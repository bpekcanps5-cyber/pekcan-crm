// ============================================================
// whapi-cevirici.js — WHAPI BICIMI -> CRM IC BICIMI
// ------------------------------------------------------------
// SAF fonksiyonlar. Ag yok, dosya yok, yan etki yok.
// Bu yuzden tek basina test edilebilir.
//
// Whapi gelen webhook zarfi:
//   { messages:[...], event:{type,event}, channel_id }
//
// Cikti: is listesi. Her is su turlerden biri:
//   { tur:'mesaj',    jid, message, meta }   -> addMessage(jid, message, meta, lineId)
//   { tur:'tepki',    jid, hedefId, emoji, benMi }
//   { tur:'sil',      jid, hedefId }
//   { tur:'duzenle',  jid, hedefId, yeniMetin }
//   { tur:'atla',     sebep, ham }
// ============================================================

const MEDYA_ALANLARI = ['image', 'video', 'audio', 'voice', 'document', 'sticker'];

// YAS FILTRESI: server.js ile AYNI (MESAJ_SAKLAMA_GUN = 30).
// Whapi 'pdo_sync' ile TUM gecmisi yollayabiliyor; eski mesajlar panele
// dusmesin, DB'ye yazilmasin. Baileys yolunda da ayni filtre var.
const SAKLAMA_GUN = 30;
const SAKLAMA_MS = SAKLAMA_GUN * 24 * 60 * 60 * 1000;

// Whapi durum -> CRM durum kodu
//   CRM: 1 gonderiliyor · 2 gonderildi(tek tik) · 3 iletildi(cift tik) · 4 okundu(mavi) · -1 hata
const DURUM_ESLEME = {
  pending: 1, sent: 2, delivered: 3, read: 4, played: 4,
  failed: -1, error: -1, canceled: -1,
};

// Whapi tur -> CRM kind. Baileys'in describeMessage ciktisiyla ayni sozluk.
const TUR_ESLEME = {
  text: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
  voice: 'audio',        // sesli mesaj da CRM'de 'audio'
  document: 'document',
  sticker: 'sticker',
  contact: 'contact',
  contacts: 'contacts',
  location: 'text',      // metne cevrilir (Baileys de oyle yapiyor)
  live_location: 'text',
  poll: 'text',
  link_preview: 'text',
  gif: 'video',
};

function ikiHane(n) { return n < 10 ? '0' + n : String(n); }

// Baileys tarafindaki nowTime() ile ayni bicim: "14:35"
function saatBicimle(ms) {
  const d = new Date(ms);
  return ikiHane(d.getHours()) + ':' + ikiHane(d.getMinutes());
}

// Numarayi sadece rakama indir (90 539... / +90539... / 905399265441@s.whatsapp.net hepsi ayni olsun)
function numaraNorm(x) {
  return String(x || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

// Whapi chat_id -> CRM jid. Grup zaten @g.us ile geliyor; kisi ciplak numara gelebilir.
function jidCoz(chatId) {
  const ham = String(chatId || '');
  if (!ham) return '';
  if (ham.includes('@')) return ham;              // zaten tam jid
  return numaraNorm(ham) + '@s.whatsapp.net';     // ciplak numara -> kisi jid'i
}

// Mesajdaki medya nesnesini bul (hangi alanda geldiyse)
function medyaBul(m) {
  for (const alan of MEDYA_ALANLARI) {
    if (m[alan] && typeof m[alan] === 'object') return { alan, medya: m[alan] };
  }
  return null;
}

// Metin/aciklama cikar
function metinCoz(m, kind) {
  const govde = (m.text && (m.text.body != null ? m.text.body : m.text)) || '';
  const bulunan = medyaBul(m);
  const caption = (bulunan && bulunan.medya.caption) || m.caption || '';

  if (kind === 'document') {
    const dosyaAdi = (bulunan && (bulunan.medya.file_name || bulunan.medya.filename)) || m.filename || 'Belge';
    return { text: dosyaAdi, caption };
  }
  if (kind === 'image' || kind === 'video') {
    return { text: caption, caption };
  }
  if (kind === 'audio' || kind === 'sticker') {
    return { text: '', caption: '' };
  }
  if (m.type === 'location' || m.type === 'live_location') {
    const l = m.location || {};
    const koordinat = (l.latitude != null && l.longitude != null) ? (l.latitude + ', ' + l.longitude) : '';
    return { text: '📍 Konum' + (koordinat ? ': ' + koordinat : ''), caption: '' };
  }
  if (m.type === 'poll') {
    const p = m.poll || {};
    return { text: '📊 Anket: ' + (p.title || p.name || ''), caption: '' };
  }
  if (kind === 'contact') {
    const c = m.contact || {};
    return { text: c.name || c.display_name || 'Kişi', caption: '' };
  }
  if (kind === 'contacts') {
    const liste = (m.contacts && m.contacts.list) || m.contacts || [];
    return { text: (Array.isArray(liste) ? liste.length : 0) + ' kişi', caption: '' };
  }
  return { text: String(govde), caption };
}

// vCard'dan numara cikar (Baileys tarafiyla ayni mantik)
function vcardNumara(vcard) {
  const s = String(vcard || '');
  const eslesme = s.match(/waid=(\d+)/) || s.match(/TEL[^:]*:([+\d\s()-]+)/i);
  return eslesme ? eslesme[1].replace(/\D/g, '') : '';
}

function kisiCoz(m, kind) {
  if (kind === 'contact') {
    const c = m.contact || {};
    return {
      contact: { name: c.name || c.display_name || '', phone: c.phone || vcardNumara(c.vcard) },
      contacts: null,
    };
  }
  if (kind === 'contacts') {
    const ham = (m.contacts && m.contacts.list) || m.contacts || [];
    const liste = (Array.isArray(ham) ? ham : []).map((c) => ({
      name: c.name || c.display_name || '',
      phone: c.phone || vcardNumara(c.vcard),
    }));
    return { contact: null, contacts: liste };
  }
  return { contact: null, contacts: null };
}

// Alintili yanit (Whapi: text.context / m.context)
function alintiCoz(m) {
  const ctx = (m.text && m.text.context) || m.context;
  if (!ctx || !ctx.quoted_id) return null;
  const icerik = ctx.quoted_content || {};
  let metin = icerik.body || '';
  if (!metin) {
    const t = ctx.quoted_type;
    if (t === 'image') metin = '📷 Fotoğraf';
    else if (t === 'video') metin = '🎬 Video';
    else if (t === 'audio' || t === 'voice') metin = '🎤 Sesli mesaj';
    else if (t === 'document') metin = '📄 ' + (icerik.file_name || icerik.filename || 'Belge');
    else if (t === 'sticker') metin = '🏷️ Çıkartma';
  }
  return {
    id: ctx.quoted_id,
    sender: numaraNorm(ctx.quoted_author) || 'biri',
    text: metin,
  };
}

// ── TEK MESAJI CEVIR ────────────────────────────────────────
// benimNumaram: kanalin kendi numarasi (fromMe tespiti icin ZORUNLU).
// Whapi'nin from_me bayragi guvenilmez cikti (kendi mesajlarimizda da false
// donuyordu), o yuzden gonderen numarayi kendi numaramizla karsilastiriyoruz.
function mesajCevir(m, benimNumaram) {
  if (!m || typeof m !== 'object') return { tur: 'atla', sebep: 'bos kayit', ham: m };

  const jid = jidCoz(m.chat_id);
  if (!jid) return { tur: 'atla', sebep: 'chat_id yok', ham: m };
  if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) {
    return { tur: 'atla', sebep: 'durum/kanal yayini', ham: m };
  }
  if (!m.id) return { tur: 'atla', sebep: 'mesaj id yok', ham: m };

  const isGroup = jid.endsWith('@g.us');
  const gonderen = numaraNorm(m.from);
  const benim = numaraNorm(benimNumaram);
  // from_me bayragina DEGIL, numara karsilastirmasina guveniyoruz.
  // Bayrak dogruysa da yanlissa da bu yontem calisir.
  const fromMe = !!(benim && gonderen === benim) || (!benim && !!m.from_me);
  const ts = m.timestamp ? Number(m.timestamp) * 1000 : Date.now();

  // ── YAS FILTRESI ──
  // Gecmis senkronundan gelen eski mesajlari ELE. 'action' turleri (tepki/
  // silme/duzenleme) HEDEF mesaji guncelledigi icin filtreden muaf degil:
  // eski bir mesaja gelen tepki de eskidir, zaten hedefi bellekte olmaz.
  if (ts < Date.now() - SAKLAMA_MS) {
    return { tur: 'atla', sebep: 'eski mesaj (' + SAKLAMA_GUN + ' gunden once)', ham: null };
  }

  // ── ACTION: tepki / silme / duzenleme. Bunlar YENI MESAJ DEGIL. ──
  if (m.type === 'action') {
    const a = m.action || {};
    const hedefId = a.target || '';
    if (!hedefId) return { tur: 'atla', sebep: 'action hedefi yok', ham: m };
    if (a.type === 'reaction') {
      return { tur: 'tepki', jid, hedefId, emoji: a.emoji || '', benMi: fromMe, kimden: m.from_name || '' };
    }
    if (a.type === 'delete') {
      return { tur: 'sil', jid, hedefId };
    }
    if (a.type === 'edit') {
      const yeni = (a.edited_content && (a.edited_content.body != null ? a.edited_content.body : a.edited_content)) || '';
      return { tur: 'duzenle', jid, hedefId, yeniMetin: String(yeni) };
    }
    return { tur: 'atla', sebep: 'bilinmeyen action: ' + a.type, ham: m };
  }

  // ── NORMAL MESAJ ──
  const bilinen = TUR_ESLEME[m.type];
  const kind = bilinen || 'undecryptable';
  const { text, caption } = metinCoz(m, kind);
  const { contact, contacts } = kisiCoz(m, kind);
  const bulunan = medyaBul(m);

  const message = {
    id: m.id,
    fromMe,
    kind,
    text: kind === 'undecryptable'
      ? 'Bu mesajın içeriği alınamadı (tip: ' + (m.type || 'bilinmiyor') + ')'
      : text,
    caption: caption || '',
    fileName: (bulunan && (bulunan.medya.file_name || bulunan.medya.filename)) || undefined,
    mime: (bulunan && bulunan.medya.mime_type) || undefined,
    mediaUrl: null,                 // once null; medya arka planda inip guncellenecek
    thumb: null,                    // asagida preview'dan uretilecek
    contact,
    contacts,
    sender: fromMe ? 'Ben' : (m.from_name || gonderen || ''),
    senderJid: gonderen ? gonderen + '@s.whatsapp.net' : '',
    senderPush: m.from_name || '',
    time: saatBicimle(ts),
    replyTo: alintiCoz(m),
    forwarded: !!(m.forwarded || m.is_forwarded),
    mentionsMe: false,              // asagida hesaplanir
    mentions: [],
  };

  // Bahsedilme: Whapi mentions dizisi verirse kendi numaramizi ara
  const bahsedilenler = (m.text && m.text.mentions) || m.mentions || [];
  if (Array.isArray(bahsedilenler) && bahsedilenler.length) {
    message.mentions = bahsedilenler.map((x) => numaraNorm(x)).filter(Boolean);
    if (!fromMe && benim) message.mentionsMe = message.mentions.includes(benim);
  }

  // Indirilecek medya bilgisi (cevirici indirmez, sadece isaret eder)
  const indir = (bulunan && bulunan.medya.link)
    ? { link: bulunan.medya.link, mime: bulunan.medya.mime_type || '', dosyaAdi: bulunan.medya.file_name || bulunan.medya.filename || '' }
    : null;

  // Onizleme: Whapi 'preview' alaninda base64 data-url veriyor -> aninda goster
  const onizleme = (bulunan && bulunan.medya.preview) || null;

  const meta = {
    name: m.chat_name || (isGroup ? '' : (m.from_name || '')) || '',
    isGroup,
    mentionsMe: message.mentionsMe,
  };

  return { tur: 'mesaj', jid, isGroup, message, meta, indir, onizleme, ts };
}

// ── DURUM (TIK) CEVIRICI ────────────────────────────────────
// Whapi zarfi: { statuses:[{id, code, status, recipient_id, viewer_id}], event:{type:'statuses'} }
// Baileys'te bunun karsiligi messages.update(status) + message-receipt.update.
function durumCevir(d) {
  if (!d || !d.id) return { tur: 'atla', sebep: 'durum kimligi yok' };
  const jid = jidCoz(d.recipient_id || d.chat_id);
  if (!jid) return { tur: 'atla', sebep: 'durum sohbeti yok' };
  let kod = DURUM_ESLEME[String(d.status || '').toLowerCase()];
  if (kod === undefined) {
    const c = Number(d.code);
    kod = (c >= 1 && c <= 4) ? c : undefined;
  }
  if (kod === undefined) return { tur: 'atla', sebep: 'bilinmeyen durum: ' + d.status };
  return {
    tur: 'durum', jid, hedefId: d.id, durum: kod,
    okuyan: d.viewer_id ? numaraNorm(d.viewer_id) : '',
  };
}

// ── ZARFI CEVIR ─────────────────────────────────────────────
function zarfCevir(zarf, benimNumaram) {
  if (!zarf || typeof zarf !== 'object') return [];
  const isler = [];

  // DURUM ZARFI (tik bilgisi)
  if (Array.isArray(zarf.statuses)) {
    for (const d of zarf.statuses) {
      try { isler.push(durumCevir(d)); }
      catch (e) { isler.push({ tur: 'atla', sebep: 'durum cevirici hatasi: ' + e.message }); }
    }
  }

  // MESAJ ZARFI
  const liste = Array.isArray(zarf.messages) ? zarf.messages
              : (zarf.message ? [zarf.message] : []);
  for (const m of liste) {
    try { isler.push(mesajCevir(m, benimNumaram)); }
    catch (e) { isler.push({ tur: 'atla', sebep: 'cevirici hatasi: ' + e.message, ham: m }); }
  }
  return isler;
}

module.exports = { zarfCevir, mesajCevir, durumCevir, jidCoz, numaraNorm, saatBicimle, SAKLAMA_MS };
