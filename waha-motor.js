/* =====================================================================
   WAHA MOTORU — Baileys uyumlu ara katman
   ---------------------------------------------------------------------
   NE YAPAR:
     WAHA'yi (WhatsApp HTTP API) Baileys gibi gosterir. Boylece
     server.js'in TEK SATIRI degismeden WAHA uzerinden calisir:
     robot, satislar, odemeler, kullanicilar, etiketler, ic mesajlar,
     veritabani — HEPSI oldugu gibi calismaya devam eder.

   NEDEN BOYLE:
     server.js WhatsApp katmanindan sadece 14 komut ve 10 olay istiyor.
     Panelin 61 istegini + 38 API ucunu yeniden yazmak yerine, sadece
     bu 14 komutu WAHA'ya cevirmek yeterli. Cok daha az kod, cok daha
     az hata, ve "birebir ayni" garantisi.

   CANLIYI ETKILEMEZ:
     server.js'te MOTOR ayari varsayilan olarak 'baileys'. Bu dosya
     yalnizca MOTOR=waha oldugunda devreye girer.

   MESAJ BICIMI:
     WAHA'nin GOWS motoru ham WhatsApp mesajini '_data.Message' altinda
     veriyor ve bu bicim Baileys ile AYNI (conversation, imageMessage,
     documentMessage...). Bu yuzden server.js'in mesaj cozucusu
     degismeden calisiyor.
   ===================================================================== */
'use strict';
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');

// ───────────────────────── AYARLAR ─────────────────────────
const WAHA_URL = (process.env.WAHA_URL || 'http://localhost:3000').replace(/\/+$/, '');
const WAHA_API_KEY = process.env.WAHA_API_KEY || '';
const WAHA_OTURUM = process.env.WAHA_OTURUM || 'default';
// Kopru bu portta dinler; WAHA olaylari buraya gelir.
const WAHA_KANCA_PORT = Number(process.env.WAHA_KANCA_PORT) || 3210;
// WAHA Docker KUTUSUNUN ICINDE calisiyor, bu sunucu DISINDA.
// Kutunun icinden 'localhost' KUTUNUN KENDISI demek — bizim sunucuya
// ulasamaz. Bu yuzden kutudan host'a giden adresi kullaniyoruz.
// Docker bunun icin 'host.docker.internal' adini sagliyor.
const WAHA_KANCA_URL = process.env.WAHA_KANCA_URL
  || ('http://host.docker.internal:' + WAHA_KANCA_PORT);

// ───────────────────────── YARDIMCILAR ─────────────────────────
const log = (...a) => console.log('[waha]', ...a);

// ZAMAN ASIMI ZORUNLU: zaman asimi olmayan bir fetch, karsi taraf yanit
// vermezse SONSUZA KADAR bekler ve hicbir sey loga dusmez — "sessiz
// takilma". (2026-08: ilk sohbet listesi tam bu yuzden hic calismadi;
// /chats/overview 607 sohbet icin yanit vermiyordu.)
const ISTEK_ZAMAN_ASIMI = Number(process.env.WAHA_ZAMAN_ASIMI_MS) || 120000;

async function istek(yol, secenek = {}) {
  const bas = { 'Content-Type': 'application/json' };
  if (WAHA_API_KEY) bas['X-Api-Key'] = WAHA_API_KEY;
  const sure = secenek.zamanAsimiMs || ISTEK_ZAMAN_ASIMI;
  const iptal = new AbortController();
  const saat = setTimeout(() => iptal.abort(), sure);
  let r;
  try {
    r = await fetch(WAHA_URL + yol, {
      method: secenek.method || 'GET',
      headers: bas,
      body: secenek.body ? JSON.stringify(secenek.body) : undefined,
      signal: iptal.signal,
    });
  } catch (e) {
    clearTimeout(saat);
    if (e && e.name === 'AbortError') {
      const z = new Error('WAHA yanit vermedi (' + Math.round(sure / 1000) + 'sn zaman asimi): ' + yol);
      z.zamanAsimi = true;
      throw z;
    }
    throw e;
  }
  clearTimeout(saat);
  const metin = await r.text();
  let veri = null;
  try { veri = metin ? JSON.parse(metin) : null; } catch (_) { veri = metin; }
  if (!r.ok) {
    const e = new Error('WAHA ' + r.status + ': ' + String(typeof veri === 'string' ? veri : JSON.stringify(veri)).slice(0, 200));
    e.status = r.status;
    e.output = { statusCode: r.status };   // Baileys hata bicimi
    throw e;
  }
  return veri;
}

// "905399265440:98@s.whatsapp.net" -> "905399265440@s.whatsapp.net"
function numaraTemizle(j) {
  if (!j) return '';
  const s = String(j);
  if (!s.includes('@')) return s;
  const [sol, sag] = s.split('@');
  return sol.split(':')[0] + '@' + (sag === 'c.us' ? 's.whatsapp.net' : sag);
}
function jidAl(x) {
  if (!x) return '';
  return String((x.id && x.id._serialized) || x.JID || x.id || x.jid || x.chatId
    || x.ChatID || x.Chat || x.from || x.LID || x.lid || '');
}
function zamanAl(x) {
  if (!x) return 0;
  const adaylar = [x.timestamp, x.t, x.messageTimestamp,
    x._data && x._data.Info && x._data.Info.Timestamp,
    x.lastMessage && x.lastMessage.timestamp];
  for (const a of adaylar) {
    if (typeof a === 'string' && a.includes('T')) {   // ISO tarih
      const n = Date.parse(a); if (n) return Math.floor(n / 1000);
    }
    const n = Number(a);
    if (!n || !isFinite(n)) continue;
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  return Math.floor(Date.now() / 1000);
}

// @lid -> gercek numara eslesmesi (mesajlardan ogreniyoruz)
const lidNumara = new Map();

// KENDI KIMLIGIMIZ — numara VE @lid birlikte.
// NEDEN LID DE LAZIM: gruplarda WhatsApp gizli kimlik (@lid) kullaniyor.
// Biri grupta bizi etiketlerse, etiket numarayla degil LID ile geliyor.
// server.js 'myLID' bos kalirsa "Bana Etiketlenenler" sekmesi CALISMAZ
// ve bahsedilme bildirimi dusmez. Baileys bunu sock.user.lid'de veriyor,
// biz de WAHA'nin oturum bilgisinden ayni alani dolduruyoruz.
function benKur(ben) {
  ben = ben || {};
  const lidHam = ben.lid || ben.LID || ben.jidAlt || ben.JIDAlt || ben.altJid || '';
  const u = {
    id: numaraTemizle(ben.id || ben.jid || ben.JID || ''),
    name: ben.pushName || ben.PushName || ben.name || ben.Name || '',
  };
  if (lidHam) u.lid = String(lidHam).split(':')[0];   // cihaz ekini at (":98")
  return u;
}

// ═══ WAHA MESAJINI BAILEYS BICIMINE CEVIR ═══════════════════════════
// GOWS ham WhatsApp mesajini _data.Message altinda veriyor ve bu bicim
// Baileys ile AYNI. Bu yuzden server.js'in cozucusu degismeden calisiyor.
function baileysMesaji(w) {
  if (!w) return null;
  const bilgi = (w._data && w._data.Info) || {};
  const sohbet = w.from || w.chatId || bilgi.Chat || jidAl(w);
  const grupMu = String(sohbet).includes('@g.us');
  const benimMi = !!(w.fromMe || bilgi.IsFromMe);

  // katilimci (grupta kimin yazdigi) — gercek numarayi tercih et
  let katilimci = '';
  if (grupMu) {
    const alt = bilgi.SenderAlt || '';
    const sender = bilgi.Sender || w.participant || w.author || '';
    if (alt) { katilimci = numaraTemizle(alt); if (sender) lidNumara.set(sender, katilimci); }
    else if (sender) katilimci = lidNumara.get(sender) || numaraTemizle(sender);
  }

  // ham WhatsApp icerigi (Baileys ile ayni yapı)
  let icerik = (w._data && w._data.Message) || null;
  if (!icerik) {
    // Yedek: ham icerik gelmediyse en azindan metni kur
    const govde = w.body || w.text || '';
    icerik = govde ? { conversation: govde } : { conversation: '' };
  }

  return {
    key: {
      remoteJid: sohbet,
      fromMe: benimMi,
      id: (w.id && w.id._serialized) || w.id || bilgi.ID || '',
      participant: katilimci || undefined,
    },
    message: icerik,
    messageTimestamp: zamanAl(w),
    pushName: bilgi.PushName || w.notifyName || w.pushName || '',
    status: Number(w.ack || 0),
    // WAHA'nin indirdigi dosyanin adresi — medya indirmede kullanilir
    _wahaMedya: (w.media && (w.media.url || w.media.URL)) || w.mediaUrl || null,
    _wahaDosyaAdi: (w.media && (w.media.filename || w.media.fileName)) || '',
    _wahaMime: (w.media && w.media.mimetype) || '',
  };
}

// ═══ GRUP BILGISI: WAHA -> Baileys bicimi ═══════════════════════════
// GOWS BUYUK harfli alanlar veriyor: Name, Topic, Participants, JID
function baileysGrup(g) {
  if (!g) return null;
  const jid = jidAl(g);
  const uyeler = (g.Participants || g.participants || []).map((p) => {
    const lid = p.LID || p.lid || p.JID || p.jid || '';
    let num = String(p.PhoneNumber || p.phoneNumber || '').replace(/[^0-9]/g, '');
    if (!num) {
      const ogr = lidNumara.get(lid) || lidNumara.get(p.JID || '');
      if (ogr) num = String(ogr).split('@')[0].split(':')[0];
    }
    if (!num) {
      const j = String(p.JID || p.jid || '');
      if (j && !j.includes('@lid')) num = j.split('@')[0].split(':')[0];
    }
    return {
      id: num ? (num + '@s.whatsapp.net') : lid,
      lid,
      admin: (p.IsSuperAdmin || p.isSuperAdmin) ? 'superadmin'
        : (p.IsAdmin || p.isAdmin || p.admin) ? 'admin' : null,
      name: p.DisplayName || p.displayName || p.name || '',
    };
  }).filter((u) => u.id);

  return {
    id: jid,
    subject: g.Name || g.name || g.subject || '',
    desc: (g.TopicDeleted === true) ? '' : (g.Topic || g.topic || g.description || g.desc || ''),
    participants: uyeler,
    announce: !!(g.IsAnnounce || g.isAnnounce || g.announce),
    restrict: !!(g.IsLocked || g.isLocked),
    owner: numaraTemizle(g.OwnerPN || g.OwnerJID || g.owner || ''),
    size: Number(g.ParticipantCount || g.participantCount || uyeler.length || 0),
    creation: zamanAl({ timestamp: g.GroupCreated }),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  ILK SOHBET LISTESI — "gruplar gelmiyor" duzeltmesi (2026-08)
//  -----------------------------------------------------------------
//  SORUN NEYDI:
//    server.js sohbet listesini SADECE iki yerden dolduruyor:
//      1) acilista Supabase'den            (loadFromDB)
//      2) Baileys'in gecmis paketinden     ('messaging-history.set')
//    fetchAllGroups() listeye grup EKLEMEZ — bilerek boyle yazilmis
//    ("bos/olu gruplar gorunmesin, mesaj geldikce eklensin"), sadece
//    zaten listede olanin adini/uye sayisini tazeler.
//    WAHA'da 2. yol HIC yoktu. Yeni bir hatta (waha_ oneki -> DB bos)
//    iki kaynak da bos kaliyor ve liste sonsuza kadar "0 sohbet".
//    Yani WAHA'nin degil, eksik olayin sorunuydu.
//
//  COZUM:
//    WAHA'dan sohbet listesini cekip Baileys'in gecmis paketi bicimine
//    cevirip AYNI olayi yayiyoruz. server.js'te tek satir degismiyor.
//
//  TAZE QR UYARISI:
//    Yeni QR okutulunca WhatsApp senkronu dakikalar surebiliyor; ilk
//    denemede liste bos gelebilir. Bu yuzden azalan siklikta tekrar
//    deneniyor ve her turda SADECE yeni gorulen sohbetler yayinlaniyor.
// ═══════════════════════════════════════════════════════════════════

// auto = once sohbet listesi, olmazsa grup listesi
// sohbetler / gruplar / kapali ile elle secilebilir (.env: WAHA_ILK_LISTE)
const ILK_LISTE_MOD = (process.env.WAHA_ILK_LISTE || 'auto').toLowerCase();
// Deneme takvimi (ms) — senkron gec biterse yakalayalim
const ILK_LISTE_TAKVIM = [5000, 20000, 45000, 90000, 180000, 300000, 600000, 1200000];

// Sohbetin son mesaj zamani (saniye). BILINMIYORSA 0 doner.
// (zamanAl'dan farki: o bilinmeyende 'simdi' donuyor -> her sohbet
//  yeni mesaj gelmis gibi en uste ciksin istemiyoruz.)
function sohbetZamani(c) {
  const son = c.lastMessage || c.LastMessage || null;
  const adaylar = [
    c.conversationTimestamp, c.ConversationTimestamp,
    c.timestamp, c.Timestamp, c.t,
    son && (son.timestamp || son.Timestamp || son.t),
    son && son._data && son._data.Info && son._data.Info.Timestamp,
  ];
  for (const a of adaylar) {
    if (typeof a === 'string' && a.includes('T')) {
      const n = Date.parse(a); if (n) return Math.floor(n / 1000);
    }
    const n = Number(a);
    if (!n || !isFinite(n)) continue;
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  return 0;
}

// Sohbet adi — GOWS BUYUK harf veriyor, digerleri kucuk. Hepsini dene.
function sohbetAdi(c) {
  const son = c.lastMessage || c.LastMessage || null;
  return String(c.name || c.Name || c.subject || c.Subject || c.DisplayName
    || c.pushName || c.PushName || c.notifyName
    || (son && (son.notifyName || son.pushName)) || '').trim();
}

// Bir ucu sayfa sayfa oku. Uc 'offset'i yok sayarsa ayni sayfa tekrar
// gelir — o zaman donguye girmeden durur.
async function _sayfaliCek(temelYol, zamanAsimiMs) {
  const hepsi = [];
  const gorulen = new Set();
  const ADIM = 500;
  const TAVAN = 60;                    // 60 x 500 = 30.000 kayit tavani
  for (let sayfa = 0; sayfa < TAVAN; sayfa++) {
    const ayrac = temelYol.includes('?') ? '&' : '?';
    const veri = await istek(temelYol + ayrac + 'limit=' + ADIM + '&offset=' + (sayfa * ADIM), { zamanAsimiMs });
    const dizi = Array.isArray(veri) ? veri
      : (veri && Array.isArray(veri.data)) ? veri.data
      : (veri && Array.isArray(veri.chats)) ? veri.chats : [];
    if (!dizi.length) break;
    let yeni = 0;
    for (const x of dizi) {
      const j = jidAl(x);
      if (!j || gorulen.has(j)) continue;
      gorulen.add(j); hepsi.push(x); yeni++;
    }
    if (!yeni) break;                  // uc offset'i yok sayiyor
    if (dizi.length < ADIM) break;     // son sayfa
  }
  return hepsi;
}

// ═══ ORTAK YAYIN NOKTASI ═══════════════════════════════════════════
// Nereden gelirse gelsin (sohbet ucu, grup ucu, ya da server.js'in
// zaten cagirdigi groupFetchAllParticipating) sohbetler BURADAN gecer.
// Ayni sohbet iki kez panele dusmez.
function yeniSohbetleriYayinla(sock, kayitlar, kaynak) {
  if (!sock || sock._kapali) return 0;
  if (!sock._gorulenSohbetler) sock._gorulenSohbetler = new Set();
  const liste = [];
  let yeniSayisi = 0;
  for (const k of (kayitlar || [])) {
    if (!k) continue;
    let jid = jidAl(k);
    if (!jid || !jid.includes('@')) continue;
    if (jid.endsWith('@c.us')) jid = jid.split('@')[0] + '@s.whatsapp.net';
    if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
    if (!sock._gorulenSohbetler.has(jid)) { sock._gorulenSohbetler.add(jid); yeniSayisi++; }
    liste.push({
      id: jid,
      name: sohbetAdi(k) || undefined,                  // bos ise server.js jid'den turetir
      conversationTimestamp: sohbetZamani(k) || undefined,
      unreadCount: Number(k.unreadCount || k.UnreadCount || k.unread || 0) || 0,
    });
  }
  if (!liste.length) return 0;

  // ═══ NEDEN HEPSINI GONDERIYORUZ, SADECE YENILERI DEGIL ═══════════
  // Kullanici panelden "verileri sil" dediginde sohbetler hem
  // veritabanindan hem bellekten gidiyor. Eger burada "bunu zaten
  // gondermistim" diye elersek gruplar bir daha GERI GELMEZ — sunucuyu
  // yeniden baslatmak gerekirdi. Bu yuzden her turda tam liste gidiyor.
  // Maliyeti yok: server.js zaten 'if (!chats.has(jid))' ile bakiyor,
  // mevcut olani atliyor. Sadece EKSIK olanlar geri ekleniyor.
  const grup = liste.filter((x) => x.id.endsWith('@g.us')).length;
  log('liste (' + kaynak + '): ' + liste.length + ' sohbet gonderildi ('
    + grup + ' grup, ' + (liste.length - grup) + ' kisi'
    + (yeniSayisi ? ', ' + yeniSayisi + ' yeni' : '') + ')');

  // ═══ 'messages' ALANI BILEREK GONDERILMIYOR ══════════════════════
  // server.js'te o alan bir dizi ise, SADECE mesaj islemek icin degil,
  // BELLEKTEKI TUM SOHBETLERI tek tek veritabanina yazmak icin de bir
  // dongu doner. Bos dizi ([]) bile o donguyu tetikliyor. 7000 sohbette
  // her yayinda 7000 yazma demek — Supabase'i bogar. Alani hic
  // gondermeyince o dongu atlaniyor; sohbetleri zaten fetchAllGroups
  // kendi olculu kuyruguyla (siraliKaydet) yaziyor.
  sock.ev.emit('messaging-history.set', { chats: liste, contacts: [], isLatest: true });
  return liste.length;
}

// Sohbet listesi uclarini SIRAYLA dene. Her adim loga yazilir —
// bir daha "sessizce hicbir sey olmadi" durumu yasanmasin.
async function ilkListeyiCek(sock) {
  const denenecek = [];
  if (ILK_LISTE_MOD !== 'gruplar') {
    // hafif uc once: sadece sohbet listesi
    denenecek.push(['sohbetler', '/api/' + WAHA_OTURUM + '/chats', 25000]);
    // agir uc sonra: her sohbetin son mesaji + fotografi (yuzlerce sohbette yavas)
    denenecek.push(['sohbetler/overview', '/api/' + WAHA_OTURUM + '/chats/overview', 45000]);
  }
  if (ILK_LISTE_MOD !== 'sohbetler') {
    denenecek.push(['gruplar', '/api/' + WAHA_OTURUM + '/groups', 60000]);
  }
  for (const [ad, yol, sure] of denenecek) {
    log('liste deneniyor: ' + ad + ' ...');
    let kayitlar;
    try {
      kayitlar = await _sayfaliCek(yol, sure);
    } catch (e) {
      log('  ' + ad + ' olmadi: ' + String(e.message).slice(0, 110));
      continue;
    }
    if (!kayitlar.length) { log('  ' + ad + ': bos geldi'); continue; }
    log('  ' + ad + ': ' + kayitlar.length + ' kayit | alan adlari: ' + Object.keys(kayitlar[0]).join(', '));
    return { ad, kayitlar };
  }
  return { ad: '', kayitlar: [] };
}

// Bir liste deneme turu
async function ilkListeTuru(sock, sira) {
  if (sock._kapali) return;
  if (sock._ilkListeCalisiyor) return;      // onceki tur hala suruyor -> ust uste binmesin
  sock._ilkListeCalisiyor = true;
  try {
    const sonuc = await ilkListeyiCek(sock);
    if (!sonuc.kayitlar.length) {
      if (sira === 0) log('liste: WAHA henuz sohbet vermedi — senkron bitince tekrar denenecek');
      return;
    }
    const eklenen = yeniSohbetleriYayinla(sock, sonuc.kayitlar, sonuc.ad);
    // Liste geldi -> kalan denemeler gereksiz, iptal.
    // Sonradan kurulan gruplar zaten server.js'in periyodik tazelemesiyle
    // (groupFetchAllParticipating) yakalaniyor — o yol da artik listeye ekliyor.
    if (sonuc.kayitlar.length) {
      ilkListeTimerlariTemizle(sock);
      if (!eklenen) log('liste: hepsi zaten listedeydi, tekrar denemeler iptal');
    }
  } catch (e) {
    log('liste turu hatasi: ' + e.message);
  } finally {
    sock._ilkListeCalisiyor = false;
  }
}

// Baglanti acildiginda takvimi kur (soket basina bir kez)
function ilkListeBaslat(sock) {
  if (sock._ilkListeBasladi) return;
  if (ILK_LISTE_MOD === 'kapali') { log('liste cekimi kapali (WAHA_ILK_LISTE=kapali)'); return; }
  sock._ilkListeBasladi = true;
  // groupFetchAllParticipating bu soketi bizden once kullanmis olabilir —
  // o zaman set zaten dolu, sifirlamayalim yoksa ayni gruplar tekrar duser.
  if (!sock._gorulenSohbetler) sock._gorulenSohbetler = new Set();
  sock._ilkListeTimerlar = [];
  ILK_LISTE_TAKVIM.forEach((gecikme, i) => {
    sock._ilkListeTimerlar.push(setTimeout(() => {
      ilkListeTuru(sock, i).catch((e) => log('liste turu: ' + e.message));
    }, gecikme));
  });
  log('liste takvimi kuruldu (ilk deneme 5sn sonra, sonra 20sn/45sn/90sn...)');
}
// Sadece liste denemelerini iptal et (gecmis cekimi devam etsin)
function ilkListeTimerlariTemizle(sock) {
  (sock._ilkListeTimerlar || []).forEach(clearTimeout);
  sock._ilkListeTimerlar = [];
}
function ilkListeDurdur(sock) {
  ilkListeTimerlariTemizle(sock);
}

// ═══════════════════════════════════════════════════════════════════
//  SOKET — Baileys arayuzu
// ═══════════════════════════════════════════════════════════════════
function wahaSoketYap(secenek = {}) {
  const ev = new EventEmitter();
  ev.setMaxListeners(50);
  const sock = {
    ev,
    user: null,
    ws: { isOpen: false, close() { sock.ws.isOpen = false; } },
    _waha: true,
    _kapali: false,
  };

  // ── 1) MESAJ GONDER ──
  sock.sendMessage = async (jid, icerik, ayar = {}) => {
    const ortak = { session: WAHA_OTURUM, chatId: jid };
    if (ayar.quoted && ayar.quoted.key && ayar.quoted.key.id) ortak.reply_to = ayar.quoted.key.id;
    if (icerik.mentions && icerik.mentions.length) ortak.mentions = icerik.mentions;

    let yanit;
    if (icerik.text != null) {
      yanit = await istek('/api/sendText', { method: 'POST', body: { ...ortak, text: icerik.text } });
    } else if (icerik.image) {
      const b64 = Buffer.isBuffer(icerik.image) ? icerik.image.toString('base64') : String(icerik.image);
      yanit = await istek('/api/sendImage', { method: 'POST', body: { ...ortak, caption: icerik.caption || '',
        file: { mimetype: icerik.mimetype || 'image/jpeg', filename: icerik.fileName || 'foto.jpg', data: b64 } } });
    } else if (icerik.video) {
      const b64 = Buffer.isBuffer(icerik.video) ? icerik.video.toString('base64') : String(icerik.video);
      yanit = await istek('/api/sendVideo', { method: 'POST', body: { ...ortak, caption: icerik.caption || '',
        file: { mimetype: icerik.mimetype || 'video/mp4', filename: icerik.fileName || 'video.mp4', data: b64 } } });
    } else if (icerik.audio) {
      const b64 = Buffer.isBuffer(icerik.audio) ? icerik.audio.toString('base64') : String(icerik.audio);
      yanit = await istek('/api/sendVoice', { method: 'POST', body: { ...ortak,
        file: { mimetype: icerik.mimetype || 'audio/ogg; codecs=opus', filename: 'ses.ogg', data: b64 } } });
    } else if (icerik.document) {
      const b64 = Buffer.isBuffer(icerik.document) ? icerik.document.toString('base64') : String(icerik.document);
      yanit = await istek('/api/sendFile', { method: 'POST', body: { ...ortak, caption: icerik.caption || '',
        file: { mimetype: icerik.mimetype || 'application/octet-stream', filename: icerik.fileName || 'dosya', data: b64 } } });
    } else if (icerik.delete) {
      // mesaj silme (herkesten)
      const silId = icerik.delete.id || icerik.delete;
      await istek('/api/' + WAHA_OTURUM + '/chats/' + jid + '/messages/' + silId, { method: 'DELETE' });
      return { key: { id: silId, remoteJid: jid, fromMe: true } };
    } else if (icerik.react) {
      await istek('/api/reaction', { method: 'PUT', body: { session: WAHA_OTURUM,
        messageId: (icerik.react.key && icerik.react.key.id) || icerik.react.key, reaction: icerik.react.text || '' } });
      return { key: { id: 'react', remoteJid: jid, fromMe: true } };
    } else if (icerik.poll) {
      yanit = await istek('/api/sendPoll', { method: 'POST', body: { ...ortak,
        poll: { name: icerik.poll.name, options: icerik.poll.values || [], multipleAnswers: false } } });
    } else if (icerik.forward) {
      yanit = await istek('/api/forwardMessage', { method: 'POST', body: { session: WAHA_OTURUM,
        chatId: jid, messageId: (icerik.forward.key && icerik.forward.key.id) || icerik.forward.id } });
    } else if (icerik.edit) {
      yanit = await istek('/api/' + WAHA_OTURUM + '/chats/' + jid + '/messages/' + (icerik.edit.id || icerik.edit),
        { method: 'PUT', body: { text: icerik.text || '' } });
    } else {
      throw new Error('WAHA: desteklenmeyen mesaj turu');
    }

    const id = (yanit && ((yanit.id && yanit.id._serialized) || yanit.id)) || ('waha_' + Date.now());
    return { key: { id, remoteJid: jid, fromMe: true }, message: icerik, status: 1 };
  };

  // ── 2) OKUNDU ISARETLE ──
  sock.readMessages = async (anahtarlar) => {
    const jidler = [...new Set((anahtarlar || []).map((k) => k && k.remoteJid).filter(Boolean))];
    for (const jid of jidler) {
      try { await istek('/api/sendSeen', { method: 'POST', body: { session: WAHA_OTURUM, chatId: jid } }); } catch (_) {}
    }
  };

  // ── 3) NUMARA WHATSAPP'TA VAR MI ──
  sock.onWhatsApp = async (...numaralar) => {
    const sonuc = [];
    for (const n of numaralar.flat()) {
      const temiz = String(n).replace(/\D/g, '');
      if (!temiz) continue;
      try {
        const r = await istek('/api/contacts/check-exists?phone=' + temiz + '&session=' + WAHA_OTURUM);
        sonuc.push({ jid: (r && r.chatId) || (temiz + '@s.whatsapp.net'), exists: !!(r && (r.numberExists || r.exists)) });
      } catch (_) { sonuc.push({ jid: temiz + '@s.whatsapp.net', exists: true }); }
    }
    return sonuc;
  };

  // ── 4) GRUP BILGISI ──
  sock.groupMetadata = async (jid) => {
    const g = await istek('/api/' + WAHA_OTURUM + '/groups/' + jid);
    const b = baileysGrup(g);
    if (!b) throw new Error('grup bulunamadi');
    return b;
  };

  // ── 5) TUM GRUPLAR ──
  sock.groupFetchAllParticipating = async () => {
    // ═══ SABIT SINIR KALDIRILDI (2026-08) ═══════════════════════════
    // ESKIDEN: '?limit=1000' yaziliydi. 7000 gruplu bir hatta sessizce
    // ilk 1000 grubu alip gerisini HIC gormuyordu — hata da vermiyor,
    // sadece eksik calisiyordu. Artik sayfa sayfa, sonuna kadar okur.
    const liste = await _sayfaliCek('/api/' + WAHA_OTURUM + '/groups');
    const sonuc = {};
    for (const g of liste) {
      const b = baileysGrup(g);
      if (b && b.id) sonuc[b.id] = b;
    }
    // ═══ GARANTI YOL (2026-08) ═══════════════════════════════════════
    // server.js bunu zaten cagiriyor (fetchAllGroups) ve CALISTIGI
    // kanitlandi — 607 grup dondu. Ama fetchAllGroups gruplari listeye
    // EKLEMEZ, sadece adlarini tazeler ("bos gruplar gorunmesin" karari).
    // Yeni bir hatta liste bos oldugu icin hicbiri gorunmuyordu.
    // Cozum: elimize gecen gruplari ayni anda gecmis paketi olarak da
    // yayinla. Boylece liste, ZATEN CALISAN cagriyla doluyor —
    // sohbet ucunun destekleniyor olmasina bagli kalmiyoruz.
    // Tekrar eleme yeniSohbetleriYayinla icinde: ayni grup iki kez dusmez.
    const kayitlar = Object.values(sonuc);
    if (kayitlar.length) {
      setTimeout(() => {
        try {
          yeniSohbetleriYayinla(sock, kayitlar, 'gruplar/toplu');
        } catch (_) {}
      }, 0);
    }
    return sonuc;
  };

  // ── 6) GRUP ADI / ACIKLAMA / UYE ──
  sock.groupUpdateSubject = async (jid, ad) =>
    istek('/api/' + WAHA_OTURUM + '/groups/' + jid + '/subject', { method: 'PUT', body: { subject: ad } });
  sock.groupUpdateDescription = async (jid, aciklama) =>
    istek('/api/' + WAHA_OTURUM + '/groups/' + jid + '/description', { method: 'PUT', body: { description: aciklama || '' } });
  sock.groupParticipantsUpdate = async (jid, katilimcilar, islem) => {
    const yol = islem === 'remove' ? 'participants/remove' : 'participants/add';
    await istek('/api/' + WAHA_OTURUM + '/groups/' + jid + '/' + yol,
      { method: 'POST', body: { participants: (katilimcilar || []).map((x) => ({ id: x })) } });
    return (katilimcilar || []).map((x) => ({ jid: x, status: '200' }));
  };

  // ── 8) GECMIS MESAJ CEKME (kacan mesaj telafisi) ──
  // server.js bunu iki yerde cagiriyor: kacanMesajTelafi() ve mesajiAktifCek().
  // Baileys'te WhatsApp'a "su mesajdan oncekileri gonder" der, gelenler
  // 'messaging-history.set' olayindan duser. Burada ayni isi WAHA'nin
  // sohbet mesajlari ucundan yapiyoruz ve AYNI olayi yayiyoruz — yani
  // server.js tarafinda hicbir sey degismiyor.
  //
  // KAPSAM BILEREK DAR: server.js zaten en aktif 30 grupla sinirli
  // cagiriyor. Burada da sohbet basina 50 mesaj tavani var. 7000 gruplu
  // bir hatta toplu tarama YAPILMIYOR — canlidaki davranis da bu.
  sock.fetchMessageHistory = async (adet, anahtar, zamanDamgasi) => {
    const jid = (anahtar && anahtar.remoteJid) || '';
    if (!jid) return '';
    // Baileys'te 'adet' ~50'lik paket sayisi demek; makul bir mesaj sayisina cevir
    const limit = Math.min(50, Math.max(10, Number(adet) * 10 || 20));
    // DIKKAT: '@' KODLANMAMALI (encodeURIComponent kullanma) — WAHA sohbeti bulamiyor
    const yol = '/api/' + WAHA_OTURUM + '/chats/' + jid + '/messages'
      + '?limit=' + limit + '&downloadMedia=false';
    let ham;
    try {
      ham = await istek(yol, { zamanAsimiMs: 20000 });
    } catch (e) {
      if (!sock._gecmisUyarisi) {
        sock._gecmisUyarisi = true;
        log('gecmis cekilemedi (bir kez yazilir): ' + String(e.message).slice(0, 110));
      }
      return '';
    }
    const dizi = Array.isArray(ham) ? ham : (ham && Array.isArray(ham.data) ? ham.data : []);
    if (!dizi.length) return '';
    const mesajlar = [];
    for (const w of dizi) {
      const m = baileysMesaji(w);
      if (!m) continue;
      if (!m.key.remoteJid) m.key.remoteJid = jid;   // uc sohbet kimligini vermediyse
      // Baslangic noktasindan ESKI olanlar isteniyor (Baileys boyle davranir)
      if (zamanDamgasi && m.messageTimestamp && m.messageTimestamp > Number(zamanDamgasi)) continue;
      mesajlar.push(m);
    }
    if (!mesajlar.length) return '';
    sock.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: mesajlar, isLatest: false });
    return '';
  };

  // ── 9) DIGERLERI ──
  sock.presenceSubscribe = async (jid) => {
    try { await istek('/api/' + WAHA_OTURUM + '/presence/' + jid + '/subscribe', { method: 'POST' }); } catch (_) {}
  };
  sock.sendPresenceUpdate = async (durum, jid) => {
    try {
      await istek(durum === 'composing' ? '/api/startTyping' : '/api/stopTyping',
        { method: 'POST', body: { session: WAHA_OTURUM, chatId: jid } });
    } catch (_) {}
  };
  sock.getBusinessProfile = async (jid) => {
    try { return await istek('/api/' + WAHA_OTURUM + '/contacts/' + jid + '/profile'); } catch (_) { return null; }
  };
  sock.profilePictureUrl = async (jid) => {
    try {
      const r = await istek('/api/contacts/profile-picture?contactId=' + jid + '&session=' + WAHA_OTURUM);
      return (r && (r.profilePictureURL || r.url)) || null;
    } catch (_) { return null; }
  };
  sock.resyncAppState = async () => { /* WAHA'da karsiligi yok, sessizce gec */ };
  sock.query = async () => ({ ok: true });          // kalp atisi yedegi
  sock.updateMediaMessage = async (m) => m;         // medya WAHA'dan iniyor
  sock.logout = async () => {
    try { await istek('/api/sessions/' + WAHA_OTURUM + '/logout', { method: 'POST' }); } catch (_) {}
    sock._kapali = true; sock.ws.isOpen = false;
  };
  sock.end = () => {
    sock._kapali = true; sock.ws.isOpen = false;
    if (sock._qrTimer) { clearInterval(sock._qrTimer); sock._qrTimer = null; }
    ilkListeDurdur(sock);   // bekleyen liste denemeleri bosuna calismasin
  };

  return sock;
}

// ═══════════════════════════════════════════════════════════════════
//  MEDYA INDIRME — WAHA'nin verdigi adresten
// ═══════════════════════════════════════════════════════════════════
async function wahaMedyaIndir(m) {
  const kaynak = m && m._wahaMedya;
  if (!kaynak) throw new Error('WAHA medya adresi yok (WHATSAPP_DOWNLOAD_MEDIA acik mi?)');
  const url = String(kaynak).startsWith('http') ? kaynak : (WAHA_URL + kaynak);
  const bas = WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {};
  const r = await fetch(url, { headers: bas });
  if (!r.ok) throw new Error('medya indirilemedi: HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('medya bos geldi');
  return buf;
}


// ═══════════════════════════════════════════════════════════════════
//  BAGLANTI + OLAY KOPRUSU
//  WAHA olaylarini Baileys olaylarina cevirir. server.js'in dinledigi
//  10 olayin hepsi burada uretiliyor.
// ═══════════════════════════════════════════════════════════════════
const http = require('http');
let _kancaSunucu = null;
const _dinleyiciler = new Set();   // aktif soketler (olaylari dagitmak icin)
let _olaySayaci = 0;               // WAHA'dan kac olay geldi
const _olayTipleri = new Map();

// ═══ KANCA BEKCISI ══════════════════════════════════════════════════
// Baglanti kuruldugu halde WAHA'dan hic olay gelmiyorsa panel bos kalir
// ve sebebi anlasilmaz (mesaj dusmez, tik gelmez). 90 saniye sonra
// kontrol edip NE YAPILACAGINI yaziyoruz.
function kancaBekcisi(sock) {
  if (sock._kancaBekcisiKuruldu) return;
  sock._kancaBekcisiKuruldu = true;
  setTimeout(() => {
    if (sock._kapali || _olaySayaci > 0) return;
    log('');
    log('╔═══════════════════════════════════════════════════════════');
    log('║ ⚠️  WAHA BAGLI AMA 90 SANIYEDIR HIC OLAY GELMEDI');
    log('║');
    log('║ Panelde mesaj gorunmemesinin sebebi budur. Baglanti var,');
    log('║ gruplar geliyor, ama WAHA olaylari bize ULASAMIYOR.');
    log('║');
    log('║ WAHA su adrese gondermeye calisiyor:');
    log('║   ' + WAHA_KANCA_URL + '/olay');
    log('║');
    log('║ Sirayla kontrol et:');
    log('║  1) Guvenlik duvari Docker\'dan gelen istegi engelliyor olabilir:');
    log('║     ufw allow from 172.16.0.0/12 to any port ' + WAHA_KANCA_PORT);
    log('║  2) docker-compose.yml icindeki WHATSAPP_HOOK_URL eski');
    log('║     kopruyu (kopru:3002) gosteriyorsa sil ya da duzelt.');
    log('║  3) .env icinde WAHA_KANCA_URL satiri OLMAMALI.');
    log('║  4) WAHA kutusunda extra_hosts host.docker.internal tanimli mi?');
    log('╚═══════════════════════════════════════════════════════════');
    log('');
  }, 90000);
}

// WAHA'dan gelen olaylari alan kucuk sunucu (tek kez acilir)
function kancaSunucusuAc() {
  if (_kancaSunucu) return;
  _kancaSunucu = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
    let govde = '';
    req.on('data', (c) => { govde += c; if (govde.length > 20e6) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      let olay = null;
      try { olay = JSON.parse(govde || '{}'); } catch (_) { return; }
      for (const s of _dinleyiciler) { try { s._olayIsle(olay); } catch (e) { log('olay hatasi:', e.message); } }
      // ── OLAY SAYACI ──
      // WAHA'dan hic olay gelmezse panel sessizce bos kalir ve sebebi
      // anlasilmaz. Ilk olayi ve sonra periyodik ozeti yaziyoruz.
      _olaySayaci++;
      const tip = String(olay.event || olay.type || '?');
      _olayTipleri.set(tip, (_olayTipleri.get(tip) || 0) + 1);
      if (_olaySayaci === 1) log('✅ WAHA\'dan ilk olay geldi: "' + tip + '" — koprü calisiyor');
      else if (_olaySayaci % 200 === 0) {
        log('olay ozeti (' + _olaySayaci + ' toplam): '
          + [..._olayTipleri].map(([t, n]) => t + '=' + n).join(' '));
      }
    });
  });
  // 0.0.0.0 -> Docker kutusundan da erisilebilsin (sadece localhost YETMEZ)
  _kancaSunucu.listen(WAHA_KANCA_PORT, '0.0.0.0', () => {
    log('olay koprusu dinliyor: ' + WAHA_KANCA_URL + '  (port ' + WAHA_KANCA_PORT + ')');
  });
  _kancaSunucu.on('error', (e) => log('olay koprusu hatasi: ' + e.message));
}

// Oturumu hazirla: yoksa olustur, webhook'u bizim kopruye yonlendir
const KANCA_OLAYLARI = ['message', 'message.any', 'message.ack', 'message.revoked', 'message.reaction',
  'session.status', 'state.change', 'group.v2.update', 'group.v2.participants',
  'presence.update', 'chat.archive'];

async function oturumHazirla() {
  const kanca = { url: WAHA_KANCA_URL + '/olay', events: KANCA_OLAYLARI };
  try {
    const s = await istek('/api/sessions/' + WAHA_OTURUM);
    const kayitli = (s.config && s.config.webhooks) || [];
    // Ne kayitli oldugunu HER ZAMAN yaz — bir daha koru koruna aramayalim
    log('WAHA kayitli olay adresi: ' + (kayitli.map((w) => w.url).join(' , ') || '(HIC YOK)'));
    for (const w of kayitli) {
      log('   ' + w.url + '  ->  olaylar: ' + ((w.events || []).join(',') || '(bos)'));
    }

    // ═══ SADECE ADRESE BAKMAK YETMIYOR (2026-08) ════════════════════
    // ESKI HATA: yalnizca url karsilastiriliyordu. Oturum daha once
    // baska bir surumle (ya da eski kopruyle) kurulduysa adres AYNI
    // kalir ama kayitli olay listesi eksik olabilir — ornegin sadece
    // 'session.status'. O zaman baglanti kurulur, QR gelir, gruplar
    // gelir AMA MESAJ HIC DUSMEZ. Kod da "adres dogru" deyip hicbir sey
    // yapmazdi. Artik olay listesi de karsilastiriliyor.
    const bizim = kayitli.find((w) => w.url === kanca.url);
    const eksikOlaylar = bizim
      ? KANCA_OLAYLARI.filter((e) => !((bizim.events || []).includes(e)))
      : KANCA_OLAYLARI;
    if (!bizim || eksikOlaylar.length) {
      log(bizim
        ? 'olay listesi eksik (' + eksikOlaylar.join(',') + ') — duzeltiliyor'
        : 'olay adresimiz kayitli degil — ekleniyor');
      try {
        await istek('/api/sessions/' + WAHA_OTURUM, { method: 'PUT', body: { config: { webhooks: [kanca] } } });
        log('olay adresi + olay listesi guncellendi');
        // Dogrulama: WAHA gercekten kaydetti mi?
        try {
          const k = await istek('/api/sessions/' + WAHA_OTURUM);
          const y = ((k.config && k.config.webhooks) || []).find((w) => w.url === kanca.url);
          if (y) log('   dogrulandi -> ' + (y.events || []).length + ' olay kayitli');
          else log('   ⚠ WAHA kaydetmemis gorunuyor — WAHA arayuzunden elle bakman gerekebilir');
        } catch (_) {}
      } catch (e) { log('olay adresi guncellenemedi: ' + e.message); }
    } else {
      log('olay adresi ve olay listesi zaten dogru');
    }
    return s;
  } catch (e) {
    if (e.status === 404) {
      log('oturum yok, olusturuluyor...');
      await istek('/api/sessions', { method: 'POST', body: { name: WAHA_OTURUM, start: true, config: { webhooks: [kanca] } } });
      return { status: 'STARTING' };
    }
    throw e;
  }
}


// ═══ QR AKTARIMI ══════════════════════════════════════════════════════
// WAHA QR'i kendi arayuzunde gosteriyor; panele de gelmesi icin ham
// metnini alip Baileys gibi 'connection.update { qr }' olarak yayiyoruz.
// Boylece panelin QR ekrani AYNEN calisiyor (kendi QR resmini uretiyor).
async function qrAl() {
  const yollar = [
    '/api/' + WAHA_OTURUM + '/auth/qr?format=raw',
    '/api/' + WAHA_OTURUM + '/auth/qr',
  ];
  const hatalar = [];
  for (const y of yollar) {
    try {
      const r = await istek(y);
      const q = (r && (r.value || r.qr || r.code || r.data)) || (typeof r === 'string' ? r : '');
      if (q && String(q).length > 20) return String(q);
      hatalar.push(y.split('?')[0] + ' -> bos cevap');
    } catch (e) { hatalar.push(y.split('?')[0] + ' -> ' + String(e.message).slice(0, 60)); }
  }
  if (!global._qrHataYazildi) { global._qrHataYazildi = true; hatalar.forEach((x) => log('  qr: ' + x)); }
  return '';
}

// QR'i duzenli araliklarla panele gonder (WAHA QR'i ~20 sn'de bir yeniliyor)
function qrTakibiBaslat(sock) {
  if (sock._qrTimer) return;
  let sonQR = '';
  let sayac = 0;
  const tur = async () => {
    if (sock._kapali) return qrTakibiDurdur(sock);
    sayac++;
    try {
      const s = await istek('/api/sessions/' + WAHA_OTURUM);
      const durum = String(s.status || s.state || '').toUpperCase();
      // Her turu degil ama ilk turu ve durum degisimlerini yaz — sessiz kalmasin
      if (sayac === 1 || durum !== sock._sonDurum) {
        log('oturum durumu: ' + (durum || '(bos)'));
        sock._sonDurum = durum;
      }
      if (/WORKING|CONNECTED/.test(durum)) {
        qrTakibiDurdur(sock);
        const ben = s.me || s.user || {};
        sock.user = benKur(ben);
        sock.ws.isOpen = true;
        sock.ev.emit('connection.update', { connection: 'open' });
        return;
      }
      if (/STOPPED|FAILED/.test(durum)) {
        // ═══ OTURUM KURTARMA ═══════════════════════════════════════════
        // FAILED: telefondan cihaz kaldirilinca ya da oturum bozulunca
        // olusuyor. Bu durumda sadece 'start' yetmiyor; once DURDURUP
        // sonra baslatmak gerekiyor. Sirayla deniyoruz.
        if (sock._kurtarmaCalisiyor) return;
        sock._kurtarmaCalisiyor = true;
        log('oturum ' + durum + ' — kurtariliyor...');
        const dene = async (ad, yol, govde) => {
          try {
            await istek(yol, { method: 'POST', body: govde });
            log('  ' + ad + ': tamam');
            return true;
          } catch (e) { log('  ' + ad + ': ' + String(e.message).slice(0, 70)); return false; }
        };
        try {
          if (durum === 'FAILED') {
            // 1) yeniden baslat
            let ok = await dene('yeniden baslat', '/api/sessions/' + WAHA_OTURUM + '/restart');
            if (!ok) {
              // 2) durdur + baslat
              await dene('durdur', '/api/sessions/' + WAHA_OTURUM + '/stop');
              await new Promise((r) => setTimeout(r, 2000));
              ok = await dene('baslat', '/api/sessions/' + WAHA_OTURUM + '/start');
            }
            if (!ok) {
              // 3) oturumu SIL ve yeniden olustur (son care — QR gerektirir)
              await dene('sil', '/api/sessions/' + WAHA_OTURUM + '/logout');
              await new Promise((r) => setTimeout(r, 1500));
              await dene('yeniden olustur', '/api/sessions', {
                name: WAHA_OTURUM, start: true,
                config: { webhooks: [{ url: WAHA_KANCA_URL + '/olay',
                  events: ['message', 'message.any', 'message.ack', 'message.revoked', 'message.reaction',
                           'session.status', 'state.change', 'group.v2.update', 'group.v2.participants'] }] },
              });
            }
          } else {
            await dene('baslat', '/api/sessions/' + WAHA_OTURUM + '/start');
          }
        } finally {
          // 8 saniye sonra tekrar denenebilir (kurtarma dongusune girmesin)
          setTimeout(() => { sock._kurtarmaCalisiyor = false; }, 8000);
        }
        return;
      }
      if (/SCAN_QR/.test(durum)) {
        const q = await qrAl();
        if (!q) {
          if (sayac % 4 === 1) log('QR alinamadi — WAHA henuz uretmemis olabilir, denemeye devam');
          return;
        }
        if (q !== sonQR) {
          sonQR = q;
          log('QR panele gonderildi (' + q.length + ' karakter)');
          sock.ev.emit('connection.update', { qr: q });
        }
        return;
      }
      // Beklenmeyen durum: gorelim
      if (sayac % 6 === 1) log('QR bekleniyor ama durum: ' + durum);
    } catch (e) {
      if (sayac % 4 === 1) log('QR takibi: WAHA\'ya ulasilamadi — ' + e.message);
    }
  };
  sock._qrTimer = setInterval(tur, 5000);
  tur();
}
function qrTakibiDurdur(sock) {
  if (sock._qrTimer) { clearInterval(sock._qrTimer); sock._qrTimer = null; }
}

// ═══ ANA GIRIS: Baileys'in makeWASocket'i yerine bunu cagiriyoruz ═══
async function wahaBaglan() {
  kancaSunucusuAc();
  const sock = wahaSoketYap();
  _dinleyiciler.add(sock);

  // soket kapatilinca dinleyiciden cikar
  const eskiEnd = sock.end;
  sock.end = (...a) => { _dinleyiciler.delete(sock); return eskiEnd(...a); };

  // ── BAGLANTI ACILINCA ILK LISTEYI GONDER ──
  // 'open' UC ayri yerden yayinlanabiliyor (acilista hazir oturum, QR
  // takibi, gelen olay). Uceni de ayri ayri yamamak yerine olayin
  // kendisini dinliyoruz — hangi yoldan acilirsa acilsin yakalanir.
  // ilkListeBaslat kendi icinde tek sefer korumali.
  sock.ev.on('connection.update', (u) => {
    if (u && u.connection === 'open') { ilkListeBaslat(sock); kancaBekcisi(sock); }
  });

  // ── WAHA olayi -> Baileys olayi ──
  sock._olayIsle = (olay) => {
    const tip = String(olay.event || olay.type || '');
    const veri = olay.payload || olay.data || {};
    if (olay.session && olay.session !== WAHA_OTURUM) return;

    // 1) BAGLANTI DURUMU
    if (/session\.status|state\.change/.test(tip)) {
      const durum = String(veri.status || veri.state || '').toUpperCase();
      if (/WORKING|CONNECTED|OPEN/.test(durum)) {
        sock.ws.isOpen = true;
        if (!sock.user) {
          istek('/api/sessions/' + WAHA_OTURUM).then((s) => {
            const ben = s.me || s.user || {};
            sock.user = benKur(ben);
            qrTakibiDurdur(sock);
            sock.ev.emit('connection.update', { connection: 'open' });
          }).catch(() => sock.ev.emit('connection.update', { connection: 'open' }));
        } else {
          sock.ev.emit('connection.update', { connection: 'open' });
        }
      } else if (/SCAN_QR|STARTING/.test(durum)) {
        if (veri.qr || veri.qrCode) sock.ev.emit('connection.update', { qr: veri.qr || veri.qrCode });
        else sock.ev.emit('connection.update', { connection: 'connecting' });
        qrTakibiBaslat(sock);   // QR uretilene kadar takip et
      } else if (/STOPPED|FAILED|DISCONNECT/.test(durum)) {
        sock.ws.isOpen = false;
        // WAHA oturumu gercekten sonlandiysa 401 (loggedOut), degilse 428
        const kod = /LOGGED_OUT|UNPAIRED/.test(durum) ? 401 : 428;
        const hata = new Error('WAHA durum: ' + durum);
        hata.output = { statusCode: kod, payload: { message: durum } };
        sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: hata } });
      }
      return;
    }

    // 2) MESAJ DURUMU (tik)
    if (/message\.ack/.test(tip)) {
      const id = (veri.id && veri.id._serialized) || veri.id;
      const jid = veri.chatId || veri.from || veri.to;
      if (!id || !jid) return;
      const ack = Number(veri.ack != null ? veri.ack : 1);
      sock.ev.emit('messages.update', [{ key: { id, remoteJid: jid, fromMe: true }, update: { status: ack } }]);
      return;
    }

    // 3) MESAJ SILINDI
    if (/message\.revoked/.test(tip)) {
      const hedef = veri.before || veri.after || veri;
      const id = (hedef.id && hedef.id._serialized) || hedef.id;
      const jid = hedef.chatId || hedef.from;
      if (id && jid) {
        sock.ev.emit('messages.update', [{ key: { id, remoteJid: jid }, update: { messageStubType: 1 } }]);
      }
      return;
    }

    // 4) TEPKI (emoji)
    if (/message\.reaction/.test(tip)) {
      const hedefId = (veri.reaction && veri.reaction.messageId) || veri.messageId;
      const jid = veri.chatId || veri.from;
      if (hedefId && jid) {
        sock.ev.emit('messages.upsert', {
          type: 'notify',
          messages: [{
            key: { remoteJid: jid, fromMe: !!veri.fromMe, id: 'r_' + Date.now() },
            message: { reactionMessage: { key: { id: hedefId, remoteJid: jid }, text: (veri.reaction && veri.reaction.text) || '' } },
            messageTimestamp: Math.floor(Date.now() / 1000),
          }],
        });
      }
      return;
    }

    // 5) YENI MESAJ
    if (/^message(\.any)?$/.test(tip)) {
      const m = baileysMesaji(veri);
      if (!m || !m.key.remoteJid) return;
      // 'message' gelen, 'message.any' hem gelen hem giden -> ikisi de gelirse
      // ayni mesaj iki kez islenmesin diye kimlige gore eleme
      if (sock._sonMesajlar.has(m.key.id)) return;
      sock._sonMesajlar.add(m.key.id);
      if (sock._sonMesajlar.size > 800) sock._sonMesajlar.delete(sock._sonMesajlar.values().next().value);
      sock.ev.emit('messages.upsert', { type: 'notify', messages: [m] });
      return;
    }

    // 6) GRUP GUNCELLENDI (ad/aciklama)
    if (/group\.v2\.update|group\.update/.test(tip)) {
      const jid = veri.id || veri.chatId || jidAl(veri);
      if (!jid) return;
      const g = veri.group || veri;
      const guncel = { id: jid };
      const ad = g.Name || g.name || g.subject;
      const acik = (g.TopicDeleted === true) ? '' : (g.Topic || g.topic || g.description);
      if (ad) guncel.subject = ad;
      if (acik !== undefined) guncel.desc = acik;
      sock.ev.emit('groups.update', [guncel]);
      return;
    }

    // 7) GRUP UYELERI DEGISTI
    if (/group\.v2\.participants|group\.participants/.test(tip)) {
      const jid = veri.id || veri.chatId || jidAl(veri);
      if (jid) sock.ev.emit('groups.update', [{ id: jid }]);
      return;
    }

    // 8) DURUM (cevrimici/yaziyor)
    if (/presence/.test(tip)) {
      const jid = veri.chatId || veri.id || jidAl(veri);
      if (!jid) return;
      const liste = veri.presences || [];
      const cevir = {};
      for (const p of liste) {
        cevir[numaraTemizle(p.participant || jid)] = { lastKnownPresence: p.lastKnownPresence || p.presence || 'available' };
      }
      sock.ev.emit('presence.update', { id: jid, presences: cevir });
      return;
    }
  };
  sock._sonMesajlar = new Set();

  // ── Oturumu hazirla ve durumu bildir ──
  try {
    const s = await oturumHazirla();
    const durum = String(s.status || s.state || '').toUpperCase();
    if (/WORKING|CONNECTED/.test(durum)) {
      const ben = s.me || s.user || {};
      sock.user = benKur(ben);
      sock.ws.isOpen = true;
      setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
    } else {
      setImmediate(() => sock.ev.emit('connection.update', { connection: 'connecting' }));
      qrTakibiBaslat(sock);   // QR'i panele akitmaya basla
    }
  } catch (e) {
    log('oturum hazirlanamadi: ' + e.message + ' — yine de QR takibi basliyor');
    setImmediate(() => sock.ev.emit('connection.update', { connection: 'connecting' }));
    qrTakibiBaslat(sock);   // WAHA gec acilmis olabilir; pes etme
  }

  return sock;
}

module.exports = {
  WAHA_URL, WAHA_API_KEY, WAHA_OTURUM, WAHA_KANCA_PORT, WAHA_KANCA_URL,
  istek, wahaSoketYap, baileysMesaji, baileysGrup, wahaMedyaIndir, qrAl,
  wahaBaglan, oturumHazirla,
  numaraTemizle, jidAl, zamanAl, lidNumara, benKur,
  ilkListeyiCek, ilkListeTuru, ilkListeBaslat, sohbetAdi, sohbetZamani,
  yeniSohbetleriYayinla,
};
