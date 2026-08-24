// ============================================================
// mesaj-guvence.js — MESAJ KAYIP GARANTISI
// ------------------------------------------------------------
// AMAC: Gelen bir WhatsApp mesaji Supabase'e YAZILANA KADAR
// kaybolmasin. Once yerel gunluge (JSONL) yazilir, sonra
// veritabanina yazilmaya calisilir. Basarisiz olursa artan
// araliklarla tekrar denenir. Surec coker/yeniden baslarsa
// gunlukten kaldigi yerden devam eder.
//
// ESKI DAVRANIS: db.saveMessage(...).catch(()=>{})  -> hata
// yutuluyordu, mesaj kalici olarak kayboluyordu.
//
// server.js'in bekledigi arayuz (DEGISTIRME):
//    baslat({ kaydedici, hazirMi, log })
//    mesajAlindi(jid, message, lineId)
//    olcumler()  ->  { bekleyen, enEskiBekleyenYasSn, oluKayit, ... }
// ============================================================
const fs = require('fs');
const path = require('path');

const KLASOR = path.join(__dirname, 'guvence');
const GUNLUK = path.join(KLASOR, 'bekleyen.jsonl');   // yazilmayi bekleyenler
const OLU     = path.join(KLASOR, 'olu-mektup.jsonl'); // cok denendi, yazilamadi

// Tekrar deneme araliklari (ms). Sonuncusuna gelince o araliktan devam eder.
const ARALIKLAR = [2000, 5000, 15000, 60000, 300000];
const AZAMI_DENEME = 40;      // bundan sonra olu mektuba tasinir
const AZAMI_KUYRUK = 5000;    // bellekte tutulacak azami kayit

let kaydedici = null;         // (jid, message, lineId) => Promise
let hazirMi   = () => true;   // veritabani hazir mi
let log       = console.log;
let calisiyor = false;
let zamanlayici = null;

const kuyruk = new Map();     // id -> kayit
let sayac = 0;
const sayaclar = { alinan: 0, yazilan: 0, yenidenDeneme: 0, olu: 0, kurtarilan: 0 };

function klasorHazirla() {
  try { if (!fs.existsSync(KLASOR)) fs.mkdirSync(KLASOR, { recursive: true }); }
  catch (e) { log('⚠️  guvence klasoru olusturulamadi: ' + e.message); }
}

function yeniId() {
  sayac += 1;
  return Date.now().toString(36) + '-' + sayac.toString(36);
}

// Gunluge tek satir ekle (mesaj kaydi ya da "yazildi" isareti)
function gunlugeYaz(dosya, nesne) {
  try { fs.appendFileSync(dosya, JSON.stringify(nesne) + '\n', 'utf8'); }
  catch (e) { log('⚠️  guvence gunlugune yazilamadi: ' + e.message); }
}

// ── ACILIS: onceki calismadan kalan tamamlanmamis mesajlari kurtar ──
function gunluktenKurtar() {
  if (!fs.existsSync(GUNLUK)) return 0;
  let ham = '';
  try { ham = fs.readFileSync(GUNLUK, 'utf8'); }
  catch (e) { log('⚠️  guvence gunlugu okunamadi: ' + e.message); return 0; }

  const acik = new Map();
  for (const satir of ham.split('\n')) {
    if (!satir.trim()) continue;
    let k; try { k = JSON.parse(satir); } catch (_) { continue; }
    if (k.t === 'y' && k.id) acik.delete(k.id);              // yazilmis, kapat
    else if (k.id && k.jid) acik.set(k.id, k);               // bekliyor
  }

  let n = 0;
  for (const [id, k] of acik) {
    if (kuyruk.size >= AZAMI_KUYRUK) break;
    kuyruk.set(id, {
      id, jid: k.jid, message: k.message, lineId: k.lineId,
      eklendi: k.eklendi || Date.now(), deneme: k.deneme || 0, sonrakiDeneme: 0,
    });
    n += 1;
  }
  sayaclar.kurtarilan = n;
  return n;
}

// Gunluk sisince temizle: sadece halen bekleyenleri geride birak
function gunlugeSikistir() {
  try {
    const satirlar = [];
    for (const k of kuyruk.values()) {
      satirlar.push(JSON.stringify({
        t: 'm', id: k.id, jid: k.jid, message: k.message,
        lineId: k.lineId, eklendi: k.eklendi, deneme: k.deneme,
      }));
    }
    fs.writeFileSync(GUNLUK, satirlar.length ? satirlar.join('\n') + '\n' : '', 'utf8');
  } catch (e) { log('⚠️  guvence gunlugu sikistirilamadi: ' + e.message); }
}

// ── ANA GIRIS: server.js gelen her mesaj icin bunu cagirir ──
function mesajAlindi(jid, message, lineId) {
  sayaclar.alinan += 1;
  const id = yeniId();
  const kayit = { id, jid, message, lineId, eklendi: Date.now(), deneme: 0, sonrakiDeneme: 0 };

  gunlugeYaz(GUNLUK, { t: 'm', id, jid, message, lineId, eklendi: kayit.eklendi, deneme: 0 });

  if (kuyruk.size >= AZAMI_KUYRUK) {
    // Kuyruk tasti: en eskiyi olu mektuba al, yenisine yer ac.
    const enEski = kuyruk.keys().next().value;
    if (enEski) oluyaTasi(kuyruk.get(enEski), 'kuyruk doldu');
  }
  kuyruk.set(id, kayit);

  yaz(kayit);   // hemen dene; olmazsa donguye kalir
  return id;
}

function oluyaTasi(kayit, sebep) {
  if (!kayit) return;
  kuyruk.delete(kayit.id);
  sayaclar.olu += 1;
  gunlugeYaz(OLU, { ...kayit, sebep, zaman: new Date().toISOString() });
  log('❌ mesaj yazilamadi, olu mektuba alindi (' + sebep + '): ' + kayit.jid);
}

async function yaz(kayit) {
  if (!kaydedici || !kuyruk.has(kayit.id)) return;
  if (kayit._islemde) return;
  try { if (!hazirMi()) return; } catch (_) { return; }

  kayit._islemde = true;
  try {
    await kaydedici(kayit.jid, kayit.message, kayit.lineId);
    kuyruk.delete(kayit.id);
    sayaclar.yazilan += 1;
    gunlugeYaz(GUNLUK, { t: 'y', id: kayit.id });   // "yazildi" isareti
  } catch (e) {
    kayit.deneme += 1;
    sayaclar.yenidenDeneme += 1;
    if (kayit.deneme >= AZAMI_DENEME) {
      oluyaTasi(kayit, e.message);
    } else {
      const ar = ARALIKLAR[Math.min(kayit.deneme - 1, ARALIKLAR.length - 1)];
      kayit.sonrakiDeneme = Date.now() + ar;
      if (kayit.deneme === 1 || kayit.deneme % 10 === 0) {
        log('⏳ mesaj yazilamadi (' + kayit.deneme + '. deneme): ' + e.message);
      }
    }
  } finally {
    kayit._islemde = false;
  }
}

async function dongu() {
  if (!kuyruk.size) return;
  let hazir = false;
  try { hazir = hazirMi(); } catch (_) { hazir = false; }
  if (!hazir) return;

  const simdi = Date.now();
  const sira = [];
  for (const k of kuyruk.values()) {
    if (!k._islemde && k.sonrakiDeneme <= simdi) sira.push(k);
    if (sira.length >= 50) break;   // her turda en fazla 50 — sunucuyu bogmasin
  }
  for (const k of sira) await yaz(k);

  // Gunluk cok sismisse ve kuyruk kucukse temizle
  try {
    if (kuyruk.size < 50 && fs.existsSync(GUNLUK) && fs.statSync(GUNLUK).size > 5 * 1024 * 1024) {
      gunlugeSikistir();
    }
  } catch (_) {}
}

// ── server.js acilista bunu cagirir ──
function baslat(ayar = {}) {
  if (ayar.kaydedici) kaydedici = ayar.kaydedici;
  if (ayar.hazirMi)   hazirMi   = ayar.hazirMi;
  if (ayar.log)       log       = ayar.log;

  if (calisiyor) return;
  calisiyor = true;

  klasorHazirla();
  const n = gunluktenKurtar();
  if (n) log('🛟 mesaj guvence: onceki calismadan ' + n + ' bekleyen mesaj kurtarildi');
  else   log('🛟 mesaj guvence katmani hazir');

  zamanlayici = setInterval(() => { dongu().catch(() => {}); }, 2000);
  if (zamanlayici.unref) zamanlayici.unref();
}

function durdur() {
  calisiyor = false;
  if (zamanlayici) { clearInterval(zamanlayici); zamanlayici = null; }
}

// ── /hazir ve /olcumler uclarinin okudugu sayilar ──
function olcumler() {
  let enEski = 0;
  const simdi = Date.now();
  for (const k of kuyruk.values()) {
    const yas = Math.round((simdi - k.eklendi) / 1000);
    if (yas > enEski) enEski = yas;
  }
  let oluKayit = 0;
  try {
    if (fs.existsSync(OLU)) {
      oluKayit = fs.readFileSync(OLU, 'utf8').split('\n').filter((s) => s.trim()).length;
    }
  } catch (_) {}

  return {
    bekleyen: kuyruk.size,
    enEskiBekleyenYasSn: enEski,
    oluKayit,
    alinan: sayaclar.alinan,
    yazilan: sayaclar.yazilan,
    yenidenDeneme: sayaclar.yenidenDeneme,
    kurtarilan: sayaclar.kurtarilan,
    calisiyor,
  };
}

module.exports = { baslat, durdur, mesajAlindi, olcumler };
