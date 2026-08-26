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
let sonSaglik = { bagli: false, durumMetni: 'baslamadi', numara: null };

function log(...a) { (B && B.log ? B.log : console.log)('[whapi]', ...a); }

// ── MUKERRER KORUMASI ────────────────────────────────────────
// Whapi kalici webhook ACIK: basarisiz olursa 24 kez tekrar dener.
// DB'deki (line_id, chat_jid, id) birincil anahtari satir cogaltmayi
// onler AMA panele ikinci kez 'msgAppend' gitmesini onlemez.
// Bu yuzden gorulen kimlikleri burada da tutuyoruz. Surec yeniden
// baslarsa diskten geri yukleniyor.
const GORULEN_DOSYA = path.join(__dirname, 'guvence', 'whapi-gorulen.txt');
const GORULEN_TAVAN = 8000;
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

function gorulenEkle(id) {
  gorulen.add(id);
  try {
    fs.appendFileSync(GORULEN_DOSYA, id + '\n', 'utf8');
    gorulenYazimSayaci += 1;
    // Dosya sismesin: her 2000 yazimda sadece bellekte kalanlari geri yaz
    if (gorulenYazimSayaci >= 2000) {
      gorulenYazimSayaci = 0;
      const kalan = Array.from(gorulen).slice(-GORULEN_TAVAN);
      gorulen.clear();
      for (const k of kalan) gorulen.add(k);
      fs.writeFileSync(GORULEN_DOSYA, kalan.join('\n') + '\n', 'utf8');
    }
  } catch (_) {}
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
function medyaArkaPlanda(jid, mesajId, indir, deneme = 1) {
  const enFazla = String(jid).endsWith('@g.us') ? 4 : 3;   // grup medyasi is kritik
  medyaIndir(indir.link, indir.mime, indir.dosyaAdi)
    .then((url) => {
      if (!url) throw new Error('bos yol');
      B.addMessage(jid, { id: mesajId, mediaUrl: url, fromMe: false }, {}, LINE_ID);
    })
    .catch((e) => {
      if (deneme < enFazla) {
        const bekle = 3000 * Math.pow(2, deneme - 1);   // 3s, 6s, 12s
        log(`medya inmedi (${deneme}/${enFazla}), ${bekle / 1000}sn sonra tekrar: ${String(mesajId).slice(0, 10)} — ${e.message}`);
        setTimeout(() => medyaArkaPlanda(jid, mesajId, indir, deneme + 1), bekle);
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

function gonderenZenginlestir(message) {
  // KENDI mesajimizsa DOKUNMA. Aksi halde rehberdeki isim 'Ben' yazisini
  // eziyor ve panelde kendi mesajimiz baskasindan gelmis gibi gorunuyordu.
  if (message.fromMe) { message.sender = 'Ben'; return; }
  const numara = String(message.senderJid || '').split('@')[0];
  if (!numara) return;

  // 1) Numara BIZIM baska bir hattimiz mi? (ofis Baileys, pazarlama hatlari)
  if (kendiHatlarimiz().has(numara)) {
    message.senderOfis = true;
    return;
  }
  // 2) CRM rehberinde kayitli mi? (savedContacts / contactNames)
  const rehber = (B.kisiAdiBul && B.kisiAdiBul(numara + '@s.whatsapp.net')) || '';
  if (rehber) {
    message.senderOfis = true;                       // kayitli isim = ekip/taninan kisi
    message.sender = rehber;                         // KAYITLI isim once gelir (Baileys de boyle)
    message.senderPush = rehber;
    return;
  }
  // 3) Gonderenin adi panel kullanicisi mi? (ekip uyesi)
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
}

// ── ZARFI ISLE (webhook ucunun cagirdigi ana fonksiyon) ──────
// SENKRON kisim: addMessage cagrilir -> mesaj-guvence JSONL'e YAZAR.
// Bu bittiginde mesaj kalicidir, ancak o zaman 200 doneriz.
function zarfIsle(zarf) {
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
  const ozet = { mesaj: 0, mukerrer: 0, tepki: 0, sil: 0, duzenle: 0, durum: 0, eski: 0, atla: 0, hedefYok: 0 };

  for (const is of isler) {
    if (is.tur === 'atla') {
      if (String(is.sebep || '').startsWith('eski mesaj')) ozet.eski += 1; else ozet.atla += 1;
      continue;
    }
    if (is.tur === 'durum')   { if (durumUygula(is))       ozet.durum += 1;   else ozet.hedefYok += 1; continue; }

    if (is.tur === 'tepki')   { if (tepkiUygula(is))      ozet.tepki += 1;   else ozet.hedefYok += 1; continue; }
    if (is.tur === 'sil')     { if (silmeUygula(is))      ozet.sil += 1;     else ozet.hedefYok += 1; continue; }
    if (is.tur === 'duzenle') { if (duzenlemeUygula(is))  ozet.duzenle += 1; else ozet.hedefYok += 1; continue; }

    // ── NORMAL MESAJ ──
    if (gorulen.has(is.message.id)) { ozet.mukerrer += 1; continue; }
    gorulenEkle(is.message.id);

    // Onizleme varsa diske yaz -> foto aninda gorunur
    if (is.onizleme) {
      const t = onizlemeYaz(is.onizleme);
      if (t) is.message.thumb = t;
    }

    // Gonderen kendi hattimiz/ekibimiz mi -> panelde rozet gorunsun
    try { gonderenZenginlestir(is.message); } catch (_) {}

    // NOT: "ayni metin = yansima" gibi bir tahmin YAPMIYORUZ.
    // Iki kisi ayni anda cizgi cekerse veya ayni mesaj bilerek iki kez
    // atilirsa ikincisi YUTULURDU. Mesaj kaybi kabul edilemez.
    // Yansima elemesi SADECE kimlik eslesmesiyle yapilir (addMessage + gorulen).

    // MEVCUT AKIS: addMessage -> broadcastHat + db.saveChat + mesajGuvence
    B.addMessage(is.jid, is.message, is.meta, LINE_ID);
    ozet.mesaj += 1;

    // Ag isleri mesaji BEKLETMEZ, hepsi addMessage'tan SONRA
    if (is.indir && is.indir.link) medyaArkaPlanda(is.jid, is.message.id, is.indir);
    if (is.isGroup) {
      // ADI HALA SAYI olan gruplar SIRANIN BASINA gecsin — kullanici
      // "grup adlari gec geliyor" dedi; adsiz grup en oncelikli is.
      const C = B.hatChats(LINE_ID);
      const c = C && C.get ? C.get(is.jid) : null;
      const adsiz = !c || !c.name || /^\d+$/.test(String(c.name));
      grupBilgisiTazele(is.jid, adsiz);
    }
  }
  return ozet;
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
      if (ozet.mesaj || ozet.tepki || ozet.sil || ozet.duzenle || ozet.durum || ozet.mukerrer || ozet.eski) {
        const parcalar = [];
        if (ozet.mesaj) parcalar.push(ozet.mesaj + ' mesaj');
        if (ozet.tepki) parcalar.push(ozet.tepki + ' tepki');
        if (ozet.sil) parcalar.push(ozet.sil + ' silme');
        if (ozet.duzenle) parcalar.push(ozet.duzenle + ' duzenleme');
        if (ozet.durum) parcalar.push(ozet.durum + ' tik');
        if (ozet.eski) parcalar.push(ozet.eski + ' ESKI mesaj elendi');
        if (ozet.mukerrer) parcalar.push(ozet.mukerrer + ' MUKERRER engellendi');
        if (ozet.hedefYok) parcalar.push(ozet.hedefYok + ' hedef bulunamadi');
        log(parcalar.join(' | '));
      }
    } catch (e) {
      // 500 = "alamadik". Whapi artan araliklarla 24 kez tekrar dener.
      log('WEBHOOK HATASI (Whapi tekrar deneyecek): ' + e.message);
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

  sock = adaptor.olustur({
    token: TOKEN, taban: TABAN, log,
    // Whapi'nin verdigi uye adlarini CRM rehberine yaz. server.js'in
    // kendi uye eslemesi (getGroupMembers) contactNames'ten okuyor;
    // bunu doldurmazsak panelde isim yerine NUMARA gorunur.
    adKaydet: (jid, ad) => { try { if (B.kisiAdiKaydet) B.kisiAdiKaydet(jid, ad); } catch (_) {} },
    gonderimOnaylandi: (jid, id, adaylar) => { gonderimTekTik(jid, id, adaylar); },
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

  return line;
}

// ── server.js'in cagirdigi kurulum ───────────────────────────
function kur(baglam, app, express) {
  B = baglam;
  kancaKur(app, express);
  return { hattiBaslat, LINE_ID, durum: () => sonSaglik, sock: () => sock };
}

module.exports = { kur, LINE_ID };
