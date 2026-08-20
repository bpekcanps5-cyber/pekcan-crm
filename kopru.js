/* ═══════════════════════════════════════════════════════════════════════
   WAHA ↔ PANEL KOPRUSU  —  TAM SURUM

   AMAC: Panel (index.html) HIC DEGISMEDEN WAHA uzerinden calissin ve
   HICBIR MESAJ KAYBOLMASIN.

   ONCEKI SURUMUN EKSIKLERI ve BURADAKI COZUMU:

   1) HAFIZA YOKTU — kopru yeniden baslayinca her sey sifirlaniyordu.
      -> Artik diske yaziliyor (veri/). Kaldigi yerden devam eder.

   2) GONDERILEN MESAJ SESSIZCE KAYBOLABILIYORDU — tek deneme yapiliyordu.
      -> GONDERIM KUYRUGU: her mesaj gidene kadar 5 kez denenir, durumu
         panele dogru bildirilir, baglanti yoksa BEKLER (kaybolmaz).

   3) KOPMA ANINDA GELEN MESAJLAR KAYBOLUYORDU.
      -> TELAFI: yeniden baglaninca son mesajlar tekrar cekilip birlestirilir.

   4) OKUNDU/ILETILDI BILGISI EKSIKTI.
      -> ack olaylari panelin bekledigi bicime cevrilir, bellekte de guncellenir.

   5) GRUP ADI/ACIKLAMASI EKSIK GELIYORDU.
      -> Uc kaynaktan birlestirilir: sohbet listesi + grup listesi + tek grup.

   CANLI SISTEME DOKUNMAZ: ayri port, ayri oturum, ayri telefon, ayri klasor.
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
const SAAT_DILIMI = process.env.TZ || 'Europe/Istanbul';

const MEDYA_DIZIN = path.join(__dirname, 'medya');
const VERI_DIZIN = path.join(__dirname, 'veri');
const MESAJ_DIZIN = path.join(VERI_DIZIN, 'mesajlar');
for (const d of [MEDYA_DIZIN, VERI_DIZIN, MESAJ_DIZIN]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

const MESAJ_TAVAN = 500;
const GONDERIM_DENEME = 5;
const TELAFI_ADET = 30;

const log = (...a) => console.log(new Date().toLocaleTimeString('tr-TR', { timeZone: SAAT_DILIMI }), ...a);
const kimlik = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const saat = (ts) => {
  try {
    return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: SAAT_DILIMI }).format(new Date(ts));
  } catch (_) { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
};
const grupMu = (jid) => String(jid).includes('@g.us');
const dosyaAdi = (j) => String(j).replace(/[^a-zA-Z0-9._-]/g, '_');

function numaraDuzelt(j) {
  if (!j) return '';
  const s = String(j);
  if (!s.includes('@')) return '';
  const p = s.split('@');
  return p[0].split(':')[0] + '@' + p[1];
}
function jidAl(x) {
  if (!x) return '';
  return String((x.id && x.id._serialized) || x.id || x.chatId || x.from || x.jid || '');
}
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

// ─────────────────────────── DURUM ───────────────────────────
const sohbetler = new Map();
const mesajlar = new Map();
const oturumlar = new Map();
const lidNumara = new Map();
const istemciler = new Set();
const jidDosya = new Map();
let bagliMi = false;
let benimJid = '';
let benimAd = '';
let sonBagliZaman = 0;
let sonKopmaZaman = 0;
const olaylar = [];

function olayEkle(tip, bilgi) {
  olaylar.unshift({ ts: Date.now(), saat: saat(Date.now()), tip, bilgi: String(bilgi || '').slice(0, 160) });
  if (olaylar.length > 300) olaylar.pop();
}

// ═══════ KALICI HAFIZA ═══════
let _yazBekliyor = false;
function sohbetleriKaydet() {
  if (_yazBekliyor) return;
  _yazBekliyor = true;
  setTimeout(() => {
    _yazBekliyor = false;
    try {
      const veri = [...sohbetler.values()].map((c) => { const k = { ...c }; delete k.messages; return k; });
      fs.writeFileSync(path.join(VERI_DIZIN, 'sohbetler.json'), JSON.stringify(veri));
    } catch (e) { log('sohbetler kaydedilemedi: ' + e.message); }
  }, 3000);
}
function mesajDosyasi(jid) {
  let f = jidDosya.get(jid);
  if (!f) { f = dosyaAdi(jid) + '.json'; jidDosya.set(jid, f); }
  return path.join(MESAJ_DIZIN, f);
}
function mesajlariKaydet(jid) {
  try {
    const ms = (mesajlar.get(jid) || []).slice(-MESAJ_TAVAN);
    fs.writeFileSync(mesajDosyasi(jid), JSON.stringify(ms));
  } catch (_) {}
}
function hafizayiYukle() {
  try {
    const yol = path.join(VERI_DIZIN, 'sohbetler.json');
    if (fs.existsSync(yol)) {
      for (const c of JSON.parse(fs.readFileSync(yol, 'utf8'))) {
        if (c && c.jid) { sohbetler.set(c.jid, c); jidDosya.set(c.jid, dosyaAdi(c.jid) + '.json'); }
      }
    }
    let n = 0;
    for (const [jid] of sohbetler) {
      try {
        const f = mesajDosyasi(jid);
        if (!fs.existsSync(f)) continue;
        const ms = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (Array.isArray(ms) && ms.length) { mesajlar.set(jid, ms); n += ms.length; }
      } catch (_) {}
    }
    if (sohbetler.size) log(`💾 hafizadan yuklendi: ${sohbetler.size} sohbet, ${n} mesaj`);
  } catch (e) { log('hafiza yuklenemedi: ' + e.message); }
}

// ─────────────── WAHA ISTEGI ───────────────
async function waha(yol, s = {}) {
  const deneme = s.deneme || 1;
  const bas = { 'Content-Type': 'application/json' };
  if (WAHA_API_KEY) bas['X-Api-Key'] = WAHA_API_KEY;
  let r;
  try {
    r = await fetch(WAHA_URL + yol, {
      method: s.method || 'GET', headers: bas,
      body: s.body ? JSON.stringify(s.body) : undefined,
      signal: AbortSignal.timeout(s.sure || 30000),
    });
  } catch (e) {
    if (deneme < 3 && !s.tekDeneme) {
      await new Promise((res) => setTimeout(res, 500 * deneme));
      return waha(yol, { ...s, deneme: deneme + 1 });
    }
    throw new Error('WAHA ulasilamadi: ' + e.message);
  }
  const metin = await r.text();
  let veri = null;
  try { veri = metin ? JSON.parse(metin) : null; } catch (_) { veri = metin; }
  if (!r.ok) {
    const e = new Error('WAHA ' + r.status + ': ' + String(typeof veri === 'string' ? veri : JSON.stringify(veri)).slice(0, 180));
    e.status = r.status;
    throw e;
  }
  return veri;
}

function yayinla(paket) {
  let metin;
  try { metin = JSON.stringify(paket); } catch (_) { return; }
  for (const ws of istemciler) if (ws.readyState === 1) { try { ws.send(metin); } catch (_) {} }
}

// hafif=true -> panel elindeki gecmisi SILMESIN
function sohbetGuvenli(c, hafif) {
  if (!c) return c;
  const k = { ...c };
  const ms = mesajlar.get(k.jid) || [];
  k.messages = ms.length ? [ms[ms.length - 1]] : [];
  if (hafif) k._hafif = true;
  return k;
}
function sohbetListesi() {
  return [...sohbetler.values()].map((c) => sohbetGuvenli(c, true)).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
}

// ─────────────── CEVIRICILER ───────────────
function bahsedilenler(m) {
  const ham = m.mentionedIds || m.mentions
    || (m._data && m._data.Message && m._data.Message.extendedTextMessage
        && m._data.Message.extendedTextMessage.contextInfo
        && m._data.Message.extendedTextMessage.contextInfo.mentionedJID) || [];
  return (Array.isArray(ham) ? ham : []).map((x) => numaraDuzelt(x) || x);
}
function ackCevir(ack) {
  const n = Number(ack);
  if (n >= 3) return 4;
  if (n === 2) return 3;
  if (n >= 1) return 2;
  return 1;
}
function mesajaCevir(m, chatJid) {
  const bilgi = (m._data && m._data.Info) || {};
  const tsMs = zamanAl(m) || Date.now();
  const gercek = numaraDuzelt(bilgi.SenderAlt || '');
  if (bilgi.Sender && gercek) lidNumara.set(bilgi.Sender, gercek);

  let kind = 'text';
  const tip = String(m.type || bilgi.Type || m.mediaType || '').toLowerCase();
  const medyaVar = !!(m.hasMedia || m.media);
  if (/image|photo/.test(tip)) kind = 'image';
  else if (/video/.test(tip)) kind = 'video';
  else if (/audio|ptt|voice/.test(tip)) kind = 'audio';
  else if (/document|pdf/.test(tip)) kind = 'document';
  else if (/sticker/.test(tip)) kind = 'sticker';
  else if (medyaVar) kind = 'document';

  const benMi = !!(m.fromMe || bilgi.IsFromMe);
  const medya = m.media || {};
  const dosyaAdi = medya.filename || medya.fileName || (m._data && m._data.filename)
    || m.filename || m.fileName || '';
  const bahs = bahsedilenler(m);
  const benimNum = String(benimJid).split('@')[0].split(':')[0];

  return {
    id: (m.id && m.id._serialized) || m.id || kimlik('m'),
    chatJid: chatJid || m.from || m.chatId || bilgi.Chat || '',
    // BELGE KURALI (panelin kodundan): panel dosya adini m.text'ten okuyor
    //   const fname = m.text || 'Belge'  -> uzanti (PDF/WORD/EXCEL) buradan
    // cikariliyor, indirme baglantisi m.mediaUrl'den aliniyor.
    // 'text'e mesaj metnini koyunca panel dosya adini goremiyor, uzantiyi
    // bulamiyor ve dosyayi ACAMIYORDU.
    text: (kind === 'document') ? (dosyaAdi || 'Belge') : (m.body || m.text || m.caption || ''),
    caption: (kind === 'document') ? (m.caption || m.body || '') : (m.caption || ''),
    kind,
    fromMe: benMi,
    // TIK KURALI (panelin kodundan): tik SADECE gonderen adi bos/'Ben'/'Siz'
    // ya da giris yapan kullanicinin adi oldugunda ciziliyor. Bizim
    // gonderdigimiz mesaja hesabin kendi adini (PushName) yazinca panel bunu
    // "baska ekip uyesi" sanip mesaji SOLA aliyor ve TIK CIZMIYORDU.
    sender: benMi ? 'Ben'
      : (bilgi.PushName || m.notifyName || m.pushName || (m._data && m._data.notifyName) || m.author || ''),
    senderJid: gercek || m.participant || bilgi.Sender || m.author || '',
    ts: tsMs,
    time: saat(tsMs),
    durum: benMi ? ackCevir(m.ack != null ? m.ack : 1) : 0,
    mediaUrl: medya.url || m.mediaUrl || null,
    fileName: dosyaAdi,
    mimeType: medya.mimetype || '',
    replyTo: (m.replyTo && (m.replyTo.id || m.replyTo)) || null,
    mentions: bahs,
    mentionsMe: !!(benimNum && bahs.some((x) => String(x).includes(benimNum))),
  };
}
function sohbeteCevir(c) {
  const jid = jidAl(c);
  const ad = c.name || c.subject || c.pushName || c.formattedTitle
    || (c.contact && (c.contact.name || c.contact.pushname)) || c.notifyName || '';
  const z = zamanAl(c);
  return {
    jid, name: ad || jid.split('@')[0], isGroup: grupMu(jid),
    description: c.description || c.desc || '',
    avatar: c.picture || c.profilePicUrl || null,
    memberCount: c.participantsCount || (c.participants || []).length || 0,
    members: [],
    unread: Number(c.unreadCount || 0), ozelUnread: Number(c.unreadCount || 0), muhUnread: 0,
    lastTime: z ? saat(z) : '', lastTs: z,
    pinned: !!c.pinned, archived: !!c.archived, hasMention: false,
  };
}

function mesajYerlestir(jid, m, sessiz) {
  if (!jid || !m || !m.id) return null;
  let liste = mesajlar.get(jid);
  if (!liste) { liste = []; mesajlar.set(jid, liste); }
  const eski = liste.find((x) => x.id === m.id);
  if (eski) {
    let degisti = false;
    if (m.durum > (eski.durum || 0)) { eski.durum = m.durum; degisti = true; }
    if (m.mediaUrl && m.mediaUrl !== eski.mediaUrl) { eski.mediaUrl = m.mediaUrl; degisti = true; }
    if (m.text && !eski.text) { eski.text = m.text; degisti = true; }
    if (degisti) { mesajlariKaydet(jid); if (!sessiz) yayinla({ type: 'msgUpdate', jid, mesaj: eski }); }
    return eski;
  }
  liste.push(m);
  liste.sort((a, b) => a.ts - b.ts);
  if (liste.length > MESAJ_TAVAN) liste.splice(0, liste.length - MESAJ_TAVAN);
  mesajlariKaydet(jid);
  return m;
}
function sohbetGuncelle(jid, m) {
  let c = sohbetler.get(jid);
  if (!c) {
    c = {
      jid, name: (m && m.sender) || jid.split('@')[0], isGroup: grupMu(jid), description: '',
      avatar: null, memberCount: 0, members: [], unread: 0, ozelUnread: 0, muhUnread: 0,
      lastTime: '', lastTs: 0, pinned: false, archived: false, hasMention: false,
    };
    sohbetler.set(jid, c);
    if (grupMu(jid)) grupBilgisiGetir(jid).catch(() => {});
  }
  if (m) {
    if (m.ts > (c.lastTs || 0)) { c.lastTs = m.ts; c.lastTime = m.time; }
    if (!m.fromMe) {
      c.unread = (c.unread || 0) + 1;
      c.ozelUnread = (c.ozelUnread || 0) + 1;
      if (m.mentionsMe) c.hasMention = true;
    }
  }
  sohbetleriKaydet();
  return c;
}

// ═══════ MEDYA ═══════
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
  if (!kaynak || String(kaynak).startsWith('/medya/') || _medyaIniyor.has(m.id)) return null;
  _medyaIniyor.add(m.id);
  try {
    const url = String(kaynak).startsWith('http') ? kaynak : (WAHA_URL + kaynak);
    const bas = WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {};
    const r = await fetch(url, { headers: bas, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('bos dosya');
    const ad = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + uzantiBul(m.mimeType, m.fileName);
    fs.writeFileSync(path.join(MEDYA_DIZIN, ad), buf);
    const yol = '/medya/' + ad;
    m.mediaUrl = yol;
    const hedef = (mesajlar.get(jid) || []).find((x) => x.id === m.id);
    if (hedef) { hedef.mediaUrl = yol; hedef.indiriliyor = false; }
    mesajlariKaydet(jid);
    log('📎 medya indi: ' + (m.fileName || m.kind) + ' (' + (buf.length / 1024).toFixed(0) + ' KB)');
    yayinla({ type: 'msgUpdate', jid, mesaj: hedef || m });
    return yol;
  } catch (e) {
    log('✗ medya inmedi (' + (m.fileName || m.kind) + '): ' + e.message);
    olayEkle('medya-hata', (m.fileName || m.kind) + ': ' + e.message);
    return null;
  } finally { _medyaIniyor.delete(m.id); }
}

// ═══════ WAHA'DAN VERI ═══════
async function kimligimiOgren() {
  try {
    const s = await waha('/api/sessions/' + OTURUM);
    const ben = s.me || s.user || {};
    benimJid = numaraDuzelt(ben.id || ben.jid || '') || ben.id || '';
    benimAd = ben.pushName || ben.name || '';
    if (benimJid) log('👤 kimlik: ' + benimAd + ' (' + benimJid + ')');
    return benimJid;
  } catch (e) { log('kimlik alinamadi: ' + e.message); return ''; }
}

async function sohbetleriYukle() {
  const yollar = [
    '/api/' + OTURUM + '/chats/overview?limit=1000',
    '/api/' + OTURUM + '/chats?limit=1000',
    '/api/chats?session=' + OTURUM + '&limit=1000',
  ];
  let liste = null, sonHata = null;
  for (const y of yollar) {
    try { const r = await waha(y); if (Array.isArray(r)) { liste = r; log('✓ sohbetler: ' + y.split('?')[0] + ' -> ' + r.length); break; } }
    catch (e) { sonHata = e; }
  }
  if (!liste) { log('✗ sohbetler alinamadi: ' + (sonHata && sonHata.message)); return 0; }

  for (const ham of liste) {
    const y = sohbeteCevir(ham);
    if (!y.jid) continue;
    const eski = sohbetler.get(y.jid);
    if (eski) {
      if (y.name && !/^\d+$/.test(y.name)) eski.name = y.name;
      if (y.description) eski.description = y.description;
      if (y.avatar) eski.avatar = y.avatar;
      if (y.memberCount) eski.memberCount = y.memberCount;
      if (y.lastTs > (eski.lastTs || 0)) { eski.lastTs = y.lastTs; eski.lastTime = y.lastTime; }
      if (y.unread > (eski.unread || 0)) { eski.unread = y.unread; eski.ozelUnread = y.unread; }
    } else { sohbetler.set(y.jid, y); }
    const sonM = ham.lastMessage || ham.lastMsg;
    if (sonM) mesajYerlestir(y.jid, mesajaCevir(sonM, y.jid), true);
  }
  sohbetleriKaydet();
  const gr = [...sohbetler.values()].filter((x) => x.isGroup).length;
  log('📋 ' + sohbetler.size + ' sohbet (' + gr + ' grup)');
  yayinla({ type: 'chats', chats: sohbetListesi(), append: false });
  return sohbetler.size;
}

async function gruplariYukle() {
  const yollar = ['/api/' + OTURUM + '/groups', '/api/groups?session=' + OTURUM];
  let liste = null;
  for (const y of yollar) { try { const r = await waha(y); if (Array.isArray(r)) { liste = r; break; } } catch (_) {} }
  if (!liste) { log('grup listesi alinamadi'); return 0; }
  let yeni = 0, guncel = 0;
  for (const g of liste) {
    const jid = jidAl(g);
    if (!jid) continue;
    const ad = g.subject || g.name || '';
    const acik = g.description || g.desc || (g.groupMetadata && g.groupMetadata.desc) || '';
    let c = sohbetler.get(jid);
    if (!c) {
      c = {
        jid, name: ad || jid.split('@')[0], isGroup: true, description: acik,
        avatar: g.picture || null, memberCount: (g.participants || []).length, members: [],
        unread: 0, ozelUnread: 0, muhUnread: 0, lastTime: '', lastTs: 0,
        pinned: false, archived: false, hasMention: false,
      };
      sohbetler.set(jid, c); yeni++;
    } else {
      if (ad && ad !== c.name) { c.name = ad; guncel++; }
      if (acik && acik !== c.description) { c.description = acik; guncel++; }
      if (!c.memberCount && (g.participants || []).length) c.memberCount = g.participants.length;
      if (!c.avatar && g.picture) c.avatar = g.picture;
    }
  }
  if (yeni || guncel) {
    log('👥 gruplar: ' + yeni + ' yeni, ' + guncel + ' bilgi guncellendi');
    sohbetleriKaydet();
    yayinla({ type: 'chats', chats: sohbetListesi(), append: false });
  }
  return liste.length;
}

async function kisiAdlariniTamamla() {
  const yollar = ['/api/' + OTURUM + '/contacts/all', '/api/contacts/all?session=' + OTURUM, '/api/' + OTURUM + '/contacts'];
  let liste = null;
  for (const y of yollar) { try { const r = await waha(y); if (Array.isArray(r)) { liste = r; break; } } catch (_) {} }
  if (!liste) return 0;
  let n = 0;
  for (const k of liste) {
    const jid = jidAl(k);
    if (!jid) continue;
    const ad = k.name || k.pushname || k.pushName || k.shortName || k.verifiedName || '';
    if (!ad) continue;
    const c = sohbetler.get(jid);
    if (c && (!c.name || /^\d+$/.test(c.name))) { c.name = ad; n++; }
  }
  if (n) { log('👤 ' + n + ' kisi ismi tamamlandi'); sohbetleriKaydet(); yayinla({ type: 'chats', chats: sohbetListesi(), append: false }); }
  return n;
}

const _grupSoruluyor = new Set();
async function grupBilgisiGetir(jid, zorla) {
  if (!grupMu(jid) || _grupSoruluyor.has(jid)) return null;
  const c = sohbetler.get(jid);
  if (!zorla && c && c.name && !/^\d+$/.test(c.name) && c.members && c.members.length) return c;
  _grupSoruluyor.add(jid);
  try {
    const g = await waha('/api/' + OTURUM + '/groups/' + jid, { tekDeneme: true });
    const uyeler = (g.participants || (g.groupMetadata && g.groupMetadata.participants) || []).map((p) => {
      const ham = jidAl(p);
      const gercek = numaraDuzelt(p.phoneNumber || p.pn || p.alt || '') || lidNumara.get(ham) || (String(ham).includes('@lid') ? '' : ham);
      return {
        jid: gercek || ham, lid: ham,
        name: p.name || p.pushName || p.notify || '',
        number: gercek ? String(gercek).split('@')[0] : '',
        admin: !!(p.admin || p.isAdmin || p.isSuperAdmin),
      };
    });
    if (c) {
      if (g.subject) c.name = g.subject;
      const acik = g.description || g.desc || (g.groupMetadata && g.groupMetadata.desc);
      if (acik) c.description = acik;
      if (uyeler.length) { c.members = uyeler; c.memberCount = uyeler.length; }
      if (g.picture && !c.avatar) c.avatar = g.picture;
      sohbetleriKaydet();
      yayinla({ type: 'chats', chats: [sohbetGuvenli(c, true)], append: true });
    }
    return c;
  } catch (_) { return null; }
  finally { _grupSoruluyor.delete(jid); }
}

let _gecmisKalip = null;
async function mesajlariYukle(jid, adet) {
  adet = adet || 100;
  const yollar = _gecmisKalip
    ? [_gecmisKalip.replace('{jid}', jid) + '?limit=' + adet + '&downloadMedia=false']
    : [
      '/api/' + OTURUM + '/chats/' + jid + '/messages?limit=' + adet + '&downloadMedia=false',
      '/api/' + OTURUM + '/chats/' + jid + '/messages?limit=' + adet,
      '/api/messages?session=' + OTURUM + '&chatId=' + jid + '&limit=' + adet + '&downloadMedia=false',
    ];
  for (const y of yollar) {
    try {
      const r = await waha(y, { tekDeneme: true });
      if (!Array.isArray(r)) continue;
      if (!_gecmisKalip) {
        _gecmisKalip = y.split('?')[0].replace(jid, '{jid}');
        log('✓ gecmis adresi: ' + _gecmisKalip + ' -> ' + r.length + ' mesaj');
      }
      for (const ham of r) mesajYerlestir(jid, mesajaCevir(ham, jid), true);
      const ms = mesajlar.get(jid) || [];
      ms.slice(-25).forEach((x) => {
        if (x.kind !== 'text' && !String(x.mediaUrl || '').startsWith('/medya/')) medyaIndir(jid, x).catch(() => {});
      });
      return ms;
    } catch (_) {}
  }
  return mesajlar.get(jid) || [];
}

// ═══════ TELAFI ═══════
let _telafiCalisiyor = false;
async function kacanlariTelafiEt() {
  if (_telafiCalisiyor) return 0;
  _telafiCalisiyor = true;
  try {
    const kopuk = sonKopmaZaman ? Math.round((Date.now() - sonKopmaZaman) / 1000) : 0;
    log('🔄 TELAFI basliyor (' + kopuk + ' sn kopuk) — kacan mesajlar aliniyor...');
    const hedefler = [...sohbetler.values()].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).slice(0, 60);
    let toplam = 0;
    for (const c of hedefler) {
      const once = (mesajlar.get(c.jid) || []).length;
      try { await mesajlariYukle(c.jid, TELAFI_ADET); } catch (_) {}
      const ms = mesajlar.get(c.jid) || [];
      if (ms.length > once) {
        toplam += ms.length - once;
        const son = ms[ms.length - 1];
        if (son && son.ts > (c.lastTs || 0)) { c.lastTs = son.ts; c.lastTime = son.time; }
        yayinla({ type: 'chats', chats: [sohbetGuvenli(c, true)], append: true });
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    if (toplam) {
      log('✅ TELAFI: ' + toplam + ' kacan mesaj geri alindi');
      olayEkle('telafi', toplam + ' mesaj kurtarildi');
      yayinla({ type: 'chats', chats: sohbetListesi(), append: false });
    } else { log('✅ TELAFI: kacan mesaj yok'); }
    sonKopmaZaman = 0;
    return toplam;
  } finally { _telafiCalisiyor = false; }
}

// ═══════ GONDERIM KUYRUGU ═══════
const kuyruk = [];
let kuyrukCalisiyor = false;
function kuyrugaEkle(is) { is.deneme = 0; kuyruk.push(is); kuyrukIsle(); }
async function kuyrukIsle() {
  if (kuyrukCalisiyor) return;
  kuyrukCalisiyor = true;
  try {
    while (kuyruk.length) {
      const is = kuyruk[0];
      if (!bagliMi) {
        if (!is._bekletmeLog) { is._bekletmeLog = true; log('⏸  gonderim bekliyor (baglanti yok): ' + kuyruk.length + ' mesaj sirada'); }
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      is.deneme++;
      const t0 = Date.now();
      try {
        const r = await waha(is.uc, { method: 'POST', body: is.govde, sure: is.medyaMi ? 180000 : 45000, tekDeneme: true });
        const id = (r && ((r.id && r.id._serialized) || r.id)) || kimlik('m');
        const sure = Date.now() - t0;
        kuyruk.shift();
        log('📤 gonderildi (' + sure + ' ms, ' + is.deneme + '. deneme): ' + is.ozet);
        olayEkle('giden', is.ozet + ' — ' + sure + 'ms');
        if (is.tamam) { try { is.tamam(id, sure); } catch (_) {} }
      } catch (e) {
        // ═══ BAGLANTI HATASI DENEME HAKKI YAKMAZ ═══════════════════════
        // WAHA'ya ulasilamiyorsa bu mesajin sucu degil. Deneme sayacini
        // artirirsak baglanti birazdan gelse bile mesaj cope gider.
        // Bu yuzden: baglanti hatasinda sayaci geri al ve BEKLE.
        const baglantiHatasi = /ulasilamadi|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|timeout|aborted/i.test(e.message || '');
        if (baglantiHatasi) {
          is.deneme--;                      // hak yakma
          if (bagliMi) {                    // bekciyi beklemeden durumu dusur
            bagliMi = false; sonKopmaZaman = Date.now();
            log('🔌 gonderim sirasinda baglanti kayboldu -> BAGLI DEGIL');
            olayEkle('koptu', 'gonderim: ' + e.message);
            yayinla({ type: 'status', connected: false });
          }
          await new Promise((r) => setTimeout(r, 3000));
          continue;                          // mesaj kuyrukta KALIYOR
        }
        if (is.deneme >= GONDERIM_DENEME) {
          kuyruk.shift();
          log('❌ GONDERILEMEDI (' + is.deneme + ' deneme): ' + is.ozet + ' — ' + e.message);
          olayEkle('gonderilemedi', is.ozet + ': ' + e.message);
          if (is.hata) { try { is.hata(e); } catch (_) {} }
        } else {
          const bekle = Math.min(2000 * is.deneme, 15000);
          log('⚠️  gonderim basarisiz (' + is.deneme + '/' + GONDERIM_DENEME + '), ' + (bekle / 1000) + 'sn sonra tekrar: ' + e.message);
          await new Promise((r) => setTimeout(r, bekle));
        }
      }
    }
  } finally { kuyrukCalisiyor = false; }
}

// ═══════ SUNUCU ═══════
const app = express();
app.use('/medya', express.static(MEDYA_DIZIN));

app.post('/upload', express.raw({ type: '*/*', limit: '80mb' }), (req, res) => {
  const jid = req.query.jid;
  const ad = req.query.name || 'dosya';
  const mime = req.query.mime || 'application/octet-stream';
  const caption = req.query.caption || '';
  if (!jid || !req.body || !req.body.length) return res.status(400).json({ ok: false, error: 'jid ve dosya zorunlu' });
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
  try {
    const kayit = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + uzantiBul(mime, ad);
    fs.writeFileSync(path.join(MEDYA_DIZIN, kayit), buf);
    const yol = '/medya/' + kayit;
    const gorsel = /^image\//.test(mime), ses = /^audio\//.test(mime), video = /^video\//.test(mime);
    const uc = gorsel ? '/api/sendImage' : ses ? '/api/sendVoice' : video ? '/api/sendVideo' : '/api/sendFile';
    const govde = { session: OTURUM, chatId: jid, file: { mimetype: mime, filename: ad, data: buf.toString('base64') } };
    if (caption && !ses) govde.caption = caption;

    const gecici = kimlik('m');
    const yeni = {
      id: gecici, chatJid: jid, text: (gorsel || video) ? (caption || '') : ad, caption,
      kind: gorsel ? 'image' : video ? 'video' : ses ? 'audio' : 'document',
      fromMe: true, sender: benimAd || 'Ben', ts: Date.now(), time: saat(Date.now()),
      durum: 1, mediaUrl: yol, fileName: ad, mimeType: mime, gonderiliyor: true,
    };
    mesajYerlestir(jid, yeni);
    const c = sohbetGuncelle(jid, yeni);
    yayinla({ type: 'msgAppend', jid, mesaj: yeni });
    yayinla({ type: 'chats', chats: [sohbetGuvenli(c, true)], append: true });

    kuyrugaEkle({
      uc, govde, medyaMi: true, ozet: 'dosya ' + ad + ' (' + (buf.length / 1024).toFixed(0) + ' KB)',
      tamam: (gercekId) => {
        const m = (mesajlar.get(jid) || []).find((x) => x.id === gecici);
        if (m) { m.id = gercekId; m.durum = 2; m.gonderiliyor = false; mesajlariKaydet(jid); }
        yayinla({ type: 'msgStatus', jid, id: gecici, durum: 2 });
        if (m) yayinla({ type: 'msgUpdate', jid, mesaj: m });
      },
      hata: (e) => {
        const m = (mesajlar.get(jid) || []).find((x) => x.id === gecici);
        if (m) { m.durum = 0; m.hata = e.message; m.gonderiliyor = false; mesajlariKaydet(jid); }
        if (m) yayinla({ type: 'msgUpdate', jid, mesaj: m });
        yayinla({ type: 'opError', message: 'Dosya gonderilemedi: ' + e.message });
      },
    });
    res.json({ ok: true, id: gecici, url: yol });
  } catch (e) {
    log('✗ dosya hatasi: ' + e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use(express.json({ limit: '25mb' }));
app.use(express.static(__dirname));

app.post('/waha/olay', (req, res) => {
  res.json({ ok: true });
  const olay = req.body || {};
  const tip = olay.event || olay.type || '';
  const veri = olay.payload || olay.data || olay;
  if (!global._ilkOlay) { global._ilkOlay = true; log('✅ WAHA olaylari geliyor (webhook calisiyor)'); }
  try {
    if (/session\.status|state\.change/.test(tip)) {
      const durum = String(veri.status || veri.state || '').toUpperCase();
      const onceki = bagliMi;
      bagliMi = /WORKING|CONNECTED|OPEN/.test(durum);
      log('🔌 WAHA durum: ' + durum + ' -> ' + (bagliMi ? 'BAGLI' : 'BAGLI DEGIL'));
      olayEkle(bagliMi ? 'baglandi' : 'koptu', durum);
      yayinla({ type: 'status', connected: bagliMi, myJid: benimJid, myName: benimAd });
      if (bagliMi && !onceki) {
        sonBagliZaman = Date.now();
        (async () => {
          await kimligimiOgren();
          await sohbetleriYukle().catch(() => {});
          await gruplariYukle().catch(() => {});
          kisiAdlariniTamamla().catch(() => {});
          if (sonKopmaZaman) await kacanlariTelafiEt().catch(() => {});
          kuyrukIsle();
        })();
      }
      if (!bagliMi && onceki) sonKopmaZaman = Date.now();
      return;
    }
    if (/ack/.test(tip)) {
      const jid = veri.chatId || veri.from || veri.to || jidAl(veri);
      const id = (veri.id && veri.id._serialized) || veri.id;
      if (!jid || !id) return;
      const durum = ackCevir(veri.ack != null ? veri.ack : (veri.ackName === 'READ' ? 3 : 1));
      const m = (mesajlar.get(jid) || []).find((x) => x.id === id);
      if (m && durum > (m.durum || 0)) { m.durum = durum; mesajlariKaydet(jid); }
      yayinla({ type: 'msgStatus', jid, id, durum });
      return;
    }
    if (/^message/.test(tip)) {
      const jid = veri.from || veri.chatId || (veri._data && veri._data.Info && veri._data.Info.Chat) || jidAl(veri);
      if (!jid) return;
      const m = mesajaCevir(veri, jid);
      const eklenen = mesajYerlestir(jid, m);
      if (eklenen !== m) return;
      const c = sohbetGuncelle(jid, m);
      log('📩 ' + (c.isGroup ? '[grup]' : '[kisi]') + ' ' + c.name + ': ' + String(m.text || m.kind).slice(0, 50));
      olayEkle('gelen', c.name + ': ' + String(m.text || m.kind).slice(0, 40));
      yayinla({ type: 'msgAppend', jid, mesaj: m });
      yayinla({ type: 'chatSync', jid, unread: c.unread, ozelUnread: c.ozelUnread, muhUnread: 0, lastTime: c.lastTime, lastTs: c.lastTs });
      yayinla({ type: 'chats', chats: [sohbetGuvenli(c, true)], append: true });
      if (m.kind !== 'text' && (veri.hasMedia || veri.media)) { m.indiriliyor = true; medyaIndir(jid, m).catch(() => {}); }
      if (c.isGroup && (!c.name || /^\d+$/.test(c.name))) grupBilgisiGetir(jid).catch(() => {});
      return;
    }
  } catch (e) { log('olay islenemedi: ' + e.message); }
});

app.post('/api/login', (req, res) => {
  const b = req.body || {};
  if (String(b.username || '').toLowerCase() !== KULLANICI || b.password !== SIFRE) {
    return res.json({ ok: false, error: 'Kullanıcı adı veya şifre hatalı' });
  }
  const t = kimlik('tok');
  oturumlar.set(t, { username: KULLANICI, displayName: benimAd || 'WAHA Test', role: 'admin' });
  res.json({ ok: true, token: t, username: KULLANICI, displayName: benimAd || 'WAHA Test', role: 'admin', bagimsizOkuma: false, lineId: 'ofis', lineTip: 'ofis' });
});
app.post('/api/whoami', (req, res) => {
  const u = oturumlar.get(req.body && req.body.token);
  res.json(u ? { ok: true, username: u.username, displayName: u.displayName, role: u.role, bagimsizOkuma: false, lineId: 'ofis', lineTip: 'ofis' } : { ok: false });
});
app.post('/api/applogout', (req, res) => res.json({ ok: true }));

const bosUclar = {
  '/api/users': () => ({ ok: true, users: [{ username: KULLANICI, displayName: benimAd || 'WAHA Test', role: 'admin', gorev: '', bagimsizOkuma: false }] }),
  '/api/users/active': () => ({ ok: true, aktif: [] }),
  '/api/users/passwords': () => ({ ok: true, users: [] }),
  '/api/satislar': () => ({ ok: true, satislar: [], isAdmin: true, saticilar: [] }),
  '/api/performans': () => ({ ok: true, liste: [] }),
  '/api/odeme/liste': () => ({ ok: true, liste: [], benUsername: KULLANICI, onaylayabilir: true }),
  '/api/quickreplies': () => ({ ok: true, items: [] }),
  '/api/ips': () => ({ ok: true, ipler: [], liste: [], kisitlama: false, aktif: false }),
  '/api/robot/durum': () => ({ ok: true, aktif: false, ocr: { hazir: false }, esik: 12, acikKisi: 0, kayitlar: [] }),
  '/api/profile/avatars': () => ({ ok: true, avatars: {} }),
};
for (const yol of Object.keys(bosUclar)) app.post(yol, (req, res) => res.json(bosUclar[yol]()));

app.get('/waha/durum', (req, res) => {
  const gr = [...sohbetler.values()].filter((x) => x.isGroup).length;
  let mesajSayi = 0; for (const [, v] of mesajlar) mesajSayi += v.length;
  res.json({
    ok: true, bagli: bagliMi, kimlik: benimJid, ad: benimAd,
    sohbet: sohbetler.size, grup: gr, kisi: sohbetler.size - gr, mesaj: mesajSayi,
    kuyrukta: kuyruk.length, panelSayisi: istemciler.size,
    bagliSureSn: sonBagliZaman ? Math.round((Date.now() - sonBagliZaman) / 1000) : 0,
    kopmaSayisi: olaylar.filter((x) => x.tip === 'koptu').length,
    gonderilemeyen: olaylar.filter((x) => x.tip === 'gonderilemedi').length,
    olaylar: olaylar.slice(0, 50),
  });
});

const server = http.createServer(app);
// ═══ TESHIS UCU ══════════════════════════════════════════════════════
// WAHA'nin GERCEKTE ne dondurdugunu gormek icin. Tahmin etmek yerine
// gercek veriyi okuyup ona gore kod yaziyoruz.
//   curl -s "http://localhost:3002/waha/tani" | head -c 4000
app.get('/waha/tani', async (req, res) => {
  const jid = req.query.jid || [...sohbetler.keys()].find((x) => grupMu(x)) || '';
  const rapor = { oturum: OTURUM, jid, sonuc: {} };
  const dene = async (ad, yol) => {
    try {
      const r = await waha(yol);
      rapor.sonuc[ad] = {
        yol, durum: 'OK',
        tip: Array.isArray(r) ? ('dizi[' + r.length + ']') : typeof r,
        alanlar: Array.isArray(r) ? (r[0] ? Object.keys(r[0]) : []) : (r ? Object.keys(r) : []),
        ornek: JSON.stringify(Array.isArray(r) ? r[0] : r).slice(0, 1000),
      };
    } catch (e) { rapor.sonuc[ad] = { yol, durum: 'HATA', hata: String(e.message).slice(0, 200) }; }
  };
  await dene('grup_bilgisi', '/api/' + OTURUM + '/groups/' + jid);
  await dene('grup_uyeleri', '/api/' + OTURUM + '/groups/' + jid + '/participants');
  await dene('grup_aciklama', '/api/' + OTURUM + '/groups/' + jid + '/description');
  await dene('gruplar_listesi', '/api/' + OTURUM + '/groups?limit=2');
  await dene('kisiler', '/api/' + OTURUM + '/contacts/all?limit=2');
  try {
    const ms = await waha('/api/' + OTURUM + '/chats/' + jid + '/messages?limit=40&downloadMedia=true');
    const medyali = (Array.isArray(ms) ? ms : []).find((x) => x.hasMedia || x.media || /image|document|video|audio/i.test(String(x.type || '')));
    rapor.medyaliMesaj = medyali ? JSON.stringify(medyali).slice(0, 1800) : 'bulunamadi';
  } catch (e) { rapor.medyaliMesaj = 'HATA: ' + e.message; }
  res.json(rapor);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  istemciler.add(ws);
  log('🖥️  panel baglandi (toplam ' + istemciler.size + ')');
  ws.on('close', () => istemciler.delete(ws));
  ws.on('error', () => istemciler.delete(ws));

  ws.on('message', async (ham) => {
    let m; try { m = JSON.parse(ham); } catch (_) { return; }
    const G = (p) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(p)); } catch (_) {} };
    try {
      if (m.type === 'ping') return G({ type: 'pong' });

      if (m.type === 'merhaba') {
        G({ type: 'status', connected: bagliMi, myJid: benimJid, myName: benimAd });
        G({ type: 'bootId', id: 'waha-test' });
        if (!sohbetler.size && bagliMi) await sohbetleriYukle().catch(() => {});
        G({ type: 'chats', chats: sohbetListesi(), append: false });
        G({ type: 'buradayimHepsi', durum: {} });
        G({ type: 'favoriler', liste: [] });
        G({ type: 'mesajSabitler', durum: {} });
        G({ type: 'labelsList', labels: [] });
        G({ type: 'teamList', team: [{ username: KULLANICI, displayName: benimAd || 'WAHA Test', role: 'admin' }] });
        G({ type: 'internalUnread', count: 0 });
        return;
      }

      if (m.type === 'loadMessages') {
        let c = sohbetler.get(m.jid) || sohbetGuncelle(m.jid, null);
        const ms = await mesajlariYukle(m.jid, 150);
        c.unread = 0; c.ozelUnread = 0; c.hasMention = false;
        sohbetleriKaydet();
        if (grupMu(m.jid)) grupBilgisiGetir(m.jid).catch(() => {});
        const tam = { ...c, messages: ms.slice(-300), atananlar: [], etiketler: [] };
        return G({ type: 'message', jid: m.jid, chat: tam });
      }

      if (m.type === 'loadOlder') {
        const ms = await mesajlariYukle(m.jid, 300);
        const esik = Number(m.beforeTs) || 0;
        const eski = esik ? ms.filter((x) => x.ts < esik) : [];
        return G({ type: 'olderMessages', jid: m.jid, messages: eski.slice(-200), bitti: eski.length < 5 });
      }

      if (m.type === 'send') {
        const jid = m.jid;
        if (!jid || !String(m.text || '').trim()) return;
        const gecici = kimlik('m');
        const yeni = {
          id: gecici, chatJid: jid, text: m.text, kind: 'text', fromMe: true,
          sender: benimAd || 'Ben', ts: Date.now(), time: saat(Date.now()),
          durum: 1, gonderiliyor: true, replyTo: m.replyTo || m.replyId || null,
        };
        mesajYerlestir(jid, yeni);
        const c = sohbetGuncelle(jid, yeni);
        yayinla({ type: 'msgAppend', jid, mesaj: yeni });
        yayinla({ type: 'chats', chats: [sohbetGuvenli(c, true)], append: true });

        const govde = { session: OTURUM, chatId: jid, text: m.text };
        if (m.replyTo || m.replyId) govde.reply_to = m.replyTo || m.replyId;
        if (m.mentions && m.mentions.length) govde.mentions = m.mentions;
        kuyrugaEkle({
          uc: '/api/sendText', govde, ozet: String(m.text || '').slice(0, 40),
          tamam: (gercekId) => {
            const mm = (mesajlar.get(jid) || []).find((x) => x.id === gecici);
            if (mm) { mm.id = gercekId; mm.durum = 2; mm.gonderiliyor = false; mesajlariKaydet(jid); }
            yayinla({ type: 'msgStatus', jid, id: gecici, durum: 2 });
            if (mm) yayinla({ type: 'msgUpdate', jid, mesaj: mm });
          },
          hata: (e) => {
            const mm = (mesajlar.get(jid) || []).find((x) => x.id === gecici);
            if (mm) { mm.durum = 0; mm.hata = e.message; mm.gonderiliyor = false; mesajlariKaydet(jid); }
            if (mm) yayinla({ type: 'msgUpdate', jid, mesaj: mm });
            G({ type: 'sendError', jid, error: e.message });
            G({ type: 'opError', message: 'Gonderilemedi: ' + e.message });
          },
        });
        return;
      }

      if (m.type === 'markRead' || m.type === 'markAllRead') {
        const c = sohbetler.get(m.jid);
        if (c) { c.unread = 0; c.ozelUnread = 0; c.hasMention = false; sohbetleriKaydet(); G({ type: 'chatSync', jid: m.jid, unread: 0, ozelUnread: 0, muhUnread: 0 }); }
        try { await waha('/api/sendSeen', { method: 'POST', body: { session: OTURUM, chatId: m.jid }, tekDeneme: true }); } catch (_) {}
        return;
      }
      if (m.type === 'markUnread') {
        const c = sohbetler.get(m.jid);
        if (c) { c.unread = 1; c.ozelUnread = 1; sohbetleriKaydet(); G({ type: 'chatSync', jid: m.jid, unread: 1, ozelUnread: 1, muhUnread: 0 }); }
        return;
      }
      if (m.type === 'getGroupMembers') {
        await grupBilgisiGetir(m.jid, true).catch(() => {});
        const c = sohbetler.get(m.jid);
        if (!c) return;
        // PANELIN KURALI: chatSync isleyicisi SADECE 'd.chat' alanina bakiyor
        //   if(d.chat){ chats[d.jid]=d.chat; ... }
        // Uyeleri ayri alanda gonderince panel YOK SAYIYORDU (numaralar
        // gorunmuyordu). Artik TAM sohbet nesnesini yolluyoruz.
        const tam = Object.assign({}, c, { messages: mesajlar.get(m.jid) || c.messages || [] });
        return G({ type: 'chatSync', jid: m.jid, chat: tam });
      }
      if (m.type === 'aciklamaTazele' || m.type === 'refreshChat' || m.type === 'syncChat' || m.type === 'refreshGroupName') {
        const oncekiAd = (sohbetler.get(m.jid) || {}).name || '';
        await grupBilgisiGetir(m.jid, true).catch(() => {});
        const c = sohbetler.get(m.jid);
        if (!c) return G({ type: 'aciklamaTazeleSonuc', jid: m.jid, ok: false, error: 'Grup bulunamadi' });
        // PANEL BU ALANLARI OKUYOR: name, description, memberCount.
        // Sadece 'description' gondermek yetmiyordu.
        G({ type: 'chats', chats: [sohbetGuvenli(c, true)], append: true });
        return G({
          type: 'aciklamaTazeleSonuc', jid: m.jid, ok: true,
          name: c.name || oncekiAd,
          description: c.description || '',
          memberCount: c.memberCount || 0,
        });
      }
      if (m.type === 'searchMessages') {
        const k = String(m.kelime || m.q || '').toLocaleLowerCase('tr');
        if (!k) return G({ type: 'searchMessagesResult', kelime: m.kelime, q: m.kelime, mesajlar: [], sohbetler: [] });
        const bulunan = [];
        for (const [jid, ms] of mesajlar) {
          const c = sohbetler.get(jid);
          for (const x of ms) {
            if (String(x.text || '').toLocaleLowerCase('tr').includes(k)) {
              bulunan.push({ jid, chatJid: jid, ad: c ? c.name : jid, mesaj: x.text, ts: x.ts, id: x.id });
            }
          }
        }
        bulunan.sort((a, b) => b.ts - a.ts);
        return G({ type: 'searchMessagesResult', kelime: m.kelime, q: m.kelime, mesajlar: bulunan.slice(0, 60), sohbetler: [] });
      }
      if (m.type === 'delete') {
        try {
          await waha('/api/' + OTURUM + '/chats/' + m.jid + '/messages/' + m.id, { method: 'DELETE', tekDeneme: true });
          const liste = mesajlar.get(m.jid) || [];
          const i = liste.findIndex((x) => x.id === m.id);
          if (i >= 0) { liste.splice(i, 1); mesajlariKaydet(m.jid); }
          yayinla({ type: 'mesajYerelSil', jid: m.jid, id: m.id });
        } catch (e) { G({ type: 'opError', message: 'Silinemedi: ' + e.message }); }
        return;
      }
      if (m.type === 'react') {
        try {
          await waha('/api/reaction', { method: 'PUT', body: { session: OTURUM, messageId: m.id, reaction: m.emoji || '' }, tekDeneme: true });
          yayinla({ type: 'msgUpdate', jid: m.jid, mesaj: { id: m.id, myReaction: m.emoji || '' } });
        } catch (e) { G({ type: 'opError', message: 'Tepki gonderilemedi: ' + e.message }); }
        return;
      }
      if (m.type === 'typing') {
        try { await waha(m.deger === false ? '/api/stopTyping' : '/api/startTyping', { method: 'POST', body: { session: OTURUM, chatId: m.jid }, tekDeneme: true }); } catch (_) {}
        return;
      }
      if (m.type === 'getContacts') {
        return G({ type: 'contactsList', contacts: [...sohbetler.values()].filter((c) => !c.isGroup).map((c) => ({ jid: c.jid, name: c.name, number: c.jid.split('@')[0] })) });
      }
      if (m.type === 'newChat') {
        const num = String(m.number || '').replace(/\D/g, '');
        if (!num) return G({ type: 'newChatResult', ok: false, error: 'Numara gecersiz' });
        const jid = num + '@c.us';
        const c = sohbetler.get(jid) || sohbetGuncelle(jid, null);
        if (m.name) c.name = m.name;
        sohbetleriKaydet();
        G({ type: 'chats', chats: [sohbetGuvenli(c, true)], append: true });
        return G({ type: 'newChatResult', ok: true, jid });
      }
      if (m.type === 'medyaYenidenIndir') {
        const mm = (mesajlar.get(m.jid) || []).find((x) => x.id === m.id);
        if (mm) { mm.mediaUrl = null; await medyaIndir(m.jid, mm).catch(() => {}); }
        return G({ type: 'opOk', message: 'Medya yeniden indiriliyor' });
      }
      if (m.type === 'getTeam') return G({ type: 'teamList', team: [{ username: KULLANICI, displayName: benimAd || 'WAHA Test', role: 'admin' }] });
      if (m.type === 'getLabels') return G({ type: 'labelsList', labels: [] });
      if (m.type === 'internalList') return G({ type: 'internalListResult', items: [], users: [], me: KULLANICI });
      return;
    } catch (e) {
      log('panel istegi hatasi: ' + e.message);
      G({ type: 'opError', message: e.message });
    }
  });
});

// ═══════ BEKCI ═══════
setInterval(async () => {
  try {
    const s = await waha('/api/sessions/' + OTURUM, { tekDeneme: true, sure: 10000 });
    const durum = String(s.status || s.state || '').toUpperCase();
    const yeni = /WORKING|CONNECTED/.test(durum);
    if (yeni !== bagliMi) {
      bagliMi = yeni;
      log('🔌 (bekci) WAHA durum: ' + durum + ' -> ' + (bagliMi ? 'BAGLI' : 'BAGLI DEGIL'));
      olayEkle(bagliMi ? 'baglandi' : 'koptu', 'bekci: ' + durum);
      yayinla({ type: 'status', connected: bagliMi, myJid: benimJid, myName: benimAd });
      if (bagliMi) {
        sonBagliZaman = Date.now();
        if (!benimJid) await kimligimiOgren();
        await sohbetleriYukle().catch(() => {});
        if (sonKopmaZaman) await kacanlariTelafiEt().catch(() => {});
        kuyrukIsle();
      } else { sonKopmaZaman = Date.now(); }
    }
  } catch (e) {
    if (bagliMi) {
      bagliMi = false; sonKopmaZaman = Date.now();
      log('🔌 (bekci) WAHA ulasilamiyor -> BAGLI DEGIL');
      olayEkle('koptu', 'bekci: ' + e.message);
      yayinla({ type: 'status', connected: false });
    }
  }
}, 20000);

setInterval(() => {
  if (!bagliMi) return;
  const eksik = [...sohbetler.values()].filter((c) => c.isGroup && (!c.name || /^\d+$/.test(c.name) || !c.description)).slice(0, 3);
  eksik.forEach((c) => grupBilgisiGetir(c.jid, true).catch(() => {}));
}, 60000);

// ═══════ ACILIS ═══════
hafizayiYukle();

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════');
  console.log('║  WAHA TEST KOPRUSU (tam surum)');
  console.log('║  Panel  : http://localhost:' + PORT + '   giris: ' + KULLANICI + ' / ' + SIFRE);
  console.log('║  Durum  : http://localhost:' + PORT + '/waha/durum');
  console.log('║  WAHA   : ' + WAHA_URL + '  (oturum: ' + OTURUM + ')');
  console.log('║  Saat   : ' + SAAT_DILIMI);
  console.log('║');
  console.log('║  CANLI SISTEME DOKUNMAZ — ayri port, ayri oturum, ayri telefon');
  console.log('╚══════════════════════════════════════════════════════════');
  console.log('');

  const baslat = async () => {
    try {
      const s = await waha('/api/sessions/' + OTURUM, { tekDeneme: true });
      log('oturum durumu: ' + (s.status || s.state));
      if (/WORKING|CONNECTED/i.test(s.status || s.state || '')) {
        bagliMi = true; sonBagliZaman = Date.now();
        await kimligimiOgren();
        await sohbetleriYukle().catch((e) => log('sohbet yukleme: ' + e.message));
        await gruplariYukle().catch(() => {});
        kisiAdlariniTamamla().catch(() => {});
        kuyrukIsle();
      }
      return true;
    } catch (e) {
      if (e.status === 404) {
        log('oturum yok, olusturuluyor...');
        try {
          await waha('/api/sessions', { method: 'POST', body: { name: OTURUM, start: true, config: { webhooks: [{ url: 'http://kopru:' + PORT + '/waha/olay', events: ['message', 'message.any', 'message.ack', 'session.status', 'state.change'] }] } } });
          log('✓ oturum olusturuldu. QR icin: ' + WAHA_URL + '/dashboard');
        } catch (e2) { log('✗ oturum olusturulamadi: ' + e2.message); }
        return true;
      }
      log("WAHA'ya ulasilamadi, 5 sn sonra tekrar: " + e.message);
      return false;
    }
  };
  const bek = setInterval(async () => { if (await baslat()) clearInterval(bek); }, 5000);
  baslat();
});

process.on('uncaughtException', (e) => { log('⚠️ yakalanmayan hata: ' + e.message); olayEkle('hata', e.message); });
process.on('unhandledRejection', (e) => { log('⚠️ islenmeyen reddetme: ' + ((e && e.message) || e)); });
process.on('SIGTERM', () => { try { for (const [j] of mesajlar) mesajlariKaydet(j); } catch (_) {} process.exit(0); });
