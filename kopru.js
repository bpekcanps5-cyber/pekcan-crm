/* ═══════════════════════════════════════════════════════════════════════
   WAHA ↔ PANEL KOPRUSU  (TEST DUZENEGI)

   NE YAPAR:
     WAHA'nin olaylarini/verisini bizim panelin ANLADIGI bicime cevirir.
     Boylece index.html HIC DEGISMEDEN WAHA ile calisir ve gercekten
     nasil hissettirdigini gorursun.

   CANLI SISTEME DOKUNMAZ:
     • Ayri kutu, ayri port (3002), ayri oturum, ayri telefon
     • Baileys sunucusuna hicbir baglantisi yok
     • Veritabani KULLANMAZ (test verisi kalici degil, bellekte)

   NOT: Bu bir TEST koprusu. Amac "WAHA/GOWS bizim isimizi goruyor mu"
   sorusunu cevaplamak. Canliya gecis karari bundan SONRA verilir.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const WAHA_URL = process.env.WAHA_URL || 'http://localhost:3000';
const WAHA_API_KEY = process.env.WAHA_API_KEY || '';
const OTURUM = process.env.WAHA_OTURUM || 'test';
const PORT = Number(process.env.PORT) || 3002;
const KULLANICI = process.env.PANEL_KULLANICI || 'demo';
const SIFRE = process.env.PANEL_SIFRE || 'demo';
const MEDYA_DIZIN = path.join(__dirname, 'medya');
try { fs.mkdirSync(MEDYA_DIZIN, { recursive: true }); } catch (_) {}

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/medya', express.static(MEDYA_DIZIN));
app.use(express.static(__dirname));           // index.html buradan servis edilir

// ─────────────────────────── DURUM ───────────────────────────
const sohbetler = new Map();      // jid -> chat
const mesajlar = new Map();       // jid -> [msg]
const oturumlar = new Map();      // token -> kullanici
let bagliMi = false;
let sonQR = null;
let benimJid = '';
const istemciler = new Set();

const log = (...a) => console.log(new Date().toLocaleTimeString('tr-TR'), ...a);
const kimlik = (p) => p + '_' + Math.random().toString(36).slice(2, 10);
// SAAT: kutu UTC calissa bile Turkiye saatini yaz. (Docker kutulari
// varsayilan UTC; bu yuzden butun saatler 3 saat geri gorunuyordu.)
const SAAT_DILIMI = process.env.TZ || 'Europe/Istanbul';
const saat = (ts) => {
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: SAAT_DILIMI,
    }).format(new Date(ts));
  } catch (_) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
};

// ─────────────────────── WAHA'YA ISTEK ────────────────────────
async function waha(yol, secenek = {}) {
  const url = WAHA_URL + yol;
  const bas = { 'Content-Type': 'application/json' };
  if (WAHA_API_KEY) bas['X-Api-Key'] = WAHA_API_KEY;
  const r = await fetch(url, {
    method: secenek.method || 'GET',
    headers: bas,
    body: secenek.body ? JSON.stringify(secenek.body) : undefined,
  });
  const metin = await r.text();
  let veri = null;
  try { veri = metin ? JSON.parse(metin) : null; } catch (_) { veri = metin; }
  if (!r.ok) {
    const e = new Error(`WAHA ${r.status}: ${typeof veri === 'string' ? veri.slice(0, 200) : JSON.stringify(veri).slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  return veri;
}

// ───────────────────── PANELE YAYIN ──────────────────────────
// Panele giden her sohbette 'messages' dizisi OLMAK ZORUNDA — yoksa panel
// liste ciziminde cokuyor. Tek noktadan garanti altina aliyoruz.
// hafif=true -> "bu pakette sadece SON mesaj var, elindeki tam listeyi SILME"
// PANELIN KURALI: bu isaret yoksa panel, gonderdigimiz 1 mesajlik diziyi
// TAM liste sanip eldeki gecmisi EZIYOR. "Yeni mesaj gelince sadece son 2
// mesaj kaliyor" sorununun sebebi tam olarak buydu.
function sohbetGuvenli(c, hafif) {
  if (!c) return c;
  const kopya = Object.assign({}, c);
  if (!Array.isArray(kopya.messages) || hafif) {
    const ms = mesajlar.get(kopya.jid);
    kopya.messages = Array.isArray(ms) && ms.length ? [ms[ms.length - 1]] : (kopya.messages || []);
  }
  if (hafif) kopya._hafif = true;      // panel gecmisi korusun
  return kopya;
}
function sohbetListesi() {
  // Liste paketleri HAFIF: sadece son mesaj tasiyor, panelin gecmisini silmiyor.
  return [...sohbetler.values()].map((c) => sohbetGuvenli(c, true)).sort((a, b) => b.lastTs - a.lastTs);
}

function yayinla(paket) {
  const metin = JSON.stringify(paket);
  for (const ws of istemciler) {
    if (ws.readyState === 1) { try { ws.send(metin); } catch (_) {} }
  }
}

// ───────────── WAHA VERISINI PANEL BICIMINE CEVIR ─────────────
// WAHA surumleri arasinda alan adlari degisebiliyor; hepsini deniyoruz.
// ZAMAN DAMGASI — WAHA surumune/motoruna gore farkli alanda gelebiliyor.
// Bulamazsa 0 doner (Date.now() DEGIL) — cunku "simdi" koymak butun
// sohbetleri ayni saate esitliyor ve siralamayi bozuyor.
function zamanAl(x) {
  if (!x) return 0;
  const adaylar = [
    x.timestamp, x.t, x.messageTimestamp, x.time,
    x._data && x._data.t, x._data && x._data.timestamp,
    x.lastMessage && x.lastMessage.timestamp, x.lastMessage && x.lastMessage.t,
    x.conversationTimestamp, x.lastMessageTime,
  ];
  for (const a of adaylar) {
    const n = Number(a);
    if (!n || !isFinite(n)) continue;
    if (n > 1e12) return Math.round(n);
    if (n > 1e9) return Math.round(n * 1000);
  }
  return 0;
}

// "905399265440:98@s.whatsapp.net" -> "905399265440@s.whatsapp.net"
// WhatsApp numaranin sonuna cihaz numarasi ekliyor, temizliyoruz.
function numaraDuzelt(j) {
  if (!j) return '';
  const s2 = String(j);
  if (!s2.includes('@')) return '';
  const [sol, sag] = s2.split('@');
  return sol.split(':')[0] + '@' + sag;
}
// @lid -> gercek numara eslesmesi (bir kez ogrenince hep kullaniriz)
const lidNumara = new Map();

function jidAl(x) {
  return x?.id?._serialized || x?.id || x?.chatId || x?.from || x?.jid || '';
}
function grupMu(jid) { return String(jid).includes('@g.us'); }

function sohbeteCevir(c) {
  const jid = jidAl(c);
  // WAHA surumune gore isim farkli alanda gelebiliyor; hepsini deniyoruz.
  const ad = c.name || c.subject || c.pushName || c.formattedTitle
    || c.contact?.name || c.contact?.pushname || c.contact?.pushName
    || c.chat?.name || c.notifyName
    || (jid.split('@')[0]);
  return {
    jid,
    name: ad,
    isGroup: grupMu(jid),
    description: c.description || c.desc || '',
    memberCount: c.participantsCount || (c.participants || []).length || 0,
    members: (c.participants || []).map((p) => ({ jid: jidAl(p), name: p.name || '', number: String(jidAl(p)).split('@')[0] })),
    unread: c.unreadCount || 0,
    ozelUnread: c.unreadCount || 0,
    muhUnread: 0,
    lastTime: zamanAl(c) ? saat(zamanAl(c)) : '',
    lastTs: zamanAl(c),
    pinned: !!c.pinned, archived: !!c.archived, hasMention: false,
    avatar: c.picture || c.profilePicUrl || null,   // WAHA 'picture' aninda veriyor
    // ZORUNLU: panel liste ciziminde c.messages[son] okuyor. Bu alan
    // olmazsa cizim COKUYOR ve liste bos gorunuyor (462 sohbet gelse bile).
    // WAHA sohbet listesinde son mesaji veriyorsa onu koyuyoruz.
    messages: (c.lastMessage || c.lastMsg) ? [mesajaCevir(c.lastMessage || c.lastMsg)] : [],
  };
}

// Mesajda kimlerden bahsedilmis (@etiket)
function bahsedilenler(m, bilgi) {
  const ham = m.mentionedIds || m.mentions
    || (m._data && m._data.Message && m._data.Message.extendedTextMessage
        && m._data.Message.extendedTextMessage.contextInfo
        && m._data.Message.extendedTextMessage.contextInfo.mentionedJID)
    || [];
  return (Array.isArray(ham) ? ham : []).map((x) => numaraDuzelt(x) || x);
}
// Bizden bahsedilmis mi?
function bendenBahsedilmis(m, bilgi) {
  if (!benimJid) return false;
  const benimNum = String(benimJid).split('@')[0].split(':')[0];
  return bahsedilenler(m, bilgi).some((x) => String(x).includes(benimNum));
}

function mesajaCevir(m) {
  // GERCEK WAHA (GOWS) yapisi — sunucudan alinan ornekle dogrulandi:
  //   id: duz metin ("false_120363...@g.us_3EB00A...")
  //   timestamp: saniye
  //   body, from, fromMe, hasMedia, ack
  //   _data.Info.PushName  -> gonderenin adi
  //   _data.Info.Sender    -> gonderenin kimligi
  //   _data.Info.Type      -> "text" / "image" / ...
  //   _data.Info.IsGroup   -> grup mu
  const bilgi = (m._data && m._data.Info) || {};
  const tsMs = zamanAl(m) || Date.now();

  let kind = 'text';
  const tip = String(m.type || bilgi.Type || m.mediaType || '').toLowerCase();
  const medyaVar = !!(m.hasMedia || m.media);
  if (/image|photo/.test(tip)) kind = 'image';
  else if (/video/.test(tip)) kind = 'video';
  else if (/audio|ptt|voice/.test(tip)) kind = 'audio';
  else if (/document|pdf/.test(tip)) kind = 'document';
  else if (/sticker/.test(tip)) kind = 'sticker';
  else if (medyaVar) kind = 'document';

  // Gonderen adi: once PushName (WAHA burada veriyor), sonra digerleri
  const gonderenAd = bilgi.PushName || m.notifyName || m.pushName
    || (m._data && m._data.notifyName) || m.author || (m.fromMe ? 'Ben' : '');
  // Gonderen kimligi: gruplarda katilimci, kisilerde sohbetin kendisi
  // GERCEK NUMARA: GOWS gruplarda "@lid" (gizli kimlik) kullaniyor.
  // Gercek telefon numarasi SenderAlt icinde geliyor. Panelde numara
  // gorunmesi ve kisi eslestirmesi icin ONCE onu tercih ediyoruz.
  const gercekNumara = bilgi.SenderAlt || bilgi.RecipientAlt || '';
  const gonderenJid = numaraDuzelt(gercekNumara) || m.participant || bilgi.Sender || m.author || '';

  // @lid <-> gercek numara eslesmesini ogren (grup uyelerinde ise yarayacak)
  try {
    if (bilgi.Sender && gercekNumara) lidNumara.set(bilgi.Sender, numaraDuzelt(gercekNumara));
  } catch (_) {}

  const govde = m.body || m.text || m.caption || '';
  const medya = m.media || {};

  return {
    id: (m.id && m.id._serialized) || m.id || kimlik('m'),
    text: govde,
    caption: m.caption || '',
    kind,
    fromMe: !!(m.fromMe || bilgi.IsFromMe),
    sender: gonderenAd,
    senderJid: gonderenJid,
    ts: tsMs,
    time: saat(tsMs),
    durum: (m.fromMe || bilgi.IsFromMe)
      ? (Number(m.ack) >= 3 ? 4 : Number(m.ack) === 2 ? 3 : Number(m.ack) >= 1 ? 2 : 1)
      : 0,
    mediaUrl: medya.url || m.mediaUrl || null,
    fileName: medya.filename || medya.fileName || (m._data && m._data.filename) || '',
    mimeType: medya.mimetype || '',
    // BAHSEDILME: mesajda bizden bahsedilmis mi (panelde kirmizi vurgu)
    mentions: bahsedilenler(m, bilgi),
    mentionsMe: bendenBahsedilmis(m, bilgi),
  };
}

// ═══ MEDYA INDIRME ══════════════════════════════════════════════════
// Sigorta isinde medya cok kritik: ruhsat fotografi, police PDF'i, dekont.
// WAHA medyayi kendi adresinde tutuyor; biz indirip panelin gorebilecegi
// yere koyuyoruz (/medya/...). Panel WAHA'ya dogrudan erisemeyebilir.
const _medyaIniyor = new Set();

function uzantiBul(mime, ad) {
  if (ad && ad.includes('.')) {
    const u = ad.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (u && u.length <= 5) return u;
  }
  const m = String(mime || '').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('sheet') || m.includes('excel')) return 'xlsx';
  if (m.includes('word')) return 'docx';
  return 'bin';
}

async function medyaIndir(jid, m) {
  const kaynak = (m.media && m.media.url) || m.mediaUrl;
  if (!kaynak || _medyaIniyor.has(m.id)) return null;
  _medyaIniyor.add(m.id);
  try {
    const url = kaynak.startsWith('http') ? kaynak : (WAHA_URL + kaynak);
    const bas = WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {};
    const r = await fetch(url, { headers: bas });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('bos dosya');
    const ext = uzantiBul(m.mimeType, m.fileName);
    const ad = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    fs.writeFileSync(path.join(MEDYA_DIZIN, ad), buf);
    const yol = '/medya/' + ad;
    log(`📎 medya indi: ${m.fileName || m.kind} (${(buf.length / 1024).toFixed(0)} KB)`);

    // mesaji guncelle + panele bildir
    const liste = mesajlar.get(jid) || [];
    const hedef = liste.find((x) => x.id === m.id);
    if (hedef) { hedef.mediaUrl = yol; hedef.indiriliyor = false; }
    m.mediaUrl = yol;
    yayinla({ type: 'msgUpdate', jid, mesaj: hedef || m });
    return yol;
  } catch (e) {
    log(`✗ medya inmedi (${m.fileName || m.kind}): ${e.message}`);
    return null;
  } finally { _medyaIniyor.delete(m.id); }
}

// ───────────────── WAHA'DAN SOHBETLERI YUKLE ─────────────────
// Kendi numaramizi WAHA'dan ogren — bahsedilme tespiti ve "ben kimim"
// bilgisi icin sart. Oturum bilgisinde 'me' alaninda geliyor.
async function kimligimiOgren() {
  try {
    const s2 = await waha(`/api/sessions/${OTURUM}`);
    const ben = s2.me || s2.user || {};
    benimJid = numaraDuzelt(ben.id || ben.jid || '') || ben.id || '';
    if (benimJid) log('👤 kimlik: ' + (ben.pushName || ben.name || '') + ' (' + benimJid + ')');
    return benimJid;
  } catch (e) { log('kimlik alinamadi: ' + e.message); return ''; }
}

// GRUPLARI AYRICA CEK — sohbet listesi bazen grup adini/aciklamasini
// eksik veriyor. Bu cagri gruplarin TAMAMINI dogru bilgiyle getiriyor.
async function gruplariYukle() {
  const yollar = [`/api/${OTURUM}/groups`, `/api/groups?session=${OTURUM}`];
  let liste = null;
  for (const y of yollar) {
    try { const r = await waha(y); if (Array.isArray(r)) { liste = r; break; } } catch (_) {}
  }
  if (!liste) { log('grup listesi alinamadi (sohbet listesindeki bilgi kullanilacak)'); return 0; }
  let guncel = 0, yeni = 0;
  for (const g of liste) {
    const jid = jidAl(g);
    if (!jid) continue;
    const ad = g.subject || g.name || '';
    const aciklama = g.description || g.desc || '';
    let c = sohbetler.get(jid);
    if (!c) {
      c = {
        jid, name: ad || jid.split('@')[0], isGroup: true, description: aciklama,
        avatar: g.picture || null, memberCount: (g.participants || []).length, members: [],
        unread: 0, ozelUnread: 0, muhUnread: 0, lastTime: '', lastTs: 0,
        pinned: false, archived: false, hasMention: false, messages: [],
      };
      sohbetler.set(jid, c); mesajlar.set(jid, mesajlar.get(jid) || []);
      yeni++;
    } else {
      if (ad && (!c.name || /^\d+$/.test(c.name))) { c.name = ad; guncel++; }
      if (aciklama && !c.description) { c.description = aciklama; guncel++; }
      if (!c.memberCount && (g.participants || []).length) c.memberCount = g.participants.length;
      if (!c.avatar && g.picture) c.avatar = g.picture;
    }
  }
  if (yeni || guncel) {
    log(`👥 gruplar: ${yeni} yeni, ${guncel} bilgi guncellendi`);
    yayinla({ type: 'chats', chats: sohbetListesi(), append: false });
  }
  return liste.length;
}

async function sohbetleriYukle() {
  // SIRA ONEMLI: 'overview' daha zengin veri veriyor — kisi ISIMLERI ve
  // SON MESAJ dahil. Duz '/chats' cogu kisi icin isim vermiyor, o yuzden
  // listede telefon numaralari gorunuyordu.
  const yollar = [
    `/api/${OTURUM}/chats/overview?limit=500`,
    `/api/${OTURUM}/chats?limit=500`,
    `/api/chats?session=${OTURUM}&limit=500`,
  ];
  let liste = null, sonHata = null;
  for (const y of yollar) {
    try { const r = await waha(y); if (Array.isArray(r) && r.length !== undefined) { liste = r; log('✓ sohbetler alindi:', y, '->', r.length); break; } }
    catch (e) { sonHata = e; }
  }
  if (!liste) { log('✗ sohbetler alinamadi:', sonHata && sonHata.message); return; }

  for (const c of liste) {
    const s = sohbeteCevir(c);
    if (!s.jid) continue;
    sohbetler.set(s.jid, s);
    if (!mesajlar.has(s.jid)) mesajlar.set(s.jid, []);
  }
  log(`📋 ${sohbetler.size} sohbet yuklendi (${[...sohbetler.values()].filter(x => x.isGroup).length} grup)`);
  yayinla({ type: 'chats', chats: sohbetListesi(), append: false });
  // isimleri arka planda tamamla (listeyi bekletmesin)
  kisiAdlariniTamamla().catch(() => {});
}

// Kisi isimlerini rehberden tamamla. Sohbet listesinde ismi gelmeyen
// kisiler icin (listede telefon numarasi gorunenler) bu doldurur.
async function kisiAdlariniTamamla() {
  const yollar = [`/api/${OTURUM}/contacts/all`, `/api/contacts/all?session=${OTURUM}`, `/api/${OTURUM}/contacts`];
  let liste = null;
  for (const y of yollar) {
    try { const r = await waha(y); if (Array.isArray(r)) { liste = r; break; } } catch (_) {}
  }
  if (!liste) { log('kisi rehberi alinamadi (isimler numara olarak kalacak)'); return 0; }
  let duzelen = 0;
  for (const k of liste) {
    const jid = jidAl(k);
    if (!jid) continue;
    const ad = k.name || k.pushname || k.pushName || k.shortName || k.verifiedName || '';
    if (!ad) continue;
    const c = sohbetler.get(jid);
    if (c && (!c.name || /^\d+$/.test(c.name))) { c.name = ad; duzelen++; }
  }
  if (duzelen) {
    log(`👤 ${duzelen} kisinin ismi rehberden tamamlandi`);
    yayinla({ type: 'chats', chats: sohbetListesi(), append: false });
  }
  return duzelen;
}

async function mesajlariYukle(jid, adet = 100) {
  // ONEMLI: jid'i encodeURIComponent ile KODLAMIYORUZ. '@' -> '%40' olunca
  // WAHA sohbeti bulamiyor ve gecmis bos donuyordu ("sadece son 2 mesaj
  // gorunuyor" sorununun sebebi buydu).
  const yollar = [
    `/api/${OTURUM}/chats/${jid}/messages?limit=${adet}&downloadMedia=false`,
    `/api/${OTURUM}/chats/${jid}/messages?limit=${adet}`,
    `/api/messages?session=${OTURUM}&chatId=${jid}&limit=${adet}&downloadMedia=false`,
  ];
  for (const y of yollar) {
    try {
      const r = await waha(y);
      if (Array.isArray(r)) {
        // ═══ BIRLESTIR, UZERINE YAZMA ═══════════════════════════════
        // ESKIDEN: WAHA gecmisi elimizdekinin UZERINE yaziliyordu. Sohbet
        // acilirken yeni gelmis bir mesaj varsa SILINIYORDU (panelde
        // "mesaj dusmuyor" goruntusu). Artik ikisi birlestiriliyor.
        const gelen = r.map(mesajaCevir);
        const eldeki = mesajlar.get(jid) || [];
        const harita = new Map();
        for (const x of gelen) harita.set(x.id, x);
        for (const x of eldeki) if (!harita.has(x.id)) harita.set(x.id, x);
        const ms = [...harita.values()].sort((a, b) => a.ts - b.ts);
        mesajlar.set(jid, ms);
        // Son 25 mesajdaki medyayi indir (hepsini indirmek gereksiz yuk)
        ms.slice(-25).forEach((x) => {
          if (x.kind !== 'text' && !String(x.mediaUrl || '').startsWith('/medya/')) {
            medyaIndir(jid, x).catch(() => {});
          }
        });
        return ms;
      }
    } catch (_) {}
  }
  return mesajlar.get(jid) || [];
}

// ───────────────────── WAHA OLAYLARI (webhook) ─────────────────────
app.post('/waha/olay', (req, res) => {
  res.json({ ok: true });                 // WAHA'yi bekletme
  const olay = req.body || {};
  if (!global._ilkOlayGoruldu) {
    global._ilkOlayGoruldu = true;
    log('✅ WAHA olaylari geliyor (webhook calisiyor). Ilk olay: ' + (olay.event || olay.type || '?'));
  }
  const tip = olay.event || olay.type || '';
  const veri = olay.payload || olay.data || olay;

  try {
    // ── OTURUM DURUMU ──
    if (/session\.status|state\.change/.test(tip)) {
      const durum = String(veri.status || veri.state || '').toUpperCase();
      const oncekiBagli = bagliMi;
      bagliMi = /WORKING|CONNECTED|OPEN/.test(durum);
      log(`🔌 WAHA durum: ${durum} -> ${bagliMi ? 'BAGLI' : 'bagli degil'}`);
      yayinla({ type: 'status', connected: bagliMi, myJid: benimJid, myName: 'WAHA Test' });
      if (bagliMi && !oncekiBagli) {
        (async () => {
          await kimligimiOgren();
          await sohbetleriYukle().catch((e) => log('sohbet yukleme hatasi: ' + e.message));
          await gruplariYukle().catch(() => {});
        })();
      }
      if (veri.qr || veri.qrCode) { sonQR = veri.qr || veri.qrCode; }
      return;
    }

    // ── MESAJ DURUMU (tek/cift tik) ──
    if (/message\.ack|ack/.test(tip)) {
      // WAHA ack degerleri: 0 hata, 1 sunucuya gitti, 2 ulasti, 3 okundu, 4 sesli dinlendi
      // Panelin bekledigi: 1 tek tik, 2 gonderildi, 3 cift tik, 4 okundu(mavi)
      const jid = veri.chatId || veri.from || veri.to || jidAl(veri);
      const id = (veri.id && veri.id._serialized) || veri.id;
      const ham = Number(veri.ack != null ? veri.ack : veri.ackName === 'READ' ? 3 : 1);
      const durum = ham >= 3 ? 4 : ham === 2 ? 3 : ham >= 1 ? 2 : 1;
      if (!jid || !id) return;
      // bellekteki mesaji da guncelle (sohbet acilinca dogru tik gorunsun)
      const liste = mesajlar.get(jid) || [];
      const hedef = liste.find((x) => x.id === id);
      if (hedef && durum > (hedef.durum || 0)) hedef.durum = durum;
      yayinla({ type: 'msgStatus', jid, id, durum });
      return;
    }

    // ── YENI MESAJ ──
    if (/^message/.test(tip)) {
      const jid = veri.from || veri.chatId || jidAl(veri);
      if (!jid) return;
      if (!sohbetler.has(jid)) {
        sohbetler.set(jid, {
          jid, name: veri.notifyName || veri._data?.notifyName || jid.split('@')[0],
          isGroup: grupMu(jid), description: '', memberCount: 0, members: [],
          unread: 0, ozelUnread: 0, muhUnread: 0, lastTime: '', lastTs: 0,
          pinned: false, archived: false, hasMention: false, avatar: null, messages: [],
        });
        mesajlar.set(jid, []);
      }
      const m = mesajaCevir(veri);
      const liste = mesajlar.get(jid) || [];
      if (liste.some((x) => x.id === m.id)) return;      // ayni mesaji iki kez ekleme
      liste.push(m);
      if (liste.length > 400) liste.splice(0, liste.length - 400);
      mesajlar.set(jid, liste);

      const c = sohbetler.get(jid);
      c.lastTs = m.ts; c.lastTime = m.time;
      if (!m.fromMe) { c.unread = (c.unread || 0) + 1; c.ozelUnread = (c.ozelUnread || 0) + 1; }

      c.messages = [m];        // liste onizlemesi guncel kalsin
      // Medya varsa arka planda indir (mesaj hemen gorunsun, foto sonra gelsin)
      if (m.kind !== 'text' && (veri.hasMedia || veri.media)) {
        m.indiriliyor = true;
        medyaIndir(jid, m).catch(() => {});
      }
      log(`📩 ${c.isGroup ? '[grup]' : '[kisi]'} ${c.name}: ${(m.text || m.kind).slice(0, 50)}`);
      yayinla({ type: 'msgAppend', jid, mesaj: m });
      yayinla({ type: 'chatSync', jid, unread: c.unread, ozelUnread: c.ozelUnread, muhUnread: 0, lastTime: c.lastTime, lastTs: c.lastTs });
      // Sohbeti guncel haliyle de yolla: liste yeniden siralansin, yeni
      // sohbetse listeye eklensin, onizleme yazisi guncellensin.
      yayinla({ type: 'chats', chats: [sohbetGuvenli(c, true)], append: true });
      return;
    }
  } catch (e) { log('olay islenemedi:', e.message); }
});

// ═══ DOSYA GONDERME (panelden WhatsApp'a) ═══════════════════════════
// Panel dosyayi /upload?jid=..&name=..&mime=.. adresine HAM olarak POST eder.
// Sigorta isinde surekli kullaniliyor: police PDF'i, dekont, ruhsat fotosu.
app.post('/upload', express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
  const jid = req.query.jid;
  const ad = req.query.name || 'dosya';
  const mime = req.query.mime || 'application/octet-stream';
  const caption = req.query.caption || '';
  if (!jid || !req.body || !req.body.length) {
    return res.status(400).json({ ok: false, error: 'jid ve dosya zorunlu' });
  }
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
  const t0 = Date.now();
  try {
    const ext = uzantiBul(mime, ad);
    const kayitAd = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    fs.writeFileSync(path.join(MEDYA_DIZIN, kayitAd), buf);
    const yol = '/medya/' + kayitAd;

    const b64 = buf.toString('base64');
    const gorsel = /^image\//.test(mime);
    const ses = /^audio\//.test(mime);
    const video = /^video\//.test(mime);
    const uc = gorsel ? '/api/sendImage' : ses ? '/api/sendVoice' : video ? '/api/sendVideo' : '/api/sendFile';
    const govde = { session: OTURUM, chatId: jid, file: { mimetype: mime, filename: ad, data: b64 } };
    if (caption && !ses) govde.caption = caption;

    const r = await waha(uc, { method: 'POST', body: govde });
    const id = (r && ((r.id && r.id._serialized) || r.id)) || kimlik('d');
    const sure = Date.now() - t0;

    const yeni = {
      id, text: (gorsel || video) ? (caption || '') : ad, caption: caption,
      kind: gorsel ? 'image' : video ? 'video' : ses ? 'audio' : 'document',
      fromMe: true, sender: 'Ben', ts: Date.now(), time: saat(Date.now()), durum: 1,
      mediaUrl: yol, fileName: ad, mimeType: mime,
    };
    const liste = mesajlar.get(jid) || [];
    liste.push(yeni); mesajlar.set(jid, liste);
    const c = sohbetler.get(jid);
    if (c) { c.lastTs = yeni.ts; c.lastTime = yeni.time; c.messages = [yeni]; }
    log('📤 dosya gonderildi (' + sure + ' ms): ' + ad + ' (' + (buf.length / 1024).toFixed(0) + ' KB)');
    yayinla({ type: 'msgAppend', jid, mesaj: yeni });
    if (c) yayinla({ type: 'chats', chats: [sohbetGuvenli(c, true)], append: true });
    res.json({ ok: true, id: id, url: yol });
  } catch (e) {
    log('✗ DOSYA GONDERILEMEDI: ' + e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────── PANEL API ───────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (String(username).toLowerCase() !== KULLANICI || password !== SIFRE) {
    return res.json({ ok: false, error: 'Kullanıcı adı veya şifre hatalı' });
  }
  const t = kimlik('tok');
  oturumlar.set(t, { username: KULLANICI, displayName: 'WAHA Test', role: 'admin' });
  res.json({ ok: true, token: t, username: KULLANICI, displayName: 'WAHA Test', role: 'admin', bagimsizOkuma: false, lineId: 'ofis', lineTip: 'ofis' });
});
app.post('/api/whoami', (req, res) => {
  const u = oturumlar.get(req.body?.token);
  res.json(u ? { ok: true, ...u, bagimsizOkuma: false, lineId: 'ofis', lineTip: 'ofis' } : { ok: false });
});
app.post('/api/applogout', (req, res) => res.json({ ok: true }));

// Test icin sabit/bos yanitlar — panel bu uclari cagirinca hata vermesin
const bosUclar = {
  '/api/users': { ok: true, users: [{ username: KULLANICI, displayName: 'WAHA Test', role: 'admin', gorev: '', bagimsizOkuma: false }] },
  '/api/users/active': { ok: true, aktif: [] },
  '/api/users/passwords': { ok: true, users: [] },
  '/api/satislar': { ok: true, satislar: [], isAdmin: true, saticilar: [] },
  '/api/performans': { ok: true, liste: [] },
  '/api/odeme/liste': { ok: true, liste: [], benUsername: KULLANICI, onaylayabilir: true },
  '/api/quickreplies': { ok: true, items: [] },
  '/api/ips': { ok: true, ipler: [], liste: [], kisitlama: false, aktif: false },
  '/api/robot/durum': { ok: true, aktif: false, ocr: { hazir: false }, esik: 12, acikKisi: 0, kayitlar: [] },
  '/api/profile/avatars': { ok: true, avatars: {} },
};
for (const [yol, yanit] of Object.entries(bosUclar)) app.post(yol, (req, res) => res.json(yanit));

// WAHA durumu (test ekrani)
app.get('/waha/durum', async (req, res) => {
  try {
    const s = await waha(`/api/sessions/${OTURUM}`);
    res.json({ ok: true, bagli: bagliMi, oturum: s, sohbet: sohbetler.size, grup: [...sohbetler.values()].filter(x => x.isGroup).length });
  } catch (e) { res.json({ ok: false, error: e.message, bagli: bagliMi }); }
});

// ─────────────────── WEBSOCKET (panelin ana yolu) ───────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  istemciler.add(ws);
  log('🖥️  panel baglandi (toplam ' + istemciler.size + ')');
  ws.on('close', () => istemciler.delete(ws));

  ws.on('message', async (ham) => {
    let m; try { m = JSON.parse(ham); } catch (_) { return; }
    const G = (p) => { try { ws.send(JSON.stringify(p)); } catch (_) {} };

    try {
      if (m.type === 'ping') return G({ type: 'pong' });

      if (m.type === 'merhaba') {
        G({ type: 'status', connected: bagliMi, myJid: benimJid, myName: 'WAHA Test' });
        G({ type: 'bootId', id: 'waha-test' });
        if (!sohbetler.size && bagliMi) await sohbetleriYukle().catch(() => {});
        G({ type: 'chats', chats: sohbetListesi(), append: false });
        G({ type: 'buradayimHepsi', durum: {} });
        G({ type: 'favoriler', liste: [] });
        G({ type: 'mesajSabitler', durum: {} });
        G({ type: 'labelsList', labels: [] });
        G({ type: 'teamList', team: [{ username: KULLANICI, displayName: 'WAHA Test', role: 'admin' }] });
        G({ type: 'internalUnread', count: 0 });
        return;
      }

      if (m.type === 'loadMessages') {
        const c = sohbetler.get(m.jid);
        if (!c) return;
        // Gecmisi her acilista tazele; birlestirme yaptigimiz icin
        // yeni gelen mesajlar artik kaybolmuyor.
        let ms = await mesajlariYukle(m.jid, 100);
        if (!ms.length) ms = mesajlar.get(m.jid) || [];
        c.unread = 0; c.ozelUnread = 0;
        return G({ type: 'message', jid: m.jid, chat: Object.assign({}, c, { messages: (ms || []).slice(-300), atananlar: [], etiketler: [] }) });
      }

      if (m.type === 'loadOlder') return G({ type: 'olderMessages', jid: m.jid, messages: [], bitti: true });

      // ── MESAJ GONDER (asil test) ──
      if (m.type === 'send') {
        const t0 = Date.now();
        try {
          const govde = { session: OTURUM, chatId: m.jid, text: m.text || '' };
          if (m.replyTo || m.replyId) govde.reply_to = m.replyTo || m.replyId;   // alintili yanit
          if (m.mentions && m.mentions.length) govde.mentions = m.mentions;      // @etiketleme
          const r = await waha('/api/sendText', { method: 'POST', body: govde });
          const sure = Date.now() - t0;
          const id = r?.id?._serialized || r?.id || kimlik('g');
          const yeni = {
            id, text: m.text || '', kind: 'text', fromMe: true, sender: 'Ben',
            ts: Date.now(), time: saat(Date.now()), durum: 1,
            replyTo: m.replyTo || m.replyId || null,
          };
          const liste = mesajlar.get(m.jid) || [];
          liste.push(yeni); mesajlar.set(m.jid, liste);
          const c = sohbetler.get(m.jid);
          if (c) { c.lastTs = yeni.ts; c.lastTime = yeni.time; }
          log(`📤 gonderildi (${sure} ms): ${(m.text || '').slice(0, 40)}`);
          if (c) c.messages = [yeni];
          yayinla({ type: 'msgAppend', jid: m.jid, mesaj: yeni });
          if (c) yayinla({ type: 'chats', chats: [sohbetGuvenli(c, true)], append: true });
        } catch (e) {
          log('✗ GONDERILEMEDI:', e.message);
          G({ type: 'sendError', jid: m.jid, error: e.message });
          G({ type: 'opError', message: 'Gonderilemedi: ' + e.message });
        }
        return;
      }

      if (m.type === 'markRead' || m.type === 'markAllRead') {
        const c = sohbetler.get(m.jid);
        if (c) { c.unread = 0; c.ozelUnread = 0; G({ type: 'chatSync', jid: m.jid, unread: 0, ozelUnread: 0, muhUnread: 0 }); }
        try { await waha('/api/sendSeen', { method: 'POST', body: { session: OTURUM, chatId: m.jid } }); } catch (_) {}
        return;
      }

      // ── GRUP UYELERI (etiketleme ve "kim yazdi" icin) ──
      if (m.type === 'getGroupMembers') {
        const c = sohbetler.get(m.jid);
        if (c && (!c.members || !c.members.length) && grupMu(m.jid)) {
          try {
            const g = await waha(`/api/${OTURUM}/groups/${m.jid}`);
            const uyeler = (g.participants || (g.groupMetadata && g.groupMetadata.participants) || []).map((p) => {
              const ham = jidAl(p);
              // gercek numara: once alan adaylarindan, sonra ogrendigimiz lid haritasindan
              const gercek = numaraDuzelt(p.phoneNumber || p.pn || p.jid || p.alt || '')
                || lidNumara.get(ham) || (String(ham).includes('@lid') ? '' : ham);
              return {
                jid: gercek || ham,
                lid: ham,
                name: p.name || p.pushName || p.notify || '',
                number: gercek ? String(gercek).split('@')[0] : '',
                admin: !!(p.admin || p.isAdmin || p.isSuperAdmin),
              };
            });
            c.members = uyeler;
            c.memberCount = uyeler.length;
            if (g.description || g.desc) c.description = g.description || g.desc;
          } catch (e) { log('grup uyeleri alinamadi: ' + e.message); }
        }
        return G({ type: 'chatSync', jid: m.jid, members: (c && c.members) || [], memberCount: (c && c.memberCount) || 0 });
      }

      // ── GRUP ACIKLAMASI TAZELE ──
      if (m.type === 'aciklamaTazele' || m.type === 'refreshChat' || m.type === 'syncChat') {
        const c = sohbetler.get(m.jid);
        let aciklama = (c && c.description) || '';
        if (grupMu(m.jid)) {
          try {
            const g = await waha(`/api/${OTURUM}/groups/${m.jid}`);
            aciklama = g.description || g.desc || aciklama;
            if (c) { c.description = aciklama; if (g.subject) c.name = g.subject; }
          } catch (_) {}
        }
        if (c) G({ type: 'chats', chats: [sohbetGuvenli(c, true)], append: true });
        return G({ type: 'aciklamaTazeleSonuc', jid: m.jid, ok: true, description: aciklama });
      }

      // ── YAZIYOR GOSTERGESI ──
      if (m.type === 'typing' || m.type === 'yaziyor') {
        try {
          await waha(m.deger === false ? '/api/stopTyping' : '/api/startTyping',
            { method: 'POST', body: { session: OTURUM, chatId: m.jid } });
        } catch (_) {}
        return;
      }

      // ── MESAJ SIL (herkesten) ──
      if (m.type === 'delete') {
        try {
          await waha(`/api/${OTURUM}/chats/${m.jid}/messages/${m.id}`, { method: 'DELETE' });
          yayinla({ type: 'mesajYerelSil', jid: m.jid, id: m.id });
        } catch (e) { G({ type: 'opError', message: 'Silinemedi: ' + e.message }); }
        return;
      }

      // ── TEPKI (emoji) ──
      if (m.type === 'react') {
        try {
          await waha('/api/reaction', { method: 'PUT', body: { session: OTURUM, messageId: m.id, reaction: m.emoji || '' } });
          yayinla({ type: 'msgUpdate', jid: m.jid, mesaj: { id: m.id, myReaction: m.emoji || '' } });
        } catch (e) { G({ type: 'opError', message: 'Tepki gonderilemedi: ' + e.message }); }
        return;
      }

      // ── KISI LISTESI (yeni sohbet acarken) ──
      if (m.type === 'getContacts') {
        const kisiler = [...sohbetler.values()].filter((c) => !c.isGroup)
          .map((c) => ({ jid: c.jid, name: c.name, number: c.jid.split('@')[0] }));
        return G({ type: 'contactsList', contacts: kisiler });
      }

      // ── YENI SOHBET ──
      if (m.type === 'newChat') {
        const num = String(m.number || '').replace(/\D/g, '');
        if (!num) return G({ type: 'newChatResult', ok: false, error: 'Numara gecersiz' });
        const jid = num + '@c.us';
        if (!sohbetler.has(jid)) {
          sohbetler.set(jid, {
            jid, name: m.name || num, isGroup: false, description: '', avatar: null,
            memberCount: 0, members: [], unread: 0, ozelUnread: 0, muhUnread: 0,
            lastTime: saat(Date.now()), lastTs: Date.now(),
            pinned: false, archived: false, hasMention: false, messages: [],
          });
          mesajlar.set(jid, []);
        }
        G({ type: 'chats', chats: [sohbetGuvenli(sohbetler.get(jid), true)], append: true });
        return G({ type: 'newChatResult', ok: true, jid });
      }

      if (m.type === 'getTeam') return G({ type: 'teamList', team: [{ username: KULLANICI, displayName: 'WAHA Test', role: 'admin' }] });
      if (m.type === 'getLabels') return G({ type: 'labelsList', labels: [] });
      if (m.type === 'internalList') return G({ type: 'internalListResult', items: [], users: [], me: KULLANICI });
      if (m.type === 'searchMessages') {
        const k = String(m.kelime || '').toLowerCase();
        const bulunan = [];
        for (const [jid, ms] of mesajlar) {
          const c = sohbetler.get(jid);
          for (const x of ms) if ((x.text || '').toLowerCase().includes(k)) bulunan.push({ jid, ad: c ? c.name : jid, mesaj: x.text, ts: x.ts, id: x.id });
        }
        return G({ type: 'searchMessagesResult', kelime: m.kelime, mesajlar: bulunan.slice(0, 40), sohbetler: [] });
      }
      // Test kapsaminda olmayan istekler: sessizce yut, panel hata gostermesin
      return;
    } catch (e) {
      log('panel istegi islenemedi:', e.message);
      G({ type: 'opError', message: e.message });
    }
  });
});

// ─────────────────── ACILIS ───────────────────
server.listen(PORT, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════');
  console.log('║  WAHA TEST KOPRUSU calisiyor');
  console.log('║  Panel     : http://localhost:' + PORT);
  console.log('║  Giris     : ' + KULLANICI + ' / ' + SIFRE);
  console.log('║  WAHA      : ' + WAHA_URL + '  (oturum: ' + OTURUM + ')');
  console.log('║');
  console.log('║  CANLI SISTEME DOKUNMAZ — ayri port, ayri oturum, ayri telefon');
  console.log('╚══════════════════════════════════════════════════════════');
  console.log('');

  // Oturumu baslat (yoksa olustur)
  const baslat = async () => {
    try {
      const s = await waha(`/api/sessions/${OTURUM}`);
      log('oturum durumu:', s.status || s.state);
      if (/WORKING|CONNECTED/i.test(s.status || s.state || '')) {
        bagliMi = true;
        await kimligimiOgren();
        await sohbetleriYukle().catch((e) => log('sohbet yukleme: ' + e.message));
        await gruplariYukle().catch(() => {});
      }
      return true;
    } catch (e) {
      if (e.status === 404) {
        log('oturum yok, olusturuluyor...');
        try {
          await waha('/api/sessions', { method: 'POST', body: { name: OTURUM, start: true, config: { webhooks: [{ url: 'http://kopru:3002/waha/olay', events: ['message', 'message.any', 'message.ack', 'session.status', 'state.change'] }] } } });
          log('✓ oturum olusturuldu. QR icin: ' + WAHA_URL + '/dashboard');
        } catch (e2) { log('✗ oturum olusturulamadi:', e2.message); }
        return true;
      }
      log('WAHA\'ya ulasilamadi, 5 sn sonra tekrar:', e.message);
      return false;
    }
  };
  const bek = setInterval(async () => { if (await baslat()) clearInterval(bek); }, 5000);
  baslat();
});

process.on('uncaughtException', (e) => log('⚠️ yakalanmayan hata:', e.message));
process.on('unhandledRejection', (e) => log('⚠️ islenmeyen reddetme:', e?.message || e));
