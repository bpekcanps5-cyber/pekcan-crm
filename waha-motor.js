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

// ═══════════════════════════════════════════════════════════════════
//  OLAY ADRESI ADAYLARI — "mesaj dusmuyor" kok cozumu (2026-08)
//  -----------------------------------------------------------------
//  ESKI SORUN: WAHA'ya TEK bir adres veriliyordu:
//      http://host.docker.internal:3210
//  Bu ad Docker kutusunun icinde cozulemezse (extra_hosts tanimli
//  degilse, ya da Linux'ta host-gateway yoksa) WAHA olayi gonderemez
//  ve HIC SES CIKARMAZ. Panel bos kalir, sebebi de anlasilmaz.
//  Tam olarak yasadigimiz sey buydu.
//
//  COZUM: Tek adrese bel baglamak yerine, bize ulasabilecek TUM
//  adresleri kaydediyoruz — makinenin kendi IP'leri (docker0 kopru
//  adresi 172.17.0.1 dahil) ve host.docker.internal. Hangisi calisiyorsa
//  olay oradan gelir. Her adaya AYRI YOL veriyoruz ki logda hangisinin
//  calistigini gorelim. Ayni mesaj iki yoldan gelirse kimlige gore
//  zaten eleniyor.
// ═══════════════════════════════════════════════════════════════════
function kancaAdaylari() {
  const adaylar = [];
  const ekle = (taban) => { if (taban && !adaylar.includes(taban)) adaylar.push(taban); };
  // Elle verildiyse o her zaman ilk sirada
  if (process.env.WAHA_KANCA_URL) ekle(process.env.WAHA_KANCA_URL);
  ekle('http://host.docker.internal:' + WAHA_KANCA_PORT);
  try {
    const arayuzler = require('os').networkInterfaces();
    const ipler = [];
    for (const ad of Object.keys(arayuzler)) {
      for (const a of (arayuzler[ad] || [])) {
        if (a.family !== 'IPv4' && a.family !== 4) continue;
        if (a.internal) continue;                       // 127.0.0.1 ise gec
        ipler.push({ ip: a.address, docker: /^(docker|br-)/.test(ad) });
      }
    }
    // docker koprusu (172.17.0.1) once — konteynerden en garanti yol odur
    ipler.sort((x, y) => (y.docker ? 1 : 0) - (x.docker ? 1 : 0));
    for (const x of ipler) ekle('http://' + x.ip + ':' + WAHA_KANCA_PORT);
  } catch (_) { /* arayuzler okunamadi, host.docker.internal ile devam */ }
  return adaylar.slice(0, 4);   // 4 aday yeter, fazlasi WAHA'yi yorar
}

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
// ═══ TIK CEVIRISI: WAHA -> Baileys ══════════════════════════════════
// ESKI HATA: WAHA'nin 'ack' degeri Baileys'in 'status' degeri sanilip
// oldugu gibi aktariliyordu. AMA IKI OLCEK BIR KAYIK:
//   WAHA:    -1 hata | 0 bekliyor | 1 sunucu | 2 iletildi | 3 okundu | 4 dinlendi
//   Baileys:  0 hata | 1 bekliyor | 2 sunucu | 3 iletildi | 4 okundu | 5 dinlendi
// Sonuc: tek tik saat, cift tik tek tik, mavi tik gri cift tik
// gorunuyordu — "tek tik cift tik muhabbeti" tam olarak buydu.
function ackCevir(ack) {
  const n = Number(ack);
  if (!isFinite(n)) return 0;
  const s = n + 1;                     // olcegi hizala
  return Math.max(0, Math.min(5, s));  // Baileys araligina sikistir
}

function baileysMesaji(w) {
  if (!w) return null;

  // ═══ IKI MOTOR, IKI FARKLI BICIM (2026-08) ══════════════════════
  // GOWS  (whatsmeow) -> _data.Info / _data.Message, BUYUK harfli alanlar
  // NOWEB (Baileys)   -> _data ZATEN Baileys mesaji: key/message/pushName
  // Motor degisince cevirmen bozuluyordu: gonderen cozulemiyor, panelde
  // "Bilinmeyen kisi" yaziyordu. Artik ikisi de taniniyor.
  const nb = w._data && w._data.key ? w._data : null;   // NOWEB mi?
  if (nb) {
    const anahtar = nb.key || {};
    let sohbetN = String(anahtar.remoteJid || w.from || w.chatId || '');
    const grupN = sohbetN.includes('@g.us');
    if (!grupN) sohbetN = sohbetN.endsWith('@lid')
      ? (lidNumara.get(sohbetN) || sohbetN) : numaraTemizle(sohbetN);
    let katilimciN = anahtar.participant || w.participant || '';
    if (katilimciN) {
      const alt = anahtar.participantPn || anahtar.participantAlt || '';
      if (alt) { lidNumara.set(katilimciN, numaraTemizle(alt)); katilimciN = numaraTemizle(alt); }
      else katilimciN = lidNumara.get(katilimciN) || numaraTemizle(katilimciN);
    }
    const govdeN = nb.message || (w.body ? { conversation: w.body } : { conversation: '' });
    return {
      key: {
        remoteJid: sohbetN,
        fromMe: !!anahtar.fromMe,
        id: anahtar.id || w.id || '',
        participant: katilimciN || undefined,
        remoteJidAlt: anahtar.remoteJidAlt || anahtar.remoteJidPn || undefined,
        remoteJidPn: anahtar.remoteJidPn || anahtar.remoteJidAlt || undefined,
      },
      message: govdeN,
      messageTimestamp: Number(nb.messageTimestamp || w.timestamp || zamanAl(w)) || 0,
      pushName: nb.pushName || w.notifyName || w.pushName || '',
      status: ackCevir(w.ack),
      _wahaMedya: (w.media && (w.media.url || w.media.URL)) || w.mediaUrl || null,
      _wahaDosyaAdi: (w.media && (w.media.filename || w.media.fileName)) || '',
      _wahaMime: (w.media && w.media.mimetype) || '',
    };
  }

  const bilgi = (w._data && w._data.Info) || {};
  let sohbet = String(w.from || w.chatId || bilgi.Chat || jidAl(w) || '');
  const grupMu = sohbet.includes('@g.us');
  const benimMi = !!(w.fromMe || bilgi.IsFromMe);

  // ═══ SOHBET KIMLIGINI TEKLESTIR (2026-08) ═══════════════════════
  // ESKI HATA: sohbet kimligi WAHA'dan geldigi gibi kullaniliyordu.
  // Ayni kisi olaya gore uc farkli kimlikle gelebiliyor:
  //   905551112233@c.us / 905551112233@s.whatsapp.net / 8873...@lid
  // Sonuc: AYNI KISI panelde 2-3 kez cikiyor ve mesaji her birine
  // ayri dusuyor — "kisiler mukerrer" ve "mesaj 3-4 kere gidiyor"
  // sikayetlerinin sebebi buydu.
  // server.js'in cozucusu (normalizeChatJid) LID'i ancak key.remoteJidAlt
  // varsa cozebiliyor, biz o alani HIC doldurmuyorduk.
  // ARTIK: gercek numarayi WAHA'nin verdigi 'Alt' alanlarindan bulup
  // hem kimligi duzeltiyor hem de alt alanlari dolduruyoruz.
  let sohbetAlt = '';
  if (!grupMu) {
    const adaylar = [bilgi.ChatAlt, w.chatIdAlt, w.fromAlt, w.toAlt];
    // gelen mesajda karsi taraf = gonderen; giden mesajda = alici
    if (benimMi) adaylar.push(bilgi.RecipientAlt, bilgi.ReceiverAlt, w.to);
    else adaylar.push(bilgi.SenderAlt, w.participantAlt);
    for (const a of adaylar) {
      const t = numaraTemizle(a || '');
      if (t && t.endsWith('@s.whatsapp.net')) { sohbetAlt = t; break; }
    }
    if (sohbet.endsWith('@lid')) {
      if (sohbetAlt) { lidNumara.set(sohbet, sohbetAlt); sohbet = sohbetAlt; }
      else { const bilinen = lidNumara.get(sohbet); if (bilinen) sohbet = bilinen; }
    } else {
      sohbet = numaraTemizle(sohbet);       // @c.us -> @s.whatsapp.net, cihaz ekini at
    }
  }

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
      // server.js'in LID cozucusu bu alanlara bakiyor — bos birakmayalim
      remoteJidAlt: sohbetAlt || undefined,
      remoteJidPn: sohbetAlt || undefined,
    },
    message: icerik,
    messageTimestamp: zamanAl(w),
    pushName: bilgi.PushName || w.notifyName || w.pushName || '',
    status: ackCevir(w.ack),
    // WAHA'nin indirdigi dosyanin adresi — medya indirmede kullanilir
    _wahaMedya: (w.media && (w.media.url || w.media.URL)) || w.mediaUrl || null,
    _wahaDosyaAdi: (w.media && (w.media.filename || w.media.fileName)) || '',
    _wahaMime: (w.media && w.media.mimetype) || '',
  };
}


// ═══════════════════════════════════════════════════════════════════
//  GRUP SERVISI (whatsmeow) — WAHA'nin yapamadigi canli grup sorgusu
//  -------------------------------------------------------------------
//  OLCUM (sonda ile, gercek hatta):
//    WAHA toplu cagri      : 7487 gruptan 2720'sinin adi var
//    whatsmeow toplu cagri : 7487 gruptan 2720'sinin adi var  (AYNI)
//    whatsmeow TEK TEK     : denenen 10 grubun 10'unun da adi geldi
//  Yani fark kutuphanede degil, SORGU BICIMINDE: WAHA kendi deposundan
//  okuyor, whatsmeow WhatsApp'a canli soruyor.
//
//  Bu yuzden mesaj/medya/gonderim WAHA'da kaliyor (calisiyor), sadece
//  grup bilgisi bu kucuk servisten aliniyor.
//  Servis yoksa hicbir sey bozulmaz — eski yola duser.
// ═══════════════════════════════════════════════════════════════════
const GRUP_SERVISI = process.env.GRUP_SERVISI_URL || 'http://127.0.0.1:3211';
let _grupServisiVar = null;   // null=bilinmiyor, true/false=olculdu

async function grupServisindenSor(jid) {
  if (_grupServisiVar === false) return null;
  try {
    const iptal = new AbortController();
    const saat = setTimeout(() => iptal.abort(), 25000);
    let r;
    try {
      r = await fetch(GRUP_SERVISI + '/grup?jid=' + jid, { signal: iptal.signal });
    } finally { clearTimeout(saat); }
    if (!r.ok) {
      if (_grupServisiVar === null) { _grupServisiVar = true; log('grup servisi calisiyor (bu grupta cevap yok)'); }
      return null;
    }
    const v = await r.json();
    if (_grupServisiVar === null) {
      _grupServisiVar = true;
      log('✓ grup servisi BAGLI — grup adlari canli sorguyla gelecek');
    }
    if (!v || !v.name) return null;
    return {
      id: v.jid || jid,
      subject: String(v.name).trim(),
      desc: String(v.topic || '').trim(),
      size: Number(v.participantCount) || (v.participants || []).length,
      owner: null,
      creation: 0,
      // Gercek numara 'id' alaninda geliyor; gizli kimlik ayri.
      // Ikisini eslestirip hafizaya aliyoruz ki mesajlarda da numara cozulsun.
      participants: (v.participants || []).map((p) => {
        if (p.lid && p.id && p.id.endsWith('@s.whatsapp.net')) lidNumara.set(p.lid, p.id);
        return {
          id: p.id || p.lid,
          lid: p.lid || p.id,
          admin: p.admin ? 'admin' : null,
          name: p.name || '',
        };
      }),
    };
  } catch (e) {
    if (_grupServisiVar === null) {
      _grupServisiVar = false;
      log('grup servisi yok (' + String(e.message).slice(0, 40) + ') — WAHA ile devam');
    }
    return null;
  }
}

// ═══ GRUP BILGISI: WAHA -> Baileys bicimi ═══════════════════════════
// GOWS BUYUK harfli alanlar veriyor: Name, Topic, Participants, JID
function baileysGrup(g) {
  if (!g) return null;
  const jid = jidAl(g);
  const uyeler = (g.Participants || g.participants || []).map((p) => {
    // GOWS: JID/LID/PhoneNumber (BUYUK harf) | NOWEB: id/jid (kucuk harf)
    const lid = p.LID || p.lid || p.JID || p.jid || p.id || '';
    let num = String(p.PhoneNumber || p.phoneNumber || '').replace(/[^0-9]/g, '');
    if (!num) {
      const ogr = lidNumara.get(lid) || lidNumara.get(p.JID || p.id || '');
      if (ogr) num = String(ogr).split('@')[0].split(':')[0];
    }
    if (!num) {
      const j = String(p.JID || p.jid || p.id || '');
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
// ═══════════════════════════════════════════════════════════════════
//  TOPLU CEKIM KAPALI (2026-08) — kullanicinin karari, ve dogrusu bu
//  -------------------------------------------------------------------
//  Baglanti aninda 7500 grubu birden cekmek her seferinde felakete yol
//  acti: 23.500 olaylik sel, kilitlenen sistem, uretilemeyen QR.
//  YENI DAVRANIS: hicbir grup onceden cekilmez. Liste BOS baslar.
//  Mesaj dustukce sohbet eklenir (1, 2, 3...) ve o an SADECE O GRUBUN
//  adi/aciklamasi cekilir. Tek grup = tek istek = anlik.
//  Bir sure sonra liste zaten dogal olarak oturur.
//  Geri acmak icin: .env -> WAHA_TOPLU_CEKIM=acik
// ═══════════════════════════════════════════════════════════════════
const TOPLU_CEKIM = (process.env.WAHA_TOPLU_CEKIM || 'kapali').toLowerCase() === 'acik';
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
  const ISTENEN = 500;                 // istedigimiz sayfa boyu
  const TAVAN = 500;                   // en fazla sayfa (50'lik sayfalarda 25.000 kayit)
  let konum = 0;
  for (let sayfa = 0; sayfa < TAVAN; sayfa++) {
    const ayrac = temelYol.includes('?') ? '&' : '?';
    const veri = await istek(temelYol + ayrac + 'limit=' + ISTENEN + '&offset=' + konum, { zamanAsimiMs });
    const dizi = Array.isArray(veri) ? veri
      : (veri && Array.isArray(veri.data)) ? veri.data
      : (veri && Array.isArray(veri.chats)) ? veri.chats : [];
    if (!dizi.length) break;           // gercek son: bos sayfa
    let yeni = 0;
    for (const x of dizi) {
      const j = jidAl(x);
      if (!j || gorulen.has(j)) continue;
      gorulen.add(j); hepsi.push(x); yeni++;
    }
    // ═══ SAYFA BOYU BIZIM DEGIL, UCUN VERDIGI KADAR (2026-08) ══════
    // ESKI HATA: "dondu sayi < istedigim sayi ise son sayfadir" varsayimi.
    // WAHA'nin sohbet ucu limit=500 istesek de 50 veriyor. Kod 50<500
    // gorup "bitti" sanip duruyordu — 3500 grubun sadece 50'si geliyordu,
    // gerisi ADSIZ kaliyordu. Panelde ham kimlik gorunmesinin sebebi buydu.
    // ARTIK: imleci UCUN VERDIGI kadar ilerletiyoruz ve ancak BOS sayfa
    // ya da hic yeni kayit gelmemesi durumunda duruyoruz.
    konum += dizi.length;
    if (!yeni) break;                  // uc offset'i yok sayiyor -> ayni sayfa geliyor
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
    const ad = sohbetAdi(k);
    const zaman = sohbetZamani(k);

    // ═══ ADSIZ GRUBU LISTEYE KOYMA (2026-08) ════════════════════════
    // WAHA 8522 grup donuyor ama bunlarin 5799'unun adi YOK — ne toplu
    // listede ne de tek tek sorunca ("metadata bos geldi"). Bunlar
    // ayrilinmis/erisilemez gruplar; WhatsApp bilgilerini vermiyor.
    // Hepsini listeye atmak:
    //   - paneli 8928 satira sisirip yavaslatiyor,
    //   - ham kimlik ("120363423564585092") olarak gorunuyor,
    //   - 5799 bosuna sorgu demek (kasma sebebi buydu).
    // Canlidaki Baileys de bunlari GOSTERMIYOR (orada 4494 grup var).
    // Kullanicinin kurali da bu: "bos/olu gruplar gorunmesin, mesaj
    // geldikce eklensin". Mesaj gelirse server.js zaten sohbeti acar.
    // Konusma zamani olan grup ise ADSIZ OLSA DA alinir — o gercek.
    if (!ad && jid.endsWith('@g.us') && !zaman) {
      if (!sock._adsizGruplar) sock._adsizGruplar = new Set();
      sock._adsizGruplar.add(jid);
      continue;
    }
    liste.push({
      id: jid,
      name: ad || undefined,                            // bos ise server.js jid'den turetir
      conversationTimestamp: zaman || undefined,
      unreadCount: Number(k.unreadCount || k.UnreadCount || k.unread || 0) || 0,
    });
    if (ad) {
      if (!sock._bilinenAdlar) sock._bilinenAdlar = new Map();
      sock._bilinenAdlar.set(jid, ad);
    }
    // Uc denemesi icin adi BILINEN bir grup ornegi sakla
    if (ad && jid.endsWith('@g.us') && !sock._adliOrnekJid) {
      sock._adliOrnekJid = jid; sock._adliOrnekAd = ad;
    }
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
  const adsiz = (sock._adsizGruplar && sock._adsizGruplar.size) || 0;
  log('liste (' + kaynak + '): ' + liste.length + ' sohbet gonderildi ('
    + grup + ' grup, ' + (liste.length - grup) + ' kisi'
    + (yeniSayisi ? ', ' + yeniSayisi + ' yeni' : '')
    + (adsiz ? ' — ' + adsiz + ' grubun adi bos, bilgisi cekilecek' : '') + ')');

  // ═══ 'messages' ALANI BILEREK GONDERILMIYOR ══════════════════════
  // server.js'te o alan bir dizi ise, SADECE mesaj islemek icin degil,
  // BELLEKTEKI TUM SOHBETLERI tek tek veritabanina yazmak icin de bir
  // dongu doner. Bos dizi ([]) bile o donguyu tetikliyor. 7000 sohbette
  // her yayinda 7000 yazma demek — Supabase'i bogar. Alani hic
  // gondermeyince o dongu atlaniyor; sohbetleri zaten fetchAllGroups
  // kendi olculu kuyruguyla (siraliKaydet) yaziyor.
  sock._sonListeYayin = Date.now();
  sock.ev.emit('messaging-history.set', { chats: liste, contacts: [], isLatest: true });
  return liste.length;
}

// ═══════════════════════════════════════════════════════════════════
//  GRUP BILGISI DOLDURMA — "adi yok, aciklamasi yok" duzeltmesi
//  -----------------------------------------------------------------
//  SORUN:
//    WAHA'nin TOPLU grup listesi cogu grup icin 'Name' alanini BOS
//    donduruyor (WhatsApp grup bilgisini ayri senkronluyor). Panelde
//    grup adi yerine ham kimlik goruluyor: "120363046524430062".
//    Aciklama da bos, dolayisiyla poliçe/etiket akisi calismiyor.
//
//  NEDEN server.js'e BIRAKMIYORUZ:
//    server.js'in aciklama motoru bunu duzeltir AMA turda 8 grup,
//    20 saniyede bir. 8500 grupta ~6 saat eder. Kullanilamaz.
//
//  NASIL:
//    Adi bos gelen gruplar icin TEK-GRUP bilgisini cekiyoruz (o cagri
//    ad + aciklama + uyeleri guvenilir donduruyor) ve Baileys'in
//    'groups.update' olayi olarak yayiyoruz. server.js o olayi zaten
//    isliyor (8123. satir) — orada tek satir degismiyor.
//
//  HIZ KENDINI AYARLIYOR:
//    WhatsApp "yavasla" derse bekleme ikiye katlanir ve 30 sn durulur;
//    duzgun giderse kademeli hizlanir. Gelen mesaji etkilemez.
// ═══════════════════════════════════════════════════════════════════
const BILGI_MOD = (process.env.WAHA_GRUP_BILGI || 'acik').toLowerCase();
const BILGI_ARALIK_TABAN = Number(process.env.WAHA_GRUP_BILGI_ARALIK_MS) || 200;
const BILGI_YAYIN_ESIGI = 40;    // kac grupta bir panele yayin

async function grupBilgiDoldur(sock) {
  if (!TOPLU_CEKIM) return;         // toplu ad doldurma yok
  if (BILGI_MOD === 'kapali') { log('grup bilgisi doldurma kapali (WAHA_GRUP_BILGI=kapali)'); return; }
  if (sock._bilgiCalisiyor || sock._kapali) return;
  // Yoklama tutmadiysa bir daha girisme (yoksa her tazelemede bastan baslar)
  if (sock._bilgiVazgecildi) return;
  sock._bilgiCalisiyor = true;
  try {
    const sira = [...(sock._adsizGruplar || [])];
    if (!sira.length) return;
    const tumu = [...sira];
    // Once ucun kendisi calisiyor mu? Adi BILINEN bir grupla dene.
    if (sock._adliOrnekJid) {
      await ucDenemesi(sock, sock._adliOrnekJid, sock._adliOrnekAd);
    }

    // ═══ ONCE DEPOYU TAZELE, SONRA TEKRAR OKU ═══════════════════════
    // Baileys farki burada: o WhatsApp'a canli soruyor, WAHA depodan
    // veriyor. Depo eksikse kac kez sorsak da bos gelir. Once WAHA'ya
    // "depoyu WhatsApp'tan yenile" deyip grup listesini TEKRAR okuyoruz;
    // adlarin buyuk kismi bu adimda geliyor olmali.
    if (!sock._depoTazelendi) {
      sock._depoTazelendi = true;
      const oldu = await gruplariTazeleWaha(tumu.length + ' grubun adi bos');
      if (oldu) {
        try {
          const taze = await _sayfaliCek('/api/' + WAHA_OTURUM + '/groups');
          let kazanilan = 0;
          const yayin = [];
          for (const g of taze) {
            const b = baileysGrup(g);
            if (!b || !b.id || !b.subject) continue;
            if (sock._bilinenAdlar && sock._bilinenAdlar.get(b.id) === b.subject) continue;
            if (!sock._bilinenAdlar) sock._bilinenAdlar = new Map();
            sock._bilinenAdlar.set(b.id, b.subject);
            sock._adsizGruplar.delete(b.id);
            yayin.push({ id: b.id, subject: b.subject, desc: b.desc || '' });
            kazanilan++;
          }
          for (let i = 0; i < yayin.length; i += 200) sock.ev.emit('groups.update', yayin.slice(i, i + 200));
          log('tazeleme sonrasi: ' + kazanilan + ' grup adina kavustu, kalan adsiz: ' + sock._adsizGruplar.size);
          if (!sock._adsizGruplar.size) return;   // is bitti
        } catch (e) { log('tazeleme sonrasi okunamadi: ' + String(e.message).slice(0, 80)); }
      }
    }
    // ═══ ONCE YOKLA, SONRA KARAR VER (2026-08) ══════════════════════
    // Adi bos gruplarin cogu ayrilinmis/erisilemez olabiliyor; onlarda
    // tek-grup sorgusu da bos donuyor ("metadata bos geldi"). 5799 grup
    // icin bosuna 5799 istek atmak sistemi kasiyor ve WhatsApp'i yoruyor.
    // Bu yuzden once kucuk bir ORNEK deniyoruz: tutmuyorsa hic girismiyoruz.
    const kalan = [...sock._adsizGruplar];
    if (!kalan.length) return;
    const ORNEK = Math.min(40, kalan.length);
    const ESIK = 0.25;   // ornekte %25 bile tutmuyorsa devam etmenin anlami yok
    let kuyruk = kalan.slice(0, ORNEK);
    let yoklamaBitti = false;
    const denemeSayisi = new Map();
    let aralik = BILGI_ARALIK_TABAN;
    log('grup bilgisi: ' + tumu.length + ' grubun adi bos — once ' + ORNEK + ' tanesi yoklaniyor');

    let biriken = [];
    let dolan = 0, adsiz = 0, hata = 0, ertelenen = 0;
    const yay = () => {
      if (!biriken.length) return;
      sock.ev.emit('groups.update', biriken);
      biriken = [];
    };

    while (kuyruk.length && !sock._kapali) {
      const jid = kuyruk.shift();
      try {
        // DIKKAT: '@' KODLANMAMALI (encodeURIComponent kullanma)
        const g = await istek('/api/' + WAHA_OTURUM + '/groups/' + jid, { zamanAsimiMs: 15000 });
        const b = baileysGrup(g);
        if (b && b.subject && b.subject.trim()) {
          biriken.push({ id: b.id || jid, subject: b.subject.trim(), desc: b.desc || '' });
          sock._adsizGruplar.delete(jid);
          dolan++;
          aralik = Math.max(BILGI_ARALIK_TABAN, Math.round(aralik * 0.9));   // iyi gidiyor -> hizlan
        } else {
          adsiz++;   // WhatsApp bu grubun bilgisini vermiyor (ayrilinmis/erisilemez)
          sock._adsizGruplar.delete(jid);
        }
      } catch (e) {
        const m = String(e.message || '');
        if (/rate.?overlimit|429|too many/i.test(m)) {
          // Hiz sinirinda DURMA, yavasla ve o grubu kuyrugun sonuna at
          aralik = Math.min(3000, Math.max(300, aralik * 2));
          const deneme = (denemeSayisi.get(jid) || 0) + 1;
          denemeSayisi.set(jid, deneme);
          if (deneme <= 2) { kuyruk.push(jid); ertelenen++; }
          else { hata++; sock._adsizGruplar.delete(jid); }
          await new Promise((r) => setTimeout(r, Math.min(8000, aralik * 3)));
        } else {
          hata++;
          sock._adsizGruplar.delete(jid);
          if (hata <= 3) {
            log('  grup bilgisi alinamadi (' + jid.slice(0, 22) + '): ' + m.slice(0, 80));
            if (hata === 3) log('  (benzer hatalar artik yazilmayacak)');
          }
        }
      }
      if (biriken.length >= BILGI_YAYIN_ESIGI) {
        yay();
        log('grup bilgisi: ' + dolan + ' grup adina kavustu'
          + (ertelenen ? ' (' + ertelenen + ' erteleme)' : ''));
      }

      // ── YOKLAMA SONUCU ──
      if (!yoklamaBitti && !kuyruk.length) {
        yoklamaBitti = true;
        const denenen = dolan + adsiz + hata;
        const oran = denenen ? dolan / denenen : 0;
        if (oran < ESIK) {
          yay();
          // ═══ KALICI DURDURMA ════════════════════════════════════
          // Bayrak konmazsa: bir sonraki tazeleme kalan gruplarla
          // yeniden basliyor ve tarama bitmek bilmiyordu.
          sock._bilgiVazgecildi = true;
          // Sebebi DOGRU yaz: uc mu bozuk, gruplar mi erisilemez?
          if (hata > adsiz) {
            log('grup bilgisi DURDURULDU: yoklanan ' + denenen + ' grubun ' + hata
              + ' tanesinde WAHA HATA dondu. Sorun gruplarda degil, UCTA.'
              + ' Yukaridaki "uc denemesi" satirlarina bak.');
          } else {
            log('grup bilgisi DURDURULDU: yoklanan ' + denenen + ' gruptan sadece ' + dolan
              + ' tanesinin adi geldi. WAHA yanit veriyor ama bu gruplarin adi BOS'
              + ' — ayrilinmis/erisilemez gruplar. ' + (kalan.length - denenen)
              + ' grup icin bosuna sorgu atilmayacak.');
          }
          log('  Bu gruplar listede gorunmuyor; birinden mesaj gelirse otomatik eklenecek.');
          return;
        }
        // Yoklama tuttu -> gerisine devam
        kuyruk = kalan.slice(ORNEK);
        log('grup bilgisi: yoklama tuttu (' + dolan + '/' + denenen + ') — kalan '
          + kuyruk.length + ' grup cekiliyor (~' + Math.ceil(kuyruk.length * aralik / 60000) + ' dk)');
      }
      await new Promise((r) => setTimeout(r, aralik));
    }
    yay();
    log('grup bilgisi bitti: ' + dolan + ' dolduruldu, ' + adsiz
      + ' bilgisi alinamadi, ' + hata + ' hata');
  } finally {
    sock._bilgiCalisiyor = false;
  }
}
// Yanit vermeyen uclar. KALICI DEGIL — WAHA acilirken senkron yuzunden
// gecici yavaslayabiliyor. Bir kez zaman asimina ugrayan uc sonsuza kadar
// dislanirsa, sonradan duzelse bile onu hic kullanamayiz. 10 dakika sonra
// yeniden denenir.
const _olukUclar = new Map();   // yol -> ne zamana kadar dislanacak
const OLUK_SURESI_MS = 10 * 60 * 1000;
function olukMu(yol) {
  const t = _olukUclar.get(yol);
  if (!t) return false;
  if (Date.now() > t) { _olukUclar.delete(yol); return false; }
  return true;
}
function olukIsaretle(yol) { _olukUclar.set(yol, Date.now() + OLUK_SURESI_MS); }

// ═══════════════════════════════════════════════════════════════════
//  TEK SEFERLIK UC DENEMESI
//  -----------------------------------------------------------------
//  "metadata bos geldi" iki AYRI sebepten olabilir:
//    (a) tek-grup ucu hic calismiyor    -> HER grup bos doner
//    (b) o gruplar gercekten erisilemez -> sadece onlar bos doner
//  Ayirt etmek icin ADI BILINEN bir grupla uclari deniyoruz. Adi bilinen
//  grup da bos donerse sorun grupta degil, UCTADIR.
//  Toplam 3 istek — 5799 istek atmadan cevabi ogreniyoruz.
// ═══════════════════════════════════════════════════════════════════
async function ucDenemesi(sock, ornekJid, ornekAd) {
  if (sock._ucDenendi || !ornekJid) return;
  sock._ucDenendi = true;
  log('uc denemesi — adi BILINEN bir grupla kontrol: "' + String(ornekAd || '').slice(0, 30) + '"');
  const denemeler = [
    ['jid ile      ', '/api/' + WAHA_OTURUM + '/groups/' + ornekJid],
    ['@g.us olmadan', '/api/' + WAHA_OTURUM + '/groups/' + String(ornekJid).split('@')[0]],
    ['uyeler ucu   ', '/api/' + WAHA_OTURUM + '/groups/' + ornekJid + '/participants'],
  ];
  for (const [ad, yol] of denemeler) {
    try {
      const r = await istek(yol, { zamanAsimiMs: 15000 });
      if (Array.isArray(r)) {
        log('   ' + ad + ' CALISIYOR -> ' + r.length + ' kayit, alanlar: ' + Object.keys(r[0] || {}).join(','));
      } else if (r && typeof r === 'object') {
        const adVar = r.Name || r.name || r.subject;
        log('   ' + ad + ' CALISIYOR -> ad: ' + (adVar ? '"' + String(adVar).slice(0, 28) + '"' : 'BOS')
          + ' | alanlar: ' + Object.keys(r).join(','));
      } else {
        log('   ' + ad + ' bos yanit');
      }
    } catch (e) {
      log('   ' + ad + ' HATA: ' + String(e.message).slice(0, 110));
    }
  }
  log('uc denemesi bitti — bu satirlar sorunun UCTA mi GRUPLARDA mi oldugunu soyler');
}

// ═══════════════════════════════════════════════════════════════════
//  ISIM TAZELEME — sohbet ucundan periyodik ad cekimi
//  -----------------------------------------------------------------
//  Sohbet ucu ('/chats') grup ADLARINI veriyor, grup ucu ('/groups')
//  cogunda vermiyor. Ustelik WhatsApp senkronu saatler icinde ilerliyor:
//  ilk acilista adsiz olan grubun adi bir sure sonra gelebiliyor.
//  Bu yuzden sohbet listesini araliklarla yeniden okuyup DEGISEN/YENI
//  adlari 'groups.update' olarak yayiyoruz.
// ═══════════════════════════════════════════════════════════════════
const ISIM_TAZELEME_MS = Number(process.env.WAHA_ISIM_TAZELEME_MS) || 10 * 60 * 1000;


// ═══════════════════════════════════════════════════════════════════
//  ADSIZ KALANLARI TAMAMLA — ikinci kaynak
//  -----------------------------------------------------------------
//  Sohbet LISTESI ucu ('/chats') sadece konusulmus sohbetleri veriyor
//  olabilir; hic mesaj gelmemis gruplar orada cikmaz ve adsiz kalir.
//  Bu yuzden kalanlari TEK-SOHBET ucundan ('/chats/{jid}') deniyoruz.
//  Grup ucu ('/groups/{jid}') bu gruplarda bos donuyor — kanitlandi —
//  ama sohbet ucu adi veriyor, dolayisiyla tek-sohbet ucu da verebilir.
//
//  ONCE YOKLA: 30 grupla deniyoruz. Tutmuyorsa binlerce bosuna istek
//  atmiyoruz; loga sebebini yazip birakiyoruz.
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
//  BIR GRUBUN ADINI GETIR  —  GEREKIRSE TAZELEYEREK
//  -------------------------------------------------------------------
//  TESHIS ARACININ SOYLEDIKLERI (gercek veri, tahmin degil):
//    /groups            -> 7487 grup, 2720'sinin adi var, 4767'si BOS
//    /chats             -> sadece 960 sohbet biliyor, 88'inin adi var
//    /chats/{jid}       -> 404, boyle bir uc YOK
//    /groups/{jid}      -> adi olan grupta ad + 22 uye, olmayanda BOS
//    /groups/refresh    -> KOD 200, CALISIYOR   ← anahtar bulgu
//
//  DEMEK KI: WAHA deposu eksik. Okumak yetmiyor, TAZELEMEK gerekiyor.
//  Ama 7487 grubun hepsini tazelemek WhatsApp'i da sistemi de yorar.
//
//  BU YUZDEN: sadece MESAJ DUSEN grup icin tazeliyoruz. Zaten panelde
//  gordugun, ilgilendigin gruplar onlar. Tazeleme cagrisi paylasimli:
//  ayni anda 20 grup istese bile 2 dakikada BIR tazeleme atiliyor ve
//  hepsi o tazelemenin sonucunu bekliyor.
// ═══════════════════════════════════════════════════════════════════
const TAZELEME_ARALIK_MS = Number(process.env.WAHA_TAZELEME_ARALIK_MS) || 120000;
let _sonTazeleme = 0;
let _tazelemeUcusta = null;      // ucus halindeki tazeleme sozu (paylasimli)
let _grupBasinaTazeleme = null;  // grup basina uc calisiyor mu? (null=bilinmiyor)
const _zorDeneme = new Map();    // jid -> en son ne zaman ZORLA denendi

const uyu = (ms) => new Promise((r) => setTimeout(r, ms));

// Grubun adini DOGRUDAN oku (tazelemeden)
async function grupAdiOku(jid) {
  try {
    const r = await istek('/api/' + WAHA_OTURUM + '/groups/' + jid, { zamanAsimiMs: 12000 });
    return String((r && (r.Name || r.name || r.subject)) || '').trim();
  } catch (_) { return ''; }
}

// Tazele: once grup basina uc, olmazsa global (kisitli ve paylasimli)
// ═══════════════════════════════════════════════════════════════════
//  AD BEKLEME KUYRUGU  —  "mesaj dustu, adi gelecek" garantisi
//  -------------------------------------------------------------------
//  ESKI HATA: grup basina tazeleme ucu yoksa ve genel tazeleme kisitli
//  aralikta ise fonksiyon 'false' donup PES EDIYORDU. O grup bir daha
//  denenmedigi icin panelde sonsuza kadar sayi olarak kaliyordu.
//
//  ARTIK: adi bulunamayan grup KUYRUKTA KALIR. Kuyruk surekli doner:
//    - grup basina tazeleme varsa: her grubu tek tek tazeler
//    - yoksa: BIR genel tazeleme yapar, ardindan TUM grup listesini
//      yeniden okur ve kuyruktaki herkesin adini bir kerede cozer
//  Ad gelene kadar birakmaz (grup basina en fazla 6 tur).
// ═══════════════════════════════════════════════════════════════════
async function grupBasinaTazele(jid) {
  if (_grupBasinaTazeleme === false) return false;
  try {
    await istek('/api/' + WAHA_OTURUM + '/groups/' + jid + '/refresh',
      { method: 'POST', zamanAsimiMs: 30000 });
    if (_grupBasinaTazeleme === null) {
      _grupBasinaTazeleme = true;
      log('✓ grup basina tazeleme ucu CALISIYOR — sadece mesaj dusen grup tazelenecek');
    }
    return true;
  } catch (e) {
    if (_grupBasinaTazeleme === null) {
      _grupBasinaTazeleme = false;
      log('grup basina tazeleme ucu yok (' + String(e.message).slice(0, 45)
        + ') — genel tazeleme + toplu okuma kullanilacak');
    }
    return false;
  }
}

// Genel tazeleme: pahali, bu yuzden PAYLASIMLI (ayni anda tek tane)
async function genelTazele() {
  if (_tazelemeUcusta) return _tazelemeUcusta;
  const bekle = TAZELEME_ARALIK_MS - (Date.now() - _sonTazeleme);
  if (bekle > 0) await uyu(bekle);        // pes etme, SIRASINI BEKLE
  if (_tazelemeUcusta) return _tazelemeUcusta;
  _sonTazeleme = Date.now();
  _tazelemeUcusta = (async () => {
    try {
      await istek('/api/' + WAHA_OTURUM + '/groups/refresh', { method: 'POST', zamanAsimiMs: 180000 });
      return true;
    } catch (e) {
      log('genel tazeleme olmadi: ' + String(e.message).slice(0, 70));
      return false;
    } finally { setTimeout(() => { _tazelemeUcusta = null; }, 2000); }
  })();
  return _tazelemeUcusta;
}

// Tum grup listesini oku, kuyruktakilerin adini coz, panele yay
async function topluOkuVeCoz(sock) {
  let liste = [];
  try { liste = await _sayfaliCek('/api/' + WAHA_OTURUM + '/groups', 60000); }
  catch (e) { log('toplu okuma olmadi: ' + String(e.message).slice(0, 60)); return 0; }
  if (!sock._bilinenAdlar) sock._bilinenAdlar = new Map();
  const yayin = [];
  for (const g of liste) {
    const b = baileysGrup(g);
    if (!b || !b.id || !b.subject) continue;
    if (sock._bilinenAdlar.get(b.id) === b.subject) continue;
    sock._bilinenAdlar.set(b.id, b.subject);
    yayin.push({ id: b.id, subject: b.subject, desc: b.desc || '' });
  }
  for (let i = 0; i < yayin.length; i += 200) sock.ev.emit('groups.update', yayin.slice(i, i + 200));
  return yayin.length;
}

const AD_KUYRUK_TUR_MS = 4000;      // kuyruk turu araligi
const AD_EN_FAZLA_TUR = 6;          // grup basina en fazla kac tur denenir

function adKuyrugunaEkle(sock, jid) {
  if (!sock._adKuyruk) { sock._adKuyruk = new Map(); }
  if (sock._adKuyruk.has(jid)) return;
  sock._adKuyruk.set(jid, 0);
  adKuyrugunuCalistir(sock);
}

async function adKuyrugunuCalistir(sock) {
  if (sock._adKuyrukCalisiyor || sock._kapali) return;
  sock._adKuyrukCalisiyor = true;
  try {
    while (sock._adKuyruk && sock._adKuyruk.size && !sock._kapali) {
      const bekleyen = [...sock._adKuyruk.keys()];

      // 1) Once dogrudan okumayi dene (tazeleme sonrasi ad gelmis olabilir)
      for (const jid of bekleyen.slice(0, 8)) {
        const ad = await grupAdiOku(jid);
        if (ad) {
          if (!sock._bilinenAdlar) sock._bilinenAdlar = new Map();
          sock._bilinenAdlar.set(jid, ad);
          sock.ev.emit('groups.update', [{ id: jid, subject: ad }]);
          sock._adKuyruk.delete(jid);
          log('mesaj dustu -> grup adi geldi: "' + ad.slice(0, 34) + '"');
        }
      }
      if (!sock._adKuyruk.size) break;

      // 2) Tazele
      const kalan = [...sock._adKuyruk.keys()];
      if (_grupBasinaTazeleme !== false) {
        let biriCalisti = false;
        for (const jid of kalan.slice(0, 8)) {
          if (await grupBasinaTazele(jid)) biriCalisti = true;
          else break;                       // uc yokmus, genel yola gec
        }
        if (biriCalisti) { await uyu(2500); }
      }
      if (_grupBasinaTazeleme === false) {
        log('ad bekleyen ' + kalan.length + ' grup — genel tazeleme yapiliyor');
        const oldu = await genelTazele();
        if (oldu) {
          // ═══ TAZELEME ANINDA BITMIYOR ════════════════════════════
          // WAHA binlerce grubu WhatsApp'tan cekiyor; hemen bakip
          // "olmadi" demek yanlisti. Artan araliklarla izliyoruz ve
          // her turda kac ad geldigini yaziyoruz. Hicbir turda ad
          // gelmiyorsa bunu ACIKCA soyluyoruz — o zaman GOWS bu bilgiyi
          // gercekten vermiyor demektir ve NOWEB karari netlesir.
          let toplamKazanc = 0;
          for (const bekle of [3000, 8000, 20000, 45000]) {
            if (sock._kapali || !sock._adKuyruk.size) break;
            await uyu(bekle);
            const kazanc = await topluOkuVeCoz(sock);
            toplamKazanc += kazanc;
            if (kazanc) log('tazeleme sonrasi +' + kazanc + ' grup adina kavustu');
            for (const jid of [...sock._adKuyruk.keys()]) {
              if (sock._bilinenAdlar && sock._bilinenAdlar.get(jid)) sock._adKuyruk.delete(jid);
            }
            if (!sock._adKuyruk.size) break;
          }
          if (!toplamKazanc) {
            log('⚠ genel tazeleme HIC ad getirmedi — WAHA/GOWS bu gruplarin adini vermiyor');
          }
        }
      }

      // 3) Tur sayaci — sonsuza kadar denemeyelim
      for (const [jid, tur] of [...sock._adKuyruk]) {
        if (tur + 1 >= AD_EN_FAZLA_TUR) {
          sock._adKuyruk.delete(jid);
          if (_adAramaYazildi < 3) {
            _adAramaYazildi++;
            log('ad bulunamadi (' + String(jid).slice(0, 22) + ') — ' + AD_EN_FAZLA_TUR
              + ' tur denendi, WhatsApp bu grubun adini vermiyor');
          }
        } else sock._adKuyruk.set(jid, tur + 1);
      }
      if (sock._adKuyruk.size) await uyu(AD_KUYRUK_TUR_MS);
    }
  } finally { sock._adKuyrukCalisiyor = false; }
}

// ═══ HIZLI: sadece OKUR, beklemez ══════════════════════════════════
// KRITIK: server.js groupMetadata cagrisini 20 saniyede iptal ediyor
// (ve aciklama motoru 6 saniyede). Tazeleme + bekleme merdivenini bu
// yolun icine koymak fonksiyonu 25 saniyeye cikardi ve HER CAGRI
// "groupMetadata hata: timeout" ile dustu — ad gelmek uzereyken cagri
// kesiliyordu. Bu yuzden okuma ve tazeleme AYRILDI:
//   tekSohbetAdi        -> hizli, sadece okur (bu fonksiyon)
//   adiTazeleyerekGetir -> yavas, arka planda tazeler ve yayinlar
async function tekSohbetAdi(jid, sock) {
  if (sock && sock._bilinenAdlar && sock._bilinenAdlar.get(jid)) return sock._bilinenAdlar.get(jid);
  const ad = await grupAdiOku(jid);
  if (ad && sock) {
    if (!sock._bilinenAdlar) sock._bilinenAdlar = new Map();
    sock._bilinenAdlar.set(jid, ad);
  }
  return ad;
}

async function adsizlariTamamla(sock, liste) {
  if (sock._kapali || sock._tamamlamaCalisiyor || sock._tamamlamaVazgecildi) return;
  sock._tamamlamaCalisiyor = true;
  try {
    const ORNEK = Math.min(30, liste.length);
    let bulunan = 0, denenen = 0;
    const bulunanlar = [];
    log('adsiz kalan ' + liste.length + ' grup — ikinci kaynak yoklaniyor (' + ORNEK + ' deneme)');
    for (const jid of liste) {
      if (sock._kapali) break;
      denenen++;
      const ad = await tekSohbetAdi(jid, sock);
      if (ad) {
        bulunan++;
        sock._bilinenAdlar.set(jid, ad);
        bulunanlar.push({ id: jid, subject: ad });
      }
      if (bulunanlar.length >= 100) { sock.ev.emit('groups.update', bulunanlar.splice(0)); }
      // Yoklama sonucu
      if (denenen === ORNEK && bulunan / ORNEK < 0.2) {
        sock._tamamlamaVazgecildi = true;
        if (bulunanlar.length) sock.ev.emit('groups.update', bulunanlar.splice(0));
        log('ikinci kaynak da vermiyor (' + bulunan + '/' + ORNEK + ') — bu gruplarin adi'
          + ' WhatsApp tarafinda yok. Mesaj geldiginde otomatik gelecek.');
        return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (bulunanlar.length) sock.ev.emit('groups.update', bulunanlar);
    log('ikinci kaynak: ' + bulunan + '/' + denenen + ' grup adina kavustu');
  } finally {
    sock._tamamlamaCalisiyor = false;
  }
}

async function isimleriTazele(sock) {
  if (sock._kapali || sock._isimTazeleniyor) return;
  sock._isimTazeleniyor = true;
  try {
    let kayitlar = [];
    for (const yol of ['/api/' + WAHA_OTURUM + '/chats', '/api/' + WAHA_OTURUM + '/chats/overview']) {
      if (olukMu(yol)) continue;
      try { kayitlar = await _sayfaliCek(yol, 40000); if (kayitlar.length) break; }
      catch (e) { if (e.zamanAsimi) olukIsaretle(yol); }
    }
    if (!kayitlar.length) return;

    if (!sock._bilinenAdlar) sock._bilinenAdlar = new Map();
    const guncellenecek = [];
    let yeniSohbet = 0;
    for (const k of kayitlar) {
      let jid = jidAl(k);
      if (!jid || !jid.includes('@')) continue;
      if (jid.endsWith('@c.us')) jid = jid.split('@')[0] + '@s.whatsapp.net';
      if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
      const ad = sohbetAdi(k);
      if (!ad) continue;
      if (sock._bilinenAdlar.get(jid) === ad) continue;   // degismemis
      sock._bilinenAdlar.set(jid, ad);
      if (!sock._gorulenSohbetler || !sock._gorulenSohbetler.has(jid)) yeniSohbet++;
      if (jid.endsWith('@g.us')) guncellenecek.push({ id: jid, subject: ad });
    }
    if (yeniSohbet) yeniSohbetleriYayinla(sock, kayitlar, 'sohbetler/tazeleme');
    if (guncellenecek.length) {
      for (let i = 0; i < guncellenecek.length; i += 200) {
        sock.ev.emit('groups.update', guncellenecek.slice(i, i + 200));
      }
    }
    // ═══ HESABI ACIKCA YAZ (2026-08) ════════════════════════════════
    // "Bazilari geliyor, cogu gelmiyor" durumunu tahminle degil SAYIYLA
    // gorelim: elimizde kac grup var, kacinin adi biliniyor, kac tanesi
    // hala adsiz. Bu satir sorunun kaynak mi kapsam mi oldugunu soyler.
    const tumGrup = sock._tumGruplar ? sock._tumGruplar.size : 0;
    let adsizKalan = 0;
    const adsizListe = [];
    if (sock._tumGruplar) {
      for (const j of sock._tumGruplar) {
        if (!sock._bilinenAdlar.has(j)) { adsizKalan++; adsizListe.push(j); }
      }
    }
    log('isim tazeleme: sohbet ucundan ' + kayitlar.length + ' kayit okundu, '
      + guncellenecek.length + ' grup adi guncellendi'
      + (tumGrup ? ' | toplam grup: ' + tumGrup + ', adi bilinen: ' + (tumGrup - adsizKalan)
        + ', HALA ADSIZ: ' + adsizKalan : ''));
    // Kalanlari ikinci kaynaktan tamamlamayi dene
    if (adsizListe.length) adsizlariTamamla(sock, adsizListe).catch(() => {});
  } catch (e) {
    log('isim tazeleme hatasi: ' + String(e.message).slice(0, 90));
  } finally {
    sock._isimTazeleniyor = false;
  }
}

function isimTazelemeBaslat(sock) {
  if (!TOPLU_CEKIM) return;         // toplu tarama yok
  if (sock._isimTimer) return;
  // Ilk tur 60 saniye sonra: grup listesi otursun, sonra adlari tamamla
  setTimeout(() => { isimleriTazele(sock).catch(() => {}); }, 60000);
  sock._isimTimer = setInterval(() => { isimleriTazele(sock).catch(() => {}); }, ISIM_TAZELEME_MS);
  log('isim tazeleme kuruldu (' + Math.round(ISIM_TAZELEME_MS / 60000) + ' dakikada bir)');
}

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
    // Daha once yanit vermemis bir uca tekrar tekrar 25-45 saniye
    // harcamayalim; her denemede tum sistem bekliyor.
    if (olukMu(yol)) continue;
    log('liste deneniyor: ' + ad + ' ...');
    let kayitlar;
    try {
      kayitlar = await _sayfaliCek(yol, sure);
    } catch (e) {
      if (e.zamanAsimi) {
        olukIsaretle(yol);
        log('  ' + ad + ' yanit vermedi — 10 dakika denenmeyecek');
      } else {
        log('  ' + ad + ' olmadi: ' + String(e.message).slice(0, 110));
      }
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
      if (sock._adsizGruplar && sock._adsizGruplar.size && !sock._bilgiCalisiyor) {
        grupBilgiDoldur(sock).catch((e) => log('grup bilgisi hatasi: ' + e.message));
      }
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
  if (!TOPLU_CEKIM) { log('toplu sohbet cekimi KAPALI — liste bos baslar, mesaj geldikce dolar'); return; }
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
  if (sock._isimTimer) { clearInterval(sock._isimTimer); sock._isimTimer = null; }
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
  // ═══ KISA ONBELLEK (2026-08) ════════════════════════════════════
  // Logda ayni grup icin ust uste UCER kez sorgu goruldu (panel acilisi,
  // avatar cekimi, ad tazeleme ayri ayri istiyor). Ayni grubu 20 saniye
  // icinde tekrar sormak yerine ilk sonucu paylasiyoruz. Ayni anda gelen
  // istekler de tek cagriya biniyor. Kasmanin bir kismi buydu.
  const _grupOnbellek = new Map();   // jid -> { veri, ts }
  const _grupUcus = new Map();       // jid -> ucus halindeki soz
  const GRUP_ONBELLEK_MS = 60000;        // adi olan grup: 1 dk
  const GRUP_BOS_ONBELLEK_MS = 60000;    // adi BOS grup: 1 dk (tekrar denenince yeniden sorulsun)
  let _grupHataYazildi = 0;

  // Uyeleri ayri uctan tamamla — toplu liste 'Participants' vermiyor,
  // bu yuzden uye sayisi 0 gorunuyordu ("0 uye").
  async function uyeleriTamamla(jid, b) {
    if (!b || (b.participants && b.participants.length)) return b;
    try {
      const p = await istek('/api/' + WAHA_OTURUM + '/groups/' + jid + '/participants', { zamanAsimiMs: 12000 });
      const dizi = Array.isArray(p) ? p : (p && Array.isArray(p.participants) ? p.participants : []);
      if (dizi.length) {
        const sahte = baileysGrup({ JID: jid, Name: b.subject, Participants: dizi });
        if (sahte && sahte.participants.length) { b.participants = sahte.participants; b.size = sahte.participants.length; }
      }
    } catch (_) { /* bu uc yoksa uye sayisi bos kalir */ }
    return b;
  }

  // ═══════════════════════════════════════════════════════════════
  //  GRUP BILGISI — server.js'in HER YERDE kullandigi fonksiyon
  //  -------------------------------------------------------------
  //  Panelde gruba girince, "adi yenile" tusuna basinca, aciklama
  //  motoru calisirken... hepsi BURAYI cagiriyor. Dolayisiyla adin
  //  bulunmasi gereken tek yer burasi.
  //
  //  ESKI HATA: sadece GRUP ucuna ('/groups/{jid}') soruluyordu. O uc
  //  bu gruplarda Name'i BOS donuyor (kanitlandi) ve panel "Grup adi
  //  cekilemedi" diyordu. Oysa SOHBET ucu ('/chats/{jid}') ayni grubun
  //  adini VERIYOR — ama o yolu sadece mesaj gelince kullaniyordum.
  //
  //  ARTIK SIRAYLA HEPSI DENENIYOR, ilk bulan kazanir:
  //    1) grup ucu            -> ad + aciklama + uyeler (en zengin)
  //    2) bellekteki ad       -> sohbet listesinden ogrendiklerimiz
  //    3) tek-sohbet ucu      -> '/chats/{jid}'
  //    4) sohbet listesi      -> ilk sayfa taramasi (son care)
  //  Ad nereden gelirse gelsin uyeler ayrica tamamlanmaya calisilir.
  // ═══════════════════════════════════════════════════════════════
  sock.groupMetadata = async (jid) => {
    const onb = _grupOnbellek.get(jid);
    if (onb && Date.now() - onb.ts < (onb.sure || GRUP_ONBELLEK_MS)) {
      // Onbellekteki kayit BOS ise de hata firlatmaliyiz — yoksa dongu
      // onbellek uzerinden devam eder.
      if (!onb.veri || !onb.veri.subject) {
        const h = new Error('grup bilgisi alinamadi'); h.bosGrup = true; throw h;
      }
      return onb.veri;
    }
    if (_grupUcus.has(jid)) return _grupUcus.get(jid);

    const soz = (async () => {
      try {
        let b = null;
        // ── 0) GRUP SERVISI (canli sorgu) ──
        b = await grupServisindenSor(jid);
        if (b && b.subject) {
          if (!sock._bilinenAdlar) sock._bilinenAdlar = new Map();
          sock._bilinenAdlar.set(jid, b.subject);
          _grupOnbellek.set(jid, { veri: b, ts: Date.now(), sure: GRUP_ONBELLEK_MS });
          return b;
        }
        b = null;
        // ── 1) GRUP UCU ──
        for (const yol of ['/api/' + WAHA_OTURUM + '/groups/' + jid,
                           '/api/' + WAHA_OTURUM + '/groups/' + String(jid).split('@')[0]]) {
          try {
            const g = await istek(yol, { zamanAsimiMs: 15000 });
            if (g) { b = baileysGrup(g); if (b) break; }
          } catch (_) { /* sonrakini dene */ }
        }
        // Grup ucu hic cevap vermediyse bile bos bir iskelet kurup devam et —
        // adi baska kaynaktan bulabiliriz, burada pes etmek yanlis olur.
        if (!b) b = { id: jid, subject: '', desc: '', participants: [], size: 0, owner: null, creation: 0 };

        // ── 2) BELLEKTEKI AD (sohbet listesinden ogrenilmis) ──
        if (!b.subject && sock._bilinenAdlar && sock._bilinenAdlar.get(jid)) {
          b.subject = sock._bilinenAdlar.get(jid);
        }
        // ── 3) ADI YOKSA: SINIRLI BIR SURE ZORLA, SONRA ARKA PLANA AT ──
        // ═══ BUTONUN CALISMASI ICIN (2026-08) ═══════════════════════
        // Panel "Yeniden Bul" tusuna basinca server.js dogrudan bu
        // fonksiyonu cagirip 20 SANIYE bekliyor. Ben fonksiyonu tamamen
        // hizlandirinca 8 milisaniyede bos donuyor ve buton her seferinde
        // "cekilemedi" diyordu — o 20 saniye bosa gidiyordu.
        // ARTIK: 14 saniyelik butce ile tazeleyip tekrar okuyoruz
        // (20'nin altinda, timeout yemez). Grup basina 10 dakikada bir
        // yapiliyor ki arka plan motorlari bundan yavaslamasin.
        if (!b.subject) {
          const sonZor = _zorDeneme.get(jid) || 0;
          if (Date.now() - sonZor > 10 * 60 * 1000) {
            _zorDeneme.set(jid, Date.now());
            if (_zorDeneme.size > 8000) _zorDeneme.delete(_zorDeneme.keys().next().value);
            const bitis = Date.now() + 9000;   // 20sn sinirina rahat sigsin
            await grupBasinaTazele(jid);
            while (Date.now() < bitis) {
              await uyu(1500);
              const ad = await grupAdiOku(jid);
              if (ad) { b.subject = ad; break; }
            }
          }
        }

        // ═══ NEDEN BEKLEMIYORUZ (2026-08) ═══════════════════════════
        // server.js bu cagriyi 20 saniyede (aciklama motoru 6 saniyede)
        // iptal ediyor. Tazeleme + bekleme buraya konunca her cagri
        // "groupMetadata hata: timeout" ile dusuyordu — ad tam gelmek
        // uzereyken cagri kesiliyordu. Artik burada BEKLEMIYORUZ:
        // hemen doneriz, tazeleme arka planda surer ve ad bulununca
        // 'groups.update' olarak panele kendisi duser.
        if (!b.subject) grupAdiniTani(sock, jid);

        if (b.subject) {
          if (!sock._bilinenAdlar) sock._bilinenAdlar = new Map();
          sock._bilinenAdlar.set(jid, b.subject);
          // Uyeler bos ise ayri uctan tamamla (panelde "0 uye" gorunmesin)
          // Uye cekimi de bekletmesin: 8 saniyede gelmezse bosver
          if (!b.participants || !b.participants.length) {
            b = await Promise.race([uyeleriTamamla(jid, b), uyu(8000).then(() => b)]);
          }
          _grupOnbellek.set(jid, { veri: b, ts: Date.now(), sure: GRUP_ONBELLEK_MS });
        } else {
          if (_grupHataYazildi < 3) {
            _grupHataYazildi++;
            log('grup adi HICBIR kaynaktan gelmedi (' + String(jid).slice(0, 24) + ')'
              + (_grupHataYazildi === 3 ? '  [bu uyari artik yazilmayacak]' : ''));
          }
          // ═══ BOS SONUC DONDURMEK YERINE HATA FIRLAT (2026-08) ══════
          // KRITIK DONGU HATASI: server.js 'if (meta && meta.participants)'
          // diye bakiyor. Bos dizi ([]) de DOGRU sayildigi icin panele
          // guncelleme yolluyor; panel guncellemeyi alinca uyeleri TEKRAR
          // istiyor -> sonsuz dongu. Logda ayni grup icin yuzlerce
          // "grup uyeleri cekildi (0 uye)" satirinin sebebi buydu.
          // BAILEYS bu durumda HATA FIRLATIYOR ve dongu olusmuyor.
          // Ayni davranisi kuruyoruz. Arka plandaki ad kuyrugu bagimsiz
          // calismaya devam eder; ad bulununca 'groups.update' ile duser.
          adKuyrugunaEkle(sock, jid);
          _grupOnbellek.set(jid, { veri: b, ts: Date.now(), sure: GRUP_BOS_ONBELLEK_MS });
          const h = new Error('grup bilgisi alinamadi');
          h.bosGrup = true;
          throw h;
        }
        if (_grupOnbellek.size > 12000) _grupOnbellek.delete(_grupOnbellek.keys().next().value);
        return b;
      } finally { _grupUcus.delete(jid); }
    })();
    _grupUcus.set(jid, soz);
    return soz;
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
    // server.js bunu zaten cagiriyor (fetchAllGroups) ama gruplari
    // listeye EKLEMEZ, sadece adlarini tazeler ("bos gruplar gorunmesin"
    // karari). Yeni bir hatta liste bos oldugu icin hicbiri gorunmuyordu.
    // Cozum: elimize gecen gruplari ayni anda gecmis paketi olarak da
    // yayinla — liste, ZATEN CALISAN cagriyla doluyor.
    // Adsiz kalanlari sayabilmek icin TUM grup kimliklerini sakla
    if (!sock._tumGruplar) sock._tumGruplar = new Set();
    for (const k of Object.keys(sonuc)) if (k.endsWith('@g.us')) sock._tumGruplar.add(k);
    const kayitlar = Object.values(sonuc);
    // Toplu yayin KAPALI: server.js bu cagriyi kendi ad tazelemesi icin
    // kullaniyor, o kalsin — ama biz listeye 7500 grup DOKMEYECEGIZ.
    if (TOPLU_CEKIM && kayitlar.length) {
      setTimeout(() => {
        try {
          // Bu cagri server.js icinde birkac yerden geliyor (periyodik
          // tazeleme, aciklama tamamlama). Her seferinde tam listeyi
          // yayinlamaya gerek yok — dakikada bir yeter.
          const simdi = Date.now();
          if (!sock._sonListeYayin || simdi - sock._sonListeYayin > 60000) {
            sock._sonListeYayin = simdi;
            yeniSohbetleriYayinla(sock, kayitlar, 'gruplar/toplu');
            // Liste bu yoldan geldi -> sohbet uclarini yoklamayi birak
            ilkListeTimerlariTemizle(sock);
          }
          // Adi bos gelen gruplarin bilgisini tek tek doldurmaya basla
          if (sock._adsizGruplar && sock._adsizGruplar.size && !sock._bilgiCalisiyor) {
            grupBilgiDoldur(sock).catch((e) => log('grup bilgisi hatasi: ' + e.message));
          }
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
      // ═══ ZATEN BILDIGIMIZI TEKRAR YAYINLAMA (2026-08) ════════════
      // KRITIK: server.js her gelen mesajdan sonra bu fonksiyonu cagiriyor
      // (mesajiAktifCek). Eskiden gelen HER mesaji yayinliyorduk — cogu
      // zaten canli akistan dusmustu. Ve server.js'te her gecmis yayini
      // BELLEKTEKI TUM SOHBETLERI veritabanina yazdiran bir dongu
      // tetikliyor: 3957 sohbet x her mesaj = on binlerce yazma.
      // Sonuc: "DB sorgu hatasi: timeout exceeded ... 7808 benzer hata".
      // Supabase'i bogan sey buydu. Artik sadece GERCEKTEN YENI olanlar.
      if (sock._sonMesajlar.has(m.key.id)) continue;
      sock._sonMesajlar.add(m.key.id);
      if (sock._sonMesajlar.size > 3000) sock._sonMesajlar.delete(sock._sonMesajlar.values().next().value);
      mesajlar.push(m);
    }
    // Yeni bir sey yoksa HIC yayinlama — bos yayin bile o donguyu tetikliyor
    if (!mesajlar.length) return '';
    // ═══ YAYINLARI BIRIKTIR (2026-08) ═══════════════════════════════
    // Her gecmis yayini server.js'te 3957 sohbetin tamamini veritabanina
    // yazdiriyor. Gercekten kacmis mesaj bulsak bile pes pese yayin
    // yapmak Supabase'i bogar. Bu yuzden 20 saniyelik pencerede biriktirip
    // TEK yayin yapiyoruz. Bu bir telafi yolu; 20 saniye gecikme sorun degil.
    sock._gecmisBirikim = (sock._gecmisBirikim || []).concat(mesajlar);
    if (!sock._gecmisYayinTimer) {
      sock._gecmisYayinTimer = setTimeout(() => {
        sock._gecmisYayinTimer = null;
        const paket = sock._gecmisBirikim || [];
        sock._gecmisBirikim = [];
        if (!paket.length || sock._kapali) return;
        log('kacan mesaj telafisi: ' + paket.length + ' mesaj panele gonderiliyor');
        sock.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: paket, isLatest: false });
      }, 20000);
    }
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
    // ═══ GRUP VE KISI AYRI UCLAR (2026-08) ══════════════════════════
    // ESKIDEN: her sey kisi ucundan (contacts/profile-picture) isteniyordu.
    // Gruplar icin o uc calismiyor -> grup fotograflari HIC gelmiyordu.
    const j = String(jid || '');
    const yollar = j.includes('@g.us')
      ? ['/api/' + WAHA_OTURUM + '/groups/' + j + '/picture']
      : ['/api/contacts/profile-picture?contactId=' + j + '&session=' + WAHA_OTURUM,
         '/api/' + WAHA_OTURUM + '/contacts/' + j + '/picture'];
    for (const yol of yollar) {
      try {
        const r = await istek(yol, { zamanAsimiMs: 12000 });
        const u = (r && (r.profilePictureURL || r.url || r.URL || r.picture)) || (typeof r === 'string' ? r : null);
        if (u) return u;
      } catch (_) { /* sonrakini dene */ }
    }
    return null;
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
// ═══ MEDYA ADRESI DUZELTMESI (2026-08) ═════════════════════════════
// WAHA dosya adresini KENDI IC adresiyle veriyor:
//     http://localhost:3000/api/files/...
// 3000, Docker kutusunun ICINDEKI port. Biz disaridan 3001'e bakiyoruz,
// dolayisiyla o adres bizde 404 doner — "Medya indirilemedi: HTTP 404"
// satirlarinin sebebi buydu, dosya WAHA'da duruyor ama yanlis kapiya
// gidiyorduk. Adresin sadece YOL kismini alip kendi WAHA adresimize
// ekliyoruz.
function medyaAdresiDuzelt(kaynak) {
  const ham = String(kaynak || '');
  if (!ham) return '';
  if (!ham.startsWith('http')) return WAHA_URL + (ham.startsWith('/') ? ham : '/' + ham);
  try {
    const u = new URL(ham);
    const bizim = new URL(WAHA_URL);
    if (u.host === bizim.host) return ham;             // zaten dogru
    return WAHA_URL.replace(/\/+$/, '') + u.pathname + u.search;
  } catch (_) { return ham; }
}

async function wahaMedyaIndir(m) {
  const kaynak = m && m._wahaMedya;
  if (!kaynak) throw new Error('WAHA medya adresi yok (WHATSAPP_DOWNLOAD_MEDIA acik mi?)');
  const url = medyaAdresiDuzelt(kaynak);
  const bas = WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {};
  const r = await fetch(url, { headers: bas });
  if (!r.ok) throw new Error('medya indirilemedi: HTTP ' + r.status + ' (' + url.slice(0, 90) + ')');
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('medya bos geldi');
  return buf;
}



// ═══════════════════════════════════════════════════════════════════
//  WAHA'NIN GRUP DEPOSUNU TAZELE  ← BAILEYS FARKI
//  -----------------------------------------------------------------
//  BAILEYS NASIL YAPIYOR: groupFetchAllParticipating her cagrildiginda
//  WhatsApp'a CANLI sorgu atiyor ve tum gruplarin adini taze aliyor.
//  Bu yuzden Baileys'te 4494 grubun hepsinin adi var.
//
//  WAHA NASIL YAPIYOR: gruplari KENDI DEPOSUNDAN veriyor. Depo eksik
//  doldurulmussa 'Name' bos gelir ve KAC KEZ SORARSAN SOR bos gelmeye
//  devam eder — sorun sorguda degil, deponun kendisinde.
//  Benim gozden kacirdigim buydu: hep OKUYORDUM, hic TAZELE demedim.
//
//  Cozum: WAHA'ya depoyu WhatsApp'tan yenilemesini soyluyoruz, sonra
//  tekrar okuyoruz. Hangi ucun bu isi yaptigi surume gore degisebilir,
//  bu yuzden bilinen adaylari sirayla deneyip SONUCU LOGA yaziyoruz.
// ═══════════════════════════════════════════════════════════════════
let _tazelemeUcu = null;      // calisani bulunca hatirla
let _tazelemeYok = false;     // hicbiri calismiyorsa bir daha ugrasma

async function gruplariTazeleWaha(sebep) {
  if (_tazelemeYok) return false;
  const adaylar = _tazelemeUcu ? [_tazelemeUcu] : [
    ['POST', '/api/' + WAHA_OTURUM + '/groups/refresh'],
    ['POST', '/api/' + WAHA_OTURUM + '/groups/refresh-metadata'],
    ['POST', '/api/' + WAHA_OTURUM + '/groups/sync'],
    ['GET', '/api/' + WAHA_OTURUM + '/groups?refresh=true&limit=1'],
  ];
  log('WAHA grup deposu tazeleniyor (' + sebep + ')...');
  for (const [yontem, yol] of adaylar) {
    try {
      await istek(yol, { method: yontem, zamanAsimiMs: 120000 });
      _tazelemeUcu = [yontem, yol];
      log('  tazeleme TAMAM -> ' + yontem + ' ' + yol.split('?')[0]);
      return true;
    } catch (e) {
      log('  ' + yol.split('?')[0] + ': ' + String(e.message).slice(0, 80));
    }
  }
  _tazelemeYok = true;
  log('  WAHA bu surumde grup tazeleme ucu sunmuyor');
  return false;
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
let _oturumYenidenBaslatildi = false;   // onarim icin oturum bir kez yeniden baslatilir
const _olayTipleri = new Map();

// ═══ KANCA BEKCISI ══════════════════════════════════════════════════
// Baglanti kuruldugu halde WAHA'dan hic olay gelmiyorsa panel bos kalir
// ve sebebi anlasilmaz (mesaj dusmez, tik gelmez). 90 saniye sonra
// kontrol edip NE YAPILACAGINI yaziyoruz.
function kancaBekcisi(sock) {
  if (sock._kancaBekcisiKuruldu) return;
  sock._kancaBekcisiKuruldu = true;

  // 'acik' modda beklemeden ac
  if (WS_MOD === 'acik') websoketBaslat('ayar acik');

  // ── 1. ADIM (30sn): olay yoksa WEBSOKET yolunu ac ──
  // Bu, kanca yolunun tersi: baglantiyi BIZ kuruyoruz, yani guvenlik
  // duvarinin gelen istegi engellemesi onemsiz hale geliyor.
  setTimeout(() => {
    if (sock._kapali || _olaySayaci > 0) return;
    websoketBaslat('30sn olay yok');
  }, 30000);

  // ── 2. ADIM (60sn): olay adreslerini yeniden yaz ──
  setTimeout(async () => {
    if (sock._kapali || _olaySayaci > 0) return;
    log('60 saniyedir olay yok — olay adresleri yeniden yaziliyor...');
    try { await oturumHazirla(); } catch (e) { log('  yazilamadi: ' + e.message); }
  }, 60000);

  // ── 3. ADIM (90sn): oturumu bir kez yeniden baslat ──
  // WAHA'da calisan bir oturum, ayari degistiginde YENIDEN BASLATILANA
  // kadar eski ayarla calismaya devam edebiliyor.
  setTimeout(async () => {
    if (sock._kapali || _olaySayaci > 0 || _oturumYenidenBaslatildi) return;
    _oturumYenidenBaslatildi = true;
    log('hala olay yok — WAHA oturumu bir kez yeniden baslatiliyor (ayarin islemesi icin)');
    try {
      await istek('/api/sessions/' + WAHA_OTURUM + '/restart', { method: 'POST', zamanAsimiMs: 30000 });
      log('  oturum yeniden baslatildi, olaylar bekleniyor...');
    } catch (e) { log('  yeniden baslatilamadi: ' + String(e.message).slice(0, 100)); }
  }, 90000);

  // ── 4. ADIM (170sn): hala yoksa teshis yaz ──
  setTimeout(() => {
    if (sock._kapali || _olaySayaci > 0) return;
    const adaylar = kancaAdaylari();
    log('');
    log('╔═══════════════════════════════════════════════════════════');
    log('║ ⚠️  170 SANIYEDIR HIC OLAY GELMEDI (iki yol da calismadi)');
    log('║');
    log('║ 1) WAHA -> bize (kanca): denenen adresler, hicbiri ulasmadi:');
    for (const a of adaylar) log('║      ' + a + '/olay/...');
    log('║    Sebep neredeyse kesin GUVENLIK DUVARI. Tek komut:');
    log('║      ufw allow from 172.16.0.0/12 to any port ' + WAHA_KANCA_PORT + ' proto tcp');
    log('║');
    log('║ 2) bizden -> WAHA (websoket): bu surumde uc olmayabilir.');
    log('║    Yukarida "websoket ACILDI" satiri yoksa desteklenmiyor.');
    log('╚═══════════════════════════════════════════════════════════');
    log('');
  }, 170000);
}

// WAHA'dan gelen olaylari alan kucuk sunucu (tek kez acilir)
// ═══ MESAJ GELDIKCE GRUBU TANI ══════════════════════════════════════
// Listede olmayan (ya da adsiz duran) bir gruptan mesaj gelirse adini
// ve aciklamasini o an cekip yayinlar. Grup basina bir kez calisir,
// mesaj trafigi ne olursa olsun ek yuk yaratmaz.
// ═══════════════════════════════════════════════════════════════════
//  MESAJ GELDIKCE GRUBU TANI
//  -----------------------------------------------------------------
//  NEDEN groupMetadata KULLANMIYORUZ ARTIK:
//    Tek-grup ucu bu gruplar icin BOS donuyor (Name alani bos) —
//    "Grup adi cekilemedi" uyarisinin sebebi tam olarak o. Ama SOHBET
//    ucu ('/chats') ayni grubun adini VERIYOR. Dogru yer orasi.
//
//  NASIL UCUZ OLUYOR:
//    Sohbet ucu en son konusulani basa koyuyor; az once mesaj gelen grup
//    zaten ILK SAYFADADIR. Bu yuzden tum listeyi degil sadece ilk 50
//    kaydi okuyoruz. Ustelik cagrilar birlestiriliyor: pes pese 100 mesaj
//    gelse bile 8 saniyede en fazla BIR istek atiliyor.
// ═══════════════════════════════════════════════════════════════════
const SON_SOHBET_ARALIK_MS = 8000;

async function sonSohbetleriTara(sock) {
  if (sock._kapali) return;
  const simdi = Date.now();
  // Birlestirme: yakin zamanda tarandiysa simdi atma, sona bir tane planla
  if (sock._sonTaramaZamani && simdi - sock._sonTaramaZamani < SON_SOHBET_ARALIK_MS) {
    if (!sock._taramaBekliyor) {
      sock._taramaBekliyor = setTimeout(() => {
        sock._taramaBekliyor = null;
        sonSohbetleriTara(sock).catch(() => {});
      }, SON_SOHBET_ARALIK_MS);
    }
    return;
  }
  sock._sonTaramaZamani = simdi;
  if (!sock._bilinenAdlar) sock._bilinenAdlar = new Map();

  let dizi = [];
  try {
    const veri = await istek('/api/' + WAHA_OTURUM + '/chats?limit=50&offset=0', { zamanAsimiMs: 20000 });
    dizi = Array.isArray(veri) ? veri : (veri && Array.isArray(veri.data) ? veri.data : []);
  } catch (e) {
    if (!sock._taramaHatasi) {
      sock._taramaHatasi = true;
      log('son sohbetler okunamadi: ' + String(e.message).slice(0, 90));
    }
    return;
  }
  const guncel = [];
  for (const k of dizi) {
    const jid = jidAl(k);
    if (!jid || !jid.endsWith('@g.us')) continue;
    const ad = sohbetAdi(k);
    if (!ad) continue;
    if (sock._bilinenAdlar.get(jid) === ad) continue;
    sock._bilinenAdlar.set(jid, ad);
    guncel.push({ id: jid, subject: ad });
  }
  if (guncel.length) {
    sock.ev.emit('groups.update', guncel);
    log('mesaj geldi -> ' + guncel.length + ' grup adina kavustu: "'
      + String(guncel[0].subject).slice(0, 30) + '"');
  }
}

// ═══════════════════════════════════════════════════════════════════
//  MESAJ DUSTUGU AN GRUBUN ADINI GETIR — ANINDA
//  -----------------------------------------------------------------
//  Once liste ucunun ilk sayfasi taraniyordu ve 8 saniye bekliyordu.
//  Mesaj gelen grubun adi ANINDA gorunmeli: artik SADECE O GRUBUN
//  adini hedefli tek istekle cekiyoruz ve gelir gelmez panele yayiyoruz.
//
//  Yuk neden buyumez:
//    - Grup basina SADECE BIR KEZ sorulur (cevap gelsin ya da gelmesin).
//    - Adi bilinen gruba hic sorulmaz.
//    - Ayni anda en fazla 4 istek isler (ani mesaj yagmurunda bile).
//    Ilk dolum bittikten sonra bu yol neredeyse hic calismaz.
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
//  MESAJ DUSTU -> O GRUBUN ADINI VE ACIKLAMASINI ANINDA CEK
//  -------------------------------------------------------------------
//  Toplu cekim kapali oldugu icin burasi artik cok hafif: ayni anda
//  sadece birkac yeni grup olur, her biri TEK istek. Karmasik kuyruga
//  gerek yok — ad da aciklama da tek cagriyla geliyor.
//  Grup basina bir kez sorulur; gelmezse tazeleyip bir kez daha dener.
// ═══════════════════════════════════════════════════════════════════
function grupAdiniTani(sock, jid) {
  if (!jid || !jid.endsWith('@g.us') || sock._kapali) return;
  if (sock._bilinenAdlar && sock._bilinenAdlar.get(jid)) return;   // adini zaten biliyoruz
  if (!sock._sorulanGruplar) sock._sorulanGruplar = new Set();
  if (sock._sorulanGruplar.has(jid)) return;
  sock._sorulanGruplar.add(jid);
  if (sock._sorulanGruplar.size > 20000) {
    sock._sorulanGruplar.delete(sock._sorulanGruplar.values().next().value);
  }
  grupBilgisiniGetir(sock, jid).catch(() => {});
}

async function grupBilgisiniGetir(sock, jid) {
  // ONCE grup servisi (canli sorgu) — WAHA'nin veremedigini o veriyor
  const canli = await grupServisindenSor(jid);
  if (canli) {
    if (!sock._bilinenAdlar) sock._bilinenAdlar = new Map();
    sock._bilinenAdlar.set(jid, canli.subject);
    sock.ev.emit('groups.update', [{ id: jid, subject: canli.subject, desc: canli.desc }]);
    log('mesaj dustu -> "' + canli.subject.slice(0, 32) + '"'
      + (canli.desc ? ' (aciklama var)' : '') + ' | ' + canli.size + ' uye');
    return;
  }
  const oku = async () => {
    try {
      const r = await istek('/api/' + WAHA_OTURUM + '/groups/' + jid, { zamanAsimiMs: 12000 });
      const b = baileysGrup(r);
      return (b && b.subject) ? b : null;
    } catch (_) { return null; }
  };
  let b = await oku();
  if (!b) {                       // gelmediyse bir kez tazeleyip tekrar dene
    await grupBasinaTazele(jid);
    await uyu(1500);
    b = await oku();
  }
  if (!b) return;
  if (!sock._bilinenAdlar) sock._bilinenAdlar = new Map();
  sock._bilinenAdlar.set(jid, b.subject);
  sock.ev.emit('groups.update', [{ id: jid, subject: b.subject, desc: b.desc || '' }]);
  log('mesaj dustu -> "' + b.subject.slice(0, 32) + '"'
    + (b.desc ? ' (aciklama var)' : '') + (b.participants.length ? ' | ' + b.participants.length + ' uye' : ''));
}

// ═══════════════════════════════════════════════════════════════════
//  YEDEK OLAY YOLU: WEBSOKET (2026-08)
//  -----------------------------------------------------------------
//  SORUN: WAHA olaylari bize HTTP ile GONDERIYOR (kanca/webhook). Yani
//  baglanti Docker kutusundan sunucuya DOGRU geliyor. Guvenlik duvari
//  ya da ag ayari bu yonu kapatirsa olaylar HIC gelmez ve panel sessizce
//  bos kalir. Dort ayri adres denedik, hicbiri ulasamadi.
//
//  COZUM: YONU TERS CEVIR. Biz zaten WAHA'ya istek atabiliyoruz (grup
//  listesi geliyor), yani DISARI dogru yol acik. O halde olaylari da biz
//  cekelim: WAHA'nin websoket ucuna BIZ baglaniyoruz. Boylece guvenlik
//  duvarindan, host.docker.internal'dan, Docker agindan tamamen
//  bagimsiz hale geliyoruz.
//
//  Gelen paketler kanca ile AYNI bicimde ({event, session, payload}),
//  bu yuzden ayni isleyiciye veriyoruz — tekrar eden mesaj kimlige gore
//  zaten eleniyor, iki yol ayni anda calissa bile sorun olmaz.
// ═══════════════════════════════════════════════════════════════════
const WS_MOD = (process.env.WAHA_WEBSOKET || 'yedek').toLowerCase();  // yedek | acik | kapali
let _wsBaglanti = null;
let _wsDenemeSayisi = 0;
let _wsKapandi = false;

function websoketAdresi() {
  // http://x:3001  ->  ws://x:3001/ws
  const taban = WAHA_URL.replace(/^http/i, 'ws').replace(/\/+$/, '');
  const olaylar = KANCA_OLAYLARI.join(',');
  return taban + '/ws?session=' + encodeURIComponent(WAHA_OTURUM) + '&events=' + encodeURIComponent(olaylar);
}

function websoketBaslat(sebep) {
  if (WS_MOD === 'kapali' || _wsBaglanti || _wsKapandi) return;
  if (typeof WebSocket !== 'function') {
    log('websoket yolu kullanilamiyor (Node surumu eski) — Node 20+ gerekiyor');
    return;
  }
  const adres = websoketAdresi();
  _wsDenemeSayisi++;
  log('websoket yolu aciliyor (' + sebep + '): ' + adres.replace(/\?.*$/, '?...'));
  let ws;
  try {
    ws = new WebSocket(adres, { headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {} });
  } catch (e) {
    log('  websoket kurulamadi: ' + String(e.message).slice(0, 100));
    return;
  }
  _wsBaglanti = ws;

  ws.onopen = () => {
    _wsDenemeSayisi = 0;
    log('✅ websoket ACILDI — olaylar artik BIZ cekiyoruz (guvenlik duvarina takilmaz)');
  };
  ws.onmessage = (olayPaketi) => {
    let olay;
    try { olay = JSON.parse(String(olayPaketi.data)); } catch (_) { return; }
    if (!olay) return;
    // WAHA bazen paketi sarmalayabiliyor — icindeki gercek olayi bul
    if (!olay.event && olay.data && olay.data.event) olay = olay.data;
    _olaySayaci++;
    const tip = String(olay.event || olay.type || '?');
    _olayTipleri.set(tip, (_olayTipleri.get(tip) || 0) + 1);
    if (_olaySayaci === 1) log('✅ ilk olay geldi (websoket): "' + tip + '"');
    else if (_olaySayaci % 200 === 0) {
      log('olay ozeti (' + _olaySayaci + ' toplam): ' + [..._olayTipleri].map(([t, n]) => t + '=' + n).join(' '));
    }
    for (const s of _dinleyiciler) { try { s._olayIsle(olay); } catch (e) { log('olay hatasi: ' + e.message); } }
  };
  ws.onerror = () => { /* onclose zaten calisacak */ };
  ws.onclose = (k) => {
    _wsBaglanti = null;
    if (_wsKapandi) return;
    const kod = (k && k.code) || 0;
    // 1006/1002 gibi kodlar "uc yok" olabilir — birkac denemeden sonra vazgec
    if (_wsDenemeSayisi >= 5) {
      log('websoket yolu kurulamadi (' + _wsDenemeSayisi + ' deneme, son kod ' + kod
        + ') — bu WAHA surumunde websoket ucu olmayabilir');
      return;
    }
    const bekle = Math.min(30000, 3000 * _wsDenemeSayisi);
    log('websoket kapandi (kod ' + kod + ') — ' + Math.round(bekle / 1000) + 'sn sonra tekrar denenecek');
    setTimeout(() => websoketBaslat('yeniden'), bekle);
  };
}

function websoketDurdur() {
  _wsKapandi = true;
  if (_wsBaglanti) { try { _wsBaglanti.close(); } catch (_) {} _wsBaglanti = null; }
}

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
      if (_olaySayaci === 1) {
        // Hangi adaydan geldi? Yol sonundaki numara onu soyluyor.
        const no = String(req.url || '').match(/\/olay\/(\d+)/);
        const adres = no ? (kancaAdaylari()[Number(no[1])] || '?') : '(eski yol)';
        log('✅ WAHA\'dan ilk olay geldi: "' + tip + '" — calisan adres: ' + adres);
      } else if (_olaySayaci % 200 === 0) {
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
  // Her adaya AYRI YOL: /olay/0, /olay/1 ... boylece olay gelince
  // hangi adresin calistigini logdan gorurüz.
  const adaylar = kancaAdaylari();
  const kancalar = adaylar.map((taban, i) => ({ url: taban + '/olay/' + i, events: KANCA_OLAYLARI }));
  const kanca = kancalar[0];
  // ═══ NOWEB DEPOSU (2026-08) ══════════════════════════════════════
  // WAHA'nin hata mesaji birebir soyluyordu:
  //   "Enable NOWEB store config.noweb.store.enabled=True and
  //    config.noweb.store.full_sync=True"
  // Depo kapaliyken sohbet listesi, grup bilgisi ve gecmis GELMIYOR.
  // Ortam degiskeni yeni oturumlarda gecerli; mevcut oturum icin ayrica
  // OTURUM AYARINA da yaziyoruz ki eski oturumda da acilsin.
  // Alan adi surume gore degisiyor: WAHA'nin hata mesaji 'full_sync'
  // diyor, API dokumani 'fullSync'. Ikisini birden yolluyoruz.
  // ═══ fullSync KAPALI (2026-08) ═══════════════════════════════════
  // fullSync acikken WAHA tum gecmisi indirmeye calisiyor; 8500 gruplu
  // hesapta bu is bitmiyor, oturum STARTING'de asili kaliyor ve QR HIC
  // uretilmiyor. Panelin "QR hazirlaniyor" ekraninda kalmasinin sebebi
  // buydu. Depo ACIK kalir (grup bilgisi icin gerekli), sadece toplu
  // gecmis indirme kapatilir — zaten mesaj geldikce dolduruyoruz.
  const depoAyari = { enabled: true, fullSync: false, full_sync: false };
  const oturumAyari = { webhooks: kancalar, noweb: { store: depoAyari } };
  try {
    const s = await istek('/api/sessions/' + WAHA_OTURUM);
    const kayitli = (s.config && s.config.webhooks) || [];
    log('WAHA kayitli olay adresi: ' + (kayitli.map((w) => w.url).join(' , ') || '(HIC YOK)'));
    for (const w of kayitli) {
      log('   ' + w.url + '  ->  olaylar: ' + ((w.events || []).join(',') || '(bos)'));
    }

    // ═══ HEM ADRES HEM OLAY LISTESI KONTROL EDILIR ══════════════════
    // ESKI HATA: yalnizca url karsilastiriliyordu. Oturum daha once
    // baska bir surumle kurulduysa adres AYNI kalir ama kayitli olay
    // listesi eksik olabilir (ornegin sadece 'session.status'). O zaman
    // baglanti kurulur, gruplar gelir AMA MESAJ HIC DUSMEZ.
    const kayitliUrller = kayitli.map((w) => w.url);
    const eksikAdres = kancalar.filter((k) => !kayitliUrller.includes(k.url)).length;
    const bizim = kayitli.find((w) => w.url === kanca.url);
    const eksikOlaylar = bizim ? KANCA_OLAYLARI.filter((e) => !((bizim.events || []).includes(e))) : KANCA_OLAYLARI;
    if (eksikAdres || eksikOlaylar.length) {
      log('olay adresleri yazilıyor (' + kancalar.length + ' aday):');
      for (const k of kancalar) log('   ' + k.url);
      try {
        await istek('/api/sessions/' + WAHA_OTURUM, { method: 'PUT', body: { config: oturumAyari } });
        log('olay adresleri + NOWEB deposu ayari yazildi');
        try {
          const k = await istek('/api/sessions/' + WAHA_OTURUM);
          const y = ((k.config && k.config.webhooks) || []);
          log('   dogrulandi -> ' + y.length + ' adres, ' + ((y[0] && y[0].events) || []).length + ' olay kayitli');
          if (!y.length) log('   ⚠ WAHA kaydetmemis gorunuyor');
        } catch (_) {}
      } catch (e) { log('olay adresi guncellenemedi: ' + e.message); }
    } else {
      log('olay adresleri ve olay listesi zaten dogru (' + kayitli.length + ' adres)');
    }
    // ═══ NOWEB DEPOSU ACIK MI? ══════════════════════════════════════
    // Depo kapaliyken WAHA sohbet listesi, grup adi, aciklama ve gecmis
    // VERMIYOR. Bugun yasadigimiz her seyin tek sebebi buydu.
    const depoOku = (x) => (x && x.config && x.config.noweb && x.config.noweb.store) || null;
    let depo = depoOku(s);
    if (!depo || !depo.enabled) {
      log('');
      log('╔══════════════════════════════════════════════════════════');
      log('║ ⚠ NOWEB DEPOSU KAPALI');
      log('║   Grup adlari, aciklamalar ve gecmis BU YUZDEN gelmiyor.');
      log('║   WAHA bu veriyi depo kapaliyken vermiyor. Aciliyor...');
      log('╚══════════════════════════════════════════════════════════');
      log('   WAHA\'da kayitli ayar: ' + JSON.stringify((s.config && s.config.noweb) || null));

      // 1) DURDUR -> YAZ -> BASLAT
      // WAHA calisan bir oturumun ayarini kabul etmiyor olabilir; bu
      // yuzden once durduruyoruz. (Sadece PUT atmak ise yaramamisti.)
      const dene2 = async (ad, yol, yontem, govde) => {
        try { await istek(yol, { method: yontem, body: govde, zamanAsimiMs: 60000 }); log('   ' + ad + ': tamam'); return true; }
        catch (e) { log('   ' + ad + ': ' + String(e.message).slice(0, 70)); return false; }
      };
      await dene2('durdur', '/api/sessions/' + WAHA_OTURUM + '/stop', 'POST');
      await uyu(2000);
      await dene2('ayar yaz', '/api/sessions/' + WAHA_OTURUM, 'PUT', { config: oturumAyari });
      await dene2('baslat', '/api/sessions/' + WAHA_OTURUM + '/start', 'POST');
      await uyu(3000);

      // 2) Kontrol
      try {
        const k = await istek('/api/sessions/' + WAHA_OTURUM);
        depo = depoOku(k);
      } catch (_) {}

      if (depo && depo.enabled) {
        log('✓ NOWEB deposu ACILDI');
      } else {
        // 3) Son care: oturumu SIL ve ayarla birlikte yeniden kur.
        // Ortam degiskenleri (WAHA_NOWEB_STORE_*) yeni oturumlarda
        // gecerli oldugu icin sifirdan kurulan oturum depoyla acilir.
        log('   ayar yazilamadi — oturum sifirdan kuruluyor (QR istenecek)');
        await dene2('cikis', '/api/sessions/' + WAHA_OTURUM + '/logout', 'POST');
        await dene2('sil', '/api/sessions/' + WAHA_OTURUM, 'DELETE');
        await uyu(2000);
        const kuruldu = await dene2('yeni oturum', '/api/sessions', 'POST',
          { name: WAHA_OTURUM, start: true, config: oturumAyari });
        if (kuruldu) log('✓ yeni oturum kuruldu — QR birazdan gelecek, depo acik');
        else log('✗ kurulamadi — docker-compose\'ta WAHA_NOWEB_STORE_ENABLED=True olmali');
        return { status: 'STARTING' };
      }
    } else {
      log('');
      log('╔══════════════════════════════════════════════════════════');
      log('║ ✓ NOWEB DEPOSU ACIK   (fullSync: ' + !!(depo.fullSync || depo.full_sync) + ')');
      log('║   Grup adlari, aciklamalar ve gecmis artik gelebilir.');
      log('╚══════════════════════════════════════════════════════════');
      log('');
    }
    return s;
  } catch (e) {
    if (e.status === 404) {
      log('oturum yok, olusturuluyor...');
      await istek('/api/sessions', { method: 'POST', body: { name: WAHA_OTURUM, start: true, config: oturumAyari } });
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
        sock._failedSayisi = 0;
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
          // ═══ INATCI FAILED -> OTURUMU SIFIRLA (2026-08) ═══════════
          // Motor degistirilince (GOWS -> NOWEB) eski oturum dosyalari
          // yeni motorla UYUMSUZ oluyor. WAHA acilista cokuyor, durum
          // FAILED'e dusuyor, yeniden baslatmak da ise yaramiyor ve
          // QR HIC uretilmiyor. Panel sonsuza kadar "baglaniyor" diyor.
          // 3 basarisiz kurtarmadan sonra oturumu silip yeniden kuruyoruz:
          // kimlik zaten calismiyor, kaybedecek bir sey yok, QR gelir.
          sock._failedSayisi = (sock._failedSayisi || 0) + 1;
          if (durum === 'FAILED' && sock._failedSayisi >= 3 && !sock._oturumSifirlandi) {
            sock._oturumSifirlandi = true;
            log('oturum ' + sock._failedSayisi + ' kez FAILED — sifirdan kuruluyor (QR istenecek)');
            await dene('durdur', '/api/sessions/' + WAHA_OTURUM + '/stop');
            await dene('cikis', '/api/sessions/' + WAHA_OTURUM + '/logout');
            try {
              await istek('/api/sessions/' + WAHA_OTURUM, { method: 'DELETE', zamanAsimiMs: 30000 });
              log('  eski oturum silindi');
            } catch (e) { log('  silinemedi: ' + String(e.message).slice(0, 60)); }
            try { await oturumHazirla(); log('  yeni oturum kuruldu — QR birazdan gelecek'); }
            catch (e) { log('  kurulamadi: ' + String(e.message).slice(0, 60)); }
            return;
          }
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
      // ═══ OTURUM YOKSA YENIDEN KUR (2026-08) ═══════════════════════
      // Docker kutusu yeniden olusturulunca WAHA'da oturum TANIMI kaybolur
      // (kimlik dosyalari waha-veri klasorunde DURUR ama oturum kayitli
      // degildir). Ustelik o an WAHA henuz ayakta olmadigi icin acilistaki
      // 'oturumHazirla' cagrisi da 'fetch failed' ile dusmus oluyor.
      // ESKIDEN: burada sadece hata yazilip sonsuza kadar sorulmaya devam
      // ediliyordu -> panel "QR hazirlaniyor" ekraninda asili kaliyordu.
      // ARTIK: oturum yoksa kendimiz kuruyoruz. Kimlik dosyalari yerinde
      // oldugu icin WAHA eski oturumu geri yukler — QR ISTEMEZ.
      const oturumYok = e.status === 404 || /session not found/i.test(String(e.message));
      if (oturumYok && !sock._oturumKuruluyor) {
        sock._oturumKuruluyor = true;
        log("WAHA'da oturum yok — yeniden kuruluyor (kimlik dosyalari duruyorsa QR istemez)");
        try {
          await oturumHazirla();
          log('  oturum kuruldu, durum bekleniyor...');
        } catch (h) {
          log('  kurulamadi: ' + String(h.message).slice(0, 90));
        } finally {
          setTimeout(() => { sock._oturumKuruluyor = false; }, 10000);
        }
        return;
      }
      if (sayac % 4 === 1) log("QR takibi: WAHA'ya ulasilamadi — " + e.message);
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
    if (u && u.connection === 'open') { ilkListeBaslat(sock); kancaBekcisi(sock); isimTazelemeBaslat(sock); }
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
      // ═══ DOGRU SOHBETI SEC (2026-08) ════════════════════════════
      // ESKIDEN: 'chatId || from || to' deniyordu. Giden mesajlarda
      // 'from' BIZIM numaramiz oluyor -> tik guncellemesi olmayan bir
      // sohbete gidiyor ve panelde tik HIC degismiyordu.
      const benim = !!(veri.fromMe != null ? veri.fromMe : true);
      let jid = veri.chatId || veri.chatID
        || (benim ? (veri.to || veri.from) : (veri.from || veri.to));
      if (!id || !jid) return;
      jid = String(jid);
      if (!jid.includes('@g.us')) {
        jid = jid.endsWith('@lid') ? (lidNumara.get(jid) || jid) : numaraTemizle(jid);
      }
      sock.ev.emit('messages.update', [{
        key: { id, remoteJid: jid, fromMe: benim },
        update: { status: ackCevir(veri.ack != null ? veri.ack : 1) },
      }]);
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
      // ═══ MESAJ GELDIKCE GRUBU TANI (2026-08) ══════════════════════
      // Listede olmayan bir gruptan mesaj gelirse server.js sohbeti
      // acar ama adi ham kimlik olur ("120363..."). Adini HEMEN cekip
      // yayiyoruz — kullanicinin istedigi "dustukce yenilensin" davranisi.
      // Sadece daha once bakilmamis gruplar icin, grup basina TEK sefer.
      grupAdiniTani(sock, m.key.remoteJid);
      return;
    }

    // 6) GRUP GUNCELLENDI (ad/aciklama)
    // ═══ SISTEMI BOGAN HATA (2026-08) ══════════════════════════════
    // WhatsApp baglaninca TUM gruplar icin guncelleme olayi yolluyor:
    // logda 23.500 adet 'group.v2.update'. Eski kod, ad bulamadiginda
    // server.js'e {id} yolluyordu; server.js de her biri icin WhatsApp'a
    // CANLI sorgu atiyordu. 23.500 sorgu = sistem kilitleniyor, QR bile
    // uretilemiyor. Panelin acilmamasinin sebebi buydu.
    //
    // ARTIK:
    //   - Adi OLAN guncellemeler biriktirilip TOPLU yayinlanir (ucuz,
    //     server.js ek sorgu atmaz cunku subject zaten var).
    //   - Adi OLMAYAN guncelleme HIC yayinlanmaz (bilgi tasimiyor,
    //     sadece maliyet). Sadece sayilir.
    // Bu olaylar aslinda bir HAZINE: icinde binlerce grubun adi var.
    if (/group\.v2\.update|group\.update/.test(tip)) {
      const jid = veri.id || veri.chatId || jidAl(veri);
      if (!jid) return;
      const g = veri.group || veri.groupMetadata || veri;
      const ad = String(g.Name || g.name || g.subject || g.Subject || '').trim();
      const acikHam = (g.TopicDeleted === true) ? ''
        : (g.Topic !== undefined ? g.Topic : (g.topic !== undefined ? g.topic
          : (g.desc !== undefined ? g.desc : g.description)));

      // Ilk olayin yapisini BIR KEZ yaz — icinde ne var, gorelim
      if (!sock._grupOlayYazildi) {
        sock._grupOlayYazildi = true;
        log('grup olayi ornek alanlar: ' + Object.keys(g).slice(0, 14).join(',')
          + (ad ? '  | ad VAR: "' + ad.slice(0, 26) + '"' : '  | ad YOK'));
      }

      if (!ad && acikHam === undefined) { sock._bosGrupOlayi = (sock._bosGrupOlayi || 0) + 1; return; }

      if (!sock._grupYigin) sock._grupYigin = new Map();
      const kayit = sock._grupYigin.get(jid) || { id: jid };
      if (ad) kayit.subject = ad;
      if (acikHam !== undefined) kayit.desc = acikHam || '';
      sock._grupYigin.set(jid, kayit);
      if (ad) { if (!sock._bilinenAdlar) sock._bilinenAdlar = new Map(); sock._bilinenAdlar.set(jid, ad); }

      // 2 saniyede bir, toplu halde yayinla
      if (!sock._grupYiginTimer) {
        sock._grupYiginTimer = setTimeout(() => {
          sock._grupYiginTimer = null;
          const paket = [...sock._grupYigin.values()];
          sock._grupYigin.clear();
          if (!paket.length) return;
          const adli = paket.filter((x) => x.subject).length;
          for (let i = 0; i < paket.length; i += 200) sock.ev.emit('groups.update', paket.slice(i, i + 200));
          log('grup guncellemesi: ' + paket.length + ' grup yayinlandi (' + adli + ' adiyla)'
            + (sock._bosGrupOlayi ? ' | bilgisiz atlanan: ' + sock._bosGrupOlayi : ''));
          sock._bosGrupOlayi = 0;
        }, 2000);
      }
      return;
    }

    // 7) GRUP UYELERI DEGISTI
    if (/group\.v2\.participants|group\.participants/.test(tip)) {
      const jid = veri.id || veri.chatId || jidAl(veri);
      // {id} yollamak server.js'te CANLI sorgu tetikliyor. Baglanti
      // aninda binlerce uye olayi gelebildigi icin bunu da kisitliyoruz:
      // ayni grup icin 60 saniyede en fazla bir kez.
      if (!jid) return;
      if (!sock._uyeOlaySon) sock._uyeOlaySon = new Map();
      const son = sock._uyeOlaySon.get(jid) || 0;
      if (Date.now() - son < 60000) return;
      sock._uyeOlaySon.set(jid, Date.now());
      if (sock._uyeOlaySon.size > 5000) sock._uyeOlaySon.delete(sock._uyeOlaySon.keys().next().value);
      sock.ev.emit('group-participants.update', { id: jid, participants: [], action: 'update' });
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
    // ═══ WAHA HENUZ AYAKTA DEGIL ════════════════════════════════════
    // 'docker compose up' ile ayni komutta pm2 restart yapilinca WAHA
    // birkac saniye gec aciliyor ve buraya 'fetch failed' ile duşuyoruz.
    // Bu bir hata degil, sadece erken davranmisiz. QR takibi zaten
    // oturumu bulamayinca kendisi kuracak (yukaridaki 404 dali).
    log('oturum hazirlanamadi: ' + e.message + ' — WAHA henuz acilmamis olabilir, takip basliyor');
    setImmediate(() => sock.ev.emit('connection.update', { connection: 'connecting' }));
    qrTakibiBaslat(sock);
  }

  return sock;
}

module.exports = {
  WAHA_URL, WAHA_API_KEY, WAHA_OTURUM, WAHA_KANCA_PORT, WAHA_KANCA_URL,
  istek, wahaSoketYap, baileysMesaji, baileysGrup, wahaMedyaIndir, qrAl,
  wahaBaglan, oturumHazirla,
  numaraTemizle, jidAl, zamanAl, lidNumara, benKur, ackCevir, baileysMesaji,
  ilkListeyiCek, ilkListeTuru, ilkListeBaslat, sohbetAdi, sohbetZamani,
  medyaAdresiDuzelt, yeniSohbetleriYayinla, isimleriTazele, adsizlariTamamla, tekSohbetAdi,
};
