// server.js — WhatsApp + Sunucu + WebSocket + MEDYA (foto/ses/belge) + grup açıklaması
// Çalıştır: node server.js  → http://localhost:3000 panel, terminalde QR

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRImage = require('qrcode'); // panelde QR resmi gostermek icin
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const db = require('./db'); // Supabase (PostgreSQL) veri katmani

// ============================================================
// SUNUCU BAŞLANGIÇ KİMLİĞİ (boot id) — OTOMATİK PANEL YENİLEME
// Sunucu HER başladığında benzersiz bir kimlik üretir. Panel bağlanınca bu kimliği alır.
// Sunucu yeniden başlayıp (güncelleme sonrası pm2 restart) panel tekrar bağlanınca, yeni
// kimlik eskisinden FARKLIYSA -> güncelleme geldi demektir -> panel kendini otomatik yeniler.
// Bir kişinin F5 atması bu kimliği DEĞİŞTİRMEZ (aynı sunucu) -> kimse boş yere yenilenmez.
// ============================================================
const BOOT_ID = 'boot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

// ── GÜNCELLEME NOTU ──
// Sen terminalden bir not yazarsın, herkesin "Güncelleme geldi" sorusunda O YAZI görünür.
// İki yol:
//   1) Dosya:  echo "Yılan oyunu eklendi" > /root/pekcan-crm/guncelleme.txt  &&  pm2 restart pekcan
//   2) Değişken:  GUNCELLEME_NOT="Poliçe düzeltme geldi" pm2 restart pekcan --update-env
// Not yoksa soru sade görünür (sadece "Güncelleme geldi").
function guncellemeNotuOku() {
  try {
    if (process.env.GUNCELLEME_NOT && process.env.GUNCELLEME_NOT.trim()) {
      return process.env.GUNCELLEME_NOT.trim().slice(0, 200);
    }
    const dosya = path.join(__dirname, 'guncelleme.txt');
    if (fs.existsSync(dosya)) {
      const icerik = fs.readFileSync(dosya, 'utf8').trim();
      if (icerik) return icerik.slice(0, 200);
    }
  } catch (_) {}
  return '';
}
const GUNCELLEME_NOT = guncellemeNotuOku();
if (GUNCELLEME_NOT) console.log(`📢 Güncelleme notu: "${GUNCELLEME_NOT}"`);

// ÇİFT GÖNDERİM KORUMASI: panelin gönderdiği benzersiz istek kimlikleri (2 dk saklanır).
// Aynı kimlik ikinci kez gelirse mesaj tekrar gönderilmez.
const _gonderilenIstekler = new Map();


// ============================================================
// LOG GURULTU FILTRESI
// Baileys/libsignal bazen "Bad MAC", "Failed to decrypt", "Session error",
// "Closing session/open session" gibi SIFRELEME hatalarini dogrudan console'a basar.
// Bunlar ZARARSIZ gurultu (sunucu cokmez) ama ekrani doldurur + cok log yazmak yuk.
// Bu satirlari gizleyip sadece ANLAMLI loglari gosteririz.
// (Onemli: kendi loglarimizi engellemez — sadece bilinen WhatsApp gurultusunu susturur.)
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _gurultuKaliplari = [
  'Bad MAC', 'Failed to decrypt', 'Session error', 'decryptWhisperMessage',
  'Closing session', 'Closing open session', 'MessageCounterError', 'No session found',
  'SessionEntry', 'libsignal', 'verifyMAC', 'queue_job', 'session_cipher',
  'No matching sessions', 'Key used already', 'prekey', 'senderKeyDistribution',
  'incoming prekey bundle', 'chainKey', 'ephemeralKeyPair', 'currentRatchet',
  'remoteIdentityKey', 'registrationId', 'rootKey', '_chains',
];
// ═══════════════════════════════════════════════════════════════════════
// ŞİFRELEME HATASI SAYACI (KRİTİK — "mesaj gitti göründü ama gitmemiş" sorunu)
// "Bad MAC" / "Failed to decrypt" = WhatsApp şifreleme oturumu bozulmuş demek.
// Bu bozukken: mesaj gönderilir, makbuz bile gelir (çift tik!), AMA karşı taraf
// mesajın şifresini çözemez -> mesaj HİÇ GÖRÜNMEZ. Panel "gitti" sanır.
// Bu yüzden bu hataları gizlemeye devam ediyoruz (ekranı doldurmasın) ama SAYIYORUZ.
// Eşik aşılırsa NET uyarı veriyoruz: oturum tazelenmeli (QR yenile).
// ═══════════════════════════════════════════════════════════════════════
const _sifrelemeHatalari = { sayac: 0, ilkZaman: 0, sonUyari: 0 };
const SIFRELEME_ESIK = 15;              // son 10 dk'da bu kadar hata -> ciddi sorun
const SIFRELEME_PENCERE = 10 * 60 * 1000; // 10 dakika
function _sifrelemeHatasiSay(metin) {
  const kritikMi = /Bad MAC|Failed to decrypt|Session error|No session found|MessageCounterError/i.test(metin);
  if (!kritikMi) return;
  const simdi = Date.now();
  // pencere dışındaysa sıfırla
  if (!_sifrelemeHatalari.ilkZaman || simdi - _sifrelemeHatalari.ilkZaman > SIFRELEME_PENCERE) {
    _sifrelemeHatalari.sayac = 0;
    _sifrelemeHatalari.ilkZaman = simdi;
  }
  _sifrelemeHatalari.sayac++;
  // eşik aşıldı + son uyarıdan 10dk geçti -> UYAR
  if (_sifrelemeHatalari.sayac >= SIFRELEME_ESIK && simdi - _sifrelemeHatalari.sonUyari > SIFRELEME_PENCERE) {
    _sifrelemeHatalari.sonUyari = simdi;
    _origLog('');
    _origLog('╔══════════════════════════════════════════════════════════════');
    _origLog('║ 🔐 ŞİFRELEME OTURUMU BOZUK! (ciddi)');
    _origLog(`║ Son 10 dakikada ${_sifrelemeHatalari.sayac} şifreleme hatası.`);
    _origLog('║');
    _origLog('║ BU NE DEMEK: Mesajlar gönderilmiş GİBİ görünebilir (çift tik bile');
    _origLog('║ gelebilir) ama karşı taraf şifresini çözemediği için GÖREMEZ.');
    _origLog('║ Yani panel "gitti" der, WhatsApp\'ta mesaj YOKTUR.');
    _origLog('║');
    _origLog('║ ÇÖZÜM: WhatsApp oturumunu tazele (QR yeniden okut):');
    _origLog('║   pm2 stop pekcan && rm -rf auth* && pm2 start pekcan');
    _origLog('║   Sonra panelde çıkan QR\'ı telefonla okut.');
    _origLog('╚══════════════════════════════════════════════════════════════');
    _origLog('');
    // panellere de bildir (yöneticiler görsün)
    try {
      if (global._sifrelemeUyariYayinla) global._sifrelemeUyariYayinla(_sifrelemeHatalari.sayac);
    } catch (_) {}
  }
}
function _gurultuMu(args) {
  try {
    // Tum argumanlari (string + nesne) tek metne cevirip kaliplari ara.
    // Boylece "Closing open session" + koca SessionEntry nesnesi dokumunu de yakalariz.
    let s = '';
    for (const a of args) {
      if (typeof a === 'string') s += ' ' + a;
      else if (a && typeof a === 'object') {
        // nesnenin anahtarlarina ve message alanina bak (tum JSON'u stringify etmek pahali olabilir)
        if (a.message) s += ' ' + a.message;
        try { s += ' ' + Object.keys(a).join(' '); } catch (_) {}
      }
    }
    // ŞİFRELEME HATASI SAYACI: gizlemeden ÖNCE say (mesaj gitmeme sorununun habercisi)
    try { _sifrelemeHatasiSay(s); } catch (_) {}
    return _gurultuKaliplari.some(k => s.includes(k));
  } catch (e) { return false; }
}
console.log = (...args) => { if (!_gurultuMu(args)) _origLog(...args); };
console.error = (...args) => { if (!_gurultuMu(args)) _origErr(...args); };
// EK: Baileys/libsignal bazı gürültüyü (özellikle "Closing open session in favor of
// incoming prekey bundle") console.info/warn/debug ile basıyordu -> filtreye takılmıyordu,
// terminali dolduruyordu. Artık bunlar da süzülüyor.
const _origInfo = console.info ? console.info.bind(console) : _origLog;
const _origWarn = console.warn ? console.warn.bind(console) : _origLog;
const _origDebug = console.debug ? console.debug.bind(console) : _origLog;
console.info = (...args) => { if (!_gurultuMu(args)) _origInfo(...args); };
console.warn = (...args) => { if (!_gurultuMu(args)) _origWarn(...args); };
console.debug = (...args) => { if (!_gurultuMu(args)) _origDebug(...args); };

const PORT = 3000;
// Mesaj saklama suresi: bundan eski mesajlar panele dusmez, DB'ye yazilmaz ve periyodik silinir.
const MESAJ_SAKLAMA_GUN = 30;
const MESAJ_SAKLAMA_MS = MESAJ_SAKLAMA_GUN * 24 * 60 * 60 * 1000;
const MEDIA_DIR = path.join(__dirname, 'public', 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
const AUTH_BASE = path.join(__dirname, 'auth'); // her hat: auth/<lineId>/
if (!fs.existsSync(AUTH_BASE)) fs.mkdirSync(AUTH_BASE, { recursive: true });

// ============================================================
// COK HATLI (MULTI-LINE) YAPI
// Her WhatsApp hatti ayri bir "line" objesi. En fazla MAX_LINES hat.
// ============================================================
const MAX_LINES = 5;
const lines = new Map(); // lineId -> line objesi

// Bir hat objesi olustur (henuz baglanmamis)
function createLine(lineId, label, ownerUser) {
  return {
    id: lineId,            // benzersiz hat kimligi (orn. "line1")
    label: label || lineId, // gorunen ad (orn. "Ofis Ana Hat")
    owner: ownerUser || null, // bu hatti ekleyen/sahibi kullanici adi
    sock: null,            // Baileys soketi
    connected: false,      // bagli mi
    myNumber: null,        // bu hattin numarasi
    myLID: null,           // bu hattin LID'i
    myName: '',            // bu hattin WhatsApp adi
    lastQR: null,          // bu hat icin son QR resmi
    manualLogout: false,   // panelden cikis yapildi mi
    chats: new Map(),      // bu hattin sohbetleri (jid -> chat)
    authDir: path.join(AUTH_BASE, lineId), // bu hattin oturum klasoru
    starting: false,       // baglanma islemi suruyor mu (cift baslatmayi onler)
    sonAktivite: 0,        // HAT BAZLI: bu hattan en son ne zaman veri geldi (kalp atisi kontrolu)
    kalpTestCalisiyor: false, // ayni anda iki kalp testi calismasin
    kalpBasarisiz: 0,      // ust uste kac kalp atisi basarisiz (2 olursa yeniden baglan)
  };
}

// Bir hattin durumunu panele yayinla
function lineStatus(line) {
  return {
    id: line.id, label: line.label, connected: line.connected,
    myNumber: line.myNumber, myName: line.myName,
    hasQR: !line.connected && !!line.lastQR,
  };
}

// ---- Geriye donuk uyumluluk koprusu ----
// Eski kod "waSock", "chats", "myNumber" gibi tek-hat degiskenlerini kullaniyordu.
// Bunlari, su an islem yapilan "aktif hatta" yonlendiriyoruz ki eski fonksiyonlar calismaya devam etsin.
// Cogu fonksiyon bir "line" parametresi alacak sekilde guncellenecek; gecis surecinde bu kopru is gorur.
let activeLine = null; // o an islem yapilan hat (mesaj islerken set edilir)

// Not: Asagidaki global'ler artik "aktif hat"tan turetilir (gecis kolayligi icin).
const chats = new Map();   // GECICI: artik her hattin kendi chats'i var; bu bos kalacak / kaldirilacak
let waSock = null;         // GECICI kopru
let waConnected = false;   // GECICI kopru
let _sonWaAktivite = 0;    // WhatsApp'tan en son ne zaman veri/olay geldi (canlilik kontrolu icin)

// ═══════════════════════════════════════════════════════════════════════════
// GÖNDERİM TRAFİK KONTROLÜ (KRİTİK — "mesaj gitti göründü ama gitmemiş" kökü)
// SORUN: 48 kullanıcı aynı ofis hattından yazıyor. Herkes AYNI ANDA gönderince
//   WhatsApp'a aynı milisaniyede 20-40 istek düşüyordu -> WhatsApp boğulup mesajları
//   SESSİZCE düşürüyor (makbuz dönüyor ama iletilmiyor) -> panel "gitti" sanıyor.
//
// ÇÖZÜM FELSEFESİ: Mesajı YAVAŞLATMA. Sadece "aynı anda kaç tane" sınırla.
//   Mesajlar art arda ANINDA gider; sadece 48'i aynı milisaniyede gitmez.
//   Bir gönderim biter bitmez sıradaki HEMEN başlar — bekleme YOK.
//   Tipik gönderim ~150-300ms sürer -> 6 kanal = saniyede ~20-40 mesaj (çok hızlı)
//   ama WhatsApp'a aynı anda en fazla 6 istek düşer (insan gibi, bot gibi değil).
//
// EK KORUMA: WhatsApp "yavaşla" derse (rate-overlimit/429) kanal sayısı geçici düşer,
//   sorun geçince otomatik normale döner. Yani hem hızlı hem güvenli.
// ═══════════════════════════════════════════════════════════════════════════
const ESZAMANLI_KANAL = 6;        // aynı anda en fazla bu kadar gönderim (bekleme YOK)
const ESZAMANLI_KISITLI = 2;      // WhatsApp şikayet ederse geçici olarak bu kadar
const _gonderimDurum = new Map(); // lineId -> { aktif:0, bekleyen:[], kisitliBitis:0 }

function _gd(lineId) {
  let d = _gonderimDurum.get(lineId);
  if (!d) { d = { aktif: 0, bekleyen: [], kisitliBitis: 0 }; _gonderimDurum.set(lineId, d); }
  return d;
}
async function kuyrukluGonder(lineId, gonderFn, medyaMi = false, _deneme = 0) {
  const d = _gd(lineId);
  const limit = (Date.now() < d.kisitliBitis) ? ESZAMANLI_KISITLI : ESZAMANLI_KANAL;
  // kanal doluysa SIRADA bekle (sabit gecikme yok — biri biter bitmez uyanır)
  if (d.aktif >= limit) {
    await new Promise((r) => d.bekleyen.push(r));
  }
  d.aktif++;
  let birakildi = false;
  const kanalBirak = () => {
    if (birakildi) return;
    birakildi = true;
    d.aktif--;
    if (d.aktif < 0) d.aktif = 0;
    const sonraki = d.bekleyen.shift();
    if (sonraki) sonraki(); // sıradakini HEMEN uyandır (bekleme yok)
  };
  try {
    const sonuc = await gonderFn();
    kanalBirak();
    return sonuc;
  } catch (e) {
    const m = (e && e.message ? e.message : '') + ' ' + (e && e.data ? JSON.stringify(e.data) : '');
    const rateMi = /rate.?overlimit|429|too many|rate.?limit/i.test(m);
    kanalBirak(); // her durumda kanalı bırak
    if (rateMi) {
      // WhatsApp "çok hızlısın" dedi -> kanal sayısını 20sn geçici düşür
      d.kisitliBitis = Date.now() + 20000;
      // ═══ OTOMATİK YENİDEN DENEME (KRİTİK) ═══
      // Log kanıtladı: WhatsApp "rate-overlimit" deyip mesajı REDDEDİYOR.
      // Eskiden mesaj burada KAYBOLUYORDU (kullanıcı "gitti sandım" diyordu).
      // Artık kısa bekleyip TEKRAR deniyoruz -> mesaj gidene kadar peşini bırakmıyoruz.
      if (_deneme < 3) {
        const bekle = 800 * Math.pow(2, _deneme); // 0.8sn -> 1.6sn -> 3.2sn
        console.log(`🔄 WhatsApp hız limiti -> ${bekle}ms sonra tekrar denenecek (deneme ${_deneme + 1}/3)`);
        await new Promise((r) => setTimeout(r, bekle));
        return kuyrukluGonder(lineId, gonderFn, medyaMi, _deneme + 1); // TEKRAR DENE
      }
      console.log('❌ WhatsApp hız limiti: 3 denemede de gönderilemedi -> mesaj kırmızı işaretlenecek');
    }
    throw e;
  }
}
// MESAJ ÖNCELİĞİ: en son ne zaman mesaj gönderildi/alındı. Ağır arka plan işleri
// (açıklama motoru, avatar taraması, grup senkronu) mesaj trafiği varken duraklar ki
// soket tıkanmasın -> mesajlar gecikmesin/kaybolmasın (özellikle yoğun ofis hattında).
let _sonMesajTrafigi = 0;
function mesajTrafigiVar() { return (Date.now() - _sonMesajTrafigi) < 10 * 1000; } // son 10sn
let myNumber = null;
let myLID = null;
let lastQR = null;
let manualLogout = false;


// ---- Web sunucusu + WebSocket ----
const app = express();
// nginx/Cloudflare ARKASINDA calisirken kullanicinin GERCEK IP'sini al
// (yoksa hep nginx'in IP'si gelir). IP kisitlamasi icin sart.
app.set('trust proxy', true);

// Medya indirme: ?name= varsa o isimle indir (belgeler gercek adiyla insin)
app.get('/media/:file', (req, res, next) => {
  const wanted = req.query.name;
  const filePath = path.join(MEDIA_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return next();
  if (wanted) {
    // 'inline': tarayicida GORUNTULE (indirme zorlamaz, "yasakli dosya" uyarisi vermez)
    // ama "farkli kaydet" yapilinca da gercek dosya adi gelsin. download=true ise indir.
    const indir = req.query.download === '1';
    const disp = indir ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disp}; filename="${encodeURIComponent(wanted)}"`);
  }
  return res.sendFile(filePath);
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- GIRIS SISTEMI (login + kullanici yonetimi) ----
// Basit oturum: giris yapan kullaniciya bir token verilir, panel bunu saklar.
const sessions = new Map(); // token -> { username, displayName, role, ts }
// BAĞIMSIZ OKUMA yan-rolü olan kullanıcı adları (bellek-içi; açılışta DB'den dolar, restart'a dayanıklı).
let bagimsizOkumaKullanicilar = new Set();
async function bagimsizOkumaYukle() {
  try { const us = await db.listUsers(); bagimsizOkumaKullanicilar = new Set(us.filter(u => u.bagimsiz_okuma).map(u => u.username)); }
  catch (e) { /* db henüz hazır değilse boş kalır, sonra tekrar yüklenir */ }
}
function makeToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ---- IP KISITLAMA ----
// IP IZIN SISTEMI — IKI AYRI LISTE (kapsam bazli):
//  ofisIpler   : OFIS linkinden girenler icin izinli IP'ler (genelde 1 sabit ofis IP'si)
//  disariIpler : DISARI linkinden girenler icin izinli IP'ler (subeler, izinli evler — 5-10 adet)
// Yonetici (admin) HER ZAMAN her IP'den, her linkten girer (muaf).
// IP_KISITLAMA_KAPALI=1 olursa (acil durum) tum kisitlama kapanir -> herkes girer.
let ofisIpler = new Set();
let disariIpler = new Set();
// IP kisitlamasi KAPALI mi? Iki kaynaktan kontrol:
//  1) .env IP_KISITLAMA_KAPALI=1  -> ACIL CIKIS (her zaman oncelikli, kod degismeden kapatir)
//  2) DB ayari 'ip_kisitlama_kapali'='1' -> PANELDEN yonetici acip kapatir (kalici)
// Boylece yonetici .env'e dokunmadan panelden tek tusla acip kapatabilir.
let _ipKisitlamaKapaliDB = false; // DB'den yuklenen bayrak (bellekte, hizli erisim)
const ipKisitlamaKapali = () => (process.env.IP_KISITLAMA_KAPALI === '1') || _ipKisitlamaKapaliDB;
// OFIS domain(ler)i: .env'de OFIS_DOMAIN=ofis.site.com (virgulle birden fazla olabilir).
// Istek bu domain(ler)den geldiyse "ofis linki", degilse "disari linki" sayilir.
const _ofisDomainler = () => (process.env.OFIS_DOMAIN || '')
  .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
// istekten gercek IP'yi al (nginx arkasinda x-forwarded-for'dan gelir; trust proxy acik)
function gercekIp(req) {
  let ip = (req.ip || '').trim();
  // IPv6-mapped IPv4 (::ffff:1.2.3.4) -> 1.2.3.4
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}
// istek HANGI linkten geldi? Host basligina bakar -> 'ofis' veya 'disari'
function istekKapsami(req) {
  const host = (req.headers.host || '').toLowerCase().split(':')[0]; // port'u at
  const ofisler = _ofisDomainler();
  if (ofisler.length && ofisler.includes(host)) return 'ofis';
  return 'disari';
}
// bu IP, bu KAPSAM (ofis/disari) icin izinli mi?
function ipIzinliMi(ip, kapsam = 'disari') {
  if (ipKisitlamaKapali()) return true;       // acil durum: kisitlama kapali
  const liste = (kapsam === 'ofis') ? ofisIpler : disariIpler;
  if (liste.size === 0) return true;           // bu liste bossa o link icin kisitlama yok (kilitlenmeyi onler)
  return liste.has(ip);
}
// izinli IP'leri DB'den bellege yukle (kapsamlara ayir)
async function izinliIpleriYukle() {
  if (!db.isReady()) return;
  try {
    const liste = await db.loadAllowedIps();
    ofisIpler = new Set(liste.filter(x => x.kapsam === 'ofis').map(x => x.ip));
    disariIpler = new Set(liste.filter(x => x.kapsam !== 'ofis').map(x => x.ip));
    // panelden ayarlanan "kisitlama kapali" bayragini da DB'den oku
    const bayrak = await db.getSetting('ip_kisitlama_kapali', '0');
    _ipKisitlamaKapaliDB = (bayrak === '1' || bayrak === 1 || bayrak === true);
    console.log(`🔒 IP listeleri yuklendi: ofis=${ofisIpler.size}, disari=${disariIpler.size}, kisitlama=${ipKisitlamaKapali() ? 'KAPALI' : 'acik'}`);
  } catch (e) { console.error('izinli IP yukleme hatasi:', e.message); }
}

// Giris yap
app.post('/api/login', express.json(), async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'Kullanıcı adı ve şifre gerekli' });
  if (!db.isReady()) return res.json({ ok: false, error: 'Veritabanı bağlı değil, giriş yapılamıyor' });
  const user = await db.checkLogin(username.trim(), password);
  if (!user) return res.json({ ok: false, error: 'Kullanıcı adı veya şifre hatalı' });
  // IP KISITLAMA: kullanici sadece izinli IP'den girebilir.
  // SADECE süper yönetici (burak) her IP'den girer ki sistem asla kilitlenmesin +
  // IP listesini yönetebilsin. Diğer TÜM kullanıcılar (normal yöneticiler dahil) IP'ye tabi.
  const superAdmin = (user.username === 'burak');
  if (!superAdmin) {
    const ip = gercekIp(req);
    const kapsam = istekKapsami(req); // hangi linkten geldi: ofis / disari
    if (!ipIzinliMi(ip, kapsam)) {
      console.log(`⛔ IP engellendi: ${username} | IP: ${ip} | link: ${kapsam} (izinli degil)`);
      const linkAdi = kapsam === 'ofis' ? 'ofis' : 'dışarı';
      return res.json({ ok: false, error: `Bu konumdan (IP) ${linkAdi} girişine izin yok. Yöneticinize başvurun.`, ipBlocked: true, ip });
    }
  }
  const token = makeToken();
  // Kullanicinin HANGI hatta bagli oldugunu bul (ofis kullanicilari 'ofis', pazarlamacilar kendi hatti)
  const hatBilgi = await db.getUserLine(user.username);
  const lineId = hatBilgi.line_id || 'ofis';
  const lineTip = hatBilgi.tip || 'ofis';
  sessions.set(token, { username: user.username, displayName: user.display_name, role: user.role, ts: Date.now(), lineId, lineTip });
  // oturumu Supabase'e de yaz (sunucu restart olunca kaybolmasin)
  db.saveSession(token, user.username, user.display_name, user.role).catch(() => {});
  // PAZARLAMACI girisi: kendi hatti henuz baglanmamissa BASLAT (QR uretsin / kayitli oturumla baglansin).
  // Ofis hatti zaten acilista baslatiliyor, ona dokunma.
  if (lineTip === 'pazarlama' && lineId !== 'ofis') {
    const mevcutHat = lines.get(lineId);
    if (!mevcutHat || (!mevcutHat.connected && !mevcutHat.starting)) {
      console.log(`📱 Pazarlamaci girisi: '${lineId}' hatti baslatiliyor (${user.username})...`);
      startWA(lineId).catch(e => console.error(`Hat baslatilamadi (${lineId}):`, e.message));
    }
  }
  res.json({ ok: true, token, displayName: user.display_name, role: user.role, username: user.username, bagimsizOkuma: !!user.bagimsiz_okuma, lineId, lineTip });
});

// Token gecerli mi (panel acilinca kontrol)
app.post('/api/whoami', express.json(), async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.json({ ok: false });
  let s = sessions.get(token);
  // Bellekte yoksa (sunucu yeniden baslamis olabilir) Supabase'den yukle ve bellege geri koy.
  if (!s && db.isReady()) {
    const rows = await db.loadSessions();
    for (const r of rows) sessions.set(r.token, { username: r.username, displayName: r.display_name, role: r.role, ts: Date.now() });
    s = sessions.get(token);
    // session DB'den geldiyse hat bilgisi eksik olabilir — kullanicinin hattini cek + session'a ekle
    if (s && !s.lineId) {
      const hb = await db.getUserLine(s.username);
      s.lineId = hb.line_id || 'ofis';
      s.lineTip = hb.tip || 'ofis';
    }
  }
  if (!s) return res.json({ ok: false });
  const lineId = s.lineId || 'ofis';
  const lineTip = s.lineTip || 'ofis';
  // PAZARLAMACI ise ve hatti bagli degilse, hattini baslat (sayfa yenilemede de QR gelsin)
  if (lineTip === 'pazarlama' && lineId !== 'ofis') {
    const mevcut = lines.get(lineId);
    if (!mevcut || (!mevcut.connected && !mevcut.starting)) {
      startWA(lineId).catch(() => {});
    }
  }
  res.json({ ok: true, displayName: s.displayName, role: s.role, username: s.username, bagimsizOkuma: bagimsizOkumaKullanicilar.has(s.username), lineId, lineTip });
});

// Cikis (token sil)
app.post('/api/applogout', express.json(), (req, res) => {
  const { token } = req.body || {};
  if (token) { sessions.delete(token); db.deleteSession(token).catch(() => {}); }
  res.json({ ok: true });
});

// Yardimci: istek yoneticiden mi geliyor?
function isAdmin(token) {
  const s = token && sessions.get(token);
  return s && s.role === 'admin';
}
// Ödemeleri ONAYLAYABİLİR mi? (muhasebeci veya yönetici)
function odemeOnaylayabilir(token) {
  const s = token && sessions.get(token);
  return s && (s.role === 'admin' || s.role === 'muhasebeci');
}
// token'dan oturum bilgisi (username + ad) al
function oturumBilgi(token) {
  const s = token && sessions.get(token);
  if (!s) return null;
  return { username: s.username, ad: s.displayName || s.username, role: s.role };
}

// ════════════════════════════════════════════════════════════
// SONRADAN GELEN ÖDEMELER API
// - Yükleme: HERKES (giriş yapan her kullanıcı) yapabilir
// - Listeleme: HERKES görebilir
// - Silme: kendi yüklediğini herkes silebilir; muhasebeci/yönetici hepsini silebilir
// - Onaylama (kaldırma): sadece muhasebeci/yönetici
// ════════════════════════════════════════════════════════════
// ÇOKLU BELGE tek ödeme: panelden birden fazla dosya (base64 dizisi) tek kayıtta toplanır.
app.post('/api/odeme/coklu', express.json({ limit: '128mb' }), async (req, res) => {
  const bilgi = oturumBilgi(req.body?.token);
  if (!bilgi) return res.json({ ok: false, error: 'Giriş gerekli' });
  try {
    const gelenler = Array.isArray(req.body?.belgeler) ? req.body.belgeler : [];
    const notMetni = req.body?.not || '';
    if (!gelenler.length) return res.json({ ok: false, error: 'Belge yok' });
    const belgeler = [];
    for (const b of gelenler) {
      // b: { veri (base64 veya /media/... url), ad, mime, mevcutUrl? }
      if (b.mevcutUrl && String(b.mevcutUrl).startsWith('/media/')) {
        // Mesajdan gelen: zaten /media'da olan dosyanın kopyasını al
        const kaynak = path.join(MEDIA_DIR, b.mevcutUrl.replace('/media/', '').split('?')[0]);
        if (!fs.existsSync(kaynak)) continue;
        const ext = (kaynak.split('.').pop() || 'bin').slice(0, 8);
        const yeniAd = `odeme_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        fs.copyFileSync(kaynak, path.join(MEDIA_DIR, yeniAd));
        belgeler.push({ url: '/media/' + yeniAd, ad: b.ad || ('Belge.' + ext), tip: b.tip || (ext === 'pdf' ? 'pdf' : 'image') });
      } else if (b.veri) {
        // Bilgisayardan yüklenen: base64 çöz, kaydet
        const orijinalAd = b.ad || 'dosya';
        const mime = b.mime || 'application/octet-stream';
        let ext = 'bin';
        if (orijinalAd.includes('.')) ext = orijinalAd.split('.').pop().slice(0, 8);
        else if (mime.startsWith('image/')) ext = mime.split('/')[1] || 'jpg';
        else if (mime === 'application/pdf') ext = 'pdf';
        const buf = Buffer.from(String(b.veri).split(',').pop(), 'base64');
        if (!buf.length) continue;
        const fileName = `odeme_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        fs.writeFileSync(path.join(MEDIA_DIR, fileName), buf);
        belgeler.push({ url: '/media/' + fileName, ad: orijinalAd, tip: mime.startsWith('image/') ? 'image' : (mime === 'application/pdf' ? 'pdf' : 'dosya') });
      }
    }
    if (!belgeler.length) return res.json({ ok: false, error: 'Belgeler kaydedilemedi' });
    const id = 'odm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const r = await db.odemeEkle({
      id, yukleyenKullanici: bilgi.username, yukleyenAd: bilgi.ad,
      belgeler, not: notMetni,
    });
    if (!r.ok) return res.json({ ok: false, error: r.error || 'Kaydedilemedi' });
    broadcastHat('ofis', { type: 'odemeGuncellendi' });
    res.json({ ok: true, belgeSayisi: belgeler.length, tekBelge: r.tekBelge });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Ödeme dosyası yükle (panelden seçerek veya sürükleyerek). Dosya /media'ya kaydedilir.
app.post('/api/odeme/yukle', express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
  const token = req.query.token;
  const bilgi = oturumBilgi(token);
  if (!bilgi) return res.json({ ok: false, error: 'Giriş gerekli' });
  try {
    const notMetni = req.query.not ? decodeURIComponent(req.query.not) : '';
    const orijinalAd = req.query.ad ? decodeURIComponent(req.query.ad) : 'dosya';
    const mime = req.query.mime ? decodeURIComponent(req.query.mime) : 'application/octet-stream';
    const buf = req.body;
    if (!buf || !buf.length) return res.json({ ok: false, error: 'Dosya boş' });
    // uzantı bul
    let ext = 'bin';
    if (orijinalAd.includes('.')) ext = orijinalAd.split('.').pop().slice(0, 8);
    else if (mime.startsWith('image/')) ext = mime.split('/')[1] || 'jpg';
    else if (mime === 'application/pdf') ext = 'pdf';
    const fileName = `odeme_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, fileName), buf);
    const id = 'odm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const r = await db.odemeEkle({
      id,
      yukleyenKullanici: bilgi.username,
      yukleyenAd: bilgi.ad,
      dosyaUrl: '/media/' + fileName,
      dosyaAd: orijinalAd,
      dosyaTip: mime.startsWith('image/') ? 'image' : (mime === 'application/pdf' ? 'pdf' : 'dosya'),
      not: notMetni,
    });
    if (!r.ok) return res.json({ ok: false, error: r.error || 'Kaydedilemedi' });
    // tüm ofis panellerine "yeni ödeme" bildir (liste tazelensin)
    broadcastHat('ofis', { type: 'odemeGuncellendi' });
    res.json({ ok: true, kayit: r.kayit });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
// Mesajdan ödeme ekle: mevcut bir medya dosyasını (zaten /media'da) ödeme olarak kaydet.
app.post('/api/odeme/mesajdan', express.json(), async (req, res) => {
  const bilgi = oturumBilgi(req.body?.token);
  if (!bilgi) return res.json({ ok: false, error: 'Giriş gerekli' });
  try {
    const mediaUrl = req.body?.mediaUrl || '';
    const kind = req.body?.kind || 'dosya';
    const notMetni = req.body?.not || '';
    if (!mediaUrl.startsWith('/media/')) return res.json({ ok: false, error: 'Geçersiz dosya' });
    // dosyanın gerçekten var olduğunu kontrol et + bir kopyasını oluştur (orijinal mesajda kalsın)
    const kaynak = path.join(MEDIA_DIR, mediaUrl.replace('/media/', '').split('?')[0]);
    if (!fs.existsSync(kaynak)) return res.json({ ok: false, error: 'Dosya bulunamadı' });
    const ext = (kaynak.split('.').pop() || 'bin').slice(0, 8);
    const yeniAd = `odeme_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.copyFileSync(kaynak, path.join(MEDIA_DIR, yeniAd));
    const id = 'odm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const dosyaAd = (kind === 'image' ? 'Fotoğraf' : 'Belge') + '.' + ext;
    const r = await db.odemeEkle({
      id,
      yukleyenKullanici: bilgi.username,
      yukleyenAd: bilgi.ad,
      dosyaUrl: '/media/' + yeniAd,
      dosyaAd,
      dosyaTip: kind === 'image' ? 'image' : (ext === 'pdf' ? 'pdf' : 'dosya'),
      not: notMetni,
    });
    if (!r.ok) return res.json({ ok: false, error: r.error || 'Kaydedilemedi' });
    broadcastHat('ofis', { type: 'odemeGuncellendi' });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Ödemeleri listele (bekleyenler)
app.post('/api/odeme/liste', express.json(), async (req, res) => {
  const bilgi = oturumBilgi(req.body?.token);
  if (!bilgi) return res.json({ ok: false, error: 'Giriş gerekli' });
  const liste = await db.odemeleriListele();
  // panele: bu kullanıcı onaylayabilir mi + kendi username'i (kendi sildiğini ayırt etmek için)
  res.json({ ok: true, liste, benUsername: bilgi.username, onaylayabilir: odemeOnaylayabilir(req.body?.token) });
});
// Ödeme notunu düzenle (kendi yüklediği VEYA yetkili)
app.post('/api/odeme/not', express.json(), async (req, res) => {
  const bilgi = oturumBilgi(req.body?.token);
  if (!bilgi) return res.json({ ok: false, error: 'Giriş gerekli' });
  const id = req.body?.id;
  const yeniNot = (req.body?.not || '').slice(0, 500);
  const kayit = await db.odemeBul(id);
  if (!kayit) return res.json({ ok: false, error: 'Kayıt bulunamadı' });
  const yetkili = odemeOnaylayabilir(req.body?.token) || (kayit.yukleyen_kullanici === bilgi.username);
  if (!yetkili) return res.json({ ok: false, error: 'Bu notu düzenleme yetkiniz yok' });
  const r = await db.odemeNotGuncelle(id, yeniNot);
  if (!r.ok) return res.json({ ok: false, error: r.error || 'Güncellenemedi' });
  broadcastHat('ofis', { type: 'odemeGuncellendi' });
  res.json({ ok: true });
});

// Ödeme sil / onayla (kaldır). Onaylama = listeden kaldırma (muhasebeci/yönetici).
app.post('/api/odeme/sil', express.json(), async (req, res) => {
  const bilgi = oturumBilgi(req.body?.token);
  if (!bilgi) return res.json({ ok: false, error: 'Giriş gerekli' });
  const id = req.body?.id;
  const kalici = !!req.body?.kalici; // true ise çöpten TAMAMEN sil
  const kayit = await db.odemeBul(id);
  if (!kayit) return res.json({ ok: false, error: 'Kayıt bulunamadı' });
  const yetkili = odemeOnaylayabilir(req.body?.token) || (kayit.yukleyen_kullanici === bilgi.username);
  if (!yetkili) return res.json({ ok: false, error: 'Bunu kaldırma yetkiniz yok' });

  // KALICI SİL (çöp kutusundan): dosyaları diskten de sil, kaydı tamamen kaldır
  if (kalici || kayit.durum === 'arsiv') {
    try {
      // tüm belgeleri (çoklu) diskten sil
      let belgeler = [];
      try { belgeler = kayit.belgeler ? (typeof kayit.belgeler === 'string' ? JSON.parse(kayit.belgeler) : kayit.belgeler) : []; } catch (_) {}
      if (!belgeler.length && kayit.dosya_url) belgeler = [{ url: kayit.dosya_url }];
      for (const b of belgeler) {
        if (b.url) { const yol = path.join(MEDIA_DIR, b.url.replace('/media/', '').split('?')[0]); if (fs.existsSync(yol)) fs.unlinkSync(yol); }
      }
    } catch (e) {}
    await db.odemeSil(id);
    broadcastHat('ofis', { type: 'odemeGuncellendi' });
    return res.json({ ok: true, kalici: true });
  }

  // NORMAL "kaldır": TAMAMEN silme, ÇÖP KUTUSUNA at (yanlışlıkla kaldırmaya karşı koruma).
  // Dosyalar diskte kalır (geri alınabilsin). Çöpten silinince tamamen gider.
  await db.odemeArsivle(id);
  broadcastHat('ofis', { type: 'odemeGuncellendi' });
  res.json({ ok: true, arsivlendi: true });
});
// Çöp kutusundaki (arşiv) ödemeleri listele
app.post('/api/odeme/arsivListe', express.json(), async (req, res) => {
  const bilgi = oturumBilgi(req.body?.token);
  if (!bilgi) return res.json({ ok: false, error: 'Giriş gerekli' });
  const liste = await db.odemeArsivListe();
  res.json({ ok: true, liste, onaylayabilir: odemeOnaylayabilir(req.body?.token), benUsername: bilgi.username });
});
// Çöpten geri al (tekrar bekleyene döndür)
app.post('/api/odeme/geriAl', express.json(), async (req, res) => {
  const bilgi = oturumBilgi(req.body?.token);
  if (!bilgi) return res.json({ ok: false, error: 'Giriş gerekli' });
  const kayit = await db.odemeBul(req.body?.id);
  if (!kayit) return res.json({ ok: false, error: 'Kayıt bulunamadı' });
  const yetkili = odemeOnaylayabilir(req.body?.token) || (kayit.yukleyen_kullanici === bilgi.username);
  if (!yetkili) return res.json({ ok: false, error: 'Yetkiniz yok' });
  await db.odemeGeriAl(req.body?.id);
  broadcastHat('ofis', { type: 'odemeGuncellendi' });
  res.json({ ok: true });
});

// ---- IZINLI IP YONETIMI (sadece yonetici) ----
// Iki ayri liste: ofis (ofis linki icin) ve disari (disari linki icin).
app.post('/api/ips', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  const liste = await db.loadAllowedIps();
  res.json({
    ok: true,
    ofisIps: liste.filter(x => x.kapsam === 'ofis'),
    disariIps: liste.filter(x => x.kapsam !== 'ofis'),
    benimIp: gercekIp(req),                 // yoneticinin su anki IP'si (tek tikla eklemek icin)
    benimKapsam: istekKapsami(req),         // yonetici su an hangi linkten girmis
    kisitlamaKapali: ipKisitlamaKapali(),   // acil durum bayragi acik mi
  });
});
// IP ekle (kapsam: ofis | disari)
app.post('/api/ips/add', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  let ip = (req.body?.ip || '').trim();
  const aciklama = (req.body?.aciklama || '').trim();
  const kapsam = req.body?.kapsam === 'ofis' ? 'ofis' : 'disari';
  if (!ip) return res.json({ ok: false, error: 'IP boş olamaz' });
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  await db.addAllowedIp(ip, aciklama, kapsam);
  await izinliIpleriYukle(); // bellegi tazele
  res.json({ ok: true });
});
// IP cikar
app.post('/api/ips/remove', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  const ip = (req.body?.ip || '').trim();
  if (!ip) return res.json({ ok: false, error: 'IP boş' });
  await db.removeAllowedIp(ip);
  await izinliIpleriYukle();
  res.json({ ok: true });
});
// IP KISITLAMASINI AC/KAPAT (panelden tek tusla, sadece yonetici).
// kapali=true  -> kisitlama KAPALI (herkes her IP'den girer)
// kapali=false -> kisitlama ACIK (sadece izinli IP'ler girer)
app.post('/api/ips/kisitlama', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  // .env'de acil kapatma varsa, panelden ACMAYA calismak bir ise yaramaz — kullaniciyi uyar.
  if (process.env.IP_KISITLAMA_KAPALI === '1') {
    return res.json({ ok: false, error: 'Sunucuda acil kapatma (.env) açık. Önce onu kaldırın.' });
  }
  const kapali = req.body?.kapali === true || req.body?.kapali === 'true' || req.body?.kapali === 1;
  await db.saveSetting('ip_kisitlama_kapali', kapali ? '1' : '0');
  _ipKisitlamaKapaliDB = kapali; // bellegi hemen guncelle (yeniden yukleme beklemeden)
  console.log(`🔒 IP kisitlamasi ${kapali ? 'KAPATILDI' : 'ACILDI'} (panelden, ${req.body?.agent || 'yonetici'})`);
  res.json({ ok: true, kisitlamaKapali: ipKisitlamaKapali() });
});

// Kullanici listesi (sadece yonetici)
app.post('/api/users', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  const users = await db.listUsers();
  res.json({ ok: true, users });
});

// Aktif (su an panelde acik) kullanicilar (sadece yonetici)
// WebSocket'i acik olan her kullanici "aktif". Tum kullanici listesiyle birlestirip
// kim aktif (yesil) kim degil (kirmizi) doneriz.
app.post('/api/users/active', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  // o an bagli WS'lerden aktif username'leri topla
  const aktifSet = new Set();
  const girisMap = {}; // username -> en eski acik baglantinin giris zamani (gercek giris saati)
  wss.clients.forEach((c) => {
    if (c.readyState === 1 && c._username) {
      aktifSet.add(c._username);
      if (c._girisTs && (!girisMap[c._username] || c._girisTs < girisMap[c._username])) girisMap[c._username] = c._girisTs;
    }
  });
  const users = await db.listUsers();
  const liste = users.map(u => ({
    username: u.username,
    displayName: u.display_name || u.username,
    role: u.role,
    active: aktifSet.has(u.username),
    girisTs: girisMap[u.username] || null, // aktifse giris saati
  }));
  res.json({ ok: true, users: liste });
});

// Yeni kullanici ekle (sadece yonetici)
// ── KENDİ ŞİFREM: giriş yapmış kullanıcı kendi bilgilerini görür ──
// Sadece KENDİ şifresini döner; başkasınınkini asla.
app.post('/api/me/password', express.json(), async (req, res) => {
  const s = req.body?.token && sessions.get(req.body.token);
  if (!s) return res.json({ ok: false, error: 'Oturum geçersiz' });
  const u = await db.getOwnPassword(s.username);
  if (!u) return res.json({ ok: false, error: 'Kullanıcı bulunamadı' });
  res.json({ ok: true, username: u.username, password: u.password, displayName: u.display_name });
});

// ── ŞİFRE LİSTESİ (yönetici): tüm kullanıcı adı + şifreler ──
// SADECE admin. Panelde varsayılan GİZLİ, kullanıcı "Göster"e basınca açılır.
app.post('/api/users/passwords', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  const users = await db.listUsersWithPasswords();
  const s = sessions.get(req.body.token);
  console.log(`🔑 Şifre listesi görüntülendi | yönetici: ${s ? s.username : '?'} | ${users.length} kullanıcı`);
  res.json({ ok: true, users });
});

app.post('/api/users/add', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  const { username, password, displayName, role, tip } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'Kullanıcı adı ve şifre gerekli' });
  const uname = username.trim();
  // Rol: admin, pzr_yonetici (pazarlama yöneticisi), muhasebeci, hat_sorumlusu veya agent (normal)
  // hat_sorumlusu = normal temsilci (agent) ile AYNI, tek farkı WhatsApp bağlayıp/çıkış yapabilmesi.
  let gecerliRol = 'agent';
  if (role === 'admin') gecerliRol = 'admin';
  else if (role === 'pzr_yonetici') gecerliRol = 'pzr_yonetici';
  else if (role === 'muhasebeci') gecerliRol = 'muhasebeci';
  else if (role === 'hat_sorumlusu') gecerliRol = 'hat_sorumlusu';
  const r = await db.addUser(uname, password, displayName, gecerliRol);
  if (r.ok) {
    // Pazarlama yöneticisi + Muhasebeci: hat gerekmez, ofis hattına bağla (zararsız).
    // hat_sorumlusu: normal kullanıcı gibi davranır (aşağıdaki tip mantığına düşer).
    if (gecerliRol === 'pzr_yonetici' || gecerliRol === 'muhasebeci') {
      await db.setUserLine(uname, 'ofis', 'ofis');
    } else {
      // KULLANICI TIPI: 'pazarlama' ise kendi ayri hattini olustur, 'ofis' ise ortak hatta bagla.
      const kullaniciTipi = (tip === 'pazarlama') ? 'pazarlama' : 'ofis';
      if (kullaniciTipi === 'pazarlama') {
        const lineId = 'pzr_' + uname; // her pazarlamaciya ozel hat (orn. pzr_fatma)
        await db.saveLine(lineId, (displayName || uname) + ' (Pazarlama)', 'pazarlama', uname);
        await db.setUserLine(uname, lineId, 'pazarlama');
      } else {
        await db.setUserLine(uname, 'ofis', 'ofis'); // ofis kullanicisi ortak hatta
      }
    }
  }
  res.json(r);
});

// Kullanici sil (sadece yonetici)
app.post('/api/users/delete', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  const r = await db.deleteUser(req.body?.id);
  res.json(r);
});

// Kullanici DUZENLE: gorunen ad / giris adi / sifre (sadece yonetici).
// Sadece gonderilen alanlar degisir. Sifre bos gonderilirse degismez.
app.post('/api/users/update', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  const id = req.body?.id;
  if (!id) return res.json({ ok: false, error: 'Kullanıcı seçili değil' });
  const r = await db.updateUser(id, {
    displayName: req.body?.displayName,
    username: req.body?.username,
    password: req.body?.password,
  });
  if (r.ok && r.username && r.eskiUsername && r.username !== r.eskiUsername) {
    // GIRIS ADI degisti: bellekteki oturumlarda da username'i guncelle (yoksa o kullanici
    // bir sonraki istekte taninmaz). Acik oturumlarini yeni ada tasi.
    for (const [tok, s] of sessions) {
      if (s.username === r.eskiUsername) s.username = r.username;
    }
    console.log(`✏️  Kullanici guncellendi: ${r.eskiUsername} -> ${r.username}`);
  } else if (r.ok) {
    console.log(`✏️  Kullanici bilgileri guncellendi (id: ${id})`);
  }
  // ── ANLIK BİLDİRİM: giriş bilgisi değişen kullanıcıya HEMEN haber ver ──
  // Yönetici şifreyi/kullanıcı adını değiştirdiğinde o kişi ekranında anında görsün,
  // yoksa bir dahaki girişte "şifrem çalışmıyor" diye takılır.
  if (r.ok && (req.body?.password || (r.username && r.eskiUsername && r.username !== r.eskiUsername))) {
    const hedefKullanici = r.username || r.eskiUsername;
    try {
      wss.clients.forEach((c) => {
        if (c.readyState === 1 && c._username === hedefKullanici) {
          c.send(JSON.stringify({
            type: 'girisBilgisiDegisti',
            username: hedefKullanici,
            password: req.body?.password || null, // şifre değişmediyse null
            adDegisti: !!(r.username && r.eskiUsername && r.username !== r.eskiUsername),
          }));
        }
      });
      console.log(`   📢 "${hedefKullanici}" bilgilendirildi (giriş bilgisi değişti)`);
    } catch (_) {}
  }
  res.json(r);
});

// MEVCUT kullanicinin HAT TIPINI degistir (ofis <-> pazarlama). Sadece yonetici.
// Kullanim: eski/yanlis eslenmis kullaniciyi pazarlamaya cevirmek icin
// (orn. Volkan 'ofis'e dusmus -> pazarlamaya al, kendi hatti olsun).
app.post('/api/users/setline', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  const username = (req.body?.username || '').trim();
  const tip = req.body?.tip === 'pazarlama' ? 'pazarlama' : 'ofis';
  if (!username) return res.json({ ok: false, error: 'Kullanıcı adı gerekli' });
  try {
    if (tip === 'pazarlama') {
      const lineId = 'pzr_' + username; // her pazarlamaciya ozel hat
      await db.saveLine(lineId, username + ' (Pazarlama)', 'pazarlama', username);
      await db.setUserLine(username, lineId, 'pazarlama');
      console.log(`🔧 Kullanici '${username}' PAZARLAMA yapildi -> hat: ${lineId}`);
      return res.json({ ok: true, username, lineId, tip: 'pazarlama', message: `${username} artık pazarlama (hat: ${lineId}). Yeniden giriş yapmalı.` });
    } else {
      await db.setUserLine(username, 'ofis', 'ofis');
      console.log(`🔧 Kullanici '${username}' OFIS yapildi (ortak hat)`);
      return res.json({ ok: true, username, lineId: 'ofis', tip: 'ofis', message: `${username} artık ofis (ortak hat). Yeniden giriş yapmalı.` });
    }
  } catch (e) {
    console.error('setline hatasi:', e.message);
    return res.json({ ok: false, error: e.message });
  }
});

// ============================================================
// SATIŞ TAKİBİ API (kontrol sekmesi)
// ============================================================
// Yardimci: token'dan {session, lineId, isAdmin} cikar
function satisYetki(token) {
  const s = token && sessions.get(token);
  if (!s) return null;
  const pzrYonetici = (s.role === 'pzr_yonetici'); // pazarlama yöneticisi: sadece pazarlama satışları
  return {
    s, lineId: s.lineId || 'ofis',
    isAdmin: s.role === 'admin',
    pzrYonetici,                       // pazarlama yöneticisi mi
    username: s.username, displayName: s.displayName,
  };
}

// Sadece PAZARLAMA hatlarının satışlarını yükle (pazarlama yöneticisi için).
async function pazarlamaSatislariYukle(basTs, bitTs) {
  // tüm satışları al, sonra sadece pazarlama hatlarınkini süz (lineId 'pzr_' ile başlar)
  const tum = (basTs && bitTs) ? await db.loadTumSatislar(basTs, bitTs) : await db.loadTumSatislar();
  return tum.filter(x => (x.line_id || x.lineId || '').startsWith('pzr_'));
}
// Tarih araligi yardimcisi: 'bugun' | 'hafta' | 'tum' -> {bas, bit} (epoch ms) veya null
function tarihAraligi(kapsam) {
  const now = new Date();
  if (kapsam === 'bugun') {
    const bas = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime();
    const bit = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
    return { bas, bit };
  }
  if (kapsam === 'hafta') {
    const bit = Date.now();
    const bas = bit - 7 * 24 * 60 * 60 * 1000; // son 7 gun
    return { bas, bit };
  }
  if (kapsam === 'ay') {
    // BU AY: ayin 1'i 00:00 -> simdi
    const bas = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0).getTime();
    return { bas, bit: Date.now() };
  }
  return null; // tum
}

// Satışları getir. Pazarlamaci KENDI hattini, yonetici TUMUNU (veya secili hat) gorur.
// ═══ POS TEMİZLİĞİ (yanlışlıkla poliçe sayılmış POS formları) — SADECE ADMIN ═══
// Önce LİSTELE (kim, hangi dosya) -> yönetici görsün; sonra SİL.
app.post('/api/pos/liste', express.json(), async (req, res) => {
  const y = satisYetki(req.body?.token);
  if (!y || !y.isAdmin) return res.json({ ok: false, error: 'Yetki yok' });
  try {
    const kayitlar = await db.posBenzeriPoliceler(posMuFormu, req.body?.lineId || null);
    const kisiSayaci = {};
    kayitlar.forEach(k => { const ad = k.kullanici_ad || k.kullanici || '?'; kisiSayaci[ad] = (kisiSayaci[ad] || 0) + 1; });
    // TEŞHİS: hiç bulunamadıysa DB'de gerçekte ne var göster (yükleme mi tespit mi sorunu?)
    let teshis = null;
    if (kayitlar.length === 0) {
      const tumu = await db.loadPoliceYuklemeler(null, null, null);
      // ham metinde pos/pso/ps harfleri geçen HER kaydı bul (geniş tarama)
      const hamGecen = tumu.filter(k => /pos|pso|p\W?s/i.test(k.dosya_adi || ''));
      teshis = {
        toplamKayit: tumu.length,
        hamGecenSayi: hamGecen.length,
        ornekler: hamGecen.slice(0, 15).map(k => ({ ad: k.kullanici_ad || k.kullanici, dosya: k.dosya_adi })),
      };
    }
    res.json({
      ok: true, toplam: kayitlar.length,
      kisiler: Object.entries(kisiSayaci).map(([ad, n]) => ({ ad, adet: n })).sort((a, b) => b.adet - a.adet),
      kayitlar: kayitlar.map(k => ({
        id: k.id, ad: k.kullanici_ad || k.kullanici || '?', dosya: k.dosya_adi || '(ad yok)',
        grup: k.chat_name || '', brans: k.brans || '', tarih: k.ts,
      })),
      teshis,
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
// SEÇİLİ POS kayıtlarını sil (arayüzden işaretlenen id'ler)
app.post('/api/pos/silSecili', express.json(), async (req, res) => {
  const y = satisYetki(req.body?.token);
  if (!y || !y.isAdmin) return res.json({ ok: false, error: 'Yetki yok' });
  const idler = Array.isArray(req.body?.idler) ? req.body.idler : [];
  if (!idler.length) return res.json({ ok: false, error: 'Silinecek kayıt seçilmedi' });
  try {
    const r = await db.policeIdSil(idler);
    if (r.ok) console.log(`🧹 POS elle temizlik (${y.username}): ${r.silinen} kayıt silindi`);
    res.json(r);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
// GENİŞ POS TARAMA: dosya adında pos/pso/ps GEÇEN tüm kayıtları getir (gevşek — teşhisle aynı).
// posMuFormu bir sebeple kaçırırsa diye "her ihtimale karşı" tam liste. Kullanıcı elle seçer.
app.post('/api/pos/genisListe', express.json(), async (req, res) => {
  const y = satisYetki(req.body?.token);
  if (!y || !y.isAdmin) return res.json({ ok: false, error: 'Yetki yok' });
  try {
    const tumu = await db.loadPoliceYuklemeler(null, null, null);
    // dosya adında pos VEYA pso GEÇEN (ham, sınırsız) — teşhisin bulduğu 150 kayıt bunlar
    const eslesme = tumu.filter(k => /pos|pso/i.test(k.dosya_adi || ''));
    // otomatik tespit (posMuFormu) bunu POS say-IYOR mu? işaretle ki kullanıcı ayırt etsin
    const kayitlar = eslesme.map(k => ({
      id: k.id, ad: k.kullanici_ad || k.kullanici || '?', dosya: k.dosya_adi || '(ad yok)',
      grup: k.chat_name || '', brans: k.brans || '', tarih: k.ts,
      kesinPos: posMuFormu(k.dosya_adi || ''), // true=otomatik de POS diyor, false=sadece harf geçiyor
    }));
    const kisiSayaci = {};
    kayitlar.forEach(k => { kisiSayaci[k.ad] = (kisiSayaci[k.ad] || 0) + 1; });
    res.json({
      ok: true, toplam: kayitlar.length,
      kisiler: Object.entries(kisiSayaci).map(([ad, n]) => ({ ad, adet: n })).sort((a, b) => b.adet - a.adet),
      kayitlar,
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/pos/temizle', express.json(), async (req, res) => {
  const y = satisYetki(req.body?.token);
  if (!y || !y.isAdmin) return res.json({ ok: false, error: 'Yetki yok' });
  try {
    const r = await db.posBenzeriSil(posMuFormu, req.body?.lineId || null);
    if (r.ok) console.log(`🧹 POS temizliği (${y.username}): ${r.silinen} yanlış POS kaydı silindi`);
    res.json(r);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/satislar', express.json(), async (req, res) => {
  const y = satisYetki(req.body?.token);
  if (!y) return res.json({ ok: false, error: 'Oturum yok' });
  const kapsam = req.body?.kapsam || 'bugun'; // bugun | hafta | tum | ozel
  // ÖZEL tarih araligi: panel baslangic/bitis (YYYY-MM-DD) gonderebilir
  let ar = tarihAraligi(kapsam);
  if (kapsam === 'ozel' && req.body?.bas && req.body?.bit) {
    const basMs = new Date(req.body.bas + 'T00:00:00').getTime();
    const bitMs = new Date(req.body.bit + 'T23:59:59.999').getTime();
    if (!isNaN(basMs) && !isNaN(bitMs)) ar = { bas: basMs, bit: bitMs };
  }
  const saticiFiltre = (req.body?.satici || '').trim().toLowerCase(); // opsiyonel: belirli satici
  try {
    let satislar;
    if (y.pzrYonetici) {
      // PAZARLAMA YÖNETİCİSİ: sadece pazarlama hatlarının satışları (tüm pazarlamacılar)
      satislar = await pazarlamaSatislariYukle(ar?.bas ?? null, ar?.bit ?? null);
    } else if (y.isAdmin) {
      const istenenHat = req.body?.lineId; // opsiyonel hat filtresi
      if (istenenHat) {
        satislar = await db.loadSatislar(istenenHat, ar?.bas ?? null, ar?.bit ?? null);
      } else {
        satislar = ar ? await db.loadTumSatislar(ar.bas, ar.bit) : await db.loadTumSatislar();
      }
    } else {
      // pazarlamaci: SADECE kendi hatti (baskasini goremez)
      satislar = await db.loadSatislar(y.lineId, ar?.bas ?? null, ar?.bit ?? null);
    }
    // satici listesini cikar (panel "kisi sec" icin) — FILTRELEMEDEN once
    const saticiSet = {};
    satislar.forEach(s => { const ad = (s.satici || '').trim(); if (ad) saticiSet[ad] = (saticiSet[ad] || 0) + 1; });
    const saticilar = Object.keys(saticiSet).sort();
    // satici filtresi uygula (istendiyse)
    if (saticiFiltre) {
      satislar = satislar.filter(s => (s.satici || '').toLowerCase().includes(saticiFiltre));
    }
    res.json({ ok: true, satislar, kapsam, isAdmin: y.isAdmin, pzrYonetici: y.pzrYonetici, lineId: y.lineId, saticilar });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Satis adedini DUZENLE. Pazarlamaci KENDI hattindaki satisi duzenleyebilir.
// Duzenleyince YONETICIYE bildirim gider (canli + kayit).
app.post('/api/satislar/duzenle', express.json(), async (req, res) => {
  const y = satisYetki(req.body?.token);
  if (!y) return res.json({ ok: false, error: 'Oturum yok' });
  const id = req.body?.id;
  const yeniAdet = parseInt(req.body?.adet, 10);
  if (!id || isNaN(yeniAdet) || yeniAdet < 1 || yeniAdet > 9999) return res.json({ ok: false, error: 'Geçersiz adet' });
  // BRANŞ (opsiyonel): verildiyse gecerli 9 brans icinden olmali
  let yeniUrun = null;
  if (req.body?.urun) {
    const istenenBrans = String(req.body.urun).toLowerCase().trim();
    // GECERLI_BRANSLAR map'inden normalize et (yesilkart -> yeşilkart vs.)
    yeniUrun = GECERLI_BRANSLAR[istenenBrans] || (BRANS_LISTESI.includes(istenenBrans) ? istenenBrans : null);
    if (!yeniUrun) return res.json({ ok: false, error: 'Geçersiz branş. Sadece tanımlı branşlar seçilebilir.' });
  }
  try {
    // YETKI: pazarlamaci sadece KENDI hattindaki satisi duzenleyebilir.
    // Pazarlama yöneticisi: TÜM pazarlama satışlarını düzenleyebilir. Admin: hepsini.
    if (y.pzrYonetici) {
      const pzrSatislar = await pazarlamaSatislariYukle(null, null);
      const varMi = pzrSatislar.find(x => x.id === id);
      if (!varMi) return res.json({ ok: false, error: 'Bu satış pazarlama hatlarında değil, düzenleyemezsiniz.' });
    } else if (!y.isAdmin) {
      const kontrol = await db.loadSatislar(y.lineId, null, null);
      const benimMi = kontrol.find(x => x.id === id);
      if (!benimMi) return res.json({ ok: false, error: 'Bu satışı düzenleme yetkiniz yok.' });
    }
    const r = await db.updateSatisAdet(id, yeniAdet, y.displayName || y.username, yeniUrun);
    if (!r.ok) return res.json({ ok: false, error: r.error || 'Düzenlenemedi' });
    // YONETICIYE BILDIRIM: ne degisti (adet ve/veya brans)
    let degisim = [];
    if (r.eskiAdet !== yeniAdet) degisim.push(`adet ${r.eskiAdet} → ${yeniAdet}`);
    if (yeniUrun && r.eskiUrun !== yeniUrun) degisim.push(`branş ${r.eskiUrun} → ${yeniUrun}`);
    const degisimMetni = degisim.length ? degisim.join(', ') : 'güncelleme yapıldı';
    broadcastHat('ofis', {
      type: 'satisDuzenlemeBildirim',
      mesaj: `${y.displayName || y.username} bir satışı düzenledi: ${degisimMetni}`,
      satisId: id, eskiAdet: r.eskiAdet, yeniAdet,
    });
    console.log(`✏️  SATIŞ DÜZENLENDİ: ${id} | ${degisimMetni} | ${y.displayName || y.username}`);
    res.json({ ok: true, satis: r.row });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Satis ONAYLA / onay kaldir (SADECE yonetici)
app.post('/api/satislar/onayla', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Sadece yönetici onaylayabilir' });
  const r = await db.setSatisOnay(req.body?.id, req.body?.onayli !== false);
  res.json(r.ok ? { ok: true, satis: r.row } : { ok: false, error: r.error });
});

// Satis SIL (yonetici VEYA pazarlama yöneticisi — yanlis/mukerrer kayit)
app.post('/api/satislar/sil', express.json(), async (req, res) => {
  const y = satisYetki(req.body?.token);
  if (!y) return res.json({ ok: false, error: 'Oturum yok' });
  // Admin her satışı siler. Pazarlama yöneticisi SADECE pazarlama satışlarını siler.
  if (!y.isAdmin) {
    if (!y.pzrYonetici) return res.json({ ok: false, error: 'Sadece yönetici silebilir' });
    const pzrSatislar = await pazarlamaSatislariYukle(null, null);
    if (!pzrSatislar.find(x => x.id === req.body?.id)) {
      return res.json({ ok: false, error: 'Bu satış pazarlama hatlarında değil, silemezsiniz.' });
    }
  }
  const r = await db.deleteSatis(req.body?.id);
  res.json(r);
});

// PANELDEN DIREKT SATIŞ EKLE (pazarlamaci composer'daki butonla).
// Gruba MESAJ GITMEZ — sadece kontrole kaydedilir. Satici = ekleyen kullanici.
app.post('/api/satislar/ekle', express.json(), async (req, res) => {
  const y = satisYetki(req.body?.token);
  if (!y) return res.json({ ok: false, error: 'Oturum yok' });
  // BRANŞ doğrula (sadece gecerli branslar)
  const istenenBrans = String(req.body?.urun || '').toLowerCase().trim();
  const urun = GECERLI_BRANSLAR[istenenBrans] || (BRANS_LISTESI.includes(istenenBrans) ? istenenBrans : null);
  if (!urun) return res.json({ ok: false, error: 'Geçersiz branş' });
  const adet = parseInt(req.body?.adet, 10);
  if (isNaN(adet) || adet < 1 || adet > 9999) return res.json({ ok: false, error: 'Geçersiz adet' });
  const chatJid = (req.body?.chatJid || '').trim();
  if (!chatJid) return res.json({ ok: false, error: 'Grup seçili değil' });
  // ─── YENI ALANLAR: odeme tipi / periyot / fiyat (kisa sureli trafik akisi) ───
  let odemeTip = null, odemePeriyot = null, fiyat = null;
  if (req.body?.odemeTip) {
    const t = String(req.body.odemeTip).toLowerCase().trim();
    if (!['mkk', 'acik', 'iadesiz'].includes(t)) return res.json({ ok: false, error: 'Geçersiz ödeme yöntemi' });
    odemeTip = t;
  }
  if (req.body?.odemePeriyot) {
    const p = String(req.body.odemePeriyot).toLowerCase().trim();
    if (!['gunluk', 'haftalik', 'aylik'].includes(p)) return res.json({ ok: false, error: 'Geçersiz ödeme periyodu' });
    odemePeriyot = p;
  }
  if (req.body?.fiyat !== undefined && req.body?.fiyat !== null && req.body?.fiyat !== '') {
    const f = parseFloat(req.body.fiyat);
    if (isNaN(f) || f < 0 || f > 1000000) return res.json({ ok: false, error: 'Geçersiz fiyat' });
    fiyat = f;
  }
  // KISA SURELI TRAFIK kurallari: odeme tipi zorunlu; acik/iadesiz ise periyot + fiyat zorunlu
  if (urun === 'kısa süreli trafik') {
    if (!odemeTip) return res.json({ ok: false, error: 'Kısa süreli trafik için ödeme yöntemi seçin (MKK/AÇIK/İADESİZ)' });
    if (odemeTip !== 'mkk') {
      if (!odemePeriyot) return res.json({ ok: false, error: 'Ödeme periyodu seçin (Günlük/Haftalık/Aylık)' });
      if (!fiyat || fiyat <= 0) return res.json({ ok: false, error: 'Fiyat seçin' });
    }
  } else {
    // diger branslarda odeme tipi/periyot anlamsiz -> temizle (fiyat opsiyonel kalir)
    odemeTip = null; odemePeriyot = null;
  }
  // grup adini bul (o hattin sohbetlerinden)
  const C = hatChats(y.lineId);
  const chat = C.get(chatJid);
  const chatName = chat?.name || (req.body?.chatName || '').trim() || chatJid.split('@')[0];
  // benzersiz id: panelden eklenenler icin zaman + rastgele (mesaj id yok)
  const satisId = 'satis_' + y.lineId + '_panel_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const kayit = {
    id: satisId,
    chatJid: chatJid,
    chatName: chatName,
    urun: urun,
    adet: adet,
    satici: y.displayName || y.username,
    saticiJid: '', // panelden eklendi, jid yok
    mesajId: '',
    hamMesaj: '(panelden eklendi)',
    ts: Date.now(),
    fiyat, odemeTip, odemePeriyot,
  };
  try {
    const r = await db.saveSatis(kayit, y.lineId);
    if (r.ok && r.yeni) {
      const ek = odemeTip ? ` [${odemeTip}${odemePeriyot ? '/' + odemePeriyot : ''}${fiyat ? '/' + fiyat + '₺' : ''}]` : (fiyat ? ` [${fiyat}₺]` : '');
      console.log(`💰 SATIŞ (panelden) [${y.lineId}]: ${urun} x${adet}${ek} | ${y.displayName || y.username} | ${chatName.slice(0, 25)}`);
      // canli haber ver (kontrol sekmesi aciksa guncellensin) + yoneticiye bildir
      broadcastHat(y.lineId, { type: 'yeniSatis', satis: { ...kayit, line_id: y.lineId, onayli: false, odeme_tip: odemeTip, odeme_periyot: odemePeriyot } });
      if (y.lineId !== 'ofis') {
        broadcastHat('ofis', { type: 'satisBildirim', mesaj: `Yeni satış: ${urun} x${adet} (${y.displayName || y.username})`, lineId: y.lineId });
      }
      return res.json({ ok: true, satis: kayit });
    }
    return res.json({ ok: false, error: 'Kaydedilemedi' });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
});

// GUNU KAPAT (SADECE yonetici). Secili hattin (veya tum hatlarin) bugununu kilitler.
app.post('/api/satislar/gunu-kapat', express.json(), async (req, res) => {
  const y = satisYetki(req.body?.token);
  if (!y || !y.isAdmin) return res.json({ ok: false, error: 'Sadece yönetici günü kapatabilir' });
  const tarih = req.body?.tarih || new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const hedefHat = req.body?.lineId; // belirli hat, yoksa TUM hatlar
  try {
    let sonuc = [];
    if (hedefHat) {
      const r = await db.gunuKapat(hedefHat, tarih, y.displayName || y.username);
      sonuc.push({ lineId: hedefHat, ...r });
    } else {
      // tum hatlar: once hatlari bul
      const hatlar = await db.loadLines();
      const tumHatIdler = ['ofis', ...(hatlar || []).map(h => h.line_id).filter(l => l && l !== 'ofis')];
      for (const lid of [...new Set(tumHatIdler)]) {
        const r = await db.gunuKapat(lid, tarih, y.displayName || y.username);
        sonuc.push({ lineId: lid, ...r });
      }
    }
    const toplam = sonuc.reduce((a, s) => a + (s.toplam || 0), 0);
    console.log(`🔒 GÜN KAPATILDI: ${tarih} | toplam ${toplam} satış | ${y.displayName || y.username}`);
    res.json({ ok: true, tarih, sonuc, toplam });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ============================================================
// PERFORMANS RAPORU API (SADECE YÖNETİCİ)
// Kişi kişi: kaç poliçe (PDF) yüklemiş + branş dağılımı + kaç kesim/ilgilenme mesajı.
// kapsam: bugun | hafta | ay | tum | ozel
// ============================================================
app.post('/api/performans', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Bu rapora sadece yönetici erişebilir' });
  // tarih aralığı
  let ar;
  const kapsam = req.body?.kapsam || 'bugun';
  const now = new Date();
  if (kapsam === 'bugun') {
    ar = { bas: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime(),
           bit: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime() };
  } else if (kapsam === 'hafta') {
    ar = { bas: Date.now() - 7 * 24 * 60 * 60 * 1000, bit: Date.now() };
  } else if (kapsam === 'ay') {
    ar = { bas: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0).getTime(), bit: Date.now() };
  } else if (kapsam === 'ozel' && req.body?.bas && req.body?.bit) {
    ar = { bas: new Date(req.body.bas + 'T00:00:00').getTime(), bit: new Date(req.body.bit + 'T23:59:59.999').getTime() };
  } else {
    ar = null; // tüm
  }
  try {
    const hat = req.body?.lineId || null; // opsiyonel hat filtresi (yoksa tüm hatlar)
    const policeler = await db.loadPoliceYuklemeler(ar?.bas ?? null, ar?.bit ?? null, hat);
    const aktiviteler = await db.loadAktiviteler(ar?.bas ?? null, ar?.bit ?? null, hat);

    // KİŞİ BAZINDA TOPLA: kullanıcı adına göre grupla
    const kisiler = {}; // ad -> { ad, police, branslar:{}, kesim, ilgilenme, iki_aylik, gruplar:Map, sonTs }
    function kisiAl(ad) {
      const k = (ad || 'Bilinmeyen').trim() || 'Bilinmeyen';
      if (!kisiler[k]) kisiler[k] = {
        ad: k, police: 0, branslar: {}, kesim: 0, ilgilenme: 0, ikiAylik: 0,
        gruplar: new Map(),   // grupAdi -> { police, kesim, ilgilenme, branslar:{} }
        sonTs: 0,             // en son aktivite zamanı
      };
      return kisiler[k];
    }
    function grupAl(k, ad) {
      const g = (ad || 'Bilinmeyen grup').trim() || 'Bilinmeyen grup';
      if (!k.gruplar.has(g)) k.gruplar.set(g, { ad: g, police: 0, kesim: 0, ilgilenme: 0, branslar: {}, sonTs: 0, polIdler: [], jid: '' });
      return k.gruplar.get(g);
    }
    for (const p of policeler) {
      const k = kisiAl(p.kullanici_ad);
      k.police++;
      const b = p.brans || 'diğer';
      k.branslar[b] = (k.branslar[b] || 0) + 1;
      if (p.iki_aylik) k.ikiAylik++;
      const pts = Number(p.ts) || 0; // DB string döndürebilir -> sayıya çevir
      if (pts > k.sonTs) k.sonTs = pts;
      // grup bazında döküm
      const g = grupAl(k, p.chat_name);
      g.police++;
      g.branslar[b] = (g.branslar[b] || 0) + 1;
      if (pts > g.sonTs) g.sonTs = pts;
      if (p.id) g.polIdler.push(p.id); // POLİÇE SİLME için: bu gruptaki poliçe kayıt id'leri
      if (p.chat_jid && !g.jid) g.jid = p.chat_jid;
    }
    for (const a of aktiviteler) {
      const k = kisiAl(a.kullanici_ad);
      if (a.tur === 'kesim') k.kesim++;
      else if (a.tur === 'ilgileniyorum') k.ilgilenme++;
      const ats = Number(a.ts) || 0; // DB string döndürebilir -> sayıya çevir
      if (ats > k.sonTs) k.sonTs = ats;
      const g = grupAl(k, a.chat_name);
      if (a.tur === 'kesim') g.kesim++;
      else if (a.tur === 'ilgileniyorum') g.ilgilenme++;
      if (ats > g.sonTs) g.sonTs = ats;
    }
    // diziye çevir + grupları diziye çevir (poliçeye göre sıralı) + kişiyi sırala
    const liste = Object.values(kisiler).map(k => ({
      ad: k.ad, police: k.police, branslar: k.branslar,
      kesim: k.kesim, ilgilenme: k.ilgilenme, ikiAylik: k.ikiAylik,
      grupSayisi: k.gruplar.size,
      sonTs: k.sonTs,
      // DETAY: grup bazında döküm (en çok poliçe olan grup üstte). polIdler+jid: silme için.
      gruplar: Array.from(k.gruplar.values()).sort((a, b) => b.police - a.police || b.kesim - a.kesim),
    })).sort((a, b) => b.police - a.police || b.kesim - a.kesim);

    // GENEL TOPLAMLAR (üstteki özet kartları için)
    const toplam = {
      police: policeler.length,
      kisi: liste.length,
      kesim: aktiviteler.filter(a => a.tur === 'kesim').length,
      ilgilenme: aktiviteler.filter(a => a.tur === 'ilgileniyorum').length,
      ikiAylik: policeler.filter(p => p.iki_aylik).length,
    };
    // branş dağılımı (genel)
    const bransDagilim = {};
    for (const p of policeler) { const b = p.brans || 'diğer'; bransDagilim[b] = (bransDagilim[b] || 0) + 1; }

    res.json({ ok: true, kapsam, liste, toplam, bransDagilim });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POLİÇE SAYISI DÜZELTME (performans raporundan): bir grubun poliçe sayısını elle düzelt.
// idler: o gruptaki TÜM poliçe id'leri. hedef: olması gereken sayı.
// Fazla kayıtlar (en YENİden başlayarak) silinir -> grup + genel toplam güncellenir.
app.post('/api/police/duzelt', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Bu işlem sadece yönetici içindir' });
  const idler = req.body?.idler;   // gruptaki tüm poliçe id'leri (yeni->eski sıralı gelmeli)
  const hedef = parseInt(req.body?.hedef, 10);
  if (!Array.isArray(idler) || !idler.length) return res.json({ ok: false, error: 'Poliçe bulunamadı' });
  if (isNaN(hedef) || hedef < 0) return res.json({ ok: false, error: 'Geçersiz sayı' });
  if (hedef >= idler.length) return res.json({ ok: false, error: 'Yeni sayı mevcut sayıdan küçük olmalı (sadece azaltılabilir)' });
  try {
    // hedef kadar KALSIN, fazlası silinsin. idler yeni->eski geldiği için baştan hedef kadarını
    // KORU, gerisini (en eskiler) sil. (İstenirse tersi de yapılabilir; en eskiyi silmek mantıklı.)
    const silinecek = idler.slice(hedef); // hedef'ten sonrakiler silinir
    const sonuc = await db.policeIdSil(silinecek);
    if (sonuc && sonuc.ok) {
      console.log(`✏️ YÖNETİCİ poliçe sayısı düzeltti: ${idler.length} -> ${hedef} (${silinecek.length} kayıt silindi)`);
      broadcast({ type: 'yeniPolice', kullanici: '' });
      return res.json({ ok: true, silinen: sonuc.silinen || 0, yeniSayi: hedef });
    }
    return res.json({ ok: false, error: (sonuc && sonuc.error) || 'Düzeltilemedi' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Rol degistir - yonetici yap/geri al (sadece yonetici)
app.post('/api/users/role', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  // Geçerli roller: admin, pzr_yonetici, muhasebeci, hat_sorumlusu, agent (normal)
  let yeniRol = 'agent';
  if (req.body?.role === 'admin') yeniRol = 'admin';
  else if (req.body?.role === 'pzr_yonetici') yeniRol = 'pzr_yonetici';
  else if (req.body?.role === 'muhasebeci') yeniRol = 'muhasebeci';
  else if (req.body?.role === 'hat_sorumlusu') yeniRol = 'hat_sorumlusu';
  try {
    const users = await db.listUsers();
    const u = users.find(x => String(x.id) === String(req.body?.id));
    if (!u) return res.json({ ok: false, error: 'Kullanıcı bulunamadı' });
    // DB'de rolü güncelle
    await db.updateUserRole(u.username, yeniRol);
    // açık oturumların rolünü de güncelle (bellek + DB session)
    for (const [tok, s] of sessions) { if (s.username === u.username) s.role = yeniRol; }
    db.updateSessionRole(u.username, yeniRol).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// BAĞIMSIZ OKUMA yan-rolünü aç/kapat (sadece yönetici). role'den bağımsız bir bayrak.
app.post('/api/users/bagimsizokuma', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });
  const val = !!req.body?.aktif;
  try {
    const users = await db.listUsers();
    const u = users.find(x => String(x.id) === String(req.body?.id));
    if (!u) return res.json({ ok: false, error: 'Kullanıcı bulunamadı' });
    await db.setBagimsizOkuma(u.id, val);
    // belleği anında güncelle (yeniden giriş gerekmesin): set + açık oturumlar
    if (val) bagimsizOkumaKullanicilar.add(u.username); else bagimsizOkumaKullanicilar.delete(u.username);
    for (const [tok, s] of sessions) { if (s.username === u.username) s.bagimsizOkuma = val; }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---- HIZLI YANITLAR (quick replies) — ortak sablonlar ----
// Supabase settings tablosunda 'quick_replies' anahtarinda bir dizi olarak tutulur:
//   [{ id, title, text }]
// Herkes OKUR; sadece yonetici EKLER/SILER/DUZENLER.
const QR_KEY = 'quick_replies';

// Listeyi getir (giris yapan herkes)
app.post('/api/quickreplies', express.json(), async (req, res) => {
  const s = req.body?.token && sessions.get(req.body.token);
  if (!s) return res.json({ ok: false, error: 'Giris gerekli' });
  const list = await db.getSetting(QR_KEY, []);
  res.json({ ok: true, items: Array.isArray(list) ? list : [] });
});

// Ekle (sadece yonetici)
app.post('/api/quickreplies/add', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok (sadece yonetici)' });
  const title = (req.body?.title || '').trim();
  const text = (req.body?.text || '').trim();
  if (!title || !text) return res.json({ ok: false, error: 'Baslik ve metin gerekli' });
  const list = await db.getSetting(QR_KEY, []);
  const arr = Array.isArray(list) ? list : [];
  const id = 'qr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  arr.push({ id, title, text });
  await db.saveSetting(QR_KEY, arr);
  res.json({ ok: true, items: arr });
});

// Sil (sadece yonetici)
app.post('/api/quickreplies/delete', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok (sadece yonetici)' });
  const id = req.body?.id;
  const list = await db.getSetting(QR_KEY, []);
  const arr = (Array.isArray(list) ? list : []).filter(x => x.id !== id);
  await db.saveSetting(QR_KEY, arr);
  res.json({ ok: true, items: arr });
});

// Guncelle (sadece yonetici)
app.post('/api/quickreplies/update', express.json(), async (req, res) => {
  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok (sadece yonetici)' });
  const { id, title, text } = req.body || {};
  if (!id || !(title || '').trim() || !(text || '').trim()) return res.json({ ok: false, error: 'Eksik bilgi' });
  const list = await db.getSetting(QR_KEY, []);
  const arr = (Array.isArray(list) ? list : []).map(x => x.id === id ? { id, title: title.trim(), text: text.trim() } : x);
  await db.saveSetting(QR_KEY, arr);
  res.json({ ok: true, items: arr });
});


// Panelden dosya yukleme (foto/pdf/belge) -> WhatsApp'a gonder
app.post('/upload', express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
  try {
    // HAT KIMLIGI: panel token'iyla hangi hatta ait oldugunu belirle (IZOLASYON).
    // Token yoksa/cozulemezse 'ofis' varsayilir (geriye uyumlu).
    const s = req.query.token && sessions.get(req.query.token);
    const upLineId = (s && s.lineId) ? s.lineId : 'ofis';
    const upLine = lines.get(upLineId); // hem ofis hem pazarlama icin o hattin objesi
    // KRITIK: ofis dahil KENDI line.sock'u kullan (global waSock pazarlama baglaninca eziliyor)
    const upSock = upLine ? upLine.sock : (upLineId === 'ofis' ? waSock : null);
    const upConnected = upLine ? !!upLine.connected : (upLineId === 'ofis' ? waConnected : false);
    if (!upSock || !upConnected) return res.status(503).json({ error: 'WhatsApp bağlı değil' });
    const jid = req.query.jid;
    // Dosya adini GUVENLI coz: Turkce karakter/bosluk iceren adlarda decodeURIComponent
    // hata firlatabilir -> o zaman ham halini kullan (fileName ASLA bos kalmasin,
    // yoksa WhatsApp dosyayi taniyamaz ve karsi taraf ACAMAZ).
    let fileName;
    try { fileName = decodeURIComponent(req.query.name || ''); }
    catch (e) { fileName = req.query.name || ''; }
    fileName = (fileName || '').trim();
    let mime = req.query.mime || 'application/octet-stream';
    const agent = (() => { try { return decodeURIComponent(req.query.agent || 'Ben'); } catch (e) { return 'Ben'; } })();
    if (!jid || !req.body?.length) return res.status(400).json({ error: 'Eksik veri' });

    // MIME DUZELTME: tarayici bazen mime'i bos/yanlis gonderir (ozellikle PDF).
    // Dosya uzantisindan dogru mime'i belirle ki karsi tarafta dosya ACILSIN.
    let uzanti = (fileName.includes('.') ? fileName.split('.').pop() : '').toLowerCase();
    const mimeTablo = {
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', rar: 'application/x-rar-compressed',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
      mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
      mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
    };
    // mime->uzanti ters tablo (fileName uzantisizsa mime'dan uzanti bulmak icin)
    const mimedenUzanti = {
      'application/pdf': 'pdf', 'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'text/plain': 'txt', 'text/csv': 'csv', 'application/zip': 'zip',
      'image/jpeg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3',
    };
    // mime bos/genel ise VEYA uzanti biliniyorsa, uzantidan gelen dogru mime'i kullan
    if (mimeTablo[uzanti] && (mime === 'application/octet-stream' || !mime || mime === 'application/pdf' || !mime.includes('/'))) {
      mime = mimeTablo[uzanti];
    }
    // FILENAME KESINLESTIRME: bos veya uzantisizsa duzgun bir ad ver.
    // (WhatsApp belge adi olmadan dosyayi taniyamaz, karsi taraf ACAMAZ.)
    if (!uzanti && mimedenUzanti[mime]) uzanti = mimedenUzanti[mime]; // mime'dan uzanti bul
    if (!fileName) {
      // ad hic yok: mime'dan uzantili varsayilan ad
      fileName = 'belge' + (uzanti ? '.' + uzanti : '');
    } else if (!fileName.includes('.') && uzanti) {
      // ad var ama uzanti yok: uzanti ekle
      fileName = fileName + '.' + uzanti;
    }

    // dosyayi diske kaydet (panelde gostermek icin)
    const ext = fileName.includes('.') ? fileName.split('.').pop() : 'bin';
    const savedName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    // req.body Buffer olmali (express.raw); degilse Buffer'a cevir (bozuk dosya gitmesin)
    const dosyaBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    const boyutMB = (dosyaBuf.length / 1048576).toFixed(2);
    console.log(`📎 Dosya yukleniyor: ${fileName} (${boyutMB} MB, ${mime})`);
    fs.writeFileSync(path.join(MEDIA_DIR, savedName), dosyaBuf);
    const webPath = '/media/' + savedName;

    // tipe gore WhatsApp'a gonder
    let kind = 'document';
    let waMsg;
    if (mime.startsWith('image/')) {
      kind = 'image';
      waMsg = { image: dosyaBuf, caption: req.query.caption ? decodeURIComponent(req.query.caption) : undefined };
    } else if (mime.startsWith('video/')) {
      kind = 'video';
      waMsg = { video: dosyaBuf, caption: req.query.caption ? decodeURIComponent(req.query.caption) : undefined };
    } else if (mime.startsWith('audio/')) {
      kind = 'audio';
      waMsg = { audio: dosyaBuf, mimetype: mime };
    } else {
      kind = 'document';
      // Belge: fileName + dogru mimetype SART (yoksa karsi tarafta acilmaz).
      waMsg = { document: dosyaBuf, fileName, mimetype: mime, caption: req.query.caption ? decodeURIComponent(req.query.caption) : undefined };
    }
    // BUYUK dosyalar icin yeterli sure tani (WhatsApp'a yukleme zaman alir).
    // Eskiden timeout yoktu -> buyuk dosya askida kalip BOZUK gidebiliyordu.
    // 90sn icinde yuklenmezse hata don (kullanici tekrar denesin).
    let sent;
    try {
      // YANIT (reply): panel replyId gonderdiyse, dosyayi o mesaja YANIT olarak gonder.
      // GUVENLI: sadece TAM raw (key'li) varsa quoted ekleriz. raw yoksa alintisiz gondeririz
      // (alinti insa etmeye calismak bazi mesajlarda gonderim hatasina yol aciyordu).
      let gonderOpt = {};
      const replyId = req.query.replyId;
      if (replyId) {
        try {
          const C2 = hatChats(upLineId);
          const chat2 = C2 && C2.get ? C2.get(jid) : null;
          const orijMsg = chat2 && chat2.messages ? chat2.messages.find(x => x && x.id === replyId) : null;
          if (orijMsg && orijMsg.raw && orijMsg.raw.key && orijMsg.raw.message) {
            gonderOpt = { quoted: orijMsg.raw };
            console.log('   ↩️  medya yaniti: raw ile alinti hazir');
          }
        } catch (e) { /* yanit bulunamazsa normal gonder */ }
      }
      // KUYRUK: medya gönderimi de sıraya girer (WhatsApp hız limitine takılmamak için)
      const medyaTimeout = () => new Promise((_, rej) => setTimeout(() => rej(new Error('dosya yukleme zaman asimi (cok buyuk olabilir)')), 90000));
      sent = await kuyrukluGonder(upLineId, async () => {
        let gonderP;
        try {
          gonderP = upSock.sendMessage(jid, waMsg, gonderOpt);
        } catch (qErr) {
          // quoted ile gonderim ANINDA patlarsa (bozuk quoted): alintisiz tekrar dene
          console.log('   ⚠️  alintili gonderim hata verdi, alintisiz deneniyor:', qErr.message);
          gonderP = upSock.sendMessage(jid, waMsg, {});
        }
        return await Promise.race([gonderP, medyaTimeout()]);
      }, true); // true = medya (daha uzun aralık)
    } catch (gonderHata) {
      console.error(`⚠️  Dosya gonderilemedi (${fileName}, ${boyutMB} MB):`, gonderHata.message);
      return res.status(502).json({ error: `Dosya gönderilemedi (${boyutMB} MB). Çok büyük olabilir veya bağlantı sorunu. Tekrar deneyin.` });
    }
    if (!sent || !sent.key) {
      // gonderim onaylanmadi -> panele hata don (kullanici gittigini sanmasin)
      return res.status(502).json({ error: 'WhatsApp dosyayı kabul etmedi, tekrar deneyin.' });
    }
    console.log(`✅ Dosya gonderildi: ${fileName} (${boyutMB} MB)`);

    // YANIT önizlemesi (panelde "yanıt: ..." görünsün) — GUVENLI: hata olsa bile PDF düşmeli.
    let medyaReplyTo = null;
    try {
      const replyId2 = req.query.replyId;
      if (replyId2) {
        const C3 = hatChats(upLineId);
        const chat3 = C3 && C3.get ? C3.get(jid) : null;
        const orij = chat3 && chat3.messages ? chat3.messages.find(x => x && x.id === replyId2) : null;
        if (orij) {
          let onText = '';
          try { onText = replyPreview(orij); } catch (e) { onText = orij.text || ''; }
          medyaReplyTo = { sender: orij.fromMe ? 'Siz' : (orij.sender || ''), text: onText };
        }
      }
    } catch (e) { medyaReplyTo = null; }

    addMessage(jid, {
      id: sent.key.id, key: sent.key,
      raw: sent, // kendi gonderdigimiz medyayi sonradan yanitlayabilmek icin
      fromMe: true, kind,
      text: kind === 'document' ? fileName : (req.query.caption ? decodeURIComponent(req.query.caption) : ''),
      caption: req.query.caption ? decodeURIComponent(req.query.caption) : '',
      fileName: kind === 'document' ? fileName : undefined,
      mime: mime,
      mediaUrl: webPath, sender: agent, time: nowTime(),
      replyTo: medyaReplyTo, // panelde yanıt önizlemesi (null olabilir, sorun değil)
      durum: 2, // gonderildi (tek tik)
    }, {}, upLineId);
    // İLETİM DENETÇİSİ: dosya/foto da yarı-açık bağlantıda kaybolabilir. Takibe al.
    // (Dosyayı otomatik yeniden gönderemeyiz -veri base64 elde yok- ama onay gelmezse
    //  panelde kırmızı uyarı çıkar; kullanıcı görür, tekrar yükler. Sessiz kayıp olmaz.)
    iletimDenetleBaslat(upLineId, jid, sent.key.id, { text: '', yazan: (req.query.username || agent || null) });

    // ---- PERFORMANS RAPORU: yüklenen PDF poliçe mi? Öyleyse kaydet. ----
    // SADECE panelden SÜRÜKLENİP yüklenen PDF'ler (bu rota = gerçek yükleme, iletme DEĞİL).
    // "POS" geçenler policeAdiAyristir içinde elenir (null döner).
    if (kind === 'document') {
      try {
        const ayristir = policeAdiAyristir(fileName);
        if (ayristir && db.isReady()) {
          const C3 = hatChats(upLineId);
          const chat3 = C3 && C3.get ? C3.get(jid) : null;
          const polId = 'pol_' + upLineId + '_' + (sent.key.id || (Date.now() + '_' + Math.random().toString(36).slice(2, 8)));
          db.savePoliceYukleme({
            id: polId,
            lineId: upLineId,
            kullanici: (s && s.username) ? s.username : '',
            kullaniciAd: agent || (s && s.displayName) || 'Bilinmeyen',
            chatJid: jid,
            chatName: chat3?.name || (jid || '').split('@')[0],
            dosyaAdi: fileName,
            brans: ayristir.brans,
            plaka: ayristir.plaka,
            ikiAylik: ayristir.ikiAylik,
            ts: Date.now(),
          }).then((r) => {
            if (r.ok && r.yeni) {
              console.log(`📄 POLİÇE yüklendi [${upLineId}]: ${ayristir.brans}${ayristir.plaka ? ' ' + ayristir.plaka : ''} | ${agent} | ${(chat3?.name || '').slice(0, 25)}`);
              // canlı haber ver (rapor açıksa güncellensin)
              broadcastHat(upLineId, { type: 'yeniPolice', kullanici: agent });
            }
          }).catch(() => {});
        }
      } catch (e) { /* poliçe kaydı başarısız olsa bile yükleme tamamlandı */ }
    }

    // STABİLİZASYON: art arda dosya yüklemede WhatsApp'ın mesajı işlemesi için kısa bekleme.
    // Panel bir sonraki dosyayı bu yanıt gelince gönderir; bu bekleme WhatsApp'ın boğulup
    // dosya DÜŞÜRMESİNİ önler (toplu PDF gönderiminde kayıp kökü).
    if (kind === 'document' || kind === 'image' || kind === 'video') {
      await new Promise(r => setTimeout(r, 500));
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Yukleme hatasi:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// İÇ MESAJ DOSYA YÜKLEME (ekip içi) — KRİTİK: WhatsApp'a HİÇ DOKUNMAZ!
// Dosya diske kaydedilir, SADECE iç mesaj olarak alıcıya iletilir.
// Boylece hicbir sekilde yanlis WhatsApp grubuna gitme riski YOKTUR.
// ============================================================
app.post('/internal-upload', express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
  try {
    // KIMLIK: token'dan gonderen kullaniciyi bul
    const s = req.query.token && sessions.get(req.query.token);
    if (!s || !s.username) return res.status(401).json({ error: 'Oturum bulunamadı.' });
    if (!db.isReady()) return res.status(503).json({ error: 'Veritabanı bağlı değil.' });

    const fromUser = s.username;
    const toUser = (req.query.to || '').trim();
    if (!toUser) return res.status(400).json({ error: 'Alıcı belirtilmedi.' });

    let fileName = req.query.name ? decodeURIComponent(req.query.name) : '';
    const mime = req.query.mime || 'application/octet-stream';
    if (!fileName) fileName = 'belge';

    // dosyayi diske kaydet (panelde gostermek icin)
    const ext = fileName.includes('.') ? fileName.split('.').pop() : 'bin';
    const savedName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const dosyaBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    if (!dosyaBuf.length) return res.status(400).json({ error: 'Dosya alınamadı.' });
    const boyutMB = (dosyaBuf.length / 1048576).toFixed(2);
    fs.writeFileSync(path.join(MEDIA_DIR, savedName), dosyaBuf);
    const webPath = '/media/' + savedName;

    // tip belirle (panel ikonu icin)
    let kind = 'document';
    if (mime.startsWith('image/')) kind = 'image';
    else if (mime.startsWith('video/')) kind = 'video';
    else if (mime.startsWith('audio/')) kind = 'audio';

    // ic mesaj olarak kaydet (text yerine dosya)
    const mid = 'im_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const caption = req.query.caption ? decodeURIComponent(req.query.caption) : '';
    const r = await db.saveInternalMessage({
      id: mid, from: fromUser, to: toUser,
      text: caption, mediaUrl: webPath, fileName, kind, ts: Date.now(),
    });
    if (!r.ok) return res.status(500).json({ error: 'İç mesaj kaydedilemedi.' });

    console.log(`📎➡️👤 İç mesaj dosyası: ${fileName} (${boyutMB} MB) | ${fromUser} -> ${toUser}`);

    const payload = {
      id: mid, from: fromUser, fromName: s.displayName || fromUser, to: toUser,
      text: caption, mediaUrl: webPath, fileName, kind, ts: r.row?.ts || Date.now(),
    };
    // gonderene + aliciya canli ilet (tum acik WS'lerine)
    let aliciCevrimici = false;
    wss.clients.forEach((c) => {
      if (c.readyState === 1 && (c._username === fromUser || c._username === toUser)) {
        c.send(JSON.stringify({ type: 'internalMessage', msg: payload }));
        if (c._username === toUser) aliciCevrimici = true;
      }
    });
    if (aliciCevrimici) {
      const n = await db.internalUnreadCount(toUser);
      wss.clients.forEach((c) => { if (c.readyState === 1 && c._username === toUser) c.send(JSON.stringify({ type: 'internalUnread', count: n })); });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('İç mesaj dosya yukleme hatasi:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GRUP FOTOGRAFINI DEGISTIR (sadece grup yoneticisi yapabilir).
// Panelden secilen fotograf -> WhatsApp grubuna profil resmi olarak yuklenir.
// Hat-izole: hangi panel istediyse (token) o hattin soketiyle yuklenir.
app.post('/upload-group-photo', express.raw({ type: '*/*', limit: '16mb' }), async (req, res) => {
  try {
    // HAT KIMLIGI (izolasyon): token'dan hangi hat oldugunu bul
    const s = req.query.token && sessions.get(req.query.token);
    const gpLineId = (s && s.lineId) ? s.lineId : 'ofis';
    const gpLine = lines.get(gpLineId);
    const gpSock = gpLine ? gpLine.sock : (gpLineId === 'ofis' ? waSock : null);
    const gpConnected = gpLine ? !!gpLine.connected : (gpLineId === 'ofis' ? waConnected : false);
    if (!gpSock || !gpConnected) return res.status(503).json({ error: 'WhatsApp bağlı değil' });

    const jid = req.query.jid;
    if (!jid || !jid.endsWith('@g.us')) return res.status(400).json({ error: 'Geçerli bir grup seçilmedi.' });
    if (!req.body?.length) return res.status(400).json({ error: 'Fotoğraf alınamadı.' });

    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    // boyut kontrolu (cok buyuk resim WhatsApp'ta sorun olabilir)
    const boyutMB = buf.length / 1048576;
    if (boyutMB > 12) return res.status(400).json({ error: 'Fotoğraf çok büyük (en fazla 12 MB).' });

    // WhatsApp'a grup profil resmini yukle (zaman asimiyla — asili kalmasin)
    const gpTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('foto yukleme zaman asimi')), 45000));
    try {
      await Promise.race([gpSock.updateProfilePicture(jid, buf), gpTimeout]);
    } catch (e) {
      console.error('⚠️  Grup fotosu degistirilemedi:', e.message);
      return res.status(502).json({ error: 'Fotoğraf değiştirilemedi. Yönetici olman gerekebilir veya bağlantı sorunu olabilir. Tekrar deneyin.' });
    }
    console.log(`🖼️  Grup fotosu degistirildi: ${jid.split('@')[0]} (hat: ${gpLineId})`);

    // Yeni fotoyu taze cek + panele yansit (avatar onbellegini atlayarak)
    // Kisa bir gecikme: WhatsApp'in yeni resmi islemesi icin
    setTimeout(async () => {
      try {
        const yeniUrl = await getAvatar(jid, true); // taze=true: onbellegi atla, yeniden cek
        const C2 = hatChats(gpLineId);
        const chat = C2.get(jid);
        if (chat) {
          chat.avatar = yeniUrl || chat.avatar;
          broadcastHat(gpLineId, { type: 'message', jid, chat: stripRaw(chat) });
          if (db.isReady()) db.saveChat(chat, gpLineId).catch(() => {});
        }
      } catch (e) {}
    }, 2000);

    res.json({ ok: true });
  } catch (e) {
    console.error('Grup foto yukleme hatasi:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
// ŞİFRELEME UYARISI: oturum bozulunca bildir.
// SADECE YÖNETİCİLERE gider — normal kullanıcıyı teknik uyarıyla meşgul etmeye gerek yok,
// zaten müdahale edecek kişi yönetici (QR tazeleme vb.).
global._sifrelemeUyariYayinla = (sayi) => {
  try {
    wss.clients.forEach((c) => {
      if (c.readyState === 1 && c._role === 'admin') {
        c.send(JSON.stringify({ type: 'sifrelemeUyari', sayi }));
      }
    });
  } catch (_) {}
};

// ============================================================
// ZOMBI BAGLANTI TEMIZLEME (sabah "mesaj dusmuyor" sorununun ANA cozumu)
// Gece internet dalgalaninca WebSocket "yari-acik" (olu ama acik gorunur) hale gelir.
// Ne panel ne sunucu farketmezse mesajlar akmaz. Cozum: sunucu her panele DUZENLI
// WebSocket-seviyesi ping atar; cevap (pong) vermeyen baglantiyi OLU sayip kapatir.
// Panel de kendi tarafinda kopmayi anlayip otomatik yeniden baglanir -> mesajlar akar.
// ============================================================
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; }); // panel WebSocket-ping'e cevap verdi -> canli
});
// Her 30sn: cevap vermeyen (zombi) baglantilari kapat, digerlerine ping at.
const _wsSaglikTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      // onceki turda ping attik, PONG GELMEDI -> baglanti olu, sonlandir.
      try { ws.terminate(); } catch (_) {}
      return;
    }
    ws.isAlive = false;          // bir sonraki pong'a kadar "olu" varsay
    try { ws.ping(); } catch (_) {} // WebSocket-seviyesi ping (panel otomatik pong doner)
  });
}, 30000);
wss.on('close', () => clearInterval(_wsSaglikTimer));

function broadcast(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(data); });
}

// GRUP SOHBETI yayini: "2 AYLIK SIGORTA MERKEZI" mesajlari TUM panel kullanicilarina gider
// (ofis/pazarlama hatti fark etmez — grup ortak; ama sadece GIRIS YAPMIS kullanicilara).
function yayinlaGrup(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === 1 && c._username) c.send(data); // sadece kimlikli (giris yapmis) kullanicilar
  });
}

// SADECE belirli bir hatta bagli panellere gonder (IZOLASYON).
// ofis hatti -> ofis kullanicilarinin panellerine. pazarlama -> sadece o pazarlamaciya.
// Bir ws'in hatti ws._lineId'de tutulur (baglanirken token'dan belirlenir).
function broadcastHat(lineId, obj) {
  const hedef = lineId || 'ofis';
  const data = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState !== 1) return;
    // ws'in hatti belirlenmemisse (eski/kimliksiz baglanti) ofis say (geriye uyumlu).
    const wsLine = c._lineId || 'ofis';
    if (wsLine === hedef) c.send(data);
  });
}

wss.on('connection', (ws) => {
  ws._lineId = 'ofis'; // varsayilan; panel 'merhaba' mesajiyla kendi hattini bildirecek
  // OTOMATİK YENİLEME: bağlanır bağlanmaz sunucunun başlangıç kimliğini gönder.
  // Panel bunu saklar; sunucu yeniden başlayıp kimlik değişince panel kendini yeniler.
  try { ws.send(JSON.stringify({ type: 'bootId', bootId: BOOT_ID, not: GUNCELLEME_NOT })); } catch (e) {}
  // Ilk status'u GONDERME — panel 'merhaba' der demez, KENDI hattinin dogru
  // durumunu (bagli/QR) gonderecegiz. Boylece pazarlamaci ofisin durumunu gormez.
  // (Asagidaki 'merhaba' handler'i dogru status + chats gonderir.)
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);

      // HEARTBEAT: panel her 25sn'de "ping" yollar; "pong" doneriz. Bu, panel-sunucu
      // arasindaki baglantiyi canli tutar (Nginx/internet "olu" deyip kesmesin).
      if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
        return;
      }

      // PANEL KIMLIGI: panel baglaninca token'iyla "merhaba" der, biz hattini buluruz.
      // Boylece bu ws'e SADECE kendi hattinin mesajlari gider (izolasyon).
      if (msg.type === 'merhaba') {
        let s = msg.token && sessions.get(msg.token);
        // RESTART SONRASI: bellek bos olabilir. Token varsa DB'den oturumu geri yukle,
        // hat bilgisi eksikse kullanicinin hattini cek. Yoksa pazarlamaci RESTART'ta
        // 'ofis'e dusup ofisin numarasina/sohbetlerine baglaniyordu (izolasyon kirilirdi!).
        if (!s && msg.token && db.isReady()) {
          try {
            const rows = await db.loadSessions();
            for (const r of rows) {
              if (!sessions.has(r.token)) sessions.set(r.token, { username: r.username, displayName: r.display_name, role: r.role, ts: Date.now() });
            }
            s = sessions.get(msg.token);
          } catch (e) {}
        }
        // session var ama hat bilgisi yok (DB'den geldiyse lineId tasinmaz) -> kullanicinin hattini cek
        if (s && !s.lineId && db.isReady()) {
          try {
            const hb = await db.getUserLine(s.username);
            s.lineId = hb.line_id || 'ofis';
            s.lineTip = hb.tip || 'ofis';
          } catch (e) {}
        }
        const lineId = (s && s.lineId) ? s.lineId : 'ofis';
        ws._lineId = lineId;
        ws._username = s ? s.username : null;
        ws._role = s ? s.role : null; // wipeAll gibi yonetici-only islemler icin
        ws._lineTip = s ? (s.lineTip || 'ofis') : 'ofis'; // WhatsApp cikis/baglama yetkisi icin
        ws._displayName = s ? (s.displayName || s.username) : null; // "buradayim" isareti icin ad
        if (ws._username && !ws._girisTs) ws._girisTs = Date.now(); // aktif kullanicilar panelinde giris saati
        console.log(`   🔗 merhaba: token ${msg.token ? 'var' : 'YOK'} | kullanici=${ws._username||'-'} | hat=${lineId}`);
        // PAZARLAMACI ise ve hatti henuz baglanmadiysa baslat (restart sonrasi QR/baglanti gelsin)
        if (lineId !== 'ofis') {
          const mevcut = lines.get(lineId);
          if (!mevcut || (!mevcut.connected && !mevcut.starting)) {
            startWA(lineId).catch(() => {});
          }
        }
        // Bu hattin GERCEK durumunu gonder (bagli mi, QR'i var mi) — panel dogru ekrani gostersin.
        const line = lines.get(lineId);
        const bagli = line ? line.connected : (lineId === 'ofis' ? waConnected : false);
        const qrImg = line ? line.lastQR : (lineId === 'ofis' ? lastQR : null);
        const myJid = line && line.myNumber ? line.myNumber + '@s.whatsapp.net' : null;
        const myName = line ? line.myName : '';
        ws.send(JSON.stringify({ type: 'status', connected: bagli, myJid, myName, qr: !bagli && !!qrImg, qrImage: (!bagli ? qrImg : null) }));
        // bu hattin GUNCEL sohbetlerini gonder (ofis ise global, pazarlama ise kendi hatti)
        // HAFIF + PARCALI: eskiden 32MB tek paket ~1.5-4sn kilitliyordu (takilmalarin ana sebebi)
        const C = hatChats(lineId);
        hafifChatsGonder(ws, C);
        // "BURADAYIM" durumu: hangi grupla kim ilgileniyor -> panel yesil isaretleri gostersin
        if (db.isReady()) {
          try { const b = await db.getBuradayim(); ws.send(JSON.stringify({ type: 'buradayimHepsi', durum: b })); } catch (_) {}
          try { const f = await db.getSetting('favoriler_' + (ws._username || ''), []); ws.send(JSON.stringify({ type: 'favoriler', liste: Array.isArray(f) ? f : [] })); } catch (_) {}
          try { const ms = await db.getSetting('mesaj_sabit', {}); ws.send(JSON.stringify({ type: 'mesajSabitler', durum: (ms && typeof ms === 'object') ? ms : {} })); } catch (_) {}
        }
        return;
      }

      // QR DURUMU ISTEGI: panel acilista (ve QR gelene kadar) bunu cagirir.
      // Boylece QR sunucuda hazirsa ANINDA panele gider (broadcast'i kacirmis olsa bile).
      if (msg.type === 'getQR') {
        // Bu panelin KENDI hattinin durumunu/QR'ini dondur (ofisinkini degil).
        const wsLine = ws._lineId || 'ofis';
        const line = lines.get(wsLine);
        const bagli = line ? line.connected : (wsLine === 'ofis' ? waConnected : false);
        const qrImg = line ? line.lastQR : (wsLine === 'ofis' ? lastQR : null);
        if (!bagli && qrImg) {
          ws.send(JSON.stringify({ type: 'status', connected: false, qr: true, qrImage: qrImg }));
        } else if (bagli) {
          ws.send(JSON.stringify({ type: 'status', connected: true }));
        }
        return;
      }

      // 0) WS KIMLIK: panel giris yapinca "ben buyum" der; ws'i o kullaniciya bagla.
      //    Ic mesajlari dogru kisiye canli iletmek icin gerekli.
      if (msg.type === 'auth') {
        const s = msg.token && sessions.get(msg.token);
        if (s) {
          ws._username = s.username;
          ws._displayName = s.displayName;
          // baglanir baglanmaz toplam okunmamis ic mesaj sayisini gonder (sekme rozeti)
          if (db.isReady()) {
            const n = await db.internalUnreadCount(s.username);
            ws.send(JSON.stringify({ type: 'internalUnread', count: n }));
          }
          // COKLU OTURUM TESPITI: ayni kullanici BASKA yer(ler)de de acik mi?
          // WhatsApp tek hat oldugundan, ayni hesabin cok yerde acik olmasi sifreleme
          // oturumunu bozabilir. Kullaniciyi uyaralim.
          let ayniKullaniciSayisi = 0;
          wss.clients.forEach((c) => {
            if (c.readyState === 1 && c._username === s.username) ayniKullaniciSayisi++;
          });
          if (ayniKullaniciSayisi > 1) {
            // bu kullanicinin TUM acik panellerine bildir
            wss.clients.forEach((c) => {
              if (c.readyState === 1 && c._username === s.username) {
                c.send(JSON.stringify({ type: 'coklisession', adet: ayniKullaniciSayisi }));
              }
            });
          }
        }
        return;
      }

      // ---- IC MESAJLAR (ekip uyeleri arasi, WhatsApp'tan bagimsiz) ----
      // Konusma listesi: kiminle yazismis, son mesaj, okunmamis
      if (msg.type === 'internalList') {
        if (!ws._username || !db.isReady()) { ws.send(JSON.stringify({ type: 'internalListResult', items: [] })); return; }
        const rows = await db.listInternalConversations(ws._username);
        // kullanici listesini de ekle (yeni konusma baslatmak icin tum ekip)
        const users = await db.listUsers();
        ws.send(JSON.stringify({
          type: 'internalListResult',
          items: rows,
          users: users.map(u => ({ username: u.username, displayName: u.display_name, role: u.role })),
          me: ws._username,
        }));
        return;
      }

      // Bir konusmayi ac (iki kullanici arasi gecmis)
      if (msg.type === 'internalLoad') {
        const other = (msg.other || '').trim();
        if (!ws._username || !other || !db.isReady()) {
          ws.send(JSON.stringify({ type: 'internalConversation', other: msg.other, messages: [] })); return;
        }
        let rows = [];
        try { rows = await db.loadInternalConversation(ws._username, other, 300); }
        catch (e) { console.log(`❌ internalLoad hatası (${ws._username}<-${other}): ${e.message}`); rows = []; }
        // MESAJLARI ÖNCE GÖNDER (okundu işaretleme sonra) -> okundu/sayaç bir hata verse
        // bile mesajlar KESİN gelir, panelde "Yükleniyor…" takılı kalmaz.
        ws.send(JSON.stringify({ type: 'internalConversation', other, messages: rows }));
        try {
          await db.markInternalRead(ws._username, other);
          const n = await db.internalUnreadCount(ws._username);
          ws.send(JSON.stringify({ type: 'internalUnread', count: n }));
          wss.clients.forEach((c) => { if (c.readyState === 1 && c._username === other) c.send(JSON.stringify({ type: 'internalReadUpdate', by: ws._username })); });
        } catch (e) { /* okundu isaretlenemese de mesajlar gitti */ }
        return;
      }

      // Ic mesaj gonder
      if (msg.type === 'internalSend') {
        if (!ws._username || !db.isReady()) { ws.send(JSON.stringify({ type: 'opError', error: 'İç mesaj gönderilemedi.' })); return; }
        const to = (msg.to || '').trim();
        const text = (msg.text || '').trim();
        if (!to || !text) return;
        const mid = 'im_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const r = await db.saveInternalMessage({ id: mid, from: ws._username, to, text, ts: Date.now() });
        if (!r.ok) { ws.send(JSON.stringify({ type: 'opError', error: 'İç mesaj kaydedilemedi.' })); return; }
        const payload = { id: mid, from: ws._username, fromName: ws._displayName || ws._username, to, text, ts: r.row?.ts || Date.now() };
        // Gonderene geri yolla (kendi ekraninda gorsun)
        ws.send(JSON.stringify({ type: 'internalMessage', msg: payload }));
        // ALICIYA canli ilet: o kullanicinin acik WS'lerini bul
        let aliciCevrimici = false;
        wss.clients.forEach((c) => {
          if (c.readyState === 1 && c._username === to) {
            c.send(JSON.stringify({ type: 'internalMessage', msg: payload }));
            aliciCevrimici = true;
          }
        });
        // alicinin yeni okunmamis sayisini guncelle (acik tum sekmelerine)
        if (aliciCevrimici && db.isReady()) {
          const n = await db.internalUnreadCount(to);
          wss.clients.forEach((c) => { if (c.readyState === 1 && c._username === to) c.send(JSON.stringify({ type: 'internalUnread', count: n })); });
        }
        return;
      }

      // Bir konusmayi okundu isaretle
      if (msg.type === 'internalRead') {
        if (!ws._username || !db.isReady()) return;
        await db.markInternalRead(ws._username, msg.other);
        const n = await db.internalUnreadCount(ws._username);
        ws.send(JSON.stringify({ type: 'internalUnread', count: n }));
        // GONDERENE ANINDA bildir: mesajlari OKUNDU -> onun ekraninda tikler maviye
        // doner + balonlar silige gecer (beklemeden, o anda).
        wss.clients.forEach((c) => {
          if (c.readyState === 1 && c._username === msg.other) {
            c.send(JSON.stringify({ type: 'internalReadUpdate', by: ws._username }));
          }
        });
        return;
      }

      // Ic mesaj SIL (sadece kendi mesajini)
      if (msg.type === 'internalDelete') {
        if (!ws._username || !db.isReady()) return;
        const r = await db.deleteInternalMessage(msg.id, ws._username);
        if (!r.ok) { ws.send(JSON.stringify({ type: 'opError', error: 'Mesaj silinemedi (sadece kendi mesajını silebilirsin).' })); return; }
        // hem bana hem karsi tarafa "silindi" bildir -> iki ekranda da guncellensin
        const bildir = { type: 'internalMsgDeleted', id: msg.id, other: msg.other, hardDelete: !!r.hardDelete };
        ws.send(JSON.stringify(bildir));
        wss.clients.forEach((c) => {
          if (c.readyState === 1 && c._username === msg.other) {
            // karsi tarafa: onun penceresinde 'other' BENIM (gonderen)
            c.send(JSON.stringify({ type: 'internalMsgDeleted', id: msg.id, other: ws._username, hardDelete: !!r.hardDelete }));
          }
        });
        return;
      }

      // Ic sohbeti KALICI SIL (kullanici istegi): mesajlar DB'den TAMAMEN silinir,
      // IKI TARAFTAN da gider, yeni mesaj gelse bile eskiler ASLA geri gelmez.
      if (msg.type === 'internalConvSil') {
        if (!ws._username || !db.isReady()) return;
        if (!msg.other || msg.other === '__GRUP__') { ws.send(JSON.stringify({ type: 'opError', error: 'Grup sohbeti silinemez.' })); return; }
        const r = await db.deleteInternalConversation(ws._username, msg.other);
        if (!r.ok) { ws.send(JSON.stringify({ type: 'opError', error: 'Sohbet silinemedi.' })); return; }
        console.log(`🗑️  İç sohbet KALICI silindi: ${ws._username} <-> ${msg.other} (${r.silinen || 0} mesaj)`);
        // iki tarafa da bildir -> acik pencereler kapansin, listeler yenilensin
        ws.send(JSON.stringify({ type: 'internalConvDeleted', other: msg.other }));
        wss.clients.forEach((c) => {
          if (c.readyState === 1 && c._username === msg.other) {
            c.send(JSON.stringify({ type: 'internalConvDeleted', other: ws._username }));
          }
        });
        return;
      }

      // Ic mesaj SOHBETINI gizle (KISIYE OZEL — sadece benden gizlenir, karsi taraf gormeye devam eder)
      if (msg.type === 'internalHide') {
        if (!ws._username || !db.isReady()) return;
        const r = await db.hideInternalConversation(ws._username, msg.other);
        if (!r.ok) { ws.send(JSON.stringify({ type: 'opError', error: 'Sohbet gizlenemedi.' })); return; }
        // bu kullaniciya onayla -> panel listeden cikarsin
        ws.send(JSON.stringify({ type: 'internalConvHidden', other: msg.other }));
        return;
      }

      // Ic mesaj DUZENLE (sadece kendi mesajini, sadece metin)
      if (msg.type === 'internalEdit') {
        if (!ws._username || !db.isReady()) return;
        const yeni = (msg.text || '').trim();
        if (!yeni) return;
        const r = await db.editInternalMessage(msg.id, ws._username, yeni);
        if (!r.ok) { ws.send(JSON.stringify({ type: 'opError', error: 'Mesaj düzenlenemedi (sadece kendi mesajını düzenleyebilirsin).' })); return; }
        const bildir = { type: 'internalMsgEdited', id: msg.id, text: yeni };
        ws.send(JSON.stringify({ ...bildir, other: msg.other }));
        wss.clients.forEach((c) => {
          if (c.readyState === 1 && c._username === msg.other) {
            c.send(JSON.stringify({ ...bildir, other: ws._username }));
          }
        });
        return;
      }

      // ===== GRUP SOHBETI: "2 AYLIK SIGORTA MERKEZI" =====
      // Grup gecmisini yukle (+ anket sonuclari)
      if (msg.type === 'groupLoad') {
        if (!db.isReady()) { ws.send(JSON.stringify({ type: 'groupConversation', messages: [] })); return; }
        const rows = await db.loadGroupMessages(300);
        // mesajlar icindeki anket id'lerini topla, sonuclarini cek
        const pollIds = rows.filter(r => r.kind === 'poll' && r.text).map(r => { try { return JSON.parse(r.text).id; } catch { return null; } }).filter(Boolean);
        const pollResults = await db.getPollsResults(pollIds);
        ws.send(JSON.stringify({ type: 'groupConversation', messages: rows, pollResults }));
        return;
      }
      // Gruba mesaj gonder -> TUM online kullanicilara yayinla
      if (msg.type === 'groupSend') {
        if (!ws._username || !db.isReady()) { ws.send(JSON.stringify({ type: 'opError', error: 'Grup mesajı gönderilemedi.' })); return; }
        const text = (msg.text || '').trim();
        if (!text) return;
        const mid = 'gim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const r = await db.saveGroupMessage({ id: mid, from: ws._username, text, ts: Date.now() });
        if (!r.ok) { ws.send(JSON.stringify({ type: 'opError', error: 'Grup mesajı kaydedilemedi.' })); return; }
        const payload = { id: mid, from: ws._username, fromName: ws._displayName || ws._username, text, ts: r.row?.ts || Date.now(), kind: 'text' };
        yayinlaGrup({ type: 'groupMessage', msg: payload });
        return;
      }
      // Grup mesaji sil
      if (msg.type === 'groupDelete') {
        if (!ws._username || !db.isReady()) return;
        const r = await db.deleteGroupMessage(msg.id, ws._username);
        if (!r.ok) { ws.send(JSON.stringify({ type: 'opError', error: 'Mesaj silinemedi (sadece kendi mesajını silebilirsin).' })); return; }
        yayinlaGrup({ type: 'groupMsgDeleted', id: msg.id, hardDelete: !!r.hardDelete });
        return;
      }
      // Grup mesaji duzenle
      if (msg.type === 'groupEdit') {
        if (!ws._username || !db.isReady()) return;
        const yeni = (msg.text || '').trim();
        if (!yeni) return;
        const r = await db.editGroupMessage(msg.id, ws._username, yeni);
        if (!r.ok) { ws.send(JSON.stringify({ type: 'opError', error: 'Mesaj düzenlenemedi.' })); return; }
        yayinlaGrup({ type: 'groupMsgEdited', id: msg.id, text: yeni });
        return;
      }
      // ANKET olustur -> gruba "poll" tipinde mesaj olarak dusur
      if (msg.type === 'pollCreate') {
        if (!ws._username || !db.isReady()) return;
        const soru = (msg.soru || '').trim();
        const secenekler = Array.isArray(msg.secenekler) ? msg.secenekler.map(s => (s || '').trim()).filter(Boolean) : [];
        if (!soru || secenekler.length < 2) { ws.send(JSON.stringify({ type: 'opError', error: 'Anket için soru ve en az 2 seçenek gerekli.' })); return; }
        const pollId = 'poll_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        const pr = await db.createPoll({ id: pollId, creator: ws._username, soru, secenekler, tip: msg.tip || 'anket', ts: Date.now() });
        if (!pr.ok) { ws.send(JSON.stringify({ type: 'opError', error: 'Anket oluşturulamadı.' })); return; }
        // grup mesaji olarak dusur (kind=poll, text=anket json)
        const mid = 'gim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const anketJson = JSON.stringify({ id: pollId, soru, secenekler, tip: msg.tip || 'anket' });
        await db.saveGroupMessage({ id: mid, from: ws._username, text: anketJson, kind: 'poll', ts: Date.now() });
        const payload = { id: mid, from: ws._username, fromName: ws._displayName || ws._username, text: anketJson, ts: Date.now(), kind: 'poll' };
        yayinlaGrup({ type: 'groupMessage', msg: payload });
        return;
      }
      // Ankete OY ver -> sonuclari herkese yayinla
      if (msg.type === 'pollVote') {
        if (!ws._username || !db.isReady()) return;
        const r = await db.votePoll(msg.pollId, ws._username, msg.secenek);
        if (!r.ok) { ws.send(JSON.stringify({ type: 'opError', error: 'Oy verilemedi.' })); return; }
        const sonuc = await db.getPollResults(msg.pollId);
        if (sonuc) yayinlaGrup({ type: 'pollUpdate', pollId: msg.pollId, votes: sonuc.votes });
        return;
      }

      // ============================================================
      // HAT-DUYARLI KATMAN (IZOLASYON): Bu noktadan sonraki TUM WhatsApp
      // islemleri (gonder/sil/yanit/forward/reaksiyon vb.) bu ws'in KENDI
      // hattini kullanir. Ofis -> global waSock/waConnected/chats.
      // Pazarlama -> kendi hattinin sock/connected/chats.
      //   _LID      : bu panelin hat kimligi ('ofis' veya 'pzr_xxx')
      //   C         : bu hattin sohbet Map'i (hatChats)
      //   SOCK      : bu hattin Baileys soketi (gonderim icin)
      //   CONNECTED : bu hat WhatsApp'a bagli mi
      // ASLA global 'waSock'/'chats'/'broadcast' kullanma; izolasyon kirilir.
      // ============================================================
      const _LID = ws._lineId || 'ofis';
      const _line = lines.get(_LID); // hem ofis hem pazarlama icin o hattin objesi
      const C = hatChats(_LID);
      // KRITIK: ofis dahil HER hat KENDI line.sock'unu kullanir. Global 'waSock' KULLANMA —
      // cunku pazarlama hatti baglaninca 'waSock = sock' ile global eziliyordu ve ofisin
      // mesaji yanlis (son baglanan) hattin soketinden gidiyordu. line.sock her zaman dogru hat.
      const SOCK = _line ? _line.sock : (_LID === 'ofis' ? waSock : null);
      const CONNECTED = _line ? !!_line.connected : (_LID === 'ofis' ? waConnected : false);

      // ═══════════════════════════════════════════════════════════
      // BAĞLANTI KORUMASI (kritik): WhatsApp kopukken bu işlemler eskiden SESSİZCE
      // hiçbir şey yapmıyordu -> kullanıcı "uyarı gelmeden mesaj gitmiyor" diyordu.
      // Artık her biri DÜRÜST uyarı veriyor. ('send' hariç: o kendi kırmızı mesajını gösteriyor)
      // ═══════════════════════════════════════════════════════════
      const _baglantiGerekli = ['edit', 'newChat', 'replyPrivate', 'markAllRead', 'forward', 'react'];
      if (_baglantiGerekli.includes(msg.type) && (!SOCK || !CONNECTED)) {
        const _islemAdi = {
          edit: 'Mesaj düzenlenemedi', newChat: 'Sohbet açılamadı',
          replyPrivate: 'Özel yanıt gönderilemedi', markAllRead: 'Okundu işaretlenemedi',
          forward: 'İletilemedi', react: 'Tepki verilemedi',
        }[msg.type] || 'İşlem yapılamadı';
        console.log(`🔌 BAĞLANTI YOK — ${msg.type} reddedildi (hat=${_LID}) -> kullanıcı uyarıldı`);
        ws.send(JSON.stringify({ type: 'opError', error: _islemAdi + ': WhatsApp bağlantısı yok. Bağlantı gelince tekrar deneyin.' }));
        // iletme ise panel sırası takılmasın diye sonucu da bildir
        if (msg.type === 'forward') {
          ws.send(JSON.stringify({ type: 'forwardResult', ok: false, error: 'WhatsApp bağlantısı yok' }));
        }
        return;
      }

      // 1) Metin / yanit gonderme
      if (msg.type === 'send' && SOCK && CONNECTED) {
        // ═══ ÇİFT GÖNDERİM KORUMASI (idempotency) ═══
        // Panel her gönderime benzersiz bir kimlik (_geciciId) verir. Aynı kimlik ikinci kez
        // gelirse (çift tık, ağ tekrarı, panel iki kez yolladı) İKİNCİSİNİ YOK SAY.
        // Böylece aynı mesaj asla iki kere gitmez.
        const istekId = msg._geciciId;
        if (istekId) {
          const simdi = Date.now();
          // eski kayıtları temizle (2 dk)
          for (const [k, t] of _gonderilenIstekler) { if (simdi - t > 120000) _gonderilenIstekler.delete(k); }
          if (_gonderilenIstekler.has(istekId)) {
            console.log(`🛑 ÇİFT GÖNDERİM engellendi (aynı istek): ${istekId.slice(0, 20)}`);
            return; // sessizce yok say — mesaj zaten gönderildi
          }
          _gonderilenIstekler.set(istekId, simdi);
        }
        let replyTo = null;
        let quotedOpt = undefined;
        if (msg.replyId) {
          const chat = C.get(msg.jid);
          const orig = chat?.messages.find(x => x.id === msg.replyId);
          if (orig) {
            // id: alintilanan mesajin id'si -> panelde alintiya tiklayinca DOGRU mesaja gider
            // (Eskiden id yoktu; foto/belge yanitinda metne dusup yanlis/en son fotoya gidiyordu.)
            replyTo = { id: orig.id || msg.replyId, sender: orig.fromMe ? 'Siz' : orig.sender, text: replyPreview(orig) };
            if (orig.raw && orig.raw.key) {
              // EN IYI: tam ham mesaj varsa onu kullan
              quotedOpt = { quoted: orig.raw };
              console.log(`   ↩️  yanit alintisi hazir (tam raw)`);
            } else if (orig.key) {
              // RAW YOK ama KEY var (DB'den yuklenen mesaj): key + icerikten quoted insa et.
              // Baileys quoted icin { key, message } bekler. Metni conversation olarak veriyoruz.
              const quotedMsg = insaQuotedMesaj(orig);
              if (quotedMsg) {
                quotedOpt = { quoted: quotedMsg };
                console.log(`   ↩️  yanit alintisi key'den insa edildi`);
              } else {
                console.log(`   ⚠️  yanit: key var ama quoted insa edilemedi -> alintisiz`);
              }
            } else {
              console.log(`   ⚠️  yanit: orig bulundu ama raw VE key yok -> alintisiz`);
            }
          } else {
            console.log(`   ⚠️  yanit: orijinal mesaj bellekte bulunamadi (id: ${msg.replyId}) -> alintisiz`);
          }
        }
        const content = { text: msg.text };
        // ═══ İŞARETLEME (MENTION) — KRİTİK DÜZELTME ═══
        // ESKİ HATA: metindeki @numara'ya HER ZAMAN '@s.whatsapp.net' ekleniyordu.
        // Ama WhatsApp artık bazı kişilerde LID sistemi kullanıyor (jid: xxxx@lid).
        // LID'li birini '@s.whatsapp.net' ile etiketleyince jid YANLIŞ oluyor ->
        // WhatsApp mesajı bozuk sayıp KARŞIYA İLETMİYOR (ama bize makbuz dönüyor!).
        // Patronun dediği "işaretleme yapınca çıkmıyor" sorununun kökü tam olarak buydu.
        // ÇÖZÜM: numarayı grup üyeleri içinde ara, üyenin GERÇEK jid'ini kullan.
        const _mChat = C.get(msg.jid);
        const _mUyeler = (_mChat && Array.isArray(_mChat.members)) ? _mChat.members : [];
        const mentionJids = [];
        for (const t of (msg.text.match(/@(\d{10,15})/g) || [])) {
          const num = t.slice(1);
          const uye = _mUyeler.find(mb => mb && (mb.number === num || String(mb.jid || '').startsWith(num + '@')));
          if (uye && uye.jid) {
            mentionJids.push(uye.jid); // GERÇEK jid (LID ise @lid, normalse @s.whatsapp.net)
          } else {
            mentionJids.push(num + '@s.whatsapp.net'); // üye listesinde yok -> varsayılan
          }
        }
        if (mentionJids.length) {
          content.mentions = mentionJids;
          const lidSayisi = mentionJids.filter(j => j.endsWith('@lid')).length;
          console.log(`   @ İşaretleme: ${mentionJids.length} kişi${lidSayisi ? ` (${lidSayisi} tanesi LID — doğru jid kullanıldı)` : ''}`);
        }
        // GONDERIMI try-catch ile SAR: basarisiz olursa panele "gonderilemedi" bildir.
        _sonMesajTrafigi = Date.now(); // MESAJ ÖNCELİĞİ: ağır arka plan işleri kısa süre duraklasın
        try {
          let sent;
          // TIMEOUT 30->12sn: baglanti "yari-acik" (olu) ise kullanici 30sn beklemesin;
          // 12sn'de pes edip kirmizi unlem goster + arka planda baglantiyi tazele.
          const timeoutP = () => new Promise((_, rej) => setTimeout(() => rej(new Error('gonderim zaman asimi')), 12000));
          // ALINTILI (yanit) gondermeyi dene; alinti BOZUKSA (eski/eksik raw) hata verir.
          // O durumda mesaji ALINTISIZ gonder ki YANIT METNI yine de gitsin (kaybolmasin).
          if (quotedOpt) {
            try {
              console.log(`   ↩️  YANIT gönderiliyor (alıntılı) -> ${(msg.jid||'').split('@')[0]}`);
              sent = await kuyrukluGonder(_LID, () => Promise.race([SOCK.sendMessage(msg.jid, content, quotedOpt), timeoutP()]));
              console.log(`   ✓ YANIT gönderildi, key=${sent?.key?.id ? sent.key.id.slice(0,12) : 'YOK'}`);
            } catch (alintiHatasi) {
              console.error('   ↳ alintili gonderim basarisiz, alintisiz deneniyor:', alintiHatasi.message);
              sent = await kuyrukluGonder(_LID, () => Promise.race([SOCK.sendMessage(msg.jid, content), timeoutP()]));
              console.log(`   ✓ YANIT alıntısız gönderildi, key=${sent?.key?.id ? sent.key.id.slice(0,12) : 'YOK'}`);
              replyTo = null; // alinti gitmedi, panelde de alinti gosterme
            }
          } else {
            sent = await kuyrukluGonder(_LID, () => Promise.race([SOCK.sendMessage(msg.jid, content), timeoutP()]));
          }
          if (!sent || !sent.key) throw new Error('WhatsApp gonderimi onaylamadi');
          // TEŞHİS: gönderim ne kadar sürdü? (yavaşlama/tıkanma tespiti için)
          const gonderimSure = Date.now() - _sonMesajTrafigi;
          if (gonderimSure > 5000) console.log(`   ⏱️  YAVAŞ gönderim: ${(gonderimSure/1000).toFixed(1)}sn (grup: ${(msg.jid||'').split('@')[0]}) — soket yoğun olabilir`);
          // BAŞLANGIÇ DURUMU: grupta 1 (gönderiliyor/saat), kişide 2 (tek tik).
          // Grupta gerçek WhatsApp makbuzu (messages.update status) gelince 2'ye çıkar.
          // Böylece "makbuz hiç gelmedi = gerçekten gitmedi" tespiti kesin olur (yanlış alarm yok).
          const baslangicDurum = (msg.jid || '').endsWith('@g.us') ? 1 : 2;
          addMessage(msg.jid, {
            id: sent.key.id, key: sent.key,
            raw: sent, // GONDERIM SONUCU: kendi mesajimizi sonradan YANITLAYINCA alinti icin gerekli
            fromMe: true, kind: 'text', text: msg.text,
            sender: msg.agent || 'Ben', time: nowTime(), replyTo,
            durum: baslangicDurum,
            teamMentions: Array.isArray(msg.teamMentions) ? msg.teamMentions : undefined,
          }, _LID);
          // PANEL EŞLEŞTİRME: panelde gösterilen geçici mesajı gerçek mesajla eşleştir.
          // (Yoksa geçici mesaj ekranda kalıp mesaj ÇİFT görünüyordu.)
          if (istekId) {
            try { ws.send(JSON.stringify({ type: 'geciciEslesti', jid: msg.jid, geciciId: istekId, gercekId: sent.key.id })); } catch (_) {}
          }
          // ═══ İLETİM DENETÇİSİ ═══ (panele düşüp WhatsApp'a gitmeyen mesaj sorunu)
          // sendMessage key döndürdü ama bu, karşıya İLETİLDİĞİ anlamına GELMEZ (yarı-açık
          // bağlantıda key döner ama mesaj gitmez). Bu mesajı takibe al: 45sn içinde
          // "iletildi" (çift tik, durum>=3) gelmezse -> ULAŞMADI say, panele uyar + otomatik yeniden dene.
          iletimDenetleBaslat(_LID, msg.jid, sent.key.id, {
            text: msg.text, agent: msg.agent, teamMentions: msg.teamMentions,
            yazan: ws._username || null, // BU mesajı yazan kişi -> uyarı SADECE ona gider
          });
        } catch (e) {
          console.error('⚠️  MESAJ GONDERILEMEDI:', e.message, '| grup:', (msg.jid || '').split('@')[0]);
          // Gonderim zaman asimina ugradiysa baglanti muhtemelen "yari-acik" (olu).
          // _sonWaAktivite'yi eskit ki canlilik kontrolu HEMEN devreye girip baglantiyi yenilesin.
          if (_LID === 'ofis' && (e.message || '').includes('zaman asimi')) {
            _sonWaAktivite = Date.now() - (80 * 1000); // 80sn once gibi goster -> kontrol tetiklenir
            // ANLIK TEST: 25sn'lik periyodu bekleme, hemen kontrol et (mesaj kaybini azalt)
            setImmediate(() => { if (global._canlilikKontrolTetikle) global._canlilikKontrolTetikle(); });
          }
          // MESAJI yine de ekrana ekle ama HATA durumuyla (durum:-1) -> WhatsApp gibi
          // kirmizi unlem cikar, kullanici gormedigini sanmaz, silip yeniden gonderir.
          const hataId = 'fail_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          addMessage(msg.jid, {
            id: hataId, fromMe: true, kind: 'text', text: msg.text,
            sender: msg.agent || 'Ben', time: nowTime(), replyTo,
            durum: -1, // GONDERILEMEDI (kirmizi unlem)
            gonderilemedi: true,
          }, _LID);
          // panele ayrica bildir (toast + metni geri koymak istersen)
          ws.send(JSON.stringify({ type: 'sendError', jid: msg.jid, text: msg.text, error: 'Mesaj gönderilemedi! Kırmızı ünlemli mesajı silip tekrar deneyin.' }));
        }
      }
      else if (msg.type === 'send') {
        // WhatsApp BAGLI DEGILKEN gonderme denemesi -> mesaji hata durumuyla goster + bildir
        const hataId = 'fail_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        addMessage(msg.jid, {
          id: hataId, fromMe: true, kind: 'text', text: msg.text,
          sender: msg.agent || 'Ben', time: nowTime(),
          durum: -1, gonderilemedi: true,
        }, _LID);
        ws.send(JSON.stringify({ type: 'sendError', jid: msg.jid, text: msg.text, error: 'WhatsApp bağlı değil — mesaj gönderilemedi.' }));
      }

      // 1b) Gonderilen mesaji DUZENLE (yaklasik 15 dk icinde)
      else if (msg.type === 'edit' && SOCK && CONNECTED) {
        const chat = C.get(msg.jid);
        const orig = chat?.messages.find(x => x.id === msg.id);
        if (orig?.key) {
          try {
            const editTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('duzenleme zaman asimi')), 15000));
            await Promise.race([SOCK.sendMessage(msg.jid, { text: msg.text, edit: orig.key }), editTimeout]);
            // WhatsApp kabul etti -> bellekte ve DB'de guncelle (yenileyince kaybolmasin)
            orig.text = msg.text;
            orig.edited = true;
            broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(chat) });
            if (db.isReady()) db.saveMessage(msg.jid, orig, _LID).catch(() => {});
            ws.send(JSON.stringify({ type: 'opOk', message: 'Mesaj düzenlendi.' }));
          } catch (e) {
            // DURUST: duzenleme gitmediyse panelde de degistirme (yoksa kullanici degisti sanir)
            console.error('⚠️  DUZENLEME BASARISIZ:', e.message);
            ws.send(JSON.stringify({ type: 'opError', error: 'Düzenlenemedi (WhatsApp 15 dakikadan eski mesajların düzenlenmesine izin vermez veya bağlantı sorunu).' }));
          }
        } else {
          ws.send(JSON.stringify({ type: 'opError', error: 'Düzenlenecek mesaj bulunamadı.' }));
        }
      }

      // 1c) Gonderilen mesaji SIL (herkes icin, ~48 saat icinde)
      else if (msg.type === 'delete') {
        const chat = C.get(msg.jid);
        const orig = chat?.messages.find(x => x.id === msg.id);
        // TEŞHİS: silme neden başarısız? mesaj bulundu mu, key var mı, fromMe mi?
        console.log(`🗑️  SİLME isteği: id=${(msg.id||'').slice(0,16)} | mesaj bulundu=${!!orig} | key var=${!!orig?.key} | fromMe=${orig?.fromMe} | hat bağlı=${!!(SOCK && CONNECTED)}`);
        // ── DURUM A: Sunucuda böyle bir mesaj YOK (hayalet / eski id / panelde kalmış kopya).
        //    WhatsApp'tan silinecek bir şey yok. Panele "sen kendi ekranından kaldır" de.
        //    (Eskiden sadece hata veriliyordu -> mesaj ekranda sonsuza kadar kalıyordu.)
        if (!orig) {
          ws.send(JSON.stringify({ type: 'mesajYerelSil', jid: msg.jid, id: msg.id }));
          ws.send(JSON.stringify({ type: 'opOk', message: 'Mesaj kaldırıldı.' }));
        }
        // ── DURUM B: key YOK = mesaj WhatsApp'a hiç gitmemiş (gönderilememiş/hayalet).
        //    Bellekten + DB'den kaldır. Hat kopuk olsa bile çalışır.
        else if (!orig.key) {
          chat.messages = chat.messages.filter(x => x.id !== msg.id);
          if (db.isReady() && db.deleteMessage) db.deleteMessage(msg.jid, msg.id, _LID).catch(() => {});
          if (db.isReady()) {
            db.policeIdSil(['pol_' + _LID + '_' + msg.id]).then((r) => {
              if (r && r.silinen > 0) broadcastHat(_LID, { type: 'yeniPolice', kullanici: msg.agent || '' });
            }).catch(() => {});
          }
          broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(chat) });
          ws.send(JSON.stringify({ type: 'opOk', message: 'Gönderilememiş mesaj kaldırıldı.' }));
        }
        // ── DURUM C: key VAR ama hat kopuk -> WhatsApp'tan silinemez. DÜRÜST söyle.
        else if (!SOCK || !CONNECTED) {
          ws.send(JSON.stringify({ type: 'opError', error: 'WhatsApp bağlantısı yok, mesaj şu an silinemiyor. Bağlantı gelince tekrar deneyin.' }));
        }
        // ── DURUM D: Normal silme (key var + hat bağlı) -> WhatsApp'tan sil
        else {
          try {
            // SILME KEY'INI TEMIZLE: DB'den yuklenen/eksik key'lerde silme basarisiz olabiliyordu.
            let silKey = orig.key;
            if (silKey && (!silKey.remoteJid || silKey.id !== msg.id)) {
              silKey = {
                remoteJid: msg.jid,
                id: silKey.id || msg.id,
                fromMe: silKey.fromMe !== undefined ? !!silKey.fromMe : true,
                ...(silKey.participant ? { participant: silKey.participant } : {})
              };
            }
            const silTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('silme zaman asimi')), 15000));
            await Promise.race([SOCK.sendMessage(msg.jid, { delete: silKey }), silTimeout]);
            orig.deleted = true;
            orig.text = '';
            orig.kind = 'text';
            orig.mediaUrl = null;
            orig.silenKisi = msg.agent || '';
            broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(chat) });
            if (db.isReady()) db.saveMessage(msg.jid, orig, _LID).catch(() => {});
            // PERFORMANS RAPORU: bu mesaj bir PDF/poliçe idiyse, poliçe kaydını da sil
            if (db.isReady()) {
              const polId = 'pol_' + _LID + '_' + msg.id;
              db.policeIdSil([polId]).then((r) => {
                if (r && r.silinen > 0) {
                  console.log(`📄 SİLİNEN mesaj poliçeydi -> rapordan da düşürüldü (${polId.slice(0,30)})`);
                  broadcastHat(_LID, { type: 'yeniPolice', kullanici: msg.agent || '' });
                }
              }).catch(() => {});
            }
            ws.send(JSON.stringify({ type: 'opOk', message: 'Mesaj silindi.' }));
          } catch (e) {
            console.error('⚠️  SILME BASARISIZ:', e.message, '| id:', (msg.id||'').slice(0,12));
            ws.send(JSON.stringify({ type: 'opError', error: 'Mesaj silinemedi! (WhatsApp 2 dakikadan eski mesajları herkesten silmeye izin vermeyebilir veya bağlantı sorunu olabilir.) Tekrar deneyin.' }));
          }
        }
      }

      // 2) Yeni sohbet baslatma: numara dogrula + (varsa) ilk mesaji gonder
      else if (msg.type === 'newChat' && SOCK && CONNECTED) {
        // numarayi temizle ve Turkiye formatina normallestir
        let num = (msg.number || '').replace(/\D/g, '');
        // farkli girisleri duzelt:
        if (num.startsWith('0090')) num = num.slice(2);        // 0090... -> 90...
        else if (num.startsWith('0')) num = '90' + num.slice(1); // 05XX -> 905XX
        else if (num.length === 10 && num.startsWith('5')) num = '90' + num; // 5XX... -> 905XX (90 yazmadan)
        // zaten 90 ile basliyorsa dokunma
        if (num.length < 10) {
          ws.send(JSON.stringify({ type: 'newChatResult', ok: false, error: 'Numarayı kontrol et.' }));
          return;
        }
        const jid = num + '@s.whatsapp.net';
        // numara WhatsApp'ta var mi?
        try {
          const [res] = await SOCK.onWhatsApp(jid);
          if (!res?.exists) {
            ws.send(JSON.stringify({ type: 'newChatResult', ok: false, error: 'Bu numara WhatsApp kullanmıyor.' }));
            return;
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: 'newChatResult', ok: false, error: 'Numara doğrulanamadı.' }));
          return;
        }
        // ilk mesaj varsa gonder
        if (msg.text) {
          try {
            const ncTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('zaman asimi')), 30000));
            const ncSent = await Promise.race([SOCK.sendMessage(jid, { text: msg.text }), ncTimeout]);
            if (!ncSent || !ncSent.key) throw new Error('gonderim onaylanmadi');
            addMessage(jid, {
              id: ncSent.key.id, key: ncSent.key, raw: ncSent,
              fromMe: true, kind: 'text', text: msg.text,
              sender: msg.agent || 'Ben', time: nowTime(), durum: 2,
            }, { name: msg.name || num }, _LID);
          } catch (e) {
            console.error('⚠️  Yeni sohbet ilk mesaj gonderilemedi:', e.message);
            ws.send(JSON.stringify({ type: 'newChatResult', ok: false, error: 'Sohbet açıldı ama ilk mesaj gönderilemedi. Sohbetten tekrar deneyin.' }));
            return;
          }
        } else {
          // bos sohbet olustur
          if (!C.has(jid)) {
            C.set(jid, {
              jid, name: msg.name || num, isGroup: false, description: '',
              messages: [], unread: 0, lastTime: nowTime(), lastTs: Date.now(),
            });
          }
          broadcastHat(_LID, { type: 'message', jid, chat: stripRaw(C.get(jid)) });
        }
        ws.send(JSON.stringify({ type: 'newChatResult', ok: true, jid }));
      }

      // 4) OZELDEN YANITLA: gruptaki bir mesaji, atan kisinin DM'ine alintilayarak yanitla
      else if (msg.type === 'replyPrivate' && SOCK && CONNECTED) {
        // msg.groupJid: grup, msg.msgId: gruptaki orijinal mesaj, msg.text: yanit
        const groupChat = C.get(msg.groupJid);
        const orig = groupChat?.messages.find(x => x.id === msg.msgId);
        const targetJid = orig?.senderJid;
        if (!targetJid) {
          ws.send(JSON.stringify({ type: 'opError', error: 'Kişi numarası bulunamadı.' }));
          return;
        }
        try {
          // GRUP ADI: WhatsApp'ta grup uzerinden ozelden yanit verince hangi gruptan
          // geldigi gorunur. Biz de DM'in basina grup adini ekliyoruz ki musteri anlasin.
          const grupAdi = (groupChat?.name && !/^\d+$/.test(groupChat.name)) ? groupChat.name : '';
          const gonderilecekMetin = grupAdi
            ? ('💬 *' + grupAdi + '*\n' + msg.text)
            : msg.text;
          // alintiyla birlikte DM'e gonder
          if (orig.raw) {
            await SOCK.sendMessage(targetJid, { text: gonderilecekMetin }, { quoted: orig.raw });
          } else {
            await SOCK.sendMessage(targetJid, { text: gonderilecekMetin });
          }
          // DM sohbetine ekle (alinti onizlemesiyle) — panelde de grup adli halini goster
          addMessage(targetJid, {
            fromMe: true, kind: 'text', text: gonderilecekMetin,
            sender: msg.agent || 'Ben', time: nowTime(),
            replyTo: { id: orig.id || null, sender: orig.sender, text: replyPreview(orig) },
          }, { name: orig.senderPush || targetJid.split('@')[0] }, _LID);
          ws.send(JSON.stringify({ type: 'openChat', jid: targetJid }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'opError', error: 'Özelden yanıt gönderilemedi.' }));
        }
      }

      // 5) Tek bir sohbeti okundu yap (+ bahsedilme isaretini KALICI temizle)
      // Not: WhatsApp baglantisindan BAGIMSIZ calisir — isaret kaldirma her zaman olmali.
      else if (msg.type === 'markRead') {
        const chat = C.get(msg.jid);
        if (chat) {
          if (ws._role === 'muhasebeci') {
            // MUHASEBECİ okuması SESSİZ: sadece kendi sayacı sıfırlanır; ortak unread/ozelUnread'e,
            // "kim okudu" bilgisine dokunulmaz, WhatsApp'a okundu gönderilmez (ekip hâlâ okunmamış görür).
            chat.muhUnread = 0;
            if (db.isReady()) db.saveChat(chat, _LID).catch(() => {});
            broadcastHat(_LID, { type: 'msgUpdate', jid: msg.jid, ozet: { muhUnread: 0 } });
          } else {
          const oncekiUnread = chat.unread || 0;
          chat.unread = 0;
          chat.muhUnread = 0; // normal (muhasebeci olmayan) okuma herkeste okundu yapar
          // BAĞIMSIZ OKUMA: sadece bu yan-rol sahibi okuyunca özel sayaç da sıfırlanır.
          if (bagimsizOkumaKullanicilar.has(ws._username)) chat.ozelUnread = 0;
          chat.hasMention = false; // ÖNEMLI: bahsedilme isareti de kalksin, yoksa geri gelir
          // KİM AÇTI TAKİBİ: okunmamış mesaj VARKEN açan kişiyi kaydet (ekip takibi).
          // "Bu grupla en son kim ilgilendi" belli olsun. Sadece gerçekten okunmamış varken
          // açıldıysa güncelle (boşuna her tıklamada değişmesin).
          // KİM OKUDU bilgisi: (3) rol sahibi okuyunca adı YAZILMAZ; (4) renkli etiket filtresinden
          // açıldıysa YAZILMAZ — sadece "Tümü"den açılınca yazılsın.
          if (oncekiUnread > 0 && !bagimsizOkumaKullanicilar.has(ws._username) && !msg.etiketFiltrede) {
            const acanAd = ws._displayName || ws._username || 'Biri';
            chat.sonAcan = acanAd;
            chat.sonAcanTs = Date.now();
            // herkese yay: bu grubu en son kim açtı
            broadcastHat(_LID, { type: 'okunduBilgi', jid: msg.jid, sonAcan: acanAd, sonAcanTs: chat.sonAcanTs });
          }
          // WhatsApp'a okundu bilgisi gonder (baglantI varsa; yoksa sorun degil, isaret zaten kalkti)
          if (SOCK && CONNECTED) {
            try {
              const keys = chat.messages.filter(m => !m.fromMe && m.key).slice(-20).map(m => m.key);
              if (keys.length) await SOCK.readMessages(keys);
            } catch (e) {}
          }
          // DB'ye de yaz ki sunucu restart olsa bile isaret geri gelmesin
          if (db.isReady()) db.saveChat(chat, _LID).catch(() => {});
          // HAFIF: sadece okundu/bahsedilme durumunu gonder (60 mesaj degil)
          broadcastHat(_LID, { type: 'msgUpdate', jid: msg.jid, ozet: { unread: 0, ozelUnread: chat.ozelUnread || 0, muhUnread: 0, hasMention: false, sonAcan: chat.sonAcan || '', sonAcanTs: chat.sonAcanTs || 0 } });
          }
        }
      }
      // EKSIK TESPIT EDILINCE: panel tam sohbeti ister (msgAppend'de mesaj kactiysa)
      // OKUNMADI OLARAK İŞARETLE: yanlışlıkla okunan grubu herkeste tekrar okunmamış yap.
      else if (msg.type === 'markUnread') {
        const chat = C.get(msg.jid);
        if (chat) {
          chat.unread = chat.unread || 1;
          chat.ozelUnread = chat.ozelUnread || 1;
          chat.muhUnread = chat.muhUnread || 1;
          if (db.isReady()) db.saveChat(chat, _LID).catch(() => {});
          broadcastHat(_LID, { type: 'msgUpdate', jid: msg.jid, ozet: { unread: chat.unread, ozelUnread: chat.ozelUnread, muhUnread: chat.muhUnread } });
        }
      }
      else if (msg.type === 'syncChat') {
        const chat = C.get(msg.jid);
        if (chat) {
          ws.send(JSON.stringify({ type: 'chatSync', jid: msg.jid, chat: stripRaw(chat, 300) }));
        }
      }

      // ACIKLAMA TAZELE: panel bir grubu HER ACTIGINDA gonderir. Guncel aciklama/ad/uye
      // (ve foto eksikse foto) ARKA PLANDA cekilir (15sn tazelik). Basarisiz olursa 2sn
      // sonra BIR KEZ daha dener -> gruba girince aciklama KESIN gelir.
      else if (msg.type === 'aciklamaTazele') {
        const chat = C.get(msg.jid);
        if (chat && chat.isGroup) {
          const zorla = !!msg.zorla; // 🔄 Yenile tusu: ONBELLEKSIZ cek + sonucu HER DURUMDA don
          const uygula = (meta) => {
            const c = C.get(msg.jid); if (!c || !meta) return false;
            let degisti = false;
            if (meta.subject && meta.subject.trim() && c.name !== meta.subject.trim()) { c.name = meta.subject.trim(); degisti = true; }
            if (meta.desc !== undefined && c.description !== (meta.desc || '')) { c.description = (meta.desc || '').trim(); degisti = true; }
            if (meta.participants && c.memberCount !== meta.participants.length) { c.memberCount = meta.participants.length; degisti = true; }
            if (degisti) {
              broadcastHat(_LID, { type: 'msgUpdate', jid: msg.jid, ozet: { name: c.name, description: c.isGroup ? (c.description || '') : '', memberCount: c.memberCount || 0, avatar: c.avatar || null } });
              if (db.isReady()) db.saveChat(c, _LID).catch(() => {});
            }
            if (zorla) {
              try { ws.send(JSON.stringify({ type: 'aciklamaTazeleSonuc', jid: msg.jid, name: c.name, description: c.description || '', memberCount: c.memberCount || 0 })); } catch (_) {}
            }
            return true;
          };
          // ZORLA (🔄 Yenile): EN AGRESİF çekim — hem groupMetadata hem TAZE groupFetchAllParticipating
          // doğrudan çağrılır, önbellek atlanır, desc kesin tamamlanır. "Çekmiyordu" sorunu için.
          if (zorla) {
            (async () => {
              const s = SOCK;
              let meta = null;
              try { meta = await Promise.race([s.groupMetadata(msg.jid), new Promise((res) => setTimeout(() => res(null), 8000))]); } catch (_) {}
              // desc boş/yoksa TAZE toplu çağrıdan tamamla (60sn önbelleği ATLA -> zorla=true)
              if (!meta || meta.desc === undefined || meta.desc === null) {
                try {
                  const detay = await Promise.race([tumGruplarDetay(s, true), new Promise((res) => setTimeout(() => res(null), 8000))]);
                  const g = detay && detay[msg.jid];
                  if (g) {
                    if (!meta) meta = g;
                    else if (g.desc !== undefined && g.desc !== null) meta.desc = g.desc;
                  }
                } catch (_) {}
              }
              if (meta && meta.subject) groupMetaCache.set(msg.jid, { meta, ts: Date.now() });
              // sonucu uygula (uygula zaten zorla'da panele bildirir); meta hâlâ boşsa yine bildir
              if (!uygula(meta)) {
                const c = C.get(msg.jid);
                try { ws.send(JSON.stringify({ type: 'aciklamaTazeleSonuc', jid: msg.jid, name: c ? c.name : '', description: (c && c.description) || '', memberCount: (c && c.memberCount) || 0 })); } catch (_) {}
              }
            })().catch(() => {});
          } else {
            getGroupMeta(msg.jid, 15 * 1000, SOCK).then((meta) => {
              if (!uygula(meta)) {
                setTimeout(() => { getGroupMeta(msg.jid, 0, SOCK).then(uygula).catch(() => {}); }, 2000);
              }
            }).catch(() => {});
          }
          // FOTO eksikse arka planda cek (kullanici: "fotoyu da ceksin")
          if (chat.avatar === undefined || chat.avatar === null) {
            getAvatar(msg.jid, false, SOCK).then((av) => {
              const c = C.get(msg.jid); if (!c) return;
              c.avatar = av || '';
              if (av) {
                broadcastHat(_LID, { type: 'msgUpdate', jid: msg.jid, ozet: { name: c.name, description: c.isGroup ? (c.description || '') : '', memberCount: c.memberCount || 0, avatar: av } });
                if (db.isReady()) db.saveChat(c, _LID).catch(() => {});
              }
            }).catch(() => {});
          }
        }
      }

      // MESAJ SABITLE (grup icinde, WhatsApp gibi): toggle + HERKESE yay. Max 3 sabit.
      else if (msg.type === 'mesajSabitle') {
        if (!ws._username || !db.isReady()) return;
        try {
          let hepsi = await db.getSetting('mesaj_sabit', {});
          if (!hepsi || typeof hepsi !== 'object') hepsi = {};
          let liste = Array.isArray(hepsi[msg.jid]) ? hepsi[msg.jid] : [];
          const idx = liste.findIndex(x => x.mid === msg.mid);
          if (idx >= 0) liste.splice(idx, 1); // vardi -> kaldir
          else {
            liste.push({ mid: msg.mid, text: String(msg.text || '').slice(0, 200), sender: String(msg.sender || '').slice(0, 60), ts: Date.now(), sabitleyen: ws._displayName || ws._username });
            if (liste.length > 3) liste.shift(); // WhatsApp gibi en fazla 3 sabit
          }
          if (liste.length) hepsi[msg.jid] = liste; else delete hepsi[msg.jid];
          await db.saveSetting('mesaj_sabit', hepsi);
          broadcast({ type: 'mesajSabitUpdate', jid: msg.jid, liste });
        } catch (e) { ws.send(JSON.stringify({ type: 'opError', error: 'Mesaj sabitlenemedi.' })); }
      }

      // FAVORILER: sohbeti favorilere ekle/cikar -> KİŞİYE ÖZEL (herkes kendi favorisini görür)
      else if (msg.type === 'favoriToggle') {
        if (!ws._username || !db.isReady()) return;
        try {
          // KİŞİYE ÖZEL anahtar: favoriler_<username>. Her kullanıcının kendi favori listesi var.
          const favKey = 'favoriler_' + ws._username;
          let f = await db.getSetting(favKey, []);
          if (!Array.isArray(f)) f = [];
          const idx = f.indexOf(msg.jid);
          let favori;
          if (idx >= 0) { f.splice(idx, 1); favori = false; }
          else { f.push(msg.jid); favori = true; }
          await db.saveSetting(favKey, f);
          // SADECE bu kullanıcının panellerine yay (ortak DEĞİL) — herkes kendi favorisini görür
          wss.clients.forEach((c) => {
            if (c.readyState === 1 && c._username === ws._username) {
              try { c.send(JSON.stringify({ type: 'favoriUpdate', jid: msg.jid, favori })); } catch (_) {}
            }
          });
        } catch (e) { ws.send(JSON.stringify({ type: 'opError', error: 'Favori güncellenemedi.' })); }
      }

      // "BURADAYIM": kullanici bir grupla ilgileniyor isaretini yak/sondur -> HERKESE yay
      else if (msg.type === 'buradayimToggle') {
        if (!ws._username || !db.isReady()) return;
        const ad = ws._displayName || ws._username;
        const r = await db.toggleBuradayim(msg.jid, ws._username, ad);
        if (!r.ok) { ws.send(JSON.stringify({ type: 'opError', error: 'İşaret güncellenemedi.' })); return; }
        // guncel listeyi TUM panellere gonder (herkes gorsun kim girdi)
        broadcast({ type: 'buradayimUpdate', jid: msg.jid, liste: r.liste || [] });
      }
      // YONETICI: bir gruptaki TUM "buradayim" isaretlerini temizle (herkesinkini)
      else if (msg.type === 'buradayimTemizle') {
        const yonetici = ws._role === 'admin' || ws._role === 'pzr_yonetici';
        if (!yonetici) { ws.send(JSON.stringify({ type: 'opError', error: 'Bu işlem için yetkiniz yok.' })); return; }
        if (!db.isReady()) return;
        const r = await db.clearBuradayim(msg.jid);
        if (!r.ok) { ws.send(JSON.stringify({ type: 'opError', error: 'İşaret kaldırılamadı.' })); return; }
        broadcast({ type: 'buradayimUpdate', jid: msg.jid, liste: [] }); // herkeste sonsun
      }

      // 6) TUMUNU okundu yap (+ tum bahsedilme isaretlerini temizle)
      else if (msg.type === 'markAllRead' && SOCK && CONNECTED) {
        for (const chat of C.values()) {
          if (chat.unread > 0 || chat.hasMention) {
            chat.unread = 0;
            chat.hasMention = false;
            try {
              const keys = chat.messages.filter(m => !m.fromMe && m.key).slice(-20).map(m => m.key);
              if (keys.length) await SOCK.readMessages(keys);
            } catch (e) {}
            if (db.isReady()) db.saveChat(chat, _LID).catch(() => {});
            broadcastHat(_LID, { type: 'message', jid: chat.jid, chat: stripRaw(chat) });
          }
        }
      }

      // 7) Mesaji ILET (forward) - baska sohbet(ler)e
      else if (msg.type === 'forward' && SOCK && CONNECTED) {
        // msg.fromJid: kaynak sohbet, msg.msgId: iletilecek mesaj, msg.targets: hedef jid listesi
        const srcChat = C.get(msg.fromJid);
        const orig = srcChat?.messages.find(x => x.id === msg.msgId);
        if (!orig) {
          ws.send(JSON.stringify({ type: 'opError', error: 'İletilecek mesaj bulunamadı.' }));
          return;
        }
        const targets = Array.isArray(msg.targets) ? msg.targets : [];
        let okCount = 0;
        let basarisizlar = []; // iletilémeyen hedefler (kullaniciya bildirilecek)
        // mime->uzanti (fileName uzantisizsa tamamlamak icin)
        const _mimedenUzanti = {
          'application/pdf': 'pdf', 'application/msword': 'doc',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
          'application/vnd.ms-excel': 'xls',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
          'text/plain': 'txt', 'text/csv': 'csv', 'image/jpeg': 'jpg', 'image/png': 'png',
          'video/mp4': 'mp4', 'audio/mpeg': 'mp3',
        };
        // iletim icin zaman asimi (medya buyukse asili kalmasin) — send ile ayni mantik
        const _iletTimeout = () => new Promise((_, rej) => setTimeout(() => rej(new Error('iletme zaman asimi')), 60000));
        for (const tjid of targets) {
          try {
            let sent;
            // MEDYA/BELGE ise: raw ile forward GUVENILMEZ (ozellikle PDF -> adsiz/bozuk gider).
            // Onun yerine diskten okuyup YENIDEN gonder (dogru fileName + mime ile).
            const medyaMi = ['image', 'video', 'audio', 'document', 'sticker'].includes(orig.kind) && orig.mediaUrl;
            if (medyaMi) {
              const fp = path.join(__dirname, 'public', orig.mediaUrl.replace(/^\/media\//, 'media/'));
              if (fs.existsSync(fp)) {
                const buf = fs.readFileSync(fp);
                const cap = orig.caption || (orig.kind !== 'document' ? orig.text : '') || '';
                if (orig.kind === 'image') sent = await kuyrukluGonder(_LID, () => Promise.race([SOCK.sendMessage(tjid, { image: buf, caption: cap || undefined }), _iletTimeout()]), true);
                else if (orig.kind === 'video') sent = await kuyrukluGonder(_LID, () => Promise.race([SOCK.sendMessage(tjid, { video: buf, caption: cap || undefined }), _iletTimeout()]), true);
                else if (orig.kind === 'audio') sent = await kuyrukluGonder(_LID, () => Promise.race([SOCK.sendMessage(tjid, { audio: buf, mimetype: orig.mime || 'audio/mp4' }), _iletTimeout()]), true);
                else if (orig.kind === 'sticker') sent = await kuyrukluGonder(_LID, () => Promise.race([SOCK.sendMessage(tjid, { sticker: buf }), _iletTimeout()]), true);
                else {
                  // BELGE: fileName + mime SART. Eksikse dosya yolundan/mime'dan tamamla.
                  let fn = orig.fileName || orig.text || '';
                  const mm = orig.mime || 'application/octet-stream';
                  if (!fn || !fn.includes('.')) {
                    const uz = _mimedenUzanti[mm] || (orig.mediaUrl.split('.').pop()) || 'pdf';
                    fn = (fn || 'belge') + '.' + uz;
                  }
                  sent = await kuyrukluGonder(_LID, () => Promise.race([SOCK.sendMessage(tjid, { document: buf, fileName: fn, mimetype: mm }), _iletTimeout()]), true);
                }
              } else if (orig.raw) {
                // dosya diskte yok ama raw varsa son care: raw ile ilet
                sent = await kuyrukluGonder(_LID, () => Promise.race([SOCK.sendMessage(tjid, { forward: orig.raw }), _iletTimeout()]), true);
              } else {
                sent = await kuyrukluGonder(_LID, () => Promise.race([SOCK.sendMessage(tjid, { text: orig.text || '(iletilen mesaj)' }), _iletTimeout()]), true);
              }
            } else if (orig.raw) {
              // METIN mesaji: raw ile forward (etiket/bicim korunur)
              sent = await kuyrukluGonder(_LID, () => Promise.race([SOCK.sendMessage(tjid, { forward: orig.raw }), _iletTimeout()]), true);
            } else {
              // sadece metin, raw yok
              sent = await kuyrukluGonder(_LID, () => Promise.race([SOCK.sendMessage(tjid, { text: orig.text || '' }), _iletTimeout()]), true);
            }
            // GONDERIM ONAYI: sent.key yoksa WhatsApp kabul etmemis -> basarisiz say
            if (!sent || !sent.key) throw new Error('WhatsApp iletimi onaylamadi');
            // STABİLİZASYON: medya (PDF/foto) gönderiminden sonra WhatsApp'ın mesajı işlemesi
            // için kısa bekleme. Art arda çok hızlı upload -> WhatsApp boğulup mesaj DÜŞÜRÜYOR
            // (yaşanan "60 PDF'ten bazıları gitmiyor" sorununun kökü). Bu bekleme rate-limit'i önler.
            const medyaGonderildi = ['image', 'video', 'audio', 'document', 'sticker'].includes(orig.kind) && orig.mediaUrl;
            if (medyaGonderildi) { await new Promise(r => setTimeout(r, 600)); }
            // panelde de gosterelim (belgede metin yerine dosya adi gosterilsin)
            addMessage(tjid, {
              id: sent.key.id, key: sent.key,
              fromMe: true, kind: orig.kind,
              text: orig.kind === 'document' ? (orig.fileName || orig.text || '') : orig.text,
              caption: orig.caption || '',
              fileName: orig.fileName || undefined,
              mime: orig.mime || undefined,
              mediaUrl: orig.mediaUrl || null,
              sender: msg.agent || 'Ben', time: nowTime(), forwarded: true,
              durum: 2,
            }, _LID);
            okCount++;
          } catch (e) {
            console.error(`Iletme hatasi (${(tjid||'').split('@')[0]}):`, e.message);
            basarisizlar.push((tjid || '').split('@')[0]);
          }
        }
        // iletme bitti. Hangi sohbete iletildiyse panel onu acsin (gittigini gorsun).
        // Tek hedefse onu, birden fazlaysa ILK hedefi ac.
        const acilacakJid = targets.length ? targets[0] : null;
        // basarisiz hedef varsa kullaniciya bildir (sessizce kaybolmasin)
        if (basarisizlar.length && okCount > 0) {
          ws.send(JSON.stringify({ type: 'opError', error: `${okCount} sohbete iletildi, ${basarisizlar.length} sohbete iletilemedi. Tekrar deneyin.` }));
        } else if (basarisizlar.length && okCount === 0) {
          ws.send(JSON.stringify({ type: 'opError', error: 'İletilemedi! Bağlantı sorunu olabilir, tekrar deneyin.' }));
        }
        ws.send(JSON.stringify({ type: 'forwardResult', ok: okCount > 0, count: okCount, acilacakJid }));
      }

      // 8) Mesaja REAKSIYON ver (emoji tepki) - bos string reaksiyonu kaldirir
      else if (msg.type === 'react' && SOCK && CONNECTED) {
        const chat = C.get(msg.jid);
        const orig = chat?.messages.find(x => x.id === msg.id);
        // key'i bul: once orig.key, yoksa orig.raw.key (gecmisten gelen mesajlar)
        let reactKey = orig?.key || orig?.raw?.key || null;
        // key'i WhatsApp'in bekledigi temiz formata getir
        if (reactKey) {
          reactKey = {
            remoteJid: msg.jid,
            id: reactKey.id || orig.id,
            fromMe: !!reactKey.fromMe,
            ...(reactKey.participant ? { participant: reactKey.participant } : {})
          };
        }
        if (reactKey && reactKey.id) {
          try {
            await SOCK.sendMessage(msg.jid, { react: { text: msg.emoji || '', key: reactKey } });
            // panelde de gosterelim (kendi reaksiyonumuz)
            if (msg.emoji) {
              orig.myReaction = msg.emoji;
              // KIM ATTI: panelden gelen kullanici adi (35 kisi tek hat kullaniyor;
              // boylece o emojiye basinca "X tepki verdi" gorunur). Telefon/musteri
              // tepkisinde bu bilgi YOK (WhatsApp vermiyor) — sadece panelden atilanlarda dolu.
              orig.reactionBy = msg.agent || '';
            } else {
              delete orig.myReaction;
              delete orig.reactionBy; // tepki kaldirildi -> kim attigi bilgisi de gitsin
            }
            broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(chat) });
            if (db.isReady()) db.saveMessage(msg.jid, orig, _LID).catch(() => {}); // kalici olsun (yenileyince kaybolmasin)
            console.log(`👍 reaksiyon gonderildi: ${msg.emoji || '(kaldirildi)'} -> ${msg.jid.split('@')[0]}${msg.agent ? ' | ' + msg.agent : ''}`);
          } catch (e) {
            console.log(`   ⚠️  REAKSIYON HATASI: ${e.message}`);
            const rl = (e.message || '').includes('rate-overlimit') || (e.message || '').includes('429');
            ws.send(JSON.stringify({ type: 'opError', error: rl ? 'WhatsApp şu an yoğun (hız sınırı), birazdan tekrar dene.' : 'Reaksiyon gönderilemedi.' }));
          }
        } else {
          console.log(`   ⚠️  reaksiyon: mesajin key'i bulunamadi (id=${msg.id})`);
          ws.send(JSON.stringify({ type: 'opError', error: 'Bu mesaja tepki verilemedi (eski mesaj olabilir).' }));
        }
      }

      // 9) Grup uye avatarlarini cek (bilgi paneli acildiginda)
      else if (msg.type === 'getMemberAvatars' && SOCK && CONNECTED) {
        const chat = C.get(msg.jid);
        if (chat?.members?.length) {
          // en fazla 40 uye icin avatar cek, hepsini cekince bir kerede yayinla
          const targets = chat.members.filter(mb => mb.avatar === undefined).slice(0, 40);
          for (const mb of targets) {
            const url = await getAvatar(mb.jid);
            mb.avatar = url; // null da olabilir (pp yok)
            // ismi numara/Bilinmeyen ise, rehber/pushName'den guncellemeyi dene
            const daha = savedContacts.get(mb.jid) || contactNames.get(mb.jid);
            if (daha && (mb.name === mb.number || mb.name === 'Bilinmeyen kişi' || !mb.name)) {
              mb.name = daha;
            }
          }
          broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(chat) });
        }
      }

      // Tek bir sohbetin (grup/kisi) kendi avatarini cek (baslik icin).
      // ARTIK her zaman GUNCEL cekiyoruz: WhatsApp'ta logo degismisse panelde de degissin.
      // (Eskiden sadece avatar YOKSA cekiyordu -> degisen logolar guncellenmiyordu.)
      // ── MEDYAYI YENİDEN İNDİR (panelden elle tetiklenir) ──
      // Dosya inmemişse kullanıcı butona basar, hemen yeniden denenir.
      else if (msg.type === 'medyaYenidenIndir' && SOCK && CONNECTED) {
        const chat = C.get(msg.jid);
        const mesaj = chat?.messages.find(x => x.id === msg.id);
        if (!mesaj || !mesaj.raw) {
          ws.send(JSON.stringify({ type: 'opError', error: 'Bu mesajın kaynağı artık yok — gönderenden tekrar iletmesini isteyin.' }));
        } else {
          console.log(`   🔄 Elle yeniden indirme isteği: ${String(msg.id).slice(0, 10)} (${mesaj.kind})`);
          try {
            const url = await saveMedia(mesaj.raw, mesaj.kind, SOCK);
            if (url) {
              addMessage(msg.jid, { id: msg.id, mediaUrl: url, fromMe: !!mesaj.fromMe }, {}, _LID);
              _medyaKuyruk.delete(msg.id);
              ws.send(JSON.stringify({ type: 'opOk', mesaj: 'Dosya indirildi ✓' }));
            } else {
              // inmedi -> kalıcı kuyruğa al, ısrar etsin
              medyaKuyrugaEkle(mesaj.raw, mesaj.kind, msg.jid, _LID, SOCK);
              ws.send(JSON.stringify({ type: 'opError', error: 'Şu an inmedi — sıraya alındı, arka planda denenecek.' }));
            }
          } catch (e) {
            medyaKuyrugaEkle(mesaj.raw, mesaj.kind, msg.jid, _LID, SOCK);
            ws.send(JSON.stringify({ type: 'opError', error: 'İndirilemedi: ' + e.message + ' — sıraya alındı.' }));
          }
        }
      }
      else if (msg.type === 'getChatAvatar' && SOCK && CONNECTED) {
        const chat = C.get(msg.jid);
        if (chat) {
          try {
            const url = await getAvatar(msg.jid, true); // true = ZORLA taze cek (onbellegi atla)
            // url null olabilir (pp kaldirilmis). Degisiklik varsa guncelle.
            if (url !== chat.avatar) {
              chat.avatar = url; // yeni logo (veya kaldirildiysa null)
              broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(chat) });
              console.log(`🖼️  avatar guncellendi [${msg.jid.split('@')[0]}]: ${url ? 'yeni logo' : 'kaldirilmis'}`);
            }
          } catch (e) {}
        }
      }

      // Sadece grup UYELERINI cek (mesajlara dokunmadan) — grup bilgisi paneli icin.
      else if (msg.type === 'getGroupMembers' && SOCK && CONNECTED) {
        const chat = C.get(msg.jid);
        if (chat && chat.isGroup) {
          try {
            const meta = await Promise.race([
              SOCK.groupMetadata(msg.jid),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
            ]);
            if (meta && meta.participants) {
              chat.memberCount = meta.participants.length;
              chat.members = meta.participants.map(p => {
                const r = resolvePhone(p.id, p.phoneNumber || null);
                const nm = savedContacts.get(r.jid) || contactNames.get(r.jid) || contactNames.get(p.id) || (r.isLid ? 'Bilinmeyen kişi' : r.number);
                const av = avatarCache.has(r.jid) ? avatarCache.get(r.jid) : (avatarCache.has(p.id) ? avatarCache.get(p.id) : undefined);
                return { jid: r.jid, number: r.number, name: nm, admin: !!p.admin, isLid: !!r.isLid, avatar: av };
              });
              if (meta.subject && meta.subject.trim()) chat.name = meta.subject.trim();
              if (db.isReady()) db.saveChat(chat, _LID).catch(() => {});
              // SADECE bu sohbetin guncel halini gonder (mesajlar stripRaw'da korunur cunku
              // panel artik az mesajla ezmiyor). Diger sohbetleri etkilemez.
              broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(chat) });
              console.log(`👥 grup uyeleri cekildi: ${chat.name} (${chat.memberCount} uye)`);
            }
          } catch (e) {
            console.log(`   ⚠️  uye cekme hatasi: ${e.message}`);
          }
        }
      }

      // Tek bir grubun gercek adini cek (adi sayiysa tiklayinca duzelsin)
      else if (msg.type === 'refreshGroupName' && SOCK && CONNECTED) {
        let chat = C.get(msg.jid);
        const grupMu = msg.jid && msg.jid.endsWith('@g.us'); // jid'den grup oldugunu anla
        console.log(`🔍 grup adi yenileme istegi: ${msg.jid} (chat var mi: ${!!chat}, isGroup: ${chat?.isGroup}, jid grup mu: ${grupMu})`);
        if (grupMu) {
          // chat yoksa bile metadata cekmeyi dene (0 uyeli/eksik yuklenmis gruplar icin)
          try {
            console.log(`   ⏳ WhatsApp'tan metadata cekiliyor...`);
            // DOGRUDAN groupMetadata cagir (getGroupMeta onbellek/kuyruk kullanir; burada taze istiyoruz)
            let meta = null;
            try {
              meta = await Promise.race([
                SOCK.groupMetadata(msg.jid),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
              ]);
            } catch (e2) {
              console.log(`   ⚠️  groupMetadata hata: ${e2.message}`);
            }
            if (meta && meta.subject && meta.subject.trim()) {
              if (!chat) {
                // chat yoktu, yeni olustur
                chat = { jid: msg.jid, isGroup: true, name: meta.subject.trim(), messages: [], lastTs: 0 };
                C.set(msg.jid, chat);
              }
              chat.isGroup = true;
              chat.name = meta.subject.trim();
              chat.description = (meta.desc && meta.desc.trim()) ? meta.desc.trim() : '';
              // UYE LISTESINI de doldur (adlari + numaralari ile) — grup bilgisinde gozuksun
              if (meta.participants) {
                chat.memberCount = meta.participants.length;
                chat.members = meta.participants.map(p => {
                  const r = resolvePhone(p.id, p.phoneNumber || null);
                  const nm = savedContacts.get(r.jid) || contactNames.get(r.jid) || contactNames.get(p.id) || (r.isLid ? 'Bilinmeyen kişi' : r.number);
                  const av = avatarCache.has(r.jid) ? avatarCache.get(r.jid) : (avatarCache.has(p.id) ? avatarCache.get(p.id) : undefined);
                  return { jid: r.jid, number: r.number, name: nm, admin: !!p.admin, isLid: !!r.isLid, avatar: av };
                });
              }
              grupAdlari.set(msg.jid, meta.subject.trim());
              if (db.isReady()) db.saveChat(chat, _LID).catch(() => {});
              broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(chat) });
              console.log(`   ✅ grup adi bulundu: "${chat.name}" (${chat.memberCount || 0} uye)`);
            } else {
              console.log(`   ❌ metadata bos geldi (subject yok). Grup gizli/erisilemez olabilir.`);
              // bellekte ad varsa onu kullan
              if (chat && grupAdlari.has(msg.jid)) {
                chat.name = grupAdlari.get(msg.jid);
                broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(chat) });
                console.log(`   ↳ bellekteki ad kullanildi: ${chat.name}`);
              }
              ws.send(JSON.stringify({ type: 'opError', error: 'Grup adı çekilemedi. WhatsApp bu grubun bilgisini vermedi (meşgul veya erişim yok). Birazdan tekrar deneyin ya da "Değiştir" ile elle yazın.' }));
            }
          } catch (e) {
            console.log(`   ⚠️  grup adi yenileme hatasi: ${e.message}`);
            ws.send(JSON.stringify({ type: 'opError', error: 'Grup adı çekilirken hata oluştu: ' + e.message }));
          }
        } else {
          console.log(`   ⚠️  bu bir grup jid'i degil: ${msg.jid}`);
        }
      }

      // Grup ADINI degistir (sadece yonetici yapabilir)
      else if (msg.type === 'setGroupName' && SOCK && CONNECTED) {
        const chat = C.get(msg.jid);
        if (!chat || !chat.isGroup) { ws.send(JSON.stringify({ type: 'opError', error: 'Bu bir grup değil.' })); return; }
        const yeni = (msg.name || '').trim();
        if (!yeni) { ws.send(JSON.stringify({ type: 'opError', error: 'İsim boş olamaz.' })); return; }
        try {
          await SOCK.groupUpdateSubject(msg.jid, yeni);
          chat.name = yeni;
          if (grupAdlari) grupAdlari.set(msg.jid, yeni); // bellekteki ad onbellegini de guncelle
          broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(chat) });
          if (db.isReady()) db.saveChat(chat, _LID).catch(() => {}); // kalici olsun
          ws.send(JSON.stringify({ type: 'opOk', message: 'Grup adı güncellendi.' }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'opError', error: 'Grup adı değiştirilemedi. Yönetici olman gerekebilir.' }));
        }
      }

      // Gruba KISI EKLE (sadece yonetici yapabilir). numbers: ["905xx", ...] veya tek numara
      // ==== ETIKETLER (labels) ====
      // Etiket listesini + grup-etiket baglantilarini panele gonder
      else if (msg.type === 'getLabels') {
        const cl = {};
        for (const [cjid, ids] of chatLabels.entries()) cl[cjid] = ids;
        ws.send(JSON.stringify({ type: 'labelsList', labels, chatLabels: cl }));
      }
      // Yeni etiket olustur (veya guncelle)
      else if (msg.type === 'saveLabel') {
        const id = msg.id || ('lbl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
        const name = (msg.name || '').trim().slice(0, 40);
        const color = msg.color || '#25d366';
        if (!name) { ws.send(JSON.stringify({ type: 'opError', error: 'Etiket adı boş olamaz.' })); return; }
        const mevcut = labels.find(l => l.id === id);
        if (mevcut) { mevcut.name = name; mevcut.color = color; }
        else labels.push({ id, name, color });
        db.addLabel(id, name, color).catch(() => {});
        broadcastHat('ofis', { type: 'labelsUpdate', labels, chatLabels: Object.fromEntries(chatLabels) });
        ws.send(JSON.stringify({ type: 'opOk', message: 'Etiket kaydedildi.' }));
      }
      // Etiketi sil
      else if (msg.type === 'deleteLabel') {
        // GÜVENLİK: etiketi SADECE yönetici silebilir (normal kullanıcı silemez).
        if (ws._role !== 'admin') {
          ws.send(JSON.stringify({ type: 'opError', error: 'Etiketleri sadece yönetici silebilir.' }));
          return;
        }
        const id = msg.id;
        labels = labels.filter(l => l.id !== id);
        // tum gruplardan bu etiketi cikar
        for (const [cjid, ids] of chatLabels.entries()) {
          const yeni = ids.filter(x => x !== id);
          if (yeni.length) chatLabels.set(cjid, yeni); else chatLabels.delete(cjid);
        }
        db.deleteLabel(id).catch(() => {});
        broadcastHat('ofis', { type: 'labelsUpdate', labels, chatLabels: Object.fromEntries(chatLabels) });
        ws.send(JSON.stringify({ type: 'opOk', message: 'Etiket silindi.' }));
      }
      // ETİKET SIRASINI değiştir (SADECE yönetici): yeni sıra dizisine göre labels'i yeniden sırala
      else if (msg.type === 'etiketSirala') {
        if (ws._role !== 'admin') {
          ws.send(JSON.stringify({ type: 'opError', error: 'Etiket sırasını sadece yönetici değiştirebilir.' }));
          return;
        }
        const yeniSira = Array.isArray(msg.sira) ? msg.sira : [];
        if (yeniSira.length) {
          // yeni sıraya göre labels'i diz (sırada olmayanlar sona)
          const haritada = new Map(labels.map(l => [l.id, l]));
          const sirali = [];
          for (const id of yeniSira) { if (haritada.has(id)) { sirali.push(haritada.get(id)); haritada.delete(id); } }
          for (const kalan of haritada.values()) sirali.push(kalan); // sırada olmayanlar
          labels = sirali;
          // DB'ye sıra kaydet (sira_no ile)
          db.etiketSiraKaydet(labels.map((l, i) => ({ id: l.id, sira: i }))).catch(() => {});
          broadcastHat('ofis', { type: 'labelsUpdate', labels, chatLabels: Object.fromEntries(chatLabels) });
        }
      }
      // Bir gruba etiket ekle/cikar (toggle)
      else if (msg.type === 'toggleChatLabel') {
        const cjid = msg.jid;
        const labelId = msg.labelId;
        if (!cjid || !labelId) return;
        const mevcut = chatLabels.get(cjid) || [];
        let yeni;
        if (mevcut.includes(labelId)) {
          yeni = mevcut.filter(x => x !== labelId);
          db.removeChatLabel(cjid, labelId).catch(() => {});
        } else {
          yeni = [...mevcut, labelId];
          db.addChatLabel(cjid, labelId).catch(() => {});
        }
        if (yeni.length) chatLabels.set(cjid, yeni); else chatLabels.delete(cjid);
        broadcastHat('ofis', { type: 'chatLabelUpdate', jid: cjid, labelIds: yeni });
        ws.send(JSON.stringify({ type: 'opOk', message: 'Etiket güncellendi.' }));
      }

      // Ekip uyelerini (giris yapan kullanicilar) panele gonder — @ ile etiketleme icin
      else if (msg.type === 'getTeam') {
        try {
          const users = await db.listUsers();
          const liste = (users || []).map(u => ({ username: u.username, displayName: u.display_name || u.username }));
          ws.send(JSON.stringify({ type: 'teamList', team: liste }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'teamList', team: [] }));
        }
      }

      // Gruba kullanici ATA (birden fazla olabilir)
      else if (msg.type === 'assignUsers') {
        const cjid = msg.jid;
        const usernames = Array.isArray(msg.usernames) ? msg.usernames : [];
        if (!cjid || !chats.has(cjid)) { ws.send(JSON.stringify({ type: 'opError', error: 'Grup bulunamadı.' })); return; }
        const mevcut = chatAssignments.get(cjid) || [];
        const yeni = [...new Set([...mevcut, ...usernames])]; // tekrarsiz birlestir
        chatAssignments.set(cjid, yeni);
        // Supabase'e yaz
        for (const u of usernames) { if (!mevcut.includes(u)) db.addAssignment(cjid, u).catch(() => {}); }
        // tum panellere bildir (atama degisti)
        broadcastHat('ofis', { type: 'assignmentUpdate', jid: cjid, users: yeni });
        ws.send(JSON.stringify({ type: 'opOk', message: 'Atama güncellendi.' }));
      }

      // Gruptan kullaniciyi CIKAR (herkes herkesi cikarabilir)
      else if (msg.type === 'unassignUser') {
        const cjid = msg.jid;
        const username = msg.username;
        if (!cjid) return;
        const mevcut = chatAssignments.get(cjid) || [];
        const yeni = mevcut.filter(u => u !== username);
        if (yeni.length) chatAssignments.set(cjid, yeni);
        else chatAssignments.delete(cjid);
        db.removeAssignment(cjid, username).catch(() => {});
        broadcastHat('ofis', { type: 'assignmentUpdate', jid: cjid, users: yeni });
        ws.send(JSON.stringify({ type: 'opOk', message: 'Çıkarıldı.' }));
      }

      // FOTO/MEDYA İŞARETLEME (ortak "yapıldı" tiki): bellekte işaretle + DB'ye yaz + tüm panellere yay.
      else if (msg.type === 'mesajIsaretle') {
        const cjid = msg.jid;
        const msgId = msg.msgId;
        const isaretli = !!msg.isaretli;
        if (!cjid || !msgId) return;
        // bellekteki mesaja işaretle
        const chat = (ws._lineId === 'ofis' || !ws._lineId) ? CC.get(cjid) : null;
        const hedefChat = chat || CC.get(cjid);
        let hedefMsg = null;
        if (hedefChat && hedefChat.messages) {
          hedefMsg = hedefChat.messages.find(x => x.id === msgId);
          if (hedefMsg) hedefMsg.isaretli = isaretli;
        }
        // DB'ye yaz (kalıcı olsun). ÖNEMLİ: mesaj DB'de kayıtlı DEĞİLSE (sadece bellekte),
        // UPDATE hiçbir satır bulamaz ve işaret KAYDEDİLMEZ (kalıcı olmaz). Bu yüzden önce
        // mesajı DB'ye KAYDET (varsa dokunmaz), sonra işaretle. Böylece işaret HER ZAMAN kalıcı.
        (async () => {
          try {
            if (hedefMsg && db.isReady()) {
              // mesajı DB'ye yaz (upsert — zaten varsa günceller, yoksa ekler)
              await db.saveMessage(cjid, hedefMsg, ws._lineId || 'ofis').catch(() => {});
            }
            await db.setMesajIsaret(msgId, isaretli, cjid, ws._lineId || 'ofis', hedefMsg).catch(() => {});
          } catch (_) {}
        })();
        // tüm ofis panellerine yay (ortak) — SINIR YOK, istenildiği kadar işaretlenebilir
        broadcastHat(ws._lineId || 'ofis', { type: 'mesajIsaretleGuncelle', jid: cjid, msgId, isaretli });
      }

      else if (msg.type === 'getContacts') {
        // Panele kayitli kisileri (isim + numara) gonder — gruba isimle ekleme icin.
        // Hem manuel/ofis kisileri (savedContacts) hem kisi sohbetleri toplanir.
        const harita = new Map(); // numara -> isim (tekrarsiz)
        // 1) savedContacts (ofis ekibi + manuel kayitlar) — sadece numarali olanlar
        for (const [jid, isim] of savedContacts.entries()) {
          if (jid.endsWith('@s.whatsapp.net')) {
            const num = jid.split('@')[0];
            if (num && isim) harita.set(num, isim);
          }
        }
        // 2) kisi sohbetleri (gruplar haric) — adi olanlar
        for (const c of C.values()) {
          if (!c.isGroup && c.jid.endsWith('@s.whatsapp.net')) {
            const num = c.jid.split('@')[0];
            const isim = c.customName || c.name;
            // isim numaranin kendisi degilse (yani gercek bir isimse) ekle
            if (num && isim && isim !== num && !harita.has(num)) harita.set(num, isim);
          }
        }
        const liste = Array.from(harita.entries()).map(([number, name]) => ({ number, name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
        ws.send(JSON.stringify({ type: 'contactsList', contacts: liste }));
      }

      // Gruba KISI EKLE (sadece yonetici yapabilir). numbers: ["905xx", ...] veya tek numara
      else if (msg.type === 'addGroupMember' && SOCK && CONNECTED) {
        const chat = C.get(msg.jid);
        if (!chat || !chat.isGroup) { ws.send(JSON.stringify({ type: 'opError', error: 'Bu bir grup değil.' })); return; }
        // numarayi/numaralari temizle ve Turkiye formatina cevir
        const ham = Array.isArray(msg.numbers) ? msg.numbers : [msg.number];
        const jidler = [];
        for (let n of ham) {
          if (!n) continue;
          n = String(n).replace(/\D/g, '');           // sadece rakam
          if (n.startsWith('0090')) n = n.slice(2);    // 0090... -> 90...
          else if (n.startsWith('0')) n = '90' + n.slice(1); // 05XX -> 905XX
          else if (!n.startsWith('90') && n.length === 10) n = '90' + n; // 5XX... -> 905XX
          if (n.length >= 12) jidler.push(n + '@s.whatsapp.net');
        }
        if (!jidler.length) { ws.send(JSON.stringify({ type: 'opError', error: 'Geçerli numara yok.' })); return; }
        try {
          const sonuc = await SOCK.groupParticipantsUpdate(msg.jid, jidler, 'add');
          // sonuc: her numara icin durum doner. Basari/hata ayikla.
          let eklenen = 0; let hatali = [];
          for (const r of (sonuc || [])) {
            // status '200' = eklendi; digerleri sorun (davet gerekebilir, numara yok vs.)
            if (r.status === '200') eklenen++;
            else hatali.push((r.jid || '').split('@')[0]);
          }
          // grup uye listesini tazele (arka planda)
          getGroupMeta(msg.jid, 0).then((meta) => {
            if (meta && meta.participants) {
              const c = C.get(msg.jid);
              if (c) { c.memberCount = meta.participants.length; broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(c) }); }
            }
          }).catch(() => {});
          if (eklenen > 0 && !hatali.length) {
            ws.send(JSON.stringify({ type: 'opOk', message: eklenen + ' kişi gruba eklendi.' }));
          } else if (eklenen > 0) {
            ws.send(JSON.stringify({ type: 'opOk', message: eklenen + ' eklendi. Bazıları eklenemedi (gizlilik/davet gerekebilir).' }));
          } else {
            ws.send(JSON.stringify({ type: 'opError', error: 'Eklenemedi. Kişinin gizlilik ayarı davet gerektiriyor olabilir veya numara WhatsApp\'ta yok.' }));
          }
        } catch (e) {
          console.error('Gruba ekleme hatasi:', e.message);
          ws.send(JSON.stringify({ type: 'opError', error: 'Eklenemedi. Yönetici olman gerekebilir.' }));
        }
      }

      // Grup ACIKLAMASINI degistir (sadece yonetici yapabilir)
      else if (msg.type === 'setGroupDesc' && SOCK && CONNECTED) {
        const chat = C.get(msg.jid);
        if (!chat || !chat.isGroup) { ws.send(JSON.stringify({ type: 'opError', error: 'Bu bir grup değil.' })); return; }
        const yeni = (msg.desc || '').trim();
        try {
          await SOCK.groupUpdateDescription(msg.jid, yeni);
          chat.description = yeni;
          broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(chat) });
          if (db.isReady()) db.saveChat(chat, _LID).catch(() => {}); // kalici olsun
          ws.send(JSON.stringify({ type: 'opOk', message: 'Grup açıklaması güncellendi.' }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'opError', error: 'Açıklama değiştirilemedi. Yönetici olman gerekebilir.' }));
        }
      }
      // Sohbet acilinca o kisinin/grubun "yaziyor" durumuna abone ol
      // Panelden kayitli isim degistir (kalici - Supabase'e yazilir)
      else if (msg.type === 'setCustomName') {
        const chat = C.get(msg.jid);
        const isim = (msg.name || '').trim();
        if (chat && isim) {
          chat.customName = isim;
          chat.name = isim;
          // kisi ise rehber ismi olarak da kaydet (her yerde gorunsun)
          if (!chat.isGroup) {
            savedContacts.set(msg.jid, isim);
            contactNames.set(msg.jid, isim);
            if (db.isReady()) db.saveContact(msg.jid, isim, true).catch(() => {});
          }
          if (db.isReady()) db.saveChat(chat, _LID).catch(() => {});
          broadcastHat(_LID, { type: 'message', jid: msg.jid, chat: stripRaw(chat) });
          console.log(`✏️  isim kaydedildi (kalici): ${isim}`);
        }
      }

      // Sohbet acilinca mesajlarini Supabase'den yukle (DB'den gelen sohbetler icin)
      else if (msg.type === 'loadMessages') {
        const chat = C.get(msg.jid);
        if (!chat) { /* sohbet yok */ }
        else {
          // Grup adi hala ID (sayi) ise, bellekteki grupAdlari'ndan gercek adi al (aninda duzelir).
          if (chat.isGroup && /^\d+$/.test(chat.name || '') && grupAdlari.has(msg.jid)) {
            chat.name = grupAdlari.get(msg.jid);
          }
          // 1) ANINDA: bellekte ne varsa hemen gonder — kullanici beklemesin (yavaslik/bos acilis biter).
          if (chat.messages && chat.messages.length) {
            ws.send(JSON.stringify({ type: 'message', jid: msg.jid, chat: stripRaw(chat, 300) }));
          }
          // 2) ARKA PLANDA: DB'den son mesajlari cek, EKSIK olanlari ekle, sonra tekrar gonder.
          //    Boylece acilis hizli olur, eksik mesaj varsa hemen ardindan tamamlanir.
          if (db.isReady()) {
            db.loadMessages(msg.jid, 300, _LID).then((rows) => {
              console.log(`📨 loadMessages [${(chat.name||msg.jid).slice(0,30)}]: bellekte ${chat.messages?.length||0}, DB'den ${rows.length} mesaj`);
              const dbMsgs = rows.map(r => ({
                id: r.id, fromMe: r.from_me, kind: r.kind, text: r.text || '',
                mediaUrl: r.media_url || null, thumb: r.thumb || null,
                sender: r.sender || '', senderJid: r.sender_jid || '', senderPush: r.sender_push || '',
                replyTo: r.reply_to || null, contact: r.contact_data || null, contacts: r.contacts_data || null,
                reaction: r.reaction || null, myReaction: r.my_reaction || null, reactionBy: r.reaction_by || null,
                forwarded: r.forwarded || false, mentionsMe: r.mentions_me || false,
                edited: r.edited || false, deleted: r.deleted || false,
                time: r.time || '', ts: Number(r.ts) || 0, key: r.key_data || null, mentions: r.mentions || null, caption: r.caption || '', isaretli: r.isaretli || false,
              }));
              // bellek + DB birlestir (id'ye gore tekilastir)
              const birlesik = new Map();
              for (const x of (chat.messages || [])) birlesik.set(x.id, x);
              let eklendi = false;
              for (const x of dbMsgs) {
                if (!birlesik.has(x.id)) { birlesik.set(x.id, x); eklendi = true; }
                else {
                  // Mesaj zaten bellekte var. ÖNEMLİ: DB'deki KALICI işaret (isaretli) bilgisini
                  // bellektekine aktar. Yoksa bellekteki (isaretli=false) DB'deki işareti EZİYOR
                  // ve F5'te işaret KAYBOLUYORDU (yaşanan sorunun kökü buydu).
                  const bellekMsg = birlesik.get(x.id);
                  if (bellekMsg && x.isaretli && !bellekMsg.isaretli) {
                    bellekMsg.isaretli = true;
                    eklendi = true; // panele güncel hali gitsin
                  }
                }
              }
              // Sadece DB'den GERCEKTEN yeni mesaj eklendiyse VEYA bellek bostiysa tekrar gonder
              // (bos yere ikinci kez gondermeyelim — panel gereksiz render etmesin).
              if (eklendi || !chat.messages.length) {
                chat.messages = Array.from(birlesik.values()).sort((a, b) => (a.ts || 0) - (b.ts || 0));
                const last = chat.messages[chat.messages.length - 1];
                if (last) { chat.lastTs = last.ts || chat.lastTs; chat.lastTime = last.time || chat.lastTime; }
                ws.send(JSON.stringify({ type: 'message', jid: msg.jid, chat: stripRaw(chat, 300) }));
              }
            }).catch(() => {});
          } else if (!chat.messages.length) {
            // DB kapali + bellek bos: yine de bos chat gonder ki "yukleniyor" kalkmasin
            ws.send(JSON.stringify({ type: 'message', jid: msg.jid, chat: stripRaw(chat) }));
          }
        }
      }

      else if (msg.type === 'subscribePresence' && SOCK && CONNECTED) {
        try { await SOCK.presenceSubscribe(msg.jid); } catch (e) {}
      }

      // PERIYODIK TAZELEME: panel acik sohbet icin DB'den son mesajlari cekip
      // bellekte EKSIK olanlari tamamlar. WhatsApp'a DEGIL, kendi veritabanina sorar
      // (sifir rate-limit / ban riski). Canli kacan mesaj DB'ye dustuyse boylece panele gelir.
      else if (msg.type === 'refreshChat') {
        const chat = C.get(msg.jid);
        if (chat && db.isReady()) {
          const rows = await db.loadMessages(msg.jid, 80, _LID);
          if (rows && rows.length > 0) {
            // bellekteki mevcut id'ler
            const mevcutIds = new Set((chat.messages || []).map(x => x.id));
            let eklenen = 0;
            for (const r of rows) {
              if (mevcutIds.has(r.id)) continue; // zaten var
              // DB satirini bellek mesaj formatina cevir (loadMessages ile ayni esleme)
              chat.messages.push({
                id: r.id, fromMe: r.from_me, kind: r.kind, text: r.text || '',
                mediaUrl: r.media_url || null, thumb: r.thumb || null,
                sender: r.sender || '', senderJid: r.sender_jid || '', senderPush: r.sender_push || '',
                replyTo: r.reply_to || null, contact: r.contact_data || null, contacts: r.contacts_data || null,
                reaction: r.reaction || null, myReaction: r.my_reaction || null, reactionBy: r.reaction_by || null,
                forwarded: r.forwarded || false, mentionsMe: r.mentions_me || false,
                edited: r.edited || false, deleted: r.deleted || false,
                time: r.time || '', ts: Number(r.ts) || 0, key: r.key_data || null,
                mentions: r.mentions || null, caption: r.caption || '', isaretli: r.isaretli || false,
              });
              eklenen++;
            }
            if (eklenen > 0) {
              // zamana gore sirala (kacan mesaj araya dogru yere girsin)
              chat.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
              const last = chat.messages[chat.messages.length - 1];
              if (last) { chat.lastTs = last.ts || chat.lastTs; chat.lastTime = last.time || chat.lastTime; }
              console.log(`🔄 tazeleme: ${eklenen} eksik mesaj DB'den eklendi (${(chat.name||msg.jid).substring(0,25)})`);
              ws.send(JSON.stringify({ type: 'message', jid: msg.jid, chat: stripRaw(chat) }));
            }
          }
        }
      }

      // MESAJ İÇERİĞİNDE ARAMA (WhatsApp gibi): panel kelime yollar, DB'de mesajlarda arar.
      // Eşleşen sohbet jid'lerini + özet döner; panel bunları arama sonucuna ekler.
      else if (msg.type === 'searchMessages') {
        const kelime = (msg.q || '').trim();
        if (kelime.length >= 2 && db.isReady()) {
          const sonuc = await db.searchMessages(kelime, _LID, 40);
          ws.send(JSON.stringify({ type: 'searchMessagesResult', q: kelime, sohbetler: sonuc.sohbetler, mesajlar: sonuc.mesajlar }));
        } else {
          ws.send(JSON.stringify({ type: 'searchMessagesResult', q: kelime, sohbetler: [], mesajlar: [] }));
        }
      }
      // beforeTs'ten ESKI mesajlari DB'den cekip panele AYRI gonderir (ustetune eklenir).
      else if (msg.type === 'loadOlder') {
        const chat = C.get(msg.jid);
        if (chat && db.isReady() && msg.beforeTs) {
          const rows = await db.loadMessages(msg.jid, 200, _LID, Number(msg.beforeTs));
          const eskiMsgs = rows.map(r => ({
            id: r.id, fromMe: r.from_me, kind: r.kind, text: r.text || '',
            mediaUrl: r.media_url || null, thumb: r.thumb || null,
            sender: r.sender || '', senderJid: r.sender_jid || '', senderPush: r.sender_push || '',
            replyTo: r.reply_to || null, contact: r.contact_data || null, contacts: r.contacts_data || null,
            reaction: r.reaction || null, myReaction: r.my_reaction || null, reactionBy: r.reaction_by || null,
            forwarded: r.forwarded || false, mentionsMe: r.mentions_me || false,
            edited: r.edited || false, deleted: r.deleted || false,
            time: r.time || '', ts: Number(r.ts) || 0, key: r.key_data || null,
            mentions: r.mentions || null, caption: r.caption || '', isaretli: r.isaretli || false,
          }));
          // belleğe de ekle (varsa tekrar etme) ki bir daha sorulmasın
          if (eskiMsgs.length) {
            const mevcut = new Set((chat.messages || []).map(x => x.id));
            const yeniler = eskiMsgs.filter(x => !mevcut.has(x.id));
            if (yeniler.length) {
              chat.messages = [...yeniler, ...(chat.messages || [])].sort((a, b) => (a.ts || 0) - (b.ts || 0));
              // bellek limitini koru (en yeni 400) — ama eski yükleme yaptıysak geçici taşmaya izin ver
              if (chat.messages.length > 600) chat.messages = chat.messages.slice(-600);
            }
          }
          console.log(`⬆️  loadOlder [${(chat.name||msg.jid).slice(0,25)}]: ${eskiMsgs.length} eski mesaj gönderildi`);
          // AYRI tip: panel bunları üste ekleyecek, mevcut görünümü bozmayacak
          ws.send(JSON.stringify({ type: 'olderMessages', jid: msg.jid, messages: eskiMsgs, bitti: eskiMsgs.length < 200 }));
        } else {
          ws.send(JSON.stringify({ type: 'olderMessages', jid: msg.jid, messages: [], bitti: true }));
        }
      }

      // Panelden CIKIS YAP (WhatsApp baglantisini kes, oturumu sil, yeni QR uret)
      else if (msg.type === 'logout') {
        // YETKİ: WhatsApp bağlantısını kesmek ciddi bir iştir. Sadece:
        //  - admin (yönetici)
        //  - pazarlamacı (KENDİ hattını yönetir)
        //  - hat_sorumlusu (bu iş için açılmış özel rol)
        // Normal temsilci (agent) ortak ofis hattını KESEMEZ.
        const _rol = ws._role;
        const _pzr = (ws._lineTip === 'pazarlama');
        const cikisYetkisi = (_rol === 'admin') || _pzr || (_rol === 'hat_sorumlusu');
        if (!cikisYetkisi) {
          console.log(`⛔ WhatsApp cikis reddedildi (yetki yok): ${ws._username || '?'} [rol: ${_rol}]`);
          ws.send(JSON.stringify({ type: 'opError', error: 'WhatsApp bağlantısını kesme yetkiniz yok.' }));
          return;
        }
        console.log(`🚪 Panelden cikis istendi... [hat: ${_LID}, kullanici: ${ws._username}]`);
        if (_LID === 'ofis') {
          // OFIS: mevcut davranis (global ofis hatti)
          manualLogout = true;
          try { if (waSock) await waSock.logout(); } catch (e) {}
          try { if (waSock) waSock.end(); } catch (e) {}
          // oturum klasorunu sil (ofis auth)
          try {
            fs.rmSync(path.join(__dirname, 'auth', 'ofis'), { recursive: true, force: true });
          } catch (e) { console.error('auth/ofis silinemedi:', e.message); }
          // NOT: chats/contactNames/savedContacts'i SILMIYORUZ! Bunlar DB'de kalici ve
          // ayni numaraya yeniden baglaninca lazim. Sadece BAGLANTI durumunu sifirla.
          // (Tamamen temiz baslangic isteyen 'wipeAll' kullanir.)
          avatarCache.clear(); groupMetaCache.clear();
          myNumber = null; myLID = null; lastQR = null; waConnected = false;
          broadcastHat('ofis', { type: 'status', connected: false, loggedOut: true });
          console.log('   ↳ ofis cikis tamam (sohbetler korundu). Yeni QR icin baglaniliyor...');
          // yeni baglanti baslat (yeni QR uretecek)
          manualLogout = false;
          setTimeout(() => startWA('ofis'), 1500);
        } else {
          // PAZARLAMA: SADECE bu hatti kapat. Ofise/digerlerine dokunma.
          const line = lines.get(_LID);
          if (line) {
            line.manualLogout = true;
            try { if (line.sock) await line.sock.logout(); } catch (e) {}
            try { if (line.sock) line.sock.end(); } catch (e) {}
            // bu hattin auth klasorunu sil
            try { fs.rmSync(line.authDir, { recursive: true, force: true }); }
            catch (e) { console.error(`${_LID} auth silinemedi:`, e.message); }
            // baglanti durumunu sifirla (kendi sohbetleri DB'de korunur)
            line.connected = false; line.myNumber = null; line.myLID = null;
            line.lastQR = null; line.manualLogout = false;
          }
          broadcastHat(_LID, { type: 'status', connected: false, loggedOut: true });
          console.log(`   ↳ ${_LID} cikis tamam (kendi sohbetleri korundu). Yeni QR icin baglaniliyor...`);
          // bu hat icin yeni baglanti baslat (yeni QR)
          setTimeout(() => startWA(_LID), 1500);
        }
      }

      // Panelden YENI QR iste (baglanmadan once QR gelmezse)
      else if (msg.type === 'requestQR') {
        // YETKİ: yeni WhatsApp bağlamak = çıkış ile aynı yetki grubu.
        const _rol = ws._role;
        const _pzr = (ws._lineTip === 'pazarlama');
        const qrYetkisi = (_rol === 'admin') || _pzr || (_rol === 'hat_sorumlusu');
        if (!qrYetkisi) {
          ws.send(JSON.stringify({ type: 'opError', error: 'WhatsApp bağlama yetkiniz yok.' }));
          return;
        }
        if (_LID === 'ofis') {
          if (!waConnected) {
            if (lastQR) { ws.send(JSON.stringify({ type: 'status', connected: false, qr: true, qrImage: lastQR })); }
            else { manualLogout = false; startWA('ofis'); }
          }
        } else {
          const line = lines.get(_LID);
          if (!line || !line.connected) {
            if (line && line.lastQR) { ws.send(JSON.stringify({ type: 'status', connected: false, qr: true, qrImage: line.lastQR })); }
            else { startWA(_LID); }
          }
        }
      }

      // TUM verileri sil (bellek + Supabase). Cikistan ayri, kasitli temizlik.
      else if (msg.type === 'wipeAll') {
        // GUVENLIK: "Tum verileri sil" SADECE yonetici yapabilir. Panelde buton kaldirildi
        // ama yine de sunucu tarafinda da kilitliyoruz (ws uzerinden kotuye kullanim olmasin).
        if (ws._role !== 'admin') {
          console.log(`⛔ wipeAll reddedildi (yonetici degil): ${ws._username || '?'} [hat: ${_LID}]`);
          ws.send(JSON.stringify({ type: 'opError', error: 'Bu işlem için yetkiniz yok.' }));
          return;
        }
        console.log(`🗑️  TUM veriler siliniyor (panel istegi) [hat: ${_LID}]...`);
        if (_LID === 'ofis') {
          // OFIS: global temizlik (mevcut davranis)
          chats.clear(); contactNames.clear(); savedContacts.clear();
          avatarCache.clear(); groupMetaCache.clear(); lidToPn.clear();
          // Supabase bagliysa oradaki tablolari da temizle
          if (typeof db !== 'undefined' && db && db.wipeAll) {
            try { await db.wipeAll(); console.log('   ↳ Supabase verileri silindi'); }
            catch (e) { console.error('   ⚠️  Supabase silme hatasi:', e.message); }
          }
          broadcastHat('ofis', { type: 'chats', chats: [] });
          broadcastHat('ofis', { type: 'opOk', message: 'Tüm veriler silindi.' });
        } else {
          // PAZARLAMA: SADECE bu hattin verisini sil. Ofise/digerlerine ASLA dokunma.
          const C2 = hatChats(_LID);
          if (C2 && C2.clear) C2.clear();
          // Supabase'de SADECE bu hattin satirlarini sil
          if (db.isReady() && db.deleteLineData) {
            try { await db.deleteLineData(_LID); console.log(`   ↳ Supabase'de ${_LID} verileri silindi`); }
            catch (e) { console.error('   ⚠️  Supabase hat silme hatasi:', e.message); }
          }
          broadcastHat(_LID, { type: 'chats', chats: [] });
          broadcastHat(_LID, { type: 'opOk', message: 'Bu hesabın tüm verileri silindi.' });
        }
        console.log('   ↳ tamam.');
      }

      // SADECE GRUPLARI sil (kayitli kisileri KORU). Temiz baslangic + eski avatar 404'lerini temizler.
      else if (msg.type === 'wipeGroups') {
        if (ws._role !== 'admin') {
          console.log(`⛔ wipeGroups reddedildi (yonetici degil): ${ws._username || '?'} [hat: ${_LID}]`);
          ws.send(JSON.stringify({ type: 'opError', error: 'Bu işlem için yetkiniz yok.' }));
          return;
        }
        console.log(`🗑️  Sadece GRUPLAR siliniyor (kisiler korunuyor) [hat: ${_LID}]...`);
        const C2 = hatChats(_LID);
        // Bellekte: sadece grup olan sohbetleri sil, bire-bir kisileri birak
        if (C2 && C2.forEach) {
          const silinecek = [];
          C2.forEach((chat, jid) => { if (chat && chat.isGroup) silinecek.push(jid); });
          silinecek.forEach(jid => C2.delete(jid));
          console.log(`   ↳ bellekten ${silinecek.length} grup silindi`);
        }
        // Avatar onbellegini temizle ki eski (404 veren) avatar adresleri gitsin
        avatarCache.clear(); groupMetaCache.clear();
        // Supabase'de sadece gruplari sil (bu hatta ait)
        if (db.isReady() && db.wipeGroups) {
          try {
            await db.wipeGroups(_LID === 'ofis' ? null : _LID);
            console.log('   ↳ Supabase grup verileri silindi (kisiler korundu)');
          } catch (e) { console.error('   ⚠️  Supabase grup silme hatasi:', e.message); }
        }
        // Panele guncel listeyi gonder (sadece kalan kisiler) — hafif + parcali
        hafifChatsYayinla(_LID, (C2 && C2.forEach) ? C2 : new Map());
        broadcastHat(_LID, { type: 'opOk', message: 'Gruplar silindi. Kayıtlı kişiler korundu. Yeni mesaj geldikçe gruplar temiz şekilde geri gelecek.' });
        console.log('   ↳ tamam.');
      }
    } catch (e) { console.error('Panel mesaji islenemedi:', e.message); }
  });
});

function nowTime() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ============================================================
// SATIŞ KOMUTU AYRIŞTIRMA: "/trafik2", "/kasko 1", "/dask" gibi
// ============================================================
// GEÇERLİ BRANŞLAR (sadece bunlar satis sayilir; baska /xxx yazilirsa null doner).
// Türkçe karakterler normalize edilir: yesilkart/yeşilkart, oss/öss, isyeri/işyeri ikisi de gecerli.
const GECERLI_BRANSLAR = {
  'trafik': 'trafik',
  'kasko': 'kasko',
  'dask': 'dask',
  'tss': 'tss',
  'yesilkart': 'yeşilkart', 'yeşilkart': 'yeşilkart', 'yesil': 'yeşilkart',
  'konut': 'konut',
  'isyeri': 'işyeri', 'işyeri': 'işyeri',
  'oss': 'öss', 'öss': 'öss',
  'imm': 'imm',
  // YENI BRANSLAR (pazarlama satis paneli):
  'kısa süreli trafik': 'kısa süreli trafik', 'kisa sureli trafik': 'kısa süreli trafik', 'kst': 'kısa süreli trafik', 'kisa': 'kısa süreli trafik',
  'ferdi kaza': 'ferdi kaza', 'ferdikaza': 'ferdi kaza', 'ferdi': 'ferdi kaza',
  'seyahat sağlık': 'seyahat sağlık', 'seyahat saglik': 'seyahat sağlık', 'seyahat': 'seyahat sağlık',
  'özel sağlık': 'özel sağlık', 'ozel saglik': 'özel sağlık', 'özel saglik': 'özel sağlık',
  'zorunlu koltuk': 'zorunlu koltuk', 'koltuk': 'zorunlu koltuk',
};
// Panelde/raporda gosterilecek sira (pazarlamaci bilgi kutusu + dashboard icin)
const BRANS_LISTESI = ['kısa süreli trafik', 'kasko', 'trafik', 'dask', 'konut', 'işyeri', 'ferdi kaza', 'seyahat sağlık', 'tss', 'özel sağlık', 'yeşilkart', 'zorunlu koltuk', 'öss', 'imm'];

// ============================================================
// POS FORMU TESPİTİ (kredi kartı bosum formu — ÜRETİM DIŞI, poliçe/kesim SAYILMAZ)
// POS çoğu zaman YANLIŞ yazılıyor: PSO, PS, PPOS, POOS, PPO, POS, PSS...
// Bu fonksiyon dosya adında P + O(lar) + S(ler) karışımı "pos benzeri" bir TOKEN
// (kelime) olup olmadığına bakar. Sadece harf sınırıyla çevrili token'lara bakılır ki
// gerçek kelimelerin (ör. "kompozit") içindeki harfler yanlışlıkla POS sanılmasın.
// ============================================================
// Türkçe küçük harf dönüşümü (GLOBAL — posMuFormu ve diğer fonksiyonlar kullanır).
// toLowerCase Türkçe İ/I'yı bozar: İ->i, I->ı (noktasız), Ş->ş vb. doğru yapılır.
function trKucultGlobal(s) {
  return String(s || '')
    .replace(/İ/g, 'i').replace(/I/g, 'ı')
    .replace(/Ş/g, 'ş').replace(/Ğ/g, 'ğ')
    .replace(/Ü/g, 'ü').replace(/Ö/g, 'ö').replace(/Ç/g, 'ç')
    .toLowerCase();
}
function posMuFormu(dosyaAdi) {
  if (!dosyaAdi) return false;
  const ad = trKucultGlobal(String(dosyaAdi).replace(/\.pdf$/i, ''));
  const s = '[^a-zçğıöşü0-9]'; // harf/rakam olmayan sınır
  // 1) POS/PSO/PS AYRI kelime olarak (en yaygın) — kelime sınırıyla, gerçek poliçeyi elemez.
  //    "SIGORTASI PSO 40" ✓, "34PSO" ✓ (rakam sınır), "(POS)" ✓ ama "POSTA/APOSTOL/DEPOSITO" ✗
  if (new RegExp(`(^|${s}|[0-9])(p+o+s+|p+s+o+|p+s+)([0-9]|${s}|$)`).test(ad)) return true;
  // 2) BİTİŞİK yazım: bilinen poliçe kelimesinin HEMEN SONUNA yapışmış POS/PSO
  //    ("SIGORTASIPSO", "TRAFIKPOS" gibi). Sadece bu güvenli kelimelerden sonra bakılır ki
  //    "POSTA/APOSTOL" gibi masum kelimeler yanlışlıkla yakalanmasın.
  if (/(sigortas[ıi]|sigorta|trafik|kasko|dask|police|polices[ıi])(pos|pso|ps)([0-9]|[^a-zçğıöşü]|$)/.test(ad)) return true;
  return false;
}

// / ile baslar, sonra urun adi (harf), sonra (opsiyonel) adet (sayi, yoksa 1).
// Eslesmezse VEYA gecerli bir brans degilse null doner (normal mesaj sayilir).
function satisAyristir(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const m = t.match(/^\/([a-zA-ZçğıöşüÇĞİÖŞÜ]+)\s*(\d+)?$/);
  if (!m) return null;
  const ham = m[1].toLowerCase();
  // KATI KONTROL: sadece gecerli branslar (listede yoksa satis degil)
  const urun = GECERLI_BRANSLAR[ham];
  if (!urun) return null;
  const adet = m[2] ? parseInt(m[2], 10) : 1;
  if (adet < 1 || adet > 9999) return null; // mantiksiz adet
  return { urun, adet };
}

// ============================================================
// POLİÇE DOSYA ADI AYRIŞTIRMA (performans raporu için)
// Yüklenen PDF'in adından branş + plaka çıkarır. "POS" geçiyorsa REDDEDER.
// Örnek ad: "CEMSAT ... TRAFİK SİGORTASI 34 EK 8531 (GRUP ADI) 06 HAZİRAN 2026.pdf"
// Dönüş: null (poliçe değil/POS) | { brans, plaka, ikiAylik }
// ============================================================
// Dosya adında brans tespiti icin anahtar kelimeler -> normalize brans.
// ÖNCE tam/uzun kelimeler aranır; bulunmazsa KISALTMALAR (tek başına duran) denenir.
// ÖNEMLİ: Branş bulunamazsa bile PDF yine SAYILIR ('diğer' branş) — hiçbir poliçe kaçmaz.
const POLICE_BRANS_TAM = {
  'trafik': 'trafik', 'kasko': 'kasko', 'dask': 'dask',
  'yeşilkart': 'yeşilkart', 'yesilkart': 'yeşilkart', 'yeşil kart': 'yeşilkart',
  'konut': 'konut', 'işyeri': 'işyeri', 'isyeri': 'işyeri', 'iş yeri': 'işyeri',
  'tamamlayıcı sağlık': 'tss', 'tamamlayici saglik': 'tss',
  'ferdi kaza': 'ferdi kaza', 'sağlık': 'sağlık', 'saglik': 'sağlık',
  'nakliyat': 'nakliyat', 'seyahat': 'seyahat',
};
// KISALTMALAR: sadece TEK BAŞINA (kelime sınırlı) eşleşir — tesadüfi eşleşmeyi önler.
// Örn. "TR", "TRF", "TRFK" -> trafik; "KSK" -> kasko; "İMM"/"IMM" -> imm.
const POLICE_BRANS_KISA = {
  'trafik': 'trafik', 'trf': 'trafik', 'trfk': 'trafik', 'tr': 'trafik',
  'kasko': 'kasko', 'ksk': 'kasko', 'ks': 'kasko',
  'dask': 'dask', 'dsk': 'dask',
  'tss': 'tss', 'tmss': 'tss',
  'yeşilkart': 'yeşilkart', 'yesilkart': 'yeşilkart', 'yk': 'yeşilkart',
  'konut': 'konut', 'knt': 'konut',
  'işyeri': 'işyeri', 'isyeri': 'işyeri',
  'öss': 'öss', 'oss': 'öss',
  'imm': 'imm', 'ımm': 'imm',
  'fk': 'ferdi kaza',
};
function policeAdiAyristir(dosyaAdi) {
  if (!dosyaAdi || typeof dosyaAdi !== 'string') return null;
  // Türkçe-güvenli küçültme: "İ"->"i", "I"->"i" düzgün olsun (yoksa TRAFİK eşleşmez)
  const trKucult = (s) => s
    .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/Ş/g, 'ş').replace(/Ğ/g, 'ğ')
    .replace(/Ü/g, 'ü').replace(/Ö/g, 'ö').replace(/Ç/g, 'ç')
    .toLowerCase();
  const adLower = trKucult(dosyaAdi);
  // sadece PDF'leri poliçe say
  if (!adLower.endsWith('.pdf')) return null;
  // ═══ POS (kredi kartı bosum formu) = ÜRETİM DIŞI, SAYILMAZ ═══
  // POS sık sık YANLIŞ yazılıyor: PSO, PS, PPOS, POOS, PPO, POS vb. Hepsini yakala.
  // Kelime sınırıyla bakılır (başka kelimenin içindekini yanlış elemesin).
  if (posMuFormu(dosyaAdi)) return null;
  // BRANŞ TESPİTİ — 2 aşamalı:
  let brans = '';
  // 1) ÖNCE tam kelimeler (en güvenilir). İlk eşleşen kazanır.
  for (const [kelime, normal] of Object.entries(POLICE_BRANS_TAM)) {
    if (adLower.includes(trKucult(kelime))) { brans = normal; break; }
  }
  // 2) Tam kelime yoksa KISALTMALARı dene — ama SADECE tek başına duranı (kelime sınırlı).
  //    Böylece "TR" tesadüfen başka kelimenin içinde geçerse yakalanmaz.
  if (!brans) {
    for (const [kisa, normal] of Object.entries(POLICE_BRANS_KISA)) {
      // kelime sınırı: rakam/harf olmayan (veya satır başı/sonu) ile çevrili
      const re = new RegExp('(^|[^a-z0-9çğıöşü])' + kisa.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9çğıöşü]|$)');
      if (re.test(adLower)) { brans = normal; break; }
    }
  }
  // PLAKA: Türk plaka formatı (34 EK 8531 / 34EK8531 / 06 ABC 123 gibi)
  let plaka = '';
  const plakaM = dosyaAdi.match(/\b(0?[1-9]|[1-7][0-9]|8[01])\s?[A-ZÇĞİÖŞÜa-zçğıöşü]{1,3}\s?\d{2,4}\b/);
  if (plakaM) plaka = plakaM[0].toUpperCase().replace(/\s+/g, ' ').trim();
  // 2 AYLIK: dosya adında açıkça "2 aylık / 2ay / 2a" yazıyorsa işaretle (opsiyonel ipucu)
  const ikiAylik = /2\s?ayl[ıi]k|2\s?ay\b|\b2a\b|\b2ay\b/i.test(dosyaAdi);
  // PDF her durumda poliçe SAYILIR; branş bulunamazsa 'diğer' (hiçbir PDF kaçmaz).
  return { brans: brans || 'diğer', plaka, ikiAylik };
}

// ============================================================
// AKTİVİTE MESAJI TESPİTİ (kesim/ilgilenme — yanlış yazım dahil)
// "ilgileniyorum, bakıyorum, kesiyorum, kesildi" vb. + bunların hatalı yazımları.
// Dönüş: null (alakasız) | { tur } ('kesim' | 'ilgileniyorum')
// ============================================================
function aktiviteMesajiTespit(text) {
  if (!text || typeof text !== 'string') return null;
  // küçült + Türkçe karakterleri sadeleştir (yanlış yazımı yakalamak için)
  let t = text.toLowerCase()
    .replace(/ı/g, 'i').replace(/İ/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c');
  t = t.trim();
  if (t.length > 60) return null; // uzun mesajlar genelde kesim bildirimi değil
  // SORU cümlelerini ELE: "kesilecek mi?", "kesti mi" gibi sorular iş bildirimi değil.
  if (/\bm[iı]\?*\s*$/.test(t) || t.includes('?')) return null;
  // KESİM grubu: yapılan/yapılıyor eylem (kesiyorum, kesildi, kesti, kesicem, kesiyom).
  // "kesilecek" (gelecek/soru) hariç — sadece olmuş/oluyor halleri.
  if (/\bkesti\b|\bkesildi\b|\bkesiyor|\bkesiyom|\bkesicem|\bkesicez|\bkestim\b|\bkesildi/.test(t)) return { tur: 'kesim' };
  // İLGİLENME grubu: ilgilen-, bak- (ilgileniyorum, bakıyorum, bakıorum, bakiyom)
  if (/\bilgileniyor|\bilgilenıyor|\bilgilendim\b|\bilgilenicem/.test(t)) return { tur: 'ilgileniyorum' };
  if (/\bbakiyor|\bbakior|\bbakiyom|\bbakicam|\bbaktim\b/.test(t)) return { tur: 'ilgileniyorum' };
  return null;
}

// ════════════════════════════════════════════════════════════════
// TAKİP UYARISI: bir grupta "ilgileniyorum/kesiyorum" yazılıp 4 DK boyunca
// O GRUPTA HİÇ MESAJ gelmezse, YÖNETİCİ paneline "takipte kalmış olabilir" kartı düşer.
// O grupta herhangi biri (gelen/giden) yazınca uyarı İPTAL olur.
// ════════════════════════════════════════════════════════════════
const TAKIP_BEKLEME_MS = 3 * 60 * 1000; // 3 dakika
const _takipUyari = new Map(); // jid -> { timer, sonKisi, grupAd, lineId, ts }

// KAPANIŞ MESAJI TESPİTİ: "iş bitti" işareti olan mesajları yakalar.
// (1) Çizgi: "------", "======" (en az 4 ardışık çizgi — kısa çizgiler de sayılır)
// (2) Kapanış ifadeleri: "işlem kalmamıştır", "yapılacak işlem", "Pekcan Sigorta" (imza)
function kapanisMesajiMi(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 2) return false;
  // küçült + Türkçe sadeleştir (yazım toleransı). NOT: İ/I önce dönüştürülür ki
  // toLowerCase Türkçe "İ"yi bozmasın.
  const sade = t
    .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/Ş/g, 's').replace(/Ğ/g, 'g')
    .replace(/Ü/g, 'u').replace(/Ö/g, 'o').replace(/Ç/g, 'c')
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c');
  // 1) ÇİZGİ: en az 4 ardışık çizgi karakteri (kısa çizgi de iş bitti sayılır)
  if (/[-=_─—–]{4,}/.test(t)) return true;
  // tamamen çizgiden oluşuyorsa (en az 3) -> çizgi
  if (/^[-=_.\s─—–]+$/.test(t)) {
    const cizgiSayisi = (t.match(/[-=_─—–]/g) || []).length;
    if (cizgiSayisi >= 3) return true;
  }
  // 2) KAPANIŞ İFADELERİ (iş bitti anlamına gelen kalıplar)
  if (/islem kalmam|yapilacak islem kalma|islem kalmadi|isi kalmam/.test(sade)) return true;
  if (/pekcan sigorta|daima yaninizda|hayirli olsun|hayirli ugurlu/.test(sade)) return true;
  if (/tamamlandi|tamamlanmistir|halloldu|hallettik|bitti gitti/.test(sade)) return true;
  return false;
}

// Geriye dönük uyumluluk için eski isim de kapanış tespitine bağlanır.
function cizgiMesajiMi(text) { return kapanisMesajiMi(text); }

// Bir grupta mesaj geldi.
// - Kapanış mesajı (çizgi/imza/işlem bitti) -> uyarı iptal (iş tamam).
// - BİZDEN (ekip) mesaj -> uyarı iptal + timer başlatma (ekip ilgilenmiş, müşteri beklemiyor).
// - Müşteriden mesaj -> 3 dk sonra biz cevap vermezsek uyar.
function takipKontrol(jid, text, sonKisi, grupAd, lineId, isGroup, fromMe) {
  if (!isGroup) return; // sadece gruplarda
  // Kapanış mesajı VEYA bizden mesaj -> bekleyen uyarıyı iptal et, yeni timer BAŞLATMA.
  if (fromMe || kapanisMesajiMi(text)) {
    takipUyarisiIptal(jid);
    return;
  }
  // Buraya geldiyse: MÜŞTERİ yazdı ve kapanış değil -> 3 dk sonra biz cevap vermezsek uyar.
  const eski = _takipUyari.get(jid);
  if (eski && eski.timer) clearTimeout(eski.timer);
  const timer = setTimeout(() => {
    _takipUyari.delete(jid);
    const payload = {
      type: 'takipUyari',
      jid,
      grupAd: grupAd || (jid || '').split('@')[0],
      kisi: sonKisi || '',
      mesaj: `"${grupAd || 'Bu grup'}" grubunda müşteri yazdı ama 3 dk'dır cevap verilmedi. İlgilenilmeyi bekliyor olabilir.`,
    };
    // SADECE bu hattın YÖNETİCİ panellerine gönder
    wss.clients.forEach((c) => {
      try {
        if (c.readyState === 1 && c._role === 'admin' && (c._lineId || 'ofis') === lineId) {
          c.send(JSON.stringify(payload));
        }
      } catch (e) {}
    });
    console.log(`🔔 TAKİP UYARISI: ${grupAd} | müşteri yazdı, 3dk cevap yok -> yöneticiye bildirildi`);
  }, TAKIP_BEKLEME_MS);
  _takipUyari.set(jid, { timer, sonKisi, grupAd, lineId, ts: Date.now() });
}

// Takip uyarısını iptal et
function takipUyarisiIptal(jid) {
  const v = _takipUyari.get(jid);
  if (v && v.timer) { clearTimeout(v.timer); _takipUyari.delete(jid); }
}

// Bir satis komutunu DB'ye kaydet (hat-izole). Panele de canli haber verir.
// m: ham WhatsApp mesaji, parsed: {urun, adet}, lineId: hat, chat: sohbet objesi
// Son islenen satislar (mukerrer koruma): "lineId|mesajId|grup" -> zaman.
// notify+append ayni mesaji iki kez getirebiliyor; ayni mesaj id'si kisa surede
// tekrar gelirse ATLA (cift kayit olmasin). Periyodik temizlenir.
const _islenenSatislar = new Map();
// Basit string hash (deterministik id uretmek icin — ayni icerik = ayni hash)
function _basitHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return Math.abs(h).toString(36);
}
function _satisMukerrerMi(anahtar) {
  const simdi = Date.now();
  // 30 saniyeden eski kayitlari temizle (bellek sismesin)
  if (_islenenSatislar.size > 500) {
    for (const [k, t] of _islenenSatislar) { if (simdi - t > 30000) _islenenSatislar.delete(k); }
  }
  if (_islenenSatislar.has(anahtar)) {
    const oncekiZaman = _islenenSatislar.get(anahtar);
    if (simdi - oncekiZaman < 30000) return true; // 30sn icinde ayni mesaj -> mukerrer
  }
  _islenenSatislar.set(anahtar, simdi);
  return false;
}

async function satisKaydet(m, parsed, lineId, chat, saticiAdi, saticiJid) {
  if (!db.isReady()) return;
  const mesajId = m.key?.id || '';
  const grupJid = chat?.jid || m.key?.remoteJid || '';
  const ts = m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now();

  // ---- ÇİFT KAYIT KORUMASI (iki katmanli, mesajId'ye GUVENMEZ) ----
  // notify+append ayni mesaji iki kez getirebiliyor; bazen m.key.id bos veya farkli gelebiliyor.
  // O yuzden ICERIK parmak izi kullaniyoruz: ayni hat+grup+satici+urun+adet kisa surede
  // tekrar gelirse AYNI satistir, atla. (Ayni kisi ayni saniyede ayni seyi iki kez yazamaz.)
  const icerikAnahtar = [lineId, grupJid, (saticiJid || saticiAdi || ''), parsed.urun, parsed.adet].join('|');
  // ham mesaj zamanini saniyeye yuvarla -> ayni mesajin notify+append'i ayni saniyeye duser
  const saniye = Math.floor(ts / 1000);
  const mukerrerAnahtar = icerikAnahtar + '|' + saniye;
  if (_satisMukerrerMi(mukerrerAnahtar)) {
    console.log(`   ⏭️  satis atlandi (mukerrer/yansima): ${parsed.urun} x${parsed.adet} | ${(saticiAdi||'?')} | ${lineId}`);
    return;
  }

  // benzersiz satis id: ICERIK + saniye'den turet (mesajId'ye guvenme — bos/degisken olabilir).
  // Boylece ayni mesajin ikinci gelisinde AYNI id uretilir -> DB ON CONFLICT de yakalar (cift emniyet).
  let satisId;
  if (mesajId) {
    satisId = 'satis_' + lineId + '_' + mesajId;
  } else {
    // mesajId yoksa icerikten deterministik id (rastgele DEGIL — yoksa cift olurdu)
    satisId = 'satis_' + lineId + '_c_' + _basitHash(icerikAnahtar + '_' + saniye);
  }
  const kayit = {
    id: satisId,
    chatJid: grupJid,
    chatName: chat?.name || '',
    urun: parsed.urun,
    adet: parsed.adet,
    satici: saticiAdi || '',
    saticiJid: saticiJid || '',
    mesajId: mesajId,
    hamMesaj: (m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim().slice(0, 100),
    ts: ts,
  };
  try {
    const r = await db.saveSatis(kayit, lineId);
    if (r.ok && r.yeni) {
      console.log(`💰 SATIŞ [${lineId}]: ${parsed.urun} x${parsed.adet} | satici: ${saticiAdi || '?'} | grup: ${(kayit.chatName || kayit.chatJid).slice(0, 25)}`);
      // panele canli haber ver (kontrol sekmesi aciksa aninda guncellensin)
      broadcastHat(lineId, { type: 'yeniSatis', satis: { ...kayit, line_id: lineId, onayli: false } });
      // YONETICIYE de haber ver (ofis panellerine)
      if (lineId !== 'ofis') {
        broadcastHat('ofis', { type: 'satisBildirim', mesaj: `Yeni satış: ${parsed.urun} x${parsed.adet} (${saticiAdi || lineId})`, lineId });
      }
    } else if (r.ok && !r.yeni) {
      console.log(`   ⏭️  satis atlandi (DB'de zaten var): ${mesajId.slice(0, 12)}`);
    }
  } catch (e) { console.error('satisKaydet hatasi:', e.message); }
}

// Adi sayi kalan gruplar icin artan araliklarla tekrar dener (her grup icin tek seferlik kilit)
// ---- Grup metadata istek KUYRUGU (rate-overlimit'i onler) ----
// WhatsApp'i bogmamak icin: ayni anda tek istek + istekler arasi bekleme + rate limit gelince geri cekilme
let metaQueue = [];
let metaBusy = false;
let rateLimitUntil = 0; // bu zamana kadar istek atma (rate limit yedikten sonra)
// HIZLANDIRMA: eskiden tek tek + 1200ms bekleme vardi -> kuyruk hic bosalmiyor,
// grup aciklamasi GEC geliyor VE ayni sokete bindigi icin MESAJ GONDERIMINI de geciktiriyordu.
// Artik: ayni anda META_PARALEL grup birden cekilir + aralarinda kisa bekleme.
// Rate limit korumasi AYNEN duruyor (WhatsApp "yavasla" derse 60sn geri cekilir) — kontrolden cikmaz.
const META_GAP = 400;     // her tur sonrasi bekleme (ms) — 1200'den dusuruldu, cok daha hizli
const META_PARALEL = 3;   // ayni anda kac grup birden cekilsin (tek tek yerine 3'lu)

function metaQueuePush(jid, resolve, sock = null) {
  metaQueue.push({ jid, resolve, sock });
  metaQueueRun();
}
// groupFetchAllParticipating önbelleği (60sn) — açıklama tamamlama için, her seferinde
// tüm grupları çekmesin. Soket başına ayrı önbellek (ortak/pazarlama hatları için).
const _tumGruplarCache = new Map(); // sock -> { veri, ts }
async function tumGruplarDetay(sock, zorla = false) {
  const onb = _tumGruplarCache.get(sock);
  if (!zorla && onb && (Date.now() - onb.ts) < 60 * 1000) return onb.veri;
  const veri = await sock.groupFetchAllParticipating();
  _tumGruplarCache.set(sock, { veri, ts: Date.now() });
  return veri;
}

async function metaQueueRun() {
  if (metaBusy) return;
  metaBusy = true;
  while (metaQueue.length) {
    // ═══ MESAJ ÖNCELİĞİ (KRİTİK) ═══
    // 3370 grubun bilgisini çekmek WhatsApp'ı yoruyor. Kullanıcılar mesaj atarken bu iş
    // aynı bağlantıda yarışıyordu -> WhatsApp "rate-overlimit" deyip MESAJLARI reddediyordu.
    // Çözüm: ekip mesaj atarken grup bilgisi çekmeyi duraklat. Mesaj her zaman önceliklidir;
    // grup ismi/üye listesi birkaç saniye geç gelse hiçbir şey olmaz.
    let mesajBeklemesi = 0;
    while (mesajTrafigiVar() && mesajBeklemesi < 60) { // en fazla 60sn bekle (sonsuz döngü olmasın)
      await new Promise(r => setTimeout(r, 1000));
      mesajBeklemesi++;
    }
    // rate limit yediyse, suresi gecene kadar bekle
    const now = Date.now();
    if (now < rateLimitUntil) {
      await new Promise(r => setTimeout(r, rateLimitUntil - now));
    }
    // Bu turda kuyruktan en fazla META_PARALEL is al, AYNI ANDA cek (paralel).
    const tur = metaQueue.splice(0, META_PARALEL);
    let rateLimitYendi = false;
    await Promise.all(tur.map(async ({ jid, resolve, sock }) => {
      let result = null;
      try {
        // sock verildiyse O HATTIN soketiyle sorgula (ortak gruplarda ikisi de calisir,
        // ayri gruplarda dogru hat calisir); verilmediyse ofis (waSock).
        const s = sock || waSock;
        result = await s.groupMetadata(jid);
        // ÖNEMLİ: groupMetadata bazı gruplarda 'desc' (açıklama) alanını DÖNDÜRMEZ (undefined).
        // Bu durumda groupFetchAllParticipating'den o grubun açıklamasını TAMAMLA.
        // (Log'da "desc tipi=undefined" görülüyordu -> açıklama var ama bu çağrı vermiyordu.)
        if (result && (result.desc === undefined || result.desc === null)) {
          try {
            // groupFetchAllParticipating pahalı (tüm grupları çeker) -> 60sn önbelleğe al,
            // aynı tur içindeki tüm eksik-desc gruplar aynı sonucu paylaşsın.
            const detay = await tumGruplarDetay(s);
            const g = detay && detay[jid];
            if (g && g.desc !== undefined && g.desc !== null) {
              result.desc = g.desc; // açıklamayı tamamladık
            }
          } catch (_) { /* tamamlanamadı, olsun */ }
        }
        if (result?.subject && result.subject.trim()) groupMetaCache.set(jid, { meta: result, ts: Date.now() });
      } catch (e) {
        if ((e.message || '').includes('rate-overlimit') || (e.message || '').includes('429')) {
          // WhatsApp "yavasla" dedi: 60 sn boyunca hic istek atma + bu isi kuyruga geri koy
          rateLimitYendi = true;
          metaQueue.unshift({ jid, resolve, sock });
          return; // bu isin resolve'u sonraki denemede yapilacak
        }
        // baska hata: bos don
      }
      resolve(result);
    }));
    if (rateLimitYendi) {
      rateLimitUntil = Date.now() + 60000;
      console.log('   ⏸️  GRUP BİLGİSİ çekme 60sn duraklatıldı (WhatsApp "yavaşla" dedi). ✓ Mesajlar ETKİLENMİYOR — normal gidip geliyor.');
      continue; // basa don, rate limit bitene kadar bekleyecek
    }
    await new Promise(r => setTimeout(r, META_GAP)); // turlar arasi kisa bekleme
  }
  metaBusy = false;
}

const retryingGroups = new Set();
function retryGroupName(jid) {
  if (retryingGroups.has(jid)) return; // zaten deneniyor
  retryingGroups.add(jid);
  // Daha cok deneme + genis araliklar (nazik ama israrci). Grup ID'de kalmasin.
  const gecikmeler = [2000, 6000, 15000, 35000, 70000, 120000];
  let i = 0;
  const dene = async () => {
    const ch = chats.get(jid);
    if (!ch) { retryingGroups.delete(jid); return; } // sohbet artik yok
    // adi zaten duzelmisse dur
    if (ch.name && !/^\d+$/.test(ch.name)) { retryingGroups.delete(jid); return; }
    // 1) ONCE bellekteki grupAdlari'na bak (fetchAllGroups doldurmus olabilir) — bedava, hizli
    if (grupAdlari.has(jid)) {
      ch.name = grupAdlari.get(jid);
      broadcastHat('ofis', { type: 'message', jid, chat: stripRaw(ch) });
      console.log(`🔤 grup adi bellekten geldi: ${ch.name}`);
      retryingGroups.delete(jid);
      return;
    }
    // 2) rate limit yoksa WhatsApp'tan taze cek
    if (rateLimitUntil < Date.now()) {
      try {
        const meta = await getGroupMeta(jid, 0);
        if (meta?.subject && meta.subject.trim()) {
          ch.name = meta.subject.trim();
          if (meta.participants) ch.memberCount = meta.participants.length;
          // ACIKLAMA: desc varsa onu, YOKSA bos string ata. (Eskiden "if(meta.desc)" idi;
          // aciklamasiz grupta eski/baska grubun aciklamasi kaliyordu — bug buydu.)
          ch.description = (meta.desc && meta.desc.trim()) ? meta.desc.trim() : '';
          if (meta.subject) grupAdlari.set(jid, meta.subject.trim()); // bellege de yaz
          broadcastHat('ofis', { type: 'message', jid, chat: stripRaw(ch) });
          console.log(`🔤 grup adi geldi (deneme ${i + 1}): ${ch.name}`);
          retryingGroups.delete(jid);
          return;
        }
      } catch (e) {}
    }
    i++;
    if (i < gecikmeler.length) {
      setTimeout(dene, gecikmeler[i]);
    } else {
      retryingGroups.delete(jid);
      // son care: periyodik tazeleme yine deneyecek (fetchAllGroups)
    }
  };
  setTimeout(dene, gecikmeler[0]);
}

// ════════════════════════════════════════════════════════════════════════════
// KALP ATIŞI (HEARTBEAT) SİSTEMİ — "mesaj gitmiyor/gelmiyor" sorununun kök çözümü
// ────────────────────────────────────────────────────────────────────────────
// PROBLEM: WhatsApp bağlantısı "yarı-açık" kalabiliyor: soket açık görünüyor ama
//   gerçekte ölü. Bu durumda HEM giden mesaj gitmiyor HEM gelen mesaj gelmiyor,
//   üstelik sistem "bağlıyım" sandığı için kimse fark etmiyor. Eski kontrol SADECE
//   ofis hattına bakıyordu (tek global _sonWaAktivite) -> pazarlama hatları hiç
//   denetlenmiyordu, oradaki kayıplar tamamen görünmezdi.
// ÇÖZÜM: HER hat için (ofis + tüm pazarlama), sürekli çalışan agresif kalp atışı.
//   Her 15 saniyede: o hattan son 30sn'de veri gelmediyse WhatsApp sunucusuna
//   YANIT BEKLEYEN bir sorgu at. Yanıt gelmezse "kalpBasarisiz" say; 2 kez üst üste
//   başarısız olursa bağlantı ÖLÜDÜR -> kapat + yeniden bağlan. Böylece yarı-açık
//   bağlantı en geç ~30-45 saniyede yakalanıp yenilenir, kayıp penceresi minimuma iner.
// ════════════════════════════════════════════════════════════════════════════
// ────────────────────────────────────────────────────────────────────────────
// AYAR NOTU (ÖNEMLİ — "bağlantı çok sık kopuyor" sorununun kökü):
// Eski ayarlar AŞIRI agresifti: 20sn sessizlikte sorgu at, 8sn'de yanıt gelmezse
// "ölü" say, 2 hatada bağlantıyı KES. Ağ bir an yavaşladığında veya WhatsApp
// sunucusu meşgul olduğunda SAĞLAM bağlantı gereksiz yere kesiliyordu (yanlış
// pozitif) -> yeniden bağlanma sırasında mesajlar gidemiyordu.
// Baileys zaten kendi keep-alive'ını (25sn) yapıyor; bizimki YEDEK olmalı, ana
// mekanizma değil. Yeni ayarlar: gerçek ölü bağlantıyı ~2 dk içinde yakalar ama
// geçici yavaşlamada bağlantıya DOKUNMAZ.
// ────────────────────────────────────────────────────────────────────────────
const KALP_PERIYOT = 20 * 1000;   // her 20 saniyede tur (12->20: gereksiz yük azaldı)
const KALP_SESSIZLIK = 60 * 1000; // 60sn hiç veri yoksa test et (20->60: Baileys keep-alive 25sn, 60sn sessizlik GERÇEKTEN anormal)
const KALP_TIMEOUT = 15 * 1000;   // yanıt için 15sn bekle (8->15: yavaş ağa tolerans, yanlış "ölü" teşhisi yok)
const KALP_MAX_BASARISIZ = 3;     // 3 kez üst üste başarısız -> gerçekten ölü (2->3: geçici sorunda kesme)

async function kalpAtisiTuru() {
  for (const [lineId, line] of lines) {
    if (!line || !line.sock || !line.connected) continue;
    // ayni hatta iki test ust uste calismasin
    if (line.kalpTestCalisiyor) continue;
    const gecen = Date.now() - (line.sonAktivite || 0);
    if (gecen < KALP_SESSIZLIK) continue; // yakinda veri geldi -> saglikli, test gereksiz
    line.kalpTestCalisiyor = true;
    (async () => {
      let canli = false;
      try {
        const sock = line.sock;
        const num = line.myNumber;
        // YANIT BEKLEYEN sorgu: onWhatsApp (kendi numaramizi sorar) sunucudan donus bekler.
        // sendPresenceUpdate yetmez (yanit beklemez, olu baglantida bile "gecer").
        const test = await Promise.race([
          (num ? sock.onWhatsApp(num) : sock.query({ tag: 'iq', attrs: { to: '@s.whatsapp.net', type: 'get', xmlns: 'w:p' } })),
          new Promise((_, rej) => setTimeout(() => rej(new Error('kalp-timeout')), KALP_TIMEOUT)),
        ]);
        if (test !== undefined) canli = true;
      } catch (e) { canli = false; }
      finally { line.kalpTestCalisiyor = false; }

      if (canli) {
        line.sonAktivite = Date.now();
        line.kalpBasarisiz = 0; // sağlıklı -> sayaç sıfır
      } else {
        line.kalpBasarisiz = (line.kalpBasarisiz || 0) + 1;
        console.log(`💓 Kalp atışı başarısız [${lineId}] (${line.kalpBasarisiz}/${KALP_MAX_BASARISIZ}) — bağlantı yanıt vermiyor`);
        if (line.kalpBasarisiz >= KALP_MAX_BASARISIZ) {
          // ÖLÜ BAĞLANTI: kapat + yeniden bağlan (bu hatta)
          console.log(`⚠️  [${lineId}] bağlantı ÖLÜ (yarı-açık) -> kapatılıp yeniden bağlanıyor. Mesaj kaybı önleniyor.`);
          line.connected = false;
          line.kalpBasarisiz = 0;
          if (lineId === 'ofis') waConnected = false;
          broadcastHat(lineId, { type: 'status', connected: false, oluBaglanti: true });
          try { line.sock.end(new Error('kalp atisi basarisiz')); } catch (_) {}
          try { line.sock.ws?.close?.(); } catch (_) {}
          yenidenBaglanPlanla(lineId, 2500, line);
        }
      }
    })().catch(() => { line.kalpTestCalisiyor = false; });
  }
}
// TÜM hatlar için her 15 saniyede kalp atışı — ofis + pazarlama hepsi denetlenir, HİÇ DURMAZ
if (!global._kalpAtisiTimer) {
  global._kalpAtisiTimer = setInterval(() => { kalpAtisiTuru().catch(() => {}); }, KALP_PERIYOT);
}


// PROBLEM: SOCK.sendMessage() bir 'key' döndürür ama bu KARŞIYA İLETİLDİĞİ anlamına
//   GELMEZ. Bağlantı "yarı-açık" (ölü ama açık görünen) ise Baileys mesajı kabul edip
//   key döndürür, sistem "gitti" sanır (tek tik), AMA mesaj WhatsApp sunucusuna hiç
//   ulaşmaz. Karşı taraf hiç görmez. Çift tik (iletildi makbuzu) de hiç gelmez.
// ÇÖZÜM: Her gönderilen mesajı takibe al. 45sn içinde "iletildi" makbuzu (durum>=3)
//   gelmezse -> ULAŞMADI kabul et: bağlantıyı tazele + mesajı OTOMATİK yeniden gönder;
//   o da olmazsa panele kırmızı uyarı. Böylece hiçbir mesaj sessizce kaybolmaz.
// ════════════════════════════════════════════════════════════════════════════
const _iletimBekleyen = new Map(); // msgId -> { lineId, jid, timer, veri, deneme }
const ILETIM_SURE = 45 * 1000;
const ILETIM_MAX_DENEME = 2;

function iletimDenetleBaslat(lineId, jid, msgId, veri, deneme = 0) {
  if (!msgId) return;
  const eski = _iletimBekleyen.get(msgId);
  if (eski && eski.timer) clearTimeout(eski.timer);
  const timer = setTimeout(() => iletimZamanAsimi(msgId), ILETIM_SURE);
  _iletimBekleyen.set(msgId, { lineId, jid, timer, veri, deneme });
}

function iletimDenetleTamam(msgId) {
  const kayit = _iletimBekleyen.get(msgId);
  if (kayit) {
    if (kayit.timer) clearTimeout(kayit.timer);
    _iletimBekleyen.delete(msgId);
  }
}

async function iletimZamanAsimi(msgId) {
  const kayit = _iletimBekleyen.get(msgId);
  if (!kayit) return;
  _iletimBekleyen.delete(msgId);
  const { lineId, jid, veri, deneme } = kayit;
  const C = hatChats(lineId);
  const chat = C ? C.get(jid) : null;
  const m = chat ? chat.messages.find(x => x.id === msgId) : null;
  if (m && (m.durum || 0) >= 3) return; // bu arada iletildi -> sorun yok

  // ═══ KRİTİK: GRUP mu KİŞİ mi? ═══
  // GRUPLARDA "iletildi onayı" (çift tik) GÜVENİLMEZ: geç gelir veya hiç gelmez. Ama mesaj
  // ASLINDA GİTMİŞTİR (tek tik = WhatsApp sunucusu aldı). Bu yüzden ÇİFT TİK bekleyip yeniden
  // göndermek YANLIŞTI (müşteri 2 mesaj alıyordu).
  // AMA "gerçekten gitmedi" durumu da yakalanmalı. Gerçek başarısızlığın işareti: mesaj
  // gönderildi ama UZUN SÜRE "tek tik" (durum>=2 makbuzu) BİLE gelmedi. WhatsApp mesajı
  // alsaydı tek tiği hemen verirdi. Bu yüzden GRUPTA:
  //   - durum >= 2 (tek tik geldi) -> mesaj GİTTİ, sorun yok (çift tik bekleme)
  //   - durum < 2 (tek tik bile YOK) -> gerçekten gitmemiş olabilir -> KIRMIZI (ama yeniden GÖNDERME
  //     yapma, çünkü belki gitti de makbuz gecikti; kullanıcı görür, kendi karar verir)
  const grupMu = (jid || '').endsWith('@g.us');
  if (grupMu) {
    const durum = m ? (m.durum || 0) : 0;
    if (durum >= 2) {
      // tek tik (veya daha üstü) geldi -> mesaj WhatsApp'a ulaştı, GİTTİ say. Sorun yok.
      return;
    }
    // tek tik BİLE gelmedi (durum 0/1) -> mesaj gerçekten gitmemiş olabilir.
    // Kırmızı YAPMADAN önce SON BİR ŞANS: 30sn daha bekle, o arada tek tik gelirse iptal.
    console.log(`⚠️  GRUP mesajı ${ILETIM_SURE/1000}sn'dir tek tik bile almadı: ${(jid||'').split('@')[0]} -> 30sn daha bekleniyor...`);
    setTimeout(() => {
      const cc = hatChats(lineId);
      const ch = cc ? cc.get(jid) : null;
      const mm = ch ? ch.messages.find(x => x.id === msgId) : null;
      if (mm && (mm.durum || 0) >= 2) return; // bu arada tek tik geldi -> gitmiş, sorun yok
      // hâlâ tek tik yok -> GERÇEKTEN gitmedi. Kırmızı yap (ama yeniden gönderme — çift kopya riski).
      console.log(`   ✗ GRUP mesajı gerçekten iletilemedi (tek tik hiç gelmedi): ${(jid||'').split('@')[0]}`);
      iletimBasarisizBildir(lineId, jid, msgId, veri);
    }, 30 * 1000);
    return;
  }

  // ── Buradan sonrası SADECE KİŞİSEL mesajlar ──
  // ═══ KRİTİK (çift mesaj kökü): TEK TİK = mesaj WhatsApp sunucusuna ULAŞTI. ═══
  // Çift tik (durum 3) ise "alıcının telefonuna indi" demek. Alıcının telefonu KAPALI/çevrimdışıysa
  // çift tik günlerce gelmeyebilir — ama mesaj WhatsApp'ta kuyrukta bekler ve AÇILINCA gider.
  // Eskiden çift tik beklenip yeniden gönderiliyordu -> alıcı telefonu açınca İKİ mesaj alıyordu.
  // Bu yüzden: durum >= 2 (tek tik) ise mesaj GİTMİŞTİR, asla yeniden gönderme.
  const durumK = m ? (m.durum || 0) : 0;
  if (durumK >= 2) {
    // WhatsApp mesajı aldı. Alıcıya iletim (çift tik) gecikebilir; bu NORMAL, müdahale etme.
    return;
  }

  // Buraya geldiysek: tek tik BİLE yok (durum 0/1) -> WhatsApp mesajı hiç almamış olabilir.
  // Bu durumda yeniden göndermek GÜVENLİ (kopya oluşmaz, çünkü ilki hiç kaydedilmedi).
  console.log(`⚠️  İLETİM ONAYI GELMEDİ (${ILETIM_SURE / 1000}sn, tek tik bile yok): kişi=${(jid || '').split('@')[0]}, deneme=${deneme} -> aksiyon.`);

  // 1) Bağlantıyı şüpheli say -> hemen canlılık testi (ölüyse yeniden bağlan)
  if (lineId === 'ofis') {
    _sonWaAktivite = Date.now() - (80 * 1000);
    if (global._canlilikKontrolTetikle) { try { global._canlilikKontrolTetikle(true); } catch (_) {} }
  }

  // 2) Otomatik yeniden gönder (SADECE kişisel mesaj, limit dahilinde)
  if (deneme < ILETIM_MAX_DENEME && veri && veri.text) {
    setTimeout(async () => {
      const l = lines.get(lineId);
      if (!l || !l.sock || !l.connected) { iletimBasarisizBildir(lineId, jid, msgId, veri); return; }
      // SON KONTROL: bu 4sn içinde TEK TİK gelmiş olabilir -> mesaj gitmiş, tekrar GÖNDERME.
      // (durum>=2 yeterli; çift tik beklemek çift kopyaya yol açıyordu)
      const mm = chat ? chat.messages.find(x => x.id === msgId) : null;
      if (mm && (mm.durum || 0) >= 2) return; // WhatsApp aldı, tekrar gönderme
      try {
        const content = { text: veri.text };
        // MENTION: burada da GERÇEK jid kullan (LID sorunu — yukarıdaki send ile aynı mantık)
        const _rChat = chat;
        const _rUyeler = (_rChat && Array.isArray(_rChat.members)) ? _rChat.members : [];
        const mentionJids = [];
        for (const t of (veri.text.match(/@(\d{10,15})/g) || [])) {
          const num = t.slice(1);
          const uye = _rUyeler.find(mb => mb && (mb.number === num || String(mb.jid || '').startsWith(num + '@')));
          mentionJids.push(uye && uye.jid ? uye.jid : num + '@s.whatsapp.net');
        }
        if (mentionJids.length) content.mentions = mentionJids;
        const sent = await Promise.race([
          l.sock.sendMessage(jid, content),
          new Promise((_, rej) => setTimeout(() => rej(new Error('yeniden gonderim zaman asimi')), 12000)),
        ]);
        if (!sent || !sent.key) throw new Error('yeniden gonderim onaylanmadi');
        console.log(`   ↻ Kişisel mesaj otomatik yeniden gönderildi (deneme ${deneme + 1}): ${(jid || '').split('@')[0]}`);
        if (m) {
          m.id = sent.key.id; m.key = sent.key; m.raw = sent; m.durum = 2; m.gonderilemedi = false;
          broadcastHat(lineId, { type: 'msgYenidenGonderildi', jid, eskiId: msgId, yeniId: sent.key.id });
        }
        iletimDenetleBaslat(lineId, jid, sent.key.id, veri, deneme + 1);
      } catch (e) {
        console.log(`   ✗ Otomatik yeniden gönderim başarısız: ${e.message}`);
        iletimBasarisizBildir(lineId, jid, msgId, veri);
      }
    }, 4000);
  } else {
    iletimBasarisizBildir(lineId, jid, msgId, veri);
  }
}

function iletimBasarisizBildir(lineId, jid, msgId, veri) {
  const C = hatChats(lineId);
  const chat = C ? C.get(jid) : null;
  const m = chat ? chat.messages.find(x => x.id === msgId) : null;
  if (m) { m.durum = -1; m.gonderilemedi = true; }
  const grupAd = (chat && chat.name) || 'bir grup';
  const metin = (veri && veri.text) || '';
  // 1) GRUPTA kırmızı ünlem: o gruba bakan HERKES görür (mesaj kırmızı olur)
  broadcastHat(lineId, { type: 'msgStatus', jid, id: msgId, durum: -1 });
  // 2) KİŞİYE ÖZEL bildirim: mesajı YAZAN kişiye, hangi grupta/sayfada olursa olsun.
  //    Panelde kırmızı bildirim çıkar; açıklama yazar; basınca o gruba gider.
  const yazan = veri && veri.yazan;
  const bildirim = {
    type: 'iletimUyari', jid, id: msgId, grupAd, text: metin,
    mesaj: '⚠️ Bu mesaj karşıya İLETİLEMEDİ (onay gelmedi). Kontrol edip tekrar gönderin.',
  };
  if (yazan) {
    // sadece yazan kişinin açık panellerine gönder
    let ulasti = false;
    wss.clients.forEach((c) => {
      if (c.readyState === 1 && c._username === yazan) { try { c.send(JSON.stringify(bildirim)); ulasti = true; } catch (_) {} }
    });
    // yazan kişi o an çevrimdışıysa (panel kapalı): grup kırmızı zaten kaldı, girince görür.
    if (!ulasti) console.log(`   (iletim uyarısı: yazan '${yazan}' çevrimdışı -> grupta kırmızı kaldı, girince görecek)`);
  } else {
    // yazan bilinmiyorsa (eski/dosya) -> hatta bağlı herkese göster (güvenli taraf)
    broadcastHat(lineId, bildirim);
  }
}

// Grup metadata'sini onbellekten al (yoksa KUYRUK uzerinden cek). Rate-overlimit'i onler.
async function getGroupMeta(jid, maxYas = 30 * 60 * 1000, sock = null) {
  const cached = groupMetaCache.get(jid);
  // sadece GERCEK adi olan onbellegi kullan (sayi/bos onbellek tekrar denensin)
  if (cached && cached.meta?.subject && cached.meta.subject.trim() && (Date.now() - cached.ts) < maxYas) {
    return cached.meta;
  }
  // kuyruga koy, sonucu bekle. sock verildiyse O HATTIN soketiyle sorgulanir
  // (pazarlama gruplari icin kritik: ofis o gruba uye degilse ofis soketi goremez).
  return new Promise((resolve) => metaQueuePush(jid, resolve, sock));
}

// ============================================================
// KACAN MESAJ AKTIF CEKME KUYRUGU
// chats.update sinyali gelince ilgili sohbetin son mesajini WhatsApp'tan cekmeyi dener.
// 7500 grupta sistemi/WhatsApp'i bogmamak icin: KUYRUK + yavas isleme + tekrar engelleme.
// Onemli: Bu "best effort" (elinden geleni yapar) — cekemese bile sohbet zaten chats.update
// ile en uste cikmis ve okunmamis isaretlenmis olur, yani kullanici kacirmaz.
// ============================================================
const _mesajCekKuyruk = [];
const _mesajCekBekleyen = new Set(); // ayni sohbeti kuyruga 2 kez ekleme
let _mesajCekCalisiyor = false;

function mesajCekKuyruguEkle(jid) {
  if (!jid || _mesajCekBekleyen.has(jid)) return;
  _mesajCekBekleyen.add(jid);
  _mesajCekKuyruk.push(jid);
  if (!_mesajCekCalisiyor) mesajCekKuyruguIsle();
}

async function mesajCekKuyruguIsle() {
  if (_mesajCekCalisiyor) return;
  _mesajCekCalisiyor = true;
  while (_mesajCekKuyruk.length > 0) {
    const jid = _mesajCekKuyruk.shift();
    _mesajCekBekleyen.delete(jid);
    try {
      await mesajiAktifCek(jid);
    } catch (e) { /* sessizce gec — sohbet zaten en uste cikti */ }
    // WhatsApp'i yormamak icin her cekme arasi kisa bekleme (rate-limit korumasi)
    await new Promise(r => setTimeout(r, 600));
  }
  _mesajCekCalisiyor = false;
}

// Bir sohbetin son mesajlarini WhatsApp'tan cekmeyi dene.
// Baileys surumune gore fetchMessageHistory imzasi degisebilir; guvenli sekilde deniyoruz.
async function mesajiAktifCek(jid) {
  if (!waSock || !waConnected) return;
  const chat = chats.get(jid);
  if (!chat) return;
  // Bizde bu sohbetin EN SON mesaj key'i varsa, ondan sonrasini iste.
  // Yoksa cekme yapilamaz (Baileys baslangic noktasi ister) — sorun degil, sohbet zaten isaretli.
  const sonMesaj = chat.messages && chat.messages.length ? chat.messages[chat.messages.length - 1] : null;
  if (!sonMesaj || !sonMesaj.key) return;
  try {
    if (typeof waSock.fetchMessageHistory === 'function') {
      // (adet, baslangicKey, baslangicTs) — son mesajdan itibaren birkac mesaj iste
      await waSock.fetchMessageHistory(5, sonMesaj.key, sonMesaj.ts ? Math.floor(sonMesaj.ts / 1000) : undefined);
      // Gelen mesajlar normal messaging-history.set / messages.upsert akisindan dusecek,
      // oradan addMessage + DB + broadcast zaten calisir.
    }
  } catch (e) { /* desteklenmiyorsa veya hata olursa sessizce gec */ }
}

// KAÇAN MESAJ TELAFİSİ: bağlantı yeniden kurulunca, en son konuşulan aktif grupların
// son mesajlarını proaktif çek. Bağlantı ölüyken (yarı-açık) gelen ve WhatsApp'ın otomatik
// göndermediği mesajları (foto/belge dahil) telafi eder. Nazik: sadece en aktif 30 grup,
// aralarında bekleme ile (soketi boğmadan).
async function kacanMesajTelafi(sock) {
  if (!sock) return;
  try {
    // en son konuşulan gruplar önce (kopukluk sırasında oralarda mesaj gelmiş olabilir)
    const aktifler = Array.from(chats.values())
      .filter(c => c.isGroup && c.lastTs)
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
      .slice(0, 30); // en aktif 30 grup (hepsini çekmek soketi boğar)
    if (!aktifler.length) return;
    console.log(`🔄 Kaçan mesaj telafisi: ${aktifler.length} aktif grup kontrol ediliyor (kopukluk sırasında düşen mesajlar için)...`);
    let denendi = 0;
    for (const c of aktifler) {
      if (mesajTrafigiVar()) { await new Promise(r => setTimeout(r, 2000)); } // canlı trafik varsa bekle
      const sonMesaj = c.messages && c.messages.length ? c.messages[c.messages.length - 1] : null;
      if (!sonMesaj || !sonMesaj.key) continue;
      try {
        if (typeof sock.fetchMessageHistory === 'function') {
          await sock.fetchMessageHistory(3, sonMesaj.key, sonMesaj.ts ? Math.floor(sonMesaj.ts / 1000) : undefined);
          denendi++;
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 400)); // gruplar arası nazik bekleme
    }
    console.log(`   ✓ Telafi tamam: ${denendi} grubun son mesajları yeniden istendi (kaçanlar messages.upsert'ten düşecek)`);
  } catch (e) { console.log('⚠️ Kaçan mesaj telafisi hatası:', e.message); }
}
// Ayni anda binlerce sorgu yerine, kucuk partiler halinde aralarinda bekleyerek yazar.
let _siraliKaydetCalisiyor = false;
let _siraliKuyruk = [];
async function siraliKaydet(chatlar) {
  // kuyruga ekle (tekrarlari jid'e gore ele)
  const mevcutJidler = new Set(_siraliKuyruk.map(c => c.jid));
  for (const c of chatlar) { if (!mevcutJidler.has(c.jid)) _siraliKuyruk.push(c); }
  if (_siraliKaydetCalisiyor) return; // zaten calisiyor, kuyruga eklendi yeter
  _siraliKaydetCalisiyor = true;
  const PARTI = 20;       // her seferinde 20 grup yaz
  const BEKLE = 400;      // partiler arasi 400ms nefes (DB rahatlasin)
  try {
    while (_siraliKuyruk.length) {
      const parti = _siraliKuyruk.splice(0, PARTI);
      // partiyi sirayla yaz (paralel degil — havuzu doldurmasin)
      for (const chat of parti) {
        try { await db.saveChat(chat); } catch (e) {}
      }
      if (_siraliKuyruk.length) await new Promise(r => setTimeout(r, BEKLE));
    }
  } finally {
    _siraliKaydetCalisiyor = false;
  }
}

// ============================================================
// TOPLU AÇIKLAMA SENKRONU ("açıklamalar düşmüyor" KÖK çözümü)
// Her hattın (ofis + TÜM pazarlama) gruplarının güncel açıklama/ad/üye bilgisi
// TEK WhatsApp isteğiyle çekilir (grup başına ayrı sorgu YOK -> sistemi yormaz).
// Sadece LİSTEDE OLAN gruplar güncellenir (pazarlama izolasyonu korunur, grup EKLENMEZ).
// Değişenler 'ozetToplu' ile panellere parçalı yayınlanır (takılma yok).
// Bağlanınca + HER 4 DAKİKADA çalışır -> açıklamalar en geç 4dk içinde herkeste güncel;
// gruba girince zaten anlık tazeleme (aciklamaTazele) da var.
// ============================================================
// ════════════════════════════════════════════════════════════════════════════
// AÇIKLAMA MOTORU (KÖK ÇÖZÜM — "1-2 saat sonra durma" sorunu için)
// ────────────────────────────────────────────────────────────────────────────
// SORUN: Önceki sistemler "açıklama bir kez dolunca bir daha bakma" mantığındaydı;
//        başta çekiyor, sonra duruyordu. Ayrıca groupFetchAllParticipating çoğu
//        grupta 'desc' (açıklama) döndürmüyor -> açıklamalar hiç dolmuyordu.
// ÇÖZÜM: SÜREKLİ DÖNEN bir imleç. Her tur listedeki gruplardan bir PARÇA alır,
//        her biri için tek-grup groupMetadata çağırır (desc GÜVENİLİR gelir),
//        değişmişse yayar + DB'ye yazar. Liste bitince başa döner. HİÇ DURMAZ.
//        Dolu açıklamaları da periyodik tazeler -> açıklama değişirse yakalar.
//        Rate-limit'e nazik: küçük parçalar + aralarında bekleme. Kilit YOK
//        (imleç ile ilerler, takılma/kilitlenme imkansız).
// ════════════════════════════════════════════════════════════════════════════
const _aciklamaImlec = new Map();  // lineId -> son işlenen grup index'i
let _aciklamaMotorCalisiyor = false;

async function aciklamaMotorTur() {
  if (_aciklamaMotorCalisiyor) return; // aynı anda iki tur çalışmasın (ama kilit takılmaz, her 20sn tetiklenir)
  // MESAJ ÖNCELİĞİ: şu an mesaj trafiği varsa bu turu ATLA. Açıklama çekimi soketi meşgul
  // edip mesajları geciktirmesin. Trafik durunca (10sn) motor kaldığı yerden devam eder.
  if (mesajTrafigiVar()) return;
  _aciklamaMotorCalisiyor = true;
  try {
    for (const [lineId, line] of lines) {
      if (!line || !line.connected || !line.sock) continue;
      const C = hatChats(lineId);
      if (!C || !C.size) continue;
      // bu hattın gruplarını sırala (en son konuşulan önce -> aktif gruplar daha sık tazelenir)
      const gruplar = Array.from(C.values())
        .filter(c => c.isGroup)
        .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
      if (!gruplar.length) continue;
      // imleçten devam et (kaldığı yerden) — her tur sadece bir PARÇA işle
      let idx = _aciklamaImlec.get(lineId) || 0;
      if (idx >= gruplar.length) idx = 0; // liste bitti -> başa dön (sonsuz döngü)
      const PARCA = 15; // her turda 15 grup (20sn'de bir -> dakikada ~45 grup, ilk dolum hızlı)
      const degisenler = [];
      for (let k = 0; k < PARCA && idx < gruplar.length; k++, idx++) {
        const c = gruplar[idx];
        if (!line.connected) break;
        if (mesajTrafigiVar()) break; // mesaj geldi/gidiyor -> turu kes, mesaja öncelik ver
        let meta = null;
        try {
          // tek-grup sorgusu: desc GÜVENİLİR gelir. Kendi hattının soketiyle (ortak/ayrı gruplar).
          meta = await Promise.race([
            getGroupMeta(c.jid, 0, line.sock), // maxYas=0 -> her zaman taze çek (açıklama değişmişse yakala)
            new Promise((res) => setTimeout(() => res(null), 6000)),
          ]);
        } catch (_) { meta = null; }
        if (meta) {
          let d = false;
          if (meta.subject && meta.subject.trim() && c.name !== meta.subject.trim()) { c.name = meta.subject.trim(); d = true; }
          if (meta.desc !== undefined) {
            const yeni = (meta.desc || '').trim();
            if ((c.description || '') !== yeni) { c.description = yeni; d = true; }
          }
          const uye = meta.participants ? meta.participants.length : 0;
          if (uye && c.memberCount !== uye) { c.memberCount = uye; d = true; }
          if (d) {
            degisenler.push({ jid: c.jid, name: c.name, description: c.description || '', memberCount: c.memberCount || 0 });
            if (db.isReady()) db.saveChat(c, lineId).catch(() => {});
          }
        }
        await new Promise(r => setTimeout(r, 100)); // gruplar arası nazik bekleme (rate-limit'e saygı)
      }
      _aciklamaImlec.set(lineId, idx); // imleci kaydet (sonraki tur buradan devam)
      // değişenleri panellere yay
      if (degisenler.length) {
        broadcastHat(lineId, { type: 'ozetToplu', liste: degisenler });
      }
    }
  } catch (e) { console.log('⚠️ Açıklama motoru hatası:', e.message); }
  finally { _aciklamaMotorCalisiyor = false; }
}
// HER 20 SANİYEDE bir tur -> imleç sürekli ilerler, tüm gruplar sırayla tazelenir, HİÇ DURMAZ.
// (2000 grup varsa ~14 dakikada tüm liste bir kez taranır, sonra baştan; açıklama
//  değişiklikleri en geç bir tur içinde yakalanır. Dolu açıklamalar da tazelenir.)
setInterval(() => { aciklamaMotorTur().catch(() => {}); }, 20 * 1000);

// ── ESKİ toplu senkron: SADECE ad + üye sayısı için (hızlı, açıklama motoru ayrı hallediyor) ──
async function topluAciklamaSenkron(lineId) {
  const line = lines.get(lineId);
  const sock = line ? line.sock : null;
  const C = hatChats(lineId);
  if (!sock || !line || !line.connected || !C || !C.size) return;
  let groups;
  try { groups = await sock.groupFetchAllParticipating(); } catch (e) { return; }
  const girisler = Object.entries(groups || {});
  const degisenler = [];
  let i = 0;
  const isle = () => {
    const parca = girisler.slice(i, i + 200);
    for (const [jid, meta] of parca) {
      if (!jid.endsWith('@g.us')) continue;
      if (!C.has(jid)) continue;
      const c = C.get(jid);
      let d = false;
      const ad = (meta.subject && meta.subject.trim()) ? meta.subject.trim() : null;
      if (ad && c.name !== ad) { c.name = ad; d = true; }
      if (meta.desc !== undefined) {
        const yeniDesc = (meta.desc || '').trim();
        if ((c.description || '') !== yeniDesc) { c.description = yeniDesc; d = true; }
      }
      const uye = meta.participants ? meta.participants.length : 0;
      if (uye && c.memberCount !== uye) { c.memberCount = uye; d = true; }
      if (d) degisenler.push({ jid, name: c.name, description: c.description || '', memberCount: c.memberCount || 0 });
    }
    i += 200;
    if (i < girisler.length) { setImmediate(isle); return; }
    if (degisenler.length) {
      for (let j = 0; j < degisenler.length; j += 100) {
        broadcastHat(lineId, { type: 'ozetToplu', liste: degisenler.slice(j, j + 100) });
      }
      if (db.isReady()) {
        (async () => { for (const g of degisenler) { const c = C.get(g.jid); if (c) await db.saveChat(c, lineId).catch(() => {}); } })().catch(() => {});
      }
    }
  };
  isle();
}
// ad/üye senkronu: bağlanınca bir kez + her 5dk (açıklama motoru ayrı, 20sn'de dönüyor)
setInterval(() => {
  try { for (const [lid, line] of lines) { if (line && line.connected) topluAciklamaSenkron(lid); } } catch (_) {}
}, 5 * 60 * 1000);

// ============================================================
// OFİS AÇIKLAMA + FOTO TARAMASI ("hepsini anında çekmeli"nin motoru)
// Toplu sorgu çoğu grupta AÇIKLAMAYI HİÇ döndürmez; tek-grup sorgusu (groupMetadata)
// GÜVENİLİR getirir. Bu tarama: listedeki grupları EN SON KONUŞULANDAN başlayarak
// tek tek gezer; AÇIKLAMASI veya FOTOĞRAFI eksik olanları doldurur, panellere anında
// yayınlar ve DB'ye KALICI kaydeder (sonraki açılışlarda hazır gelir). Nazik tempoda
// çalışır (rate-limit'e uyar), dolu olanları atlar -> sistemi/WhatsApp'ı yormaz.
// ============================================================
let _aciklamaTaramaCalisiyor = false;
let _aciklamaTaramaBaslangic = 0;
// NOT: Açıklama artık yeni "aciklamaMotorTur" tarafından sürekli tazeleniyor.
// Bu fonksiyon SADECE grup FOTOĞRAFLARINI dolduruyor (foto ayrı bir iş, motor sadece metin).
async function ofisAciklamaTaramasi() {
  if (_aciklamaTaramaCalisiyor) {
    if (Date.now() - _aciklamaTaramaBaslangic > 3 * 60 * 1000) { _aciklamaTaramaCalisiyor = false; }
    else return;
  }
  const line = lines.get('ofis');
  if (!line || !line.connected) return;
  _aciklamaTaramaCalisiyor = true;
  _aciklamaTaramaBaslangic = Date.now();
  try {
    const gruplar = Array.from(chats.values())
      .filter(c => c.isGroup)
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    // GRUP FOTOĞRAFLARI (eksik olanları doldur — açıklama motoru ayrı çalışıyor)
    let fotoAlinan = 0;
    for (const c of gruplar) {
      if (!line.connected) break;
      if (mesajTrafigiVar()) break; // mesaj trafiği var -> foto taramasını kes, mesaja öncelik
      if (!(c.avatar === undefined || c.avatar === null)) continue; // '' = "sorduk, yok"
      try {
        const av = await Promise.race([
          getAvatar(c.jid),
          new Promise((_, rej) => setTimeout(() => rej(new Error('yavas')), 2500)),
        ]);
        c.avatar = av || '';
        if (av) {
          fotoAlinan++;
          broadcastHat('ofis', { type: 'msgUpdate', jid: c.jid, ozet: { name: c.name, description: c.description || '', memberCount: c.memberCount || 0, avatar: av } });
          if (db.isReady()) db.saveChat(c, 'ofis').catch(() => {});
        }
      } catch (_) { /* zaman aşımı: damgasız bırak, sonraki tur dener */ }
      await new Promise(r => setTimeout(r, 60));
    }
    if (fotoAlinan) console.log(`🔎 Grup fotoğrafı taraması: ${fotoAlinan} yeni foto alındı`);
  } catch (e) { console.log('⚠️ Foto taraması hatası:', e.message); }
  finally { _aciklamaTaramaCalisiyor = false; }
}
// Grup fotoğrafları: bağlanınca + her 15 dakikada eksikleri doldur
setInterval(() => { try { ofisAciklamaTaramasi(); } catch (_) {} }, 15 * 60 * 1000);

async function fetchAllGroups() {
  // Bu fonksiyon SADECE ofis hatti icindir. Global waSock yerine ofis hattinin
  // kendi soketini kullan — yoksa iki hat acikken Volkan'in soketiyle calisip karisir.
  const ofisLine = lines.get('ofis');
  const ofisSock = ofisLine ? ofisLine.sock : waSock;
  if (!ofisSock || !ofisLine || !ofisLine.connected) return;
  try {
    const groups = await ofisSock.groupFetchAllParticipating(); // { jid: metadata }
    let guncellenen = 0;
    for (const [jid, meta] of Object.entries(groups || {})) {
      if (!jid.endsWith('@g.us')) continue;
      const gercekAd = meta.subject && meta.subject.trim() ? meta.subject.trim() : null;
      const uyeSayisi = meta.participants?.length || 0;
      // Grup ADINI her zaman bellege al (isim cozumlemesi + mesaj gelince hemen dogru ad icin).
      // Bu, grubu LISTEYE eklemez — sadece adini hatirlar.
      if (gercekAd) grupAdlari.set(jid, gercekAd);
      // Grup ZATEN listedeyse (yani mesaji varsa) adini/uye sayisini guncelle.
      // Listede DEGILSE EKLEME — kullanici "bos/olu gruplar gorunmesin, mesaj geldikce eklensin" dedi.
      if (chats.has(jid)) {
        const chat = chats.get(jid);
        if (gercekAd) chat.name = gercekAd;
        if (uyeSayisi) chat.memberCount = uyeSayisi;
        // ACIKLAMA: toplu sorguda desc COGU grupta HIC GELMEZ (undefined = bilinmiyor).
        // undefined ise DOKUNMA (eski hata: bilinmiyor'u "bos" sanip dolu aciklamayi siliyordu).
        // Alan geldiyse ('' dahil) gercek durumdur -> uygula (gercek silinme yansir).
        if (meta.desc !== undefined) {
          chat.description = (meta.desc && meta.desc.trim()) ? meta.desc.trim() : '';
        }
        guncellenen++;
      }
    }
    hafifChatsYayinla('ofis', chats);
    console.log(`👥 Grup adlari alindi: ${grupAdlari.size} grup adi bellekte, ${guncellenen} aktif grup guncellendi`);
    // ID'de (sayi) kalmis listedeki gruplari grupAdlari'ndan duzelt
    let duzeltilen = 0;
    for (const ch of chats.values()) {
      if (ch.isGroup && /^\d+$/.test(ch.name || '') && grupAdlari.has(ch.jid)) {
        ch.name = grupAdlari.get(ch.jid);
        duzeltilen++;
      }
    }
    // TEK toplu broadcast (eskiden her grup icin ayri broadcast vardi -> panel yavasliyordu)
    if (duzeltilen) {
      console.log(`   🔤 ${duzeltilen} grubun adi ID'den gercek ada duzeltildi`);
      hafifChatsYayinla('ofis', chats);
    }
    broadcastHat('ofis', { type: 'syncStatus', done: true, chatCount: chats.size });
    // SADECE listedeki (mesaji olan) gruplari DB'ye yaz — tum 7547'yi degil (hiz icin).
    if (db.isReady()) {
      const yazilacaklar = Array.from(chats.values()).filter(c => c.isGroup);
      if (yazilacaklar.length) siraliKaydet(yazilacaklar);
    }
  } catch (e) {
    console.error('Gruplar cekilemedi:', e.message);
  }
}

// Bir mesajin kisa onizlemesi (yanit alintisinda gosterilir)
function replyPreview(m) {
  if (m.kind === 'image') return '📷 Fotograf';
  if (m.kind === 'audio') return '🎤 Sesli mesaj';
  if (m.kind === 'video') return '🎬 Video';
  if (m.kind === 'document') return '📄 ' + (m.text || 'Belge');
  return m.text || '';
}

// RAW olmadan alinti (quoted) nesnesi insa et.
// DB'den yuklenen mesajlarda tam ham veri (raw) yok ama key var.
// Baileys'in alinti icin bekledigi minimal yapi: { key, message }.
// Mesajin tipine gore uygun message govdesi olusturuyoruz.
function insaQuotedMesaj(orig) {
  if (!orig || !orig.key) return null;
  // key icinde en az id olmali
  if (!orig.key.id) return null;
  let message;
  const metin = orig.text || orig.caption || '';
  if (orig.kind === 'image') {
    message = { imageMessage: { caption: orig.caption || '' } };
  } else if (orig.kind === 'video') {
    message = { videoMessage: { caption: orig.caption || '' } };
  } else if (orig.kind === 'audio') {
    message = { audioMessage: {} };
  } else if (orig.kind === 'document') {
    message = { documentMessage: { fileName: orig.fileName || orig.text || 'belge', caption: orig.caption || '' } };
  } else {
    // metin mesaji (en yaygin)
    message = { conversation: metin || ' ' };
  }
  return { key: orig.key, message };
}

// Sohbete SISTEM mesaji ekle (grup adi/aciklamasi degisti gibi bilgi satirlari).
// WhatsApp tarzi: ortada kucuk gri bilgi yazisi. DB'ye de kaydedilir (kalici).
function sistemMesajiEkle(jid, metin) {
  const chat = chats.get(jid);
  if (!chat) return;
  const now = Date.now();
  const m = {
    id: 'sys_' + now + '_' + Math.random().toString(36).slice(2, 7),
    kind: 'system',
    text: metin,
    fromMe: false,
    sender: '',
    time: nowTime(),
    ts: now,
  };
  chat.messages.push(m);
  chat.lastTs = now;
  chat.lastTime = m.time;
  if (db.isReady()) db.saveMessage(jid, m).catch(() => {});
}

// Bir hattin chats Map'ini dondur. lineId verilmezse veya 'ofis' ise GLOBAL chats
// (eski sistem — geriye uyumlu). Pazarlama hatlari icin o hattin kendi chats'i.
function hatChats(lineId) {
  if (!lineId || lineId === 'ofis') return chats; // ofis = mevcut global (degismedi)
  const line = lines.get(lineId);
  return line ? line.chats : chats; // hat yoksa guvenli sekilde global'e dus
}

function addMessage(jid, message, meta = {}, lineId = 'ofis') {
  const now = Date.now();
  message.ts = now; // gercek zaman damgasi (siralama icin)
  const C = hatChats(lineId); // bu hattin sohbetleri (ofis ise global chats)
  // AYNI mesaj iki kez eklenmesin (gonderdigimiz mesaji WhatsApp geri yansitir -> cift kayit)
  if (message.id && C.has(jid)) {
    const varolan = C.get(jid).messages.find(x => x.id === message.id);
    if (varolan) {
      // zaten var: sadece eksik bilgileri guncelle (orn. key, mediaUrl), tekrar EKLEME
      let degisti = false;
      if (message.key && !varolan.key) { varolan.key = message.key; degisti = true; }
      if (message.mediaUrl && !varolan.mediaUrl) { varolan.mediaUrl = message.mediaUrl; degisti = true; }
      if (message.thumb && !varolan.thumb) { varolan.thumb = message.thumb; degisti = true; }
      // COZULME: var olan mesaj sifresi cozulemeyen placeholder ise ve simdi gercek
      // icerik (text/medya) geldiyse, onu GUNCELLE (ekrandaki "cozulemedi" yazisi kalksin).
      if (varolan.kind === 'undecryptable' && message.kind && message.kind !== 'undecryptable' && message.kind !== 'skip') {
        varolan.kind = message.kind;
        if (message.text) varolan.text = message.text;
        if (message.contact) varolan.contact = message.contact;
        if (message.contacts) varolan.contacts = message.contacts;
        degisti = true;
        console.log(`🔓 cozulemeyen mesaj upsert ile cozuldu: ${String(message.id).substring(0,12)} -> ${message.kind}`);
      }
      // Eksik bilgi sonradan geldiyse (orn. medya arka planda indi): panele + DB'ye yansit
      if (degisti) {
        // HAFIF: tum sohbeti degil, sadece GUNCELLENEN mesaji gonder (medya/cozulme guncellemesi)
        broadcastHat(lineId, { type: 'msgUpdate', jid, mesaj: stripBirMesaj(varolan) });
        if (db.isReady()) db.saveMessage(jid, varolan, lineId).catch(() => {});
      }
      return; // cift eklemeyi onle
    }
  }
  if (!C.has(jid)) {
    // Yeni grup ilk mesajla ekleniyor: adini once meta'dan, yoksa grupAdlari belleginden
    // (fetchAllGroups doldurdu), o da yoksa gecici olarak ID'den al (sonra duzelir).
    const grupAdi = jid.endsWith('@g.us') ? (meta.name || grupAdlari.get(jid) || jid.split('@')[0]) : (meta.name || jid.split('@')[0]);
    C.set(jid, {
      jid,
      name: grupAdi,
      isGroup: jid.endsWith('@g.us'),
      description: meta.description || '',
      avatar: meta.avatar || null,
      memberCount: meta.memberCount || 0,
      members: meta.members || [],
      messages: [],
      unread: 0,
      lastTime: message.time,
      lastTs: now,
    });
  }
  const chat = C.get(jid);
  if (meta.name) chat.name = meta.name;
  if (meta.description !== undefined) chat.description = meta.description;
  if (meta.avatar !== undefined && meta.avatar !== null) chat.avatar = meta.avatar;
  if (meta.memberCount) chat.memberCount = meta.memberCount;
  if (meta.members) chat.members = meta.members;
  chat.messages.push(message);
  // BELLEK OPTIMIZASYONU (40 kullanici): her sohbette bellekte en fazla 400 mesaj tut.
  // Daha eskiler bellekten dusurulur (DB'de KALIR — sohbet acilinca oradan yuklenir).
  // 400 mesaj = yogun bir grupta bile rahat 2 hafta gerisini kapsar.
  if (chat.messages.length > 400) {
    chat.messages = chat.messages.slice(-400);
  }
  chat.lastTime = message.time;
  chat.lastTs = now;
  if (!message.fromMe) { chat.unread++; chat.ozelUnread = (chat.ozelUnread || 0) + 1; chat.muhUnread = (chat.muhUnread || 0) + 1; }
  // beni etiketleyen okunmamis mesaj geldiyse isaretle
  if (meta.mentionsMe) chat.hasMention = true;
  // HAFIF YAYIN: 60 mesaj yerine sadece bu yeni mesaji gonder (trafik ~40x az -> aninda gider).
  broadcastYeniMesaj(lineId, jid, chat, message);
  // Supabase'e kaydet (arka planda, mesaji bekletmez)
  // AMA gonderilemeyen mesaji (durum:-1) DB'ye YAZMA — gitmedi, kalici olmamali.
  // (Kullanici silince veya yenileyince kaybolsun; DB'de "hayalet hata mesaji" kalmasin.)
  if (db.isReady() && message.durum !== -1 && !message.gonderilemedi) {
    db.saveChat(chat, lineId).catch((e) => { if (!global._saveChatHataLog) { global._saveChatHataLog = true; console.log('⚠️  saveChat HATASI (ilk): ' + e.message); } });
    db.saveMessage(jid, message, lineId).catch((e) => { if (!global._saveMsgHataLog) { global._saveMsgHataLog = true; console.log('⚠️  saveMessage HATASI (ilk): ' + e.message); } });
  }
}

// Tek bir mesaji panele gondermeye hazirla (raw+key cikar).
function stripBirMesaj(m) {
  const { raw, key, ...rest } = m;
  return rest;
}
// HAFIF YAYIN: tum sohbeti (60 mesaj) degil, SADECE tek yeni mesaji + sohbet ozetini gonderir.
// Boylece yogun saatte trafik ~40 kat azalir -> mesajlar ANINDA gider, yigilma olmaz.
// prevId: bu mesajdan onceki mesajin id'si. Panel, kendi son mesaji != prevId ise BIR MESAJ
// KACIRDIGINI anlar ve o sohbet icin tam senkron (syncChat) ister -> hicbir mesaj EKSIK kalmaz.
function broadcastYeniMesaj(lineId, jid, chat, mesaj) {
  // mesajdan onceki mesajin id'si (eksik tespiti icin)
  const idx = chat.messages.findIndex(x => x.id === mesaj.id);
  const prevId = idx > 0 ? (chat.messages[idx - 1].id || null) : null;
  broadcastHat(lineId, {
    type: 'msgAppend',
    jid,
    prevId,
    mesaj: stripBirMesaj(mesaj),
    // sohbet ozeti (liste guncellemesi icin — agir mesaj listesi GITMEZ)
    ozet: {
      name: chat.name,
      isGroup: chat.isGroup,
      description: chat.isGroup ? (chat.description || '') : '',
      avatar: chat.avatar || null,
      memberCount: chat.memberCount || 0,
      lastTime: chat.lastTime,
      lastTs: chat.lastTs,
      unread: chat.unread || 0,
      ozelUnread: chat.ozelUnread || 0,
      muhUnread: chat.muhUnread || 0,
      hasMention: chat.hasMention || false,
      customName: chat.customName,
      atananlar: chatAssignments.get(jid) || [],
      etiketler: chatLabels.get(jid) || [],
    },
  });
}

// raw + key (buyuk/hassas alanlar) panele gonderilmez — sadece sunucuda tutulur
// limit: normal mesaj akisinda 60 (trafik az), sohbet ACILISINDA 300 (eski mesajlar gorunur).
function stripRaw(chat, limit = 60) {
  const recent = chat.messages.length > limit ? chat.messages.slice(-limit) : chat.messages;
  return {
    ...chat,
    // ACIKLAMA her zaman TANIMLI gitsin: undefined ise panel "eskisini koru" deyip
    // baska grubun aciklamasini gosteriyordu. Grup ise mevcut deger veya '', grup degilse ''.
    description: (chat.isGroup ? (chat.description || '') : ''),
    messages: recent.map(({ raw, key, ...rest }) => rest),
    atananlar: chatAssignments.get(chat.jid) || [], // bu gruba atanan ekip uyeleri
    etiketler: chatLabels.get(chat.jid) || [],      // bu gruba bagli etiket id'leri
  };
}

// ============================================================
// TAKILMA ONLEME (3-4 sn donmalarin cozumu):
// Eskiden panel her baglandiginda 2000+ sohbet x 60 mesaj TEK pakette
// hazirlaniyordu (~32MB, ~1.5-4sn). Bu surede Node KILITLENIR: mesaj islenmez,
// fotograf panele dusmez, aciklama cekilemez. Cozum iki katman:
//  1) HAFIF sohbet: liste icin sadece SON 1 mesaj gider (onizleme). Panel
//     sohbeti ACINCA syncChat ile 300 mesaji ayrica ceker (tek sohbet, kucuk).
//  2) PARCALI gonderim: 400'erlik parcalar, aralarinda setImmediate ->
//     event loop nefes alir, akan mesajlar/istekler islenmeye devam eder.
// Olcum: 1435ms tek bloke -> max 11ms parca; 32MB -> 1.3MB.
// ============================================================
function stripHafif(chat) {
  const son = chat.messages.length
    ? [(({ raw, key, ...rest }) => rest)(chat.messages[chat.messages.length - 1])]
    : [];
  return {
    ...chat,
    description: (chat.isGroup ? (chat.description || '') : ''),
    messages: son,
    _hafif: true, // panel bunu gorunce sohbet acilinca tam listeyi ister
    atananlar: chatAssignments.get(chat.jid) || [],
    etiketler: chatLabels.get(chat.jid) || [],
  };
}
const HAFIF_PARCA = 400; // her pakette kac sohbet
// TEK panele parcali gonder (merhaba/baglanis icin)
function hafifChatsGonder(ws, C) {
  const arr = Array.from(C.values());
  let i = 0;
  const gonder = () => {
    if (!ws || ws.readyState !== 1) return; // panel kapandiysa birak
    const parca = arr.slice(i, i + HAFIF_PARCA).map(stripHafif);
    try { ws.send(JSON.stringify({ type: 'chats', chats: parca, append: i > 0 })); } catch (_) { return; }
    i += HAFIF_PARCA;
    if (i < arr.length) setImmediate(gonder);
  };
  gonder();
}
// Bir hattin TUM panellerine parcali yayinla (toplu guncellemeler icin)
function hafifChatsYayinla(lineId, C) {
  const arr = Array.from(C.values());
  let i = 0;
  const gonder = () => {
    const parca = arr.slice(i, i + HAFIF_PARCA).map(stripHafif);
    broadcastHat(lineId, { type: 'chats', chats: parca, append: i > 0 });
    i += HAFIF_PARCA;
    if (i < arr.length) setImmediate(gonder);
  };
  gonder();
}

// Mesajin tipini ve metnini coz
function describeMessage(m) {
  let msg = m.message || {};

  // senderKeyDistributionMessage cogu zaman ASIL mesajin yaninda gelir (grup sifrelemesi).
  // Onu yok sayip kalan gercek icerige bakalim.
  if (msg.senderKeyDistributionMessage) {
    const rest = { ...msg };
    delete rest.senderKeyDistributionMessage;
    delete rest.messageContextInfo;
    // baska bir icerik kaldiysa onu kullan, yoksa bu sadece teknik mesajdir -> atla
    if (Object.keys(rest).length === 0) return { kind: 'skip' };
    msg = rest;
  }

  // Ic ice sarmalanmis mesajlari ac (kaybolan mesaj, tek-seferlik, cihaz mesaji vs.)
  let guard = 0;
  while (guard++ < 5) {
    if (msg.ephemeralMessage?.message) { msg = msg.ephemeralMessage.message; continue; }
    if (msg.viewOnceMessage?.message) { msg = msg.viewOnceMessage.message; continue; }
    if (msg.viewOnceMessageV2?.message) { msg = msg.viewOnceMessageV2.message; continue; }
    if (msg.viewOnceMessageV2Extension?.message) { msg = msg.viewOnceMessageV2Extension.message; continue; }
    if (msg.deviceSentMessage?.message) { msg = msg.deviceSentMessage.message; continue; }
    if (msg.documentWithCaptionMessage?.message) { msg = msg.documentWithCaptionMessage.message; continue; }
    if (msg.editedMessage?.message) { msg = msg.editedMessage.message; continue; }
    if (msg.associatedChildMessage?.message) { msg = msg.associatedChildMessage.message; continue; }
    if (msg.botInvokeMessage?.message) { msg = msg.botInvokeMessage.message; continue; }
    // secretEncryptedMessage: WhatsApp'in yeni nesil sarmalayicisi (etkinlik/ozel mesaj).
    // Gercek icerik bazen icinde bir 'message' alaninda gelir; varsa onu ac.
    if (msg.secretEncryptedMessage?.message) { msg = msg.secretEncryptedMessage.message; continue; }
    // bazi surumlerde gercek icerik 'targetMessage' altinda olabilir
    if (msg.secretEncryptedMessage?.targetMessage?.message) { msg = msg.secretEncryptedMessage.targetMessage.message; continue; }
    // sarmalama sonrasi tekrar senderKey cikarsa onu da temizle
    if (msg.senderKeyDistributionMessage && Object.keys(msg).filter(k => k !== 'senderKeyDistributionMessage' && k !== 'messageContextInfo').length > 0) {
      const r = { ...msg }; delete r.senderKeyDistributionMessage; delete r.messageContextInfo; msg = r; continue;
    }
    break;
  }

  if (msg.conversation) return { kind: 'text', text: msg.conversation };
  if (msg.extendedTextMessage?.text) return { kind: 'text', text: msg.extendedTextMessage.text };
  // FOTO/VIDEO: WhatsApp'ta gorsele yazilan not (caption). Hem text hem caption alanina
  // koyariz; boylece panel (albüm caption'i icin caption'a bakar, eski kod text'e bakar) ikisini de bulur.
  if (msg.imageMessage) { const c = msg.imageMessage.caption || ''; return { kind: 'image', text: c, caption: c }; }
  if (msg.videoMessage) { const c = msg.videoMessage.caption || ''; return { kind: 'video', text: c, caption: c }; }
  if (msg.audioMessage) return { kind: 'audio', text: '' };
  // BELGE: dosya adi + (varsa) ACIKLAMA metni (caption). WhatsApp'ta belgeye yazilan not
  // documentMessage.caption'da VEYA documentWithCaptionMessage sarmalayicisinda gelir.
  if (msg.documentWithCaptionMessage?.message?.documentMessage) {
    const dm = msg.documentWithCaptionMessage.message.documentMessage;
    return { kind: 'document', text: dm.fileName || 'Belge', caption: dm.caption || '', _fileName: dm.fileName || '', _mime: dm.mimetype || '' };
  }
  if (msg.documentMessage) {
    return { kind: 'document', text: msg.documentMessage.fileName || 'Belge', caption: msg.documentMessage.caption || '', _fileName: msg.documentMessage.fileName || '', _mime: msg.documentMessage.mimetype || '' };
  }
  if (msg.stickerMessage) return { kind: 'sticker', text: '' };
  // Yaygin diger tipler
  if (msg.locationMessage) {
    const lat = msg.locationMessage.degreesLatitude, lng = msg.locationMessage.degreesLongitude;
    return { kind: 'text', text: '📍 Konum: ' + lat + ', ' + lng };
  }
  if (msg.contactMessage) {
    const name = msg.contactMessage.displayName || '';
    const vcard = msg.contactMessage.vcard || '';
    const phoneMatch = vcard.match(/waid=(\d+)/) || vcard.match(/TEL[^:]*:([+\d\s()-]+)/i);
    let phone = '';
    if (phoneMatch) phone = phoneMatch[1].replace(/[^\d]/g, '');
    return { kind: 'contact', text: name, _contact: { name, phone } };
  }
  if (msg.contactsArrayMessage) {
    const arr = msg.contactsArrayMessage.contacts || [];
    const list = arr.map(ct => {
      const vcard = ct.vcard || '';
      const pm = vcard.match(/waid=(\d+)/) || vcard.match(/TEL[^:]*:([+\d\s()-]+)/i);
      return { name: ct.displayName || '', phone: pm ? pm[1].replace(/[^\d]/g, '') : '' };
    });
    return { kind: 'contacts', text: arr.length + ' kisi', _contacts: list };
  }
  if (msg.pollCreationMessage || msg.pollCreationMessageV3) {
    const p = msg.pollCreationMessage || msg.pollCreationMessageV3;
    return { kind: 'text', text: '📊 Anket: ' + (p.name || '') };
  }
  // Albüm (toplu fotograf/video gonderimi) - bir sarmalayici.
  // Icindeki foto/videolar ayri mesajlar olarak ZATEN gelir, o yuzden albumun kendisini atla.
  if (msg.albumMessage) {
    return { kind: 'skip' };
  }
  // Canli konum paylasimi
  if (msg.liveLocationMessage) {
    return { kind: 'text', text: '📍 Canlı konum paylaşıldı' };
  }
  // Reaksiyon (bir mesaja emoji ile tepki)
  if (msg.reactionMessage) {
    const emoji = msg.reactionMessage.text || '';
    return { kind: 'reaction', text: emoji, _reactKey: msg.reactionMessage.key };
  }
  // Taninmayan tip
  const keys = Object.keys(msg).filter(k => k !== 'messageContextInfo');
  const realType = keys[0] || 'bos-mesaj';
  // Gercek icerik tasimayan teknik/sistem mesajlari - kullaniciya gosterme
  const skipTypes = [
    'protocolMessage', 'senderKeyDistributionMessage', 'associatedChildMessage',
    'messageContextInfo', 'reactionMessage', 'pollUpdateMessage', 'keepInChatMessage',
    'deviceSentMessage', 'botInvokeMessage', 'encReactionMessage', 'pinInChatMessage',
    'pollResultSnapshotMessage', 'eventCoverImage', 'statusMentionMessage',
    // secretEncryptedMessage: yukaridaki dongude acilamadiysa (gercekten sifreli/ic
    // icerik okunamadi) — kafa karistiran "sifresi cozulemedi" yerine SESSIZCE atla.
    // Bu tip mesajin gercek hali cogunlukla ayri bir mesaj olarak zaten gelir.
    'secretEncryptedMessage',
  ];
  if (keys.length === 0 || skipTypes.includes(realType)) {
    // TESHIS: boş mesaj mı yoksa bilinen teknik mesaj mı? (kaçan mesajı yakalamak için)
    if (keys.length === 0) {
      console.log('⚠️  BOŞ MESAJ (decrypt henüz olmamış olabilir) — messages.update ile düzeltme beklenecek');
    }
    return { kind: 'skip' };
  }
  console.log('⚠️  DESTEKLENMEYEN MESAJ TİPİ:', JSON.stringify(keys), '| realType:', realType);
  // Sifreleme/anahtar sorunu olan mesajlar icin kullanici dostu aciklama
  return { kind: 'undecryptable', text: 'Bu mesajın şifresi çözülemedi. Gönderenin mesajı tekrar göndermesini isteyebilirsin.' };
}

// Sessiz logger (Baileys'in beklediği formatta) — console logger stream hatasi firlatabiliyor
const silentLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: () => {}, debug: () => {}, info: () => {},
  warn: () => {}, error: () => {}, fatal: () => {},
};

// Profil fotosu onbellegi (her seferinde cekmemek icin)
const avatarCache = new Map(); // jid -> url | null
// Kisi isimleri onbellegi (uye listesi + etiketleme icin)
const contactNames = new Map(); // jid -> isim (pushName veya rehber)
const savedContacts = new Map(); // jid -> SADECE telefon rehberine kayitli isim
// PANEL KULLANICILARI (ekip üyeleri) — displayName'leri normalize edilmiş halde tutar.
// Performans/aktivite SADECE gerçek ekip üyeleri için sayılsın diye kullanılır.
// (Müşteri/rastgele kayıtlı kişi sayılmaz.) Periyodik güncellenir.
const panelKullaniciAdlari = new Set(); // normalize edilmiş displayName + username
function _normAd(s){ return (s||'').toLocaleLowerCase('tr').replace(/i̇/g,'i').replace(/ı/g,'i').replace(/İ/g,'i').replace(/ş/g,'s').replace(/ğ/g,'g').replace(/ü/g,'u').replace(/ö/g,'o').replace(/ç/g,'c').replace(/\s+/g,' ').trim(); }
async function panelKullanicilariYenile(){
  try{
    const users = await db.listUsers();
    panelKullaniciAdlari.clear();
    for(const u of (users||[])){
      if(u.display_name) panelKullaniciAdlari.add(_normAd(u.display_name));
      if(u.username) panelKullaniciAdlari.add(_normAd(u.username));
    }
  }catch(e){}
}
// bir kişi adı panel kullanıcısı (ekip üyesi) mı?
function ekipUyesiMi(ad){ return ad ? panelKullaniciAdlari.has(_normAd(ad)) : false; }
// başlangıçta + her 2 dakikada bir kullanıcı listesini tazele
panelKullanicilariYenile();
setInterval(panelKullanicilariYenile, 120000);
const groupMetaCache = new Map(); // grup jid -> { meta, ts } (tekrar tekrar cekmeyi onler)
// LID -> gercek numara (PN) esleme onbellegi
const lidToPn = new Map(); // '...@lid' -> '...@s.whatsapp.net'
// Grup adlari (jid -> ad). fetchAllGroups ile doldurulur; grubu listeye EKLEMEDEN
// adini hatirlamak icin. Mesaj gelince yeni grup eklenirken dogru ad hemen kullanilir.
const grupAdlari = new Map();
// Gruba ATAMA: chat_jid -> [username, ...] (hangi ekip uyeleri bu grupla ilgileniyor)
// Supabase'den acilista yuklenir, degisince oraya yazilir.
const chatAssignments = new Map();
// ETIKETLER: labels = [{id,name,color}], chatLabels = chat_jid -> [labelId,...]
let labels = [];
const chatLabels = new Map();

// Grup adi/aciklamasi degisiminde sistem mesaji EKLENSIN mi?
// Sunucu yeni acildiginda WhatsApp GECMIS tum grup degisikliklerini birden gonderir
// (senkron). Bunlari "yeni degisti" sanip panele doldurmamak icin: acilistan sonra
// kisa bir sure (isinma) sistem mesaji EKLEME. Sure dolunca gercek CANLI degisiklikler eklenir.
let grupDegisimCanli = false;
function grupDegisimCanliyiAc() {
  // her baglanti acilisindan 35sn sonra canli moda gec (senkron bitmis olur)
  grupDegisimCanli = false;
  setTimeout(() => { grupDegisimCanli = true; console.log('✅ grup degisim bildirimleri artik CANLI (gecmis senkron bitti)'); }, 35000);
}

// Kisi sohbeti jid'ini tek standart forma getir (ayni kisi = tek sohbet)
// lineId: hangi hattin numarasini "kendi numaram" sayacagiz. Ofis -> global myNumber,
//         pazarlama -> o hattin kendi numarasi (line.myNumber). Bu KRITIK: yoksa ofis
//         Volkan'a yazinca, Volkan'in hatti gelen mesaji "kendine mesaj" sanip fromMe gibi gosterir.
function normalizeChatJid(jid, m, lineId = 'ofis') {
  if (!jid) return jid;
  // bu hattin kendi numarasi (kendine mesaj tespiti icin)
  const benimNumaram = lineId === 'ofis' ? myNumber : (lines.get(lineId)?.myNumber || null);
  // Kendine mesaj: senin numaranin her varyasyonu tek jid olsun
  if (benimNumaram) {
    const num = jid.split('@')[0];
    if (num === benimNumaram) return benimNumaram + '@s.whatsapp.net';
  }
  // LID ise gercek numaraya cevirmeyi dene (birden cok yoldan)
  if (jid.endsWith('@lid')) {
    const alt = m?.key?.remoteJidAlt || m?.key?.participantAlt || m?.key?.remoteJidPn || null;
    const r = resolvePhone(jid, alt);
    if (!r.isLid && r.jid && r.jid.endsWith('@s.whatsapp.net')) return r.jid; // cozulduyse normal numara
    // onbellekte eslesme var mi? (resolvePhone disinda son bir kontrol)
    if (lidToPn.has(jid)) {
      const pn = lidToPn.get(jid);
      if (pn && pn.endsWith('@s.whatsapp.net')) return pn;
    }
    return jid; // cozulemezse LID kalsin
  }
  // @s.whatsapp.net disindaki kucuk varyasyonlari standarda cek
  if (jid.endsWith('@s.whatsapp.net')) return jid;
  if (jid.endsWith('@c.us')) return jid.split('@')[0] + '@s.whatsapp.net';
  return jid;
}

// Iki sohbeti birlestir: LID'li sohbet, numara cozulunce numara sohbetine tasinir.
// Boylece ayni kisi 2-3 kez gorunmez, tek sohbette toplanir.
function sohbetleriBirlestir(lidJid, numaraJid) {
  if (lidJid === numaraJid) return;
  const lidChat = chats.get(lidJid);
  const numChat = chats.get(numaraJid);
  if (!lidChat) return; // birlestirilecek LID sohbeti yok
  if (!numChat) {
    // numara sohbeti yoksa: LID sohbetini numaraya tasi (jid degistir)
    lidChat.jid = numaraJid;
    chats.set(numaraJid, lidChat);
    chats.delete(lidJid);
    broadcastHat('ofis', { type: 'chatMerged', oldJid: lidJid, newJid: numaraJid });
    broadcastHat('ofis', { type: 'message', jid: numaraJid, chat: stripRaw(lidChat) });
    return;
  }
  // her iki sohbet de varsa: mesajlari birlestir (id'ye gore tekrarsiz)
  const mevcutIdler = new Set(numChat.messages.map(x => x.id));
  for (const msg of lidChat.messages) {
    if (!mevcutIdler.has(msg.id)) numChat.messages.push(msg);
  }
  // zamana gore sirala
  numChat.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  // son 200 ile sinirla
  if (numChat.messages.length > 200) numChat.messages = numChat.messages.slice(-200);
  // okunmamis + son zaman guncelle
  numChat.unread = (numChat.unread || 0) + (lidChat.unread || 0);
  if ((lidChat.lastTs || 0) > (numChat.lastTs || 0)) { numChat.lastTs = lidChat.lastTs; numChat.lastTime = lidChat.lastTime; }
  chats.delete(lidJid);
  broadcastHat('ofis', { type: 'chatMerged', oldJid: lidJid, newJid: numaraJid });
  broadcastHat('ofis', { type: 'message', jid: numaraJid, chat: stripRaw(numChat) });
  console.log(`🔗 sohbet birlestirildi: ${lidJid.split('@')[0]} -> ${numaraJid.split('@')[0]}`);
}

// Bir JID'den gercek telefon numarasini cikarmaya calis.
// LID (gizli kimlik) ise once esleme deposuna, sonra onbellege bakar.
function resolvePhone(jidRaw, altJid) {
  if (!jidRaw) return { jid: jidRaw, number: '' };
  // Zaten normal numaraysa direkt dondur
  if (jidRaw.endsWith('@s.whatsapp.net')) {
    return { jid: jidRaw, number: jidRaw.split('@')[0] };
  }
  // LID ise: alternatif alandan gelen gercek numara var mi?
  if (jidRaw.endsWith('@lid')) {
    // 1) mesajla birlikte gelen alternatif (PN) alani
    if (altJid && altJid.endsWith('@s.whatsapp.net')) {
      lidToPn.set(jidRaw, altJid);
      return { jid: altJid, number: altJid.split('@')[0] };
    }
    // 2) daha once eslestirdiysek onbellekten
    if (lidToPn.has(jidRaw)) {
      const pn = lidToPn.get(jidRaw);
      return { jid: pn, number: pn.split('@')[0] };
    }
    // 3) Baileys'in dahili LID->PN deposu
    try {
      const store = waSock?.signalRepository?.lidMapping;
      if (store?.getPNForLID) {
        const pn = store.getPNForLID(jidRaw);
        if (pn && pn.endsWith('@s.whatsapp.net')) {
          lidToPn.set(jidRaw, pn);
          return { jid: pn, number: pn.split('@')[0] };
        }
      }
    } catch (e) {}
    // cozulemedi: LID numarasini goster (gercek numara WhatsApp tarafindan gizli)
    return { jid: jidRaw, number: jidRaw.split('@')[0], isLid: true };
  }
  return { jid: jidRaw, number: jidRaw.split('@')[0] };
}

// Mesaj metnindeki @numara etiketlerini, biliniyorsa isimle degistir.
// mentionedJid: etiketlenen kisilerin jid listesi (contextInfo'dan)
// uyeler: o grubun uye listesi (varsa) — LID'i uye listesinden cozmek icin
function prettifyMentions(text, mentionedJids, uyeler) {
  if (!text || !mentionedJids || !mentionedJids.length) return { text, mentions: [] };
  let out = text;
  const mentions = []; // panele gidecek: [{ display, jid, number }]
  for (const mj of mentionedJids) {
    const num = (mj || '').split('@')[0];
    if (!num) continue;
    // etiketlenen BEN miyim? (numaram veya LID'im)
    const benMiyim = (myNumber && num === myNumber) || (myLID && num === myLID);
    // LID ise once numaraya cevirmeyi dene. ONCE resolvePhone (Baileys dahili depo dahil),
    // sonra lidToPn. Boylece daha fazla LID cozulur, "@kişi" azalir.
    let cozumNum = num;
    let cozumJid = mj;
    if (mj.endsWith('@lid')) {
      const r = resolvePhone(mj, null);
      if (r && !r.isLid && r.jid && r.jid.endsWith('@s.whatsapp.net')) {
        cozumJid = r.jid;
        cozumNum = r.number || num;
      } else if (lidToPn.has(mj)) {
        const pn = lidToPn.get(mj);
        cozumJid = pn;
        cozumNum = (pn || '').split('@')[0] || num;
      }
    }
    // Grup UYE listesinden isim/numara bulmayi dene (etiketlenen kisi uyeyse)
    let uyeAdi = '';
    let uyeNum = '';
    if (uyeler && uyeler.length) {
      // hem LID hem cozulmus numara ile uye ara
      const aday = uyeler.find(u => {
        const ujid = u.jid || '';
        const unum = (ujid.split('@')[0]) || (u.number || '');
        return ujid === mj || ujid === cozumJid || unum === num || unum === cozumNum;
      });
      if (aday) {
        uyeAdi = aday.name && !/^\d+$/.test(aday.name) ? aday.name : '';
        uyeNum = (aday.jid ? aday.jid.split('@')[0] : aday.number) || '';
      }
    }
    const name = benMiyim ? 'Ben'
               : (savedContacts.get(mj)
                  || savedContacts.get(cozumJid)
                  || savedContacts.get(cozumNum + '@s.whatsapp.net')
                  || contactNames.get(mj)
                  || contactNames.get(cozumJid)
                  || contactNames.get(cozumNum + '@s.whatsapp.net')
                  || uyeAdi
                  || '');
    // GORUNUM onceligi:
    //  1) Kayitli isim varsa -> "@isim"
    //  2) Isim yok ama NUMARA biliniyorsa (normal/cozulmus LID/uye numarasi) -> "@numara"
    //  3) Hicbiri yok -> "@kişi"
    let display;
    if (name) {
      display = '@' + name;
    } else if (!mj.endsWith('@lid')) {
      display = '@' + num;                       // normal numara
    } else if (cozumNum !== num) {
      display = '@' + cozumNum;                   // LID cozuldu (resolvePhone/lidToPn)
    } else if (uyeNum) {
      display = '@' + uyeNum;                     // uye listesinden numara
    } else {
      display = '@kişi';                          // gercekten cozulemedi
    }
    out = out.split('@' + num).join(display);

    // Tiklayinca acilacak sohbet jid'ini belirle:
    //  - Normal numara ise dogrudan kullan.
    //  - LID cozulduyse (resolvePhone/lidToPn) veya uye listesinden numara bulunduysa onu kullan.
    let tiklanabilirJid = null;
    let tiklanabilirNum = null;
    if (!mj.endsWith('@lid')) {
      tiklanabilirJid = num + '@s.whatsapp.net';
      tiklanabilirNum = num;
    } else if (cozumNum !== num) {
      tiklanabilirJid = cozumNum + '@s.whatsapp.net';
      tiklanabilirNum = cozumNum;
    } else if (uyeNum) {
      tiklanabilirJid = uyeNum + '@s.whatsapp.net';
      tiklanabilirNum = uyeNum;
    }
    mentions.push({
      display,                       // "@Pekcan Sigorta Emre"
      jid: tiklanabilirJid,          // numarasi biliniyorsa dolu, LID+bilinmiyorsa null
      number: tiklanabilirNum,
      benMiyim,
    });
  }
  return { text: out, mentions };
}
// Bir URL'den resmi indirip diske kaydet, web yolunu dondur
function downloadToFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) { file.close(); fs.unlink(filePath, () => {}); return reject(new Error('HTTP ' + res.statusCode)); }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(true)));
    }).on('error', (e) => { file.close(); fs.unlink(filePath, () => {}); reject(e); });
  });
}
async function getAvatar(jid, taze = false, sock = null) {
  // taze=false: onbellekten ver (hizli). taze=true: WhatsApp'tan YENIDEN cek (logo degistiyse yakala).
  // sock: verilirse O HATTIN soketiyle cekilir (pazarlama gruplari icin), yoksa ofis.
  if (!taze && avatarCache.has(jid)) return avatarCache.get(jid);
  let result = null;
  try {
    // 8 sn zaman asimi: bazi (LID) jid'lerde profilePictureUrl sonsuza kadar bekleyebilir
    const urlPromise = (sock || waSock).profilePictureUrl(jid, 'image');
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('avatar zaman asimi')), 8000));
    const url = await Promise.race([urlPromise, timeout]);
    if (url) {
      const safe = jid.split('@')[0].replace(/[^\d]/g, '');
      // taze cekimde dosya adina zaman damgasi ekle ki tarayici ESKI logoyu cache'ten gostermesin
      const fname = taze ? `pp_${safe}_${Date.now()}.jpg` : `pp_${safe}.jpg`;
      try {
        await downloadToFile(url, path.join(MEDIA_DIR, fname));
        result = '/media/' + fname;
      } catch (e) {
        result = url;
      }
    }
  } catch (e) { result = null; }
  avatarCache.set(jid, result);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// KALICI MEDYA İNDİRME KUYRUĞU (KRİTİK — "PDF/ruhsat panele düşmedi" sorunu)
// SORUN: Medya indirme 4 kez denenip (toplam ~28sn) VAZGEÇİYORDU. WhatsApp o an
//   yoğunsa (rate-overlimit) veya bağlantı kopuksa 4 deneme de başarısız oluyor
//   -> dosya KALICI kayboluyor, panelde sadece ismi kalıyordu.
// ÇÖZÜM: İnmeyen medya kalıcı kuyruğa girer. Bağlantı/yoğunluk düzelince otomatik
//   iner. WhatsApp medyayı ~14 gün sunucusunda tutar; o yüzden ısrar etmek işe yarar.
//   Kuyruk her 45sn'de işlenir, mesaj trafiği varsa bekler (mesaj önceliği).
// ═══════════════════════════════════════════════════════════════════════════
const _medyaKuyruk = new Map(); // msgId -> { m, kind, jid, lineId, sock, deneme, ekleme, oncelik }
const MEDYA_MAX_DENEME = 40;    // ~20+ dakika ısrar (WhatsApp medyayı günlerce tutar)

// ÖNCELİK: küçük sayı = önce iner
//  1 = GRUP medyası (poliçe/ruhsat/dekont — iş kritik, ekip bekliyor)
//  2 = kişisel sohbet medyası
function _medyaOncelik(jid) {
  return String(jid || '').endsWith('@g.us') ? 1 : 2;
}

function medyaKuyrugaEkle(m, kind, jid, lineId, sock) {
  const id = m?.key?.id;
  if (!id || _medyaKuyruk.has(id)) return;
  const oncelik = _medyaOncelik(jid);
  _medyaKuyruk.set(id, { m, kind, jid, lineId, sock, deneme: 0, ekleme: Date.now(), oncelik });
  console.log(`   📥 Medya kuyruğa alındı: ${String(id).slice(0, 10)} | ${kind} | ${oncelik === 1 ? 'GRUP (öncelikli)' : 'kişisel'} | kuyruk: ${_medyaKuyruk.size}`);
}

async function medyaKuyrukIsle() {
  if (!_medyaKuyruk.size) return;
  // MESAJ ÖNCELİĞİ: ekip yazarken indirme yapıp WhatsApp'ı yorma
  if (mesajTrafigiVar()) return;
  // SIRALAMA: önce GRUP medyası, aynı öncelikte YENİ gelen önce (ekip onu bekliyor)
  const sirali = Array.from(_medyaKuyruk.entries()).sort((a, b) => {
    if (a[1].oncelik !== b[1].oncelik) return a[1].oncelik - b[1].oncelik; // grup önce
    return b[1].ekleme - a[1].ekleme;                                       // yeni önce
  });
  for (const [id, is] of sirali) {
    const line = lines.get(is.lineId);
    if (!line || !line.connected) continue; // hat kopuk -> sıradaki tura bırak
    is.deneme++;
    try {
      const url = await saveMedia(is.m, is.kind, line.sock || is.sock);
      if (url) {
        addMessage(is.jid, { id, mediaUrl: url, fromMe: !!is.m.key.fromMe }, {}, is.lineId);
        _medyaKuyruk.delete(id);
        const gecen = ((Date.now() - is.ekleme) / 1000).toFixed(0);
        console.log(`   ✅ Medya SONUNDA indi (${is.deneme}. denemede, ${gecen}sn sonra): ${String(id).slice(0, 10)} | ${is.kind}${is.oncelik === 1 ? ' | GRUP' : ''}`);
        return; // bu turda iş bitti, WhatsApp'ı yorma
      }
    } catch (_) { /* aşağıda değerlendirilir */ }
    if (is.deneme >= MEDYA_MAX_DENEME) {
      _medyaKuyruk.delete(id);
      console.error(`   ❌ Medya ${MEDYA_MAX_DENEME} denemede inmedi, bırakıldı: ${String(id).slice(0, 10)} (${is.kind}) — panelden "yeniden indir" denenebilir`);
      try { broadcastHat(is.lineId, { type: 'medyaInmedi', jid: is.jid, id }); } catch (_) {}
    }
    return; // her turda TEK indirme denemesi (WhatsApp'ı yorma)
  }
}
setInterval(medyaKuyrukIsle, 30000); // her 30 saniyede bir dene (45->30: daha hızlı kurtarma)

// Medyayi indir, public/media'ya kaydet, web yolunu dondur.
// 30 sn icinde inmezse veya hata olursa null doner — sunucu ASLA cokmemeli.
async function saveMedia(m, kind, sock = waSock) {
  const extMap = { image: 'jpg', video: 'mp4', audio: 'ogg', document: '', sticker: 'webp' };
  try {
    const downloadPromise = downloadMediaMessage(
      m, 'buffer', {},
      { logger: silentLogger, reuploadRequest: (sock || waSock).updateMediaMessage }
    );
    // zaman asimi: 60 sn (30->60). Buyuk PDF'ler ve WhatsApp yogun oldugunda 30sn
    // yetmiyordu -> dosya inmiyordu. Artik daha sabirli.
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('indirme zaman asimi')), 60000));
    const buffer = await Promise.race([downloadPromise, timeout]);

    let ext = extMap[kind] || 'bin';
    if (kind === 'document') {
      // belge documentMessage VEYA documentWithCaptionMessage icinde olabilir
      const docM = m.message?.documentMessage
                || m.message?.documentWithCaptionMessage?.message?.documentMessage
                || m.message?.ephemeralMessage?.message?.documentMessage
                || m.message?.viewOnceMessage?.message?.documentMessage;
      const fn = docM?.fileName || '';
      ext = fn.includes('.') ? fn.split('.').pop() : 'bin';
    }
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, fileName), buffer);
    const webYol = '/media/' + fileName;
    // VIDEO ise: tarayıcıda sesi olmayabilir (HEVC/uyumsuz codec). ffmpeg ile
    // H.264 + AAC'ye çevir (tarayıcı kesin destekler, ses gelir). Arka planda yapılır;
    // bitince videoUpdate ile panele yeni (sesli) sürüm bildirilir.
    if (kind === 'video' && FFMPEG_VAR) {
      videoSesliCevir(path.join(MEDIA_DIR, fileName), fileName, m);
    }
    return webYol;
  } catch (e) {
    console.error('Medya indirilemedi:', e.message);
    return null;
  }
}

// ffmpeg kurulu mu? (başlangıçta bir kez kontrol edilir)
let FFMPEG_VAR = false;
try {
  require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' });
  FFMPEG_VAR = true;
  console.log('✅ ffmpeg bulundu — videolar tarayıcı-dostu (sesli) formata çevrilecek.');
} catch (e) {
  console.log('⚠️  ffmpeg YOK — video ses dönüşümü kapalı. Kurmak için: apt install ffmpeg -y');
}

// Bir videoyu H.264 + AAC'ye çevir (tarayıcıda sesli oynar). Başarılıysa orijinalin
// yerine kullanılır; başarısızsa orijinal kalır (güvenlik ağı).
const _videoCevrilenler = new Set(); // aynı dosyayı tekrar çevirme
function videoSesliCevir(tamYol, fileName, m) {
  if (_videoCevrilenler.has(fileName)) return;
  _videoCevrilenler.add(fileName);
  const { exec } = require('child_process');
  const ciktiAd = fileName.replace(/\.[^.]+$/, '') + '_web.mp4';
  const ciktiYol = path.join(MEDIA_DIR, ciktiAd);
  // -movflags +faststart: web'de hızlı başlasın. -c:v libx264 -c:a aac: tarayıcı dostu.
  const komut = `ffmpeg -y -i "${tamYol}" -c:v libx264 -preset veryfast -crf 26 -c:a aac -b:a 128k -movflags +faststart "${ciktiYol}"`;
  exec(komut, { timeout: 120000 }, (err) => {
    if (err) { console.error('🎬 video dönüşüm hatası:', err.message); return; }
    try {
      // orijinali sil, web sürümünü orijinal adına taşı (URL değişmesin)
      fs.unlinkSync(tamYol);
      fs.renameSync(ciktiYol, tamYol);
      console.log(`🎬 video sesli formata çevrildi: ${fileName}`);
      // panellere "bu video güncellendi" de (yeniden yüklensin, sesli gelsin)
      try {
        const jid = m.key?.remoteJid;
        if (jid) {
          // tüm hatlara değil, ofis + varsa ilgili hatta yayınla (basit: ofis)
          broadcastHat('ofis', { type: 'videoGuncellendi', jid, msgId: m.key?.id, mediaUrl: '/media/' + fileName });
        }
      } catch (e2) {}
    } catch (e3) { console.error('🎬 video taşıma hatası:', e3.message); }
  });
}

// ---- WhatsApp baglantisi ----
let _waStarting = false;
let _reconnectGecikme = 1500; // ilk gecici kopmada hizli baglan (1.5sn); ust uste koparsa backoff ile artar
// GECE KOPMASI DUZELTMESI: ust uste basarisiz denemeleri say. Cok denenince bekleme
// 20sn'de tavanlanir (60 yerine) VE belli arada sayac sifirlanip yeniden agresif denenir.
// Boylece gece internet dalgalaninca sistem "60sn'de bir isteksizce" takilip kalmaz.
let _reconnectSayac = 0;
// CAKISMA DUZELTMESI: ayni hat icin AYNI ANDA birden fazla "yeniden baglan" tetiklenmesin
// (canlilik kontrolu + connection.close ikisi birden tetikleyince iki soket aciliyordu).
const _yenidenBaglaniyor = new Set(); // su an yeniden baglanma planlanmis hatlar
function yenidenBaglanPlanla(lineId, bekle, line) {
  if (_yenidenBaglaniyor.has(lineId)) return; // zaten planlandi, cift planlama yok
  _yenidenBaglaniyor.add(lineId);
  setTimeout(() => {
    _yenidenBaglaniyor.delete(lineId);
    if (line && line.manualLogout) return; // arada elle cikis yapildiysa baglanma
    startWA(lineId).catch(() => {});
  }, bekle);
}
// startWA(lineId): bir HATTI baslatir. Varsayilan 'ofis' (geriye uyumlu).
// Her hat kendi auth klasorunu (auth/<lineId>) ve kendi line objesini kullanir.
async function startWA(lineId = 'ofis') {
  // bu hat icin line objesini al/olustur
  let line = lines.get(lineId);
  if (!line) { line = createLine(lineId, lineId === 'ofis' ? 'Ofis Ana Hat' : lineId); lines.set(lineId, line); }
  if (line.starting) return; // bu hat zaten baglaniyor, cift baslatma
  line.starting = true;
  activeLine = line; // su an islem yapilan hat (kopru icin)
  _waStarting = true; // (eski global bayrak — geriye uyumluluk)

  // her hattin KENDI auth klasoru: auth/<lineId>
  const { state, saveCreds } = await useMultiFileAuthState(line.authDir);
  // SÜRÜM: fetchLatestBaileysVersion() her açılışta internete çıkıp 2-3sn bekletiyordu
  // (restart kesintisini uzatan sebeplerden biri). Sürümü hızlıca almayı dene, takılırsa
  // gömülü sürümle DEVAM ET -> açılış belirgin hızlanır, kesinti kısalır.
  let version;
  try {
    const vP = fetchLatestBaileysVersion();
    const zaman = new Promise((_, r) => setTimeout(() => r(new Error('surum sorgu timeout')), 2500));
    version = (await Promise.race([vP, zaman])).version;
  } catch (_) {
    version = [2, 3000, 1023223821]; // gömülü güncel sürüm — internet beklemeden bağlan
    console.log('   ⏩ Surum sorgusu atlandi (gomulu surumle hizli baglaniliyor)');
  }

  const sock = makeWASocket({
    version, auth: state,
    logger: silentLogger,         // ÖNEMLI: Baileys'in JSON log selini sustur (terminal okunabilir kalsin)
    printQRInTerminal: false,
    browser: ['Anka CRM', 'Chrome', '1.0.0'],
    syncFullHistory: false,       // tüm gecmisi cekme — 7500+ sohbette sunucuyu bogup CANLI mesajlari engelliyordu.
                                  // false = baglaninca sadece yakin gecmis gelir, canli akisa hemen gecer.
    markOnlineOnConnect: false,   // panel "cevrimici" gorunmesin — cevrimici iken WhatsApp bazi gelen
                                  // mesaj bildirimlerini farkli/eksik iletebiliyor. false daha guvenilir akis verir.
    // ↓↓↓ BAGLANTI KARARLILIGI (surekli kopma + "Precondition Required" + sendRetryRequest hatasi icin) ↓↓↓
    // KRITIK: getMessage — WhatsApp bir mesaji cozemeyip "tekrar gonder" (retry) isterse,
    // Baileys o mesaji bizden ister. Bu fonksiyon yoksa retry basarisiz olup BAGLANTI DUSUYOR.
    // Bellekteki mesaj deposundan ilgili mesaji dondururuz -> retry basarili -> baglanti kopmaz.
    getMessage: async (key) => {
      try {
        const jid = key.remoteJid;
        const C = hatChats(lineId);
        const chat = C && C.get ? C.get(jid) : null;
        if (chat && chat.messages) {
          const m = chat.messages.find(x => x && x.id === key.id);
          if (m && m._raw) return m._raw.message || undefined;
        }
      } catch (e) {}
      return undefined; // bulunamazsa undefined (Baileys bos mesajla devam eder, kopmaz)
    },
    retryRequestDelayMs: 350,       // retry istekleri arasi bekleme (cok hizli retry WhatsApp'i kizdirir)
    maxMsgRetryCount: 5,            // bir mesaj icin en fazla 5 retry (3'ten artirildi — gecici ag sorunlarinda mesaj dusurmesin)
    connectTimeoutMs: 90000,        // baglanti kurma zaman asimi 90sn (yavas/dalgali agda erken pes etmesin)
    keepAliveIntervalMs: 25000,     // 25 sn'de bir "hayatta miyim" (WhatsApp Web standardi ~30sn; 15sn cok sikti, bazen ters tepiyordu)
    defaultQueryTimeoutMs: 90000,   // sorgu zaman asimi 90sn (varsayilan 60sn bazen yavas yanitta kopmaya yol aciyordu)
    emitOwnEvents: false,           // kendi gonderdigimiz mesajlari geri event olarak alma (gereksiz yuk)
    qrTimeout: 60000,               // QR gecerlilik suresi (cok kisa olunca surekli yeni QR uretip baglantiyi mesgul ediyordu)
  });
  line.sock = sock;   // hattin kendi soketi (HER hat icin dogru — bunu kullan)
  // KRITIK: global 'waSock' koprusu SADECE ofis hatti icin guncellensin.
  // Eskiden her hat (pazarlama dahil) burada waSock'u eziyordu -> ofis paneli mesaj
  // atinca son baglanan pazarlama hattinin soketinden gidiyordu (Volkan'in numarasindan!).
  // Artik waSock hep ofis soketi; pazarlama hatlari line.sock ile izole calisir.
  if (lineId === 'ofis') waSock = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\n📱 QR kodu telefonundan okut (Ayarlar > Bagli cihazlar > Cihaz bagla):\n');
      qrcode.generate(qr, { small: true });
      // QR'i resim (data URL) olarak panele de gonder — HEMEN, beklemeden.
      // SADECE bu hattin kullanicilarina gider (pazarlamacinin QR'i ofise gitmez).
      QRImage.toDataURL(qr, { width: 280, margin: 1 }, (err, url) => {
        if (!err && url) {
          line.lastQR = url;
          if (lineId === 'ofis') lastQR = url; // ofis icin global de guncel kalsin (eski kod)
          broadcastHat(lineId, { type: 'status', connected: false, qr: true, qrImage: url });
          console.log(`   ✅ QR panele gonderildi (hat: ${lineId}).`);
        } else {
          broadcastHat(lineId, { type: 'status', connected: false, qr: true });
        }
      });
    }
    if (connection === 'open') {
      line.connected = true;       // hattin kendi durumu
      line.starting = false;       // hat baglandi
      line.lastQR = null;
      const myJid = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] + '@s.whatsapp.net' : null;
      const myName = sock.user?.name || sock.user?.verifiedName || 'Ben';
      const buNumara = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null;
      const buLID = sock.user?.lid ? sock.user.lid.split(':')[0].split('@')[0] : null;
      line.myNumber = buNumara; line.myLID = buLID; line.myName = myName;
      line.sonAktivite = Date.now(); // HAT BAZLI kalp atışı: yeni bağlandı, taze
      line.kalpBasarisiz = 0;
      line.kalpTestCalisiyor = false;
      // Global'ler (myNumber, waConnected, lastQR) SADECE ofis hatti icin guncellensin —
      // pazarlama hatti baglaninca ofisin global durumunu EZMESIN.
      if (lineId === 'ofis') {
        waConnected = true;
        _waStarting = false;
        _sonWaAktivite = Date.now();
        lastQR = null;
        myNumber = buNumara; myLID = buLID;
      }
      _reconnectGecikme = 1500;
      _reconnectSayac = 0;          // basarili baglandi -> sayac sifir (bir dahaki kopmada yine hizli dene)
      _yenidenBaglaniyor.delete(lineId); // varsa bekleyen plani temizle (artik bagliyiz)
      console.log(`\n✅ WhatsApp baglandi (hat: ${lineId})! Panel: http://localhost:${PORT}\n`);
      console.log(`   👤 numaram: ${buNumara}${buLID ? ' | LID: ' + buLID : ''}`);
      broadcastHat(lineId, { type: 'status', connected: true, myJid, myName });
      // ═══ KAÇAN MESAJ TELAFİSİ ═══ (bağlantı ölüyken gelen mesajlar kaybolmasın)
      // Bağlantı yarı-açık/ölü olduğu sürede WhatsApp bazı mesajları iletemez. Yeniden
      // bağlanınca bunları otomatik göndermeyebilir. Bu yüzden: bağlandıktan 6sn sonra,
      // EN SON konuşulan grupların son mesajlarını proaktif çek (fetchMessageHistory).
      // Böylece kopukluk sırasında düşen foto/mesajlar telafi edilir.
      if (lineId === 'ofis') {
        setTimeout(() => { kacanMesajTelafi(sock).catch(() => {}); }, 6000);
      }
      if (lineId === 'ofis') {
        // ---- OFIS HATTI (mevcut davranis, degismedi) ----
        // GUVENCE: bellek bossa DB'den sohbetleri geri yukle.
        if (chats.size === 0 && db.isReady()) {
          console.log('   📂 Bellek bos — DB\'den sohbetler yeniden yukleniyor...');
          try {
            await loadFromDB();
            hafifChatsYayinla('ofis', chats);
            console.log(`   ✅ ${chats.size} sohbet DB'den geri yuklendi.`);
          } catch (e) { console.log('   ⚠️  DB yukleme hatasi: ' + e.message); }
        }
        // Katildigim TUM gruplari cek (ofis ortak hatti — tum gruplari gorur)
        setTimeout(() => fetchAllGroups(), 8000);
        setTimeout(() => fetchAllGroups(), 30000);
        // ACIKLAMA+FOTO TARAMASI: adlar geldikten sonra eksik aciklama/fotolari tek tek doldur
        setTimeout(() => ofisAciklamaTaramasi(), 45000);
        // AÇIKLAMA MOTORU: bağlanınca imleci sıfırla + hemen başlat (ilk dolum hızlı başlasın)
        _aciklamaImlec.set('ofis', 0);
        setTimeout(() => { aciklamaMotorTur().catch(() => {}); }, 8000);
        setTimeout(() => fetchAllGroups(), 75000);
      } else {
        // ---- PAZARLAMA HATTI ----
        // Kullanicinin istegi: ESKI gruplari toplu CEKME. Sadece QR sonrasi GELEN mesajlar
        // bu hatta kaydedilir. Onceki girislerde kendi hattina kaydedilenleri DB'den yukle.
        if (db.isReady()) {
          try {
            const veri = await db.loadAll(lineId); // SADECE bu hattin sohbetleri
            line.chats.clear();
            for (const row of veri.chats) {
              line.chats.set(row.jid, {
                jid: row.jid, name: row.name || row.jid.split('@')[0],
                isGroup: row.is_group, description: row.description || '',
                avatar: row.avatar || null, memberCount: row.member_count || 0,
                members: row.members || [], messages: [],
                unread: row.unread || 0, ozelUnread: row.ozel_unread || 0, muhUnread: row.muh_unread || 0, lastTime: row.last_time || '', lastTs: Number(row.last_ts) || 0,
                pinned: row.pinned, archived: row.archived, hasMention: row.has_mention,
              });
            }
            hafifChatsYayinla(lineId, line.chats);
            console.log(`   ✅ Pazarlama hatti '${lineId}': ${line.chats.size} kendi sohbeti yuklendi (eski gruplar cekilmedi).`);
            // ACIKLAMALAR: pazarlama hattinda toplu cekim yoktu -> "aciklamalar dusmuyor"un
            // ana sebebi. Baglaninca 12sn sonra TUM gruplarin aciklamasi tek istekle cekilir.
            setTimeout(() => topluAciklamaSenkron(lineId), 12000);
          } catch (e) { console.log(`   ⚠️  Pazarlama hatti yukleme hatasi (${lineId}): ` + e.message); }
        }
        // Pazarlama icin fetchAllGroups YOK (eski gruplar karismasin, sadece canli akis).
      }
      // PERIYODIK tazeleme: her 10 dakikada bir OFIS grup adlarini yenile.
      // Boylece sonradan ID'de kalan/yeni gruplarin adlari otomatik duzelir.
      // (fetchAllGroups zaten kendi icinde sadece ofis icin calisir.)
      if (lineId === 'ofis' && !global._grupTazelemeTimer) {
        global._grupTazelemeTimer = setInterval(() => {
          const ol = lines.get('ofis');
          if (ol && ol.connected) fetchAllGroups();
        }, 10 * 60 * 1000); // 10 dakika
      }
      // CANLILIK: Artık merkezi "kalp atışı" sistemi TÜM hatları (ofis+pazarlama) denetliyor
      // (yukarıda tanımlı global._kalpAtisiTimer). Eski ofis-only kontrol kaldırıldı — çakışma olmasın.
      // Sadece geriye uyumluluk: mesaj gönderilemeyince ANLIK tetikleme için fonksiyonu koruyoruz.
      if (!global._canlilikKontrolTetikle) {
        global._canlilikKontrolTetikle = async (zorla = false) => {
          // ofis hattını hemen test et (kalp atışı periyodunu beklemeden)
          const ol = lines.get('ofis');
          if (ol) { ol.sonAktivite = 0; } // sessiz say -> sonraki kalp turu (max 15sn) hemen test eder
          // acil durumda hemen bir tur çalıştır
          if (zorla) { try { await kalpAtisiTuru(); } catch (_) {} }
        };
      }
    }
    if (connection === 'close') {
      if (lineId === 'ofis') waConnected = false;
      line.connected = false;
      line.starting = false;
      _waStarting = false; // koptu, yeniden baslatilabilir
      const code = lastDisconnect?.error?.output?.statusCode;
      // ═══ TEŞHİS: kopmanın GERÇEK sebebini yaz (tahmin değil, WhatsApp'ın verdiği kod) ═══
      const _sebepler = {
        401: '🔴 OTURUM KAPATILDI (telefondan çıkış yapıldı veya WhatsApp oturumu iptal etti)',
        408: '🟡 ZAMAN AŞIMI (ağ yavaş/kesik — sunucu internet sorunu olabilir)',
        411: '🔴 CİHAZ UYUŞMAZLIĞI (multi-device sorunu — yeni QR gerekir)',
        428: '🟡 BAĞLANTI KAPANDI (WhatsApp bağlantıyı kesti — genelde ağ veya yoğunluk)',
        440: '🔴 BAŞKA YERDE AÇILDI! (aynı oturum başka cihazda/panelde açıldı — ÇAKIŞMA)',
        500: '🔴 BOZUK OTURUM (auth dosyaları bozulmuş — yeni QR gerekir)',
        503: '🟡 WHATSAPP SERVİSİ MEŞGUL (WhatsApp tarafında geçici sorun)',
        515: '🟢 YENİDEN BAŞLATMA GEREKLİ (normal — Baileys kendini tazeliyor)',
      };
      const _sebepYazi = _sebepler[code] || ('❓ BİLİNMEYEN KOD: ' + code + ' | mesaj: ' + (lastDisconnect?.error?.message || '-'));
      // kopma geçmişi (son 1 saat) — desen görelim
      if (!line.kopmaGecmisi) line.kopmaGecmisi = [];
      line.kopmaGecmisi.push({ ts: Date.now(), code });
      line.kopmaGecmisi = line.kopmaGecmisi.filter(k => Date.now() - k.ts < 3600000);
      const _sonSaatKopma = line.kopmaGecmisi.length;
      console.log('');
      console.log('╔══════════════════════════════════════════════════════════');
      console.log(`║ 🔌 BAĞLANTI KOPTU [${lineId}]`);
      console.log(`║ Sebep: ${_sebepYazi}`);
      console.log(`║ Son 1 saatte kopma sayısı: ${_sonSaatKopma}`);
      if (_sonSaatKopma >= 5) {
        console.log('║ ⚠️  ÇOK SIK KOPUYOR! Muhtemel sebepler:');
        console.log('║    • Aynı numara telefonda/başka panelde aktif (çakışma)');
        console.log('║    • Telefonda "Bağlı cihazlar" listesinde fazla cihaz var');
        console.log('║    • Sunucu ağı dalgalı (VPS internet sorunu)');
      }
      console.log('╚══════════════════════════════════════════════════════════');
      console.log('');
      broadcastHat(lineId, { type: 'status', connected: false });
      if (code === DisconnectReason.loggedOut) {
        // OTURUM GECERSIZ (telefondan cikis, baska cihaz cakismasi, 401/440).
        // Bozuk auth ile tekrar denemek ayni hataya dusurur (sonsuz dongü) — bu yuzden
        // auth klasorunu OTOMATIK temizle ki temiz bir QR uretebilelim.
        // Boylece elle "auth klasorunu sil" yapmaya gerek kalmaz.
        console.log('⚠️  Oturum gecersiz oldu (telefondan cikis/cakisma olabilir). Auth temizleniyor, yeni QR uretilecek...');
        try {
          fs.rmSync(line.authDir, { recursive: true, force: true }); // bu HATTIN auth'u
          console.log('   🗑️  auth klasoru temizlendi.');
        } catch (e) { console.error('   auth temizlenemedi:', e.message); }
        if (lineId === 'ofis') { myNumber = null; myLID = null; lastQR = null; }
        line.myNumber = null; line.myLID = null; line.lastQR = null;
        _reconnectGecikme = 1500;
        // panele bildir: baglanti gitti, yeni QR geliyor
        broadcastHat(lineId, { type: 'status', connected: false, loggedOut: true });
        if (!line.manualLogout) setTimeout(() => startWA(lineId), 2000); // bu HATTI yeniden baslat
      } else if (code === 440) {
        // ═══ ÇAKIŞMA: Aynı oturum BAŞKA bir yerde açıldı (telefonda WhatsApp Web,
        //     başka panel, ya da ikinci bir sunucu). Hemen yeniden bağlanırsak iki taraf
        //     birbirini SÜREKLİ atar (sonsuz savaş) -> bağlantı hiç oturmaz.
        //     Bu yüzden UZUN bekle (30sn) ve tek sefer dene. ═══
        console.log('⚔️  ÇAKIŞMA: Bu numara başka bir yerde açık! (telefonda WhatsApp Web veya başka panel)');
        console.log('   → Sonsuz kopma savaşını önlemek için 30 saniye bekleniyor.');
        console.log('   → ÇÖZÜM: Telefonda WhatsApp > Bağlı cihazlar > gereksiz cihazları çıkar.');
        broadcastHat(lineId, { type: 'status', connected: false, cakisma: true });
        _reconnectGecikme = 1500;
        yenidenBaglanPlanla(lineId, 30000, line); // 30sn bekle, karşı taraf otursun
      } else if (code === 515) {
        // NORMAL: Baileys kendini tazeliyor (restartRequired). Hemen bağlan, bu bir hata değil.
        console.log('🟢 Normal tazeleme (515) — hemen yeniden bağlanılıyor.');
        _reconnectGecikme = 1500;
        yenidenBaglanPlanla(lineId, 1000, line);
      } else {
        // Gecici kopma. GECE KOPMASI DUZELTMESI:
        //  - Bekleme tavani 60sn DEGIL 20sn (gece saatlerce "olu" beklemede kalmasin).
        //  - Her 5 basarisiz denemede bir bekleme SIFIRLANIR -> tekrar hizli/agresif dener.
        //    Boylece internet gece duzelince sistem 20sn beklemeden, hemen yakalar.
        _reconnectSayac++;
        let bekle = _reconnectGecikme;
        _reconnectGecikme = Math.min(_reconnectGecikme * 2, 20000); // tavan 20sn
        if (_reconnectSayac % 5 === 0) {
          // 5 denemede bir: agresif moda don (gece takilip kalmayi kirar)
          _reconnectGecikme = 1500;
          bekle = 1500;
          console.log('   🔄 Ust uste kopma — agresif yeniden baglanmaya donuluyor (sayac sifirlandi).');
        }
        console.log(`Baglanti koptu (deneme ${_reconnectSayac}), ${Math.round(bekle / 1000)} sn sonra yeniden baglaniyorum...`);
        yenidenBaglanPlanla(lineId, bekle, line); // CAKISMA KILITLI: ayni anda 2 plan olmaz
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Telefon rehberindeki kayitli isimleri al (Busra Dogan gibi)
  function kaydetKisiler(contacts) {
    if (!Array.isArray(contacts)) return;
    let n = 0;
    for (const ct of contacts) {
      const jid = ct.id;
      if (!jid) continue;
      const num = jid.split('@')[0];
      // 1) rehbere kaydedilmis gercek isim (en oncelikli)
      const rehberIsmi = ct.name || ct.verifiedName;
      if (rehberIsmi && rehberIsmi.trim()) {
        savedContacts.set(jid, rehberIsmi.trim());
        if (num) savedContacts.set(num + '@s.whatsapp.net', rehberIsmi.trim());
        contactNames.set(jid, rehberIsmi.trim());
        if (num) contactNames.set(num + '@s.whatsapp.net', rehberIsmi.trim());
        n++;
      }
      // 2) rehber yoksa, en azindan notify (kisinin kendi koydugu isim) yedek olsun
      else if (ct.notify && ct.notify.trim()) {
        if (!contactNames.has(jid)) { contactNames.set(jid, ct.notify.trim()); if (num) contactNames.set(num + '@s.whatsapp.net', ct.notify.trim()); }
      }
    }
    if (n) console.log(`📇 ${n} kayitli rehber ismi alindi (toplam rehber: ${savedContacts.size})`);
  }
  sock.ev.on('contacts.set', ({ contacts }) => { console.log(`📇 contacts.set tetiklendi: ${contacts?.length||0} kisi`); kaydetKisiler(contacts); });
  sock.ev.on('contacts.upsert', (contacts) => { console.log(`📇 contacts.upsert tetiklendi: ${contacts?.length||0} kisi`); kaydetKisiler(contacts); });
  sock.ev.on('contacts.update', (contacts) => { kaydetKisiler(contacts); });


  // Baglaninca WhatsApp son sohbetleri ve mesajlari gonderir - bunlari panele yukle
  sock.ev.on('messaging-history.set', async ({ chats: histChats, messages: histMessages, isLatest }) => {
    // PAZARLAMA hatlari icin gecmis YUKLEME — kullanici istegi: sadece QR sonrasi gelen
    // mesajlar gorunsun, eski toplu gecmis cekilmesin. Sadece ofis hatti gecmis yukler.
    if (lineId !== 'ofis') return;
    try {
      // 1) Sohbet listesini doldur (isim, son zaman)
      if (Array.isArray(histChats)) {
        for (const hc of histChats) {
          let jid = hc.id;
          if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
          const isG = jid.endsWith('@g.us');
          if (!isG) jid = normalizeChatJid(jid, { key: { remoteJid: jid } });
          if (!chats.has(jid)) {
            chats.set(jid, {
              jid,
              name: hc.name || hc.subject || jid.split('@')[0],
              isGroup: isG,
              description: '',
              avatar: null,
              memberCount: 0,
              members: [],
              messages: [],
              unread: hc.unreadCount || 0,
              lastTime: '',
              lastTs: hc.conversationTimestamp ? Number(hc.conversationTimestamp) * 1000 : 0,
            });
          }
        }
      }
      // 2) Gelen gecmis mesajlari ilgili sohbetlere ekle (en son birkaci)
      if (Array.isArray(histMessages)) {
        for (const m of histMessages) {
          try {
            let jid = m.key?.remoteJid;
            if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
            // YAS FILTRESI: 30 gunden eski gecmis mesajlari hic isleme (panel + DB temiz kalsin)
            const mTs = m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now();
            if (mTs < Date.now() - MESAJ_SAKLAMA_MS) continue;
            const info = describeMessage(m);
            if (info.kind === 'skip' || info.kind === 'reaction') continue;
            const isG = jid.endsWith('@g.us');
            if (!isG) jid = normalizeChatJid(jid, m);
            const fromMe = !!m.key.fromMe;
            // sohbet yoksa olustur
            if (!chats.has(jid)) {
              chats.set(jid, {
                jid, name: m.pushName || jid.split('@')[0], isGroup: isG,
                description: '', avatar: null, memberCount: 0, members: [],
                messages: [], unread: 0, lastTime: '', lastTs: 0,
              });
            }
            const chat = chats.get(jid);
            // ayni mesaj zaten varsa atla
            if (chat.messages.some(x => x.id === m.key.id)) continue;
            const ts = m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now();
            const histMsg = {
              id: m.key.id, raw: m, key: m.key, fromMe,
              kind: info.kind, text: info.text, mediaUrl: null,
              contact: info._contact || null, contacts: info._contacts || null,
              sender: fromMe ? 'Ben' : (m.pushName || ''),
              senderJid: m.key.participant || (fromMe ? '' : jid),
              time: new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
              ts,
            };
            chat.messages.push(histMsg);
            // ÖNEMLI: gecmis mesajlari da Supabase'e yaz. Kopma sirasinda kacan mesajlar
            // WhatsApp'tan cogunlukla bu event ile geri gelir; DB'ye yazilmazsa sunucu
            // restart olunca kaybolur. (chat_jid,id) PRIMARY KEY oldugu icin tekrar yazim guvenli.
            if (db.isReady()) db.saveMessage(jid, histMsg).catch(() => {});
          } catch (e) {}
        }
        // her sohbetin mesajlarini zamana gore sirala + son zamani guncelle
        for (const chat of chats.values()) {
          chat.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
          const last = chat.messages[chat.messages.length - 1];
          if (last) { chat.lastTs = last.ts || chat.lastTs; chat.lastTime = last.time || chat.lastTime; }
          // sohbetin son durumunu (son zaman) DB'ye yaz ki acilis sirasi dogru olsun
          if (db.isReady()) db.saveChat(chat).catch(() => {});
        }
      }
      // panele guncel listeyi gonder (ofis gecmisi -> sadece ofis panellerine)
      // ⚠️ GECIKTIRME: WhatsApp history sync'i art arda BIRCOK paket halinde gonderebiliyor.
      // Her pakette listeyi yayinlarsak panel surekli yenilenip TITRIYOR ("gruplar 0'a dustu").
      // Bu yuzden yayini 2sn geciktiriyoruz -> art arda gelen paketler TEK yayinda toplanir.
      clearTimeout(global._histYayinTimer);
      global._histYayinTimer = setTimeout(() => {
        hafifChatsYayinla('ofis', chats);
        console.log(`📚 Gecmis islendi, liste guncellendi (${chats.size} sohbet)`);
      }, 2000);
      console.log(`📚 Gecmis paketi alindi: ${histChats?.length || 0} sohbet, ${histMessages?.length || 0} mesaj (yayin 2sn beklemede)`);
    } catch (e) { console.error('Gecmis yukleme hatasi:', e.message); }
  });

  // Karsi taraf bir mesaji silince / duzenleyince yakala
  sock.ev.on('messages.update', (updates) => {
    _sonWaAktivite = Date.now(); // WhatsApp aktivitesi
    if (line) { line.sonAktivite = Date.now(); line.kalpBasarisiz = 0; }
    const CC = hatChats(lineId); // bu hattin sohbetleri
    for (const u of updates) {
      const jid = u.key?.remoteJid;
      const id = u.key?.id;
      if (!jid || !id) continue;
      const chat = CC.get(jid);
      if (!chat) continue;
      const m = chat.messages.find(x => x.id === id);
      if (!m) continue;
      const upd = u.update || {};
      // --- MESAJ DURUMU (TIK) — DURUST MOD ---
      // SORUN: Baileys, sifreleme oturumu bozukken bile status=3 (iletildi/cift tik)
      // gonderebiliyor. Bu YANILTICI — mesaj aslinda gitmemisken cift tik gosteriyordu.
      // COZUM: status'tan gelen bilgiyle SADECE tek tik'e (gonderildi=2) kadar cikariyoruz.
      // Cift tik (iletildi=3) ve mavi (okundu=4) ARTIK SADECE 'message-receipt.update'ten
      // gelir — o gercek teslimat makbuzudur, guvenilirdir. Boylece cift tik yaniltmaz.
      if (m.fromMe && typeof upd.status !== 'undefined' && upd.status !== null) {
        let yeniDurum = Number(upd.status);
        if (yeniDurum > 2) yeniDurum = 2; // status en fazla "gonderildi" (tek tik) saysin
        const eski = m.durum || 0;
        if (yeniDurum > eski) {
          m.durum = yeniDurum;
          broadcastHat(lineId, { type: 'msgStatus', jid, id, durum: yeniDurum });
        }
      }
      // silindi mi? (protokol mesaji REVOKE)
      if (upd.messageStubType === 1 || upd.message === null) {
        m.deleted = true; m.text = ''; m.kind = 'text'; m.mediaUrl = null;
        broadcastHat(lineId, { type: 'message', jid, chat: stripRaw(chat) });
        // DB'ye de yaz: silme kalici olsun (yenileyince geri gelmesin)
        if (db.isReady()) db.saveMessage(jid, m, lineId).catch(() => {});
      }
      // duzenlendi mi?
      else if (upd.message?.editedMessage || upd.message?.protocolMessage?.editedMessage) {
        const em = upd.message.editedMessage?.message || upd.message.protocolMessage?.editedMessage;
        const newText = em?.conversation || em?.extendedTextMessage?.text;
        if (newText) {
          m.text = newText;
          m.edited = true;
          broadcastHat(lineId, { type: 'message', jid, chat: stripRaw(chat) });
          // DB'ye de yaz: yoksa sayfa yenilenince / baska kullanicida ESKI metin gorunur.
          if (db.isReady()) db.saveMessage(jid, m, lineId).catch(() => {});
          console.log(`✏️  mesaj duzenlendi: ${id.substring(0,12)} -> "${newText.substring(0,30)}"`);
        }
      }
      // ŞIFRESI COZULEMEYEN mesajin COZULMUS hali sonradan geldi mi?
      // Baileys bazen once cozulememis placeholder ("undecryptable") gonderir,
      // saniyeler sonra gercek icerigi messages.update ile yollar. Bunu yakalayip guncelliyoruz,
      // yoksa ekranda "sifresi cozulemedi" yazisi kalir ama mesaj aslinda gelmistir.
      else if (m.kind === 'undecryptable' && upd.message) {
        try {
          const yeni = describeMessage({ key: u.key, message: upd.message });
          if (yeni && yeni.kind !== 'undecryptable' && yeni.kind !== 'skip') {
            m.kind = yeni.kind;
            m.text = yeni.text || '';
            if (yeni._contact) m.contact = yeni._contact;
            if (yeni._contacts) m.contacts = yeni._contacts;
            // medya ise arka planda indir (mesaji bekletmeden), inince guncellenir
            if (['image','video','audio','document','sticker'].includes(yeni.kind)) {
              const mm = { key: u.key, message: upd.message, messageTimestamp: m.ts ? m.ts/1000 : undefined };
              saveMedia(mm, yeni.kind, sock).then((url) => {
                if (url) { m.mediaUrl = url; broadcastHat(lineId, { type: 'message', jid, chat: stripRaw(chat) });
                  if (db.isReady()) db.saveMessage(jid, m, lineId).catch(()=>{}); }
              }).catch(()=>{});
            }
            console.log(`🔓 cozulemeyen mesaj sonradan cozuldu: ${id.substring(0,12)} -> ${yeni.kind}`);
            broadcastHat(lineId, { type: 'message', jid, chat: stripRaw(chat) });
            if (db.isReady()) db.saveMessage(jid, m, lineId).catch(()=>{});
          }
        } catch (e) { console.error('   ⚠️  cozulme guncelleme hatasi:', e.message); }
      }
    }
  });

  // MESAJ ALINDI BILGISI (receipt): iletildi/okundu durumunu daha guvenilir verir (ozellikle grup).
  sock.ev.on('message-receipt.update', (updates) => {
    if (line) { line.sonAktivite = Date.now(); line.kalpBasarisiz = 0; } // makbuz geldi -> hat canli
    const CC = hatChats(lineId); // bu hattin sohbetleri
    for (const u of updates) {
      const jid = u.key?.remoteJid;
      const id = u.key?.id;
      if (!jid || !id) continue;
      const chat = CC.get(jid);
      if (!chat) continue;
      const m = chat.messages.find(x => x.id === id);
      if (!m || !m.fromMe) continue;
      // receipt tipi: 'delivery'=iletildi(3), 'read'/'played'=okundu(4)
      const r = u.receipt || {};
      let yeniDurum = 0;
      if (r.readTimestamp || r.playedTimestamp) yeniDurum = 4;
      else if (r.receiptTimestamp) yeniDurum = 3;
      const eski = m.durum || 0;
      if (yeniDurum > eski) {
        m.durum = yeniDurum;
        broadcastHat(lineId, { type: 'msgStatus', jid, id, durum: yeniDurum });
      }
      // İLETİM DENETÇİSİ: iletildi onayı geldi (durum>=3) -> bu mesaj ULAŞTI, takipten çıkar.
      if (yeniDurum >= 3) iletimDenetleTamam(id);
    }
  });

  // Grup bilgisi degisince (isim, aciklama vs) yakala ve guncelle
  // ============================================================
  // chats.update: WhatsApp "bu sohbette hareket var" sinyali gonderir.
  // Mesaj messages.upsert'e dusmese bile bu event gelir. Bunu yakalayip:
  //  1) sohbeti listede EN USTE cikar (lastTs guncelle) + okunmamis isaretle
  //  2) son mesaji WhatsApp'tan AKTIF cek (sadece bu sohbet — 7500 grup degil) -> kuyruga koy
  // Boylece "guncel mesaj en uste cikmiyor" sorunu cozulur.
  // ============================================================
  sock.ev.on('chats.update', async (updates) => {
    try {
      const CC = hatChats(lineId); // bu hattin sohbetleri
      for (const u of updates) {
        const jid = u.id;
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        const chat = CC.get(jid);
        if (!chat) continue; // bilmedigimiz sohbet (yeni grup) -> groups.upsert/fetchAllGroups halleder
        // conversationTimestamp = son aktivite zamani (saniye cozunurlukte gelir).
        const ts = u.conversationTimestamp ? Number(u.conversationTimestamp) * 1000 : 0;
        let degisti = false;

        // --- 1) SIRALAMA SENKRONU (sahte hareket YARATMADAN) ---
        // WhatsApp bu sohbetin gercek son-aktivite zamanini (conversationTimestamp) gonderir.
        // Bunu lastTs'e yansitiriz ki LISTE SIRASI WhatsApp'la ayni olsun.
        // ÖNEMLI: Bu sadece SIRALAMA icindir — sohbeti "yeni mesaj geldi" diye zip latmaz,
        // okunmamis isareti koymaz. Yani sahte hareket olmaz ama sira dogru olur.
        // Sadece anlamli bir fark varsa (>3sn) guncelle ki gereksiz broadcast olmasin.
        if (ts && Math.abs(ts - (chat.lastTs || 0)) > 3000) {
          chat.lastTs = ts;
          chat.lastTime = new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
          degisti = true;
        }

        // --- 2) GERCEK YENI MESAJ (okunmamis artisi) -> okunmamis isareti ---
        // unreadCount GERCEKTEN arttiysa WhatsApp tarafinda yeni okunmamis var demektir.
        if (typeof u.unreadCount === 'number' && u.unreadCount > 0 && u.unreadCount !== chat.unread) {
          chat.unread = u.unreadCount;
          degisti = true;
        }
        const gercekYeniMesaj = (typeof u.unreadCount === 'number' && u.unreadCount > 0 && u.unreadCount !== (chat._oncekiUnread || 0));
        if (degisti) {
          broadcastHat(lineId, { type: 'message', jid, chat: stripRaw(chat) });
          // AKTIF mesaj cekmeyi SADECE gercek yeni mesaj (okunmamis artisi) varsa dene.
          // Sadece siralama senkronu icin mesaj cekmeye gerek yok (gereksiz yuk olur).
          if (gercekYeniMesaj) mesajCekKuyruguEkle(jid);
        }
        chat._oncekiUnread = chat.unread || 0;
      }
    } catch (e) { console.error('⚠️  chats.update hatasi:', e.message); }
  });

  sock.ev.on('groups.update', async (updates) => {
    try {
      const CC = hatChats(lineId); // bu hattin sohbetleri
      for (const u of updates) {
        const jid = u.id;
        if (!jid || !jid.endsWith('@g.us')) continue;
        // grup listemizde yoksa olustur (yeni katildigimiz grup olabilir)
        if (!CC.has(jid)) {
          CC.set(jid, {
            jid, name: jid.split('@')[0], isGroup: true,
            description: '', avatar: null, memberCount: 0, members: [],
            messages: [], unread: 0, lastTime: '', lastTs: 0,
          });
        }
        const chat = CC.get(jid);
        let degisti = false;
        const eskiAd = chat.name;
        const eskiAciklama = chat.description || '';
        let yeniAd = null, yeniAciklama = null;
        if (u.subject && u.subject.trim()) { yeniAd = u.subject.trim(); }
        if (u.desc !== undefined) { yeniAciklama = u.desc || ''; }
        // subject olayda gelmediyse, guncel adi/aciklamayi metadata'dan cek
        if (!u.subject) {
          try {
            const meta = await getGroupMeta(jid, 0); // degisiklik oldu, taze cek
            if (meta?.subject && meta.subject.trim()) yeniAd = meta.subject.trim();
            if (meta?.desc !== undefined) yeniAciklama = meta.desc || '';
            if (meta?.participants) chat.memberCount = meta.participants.length;
          } catch (e) {}
        }
        // --- AD degisti mi? (sessizce guncelle, bilgi satiri EKLEME) ---
        // Not: Grup adi/aciklamasi degisince sohbete sistem mesaji EKLENMIYOR
        // (kullanici istemedi). Sadece grubun adi/aciklamasi guncel tutulur.
        if (yeniAd && yeniAd !== eskiAd) {
          chat.name = yeniAd;
          degisti = true;
        }
        // --- ACIKLAMA degisti mi? (sessizce guncelle) ---
        if (yeniAciklama !== null && yeniAciklama !== eskiAciklama) {
          chat.description = yeniAciklama;
          degisti = true;
        }
        if (degisti) {
          // HAFIF yayin: sadece ad/aciklama/uye ozeti gider (eskiden 60 mesajli tam sohbet gidiyordu)
          broadcastHat(lineId, { type: 'msgUpdate', jid, ozet: { name: chat.name, description: chat.isGroup ? (chat.description || '') : '', memberCount: chat.memberCount || 0, avatar: chat.avatar || null } });
          console.log(`✏️  grup guncellendi: ${chat.name}`);
        }
      }
    } catch (e) {}
  });

  // Gruba uye eklenince/cikinca uye sayisini guncelle
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      const CC = hatChats(lineId); // bu hattin sohbetleri
      if (!id || !CC.has(id)) return;
      const chat = CC.get(id);
      // guncel uye sayisini cek (taze)
      try {
        const meta = await getGroupMeta(id, 0);
        if (meta) {
          if (meta.subject && meta.subject.trim()) chat.name = meta.subject.trim();
          chat.memberCount = meta.participants?.length || chat.memberCount;
        }
      } catch (e) {}
      broadcastHat(lineId, { type: 'message', jid: id, chat: stripRaw(chat) });
    } catch (e) {}
  });

  // Karsi taraf yaziyor mu? (presence.update)
  sock.ev.on('presence.update', ({ id, presences }) => {
    try {
      if (!id || !presences) return;
      // presences: { participantJid: { lastKnownPresence: 'composing'|'available'|... } }
      let typing = false;
      let whoJid = null;
      for (const [pjid, info] of Object.entries(presences)) {
        const st = info?.lastKnownPresence;
        if (st === 'composing' || st === 'recording') { typing = true; whoJid = pjid; break; }
      }
      // yazan kisinin adini bul
      let who = '';
      if (whoJid) {
        const r = resolvePhone(whoJid, null);
        who = contactNames.get(r.jid) || contactNames.get(whoJid) || '';
      }
      broadcastHat(lineId, { type: 'typing', jid: id, typing, who });
      if(typing) console.log(`⌨️  yaziyor: ${id.split('@')[0]}${who?' ('+who+')':''}`);
    } catch (e) {}
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    _sonWaAktivite = Date.now(); // WhatsApp'tan veri geldi -> baglanti canli (ofis global)
    if (line) { line.sonAktivite = Date.now(); line.kalpBasarisiz = 0; } // HAT BAZLI: bu hat canli
    if (type === 'notify') _sonMesajTrafigi = Date.now(); // MESAJ ÖNCELİĞİ: gelen mesaj da trafik
    // 'notify' yeni mesaj, 'append' senkronizasyon/ilk mesaj - ikisini de al
    if (type !== 'notify' && type !== 'append') return;
    // HAT KISAYOLLARI: bu event hangi hatta ait? (closure'daki lineId/line).
    //  CC      : bu hattin sohbet Map'i (ofis -> global chats, pazarlama -> line.chats)
    //  myNum/myLid : bu hattin kendi numarasi/LID'i (bahsedilme tespiti dogru hatta olsun)
    const CC = hatChats(lineId);
    const myNum = lineId === 'ofis' ? myNumber : line.myNumber;
    const myLidV = lineId === 'ofis' ? myLID : line.myLID;
    for (const m of messages) {
     try {
      let jid = m.key.remoteJid;
      // sohbet olmayan jid'leri atla (durum guncellemeleri, broadcast)
      if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
      const isGroup = jid.endsWith('@g.us');
      let fromMe = !!m.key.fromMe; // baska cihazdan gonderdigin mesajlar da gelir
      const fromMeOrijinal = !!m.key.fromMe; // YANSIMA düzeltmesinden ÖNCEki hal (takip uyarısı için)

      // ════════════════════════════════════════════════════════════════
      // ORTAK GRUP YANSIMASI DUZELTMESI (kritik bug):
      // Ofis ve pazarlama hatti AYNI WhatsApp grubunda uye olabilir. Ofis gruba
      // yazinca, WhatsApp ayni mesaji pazarlama hattina da [append]/fromMe=true
      // olarak yansitiyor (cok-cihaz senkronu gibi). Sonuc: Volkan'in panelinde
      // ofisin mesaji "Volkan gondermis" gibi gorunuyordu.
      // COZUM: grup mesaji fromMe=true ise, GERCEKTEN bu hattin numarasindan mi
      // gonderilmis dogrula. Gonderenin (participant) numarasi bu hattin numarasi
      // DEGILSE, bu baska hattin yansimasidir -> fromMe=false (gelen mesaj say).
      if (isGroup && fromMe) {
        const benimNum = lineId === 'ofis' ? myNumber : (line ? line.myNumber : null);
        const benimLid = lineId === 'ofis' ? myLID : (line ? line.myLID : null);
        // gonderenin numarasini cikar (participant veya alternatif alanlar)
        const gonderenHam = m.key.participant || m.key.participantPn || m.participant || '';
        const gonderenNum = gonderenHam ? gonderenHam.split('@')[0].split(':')[0] : '';
        if (gonderenNum && benimNum && gonderenNum !== benimNum && gonderenNum !== benimLid) {
          // participant ÇÖZÜLDÜ ve benim numaram DEĞİL -> kesinlikle baska hattin yansimasi
          console.log(`   ⚠️  ORTAK GRUP YANSIMASI: fromMe=true ama gonderen ${gonderenNum} ≠ benim ${benimNum} -> gelen mesaj sayiliyor`);
          fromMe = false;
        } else if (!gonderenNum && type === 'append') {
          // participant BOŞ + [append] tipi: WhatsApp cok-cihaz/ortak grup yansimasi.
          // Gercekten kendi gonderdigin mesajlar 'notify' veya panel uzerinden gelir
          // (panelden gonderince zaten addMessage ile fromMe=true ekleniyor, id eslesince
          // mukerrer onlenir). Bu yuzden append+participant yok olan fromMe'yi gelen say.
          console.log(`   ⚠️  ORTAK GRUP YANSIMASI ([append], participant yok): fromMe iptal -> gelen mesaj`);
          fromMe = false;
        }
      }

      // YAS FILTRESI: 30 gunden eski mesajlari isleme — ne panele dusur ne DB'ye yaz.
      // Acilista Baileys eski gecmis cekse bile bunlar elenir (panel hizli/temiz kalir).
      const msgTs = m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now();
      if (msgTs < Date.now() - MESAJ_SAKLAMA_MS) continue;

      // KISI sohbetlerinde jid'i normallestir (ayni kisi farkli formatlarda gelince tek sohbet olsun)
      if (!isGroup) {
        const ham = jid; // gelen orijinal jid (LID olabilir)
        jid = normalizeChatJid(jid, m, lineId); // lineId KRITIK: bu hattin kendi numarasiyla "kendine mesaj" tespiti
        // Eger orijinal LID idi ve numaraya cozuldu, eski LID sohbetini numara sohbetiyle BIRLESTIR.
        // Boylece ayni kisi 2-3 ayri sohbet olarak kalmaz.
        // NOT: sohbetleriBirlestir/normalizeChatJid global chats+myNumber kullanir (ofis-merkezli).
        //      Pazarlama hatlarinda bu birlestirmeyi ATLIYORUZ (en kotu durumda ayni kisi 2 sohbet
        //      gorunur — kozmetik; veri sizintisi DEGIL). Ofiste eskisi gibi calisir.
        if (lineId === 'ofis' && ham !== jid && ham.endsWith('@lid') && chats.has(ham)) {
          sohbetleriBirlestir(ham, jid);
        }
      }

      const info = describeMessage(m);
      // TESHIS: gelen her mesaji logla
      console.log(`📩 [${type}] ${isGroup?'grup':'kisi'} ${jid.split('@')[0]} | tip=${info.kind} | fromMe=${fromMe}`);

      // Icerik tasimayan protokol/sistem mesajlarini atla
      if (info.kind === 'skip') { console.log('   ↳ atlandi (sistem mesaji)'); continue; }

      // Reaksiyon ise: ayri mesaj ekleme, ilgili mesaja ekle
      if (info.kind === 'reaction') {
        const chat = CC.get(jid);
        const targetId = info._reactKey?.id;
        if (chat && targetId) {
          const target = chat.messages.find(x => x.id === targetId);
          if (target) {
            if (info.text) {
              target.reaction = info.text; // emoji
              // Bu reaksiyon TELEFONDAN/MUSTERIDEN geldi — kim attigi WhatsApp'ta belli degil.
              // Panelden atilmis eski "kim atti" bilgisi varsa temizle (yanlis isim kalmasin).
              delete target.reactionBy;
              delete target.myReaction; // bizim panelden atilan degil; karsi taraf/telefon tepkisi
            } else {
              delete target.reaction;     // bos = reaksiyon kaldirildi
              delete target.reactionBy;
              delete target.myReaction;
            }
            broadcastHat(lineId, { type: 'msgUpdate', jid, mesaj: stripBirMesaj(target) });
            if (db.isReady()) db.saveMessage(jid, target, lineId).catch(() => {}); // kalici (yenileyince kaybolmasin)
          }
        }
        continue; // reaksiyon islendi, sonraki mesaja gec
      }
      let senderName = '';
      let senderJid = '';      // grupta mesaji atan kisinin numarasi (ozelden yanit icin)
      let senderPush = '';     // o kisinin gercek adi
      let senderOfis = false;  // bu kisi ofis ekibi/kayitli mi (panelde rozet icin)
      let description = '';
      let memberCount = 0;
      let members = null;
      let chatName = isGroup ? jid.split('@')[0] : (m.pushName || jid.split('@')[0]); // varsayilan
      // grup zaten listede ve duzgun adi varsa onu kullan (subject bos gelirse sayiya donmesin)
      if (isGroup && CC.has(jid) && CC.get(jid).name && !/^\d+$/.test(CC.get(jid).name)) {
        chatName = CC.get(jid).name;
      }
      if (isGroup) {
        // MESAJI METADATA ICIN BEKLETME! (Eskiden 'await getGroupMeta' mesaji 5-10sn
        //  geciktiriyordu — onbellekte yoksa WhatsApp sorgusunu bekliyordu.)
        // Adi ZATEN bildigimiz kaynaklardan al (aninda): mevcut chat > grupAdlari > onbellek.
        const mevcut = CC.get(jid);
        if (mevcut && mevcut.name && mevcut.name !== jid.split('@')[0]) {
          chatName = mevcut.name;
        } else if (grupAdlari.has(jid)) {
          chatName = grupAdlari.get(jid);
        } else {
          const c = groupMetaCache.get(jid);
          if (c && c.meta?.subject && c.meta.subject.trim()) chatName = c.meta.subject.trim();
        }
        // Uye listesi / tam metadata ARKA PLANDA cekilsin (mesaji bekletmeden).
        getGroupMeta(jid).then((meta) => {
          if (!meta) return;
          const c = CC.get(jid);
          if (!c) return;
          let degisti = false;
          if (meta.subject && meta.subject.trim() && c.name !== meta.subject.trim()) { c.name = meta.subject.trim(); degisti = true; }
          if (meta.desc !== undefined && c.description !== meta.desc) { c.description = meta.desc || ''; degisti = true; }
          if (meta.participants) {
            c.memberCount = meta.participants.length;
            c.members = meta.participants.map(p => {
              const r = resolvePhone(p.id, p.phoneNumber || null);
              const nm = savedContacts.get(r.jid) || contactNames.get(r.jid) || contactNames.get(p.id) || (r.isLid ? 'Bilinmeyen kişi' : r.number);
              const av = avatarCache.has(r.jid) ? avatarCache.get(r.jid) : (avatarCache.has(p.id) ? avatarCache.get(p.id) : undefined);
              return { jid: r.jid, number: r.number, name: nm, admin: !!p.admin, isLid: !!r.isLid, avatar: av };
            });
            degisti = true;
          }
          if (degisti) { broadcastHat(lineId, { type: 'msgUpdate', jid, ozet: { name: c.name, description: c.isGroup?(c.description||''):'', memberCount: c.memberCount||0, avatar: c.avatar||null } }); if (db.isReady()) db.saveChat(c, lineId).catch(() => {}); }
        }).catch(() => {});
        // Hala sayi adindaysa: arka planda artan araliklarla TEKRAR TEKRAR dene
        if (/^\d+$/.test(chatName)) {
          retryGroupName(jid);
        }
        // gonderenin gercek numarasini cozmeye calis (LID ise alternatif alanlardan)
        const altSender = m.key.participantPn || m.key.participantAlt || m.participantPn || null;
        const resolved = resolvePhone(m.key.participant || '', altSender);
        senderJid = resolved.jid;
        // gonderen adi ONCELIK: KAYITLI isim (savedContacts — kullanicinin kalici kayitlari)
        //  > pushName > onbellek > (LID degilse numara) > "Bilinmeyen"
        // Kayitli isim EN ONCE gelir ki ofis ekibi her grupta SABIT isimle gorunsun
        // (WhatsApp'in pushName'i degil, kullanicinin verdigi isim kullanilsin).
        const rNum = resolved.number ? (resolved.number + '@s.whatsapp.net') : '';
        const kayitliIsim = savedContacts.get(resolved.jid)
          || savedContacts.get(rNum)
          || savedContacts.get(m.key.participant || '');
        // KAYITLI isim varsa bu kisi OFIS EKIBI/elle kaydedilmis demektir -> isaretle.
        // Boylece panel, ofis ekibini gruptaki normal kisilerden ayirt edip rozet koyar.
        senderOfis = !!kayitliIsim;
        senderPush = kayitliIsim
          || m.pushName
          || contactNames.get(resolved.jid)
          || contactNames.get(m.key.participant || '')
          || (resolved.isLid ? 'Bilinmeyen kişi' : resolved.number);
        senderName = senderPush;
        // eslemeyi onbellege al (uye listesinde de kullanmak icin)
        if (m.key.participant && resolved.jid !== m.key.participant) {
          lidToPn.set(m.key.participant, resolved.jid);
        }
        // gonderenin adini onbellege al — HER FORMATTA (LID, cozulmus jid, numara@s.whatsapp.net).
        // Boylece bu kisi SONRADAN ETIKETLENINCE (farkli formatta gelse bile) adi bulunur.
        // (Sorun: Yusuf gruba yazinca "Yusuf" gorunuyordu ama etiketlenince "@kişi" cikiyordu —
        //  cunku etiket farkli kimlikle geliyordu. Artik numara bazinda da kayitli.)
        if (m.pushName) {
          contactNames.set(senderJid, m.pushName);
          if (m.key.participant) contactNames.set(m.key.participant, m.pushName);
          if (rNum) contactNames.set(rNum, m.pushName);
          if (resolved.number) contactNames.set(resolved.number + '@s.whatsapp.net', m.pushName);
        }
      } else {
        // kisi sohbeti: KAYITLI isim (rehber/kalici) > pushName > numara
        const kNum = (jid.split('@')[0]) + '@s.whatsapp.net';
        const rehber = savedContacts.get(jid) || savedContacts.get(kNum);
        senderName = rehber || m.pushName || contactNames.get(jid) || chatName;
        chatName = rehber || m.pushName || contactNames.get(jid) || chatName;
        if (m.pushName && !rehber) contactNames.set(jid, m.pushName);
      }

      // Profil fotosu (sohbet/grup avatari) — ağ beklemesi olmasin diye mesaji
      // bekletmeden, addMessage'tan SONRA arka planda cekiyoruz (asagida).
      let avatarUrl = CC.get(jid)?.avatar || null;

      // NOT: Medya (foto/video/ses/belge) indirme de ağ islemidir ve yogunlukta
      // mesajlari bekletir. Mesaji once metin/kayit olarak DUSURUP medyayi arka
      // planda indiriyoruz; indi mi addMessage tekrar cagrilip mediaUrl guncellenir.
      const hasMedia = ['image', 'video', 'audio', 'document', 'sticker'].includes(info.kind);

      // Onizleme (jpegThumbnail): FOTOGRAF + belge + video icin.
      // Mesajla birlikte gelen kucuk onizlemeyi ANINDA gosteririz; tam cozunurluk arkada iner.
      // (WhatsApp boyle yapar — foto hemen gorunur, beklemezsin.)
      let thumbUrl = null;
      try {
        const docMsg = m.message?.documentMessage || m.message?.documentWithCaptionMessage?.message?.documentMessage;
        const thumb = m.message?.imageMessage?.jpegThumbnail   // <-- FOTOGRAF onizlemesi (yeni)
                   || docMsg?.jpegThumbnail
                   || m.message?.videoMessage?.jpegThumbnail;
        if (thumb && thumb.length) {
          const tname = `thumb_${Date.now()}_${Math.random().toString(36).slice(2,6)}.jpg`;
          const buf = Buffer.isBuffer(thumb) ? thumb : Buffer.from(thumb, 'base64');
          fs.writeFileSync(path.join(MEDIA_DIR, tname), buf);
          thumbUrl = '/media/' + tname;
        }
      } catch (e) {}

      // Eger gelen mesaj bir baska mesaja yanitsa, onun onizlemesini cek
      let incomingReply = null;
      const ctx = m.message?.extendedTextMessage?.contextInfo
                || m.message?.imageMessage?.contextInfo
                || m.message?.videoMessage?.contextInfo;
      if (ctx?.quotedMessage) {
        const q = ctx.quotedMessage;
        let qText = q.conversation || q.extendedTextMessage?.text
          || (q.imageMessage ? '📷 Fotoğraf' : '')
          || (q.audioMessage ? '🎤 Sesli mesaj' : '')
          || (q.documentMessage ? '📄 ' + (q.documentMessage.fileName || 'Belge') : '')
          || '';
        // alintilanan kisinin ismini bul (LID/numara yerine)
        const qpRaw = ctx.participant || '';
        let qSender = contactNames.get(qpRaw) || '';
        if (!qSender) {
          const r = resolvePhone(qpRaw, null);
          // LID ise ismi yoksa "biri" de, gercek numara ise numarayi goster
          qSender = r.isLid ? 'biri' : (contactNames.get(r.jid) || r.number);
        }
        incomingReply = {
          id: ctx.stanzaId || null,  // alintilanan mesajin id'si — panelde tiklayinca ona gitmek icin
          sender: qSender,
          text: qText,
        };
      }

      // Mesaj iletilmis mi? (forward)
      const anyCtx = m.message?.extendedTextMessage?.contextInfo
                  || m.message?.imageMessage?.contextInfo
                  || m.message?.videoMessage?.contextInfo
                  || m.message?.documentMessage?.contextInfo
                  || m.message?.audioMessage?.contextInfo;
      const isForwarded = !!(anyCtx?.isForwarded || (anyCtx?.forwardingScore > 0));

      // Metindeki @etiketleri isimle degistir (LID/garip numara gizlensin)
      // + panele gidecek mention eslemesini (isim->numara) hazirla.
      let msgMentions = [];
      if (info.text && anyCtx?.mentionedJid?.length) {
        // grup uye listesini (varsa) ver ki etiketlenen kisi uyeyse adi/numarasi bulunabilsin
        const chatUyeleri = (isGroup && CC.get(jid)?.members) || null;
        const pm = prettifyMentions(info.text, anyCtx.mentionedJid, chatUyeleri);
        info.text = pm.text;
        msgMentions = pm.mentions;
      }

      // Beni etiketlemis mi? (mentionedJid icinde benim numaram VEYA LID'im var mi)
      let mentionsMe = false;
      let bahsedilmeKime = undefined; // ortak hat etiketlenince: bu bahsedilme kimlere ait
      if (!fromMe && anyCtx?.mentionedJid?.length) {
        mentionsMe = anyCtx.mentionedJid.some(mj => {
          const num = (mj || '').split('@')[0];
          return (myNum && num === myNum) || (myLidV && num === myLidV);
        });
        if (mentionsMe) {
          console.log(`   🔔 BAHSEDILME: ${chatName || jid.split('@')[0]}`);
          // Ortak hat etiketlendi. Bu grup birine ETIKETLENMIS mi?
          const atananlar = chatAssignments.get(jid) || [];
          if (atananlar.length) {
            // gruba etiketlenenler varsa: bahsedilme SADECE onlara ait
            bahsedilmeKime = atananlar;
          } else {
            // grup kimseye etiketlenmemis: yoneticilere ait (panel role==='admin' kontrol eder)
            bahsedilmeKime = '__admins__';
          }
        }
      }

      // TAKİP UYARISI (çizgi mantığı): grupta mesaj geldi. En son mesaj ÇİZGİ (---- ====)
      // DEĞİLSE 3 dk sonra hâlâ çizgi/mesaj gelmezse yöneticiye "iş yarım kalmış olabilir" uyarısı.
      // Çizgi gelirse = işlem bitti, uyarı iptal. (Hem bizim hem müşteri mesajı sayılır.)
      if (isGroup) {
        // "Bizden" sayılma: panel/hat üzerinden (fromMeOrijinal) VEYA kayıtlı ofis ekibi kişisi (senderOfis).
        const bizdenMi = fromMeOrijinal || senderOfis;
        const takipKisi = bizdenMi ? 'Ekip' : (senderName || senderPush || '');
        const takipGrupAd = (CC.get(jid)?.name) || (jid || '').split('@')[0];
        takipKontrol(jid, info.text, takipKisi, takipGrupAd, lineId, isGroup, bizdenMi);
      }

      addMessage(jid, {
        id: m.key.id,
        raw: m,
        key: m.key,
        fromMe: fromMe,
        kind: info.kind,
        text: info.text,
        caption: info.caption || '', // belge/dosya aciklamasi (varsa)
        fileName: info._fileName || undefined, // belge adi (iletme icin saklanir)
        mime: info._mime || undefined,         // belge tipi (iletme icin saklanir)
        mediaUrl: null, // medya arka planda inecek; indince addMessage tekrar guncelleyecek
        thumb: thumbUrl,
        contact: info._contact || null,
        contacts: info._contacts || null,
        sender: fromMe ? 'Ben' : senderName,
        senderJid,
        senderPush,
        senderOfis, // bu kisi ofis ekibi/kayitli mi (panelde rozet icin)
        time: nowTime(),
        replyTo: incomingReply,
        forwarded: isForwarded,
        mentionsMe,
        bahsedilmeKime, // ortak hat etiketlenince: bu bahsedilme kimlere ait (panel suzer)
        mentions: msgMentions,
      }, { name: chatName, description, avatar: avatarUrl, memberCount, members, mentionsMe }, lineId);

      // --- SATIŞ KOMUTU KONTROLÜ: "/trafik2" gibi mesajlar satis olarak kaydedilir ---
      // Sadece GRUP mesajlarinda + metin mesajlarinda kontrol et (DM'de satis sayma).
      // Satici = mesaji yazan kisi (grup uyesi pazarlamaci). Musteri de atabilir ama
      // o zaman satici musteri gorunur — kullanici "mesaji kim yazdiysa o satici" dedi.
      if (isGroup && info.kind === 'text') {
        const satis = satisAyristir(info.text);
        if (satis) {
          // satici: fromMe ise hat sahibi (ben), degilse mesaji yazan kisi
          const saticiAdi = fromMe ? (line?.myName || 'Ben') : (senderName || senderPush || '');
          const saticiJid2 = fromMe ? (myNum ? myNum + '@s.whatsapp.net' : '') : (senderJid || '');
          const chatObj = CC.get(jid);
          satisKaydet(m, satis, lineId, chatObj, saticiAdi, saticiJid2).catch(() => {});
        }
        // --- AKTİVİTE MESAJI: "ilgileniyorum/kesiyorum" vb. (yanlış yazım dahil) ---
        // SADECE GERÇEK EKİP ÜYELERİ (panel kullanıcısı) sayılır. Müşteri/rastgele kayıtlı
        // kişi yazınca SAYILMAZ. fromMe (panelden gönderilen) VEYA mesajı yazan panel kullanıcısı.
        const aktKisiAdiOn = fromMe ? (line?.myName || 'Ben') : (senderName || senderPush || '');
        const sayilsinMi = fromMe || ekipUyesiMi(aktKisiAdiOn);
        if (sayilsinMi) {
          const akt = aktiviteMesajiTespit(info.text);
          if (akt && db.isReady()) {
            const chatObj2 = CC.get(jid);
            const aktKisiAdi = aktKisiAdiOn;
            const aktId = 'akt_' + lineId + '_' + (m.key?.id || (Date.now() + '_' + Math.random().toString(36).slice(2, 8)));
            db.saveAktivite({
              id: aktId,
              lineId,
              kullanici: '', // grup mesajında panel kullanıcı adı yok; ad ile takip edilir
              kullaniciAd: aktKisiAdi,
              chatJid: jid,
              chatName: chatObj2?.name || (jid || '').split('@')[0],
              tur: akt.tur,
              hamMesaj: (info.text || '').slice(0, 80),
              ts: m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now(),
            }).catch(() => {});
          }
        }
      }

      // --- ARKA PLAN: medya + avatar indir (mesaji bekletmeden) ---
      // Medya indip diske yazilinca addMessage'i ayni id ile tekrar cagiririz;
      // addMessage var olan mesajin mediaUrl'unu doldurup panele + DB'ye yansitir.
      if (hasMedia) {
        // HIZLI DENEME: çoğu medya ilk saniyelerde iner.
        // GRUP medyası (poliçe/ruhsat/dekont) iş kritik -> daha ısrarcı (4 deneme).
        // İnmezse VAZGEÇMEZ -> kalıcı kuyruğa devreder (grup medyası orada da öncelikli).
        const grupMedyasi = String(jid || '').endsWith('@g.us');
        const hizliMax = grupMedyasi ? 4 : 3;
        const medyaIndirRetry = async (deneme = 1) => {
          try {
            const url = await saveMedia(m, info.kind, sock);
            if (url) {
              addMessage(jid, { id: m.key.id, mediaUrl: url, fromMe }, {}, lineId);
              return; // basarili
            }
          } catch (e) { /* asagida tekrar denenecek */ }
          if (deneme < hizliMax) {
            const bekle = 3000 * Math.pow(2, deneme - 1); // 3s, 6s, 12s
            console.log(`   ⏳ medya inmedi (hızlı ${deneme}/${hizliMax}${grupMedyasi ? ', GRUP' : ''}), ${bekle / 1000}sn sonra tekrar: ${String(m.key.id).slice(0, 10)}`);
            setTimeout(() => medyaIndirRetry(deneme + 1), bekle);
          } else {
            // ARTIK PES ETMİYORUZ: kalıcı kuyruğa al (grup medyası orada öncelikli işlenir)
            medyaKuyrugaEkle(m, info.kind, jid, lineId, sock);
          }
        };
        medyaIndirRetry(1);
      }
      // Avatar daha onceden yoksa arka planda cek (sohbet basligi/listesi icin)
      if (!avatarUrl) {
        getAvatar(jid).then((url) => {
          const c = CC.get(jid);
          if (url && c && !c.avatar) {
            c.avatar = url;
            broadcastHat(lineId, { type: 'message', jid, chat: stripRaw(c) });
            if (db.isReady()) db.saveChat(c, lineId).catch(() => {});
          }
        }).catch(() => {});
      }

      const label = info.kind === 'text' ? info.text : `[${info.kind}]${info.text ? ' ' + info.text : ''}`;
      console.log(isGroup ? `👥 [${chatName}] ${senderName}: ${label}` : `💬 ${chatName}: ${label}`);
     } catch (err) {
       console.error('⚠️  Mesaj islenirken hata (atlandi):', err.message);
     }
    }
  });
}

server.listen(PORT, async () => {
  console.log(`🌐 Panel hazir: http://localhost:${PORT}`);
  // 1) Supabase'i baslat ve test et
  db.init();
  const dbOk = await db.test();
  await bagimsizOkumaYukle(); // bağımsız okuma yan-rolü listesini belleğe al
  db.startKeepAlive(15);
  db.startCleanup();

  // ═══════════════════════════════════════════════════════════════════
  // SIRA: ÖNCE tüm veri yüklenir, SONRA WhatsApp bağlanır.
  // ⚠️ ÖNEMLİ DERS: Bir ara "kesintiyi azaltmak için" WhatsApp'ı paralel başlatmıştım.
  //   Ama bu SOHBET KAYBINA yol açtı: WhatsApp bağlanınca gördüğü ~800 sohbeti belleğe
  //   yazıyor, sonra Supabase'den gelen 3800+ sohbet "bellekte var, ezmeyeyim" diye
  //   ATLANIYORDU -> panelde 3800 yerine 800 sohbet kalıyordu ("kendini sıfırlıyor").
  //   Doğru sıra: önce TÜM eski veri yüklensin, üstüne WhatsApp gelsin. Birkaç saniye
  //   ekstra kesinti, veri kaybından çok daha iyidir.
  // ═══════════════════════════════════════════════════════════════════
  if (dbOk) {
    const adminUser = process.env.ADMIN_USER || 'burak';
    const adminPass = process.env.ADMIN_PASS || 'pekcan';
    await db.ensureAdmin(adminUser, adminPass, 'Burak Pekcan');
    const t0 = Date.now();
    await loadFromDB();          // TÜM sohbetler önce yüklensin
    await izinliIpleriYukle();
    console.log(`   📦 ${chats.size} sohbet yuklendi (${((Date.now() - t0) / 1000).toFixed(1)}sn). Simdi WhatsApp baglanacak.`);
  } else {
    console.log('   ⚠️  Supabase kapali — veriler sadece bellekte tutulacak (eskisi gibi).');
  }

  console.log('   (WhatsApp baglantisi baslatiliyor...)');
  const credsPath = path.join(__dirname, 'auth', 'creds.json');
  if (fs.existsSync(credsPath)) {
    console.log('   🔁 Kayitli oturum bulundu, otomatik baglaniliyor...');
  } else {
    console.log('   📱 Oturum yok — QR uretiliyor, panelden okutun.');
  }
  startWA(); // <-- veri yüklendikten SONRA
});

// Supabase'den tum veriyi bellege yukle (acilista)
// Supabase'den tum veriyi bellege yukle (acilista).
// WhatsApp'tan ÖNCE calisir -> tum sohbetler eksiksiz yuklenir, sonra WhatsApp ustune gelir.
async function loadFromDB() {
  try {
    const data = await db.loadAll();
    let n = 0;
    for (const row of data.chats) {
      chats.set(row.jid, {
        jid: row.jid,
        name: row.custom_name || row.name || row.jid.split('@')[0],
        isGroup: row.is_group,
        description: row.description || '',
        avatar: row.avatar || null,
        memberCount: row.member_count || 0,
        members: row.members || [],
        messages: [], // mesajlar sohbet acilinca yuklenecek (performans)
        unread: row.unread || 0,
        ozelUnread: row.ozel_unread || 0,
        muhUnread: row.muh_unread || 0,
        lastTime: row.last_time || '',
        lastTs: Number(row.last_ts) || 0,
        pinned: row.pinned || false,
        archived: row.archived || false,
        hasMention: row.has_mention || false,
        customName: row.custom_name || null,
        _fromDB: true, // bu sohbet DB'den geldi (mesajlari henuz yuklenmedi)
      });
      n++;
    }
    // kayitli isimler
    let manuelSayisi = 0;
    for (const c of data.contacts) {
      if (c.is_manual) { savedContacts.set(c.jid, c.name); manuelSayisi++; }
      contactNames.set(c.jid, c.name);
    }
    if (manuelSayisi) console.log(`📇 ${manuelSayisi} kalici isim yuklendi (ofis ekibi vs.)`);
    // OTURUMLAR: kayitli token'lari bellege yukle (restart sonrasi kimse atilmasin)
    try {
      const oturumlar = await db.loadSessions();
      for (const r of oturumlar) sessions.set(r.token, { username: r.username, displayName: r.display_name, role: r.role, ts: Date.now() });
      if (oturumlar.length) console.log(`🔑 ${oturumlar.length} oturum yuklendi (kullanicilar atilmadi)`);
    } catch (e) {}
    // ATAMALAR: hangi grup kime atanmis (Supabase'den yukle)
    try {
      const atamalar = await db.loadAssignments();
      let sayac = 0;
      for (const [cjid, users] of Object.entries(atamalar)) {
        chatAssignments.set(cjid, users);
        sayac += users.length;
      }
      if (sayac) console.log(`👤 ${Object.keys(atamalar).length} grup atamasi yuklendi (${sayac} atama)`);
    } catch (e) {}
    // ETIKETLER: etiket tanimlari + grup-etiket baglantilari (Supabase'den yukle)
    try {
      labels = await db.loadLabels();
      const cl = await db.loadChatLabels();
      for (const [cjid, ids] of Object.entries(cl)) chatLabels.set(cjid, ids);
      if (labels.length) console.log(`🏷️  ${labels.length} etiket yuklendi`);
    } catch (e) {}
    console.log(`📂 Supabase'den yuklendi: ${n} sohbet, ${data.contacts.length} kayitli isim`);
  } catch (e) {
    console.error('⚠️  DB yukleme hatasi:', e.message);
  }
}

// ---- GUVENLIK AGI: hicbir yakalanmayan hata sunucuyu kapatmasin ----
// Medya indirme, ag kopmasi gibi beklenmedik hatalarda sunucu cokmek yerine
// hatayi loglar ve calismaya devam eder.
process.on('uncaughtException', (err) => {
  console.error('⚠️  Yakalanmayan hata (sunucu calismaya devam ediyor):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Islenmeyen reddetme (sunucu calismaya devam ediyor):', reason?.message || reason);
});
