// ============================================================
// whapi-hat.js — WHAPI HATTININ CALISMA KATMANI
// ------------------------------------------------------------
// Bu dosya UC isi yapar:
//   1) Webhook ucu: Whapi'den gelen zarfi cozup CRM'e verir
//   2) Medya: Whapi'nin verdigi link'ten dosyayi indirip diske yazar
//   3) Hat yonetimi: adaptoru line.sock'a takar, sagligi yoklar
//
// KURAL: server.js'in MEVCUT akisini kullanir (addMessage / broadcastHat /
// db.saveMessage). Paralel yol ACMAZ. Baileys yoluna DOKUNMAZ.
//
// server.js'ten alinan baglam (kur() ile verilir):
//   addMessage, broadcastHat, hatChats, stripBirMesaj, lines, createLine,
//   db, MEDIA_DIR, log
// ============================================================
const fs = require('fs');
const path = require('path');
const { zarfCevir } = require('./whapi-cevirici');
const adaptor = require('./whapi-adapter');

const LINE_ID = process.env.WHAPI_LINE_ID || 'whapi';
const GIZLI = process.env.WHAPI_WEBHOOK_SECRET || '';
const TOKEN = process.env.WHAPI_TOKEN || '';
const TABAN = process.env.WHAPI_URL || 'https://gate.whapi.cloud';

// Baileys tarafiyla AYNI guvenli uzanti listesi (server.js 9661)
const GUVENLI_UZANTI = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'ogg', 'opus', 'wav', 'm4a', 'aac',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'zip', 'rar'];

const MIME_UZANTI = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls',
};

const MEDYA_TAVAN = 80 * 1024 * 1024;   // 80 MB'tan buyuk dosya indirilmez

let B = null;          // server.js'ten gelen baglam
let sock = null;       // whapi adaptoru (line.sock'a takilacak)
let sagliTimer = null;
let telafiTimer = null;
// Telafi ne siklikta calissin. 5 dakika: kacan mesaj en gec 5 dk sonra gelir.
// Cok kisaltma — her turda TELAFI_SOHBET_TAVAN kadar API istegi gidiyor.
const TELAFI_ARALIK = 5 * 60 * 1000;
let sonSaglik = { bagli: false, durumMetni: 'baslamadi', numara: null };

function log(...a) { (B && B.log ? B.log : console.log)('[whapi]', ...a); }

// ── MUKERRER KORUMASI ────────────────────────────────────────
// Whapi kalici webhook ACIK: basarisiz olursa 24 kez tekrar dener.
// DB'deki (line_id, chat_jid, id) birincil anahtari satir cogaltmayi
// onler AMA panele ikinci kez 'msgAppend' gitmesini onlemez.
// Bu yuzden gorulen kimlikleri burada da tutuyoruz. Surec yeniden
// baslarsa diskten geri yukleniyor.
const GORULEN_DOSYA = path.join(__dirname, 'guvence', 'whapi-gorulen.txt');
// TAVAN (2026-08): surekli cekim 2000+ sohbetten 50'ser mesaj getiriyor
// -> 100.000+ kimlik. Tavan 8000 iken eskiler tasip siliniyor, silinen mesaj
// bir sonraki turda "yeni" sayilip TEKRAR isleniyordu. Panel her seferinde
// yeniden ciziliyor ve sohbet listesi parmagin altinda kayiyordu.
// 60.000 kimlik ~2 MB bellek; sorun degil.
const GORULEN_TAVAN = 60000;
const gorulen = new Set();
let gorulenYazimSayaci = 0;

function gorulenYukle() {
  try {
    if (!fs.existsSync(GORULEN_DOSYA)) return;
    const satirlar = fs.readFileSync(GORULEN_DOSYA, 'utf8').split('\n');
    for (const s of satirlar.slice(-GORULEN_TAVAN)) { if (s.trim()) gorulen.add(s.trim()); }
    log(gorulen.size + ' onceki mesaj kimligi hatirlandi (mukerrer korumasi)');
  } catch (e) { log('gorulen listesi okunamadi: ' + e.message); }
}

// YAZILAMAYAN MESAJ GUNLUGU. Whapi 24 denemeden sonra pes ederse mesaj
// yine de burada durur; elle kurtarilabilir. Token/gizli dize YAZILMAZ.
const KARANTINA_DOSYA = path.join(__dirname, 'guvence', 'whapi-yazilamayan.jsonl');
function karantinayaYaz(is, hata) {
  try {
    fs.appendFileSync(KARANTINA_DOSYA, JSON.stringify({
      zaman: new Date().toISOString(),
      jid: is.jid,
      id: is.message && is.message.id,
      hata: String((hata && hata.message) || hata).slice(0, 300),
      mesaj: is.message,
    }) + '\n', 'utf8');
  } catch (_) {}
}

// ═══ YAZMA TAMPONU (2026-08) ══════════════════════════════════
// ESKI HALI: her mesajda fs.appendFileSync — webhook isleyicisinin TAM
// ortasinda, senkron. Art arda mesaj gelince disk yazmalari siraya girip
// olay dongusunu kilitliyordu. Yavas kalirsak Whapi zaman asimina duser,
// kalici webhook 24 denemeden sonra pes eder, mesaj GERCEKTEN kaybolur.
// Saniyede bir cekim yapacaksak bu yol kesinlikle senkron OLMAMALI.
//
// YENI: kimlik ANINDA bellege girer (mukerrer korumasi hemen aktif),
// diske yazma tamponlanip asenkron yapilir.
// COKME RISKI: tampon bosalmadan surec olurse birkac kimlik diske
// yazilmamis olur. Bu MESAJ KAYBI DEGIL — en fazla ayni mesaj ikinci kez
// islenmeye calisilir, ve UC katman bunu engeller:
//   1) addMessage'in kendi kimlik kontrolu
//   2) DB birincil anahtari (line_id, chat_jid, id)
//   3) panelin handleMsgAppend kimlik kontrolu
const gorulenTampon = [];
let gorulenBosaltTimer = null;
const GORULEN_BOSALT_MS = 2000;
const GORULEN_TAMPON_TAVAN = 50;

function gorulenBosalt() {
  if (gorulenBosaltTimer) { clearTimeout(gorulenBosaltTimer); gorulenBosaltTimer = null; }
  if (!gorulenTampon.length) return;
  const yazilacak = gorulenTampon.splice(0, gorulenTampon.length).join('\n') + '\n';
  fs.appendFile(GORULEN_DOSYA, yazilacak, 'utf8', (e) => {
    if (e) log('gorulen listesi diske yazilamadi: ' + e.message);
  });
}

// Surec kapanirken (pm2 restart / SIGTERM) tamponu KAYBETME.
// Burasi senkron yazmanin dogru oldugu TEK yer: olay dongusu zaten bitiyor.
let cikisKancasiKuruldu = false;
function cikisKancasiKur() {
  if (cikisKancasiKuruldu) return;
  cikisKancasiKuruldu = true;
  const bosaltSenkron = () => {
    if (!gorulenTampon.length) return;
    try {
      fs.appendFileSync(GORULEN_DOSYA, gorulenTampon.splice(0, gorulenTampon.length).join('\n') + '\n', 'utf8');
    } catch (_) {}
  };
  process.on('exit', bosaltSenkron);
  for (const s of ['SIGINT', 'SIGTERM']) {
    process.on(s, () => { bosaltSenkron(); });
  }
}

function gorulenEkle(id) {
  gorulen.add(id);                 // mukerrer korumasi ANINDA aktif
  gorulenTampon.push(id);
  gorulenYazimSayaci += 1;
  if (gorulenTampon.length >= GORULEN_TAMPON_TAVAN) gorulenBosalt();
  else if (!gorulenBosaltTimer) {
    gorulenBosaltTimer = setTimeout(gorulenBosalt, GORULEN_BOSALT_MS);
    if (gorulenBosaltTimer.unref) gorulenBosaltTimer.unref();
  }
  // Dosya sismesin: her 2000 yazimda sadece bellekte kalanlari geri yaz
  if (gorulenYazimSayaci >= 2000) {
    gorulenYazimSayaci = 0;
    const kalan = Array.from(gorulen).slice(-GORULEN_TAVAN);
    gorulen.clear();
    for (const k of kalan) gorulen.add(k);
    gorulenTampon.length = 0;
    fs.writeFile(GORULEN_DOSYA, kalan.join('\n') + '\n', 'utf8', () => {});
  }
  if (gorulen.size > GORULEN_TAVAN * 2) {
    const kalan = Array.from(gorulen).slice(-GORULEN_TAVAN);
    gorulen.clear();
    for (const k of kalan) gorulen.add(k);
  }
}

// Panelden giden mesaj ile Whapi'nin webhook'ta kullandigi kimlik farkli
// olabiliyor. Tik bildirimleri webhook kimligiyle geliyor; bu kopru sayesinde
// dogru mesaja uygulanir.
const kimlikKopru = new Map();   // webhook kimligi -> paneldeki mesaj kimligi
function esiKimlikBagla(panelId, webhookId) {
  kimlikKopru.set(webhookId, panelId);
  if (kimlikKopru.size > 3000) {
    const ilk = kimlikKopru.keys().next().value;
    kimlikKopru.delete(ilk);
  }
}

// ── MEDYA INDIRME ────────────────────────────────────────────
function uzantiSec(link, mime, dosyaAdi) {
  // 1) dosya adindaki uzanti (belge icin en dogrusu)
  if (dosyaAdi && dosyaAdi.includes('.')) {
    const u = dosyaAdi.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (GUVENLI_UZANTI.includes(u)) return u;
  }
  // 2) mime esleme
  const m = MIME_UZANTI[String(mime || '').split(';')[0].trim().toLowerCase()];
  if (m) return m;
  // 3) link sonundaki uzanti
  const son = String(link || '').split('?')[0].split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (GUVENLI_UZANTI.includes(son)) return son;
  return 'bin';
}

async function medyaIndir(link, mime, dosyaAdi) {
  const kontrol = new AbortController();
  const zt = setTimeout(() => kontrol.abort(), 90000);
  try {
    const cevap = await fetch(link, { signal: kontrol.signal });
    if (!cevap.ok) throw new Error('HTTP ' + cevap.status);
    const boyut = Number(cevap.headers.get('content-length') || 0);
    if (boyut && boyut > MEDYA_TAVAN) throw new Error('dosya cok buyuk: ' + Math.round(boyut / 1048576) + ' MB');
    const veri = Buffer.from(await cevap.arrayBuffer());
    if (veri.length > MEDYA_TAVAN) throw new Error('dosya cok buyuk');
    const ext = uzantiSec(link, mime || cevap.headers.get('content-type'), dosyaAdi);
    const ad = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    fs.writeFileSync(path.join(B.MEDIA_DIR, ad), veri);
    return '/media/' + ad;
  } finally { clearTimeout(zt); }
}

// Baileys tarafiyla AYNI davranis: mesaj BEKLEMEZ, medya arkadan iner,
// inince addMessage tekrar cagrilip mediaUrl guncellenir.
// ── IPTAL ROBOTU KANCASI ────────────────────────────────────
// Baileys yolunda robot, saveMedia icinden ve messages.upsert'ten
// cagriliyordu. Whapi yolu o iki yerden gecmedigi icin robot Whapi
// hattinda HIC calismiyordu.
//
// ACIP KAPAMA: robotMedyaGeldi'nin ILK satiri  if (!robotAktif) return;
// Bayragi CAGRI ANINDA okuyor, onbellege almiyor. Kendi yolumuzu yazmayip
// AYNI fonksiyonu cagirdigimiz icin paneldeki mevcut ac/kapa dugmesi
// Whapi hattini da ANINDA kontrol eder. Kapaliyken belge kuyruga bile girmez.
// ═══ ROBOT GUVENLIGI (2026-08 — CANLI OLAY) ═══════════════════
// OLAN: surekli cekim/telafi ESKI belgeleri yeniden indiriyor, her indirme
// IPTAL ROBOTU'nu tetikliyor ve robot alakasiz gruplara iptal mesaji atiyordu.
// KURAL: robot SADECE canli webhook ile GERCEKTEN YENI gelen belgede calisir.
//   • cekim/telafi ile gelen  -> ASLA
//   • 10 dakikadan eski mesaj -> ASLA
//   • WHAPI_ROBOT=0           -> hic calismaz (acil kapatma)
const ROBOT_ACIK = String(process.env.WHAPI_ROBOT || '0') === '1';
const ROBOT_TAZE_MS = 10 * 60 * 1000;

function robotaVer(jid, mesajId, kind, url, mime, canliMi, ts) {
  if (!B.robotMedyaGeldi) return;
  if (!ROBOT_ACIK) return;                       // varsayilan KAPALI
  if (!canliMi) return;                          // cekim/telafi -> asla
  if (ts && (Date.now() - Number(ts)) > ROBOT_TAZE_MS) return;   // eski belge -> asla
  try {
    // robotMedyaGeldi Baileys nesnesinden SADECE su ikisini okuyor:
    //   m.key.id                                  -> arac bilgisini mesaja islemek icin
    //   m.message.documentMessage.mimetype        -> PDF mi tespiti icin
    // Dosyanin kendisini diskten okuyor (public/media/...), o yuzden
    // ham Baileys nesnesine ihtiyaci yok.
    const m = {
      key: { id: mesajId, remoteJid: jid, fromMe: false },
      message: mime ? { documentMessage: { mimetype: mime } } : {},
    };
    B.robotMedyaGeldi({ m, kind, url, jid, lineId: LINE_ID });
  } catch (e) { log('robot kancasi: ' + e.message); }
}

function medyaArkaPlanda(jid, mesajId, indir, deneme = 1, canliMi = false, ts = 0) {
  const enFazla = String(jid).endsWith('@g.us') ? 4 : 3;   // grup medyasi is kritik
  medyaIndir(indir.link, indir.mime, indir.dosyaAdi)
    .then((url) => {
      if (!url) throw new Error('bos yol');
      B.addMessage(jid, { id: mesajId, mediaUrl: url, fromMe: false }, {}, LINE_ID);
      // Belge/foto indi -> IPTAL ROBOTU'na ver (acikssa isler, kapaliysa atlar)
      robotaVer(jid, mesajId, indir.kind, url, indir.mime, canliMi, ts);
    })
    .catch((e) => {
      if (deneme < enFazla) {
        const bekle = 3000 * Math.pow(2, deneme - 1);   // 3s, 6s, 12s
        log(`medya inmedi (${deneme}/${enFazla}), ${bekle / 1000}sn sonra tekrar: ${String(mesajId).slice(0, 10)} — ${e.message}`);
        setTimeout(() => medyaArkaPlanda(jid, mesajId, indir, deneme + 1, canliMi, ts), bekle);
      } else {
        log(`MEDYA INDIRILEMEDI (${enFazla} deneme): ${String(mesajId).slice(0, 12)} — ${e.message}`);
      }
    });
}

// Onizleme (base64 data-url) -> diske kucuk jpg. Foto ANINDA gorunsun.
function onizlemeYaz(dataUrl) {
  try {
    const virgul = String(dataUrl).indexOf(',');
    if (virgul < 0) return null;
    const veri = Buffer.from(String(dataUrl).slice(virgul + 1), 'base64');
    if (!veri.length || veri.length > 400 * 1024) return null;
    const ad = 'thumb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.jpg';
    fs.writeFileSync(path.join(B.MEDIA_DIR, ad), veri);
    return '/media/' + ad;
  } catch (_) { return null; }
}

// ── HEDEF MESAJI GUNCELLE (tepki / silme / duzenleme) ────────
function hedefMesajBul(jid, hedefId) {
  const C = B.hatChats(LINE_ID);
  const chat = C && C.get ? C.get(jid) : null;
  if (!chat || !chat.messages) return { chat: null, mesaj: null };
  let m = chat.messages.find((x) => x && x.id === hedefId) || null;
  if (!m && kimlikKopru.has(hedefId)) {
    const panelId = kimlikKopru.get(hedefId);
    m = chat.messages.find((x) => x && x.id === panelId) || null;
  }
  return { chat, mesaj: m };
}

function hedefiYayinla(jid, mesaj) {
  B.broadcastHat(LINE_ID, { type: 'msgUpdate', jid, mesaj: B.stripBirMesaj(mesaj) });
  if (B.db.isReady()) B.db.saveMessage(jid, mesaj, LINE_ID).catch(() => {});
}

function tepkiUygula(is) {
  const { mesaj } = hedefMesajBul(is.jid, is.hedefId);
  if (!mesaj) return false;
  if (is.emoji) {
    mesaj.reaction = is.emoji;
    if (is.benMi) { mesaj.myReaction = is.emoji; delete mesaj.reactionBy; }
    else { delete mesaj.myReaction; mesaj.reactionBy = is.kimden || ''; }
  } else {
    delete mesaj.reaction; delete mesaj.myReaction; delete mesaj.reactionBy;
  }
  hedefiYayinla(is.jid, mesaj);
  return true;
}

function silmeUygula(is) {
  const { mesaj } = hedefMesajBul(is.jid, is.hedefId);
  if (!mesaj) return false;
  mesaj.deleted = true; mesaj.text = ''; mesaj.kind = 'text'; mesaj.mediaUrl = null;
  hedefiYayinla(is.jid, mesaj);
  return true;
}

function duzenlemeUygula(is) {
  const { mesaj } = hedefMesajBul(is.jid, is.hedefId);
  if (!mesaj) return false;
  mesaj.text = is.yeniMetin; mesaj.edited = true;
  hedefiYayinla(is.jid, mesaj);
  return true;
}

// ── KENDI HATLARIMIZI TANI ──────────────────────────────────
// Ofis (Baileys) ve pazarlama hatlari AYNI gruplarda uye. Ofis panelden
// yazinca Whapi kanali bunu "disaridan gelen mesaj" olarak goruyor ve
// panelde musteri gibi duruyor. Baileys tarafinda bunun karsiligi
// 'senderOfis' bayragi: kayitli/ekip kisisi ise panel rozet koyuyor.
// Burada ayni bayragi kuruyoruz.
function kendiHatlarimiz() {
  const kume = new Set();
  try {
    for (const [, l] of B.lines) {
      if (!l || l.id === LINE_ID) continue;          // kendi hattimiz haric
      if (l.myNumber) kume.add(String(l.myNumber).split(':')[0].replace(/\D/g, ''));
    }
  } catch (_) {}
  return kume;
}

// PANEL KULLANICISINI BUL — bellekten.
// Ofis (Baileys) panelinden yazilan mesaj, ofis hattinda PANEL KULLANICISININ
// adiyla kayitli (server.js: sender = msg.agent). WhatsApp mesaj kimligi iki
// hatta da AYNI oldugu icin ayni kimlikle arayip gercek adi aliyoruz.
// Boylece whapi panelinde "OPERASYON MERKEZI" yerine "Efe Riza" yazar.
// OLCULDU (2026-08): Whapi KENDI mesaj kimligini kullaniyor, Baileys'inkiyle
// eslesmiyor.  whapi_id = PrAYhSY045J89Uo-...   ofis_id = 3EB018852634E...
// Bu yuzden kimlikle eslestirme CALISMAZ. Olculen tek saglam anahtar:
//   ayni grup + harfi harfine ayni metin + ~0.7 saniye zaman farki
// (olculen farklar: 638, 642, 648, 652, 657, 662 ms)
// Yanlis eslesme icin ayni grupta ayni saniyede AYNI metnin iki kez atilmasi
// gerekir; o da zaten ayni mesajdir. Yanlis eslesse bile bedeli KOZMETIKTIR
// (isim etiketi), mesaj kaybi veya cogalmasi DEGILDIR.
// Olculen gercek fark 638-662 ms. Pencereyi DAR tutuyoruz, cunku bu
// gruplarda herkes ayni cizgiyi (-------) cekiyor; genis pencerede yanlis
// kisiye eslesiyordu (Ertan'in mesaji Efe Riza gorunuyordu).
// Whapi zaman damgasini SANIYE cinsinden veriyor -> ms hassasiyeti kayboluyor
// (en fazla 999 ms sapma). Olculen gercek hat farki 638-662 ms. Ikisi ust uste
// binince en kotu durum ~1.7 sn. Pencere 3 sn.
// KARISMAYI onleyen asil iki kural:
//   1) EN YAKIN zamanli aday kazanir (ilk bulunan degil)
//   2) Bir ofis mesaji SADECE BIR whapi mesajina eslesir
const ES_ZAMAN_PENCERESI = 3000;   // ms
// Bir ofis mesaji SADECE BIR whapi mesajina eslesebilir.
const esKullanilan = new Map();    // ofisMesajId -> whapiMesajId

function panelKullanicisiBul(jid, message) {
  const metin = String(message.text || '');
  if (!metin) return '';
  const ts = Number(message.ts || Date.now());
  try {
    for (const [lid, l] of B.lines) {
      if (!l || lid === LINE_ID) continue;
      const C = B.hatChats(lid);
      const c = C && C.get ? C.get(jid) : null;
      if (!c || !c.messages) continue;
      // Sondan basa: yeni mesaj sonda, en fazla 80 kayit geriye bak
      const ms = c.messages;
      // EN YAKIN ZAMANLI adayi sec — ilk bulunani DEGIL.
      let enIyi = null, enIyiFark = Infinity;
      for (let i = ms.length - 1, n = 0; i >= 0 && n < 120; i--, n++) {
        const m = ms[i];
        if (!m || !m.fromMe) continue;
        if (String(m.text || '') !== metin) continue;
        const fark = Math.abs(Number(m.ts || 0) - ts);
        if (fark > ES_ZAMAN_PENCERESI) continue;
        if (!m.sender || m.sender === 'Ben') continue;
        // Bu ofis mesaji BASKA bir whapi mesajina zaten eslendiyse atla
        const sahip = esKullanilan.get(m.id);
        if (sahip && sahip !== message.id) continue;
        if (fark < enIyiFark) { enIyiFark = fark; enIyi = m; }
      }
      if (enIyi) {
        esKullanilan.set(enIyi.id, message.id);
        if (esKullanilan.size > 4000) esKullanilan.clear();
        return enIyi.sender;
      }
    }
  } catch (_) {}
  return '';
}

// Yaris durumu: whapi webhook'u, ofis hattinin ayni mesaji islemesinden ONCE
// gelebilir. O yuzden bulamazsak kisa araliklarla birkac kez daha bakariz.
// Bulunca mesaji gunceller ve panele yansitir. Bulamazsa WhatsApp hesap adi kalir.
function panelKullanicisiSonradanAra(jid, message, deneme = 0) {
  const gecikme = [400, 1000, 2500, 6000];
  if (deneme >= gecikme.length) return;
  const mesajId = message.id;
  setTimeout(() => {
    const ad = panelKullanicisiBul(jid, message);
    if (!ad) { panelKullanicisiSonradanAra(jid, message, deneme + 1); return; }
    const { mesaj } = hedefMesajBul(jid, mesajId);
    if (!mesaj || mesaj.sender === ad) return;
    mesaj.sender = ad;
    mesaj.senderPush = ad;
    mesaj.senderOfis = true;
    mesaj.panelKullanicisi = true;
    B.broadcastHat(LINE_ID, { type: 'msgUpdate', jid, mesaj: B.stripBirMesaj(mesaj) });
    if (B.db.isReady()) B.db.saveMessage(jid, mesaj, LINE_ID).catch(() => {});
  }, gecikme[deneme]);
}

function gonderenZenginlestir(message, jid) {
  // ═══ AYNI TELEFON DURUMU (2026-08) ════════════════════════════
  // Whapi kanali ofis hattiyla AYNI telefona bagliysa, ofis panelinden
  // yazilan HER mesaj bize fromMe=true gelir. Eskiden burada 'Ben' yazip
  // cikiyorduk; sonuc olarak Efe'nin yazdigi mesaj Emre'nin panelinde de
  // "ben yazdim" gibi goruntuyordu ve kimin yazdigi kayboluyordu.
  // Artik fromMe olsa bile PANEL KULLANICISINI ariyoruz.
  // Bulamazsak 'Ben' kalir — eski davranis, yani hic bozulma yok.
  if (message.fromMe) {
    message.sender = 'Ben';
    const panelAd = panelKullanicisiBul(jid, message);
    if (panelAd) {
      message.sender = panelAd;
      message.senderPush = panelAd;
      message.senderOfis = true;
      message.panelKullanicisi = true;   // panel: kalkan rozeti + gorev rengi
    } else {
      // Ofis hatti mesaji henuz islememis olabilir — birkac kez daha bak
      panelKullanicisiSonradanAra(jid, message);
    }
    return;
  }
  const numara = String(message.senderJid || '').split('@')[0];
  if (!numara) return;

  // 0) BIZIM baska bir hattimizdan mi geldi? Oyleyse PANEL KULLANICISININ adini bul.
  if (kendiHatlarimiz().has(numara)) {
    message.senderOfis = true;
    const panelAd = panelKullanicisiBul(jid, message);
    if (panelAd) {
      message.sender = panelAd;
      message.senderPush = panelAd;
      // Panel bu isareti gorunce mesaji "panelden gonderilmis" gorunumuyle
      // cizer (kalkan rozeti + profil fotosu + gorev rengi), duz gelen mesaj gibi degil.
      message.panelKullanicisi = true;
    }
    else panelKullanicisiSonradanAra(jid, message);   // ofis hatti henuz islememis olabilir
    return;
  }

  // 1) CRM rehberinde kayitli mi? (savedContacts / contactNames)
  const rehber = (B.kisiAdiBul && B.kisiAdiBul(numara + '@s.whatsapp.net')) || '';
  if (rehber) {
    message.senderOfis = true;                       // kayitli isim = ekip/taninan kisi
    message.sender = rehber;                         // KAYITLI isim once gelir (Baileys de boyle)
    message.senderPush = rehber;
    return;
  }
  // 2) Gonderenin adi panel kullanicisi mi? (ekip uyesi)
  if (B.ekipUyesiMi && message.senderPush && B.ekipUyesiMi(message.senderPush)) {
    message.senderOfis = true;
  }
}

// ── GONDERIM ONAYI -> ANINDA TEK TIK ────────────────────────
// server.js grup mesajlarina baslangic durumu 1 (saat ikonu) veriyor;
// gercek makbuz gelene kadar mesaj "gitmemis" gibi gorunuyordu.
// Whapi istegi kabul edip GERCEK kimlik dondurdugunde durum 2 (tek tik) olur.
// NOT: server.js mesaji sendMessage DONDUKTEN SONRA ekliyor, o yuzden
// mesaj bellege dusene kadar kisa araliklarla birkac kez deniyoruz.
function gonderimTekTik(jid, id, adaylar, deneme = 0) {
  // Webhook yansimasi bu kimliklerden biriyle gelirse MUKERRER sayilsin.
  // Kimlige dayali, metne DEGIL — ayni metni iki kez yazmak guvenli kalir.
  try {
    if (deneme === 0) {
      gorulenEkle(id);
      for (const a of (adaylar || [])) {
        if (a && a !== id) { gorulenEkle(a); esiKimlikBagla(id, a); }
      }
    }
  } catch (_) {}

  const { mesaj } = hedefMesajBul(jid, id);
  if (!mesaj) {
    if (deneme < 4) setTimeout(() => gonderimTekTik(jid, id, adaylar, deneme + 1), [250, 500, 1200, 3000][deneme]);
    return;
  }
  if (!mesaj.fromMe) return;
  if ((mesaj.durum || 0) >= 2) return;          // zaten tek tik veya ustu
  mesaj.durum = 2;
  B.broadcastHat(LINE_ID, { type: 'msgStatus', jid, id, durum: 2 });
  if (B.db.isReady()) B.db.saveMessage(jid, mesaj, LINE_ID).catch(() => {});
}

// ── DURUM (TIK) UYGULA ──────────────────────────────────────
// Baileys'te bu is messages.update + message-receipt.update ile oluyordu.
// Whapi'de 'statuses' zarfi geliyor. Panelin bekledigi yayin: msgStatus.
function durumUygula(is) {
  const { mesaj } = hedefMesajBul(is.jid, is.hedefId);
  if (!mesaj) return false;
  if (!mesaj.fromMe) return false;              // sadece BIZIM mesajlarin tiki
  const eski = mesaj.durum || 0;
  if (is.durum === -1) {
    mesaj.durum = -1;
    B.broadcastHat(LINE_ID, { type: 'msgStatus', jid: is.jid, id: is.hedefId, durum: -1 });
    return true;
  }
  if (is.durum <= eski) return false;           // geri gitme (okundu -> iletildi olmaz)
  mesaj.durum = is.durum;
  B.broadcastHat(LINE_ID, { type: 'msgStatus', jid: is.jid, id: is.hedefId, durum: is.durum });
  // ILETIM DENETCISI: durum >= 3 ise mesaj ULASTI, 45sn'lik "gitmedi" alarmini iptal et.
  // Panelin "mesaj gitmedi" yanlis uyarisinin sebebi buydu.
  if (is.durum >= 3 && typeof B.iletimDenetleTamam === 'function') {
    try { B.iletimDenetleTamam(is.hedefId); } catch (_) {}
  }
  if (B.db.isReady()) B.db.saveMessage(is.jid, mesaj, LINE_ID).catch(() => {});
  return true;
}

// ── GRUP BILGISI (arka planda, mesaji BEKLETMEDEN) ───────────
const grupSonCekim = new Map();   // jid -> zaman
const GRUP_TAZELIK = 30 * 60 * 1000;
const grupKuyruk = [];            // sirada bekleyen jid'ler
const grupKuyruktakiler = new Set();
const GRUP_PARALEL = 3;           // ayni anda en fazla 3 sorgu
const GRUP_ARALIK = 150;          // sorgular arasi kisa nefes
let grupCalisan = 0;

// Grubu SIRAYA al. Yuzlerce grup ayni anda sorgulanirsa Whapi 429/404 veriyor
// ("specified group not found" satirlarinin sebebi buydu).
function grupBilgisiTazele(jid, zorla = false) {
  if (!sock || !String(jid).endsWith('@g.us')) return;
  if (grupKuyruktakiler.has(jid)) return;
  const son = grupSonCekim.get(jid) || 0;
  if (!zorla && Date.now() - son < GRUP_TAZELIK) return;
  if (zorla && Date.now() - son < 20000) return;   // adsiz bile olsa 20sn'de bir yeter
  grupKuyruktakiler.add(jid);
  if (zorla) grupKuyruk.unshift(jid); else grupKuyruk.push(jid);
  grupKuyruguIsle();
}

// 3 paralel isci. Ad/aciklama/foto TEK sorguda gelir; uye listesi
// ARTIK otomatik cekilmiyor (panel dugmesine baglandi), o yuzden
// grup basina 1 istek yeterli ve hizli.
function grupKuyruguIsle() {
  while (grupCalisan < GRUP_PARALEL && grupKuyruk.length) {
    const jid = grupKuyruk.shift();
    grupKuyruktakiler.delete(jid);
    grupSonCekim.set(jid, Date.now());
    grupCalisan += 1;
    grupBilgisiCek(jid)
      .catch(() => {})
      .then(() => {
        grupCalisan -= 1;
        if (grupKuyruk.length) setTimeout(grupKuyruguIsle, GRUP_ARALIK);
      });
  }
}

// ── ACIKLAMAYI OFIS (BAILEYS) HATTINDAN TAMAMLA ─────────────
// OLCULDU: Whapi cogu grupta 'description' alanini HIC gondermiyor
// (cevapta alan yok: id, name, type, timestamp, chat_pic, ... ).
// Ofis Baileys hatti AYNI gruplarda uye ve aciklamayi dogru veriyor.
//
// KURAL: ofis hattini YORMAYACAGIZ. Bu yuzden dogrudan sokete gitmiyoruz;
// server.js'in KENDI korumali yolundan (getGroupMeta) geciyoruz:
//   • 30 dakika onbellek  • arka plan kuyrugu  • mesaj trafigine oncelik
//   • 20 saniye emniyet agi (asla asili kalmaz)
// Ayrica: ofis bagli degilse HIC denemiyoruz ve dakikada en fazla
// ACIKLAMA_DAKIKA_TAVAN grup soruyoruz.
// Ayni grubu tekrar tekrar sorma (dakika tavani ofistenAninda icinde)
const aciklamaSorulan = new Set();

// ── DUGMEYE BASILDIGINDA: OFIS HATTINDAN ANINDA CEK ─────────
// Panelin "aciklama yenile", "uyeleri cek" ve "grup adi yenile" dugmeleri
// server.js'te SOCK.groupMetadata(jid, true) cagiriyor. Whapi aciklamayi
// vermediginde ofis Baileys soketinden DOGRUDAN soruyoruz — beklemesiz.
//
// YUK KORUMASI: bu ofis panelindeki AYNI dugmenin yaptigi isin aynisi, yani
// fazladan bir yuk degil. Yine de kotuye kullanimi onlemek icin:
//   • ofis kopuksa HIC denenmez
//   • iki sorgu arasi en az 1.2 saniye
//   • dakikada en fazla 30 sorgu
//   • 12 saniye cevap gelmezse vazgecilir (panel askida kalmaz)
// HIZLANDIRILDI: aciklama Whapi'de HIC gelmiyor, her grup icin ofise soruluyor.
// Eski ayar (1200 ms / 30 dk) yeni gruplarda gorunur gecikme yaratiyordu.
// Yeni ayar olculdu: 30 grup icin ~4.6 sn -> ~1.5 sn.
// Ofis hattini korumak icin sinirlar DURUYOR, sadece daralttik.
const ANINDA_ARALIK = 350;          // iki sorgu arasi
const ANINDA_PARALEL = 2;           // ayni anda en fazla 2 sorgu
const ANINDA_DAKIKA_TAVAN = 90;     // dakika tavani
let _anindaCalisan = 0;
let _anindaSonSorgu = 0;
let _anindaSayac = 0;
let _anindaPencere = 0;

async function ofistenAninda(jid) {
  const ofis = B.lines.get('ofis');
  if (!ofis || !ofis.connected || !ofis.sock) return null;

  const simdi = Date.now();
  if (simdi - _anindaPencere > 60000) { _anindaPencere = simdi; _anindaSayac = 0; }
  if (_anindaSayac >= ANINDA_DAKIKA_TAVAN) { log('ofis yedegi dakika tavanina takildi, atlandi'); return null; }

  // Ayni anda en fazla ANINDA_PARALEL sorgu; sirasi gelene kadar bekle
  while (_anindaCalisan >= ANINDA_PARALEL) await new Promise((c) => setTimeout(c, 60));
  const gecen = Date.now() - _anindaSonSorgu;
  if (gecen < ANINDA_ARALIK) await new Promise((c) => setTimeout(c, ANINDA_ARALIK - gecen));
  _anindaSonSorgu = Date.now();
  _anindaSayac += 1;
  _anindaCalisan += 1;

  try {
    const meta = await Promise.race([
      ofis.sock.groupMetadata(jid),
      new Promise((_, r) => setTimeout(() => r(new Error('ofis yedegi zaman asimi')), 12000)),
    ]);
    if (!meta) return null;
    const uyeler = (meta.participants || []).map((p) => {
      const numara = String(p.id || '').split('@')[0].split(':')[0];
      const ad = (B.kisiAdiBul && (B.kisiAdiBul(p.id) || B.kisiAdiBul(numara + '@s.whatsapp.net'))) || '';
      return { id: numara + '@s.whatsapp.net', phoneNumber: numara, name: ad, admin: p.admin ? 'admin' : null };
    });
    if (!global._whapiOfisYedegi) {
      global._whapiOfisYedegi = true;
      log('aciklama/uye eksiginde OFIS (Baileys) hatti yedek olarak kullaniliyor');
    }
    return { desc: (meta.desc === undefined || meta.desc === null) ? '' : String(meta.desc), participants: uyeler };
  } catch (e) {
    log('ofis yedegi basarisiz: ' + e.message);
    return null;
  } finally { _anindaCalisan -= 1; }
}

async function aciklamayiOfistenTamamla(jid, chat) {
  if (aciklamaSorulan.has(jid)) return false;
  const ofis = B.lines.get('ofis');
  if (!ofis || !ofis.connected || !ofis.sock) return false;   // ofis kopuksa DOKUNMA
  aciklamaSorulan.add(jid);
  if (aciklamaSorulan.size > 5000) aciklamaSorulan.clear();

  try {
    // HIZLANDIRMA: eskiden server.js'in arka plan KUYRUGUNDAN geciyordu
    // (getGroupMeta). O kuyruk mesaj trafigine oncelik verdigi icin aciklama
    // dakikalar sonra dusuyordu. Artik dugme yolundaki DOGRUDAN cagriyi
    // kullaniyoruz; hiz sinirlari ofistenAninda icinde duruyor.
    const y = await ofistenAninda(jid);
    if (!y || y.desc === undefined || y.desc === null) return false;
    const yeni = String(y.desc || '').trim();
    if ((chat.description || '') === yeni) return false;
    chat.description = yeni;
    if (!global._whapiAciklamaOfisten) {
      global._whapiAciklamaOfisten = true;
      log('grup aciklamalari OFIS (Baileys) hattindan tamamlaniyor — Whapi bu alani vermiyor');
    }
    B.broadcastHat(LINE_ID, {
      type: 'msgUpdate', jid,
      ozet: { name: chat.name, description: chat.description || '', memberCount: chat.memberCount || 0, avatar: chat.avatar || null },
    });
    if (B.db.isReady()) B.db.saveChat(chat, LINE_ID).catch(() => {});
    return true;
  } catch (_) { return false; }
}

async function grupBilgisiCek(jid) {
  const C = B.hatChats(LINE_ID);
  const chat = C && C.get ? C.get(jid) : null;
  if (!chat) return;

  const meta = await sock.groupMetadata(jid);
  if (!meta) return;
  let degisti = false;

  // AD: Whapi tekil /groups/{id} ucunda 'name' alaninda geliyor (listede GELMEZ).
  if (meta.subject && meta.subject.trim() && chat.name !== meta.subject.trim()) {
    chat.name = meta.subject.trim(); degisti = true;
  }
  // ACIKLAMA
  if (meta.desc !== undefined && (chat.description || '') !== (meta.desc || '')) {
    chat.description = meta.desc || ''; degisti = true;
  }
  // GRUP FOTOGRAFI: 'chat_pic' -> panelin avatar alani
  if (meta.chatPic && chat.avatar !== meta.chatPic) {
    chat.avatar = meta.chatPic; degisti = true;
  }
  // UYE SAYISI: participants bos gelse bile participants_count dogru
  if (meta.uyeSayisi && chat.memberCount !== meta.uyeSayisi) {
    chat.memberCount = meta.uyeSayisi; degisti = true;
  }
  // UYE LISTESI: OTOMATIK CEKILMIYOR.
  // Sebep: bos gelince 3 ayri uc deneniyor, grup basina 4 istek ediyordu ve
  // ad/aciklama/foto'nun gelmesini geciktiriyordu. Kullanici uye listesini
  // panelin "Uyeleri ve numaralari cek" dugmesiyle ANLIK cekiyor
  // (server.js -> SOCK.groupMetadata(jid, true) -> adaptor uyeleriCek).
  const uyeler = meta.participants || [];   // tekil uc zaten verdiyse kullan (yoksa undefined gelir)
  if (uyeler.length) {
    chat.members = uyeler.map((p) => {
      const numara = p.phoneNumber || String(p.id).split('@')[0];
      // Isim onceligi: Whapi'nin verdigi ad > CRM rehberi > numara
      const rehber = (B.kisiAdiBul && B.kisiAdiBul(p.id)) || '';
      return { jid: p.id, number: numara, name: p.name || rehber || numara, admin: !!p.admin, isLid: false };
    });
    chat.memberCount = uyeler.length;
    degisti = true;
  }

  if (degisti) {
    B.broadcastHat(LINE_ID, {
      type: 'msgUpdate', jid,
      ozet: {
        name: chat.name, description: chat.description || '',
        memberCount: chat.memberCount || 0, avatar: chat.avatar || null,
      },
    });
    if (B.db.isReady()) B.db.saveChat(chat, LINE_ID).catch(() => {});
  }

  // Whapi aciklamayi vermediyse OFIS hattindan tamamla (arka planda, beklemeden)
  if (!chat.description) {
    aciklamayiOfistenTamamla(jid, chat).catch(() => {});
  }
}

// ── TESLIM GECIKMESI OLCUMU ──────────────────────────────────
// "Mesajlar gec geliyor" sikayetini TAHMIN etmeden cevaplamak icin.
// Olculen: WhatsApp mesaj zaman damgasi -> webhook'un bize ulastigi an.
// Whapi damgasi SANIYE hassasiyetinde, ±1 sn gurultu normaldir.
//
// TIPE GORE AYIRIYOR. Suphe: Whapi'de "otomatik indirme" acik oldugu icin
// medyayi once kendi deposuna yukluyor, webhook'u ONDAN SONRA yolluyor.
// Oyleyse metin hizli, medya yavas cikar ve rakam bunu gosterir.
const gecikme = new Map();       // kind -> {adet, toplam, enKotu, esikAsan}
const GECIKME_ESIK = 10000;      // 10 sn ustu "gec" sayilir
let gecikmeSonRapor = Date.now();
const GECIKME_RAPOR_ARALIK = 5 * 60 * 1000;

function gecikmeOlc(ts, kind) {
  if (!ts) return;
  const fark = Date.now() - Number(ts);
  if (fark < -5000 || fark > 6 * 60 * 60 * 1000) return;   // sacma deger, sayma
  const k = kind || 'text';
  if (!gecikme.has(k)) gecikme.set(k, { adet: 0, toplam: 0, enKotu: 0, esikAsan: 0 });
  const g = gecikme.get(k);
  g.adet += 1; g.toplam += fark;
  if (fark > g.enKotu) g.enKotu = fark;
  if (fark > GECIKME_ESIK) g.esikAsan += 1;

  const simdi = Date.now();
  let toplamAdet = 0;
  for (const v of gecikme.values()) toplamAdet += v.adet;
  if (simdi - gecikmeSonRapor >= GECIKME_RAPOR_ARALIK && toplamAdet >= 3) {
    gecikmeSonRapor = simdi;
    const satirlar = [];
    for (const [tip, v] of gecikme) {
      satirlar.push(tip + ': ' + v.adet + ' adet, ort ' + Math.round(v.toplam / v.adet)
        + ' ms, en kotu ' + v.enKotu + ' ms, ' + (GECIKME_ESIK / 1000) + 'sn+ ' + v.esikAsan);
    }
    log('TESLIM GECIKMESI ─ ' + satirlar.join(' | '));
    gecikme.clear();
  }
}

// ── ZARFI ISLE (webhook ucunun cagirdigi ana fonksiyon) ──────
// SENKRON kisim: addMessage cagrilir -> mesaj-guvence JSONL'e YAZAR.
// Bu bittiginde mesaj kalicidir, ancak o zaman 200 doneriz.
function zarfIsle(zarf, telafiMi = false) {
  // KRITIK KORUMA: hat henuz kurulmadiysa isleme! server.js'in hatChats()
  // fonksiyonu hat bulunamazsa GLOBAL (ofis) sohbetlerine duser -> whapi
  // mesajlari ofis paneline karisirdi. 500 donup Whapi'nin tekrar
  // gondermesini sagliyoruz (kalici webhook 24 kez dener, veri kaybolmaz).
  if (!B.lines.get(LINE_ID)) {
    throw new Error('whapi hatti henuz hazir degil — Whapi tekrar denesin');
  }
  const benim = sonSaglik.numara || null;
  if (!benim && !global._whapiNumaraUyarisi) {
    global._whapiNumaraUyarisi = true;
    log('UYARI: kanal numarasi henuz bilinmiyor — kendi mesajlarin GELEN gorunebilir. /health sorgusu bekleniyor.');
  }
  const isler = zarfCevir(zarf, benim);
  const ozet = { mesaj: 0, mukerrer: 0, tepki: 0, sil: 0, duzenle: 0, durum: 0, eski: 0, atla: 0, hedefYok: 0, hata: 0, sebepler: {} };

  // TANINMAYAN ZARF: zarfCevir SADECE 'messages' ve 'statuses' okuyor.
  // Whapi panelinde 'chats', 'contacts', 'groups', 'users' de acik olabilir.
  // Bunlar sessizce cope gidiyordu — en azindan GORELIM ki mesaj tasiyip
  // tasimadigini anlayalim.
  if (!isler.length) {
    const anahtarlar = Object.keys(zarf || {}).filter((k) => k !== 'event' && k !== 'channel_id');
    const olay = (zarf && zarf.event) ? (zarf.event.type + '/' + zarf.event.event) : 'olaysiz';
    log('ISLENMEYEN ZARF — olay: ' + olay + ' | alanlar: ' + (anahtarlar.join(',') || 'yok'));
  }

  for (const is of isler) {
    if (is.tur === 'atla') {
      if (String(is.sebep || '').startsWith('eski mesaj')) ozet.eski += 1;
      else {
        // ESKI KOR NOKTA: 'atla' hicbir yerde loglanmiyordu, log kosulunda
        // bile yoktu. Cevirici bir mesaji sessizce elerse ortada TEK SATIR
        // iz kalmiyordu. Artik sebebini sayiyoruz.
        ozet.atla += 1;
        ozet.sebepler[is.sebep || 'bilinmiyor'] = (ozet.sebepler[is.sebep || 'bilinmiyor'] || 0) + 1;
      }
      continue;
    }
    if (is.tur === 'durum')   { if (durumUygula(is))       ozet.durum += 1;   else ozet.hedefYok += 1; continue; }

    if (is.tur === 'tepki')   { if (tepkiUygula(is))      ozet.tepki += 1;   else { ozet.hedefYok += 1; bosluktanTetikle(is.jid); } continue; }
    if (is.tur === 'sil')     { if (silmeUygula(is))      ozet.sil += 1;     else { ozet.hedefYok += 1; bosluktanTetikle(is.jid); } continue; }
    if (is.tur === 'duzenle') { if (duzenlemeUygula(is))  ozet.duzenle += 1; else { ozet.hedefYok += 1; bosluktanTetikle(is.jid); } continue; }

    // ── NORMAL MESAJ ──
    if (gorulen.has(is.message.id)) { ozet.mukerrer += 1; continue; }

    // ═══ MUKERRER ISARETI YAZMADAN SONRA (2026-08) ═══════════════════
    // ESKI HATA: gorulenEkle(id) addMessage'tan ONCE cagriliyordu.
    // addMessage patlarsa mesaj "gordum" damgasini yemis ama panele ve
    // DB'ye HIC yazilmamis oluyordu. Webhook 500 donunce Whapi ayni zarfi
    // tekrar yolluyor, mesaj bu kez MUKERRER sayilip atlaniyordu.
    // Sonuc: KALICI MESAJ KAYBI. (test-kayip.js bunu ureten testtir.)
    //
    // KURAL: bir mesaj panele YAZILDIYSA bir daha yazilmaz; YAZILMADIYSA
    // mukerrer sayilmaz, Whapi tekrar denedinde islenir.
    //
    // Ayrica dongu mesaj basina korumali: bir mesaj patlarsa zarftaki
    // DIGERLERI islenmeye devam eder (eskiden hepsi kesiliyordu).
    try {
      // Onizleme varsa diske yaz -> foto aninda gorunur
      if (is.onizleme) {
        const t = onizlemeYaz(is.onizleme);
        if (t) is.message.thumb = t;
      }

      // Gonderen kendi hattimiz/ekibimiz mi -> panelde rozet gorunsun
      try { gonderenZenginlestir(is.message, is.jid); } catch (_) {}

      // NOT: "ayni metin = yansima" gibi bir tahmin YAPMIYORUZ.
      // Iki kisi ayni anda cizgi cekerse veya ayni mesaj bilerek iki kez
      // atilirsa ikincisi YUTULURDU. Mesaj kaybi kabul edilemez.
      // Yansima elemesi SADECE kimlik eslesmesiyle yapilir (addMessage + gorulen).

      // MEVCUT AKIS: addMessage -> broadcastHat + db.saveChat + mesajGuvence
      B.addMessage(is.jid, is.message, is.meta, LINE_ID);

      // ANCAK BURADA "gorduk" diyebiliriz — mesaj artik panelde ve kuyrukta.
      gorulenEkle(is.message.id);
      ozet.mesaj += 1;
      // TELAFI ile gelen mesaj ESKI olabilir; gecikme istatistigini kirletmesin.
      if (!telafiMi) gecikmeOlc(is.ts, is.message.kind);
    } catch (e) {
      // Mesaj YAZILAMADI: gorulen'e EKLENMEDI, Whapi tekrar deneyince islenecek.
      // Whapi 24 denemeden sonra pes ederse diye ham kaydi karantinaya aliyoruz.
      ozet.hata += 1;
      karantinayaYaz(is, e);
      log('MESAJ YAZILAMADI (mukerrer isaretlenmedi, Whapi tekrar deneyecek): '
        + String(is.message.id).slice(0, 16) + ' — ' + e.message);
      continue;
    }

    // Ag isleri mesaji BEKLETMEZ, hepsi addMessage'tan SONRA.
    // Bunlar patlarsa mesaj ZATEN yazildi -> kayip yok, zarfi kesme.
    try {
      if (is.indir && is.indir.link) medyaArkaPlanda(is.jid, is.message.id, is.indir, 1, !telafiMi, is.ts);
      if (is.isGroup) {
        // ADI HALA SAYI olan gruplar SIRANIN BASINA gecsin — kullanici
        // "grup adlari gec geliyor" dedi; adsiz grup en oncelikli is.
        const C = B.hatChats(LINE_ID);
        const c = C && C.get ? C.get(is.jid) : null;
        const adsiz = !c || !c.name || /^\d+$/.test(String(c.name));
        grupBilgisiTazele(is.jid, adsiz);
      }
    } catch (e) {
      log('mesaj sonrasi arka plan isi basarisiz (mesaj GUVENDE): ' + e.message);
    }
  }

  // Yazilamayan mesaj varsa 500 don ki Whapi zarfi TEKRAR yollasin.
  // Basarili olanlar gorulen'de oldugu icin ikinci kez panele DUSMEZ.
  // TELAFI yolunda firlatma: orada 'tekrar yollayacak' bir karsi taraf yok,
  // bir sonraki telafi turunda zaten yeniden denenir.
  if (ozet.hata && !telafiMi) {
    const h = new Error(ozet.hata + ' mesaj yazilamadi — Whapi tekrar denesin');
    h._ozet = ozet;
    throw h;
  }
  return ozet;
}

// ── KACAN MESAJ TELAFISI ─────────────────────────────────────
// Baileys'te bunun karsiligi kacanMesajTelafi(sock): baglanti kurulunca
// aktif gruplarin son mesajlarini PROAKTIF ister, kacanlar boylece gelir.
// Whapi hattinda bu HIC YOKTU: webhook gelmezse mesaj sonsuza kadar kayipti.
// "Baileys neden daha eksiksiz" sorusunun cevabi buydu.
//
// GUVENLIK: mukerrer olusturmaz. Iki katman var —
//   1) gorulen (kimlik kumesi, diske yazili, restart'a dayanikli)
//   2) addMessage'in kendi kimlik kontrolu (ayni id ikinci kez EKLENMEZ)
// Whapi kimlikleri webhook ile /messages/list arasinda AYNI oldugu icin
// eslesme tutar. Tutmazsa mesaj iki kez GORUNUR; asagidaki olcum bunu
// yakalar (kurtarilan sayisi surekli yuksek kalirsa kimlikler tutmuyordur).
// ── BOSLUK TELAFISI ICIN ORTAK AYARLAR ──────────────────────
// Tek sohbeti aninda kontrol ederken kac mesaj geriye bakilir.
const BOSLUK_ADET = Math.max(3, Number(process.env.WHAPI_BOSLUK_ADET) || 8);

function hizSiniriMi(e) {
  return /rate-overlimit|429|too many/i.test(String((e && e.message) || e));
}

// Tek sohbeti hemen kontrol et (bosluk sinyali ve sohbet kipi icin)
async function birSohbetiTelafiEt(jid, adet) {
  const ham = await sock._mesajlariCek(jid, adet);
  if (!Array.isArray(ham) || !ham.length) return 0;
  const o = zarfIsle({ messages: ham }, true);
  return o.mesaj;
}

// NOT: eski 'hizli tur' KALDIRILDI. Isini SUREKLI CEKIM devraldi
// (o her turda zaten aktif sohbetlere bakiyor). Iki mekanizma birden
// calisirsa gereksiz istek gider ve 429 riski artar.

// ── BOSLUK SINYALI ───────────────────────────────────────────
// Birisi bizde OLMAYAN bir mesaja tepki verdiyse / onu sildiyse, o mesaji
// KACIRMISIZ demektir. Bu bedava bir kanit — eskiden 'hedef bulunamadi'
// diye sayilip atiliyordu. Artik o sohbeti ANINDA telafi ediyoruz.
const bosluk = new Map();          // jid -> son tetikleme
const BOSLUK_BEKLEME = 5000;       // ayni sohbet icin 5 sn'de bir yeter

function bosluktanTetikle(jid) {
  if (!jid || !sock || !sonSaglik.bagli) return;
  const son = bosluk.get(jid) || 0;
  if (Date.now() - son < BOSLUK_BEKLEME) return;
  bosluk.set(jid, Date.now());
  if (bosluk.size > 500) bosluk.clear();
  setTimeout(() => {
    birSohbetiTelafiEt(jid, BOSLUK_ADET)
      .then((n) => { if (n) log('BOSLUK TELAFISI: bizde olmayan mesaja tepki/silme geldi -> '
        + n + ' kacan mesaj kurtarildi'); })
      .catch(() => {});
  }, 300);
}

// ── SUREKLI CEKIM: webhook'a GUVENME, sen iste ───────────────
// Kullanici: "eksiksiz Whapi'den her mesaji iste, ne olursa olsun."
// Webhook PUSH'tur; gelmezse haberimiz olmaz. Cekim PULL'dur; biz sorariz,
// cevap gelmezse tekrar sorariz. Kayip icin tek gercek panzehir budur.
//
// IKI KIP var, kod HANGISININ calistigini kendisi bulur:
//   GENEL : tek istekte TUM sohbetlerin son mesajlari  -> her tur her sey
//   SOHBET: sohbet basina istek, sirayla doner          -> genel uc yoksa
// Whapi'nin genel ucu destekleyip desteklemedigini bilmiyorum; ilk turda
// deneyip 404/405 alirsa sohbet kipine duser ve bunu LOGLAR.
const CEKIM_SN   = Math.max(1, Number(process.env.WHAPI_CEKIM_SN) || 2);
const CEKIM_ADET = Math.max(10, Number(process.env.WHAPI_CEKIM_ADET) || 50);
const CEKIM_SOHBET_TUR = Math.max(1, Number(process.env.WHAPI_CEKIM_SOHBET) || 2);
const CEKIM_CARPAN_TAVAN = 15;
const CEKIM_ADET_SAKIN = 15;      // birikim bitince tur basina bu kadar
let cekimAdet = CEKIM_ADET;       // su anki cekim adedi (uyarlanir)

let cekimTimer = null;
let cekimKip = 'bilinmiyor';   // 'genel' | 'sohbet'
let cekimCarpan = 1;
let cekimBasarili = 0;
let cekimSirasi = 0;
const cekimSayac = { tur: 0, kurtarilan: 0, hata: 0 };
let cekimSonRapor = Date.now();

async function genelCekimDene() {
  // Whapi'de sohbet kimligi VERMEDEN son mesajlar
  const c = await sock._istek('/messages/list?count=' + cekimAdet, { zamanAsimi: 30000 });
  return (c && c.messages) || [];
}

async function surekliCekim() {
  if (!sock || !sonSaglik.bagli || !B.lines.get(LINE_ID)) return;
  if (telafiCalisiyor) return;
  telafiCalisiyor = true;
  cekimSayac.tur += 1;
  try {
    let kurtarilan = 0;

    if (cekimKip !== 'sohbet') {
      try {
        const ham = await genelCekimDene();
        if (cekimKip === 'bilinmiyor') {
          cekimKip = 'genel';
          log('SUREKLI CEKIM kipi: GENEL — tek istekte tum sohbetler (' + CEKIM_SN + ' sn)');
        }
        if (ham.length) kurtarilan += zarfIsle({ messages: ham }, true).mesaj;
      } catch (e) {
        if (hizSiniriMi(e)) throw e;
        // Genel uc yok -> sohbet kipine dus. Bir kez soyle, bir daha deneme.
        cekimKip = 'sohbet';
        log('SUREKLI CEKIM kipi: SOHBET — genel uc yok (' + e.message.slice(0, 60)
          + '). Tur basina ' + CEKIM_SOHBET_TUR + ' sohbet dolasilacak.');
      }
    }

    if (cekimKip === 'sohbet') {
      const C = B.hatChats(LINE_ID);
      const aktif = Array.from((C && C.values) ? C.values() : [])
        .filter((c) => c && c.jid && c.lastTs && (Date.now() - Number(c.lastTs) < TELAFI_YAS))
        .sort((a, b) => (Number(b.lastTs) || 0) - (Number(a.lastTs) || 0));
      if (!aktif.length) return;
      for (let i = 0; i < CEKIM_SOHBET_TUR; i++) {
        const c = aktif[cekimSirasi % aktif.length];
        cekimSirasi += 1;
        try { kurtarilan += await birSohbetiTelafiEt(c.jid, cekimAdet); }
        catch (e) { if (hizSiniriMi(e)) throw e; cekimSayac.hata += 1; }
      }
    }

    cekimSayac.kurtarilan += kurtarilan;
    if (kurtarilan) log('SUREKLI CEKIM: ' + kurtarilan + ' mesaj webhook ile GELMEMISTI, cekimle geldi');

    // GERI YAKALAMA BITTI MI: acilista buyuk bir birikim var, o gecince
    // her turda 50 mesaj cekmeye gerek yok. Az cekmek = az yayin = panel
    // sakin. Yeni mesaj bulununca tekrar buyuruyoruz.
    if (kurtarilan === 0) { if (cekimAdet > CEKIM_ADET_SAKIN) cekimAdet = CEKIM_ADET_SAKIN; }
    else cekimAdet = CEKIM_ADET;

    cekimBasarili += 1;
    if (cekimCarpan > 1 && cekimBasarili >= 20) {
      cekimCarpan = Math.max(1, cekimCarpan - 1);
      cekimBasarili = 0;
      log('hiz siniri gecti — cekim araligi ' + (CEKIM_SN * cekimCarpan) + ' sn');
    }
  } catch (e) {
    if (hizSiniriMi(e)) {
      cekimCarpan = Math.min(cekimCarpan * 2, CEKIM_CARPAN_TAVAN);
      cekimBasarili = 0;
      log('HIZ SINIRI — cekim araligi ' + (CEKIM_SN * cekimCarpan)
        + ' sn ye cikarildi (Whapi 429 verdi). Panele dusme suresi bu kadar uzar.');
    } else {
      cekimSayac.hata += 1;
    }
  } finally {
    telafiCalisiyor = false;
  }

  // 5 dakikada bir ozet: cekim gercekten is yapiyor mu, rakamla gorelim
  if (Date.now() - cekimSonRapor >= 5 * 60 * 1000) {
    cekimSonRapor = Date.now();
    log('CEKIM OZETI (' + cekimKip + ', ' + (CEKIM_SN * cekimCarpan) + ' sn): '
      + cekimSayac.tur + ' tur | ' + cekimSayac.kurtarilan
      + ' mesaj SADECE cekimle geldi | ' + cekimSayac.hata + ' hata');
    cekimSayac.tur = 0; cekimSayac.kurtarilan = 0; cekimSayac.hata = 0;
  }
}

function cekimPlanla() {
  if (cekimTimer) clearTimeout(cekimTimer);
  cekimTimer = setTimeout(() => {
    surekliCekim().catch(() => {}).then(cekimPlanla);
  }, CEKIM_SN * 1000 * cekimCarpan);
  if (cekimTimer.unref) cekimTimer.unref();
}

const TELAFI_SOHBET_TAVAN = 25;      // en son konusulan kac sohbet
const TELAFI_MESAJ_ADEDI = 20;       // sohbet basina kac mesaj geri bakilir
const TELAFI_YAS = 48 * 3600 * 1000; // son 48 saatte konusulan sohbetler
const TELAFI_NEFES = 250;            // istekler arasi bekleme (429 yememek icin)
let telafiCalisiyor = false;

function bekleMs(n) { return new Promise((c) => setTimeout(c, n)); }

async function kacanTelafi(sebep = 'periyodik') {
  if (telafiCalisiyor) return { atlandi: 'zaten calisiyor' };
  if (!sock || !B.lines.get(LINE_ID)) return { atlandi: 'hat hazir degil' };
  if (!sonSaglik.bagli) return { atlandi: 'hat bagli degil' };
  telafiCalisiyor = true;
  const basladi = Date.now();
  let bakilan = 0, kurtarilan = 0, hatali = 0;
  try {
    const C = B.hatChats(LINE_ID);
    const sohbetler = Array.from((C && C.values) ? C.values() : [])
      .filter((c) => c && c.jid && c.lastTs && (Date.now() - Number(c.lastTs) < TELAFI_YAS))
      .sort((a, b) => (Number(b.lastTs) || 0) - (Number(a.lastTs) || 0))
      .slice(0, TELAFI_SOHBET_TAVAN);

    for (const c of sohbetler) {
      try {
        const ham = await sock._mesajlariCek(c.jid, TELAFI_MESAJ_ADEDI);
        if (!Array.isArray(ham) || !ham.length) continue;
        bakilan += ham.length;
        // AYNI yoldan gecir: cevirici + gorulen + addMessage. Paralel yol YOK.
        const o = zarfIsle({ messages: ham }, true);
        kurtarilan += o.mesaj;
        if (o.mesaj) {
          log('TELAFI: "' + String(c.name || c.jid).slice(0, 30) + '" icin '
            + o.mesaj + ' KACAN mesaj kurtarildi');
        }
      } catch (e) {
        hatali += 1;
        log('telafi sorgusu basarisiz (' + String(c.jid).slice(0, 24) + '): ' + e.message);
      }
      await bekleMs(TELAFI_NEFES);
    }
  } finally {
    telafiCalisiyor = false;
  }
  const sure = Date.now() - basladi;
  log('TELAFI (' + sebep + ') bitti: ' + kurtarilan + ' kacan mesaj kurtarildi | '
    + bakilan + ' mesaj kontrol edildi | ' + hatali + ' sorgu hatasi | ' + sure + ' ms');
  return { kurtarilan, bakilan, hatali, sure };
}

// ── WEBHOOK UCU ──────────────────────────────────────────────
function kancaKur(app, express) {
  if (!GIZLI) { log('UYARI: WHAPI_WEBHOOK_SECRET yok — webhook ucu ACILMADI'); return; }
  const yol = '/whapi/gelen/:gizli';

  app.post(yol, express.json({ limit: '50mb' }), (req, res) => {
    // Gizli yol yanlissa hicbir bilgi verme (var oldugunu bile belli etme)
    if (req.params.gizli !== GIZLI) return res.status(404).end();
    try {
      const ozet = zarfIsle(req.body || {});
      // 200 = "kalici olarak aldik". Whapi bir daha yollamaz.
      res.json({ ok: true });
      if (ozet.mesaj || ozet.tepki || ozet.sil || ozet.duzenle || ozet.durum || ozet.mukerrer || ozet.eski || ozet.atla) {
        const parcalar = [];
        if (ozet.mesaj) parcalar.push(ozet.mesaj + ' mesaj');
        if (ozet.tepki) parcalar.push(ozet.tepki + ' tepki');
        if (ozet.sil) parcalar.push(ozet.sil + ' silme');
        if (ozet.duzenle) parcalar.push(ozet.duzenle + ' duzenleme');
        if (ozet.durum) parcalar.push(ozet.durum + ' tik');
        if (ozet.eski) parcalar.push(ozet.eski + ' ESKI mesaj elendi');
        if (ozet.mukerrer) parcalar.push(ozet.mukerrer + ' MUKERRER engellendi');
        if (ozet.hedefYok) parcalar.push(ozet.hedefYok + ' hedef bulunamadi');
        // ELENEN: sebebiyle birlikte. Eskiden bu satir HIC yazilmiyordu.
        if (ozet.atla) {
          const s = Object.entries(ozet.sebepler).map(([k, v]) => k + ' x' + v).join(', ');
          parcalar.push(ozet.atla + ' ELENDI (' + s + ')');
        }
        log(parcalar.join(' | '));
      }
    } catch (e) {
      // 500 = "alamadik". Whapi artan araliklarla 24 kez tekrar dener.
      // Kismi basari: bir kismi YAZILDI (gorulen'de, ikinci kez dusmez),
      // yazilamayanlar tekrar denenecek.
      const o = e._ozet;
      if (o) {
        log('KISMI BASARI — yazilan: ' + o.mesaj + ' | YAZILAMAYAN: ' + o.hata
          + ' (Whapi tekrar deneyecek, yazilanlar ikinci kez DUSMEZ)');
      } else {
        log('WEBHOOK HATASI (Whapi tekrar deneyecek): ' + e.message);
      }
      try { res.status(500).json({ ok: false }); } catch (_) {}
    }
  });

  log('webhook ucu hazir: POST /whapi/gelen/<gizli>');
}

// ── SAGLIK YOKLAMASI ─────────────────────────────────────────
// Whapi'de connection.update yok. 60 saniyede bir /health sorulur.
async function sagligiYokla(ilkMi = false) {
  const line = B.lines.get(LINE_ID);
  if (!line || !sock) return;
  try {
    const s = await sock._saglik();
    const eskiBagli = sonSaglik.bagli;
    sonSaglik = s;
    line.connected = s.bagli;
    line.myNumber = s.numara || line.myNumber;
    line.myName = s.ad || line.myName;
    line.sonAktivite = Date.now();
    if (s.bagli !== eskiBagli || ilkMi) {
      log('kanal durumu: ' + (s.bagli ? 'BAGLI' : 'KOPUK') + ' (' + s.durumMetni + ')');
      B.broadcastHat(LINE_ID, {
        type: 'status', connected: s.bagli,
        myJid: s.numara ? s.numara + '@s.whatsapp.net' : null,
        myName: s.ad || '', qr: false, qrImage: null,
      });
      // KOPUKTAN BAGLIYA gecis: kopukken gelen webhook'lar kaybolmus olabilir.
      // Baileys'te kacanMesajTelafi tam olarak burada calisiyor; ayni sey.
      if (s.bagli && !eskiBagli && !ilkMi) {
        kacanTelafi('baglanti geri geldi').catch(() => {});
      }
    }
  } catch (e) {
    sonSaglik = { bagli: false, durumMetni: 'ulasilamadi', numara: sonSaglik.numara };
    line.connected = false;
    log('saglik sorgusu basarisiz: ' + e.message);
    B.broadcastHat(LINE_ID, { type: 'status', connected: false, qr: false, qrImage: null });
  }
}

// ── HATTI BASLAT ─────────────────────────────────────────────
async function hattiBaslat() {
  if (!TOKEN) { log('WHAPI_TOKEN yok — hat baslatilmadi'); return null; }

  let line = B.lines.get(LINE_ID);
  if (!line) { line = B.createLine(LINE_ID, 'Whapi Test Hatti', 'motortest'); B.lines.set(LINE_ID, line); }
  line.motor = 'whapi';          // startWA bunu gorup Baileys'e HIC girmeyecek
  line.starting = false;
  line.manualLogout = false;
  line.lastQR = null;            // Whapi'de QR yok

  gorulenYukle();
  cikisKancasiKur();

  sock = adaptor.olustur({
    token: TOKEN, taban: TABAN, log,
    // Whapi'nin verdigi uye adlarini CRM rehberine yaz. server.js'in
    // kendi uye eslemesi (getGroupMembers) contactNames'ten okuyor;
    // bunu doldurmazsak panelde isim yerine NUMARA gorunur.
    adKaydet: (jid, ad) => { try { if (B.kisiAdiKaydet) B.kisiAdiKaydet(jid, ad); } catch (_) {} },
    gonderimOnaylandi: (jid, id, adaylar) => { gonderimTekTik(jid, id, adaylar); },
    ofisYedek: (jid) => ofistenAninda(jid),
  });
  line.sock = sock;              // KRITIK: panelin gonderme kodu bunu kullanir

  // Kendi numarasini ogren — fromMe tespiti buna dayaniyor
  try {
    const s = await sock._hazirla();
    sonSaglik = s;
    line.connected = s.bagli;
    line.myNumber = s.numara;
    line.myName = s.ad || '';
    log('kanal ' + s.kanalId + ' / numara ' + s.numara + ' / durum ' + s.durumMetni);
  } catch (e) {
    log('kanal bilgisi alinamadi: ' + e.message + ' — hat KOPUK baslatildi, yoklama devam edecek');
    line.connected = false;
  }

  // Onceki oturumlardan kalan sohbetleri DB'den yukle (SADECE bu hat)
  if (B.db.isReady()) {
    try {
      const veri = await B.db.loadAll(LINE_ID);
      line.chats.clear();
      for (const row of veri.chats) {
        line.chats.set(row.jid, {
          jid: row.jid, name: row.name || row.jid.split('@')[0],
          isGroup: row.is_group, description: row.description || '',
          avatar: row.avatar || null, memberCount: row.member_count || 0,
          members: row.members || [], messages: [],
          unread: row.unread || 0, ozelUnread: row.ozel_unread || 0, muhUnread: row.muh_unread || 0,
          lastTime: row.last_time || '', lastTs: Number(row.last_ts) || 0,
          pinned: row.pinned, archived: row.archived, hasMention: row.has_mention,
        });
      }
      log(line.chats.size + ' sohbet veritabanindan yuklendi');
    } catch (e) { log('sohbet yukleme hatasi: ' + e.message); }
  }

  if (sagliTimer) clearInterval(sagliTimer);
  sagliTimer = setInterval(() => { sagligiYokla(false).catch(() => {}); }, 60000);
  if (sagliTimer.unref) sagliTimer.unref();

  // ── TELAFI ZAMANLAYICISI ──
  // Baileys'in kacanMesajTelafi'sinin Whapi karsiligi. Webhook'un kacirdigi
  // mesajlar burada yakalanir. Mukerrer uretmez (kimlik bazli iki katman).
  if (telafiTimer) clearInterval(telafiTimer);
  telafiTimer = setInterval(() => { kacanTelafi('periyodik').catch(() => {}); }, TELAFI_ARALIK);
  if (telafiTimer.unref) telafiTimer.unref();
  // Acilistan 30 sn sonra bir kez: surec kapaliyken gelenleri yakala
  setTimeout(() => { kacanTelafi('acilis').catch(() => {}); }, 30000).unref?.();

  // SUREKLI CEKIM: webhook'a guvenmeden her mesaji biz isteyecegiz
  cekimPlanla();
  log('SUREKLI CEKIM acik — her ' + CEKIM_SN + ' sn, ' + CEKIM_ADET
    + ' mesaj | genis telafi: ' + (TELAFI_ARALIK / 60000) + ' dk / '
    + TELAFI_SOHBET_TAVAN + ' sohbet (emniyet agi)');

  return line;
}

// ── server.js'in cagirdigi kurulum ───────────────────────────
function kur(baglam, app, express) {
  B = baglam;
  kancaKur(app, express);
  return { hattiBaslat, LINE_ID, durum: () => sonSaglik, sock: () => sock, telafi: kacanTelafi, birSohbet: birSohbetiTelafiEt, cekim: surekliCekim,
    cekimKip: () => cekimKip, bosalt: gorulenBosalt };
}

module.exports = { kur, LINE_ID };
