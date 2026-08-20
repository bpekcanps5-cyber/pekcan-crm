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
const PORT = 3002;
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
const saat = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

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
function sohbetGuvenli(c) {
  if (!c) return c;
  if (!Array.isArray(c.messages)) {
    const ms = mesajlar.get(c.jid);
    c.messages = Array.isArray(ms) && ms.length ? [ms[ms.length - 1]] : [];
  }
  return c;
}
function sohbetListesi() {
  return [...sohbetler.values()].map(sohbetGuvenli).sort((a, b) => b.lastTs - a.lastTs);
}

function yayinla(paket) {
  const metin = JSON.stringify(paket);
  for (const ws of istemciler) {
    if (ws.readyState === 1) { try { ws.send(metin); } catch (_) {} }
  }
}

// ───────────── WAHA VERISINI PANEL BICIMINE CEVIR ─────────────
// WAHA surumleri arasinda alan adlari degisebiliyor; hepsini deniyoruz.
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
    lastTime: saat(Number(c.timestamp || Date.now()) * (String(c.timestamp || '').length <= 11 ? 1000 : 1)),
    lastTs: Number(c.timestamp || Date.now()) * (String(c.timestamp || '').length <= 11 ? 1000 : 1),
    pinned: !!c.pinned, archived: !!c.archived, hasMention: false,
    avatar: null,
    // ZORUNLU: panel liste ciziminde c.messages[son] okuyor. Bu alan
    // olmazsa cizim COKUYOR ve liste bos gorunuyor (462 sohbet gelse bile).
    // WAHA sohbet listesinde son mesaji veriyorsa onu koyuyoruz.
    messages: c.lastMessage ? [mesajaCevir(c.lastMessage)] : [],
  };
}

function mesajaCevir(m) {
  const ts = Number(m.timestamp || Date.now());
  const tsMs = String(m.timestamp || '').length <= 11 ? ts * 1000 : ts;
  const govde = m.body || m.text || m.caption || '';
  let kind = 'text';
  const tip = String(m.type || m._data?.type || '').toLowerCase();
  if (/image|photo/.test(tip)) kind = 'image';
  else if (/video/.test(tip)) kind = 'video';
  else if (/audio|ptt|voice/.test(tip)) kind = 'audio';
  else if (/document|pdf/.test(tip)) kind = 'document';
  else if (/sticker/.test(tip)) kind = 'sticker';

  return {
    id: m.id?._serialized || m.id || kimlik('m'),
    text: govde,
    caption: m.caption || '',
    kind,
    fromMe: !!m.fromMe,
    sender: m.notifyName || m._data?.notifyName || m.pushName || m.author || (m.fromMe ? 'Ben' : ''),
    senderJid: m.author || m.participant || m.from || '',
    ts: tsMs,
    time: saat(tsMs),
    durum: m.fromMe ? (m.ack || 1) : 0,
    mediaUrl: m.mediaUrl || m.media?.url || null,
    fileName: m.media?.filename || m._data?.filename || '',
    mentionsMe: false,
  };
}

// ───────────────── WAHA'DAN SOHBETLERI YUKLE ─────────────────
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
  const yollar = [
    `/api/${OTURUM}/chats/${encodeURIComponent(jid)}/messages?limit=${adet}&downloadMedia=false`,
    `/api/messages?session=${OTURUM}&chatId=${encodeURIComponent(jid)}&limit=${adet}`,
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
        sohbetleriYukle().catch((e) => log('sohbet yukleme hatasi:', e.message));
      }
      if (veri.qr || veri.qrCode) { sonQR = veri.qr || veri.qrCode; }
      return;
    }

    // ── MESAJ DURUMU (tek/cift tik) ──
    if (/message\.ack/.test(tip)) {
      const jid = jidAl(veri) || veri.chatId;
      const id = veri.id?._serialized || veri.id;
      yayinla({ type: 'msgStatus', jid, id, durum: veri.ack || 1 });
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
      log(`📩 ${c.isGroup ? '[grup]' : '[kisi]'} ${c.name}: ${(m.text || m.kind).slice(0, 50)}`);
      yayinla({ type: 'msgAppend', jid, mesaj: m });
      yayinla({ type: 'chatSync', jid, unread: c.unread, ozelUnread: c.ozelUnread, muhUnread: 0, lastTime: c.lastTime, lastTs: c.lastTs });
      // Sohbeti guncel haliyle de yolla: liste yeniden siralansin, yeni
      // sohbetse listeye eklensin, onizleme yazisi guncellensin.
      yayinla({ type: 'chats', chats: [sohbetGuvenli(c)], append: true });
      return;
    }
  } catch (e) { log('olay islenemedi:', e.message); }
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
          const r = await waha('/api/sendText', { method: 'POST', body: { session: OTURUM, chatId: m.jid, text: m.text || '' } });
          const sure = Date.now() - t0;
          const id = r?.id?._serialized || r?.id || kimlik('g');
          const yeni = {
            id, text: m.text || '', kind: 'text', fromMe: true, sender: 'Ben',
            ts: Date.now(), time: saat(Date.now()), durum: 1,
          };
          const liste = mesajlar.get(m.jid) || [];
          liste.push(yeni); mesajlar.set(m.jid, liste);
          const c = sohbetler.get(m.jid);
          if (c) { c.lastTs = yeni.ts; c.lastTime = yeni.time; }
          log(`📤 gonderildi (${sure} ms): ${(m.text || '').slice(0, 40)}`);
          yayinla({ type: 'msgAppend', jid: m.jid, mesaj: yeni });
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

      if (m.type === 'getTeam') return G({ type: 'teamList', team: [{ username: KULLANICI, displayName: 'WAHA Test', role: 'admin' }] });
      if (m.type === 'getLabels') return G({ type: 'labelsList', labels: [] });
      if (m.type === 'internalList') return G({ type: 'internalListResult', items: [], users: [], me: KULLANICI });
      if (m.type === 'getGroupMembers') {
        const c = sohbetler.get(m.jid);
        return G({ type: 'chatSync', jid: m.jid, members: (c && c.members) || [] });
      }
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
        await sohbetleriYukle().catch((e) => log('sohbet yukleme:', e.message));
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
