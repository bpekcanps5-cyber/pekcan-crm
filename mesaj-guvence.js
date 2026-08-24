// ═══════════════════════════════════════════════════════════════════
//  MESAJ GUVENCE KATMANI
//  -------------------------------------------------------------------
//  AMAC: WhatsApp'tan alinan hicbir mesaj, sureç cokse, veritabani
//  gecici olarak erisilemez olsa ya da ayni olay birden fazla kez gelse
//  bile KAYBOLMASIN.
//
//  NEDEN GEREKLI (kanit):
//    server.js:6704  ->  db.saveMessage(jid, message, lineId).catch(...)
//    Gelen mesaj veritabanina BEKLENMEDEN yaziliyor ve hata YUTULUYOR.
//    Supabase yavaslarsa / kisa sure erisilemezse o mesaj kalici olarak
//    kayboluyor; bellekten de dusunce geri gelmiyor.
//    Ayrica surec o an cokerse bellekteki mesaj da gider.
//
//  TASARIM: yerel, ekleme-tabanli gunluk (write-ahead journal)
//    1) Mesaj alinir alinmaz DISKE yazilir (yerel dosya, ag yok, ~mikrosaniye)
//    2) Veritabanina yazma DENENIR
//    3) Basarili olursa gunluge "tamam" satiri dusulur
//    4) Basarisiz olursa artan araliklarla TEKRAR DENENIR
//    5) Surec coker/yeniden baslarsa gunlukteki tamamlanmamis kayitlar
//       basdan islenir
//    6) Ayni mesaj iki kez gelirse (canli olay + tarama) tek kayit olur
//
//  Neden veritabani yerine yerel dosya:
//    Kalicilik icin Supabase'e IKINCI bir yazma yapmak her mesajin
//    maliyetini ikiye katlar (3500 sohbetli bir hatta bu ciddi yuktur).
//    Yerel dosya ag gecikmesi olmadan crash-guvenligi saglar; asil kayit
//    yine Supabase'e gider.
// ═══════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

const KLASOR = process.env.GUVENCE_KLASOR || 'veri';
const DOSYA = path.join(KLASOR, 'gelen-kuyruk.jsonl');
const TAVAN_TEKRAR = Number(process.env.GUVENCE_TAVAN_TEKRAR) || 12;
// Artan bekleme: 2sn, 5sn, 15sn, 45sn, 2dk, 5dk sonra 10dk sabit
const BEKLEME = [2000, 5000, 15000, 45000, 120000, 300000];

let _kaydedici = null;      // (jid, mesaj, hat) => Promise  — db.saveMessage
let _hazirMi = null;        // () => boolean                 — db.isReady
let _log = console.log;
let _akis = null;           // acik dosya tanimlayicisi
let _bekleyen = new Map();  // anahtar -> kayit
let _islemZamanlayici = null;
let _sikistirmaZamanlayici = null;
let _baslatildi = false;

const _olcum = {
  alinan: 0,          // gunluge yazilan
  kaydedilen: 0,      // veritabanina basariyla yazilan
  tekrarlanan: 0,     // ayni mesaj tekrar geldi, elendi
  denemeler: 0,       // toplam yeniden deneme
  oluKayit: 0,        // tavan asildi, olu mektup
  kurtarilan: 0,      // yeniden baslatmada gunlukten kurtarilan
  sonKayitZamani: 0,
  sonHata: '',
};

// ── Mesaj icin tekil anahtar ────────────────────────────────────────
// SADECE message_id yeterli degil: ayni id farkli hatta/sohbette
// bulunabilir, ayrica duzenleme/tepki gibi varyantlar ayni id'yi
// paylasabilir. Hat + sohbet + mesaj kimligi birlestiriliyor.
function anahtarUret(hat, jid, mesajId) {
  return String(hat || 'ofis') + '|' + String(jid || '') + '|' + String(mesajId || '');
}

function klasoruHazirla() {
  try { fs.mkdirSync(KLASOR, { recursive: true }); } catch (_) {}
}

function satirYaz(nesne) {
  if (!_akis) return;
  try { _akis.write(JSON.stringify(nesne) + '\n'); } catch (e) { _olcum.sonHata = e.message; }
}

// ═══ BASLATMA ══════════════════════════════════════════════════════
// kaydedici: veritabanina yazan fonksiyon (db.saveMessage)
// hazirMi  : veritabani ayakta mi (db.isReady)
function baslat({ kaydedici, hazirMi, log } = {}) {
  if (_baslatildi) return;
  _baslatildi = true;
  _kaydedici = kaydedici;
  _hazirMi = hazirMi || (() => true);
  if (log) _log = log;

  klasoruHazirla();
  const kurtarilanlar = gunlugüOku();
  _akis = fs.createWriteStream(DOSYA, { flags: 'a' });

  if (kurtarilanlar.length) {
    _olcum.kurtarilan = kurtarilanlar.length;
    for (const k of kurtarilanlar) _bekleyen.set(k.anahtar, k);
    _log('🛟 mesaj guvence: onceki calismadan ' + kurtarilanlar.length
      + ' tamamlanmamis mesaj bulundu, yeniden yazilacak');
  }
  zamanlayiciyiKur();
  // Kurtarilanlari BEKLETME: ilk turu beklemeden hemen yaz.
  // (Yeniden baslatma sonrasi mesajin panelde gorunmesi gecikmesin.)
  if (kurtarilanlar.length) setImmediate(() => { hemenIsle().catch(() => {}); });
  // Gunluk sonsuza kadar buyumesin: saatte bir tamamlananlari at
  _sikistirmaZamanlayici = setInterval(() => { sikistir(); }, 60 * 60 * 1000);
  if (_sikistirmaZamanlayici.unref) _sikistirmaZamanlayici.unref();
}

// ═══ GUNLUGU OKU (yeniden baslatma kurtarmasi) ══════════════════════
function gunlugüOku() {
  let ham = '';
  try { ham = fs.readFileSync(DOSYA, 'utf8'); } catch (_) { return []; }
  const bekleyen = new Map();
  for (const satir of ham.split('\n')) {
    if (!satir.trim()) continue;
    let k;
    try { k = JSON.parse(satir); } catch (_) { continue; }   // bozuk satiri atla
    if (!k || !k.anahtar) continue;
    if (k.tip === 'tamam') bekleyen.delete(k.anahtar);
    else if (k.tip === 'olu') bekleyen.delete(k.anahtar);
    else bekleyen.set(k.anahtar, k);
  }
  return [...bekleyen.values()];
}

// ═══ GUNLUGU SIKISTIR ══════════════════════════════════════════════
// Tamamlanmis kayitlari atip sadece bekleyenleri birakir.
function sikistir() {
  try {
    const bekleyenler = [..._bekleyen.values()];
    const gecici = DOSYA + '.tmp';
    fs.writeFileSync(gecici, bekleyenler.map((k) => JSON.stringify(k)).join('\n')
      + (bekleyenler.length ? '\n' : ''));
    if (_akis) { _akis.end(); _akis = null; }
    fs.renameSync(gecici, DOSYA);
    _akis = fs.createWriteStream(DOSYA, { flags: 'a' });
  } catch (e) {
    _olcum.sonHata = 'sikistirma: ' + e.message;
    if (!_akis) { try { _akis = fs.createWriteStream(DOSYA, { flags: 'a' }); } catch (_) {} }
  }
}

// ═══ MESAJ ALINDI ═══════════════════════════════════════════════════
// Once diske yazar, sonra veritabanina yazmayi dener.
// Ayni mesaj tekrar gelirse (canli olay + periyodik tarama) elenir.
function mesajAlindi(jid, mesaj, hat) {
  if (!_baslatildi || !mesaj || !mesaj.id) return false;
  const anahtar = anahtarUret(hat, jid, mesaj.id);
  if (_bekleyen.has(anahtar)) { _olcum.tekrarlanan++; return false; }

  const kayit = {
    tip: 'gelen',
    anahtar,
    jid,
    hat: hat || 'ofis',
    mesajId: mesaj.id,
    mesaj,                       // yeniden yazabilmek icin tam kayit
    deneme: 0,
    sonrakiDeneme: 0,
    alindi: Date.now(),
  };
  _bekleyen.set(anahtar, kayit);
  satirYaz(kayit);
  _olcum.alinan++;
  zamanlayiciyiKur();
  hemenIsle();
  return true;
}

// ═══ ISLEME DONGUSU ════════════════════════════════════════════════
let _calisiyor = false;

async function hemenIsle() {
  if (_calisiyor || !_bekleyen.size) return;
  _calisiyor = true;
  try {
    const simdi = Date.now();
    for (const [anahtar, k] of [..._bekleyen]) {
      if (k.sonrakiDeneme > simdi) continue;
      if (_hazirMi && !_hazirMi()) {
        // Veritabani su an yok: SILME, bir sonraki tura birak.
        k.sonrakiDeneme = simdi + 5000;
        continue;
      }
      try {
        await _kaydedici(k.jid, k.mesaj, k.hat);
        _bekleyen.delete(anahtar);
        satirYaz({ tip: 'tamam', anahtar });
        _olcum.kaydedilen++;
        _olcum.sonKayitZamani = Date.now();
      } catch (e) {
        k.deneme++;
        _olcum.denemeler++;
        _olcum.sonHata = String(e && e.message).slice(0, 160);
        if (k.deneme >= TAVAN_TEKRAR) {
          // Olu mektup: daha fazla denemiyoruz AMA kaydi silmiyoruz —
          // dosyada duruyor, elle yeniden islenebilir.
          _bekleyen.delete(anahtar);
          satirYaz({ tip: 'olu', anahtar, hata: _olcum.sonHata, mesajId: k.mesajId, jid: k.jid, hat: k.hat });
          _olcum.oluKayit++;
          _log('⚠️  mesaj guvence: ' + k.deneme + ' denemede yazilamadi -> olu mektup ('
            + String(k.jid).slice(0, 24) + ' / ' + String(k.mesajId).slice(0, 16) + ')');
        } else {
          // Artan bekleme + rastgele sapma (ayni anda hepsi vurmasin)
          const taban = BEKLEME[Math.min(k.deneme - 1, BEKLEME.length - 1)];
          k.sonrakiDeneme = simdi + taban + Math.floor(Math.random() * 1000);
        }
      }
    }
  } finally {
    _calisiyor = false;
  }
  // ═══ KUYRUGU BOSALTANA KADAR DEVAM (2026-08) ═════════════════════
  // Tek turda sadece o ANDAKI kuyruk isleniyordu; tur suresince gelen
  // yeni mesajlar 3 saniye bekliyordu. Yogun trafikte bu gecikme
  // birikiyor. Sirasi gelmis is kaldiysa hemen yeni tur baslat.
  const simdi2 = Date.now();
  let sirasiGelenVar = false;
  for (const k of _bekleyen.values()) {
    if (k.sonrakiDeneme <= simdi2) { sirasiGelenVar = true; break; }
  }
  if (sirasiGelenVar) setImmediate(() => { hemenIsle().catch(() => {}); });
}

function zamanlayiciyiKur() {
  if (_islemZamanlayici) return;
  _islemZamanlayici = setInterval(() => { hemenIsle().catch(() => {}); }, 3000);
  if (_islemZamanlayici.unref) _islemZamanlayici.unref();
}

// ═══ OLCUMLER ══════════════════════════════════════════════════════
function olcumler() {
  let enEski = 0;
  for (const k of _bekleyen.values()) {
    if (!enEski || k.alindi < enEski) enEski = k.alindi;
  }
  return {
    ...(_olcum),
    bekleyen: _bekleyen.size,
    enEskiBekleyenYasSn: enEski ? Math.round((Date.now() - enEski) / 1000) : 0,
    veritabaniHazir: _hazirMi ? !!_hazirMi() : null,
  };
}

// Olu mektuplari yeniden kuyruğa al (elle onarim)
function oluKayitlariYenidenIsle() {
  let ham = '';
  try { ham = fs.readFileSync(DOSYA, 'utf8'); } catch (_) { return 0; }
  let n = 0;
  for (const satir of ham.split('\n')) {
    if (!satir.trim()) continue;
    let k; try { k = JSON.parse(satir); } catch (_) { continue; }
    if (k && k.tip === 'olu' && k.anahtar && !_bekleyen.has(k.anahtar)) {
      // Olu kaydin tam mesaji gunlukte daha once 'gelen' olarak duruyor
      const tamKayit = gunluktenBul(ham, k.anahtar);
      if (tamKayit) {
        tamKayit.deneme = 0; tamKayit.sonrakiDeneme = 0;
        _bekleyen.set(k.anahtar, tamKayit);
        satirYaz(tamKayit);
        n++;
      }
    }
  }
  if (n) { _log('🛟 ' + n + ' olu kayit yeniden kuyruga alindi'); hemenIsle(); }
  return n;
}

function gunluktenBul(ham, anahtar) {
  for (const satir of ham.split('\n')) {
    if (!satir.includes(anahtar)) continue;
    let k; try { k = JSON.parse(satir); } catch (_) { continue; }
    if (k && k.tip === 'gelen' && k.anahtar === anahtar) return k;
  }
  return null;
}

function durdur() {
  if (_islemZamanlayici) { clearInterval(_islemZamanlayici); _islemZamanlayici = null; }
  if (_sikistirmaZamanlayici) { clearInterval(_sikistirmaZamanlayici); _sikistirmaZamanlayici = null; }
  if (_akis) { try { _akis.end(); } catch (_) {} _akis = null; }
  _baslatildi = false;
  _bekleyen.clear();
}

module.exports = {
  baslat, mesajAlindi, olcumler, oluKayitlariYenidenIsle, sikistir, durdur,
  anahtarUret, DOSYA,
};
