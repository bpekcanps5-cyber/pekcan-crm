// ============================================================
// whapi-adapter.js — WHAPI'YI BAILEYS SOKETI KILIGINA SOKAR
// ------------------------------------------------------------
// AMAC: server.js'in panel/WS kodu su cagrilari yapiyor:
//     SOCK.sendMessage(jid, icerik, secenek)
//     SOCK.groupMetadata(jid)
//     SOCK.groupFetchAllParticipating()
//     SOCK.onWhatsApp(numara)
//     SOCK.readMessages(keys)
//     SOCK.sendPresenceUpdate(tip, jid)
//     SOCK.profilePictureUrl(jid, 'image')
//     SOCK.ev.removeAllListeners() / SOCK.end() / SOCK.ws.close()
//     SOCK.user
// Bu dosya AYNI arayuzu Whapi uzerinden saglar. Boylece
// server.js'teki gonderme/duzenleme/silme/tepki/iletme kodlarinin
// TEK SATIRI degismez ve Baileys yolu hic etkilenmez.
//
// TOKEN: sadece Authorization basliginda kullanilir. Log'a, hataya,
// panele ASLA yazilmaz (gizle() her ciktidan temizler).
// ============================================================

const GONDERIM_ZAMAN_ASIMI = 30000;   // tek istek icin tavan
const MEDYA_ZAMAN_ASIMI = 120000;     // medya yuklemesi daha uzun surebilir

function jidNumara(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}
function grupMu(jid) {
  return String(jid || '').endsWith('@g.us');
}
// Whapi 'to' alani: grup icin tam jid, kisi icin ciplak numara
function hedefCoz(jid) {
  return grupMu(jid) ? String(jid) : jidNumara(jid);
}

function olustur({ token, taban = 'https://gate.whapi.cloud', log = console.log }) {
  if (!token) throw new Error('whapi-adapter: token yok');
  const U = String(taban).replace(/\/+$/, '');
  // Token'i her ciktidan sil — kaza ile loglanmasin.
  const gizle = (s) => String(s == null ? '' : s).split(token).join('***');

  let kendiNumara = null;
  let kendiAd = '';

  async function istek(yol, { yontem = 'GET', govde = null, zamanAsimi = GONDERIM_ZAMAN_ASIMI } = {}) {
    const kontrol = new AbortController();
    const zt = setTimeout(() => kontrol.abort(), zamanAsimi);
    try {
      const basliklar = { Authorization: 'Bearer ' + token };
      if (govde) basliklar['Content-Type'] = 'application/json';
      const cevap = await fetch(U + yol, {
        method: yontem,
        headers: basliklar,
        body: govde ? JSON.stringify(govde) : undefined,
        signal: kontrol.signal,
      });
      const ham = await cevap.text();
      let veri = null;
      try { veri = ham ? JSON.parse(ham) : null; } catch (_) { veri = null; }
      if (!cevap.ok) {
        // 429 = hiz siniri. server.js'in kuyruklu gonderim katmani bu kelimeyi
        // tanisin diye Baileys'in kullandigi ifadeyi tasiyoruz.
        const detay = gizle(veri && veri.error ? JSON.stringify(veri.error) : ham).slice(0, 220);
        const hata = new Error(
          (cevap.status === 429 ? 'rate-overlimit: ' : 'whapi HTTP ' + cevap.status + ': ') + detay
        );
        hata.status = cevap.status;
        throw hata;
      }
      return veri;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('whapi zaman asimi (' + yol + ')');
      throw new Error(gizle(e.message));
    } finally { clearTimeout(zt); }
  }

  // ── KANAL DURUMU ──────────────────────────────────────────
  async function saglik() {
    const j = await istek('/health', { zamanAsimi: 15000 });
    const kullanici = (j && j.user) || {};
    if (kullanici.id) { kendiNumara = jidNumara(kullanici.id); kendiAd = kullanici.name || ''; }
    // status.code 4 / text 'AUTH' = bagli ve yetkili
    const durum = (j && j.status) || {};
    return {
      bagli: durum.code === 4 || String(durum.text).toUpperCase() === 'AUTH',
      durumMetni: durum.text || '',
      numara: kendiNumara,
      ad: kendiAd,
      ayaktaSn: j && j.uptime ? Number(j.uptime) : 0,
      kanalId: (j && j.channel_id) || '',
    };
  }

  // ── GONDERIM: Baileys icerik nesnesi -> Whapi ucu ─────────
  // server.js su bicimleri gonderiyor:
  //   {text}  {image,caption}  {video}  {audio,mimetype}  {document,fileName,mimetype}
  //   {sticker}  {react:{text,key}}  {delete:key}  {text,edit:key}  {forward:raw}
  function ucSec(icerik) {
    if (icerik.delete) return { tur: 'sil' };
    if (icerik.react) return { tur: 'tepki' };
    if (icerik.edit) return { tur: 'duzenle' };
    if (icerik.image !== undefined) return { tur: 'medya', yol: '/messages/image', alan: 'media' };
    if (icerik.video !== undefined) return { tur: 'medya', yol: '/messages/video', alan: 'media' };
    if (icerik.audio !== undefined) return { tur: 'medya', yol: '/messages/audio', alan: 'media' };
    if (icerik.document !== undefined) return { tur: 'medya', yol: '/messages/document', alan: 'media' };
    if (icerik.sticker !== undefined) return { tur: 'medya', yol: '/messages/sticker', alan: 'media' };
    if (icerik.forward) return { tur: 'ilet' };
    if (icerik.text !== undefined) return { tur: 'metin', yol: '/messages/text' };
    return { tur: 'bilinmeyen' };
  }

  // Baileys'te medya Buffer olarak veriliyor. Whapi base64 data-url kabul ediyor.
  function medyaGovde(deger, mime) {
    if (Buffer.isBuffer(deger)) {
      return 'data:' + (mime || 'application/octet-stream') + ';base64,' + deger.toString('base64');
    }
    if (deger && typeof deger === 'object' && deger.url) return String(deger.url);
    return String(deger || '');
  }

  // Whapi cevabindan mesaj kimligi cikar (bicim surumden surume degisebiliyor)
  function kimlikCoz(cevap) {
    if (!cevap) return '';
    const m = cevap.message || {};
    return m.id || (m.key && m.key.id) || cevap.id || cevap.sent_id || '';
  }

  // Baileys'in dondurdugu bicimde cevap uret — panel kodu sent.key.id okuyor.
  function baileysCevabi(id, jid) {
    return {
      key: { id: String(id), remoteJid: String(jid), fromMe: true },
      message: undefined,
      status: 1,
      _whapi: true,
    };
  }

  async function sendMessage(jid, icerik = {}, secenek = {}) {
    const hedef = hedefCoz(jid);
    const secim = ucSec(icerik);

    if (secim.tur === 'sil') {
      const hedefId = icerik.delete && icerik.delete.id;
      if (!hedefId) throw new Error('silinecek mesaj kimligi yok');
      await istek('/messages/' + encodeURIComponent(hedefId), { yontem: 'DELETE' });
      return baileysCevabi(hedefId, jid);
    }

    if (secim.tur === 'tepki') {
      const hedefId = icerik.react.key && icerik.react.key.id;
      if (!hedefId) throw new Error('tepki verilecek mesaj kimligi yok');
      await istek('/messages/' + encodeURIComponent(hedefId) + '/reaction', {
        yontem: 'PUT', govde: { emoji: icerik.react.text || '' },
      });
      return baileysCevabi(hedefId, jid);
    }

    if (secim.tur === 'duzenle') {
      const hedefId = icerik.edit && icerik.edit.id;
      if (!hedefId) throw new Error('duzenlenecek mesaj kimligi yok');
      await istek('/messages/' + encodeURIComponent(hedefId), {
        yontem: 'PUT', govde: { body: icerik.text || '' },
      });
      return baileysCevabi(hedefId, jid);
    }

    if (secim.tur === 'ilet') {
      // Whapi'de iletme ham proto ile degil, kaynak mesaj kimligiyle yapilir.
      // server.js'in gonderdigi 'forward' Baileys ham nesnesi -> kimligi cikar.
      const kaynak = icerik.forward || {};
      const kaynakId = (kaynak.key && kaynak.key.id) || kaynak.id || '';
      if (!kaynakId) throw new Error('iletilecek mesaj kimligi yok (Whapi ham nesne kabul etmiyor)');
      const c = await istek('/messages/' + encodeURIComponent(kaynakId) + '/forward', {
        yontem: 'POST', govde: { to: hedef },
      });
      return baileysCevabi(kimlikCoz(c) || kaynakId, jid);
    }

    if (secim.tur === 'metin') {
      const govde = { to: hedef, body: String(icerik.text || '') };
      // Alinti: Baileys {quoted: rawMesaj} verir; Whapi sadece kimlik ister.
      const alintiId = secenek.quoted && ((secenek.quoted.key && secenek.quoted.key.id) || secenek.quoted.id);
      if (alintiId) govde.quoted = String(alintiId);
      if (Array.isArray(icerik.mentions) && icerik.mentions.length) {
        govde.mentions = icerik.mentions.map(jidNumara);
      }
      const c = await istek(secim.yol, { yontem: 'POST', govde });
      const id = kimlikCoz(c);
      if (!id) throw new Error('whapi mesaj kimligi dondurmedi');
      return baileysCevabi(id, jid);
    }

    if (secim.tur === 'medya') {
      const ham = icerik.image ?? icerik.video ?? icerik.audio ?? icerik.document ?? icerik.sticker;
      const mime = icerik.mimetype || '';
      const govde = { to: hedef, media: medyaGovde(ham, mime) };
      if (icerik.caption) govde.caption = String(icerik.caption);
      if (icerik.fileName) govde.filename = String(icerik.fileName);
      if (mime) govde.mime_type = mime;
      const alintiId = secenek.quoted && ((secenek.quoted.key && secenek.quoted.key.id) || secenek.quoted.id);
      if (alintiId) govde.quoted = String(alintiId);
      const c = await istek(secim.yol, { yontem: 'POST', govde, zamanAsimi: MEDYA_ZAMAN_ASIMI });
      const id = kimlikCoz(c);
      if (!id) throw new Error('whapi medya kimligi dondurmedi');
      return baileysCevabi(id, jid);
    }

    throw new Error('bu icerik turu Whapi hattinda desteklenmiyor: ' + Object.keys(icerik).join(','));
  }

  // ── GRUPLAR ───────────────────────────────────────────────
  // Baileys groupMetadata bicimi: { id, subject, desc, participants:[{id,admin}] }
  function grupCevir(g) {
    if (!g) return null;
    const uyeler = g.participants || g.members || [];
    return {
      id: g.id || '',
      subject: g.name || g.subject || '',
      desc: g.description || g.desc || '',
      owner: g.owner || undefined,
      participants: (Array.isArray(uyeler) ? uyeler : []).map((p) => {
        const kimlik = typeof p === 'string' ? p : (p.id || p.phone || '');
        const rol = (typeof p === 'object' && (p.rank || p.role || p.admin)) || '';
        const yonetici = /admin|superadmin|creator|owner/i.test(String(rol)) ? 'admin' : null;
        const ad = (typeof p === 'object' && (p.name || p.pushname || p.display_name || p.notify)) || '';
        return {
          id: jidNumara(kimlik) + '@s.whatsapp.net',
          phoneNumber: jidNumara(kimlik),
          name: ad,
          admin: yonetici,
        };
      }),
    };
  }

  async function groupMetadata(jid) {
    const g = await istek('/groups/' + encodeURIComponent(String(jid)));
    const cevrilen = grupCevir(g);
    if (!cevrilen) throw new Error('grup bulunamadi');
    if (!cevrilen.id) cevrilen.id = String(jid);
    return cevrilen;
  }

  // UYE LISTESI: tekil /groups/{id} cevabinda participants BOS gelebiliyor
  // (participants_count 25 iken dizi bos). Bu durumda alternatif uclari sirayla dene.
  // Hicbiri tutmazsa bos dizi doner — UYDURMA veri uretilmez.
  async function uyeleriCek(jid) {
    const denenecek = [
      '/groups/' + encodeURIComponent(String(jid)) + '/participants',
      '/groups/' + encodeURIComponent(String(jid)) + '?participants=true',
      '/groups/' + encodeURIComponent(String(jid)) + '?full=true',
    ];
    for (const y of denenecek) {
      try {
        const j = await istek(y, { zamanAsimi: 20000 });
        const ham = (j && (j.participants || j.members || (Array.isArray(j) ? j : null))) || null;
        if (Array.isArray(ham) && ham.length) {
          const c = grupCevir({ id: jid, participants: ham });
          return { uc: y, uyeler: c.participants };
        }
      } catch (_) { /* sonrakini dene */ }
    }
    return { uc: null, uyeler: [] };
  }

  async function groupFetchAllParticipating() {
    const sonuc = {};
    let sayfa = 0;
    // Whapi sayfali doner; 500'luk paketlerle hepsini topla (en fazla 20 tur).
    while (sayfa < 20) {
      const j = await istek('/groups?count=500&offset=' + (sayfa * 500), { zamanAsimi: 60000 });
      const liste = (j && j.groups) || [];
      if (!liste.length) break;
      for (const g of liste) {
        const c = grupCevir(g);
        if (c && c.id) sonuc[c.id] = c;
      }
      const toplam = (j && Number(j.total)) || 0;
      if (Object.keys(sonuc).length >= toplam || liste.length < 500) break;
      sayfa += 1;
    }
    return sonuc;
  }

  // ── DIGER BAILEYS CAGRILARI ───────────────────────────────
  async function onWhatsApp(...numaralar) {
    const cikti = [];
    for (const n of numaralar.flat()) {
      const num = jidNumara(n);
      if (!num) continue;
      try {
        const j = await istek('/contacts/' + encodeURIComponent(num), { zamanAsimi: 15000 });
        // Whapi bulamazsa 404 firlatir; buraya geldiyse var demektir.
        cikti.push({ exists: true, jid: num + '@s.whatsapp.net', _whapi: j || undefined });
      } catch (_) {
        cikti.push({ exists: false, jid: num + '@s.whatsapp.net' });
      }
    }
    return cikti;
  }

  async function readMessages(keys) {
    // Baileys key dizisi alir. Whapi sohbet bazinda okundu isaretler.
    const sohbetler = new Set();
    for (const k of (keys || [])) {
      const jid = k && (k.remoteJid || k.jid);
      if (jid) sohbetler.add(hedefCoz(jid));
    }
    for (const s of sohbetler) {
      try { await istek('/chats/' + encodeURIComponent(s), { yontem: 'PATCH', govde: { read: true }, zamanAsimi: 15000 }); }
      catch (_) { /* okundu isareti kritik degil, sessiz gec */ }
    }
  }

  async function sendPresenceUpdate(tip, jid) {
    if (!jid) return;
    const esleme = { composing: 'typing', recording: 'recording', paused: 'pause', available: 'online', unavailable: 'offline' };
    try {
      await istek('/presences/' + encodeURIComponent(hedefCoz(jid)), {
        yontem: 'PUT', govde: { presence: esleme[tip] || 'typing' }, zamanAsimi: 10000,
      });
    } catch (_) { /* yaziyor gostergesi kritik degil */ }
  }

  async function profilePictureUrl(jid) {
    try {
      const num = jidNumara(jid);
      if (grupMu(jid)) {
        const g = await istek('/groups/' + encodeURIComponent(String(jid)), { zamanAsimi: 15000 });
        return (g && (g.chat_pic || g.chat_pic_full || g.profile_pic)) || null;
      }
      const c = await istek('/contacts/' + encodeURIComponent(num) + '/profile', { zamanAsimi: 15000 });
      return (c && (c.icon_full || c.icon || c.profile_pic)) || null;
    } catch (_) { return null; }
  }

  // Kacirilan mesajlari geri cek (webhook dustuyse). Baileys'te karsiligi yok,
  // Whapi'nin fazladan verdigi bir imkan.
  async function mesajlariCek(chatId, adet = 100) {
    const j = await istek('/messages/list/' + encodeURIComponent(chatId) + '?count=' + adet, { zamanAsimi: 60000 });
    return (j && j.messages) || [];
  }

  // ── SOKET KILIFI ──────────────────────────────────────────
  // server.js soketiKapat() icinde ev.removeAllListeners / end / ws.close cagiriyor.
  // Whapi'de kapatilacak soket yok; bunlar zararsiz bos fonksiyon.
  const sock = {
    _motor: 'whapi',
    user: { id: null, name: '' },
    ev: { on() {}, off() {}, removeAllListeners() {} },
    ws: { close() {} },
    end() {},
    updateMediaMessage: async (m) => m,   // Baileys medya yeniden yukleme kancasi; Whapi'de gereksiz
    sendMessage,
    groupMetadata,
    groupFetchAllParticipating,
    onWhatsApp,
    readMessages,
    sendPresenceUpdate,
    profilePictureUrl,
    // whapi'ye ozel ekler
    _saglik: saglik,
    _uyeleriCek: uyeleriCek,
    _mesajlariCek: mesajlariCek,
    _istek: istek,
    _gizle: gizle,
  };

  // Acilista kendi numarasini ogren (fromMe tespiti buna dayaniyor)
  sock._hazirla = async () => {
    const s = await saglik();
    sock.user = { id: s.numara ? s.numara + '@s.whatsapp.net' : null, name: s.ad };
    return s;
  };

  return sock;
}

module.exports = { olustur, jidNumara, hedefCoz };
