// ============================================================
// db.js — Supabase (PostgreSQL) baglanti ve veri katmani
// server.js bunu kullanarak sohbet/mesaj/kisi/ayar okur-yazar.
// .env icindeki DATABASE_URL'i kullanir.
// ============================================================
require('dotenv').config();
const { Pool } = require('pg');

let pool = null;
let aktif = false; // baglanti basarili mi

// Baglanti havuzu olustur
function init() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('⚠️  .env icinde DATABASE_URL yok — Supabase KAPALI, veriler bellekte kalir.');
    return false;
  }
  pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false }, // Supabase SSL ister
    // --- Supabase TRANSACTION MODE pooler (port 6543) icin ayarlar ---
    // 40 kullanici icin ayarlandi. Pooler zaten havuzlar; biz makul bir es-zamanlilik tutariz.
    max: 12,                         // 40 kullanici icin 12 es-zamanli baglanti (eskiden 5'ti)
    min: 2,                          // her zaman 2 baglanti hazir tut (ilk sorgu beklemesin)
    idleTimeoutMillis: 30000,        // bos baglantiyi 30sn sonra birak
    connectionTimeoutMillis: 20000,  // yogunlukta baglanti alma suresi (biraz daha tolerans)
    allowExitOnIdle: false,
  });
  pool.on('error', (err) => { console.error('⚠️  DB havuz hatasi:', err.message); });
  return true;
}

// Baglantiyi test et (server acilirken VE koptuktan sonra periyodik cagrilir)
async function test() {
  if (!pool) return false;
  try {
    const r = await pool.query('SELECT now() AS zaman');
    const oncedenKapaliydi = !aktif;
    aktif = true;
    if (oncedenKapaliydi) {
      console.log(`✅ Supabase baglantisi BASARILI (sunucu saati: ${r.rows[0].zaman.toISOString()})`);
    }
    return true;
  } catch (e) {
    aktif = false;
    console.error('❌ Supabase baglanti HATASI:', e.message);
    console.error('   → Olasi nedenler: (1) Supabase projesi duraklatilmis (dashboard > Restore),');
    console.error('     (2) yanlis port — pooler icin 6543 (transaction) onerilir, (3) yanlis sifre/host.');
    return false;
  }
}

function isReady() { return aktif; }

// ---- Log spam kontrolu: ayni hatayi her sorguda degil, periyodik ozetle ----
let _sonHataZamani = 0;
let _bastirilanHata = 0;
function logSorguHatasi(mesaj) {
  const simdi = Date.now();
  _bastirilanHata++;
  // En fazla 10 saniyede bir hata satiri bas; arada birikenleri say
  if (simdi - _sonHataZamani > 10000) {
    const ek = _bastirilanHata > 1 ? ` (son 10sn'de ${_bastirilanHata} benzer hata bastirildi)` : '';
    console.error(`⚠️  DB sorgu hatasi: ${mesaj}${ek}`);
    _sonHataZamani = simdi;
    _bastirilanHata = 0;
  }
}

// ---- yardimci: tek sorgu calistir ----
async function q(text, params, opts) {
  if (!aktif) return { rows: [] };
  try {
    return await pool.query(text, params);
  } catch (e) {
    // sessiz mod: cagiran taraf hatayi kendi yonetecek (orn. saveMessage fallback)
    if (!opts || !opts.sessiz) logSorguHatasi(e.message);
    // Baglanti tipi bir hata ise: aktif'i dusur ki spam dursun, otomatik yeniden
    // baglanma devreye girsin (asagidaki baglantiyiIzle bunu toparlar).
    const baglantiHatasi = /timeout|ECONNREFUSED|ENOTFOUND|terminat|Connection| to connect/i.test(e.message || '');
    if (baglantiHatasi) aktif = false;
    return { rows: [], _hata: true, _mesaj: e.message };
  }
}

// ---- Otomatik yeniden baglanma: koptuysa periyodik dene, gelince kendine gelir ----
// server.js'ten startKeepAlive() ile baslatilir.
let _izleTimer = null;
function startKeepAlive(saniye = 15) {
  if (_izleTimer) return;
  _izleTimer = setInterval(async () => {
    if (!aktif && pool) {
      // sessizce yeniden baglanmayi dene (test zaten basariyi loglar)
      await test();
    }
  }, saniye * 1000);
  _izleTimer.unref?.(); // bu timer surecin kapanmasini engellemesin
}

// ============================================================
// SOHBETLER (chats)
// ============================================================
async function saveChat(c, lineId = 'ofis') {
  if (!aktif) return;
  await q(
    `INSERT INTO chats (line_id, jid, name, is_group, description, avatar, member_count, members, unread, last_time, last_ts, pinned, archived, has_mention, custom_name, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
     ON CONFLICT (line_id, jid) DO UPDATE SET
       name=EXCLUDED.name, is_group=EXCLUDED.is_group, description=EXCLUDED.description,
       avatar=COALESCE(EXCLUDED.avatar, chats.avatar), member_count=EXCLUDED.member_count,
       members=EXCLUDED.members, unread=EXCLUDED.unread, last_time=EXCLUDED.last_time,
       last_ts=EXCLUDED.last_ts, pinned=EXCLUDED.pinned, archived=EXCLUDED.archived,
       has_mention=EXCLUDED.has_mention, custom_name=COALESCE(EXCLUDED.custom_name, chats.custom_name),
       updated_at=now()`,
    [lineId, c.jid, c.name || '', !!c.isGroup, c.description || '', c.avatar || null,
     c.memberCount || 0, JSON.stringify(c.members || []), c.unread || 0,
     c.lastTime || '', c.lastTs || 0, !!c.pinned, !!c.archived, !!c.hasMention, c.customName || null]
  );
}

// ============================================================
// MESAJLAR (messages)
// ============================================================
async function saveMessage(chatJid, m, lineId = 'ofis') {
  if (!aktif) return;
  const mentionsVal = (m.mentions && m.mentions.length) ? JSON.stringify(m.mentions) : null;
  const captionVal = m.caption || null;
  // Once mentions + caption + reaction_by sutunlari DAHIL kaydetmeyi dene.
  const r = await q(
    `INSERT INTO messages (line_id, id, chat_jid, from_me, kind, text, media_url, thumb, sender, sender_jid, sender_push, reply_to, contact_data, contacts_data, reaction, my_reaction, forwarded, mentions_me, edited, deleted, time, ts, key_data, mentions, caption, reaction_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26, now())
     ON CONFLICT (line_id, chat_jid, id) DO UPDATE SET
       text=EXCLUDED.text, kind=EXCLUDED.kind, media_url=COALESCE(EXCLUDED.media_url, messages.media_url),
       reaction=EXCLUDED.reaction, my_reaction=EXCLUDED.my_reaction,
       edited=EXCLUDED.edited, deleted=EXCLUDED.deleted,
       mentions=COALESCE(EXCLUDED.mentions, messages.mentions),
       caption=COALESCE(EXCLUDED.caption, messages.caption),
       reaction_by=EXCLUDED.reaction_by`,
    [lineId, m.id, chatJid, !!m.fromMe, m.kind || 'text', m.text || '', m.mediaUrl || null,
     m.thumb || null, m.sender || '', m.senderJid || '', m.senderPush || '',
     m.replyTo ? JSON.stringify(m.replyTo) : null,
     m.contact ? JSON.stringify(m.contact) : null,
     m.contacts ? JSON.stringify(m.contacts) : null,
     m.reaction || null, m.myReaction || null, !!m.forwarded, !!m.mentionsMe,
     !!m.edited, !!m.deleted, m.time || '', m.ts || 0,
     m.key ? JSON.stringify(m.key) : null, mentionsVal, captionVal, m.reactionBy || null],
    { sessiz: true } // hata olursa loglama, asagida fallback var
  );
  // mentions/reaction_by sutunlari HENUZ eklenmediyse (SQL calistirilmadi), q bos doner.
  // O zaman o sutunlar OLMADAN kaydet ki mesaj KESINLIKLE kaybolmasin.
  if (r && r._hata) {
    await q(
      `INSERT INTO messages (line_id, id, chat_jid, from_me, kind, text, media_url, thumb, sender, sender_jid, sender_push, reply_to, contact_data, contacts_data, reaction, my_reaction, forwarded, mentions_me, edited, deleted, time, ts, key_data, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, now())
       ON CONFLICT (line_id, chat_jid, id) DO UPDATE SET
         text=EXCLUDED.text, kind=EXCLUDED.kind, media_url=COALESCE(EXCLUDED.media_url, messages.media_url),
         reaction=EXCLUDED.reaction, my_reaction=EXCLUDED.my_reaction,
         edited=EXCLUDED.edited, deleted=EXCLUDED.deleted`,
      [lineId, m.id, chatJid, !!m.fromMe, m.kind || 'text', m.text || '', m.mediaUrl || null,
       m.thumb || null, m.sender || '', m.senderJid || '', m.senderPush || '',
       m.replyTo ? JSON.stringify(m.replyTo) : null,
       m.contact ? JSON.stringify(m.contact) : null,
       m.contacts ? JSON.stringify(m.contacts) : null,
       m.reaction || null, m.myReaction || null, !!m.forwarded, !!m.mentionsMe,
       !!m.edited, !!m.deleted, m.time || '', m.ts || 0,
       m.key ? JSON.stringify(m.key) : null]
    );
  }
}

// ============================================================
// KISILER (contacts) — kayitli isimler
// ============================================================
async function saveContact(jid, name, isManual) {
  if (!aktif) return;
  await q(
    `INSERT INTO contacts (jid, name, is_manual, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (jid) DO UPDATE SET
       name=EXCLUDED.name,
       is_manual=(contacts.is_manual OR EXCLUDED.is_manual),
       updated_at=now()`,
    [jid, name, !!isManual]
  );
}

// ============================================================
// AYARLAR (settings) — key/value
// ============================================================
async function saveSetting(key, value) {
  if (!aktif) return;
  await q(
    `INSERT INTO settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}

// Tek bir ayari oku (yoksa varsayilani dondur)
async function getSetting(key, varsayilan = null) {
  if (!aktif) return varsayilan;
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
    if (r.rows.length === 0) return varsayilan;
    return r.rows[0].value; // jsonb -> JS degeri olarak doner
  } catch (e) {
    console.error('⚠️  getSetting hatasi:', e.message);
    return varsayilan;
  }
}

// ============================================================
// "BURADAYIM" — grup ilgi isareti (kim hangi grupla ilgileniyor)
// settings'te 'grup_buradayim' -> { grupJid: [ {user, ad}, ... ] }
// Kalici (kullanici kaldirana kadar), herkese gorunur.
// ============================================================
async function getBuradayim() {
  const v = await getSetting('grup_buradayim', {});
  return (v && typeof v === 'object') ? v : {};
}
// Bir kullanicinin bir gruptaki "buradayim" durumunu yak/sondur (toggle).
// Doner: { durum: guncel liste, aktif: bool }
async function toggleBuradayim(grupJid, user, ad) {
  if (!aktif) return { ok: false };
  try {
    const hepsi = await getBuradayim();
    let liste = Array.isArray(hepsi[grupJid]) ? hepsi[grupJid] : [];
    const idx = liste.findIndex(x => x.user === user);
    let aktif;
    if (idx >= 0) { liste.splice(idx, 1); aktif = false; } // vardi -> kaldir
    else { liste.push({ user, ad }); aktif = true; }        // yoktu -> ekle
    if (liste.length) hepsi[grupJid] = liste;
    else delete hepsi[grupJid]; // bos kaldiysa grubu tamamen sil (temiz kalsin)
    await saveSetting('grup_buradayim', hepsi);
    return { ok: true, aktif, liste };
  } catch (e) { return { ok: false, error: e.message }; }
}
// YONETICI: bir gruptaki TUM "buradayim" isaretlerini temizle (herkesinkini kaldir).
async function clearBuradayim(grupJid) {
  if (!aktif) return { ok: false };
  try {
    const hepsi = await getBuradayim();
    delete hepsi[grupJid];
    await saveSetting('grup_buradayim', hepsi);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================
// ACILISTA TUM VERIYI OKU (bellege doldurmak icin)
// ============================================================
async function loadAll(lineId = 'ofis') {
  if (!aktif) return { chats: [], contacts: [], settings: {} };
  const out = { chats: [], contacts: [], settings: {} };
  try {
    // sohbetler — SADECE bu hatta ait + mesaj trafigi olanlar (last_ts>0).
    // line_id ile filtreleme: her hat sadece kendi sohbetlerini yukler (izolasyon).
    const ch = await pool.query('SELECT * FROM chats WHERE line_id=$1 AND last_ts > 0 ORDER BY last_ts DESC', [lineId]);
    out.chats = ch.rows;
    // kisiler (kayitli isimler — su an ortak; ileride hatta ozel yapilabilir)
    const co = await pool.query('SELECT * FROM contacts');
    out.contacts = co.rows;
    // ayarlar
    const se = await pool.query('SELECT * FROM settings');
    for (const row of se.rows) out.settings[row.key] = row.value;
  } catch (e) {
    console.error('⚠️  DB loadAll hatasi:', e.message);
  }
  return out;
}

// Bir sohbetin son N mesajini oku
// Saklama suresi (gun). server.js ile ayni mantik; eski mesajlar okunmaz/silinir.
const SAKLAMA_GUN = 30;
function eskiEsikMs() { return Date.now() - SAKLAMA_GUN * 24 * 60 * 60 * 1000; }

async function loadMessages(chatJid, limit = 60, lineId = 'ofis', beforeTs = null) {
  if (!aktif) return [];
  try {
    // Sadece son SAKLAMA_GUN gunluk + bu hatta ait mesajlar (izolasyon).
    // beforeTs verilirse: o zamandan ESKI mesajlari getir (sonsuz scroll / "daha fazla yukle").
    let sql, params;
    if (beforeTs) {
      sql = 'SELECT * FROM messages WHERE line_id=$1 AND chat_jid=$2 AND ts >= $3 AND ts < $4 ORDER BY ts DESC LIMIT $5';
      params = [lineId, chatJid, eskiEsikMs(), beforeTs, limit];
    } else {
      sql = 'SELECT * FROM messages WHERE line_id=$1 AND chat_jid=$2 AND ts >= $3 ORDER BY ts DESC LIMIT $4';
      params = [lineId, chatJid, eskiEsikMs(), limit];
    }
    const r = await pool.query(sql, params);
    return r.rows.reverse(); // eskiden yeniye (snake_case; çağıran taraf camelCase'e çevirir)
  } catch (e) {
    console.error('⚠️  DB loadMessages hatasi:', e.message);
    return [];
  }
}

// ============================================================
// MESAJ İÇERİĞİNDE ARAMA (WhatsApp gibi — sohbet adı değil, mesaj metni içinde)
// Verilen kelimeyi bu hatta ait mesajların text/caption alanlarında arar.
// Eşleşen her sohbet için: kaç eşleşme + en son eşleşen mesajın özeti döner.
// ============================================================
async function searchMessages(kelime, lineId = 'ofis', limit = 40) {
  if (!aktif || !kelime || kelime.trim().length < 2) return { sohbetler: [], mesajlar: [] };
  try {
    // ÇOK KELİMELİ ARAMA: "araç motor" -> hem "araç" hem "motor" geçen mesajlar (ayrı ayrı).
    // Tek kelime gibi "%araç motor%" aramak, kelimeler ardışık değilse bulamıyordu.
    const kelimeler = kelime.trim().toLowerCase().split(/\s+/).filter(k => k.length >= 2).slice(0, 5);
    if (!kelimeler.length) return { sohbetler: [], mesajlar: [] };
    // her kelime için ayrı LIKE koşulu (hepsi geçmeli = AND)
    const kosullar = [];
    const params = [lineId, eskiEsikMs()];
    for (const k of kelimeler) {
      params.push('%' + k + '%');
      const idx = params.length;
      kosullar.push(`(LOWER(text) LIKE $${idx} OR LOWER(caption) LIKE $${idx})`);
    }
    const kosulSql = kosullar.join(' AND ');

    // 1) SOHBET ÖZETİ: hangi sohbette kaç eşleşme
    const ozet = await pool.query(
      `SELECT chat_jid, COUNT(*) AS eslesme, MAX(ts) AS son_ts
       FROM messages
       WHERE line_id = $1 AND ts >= $2 AND ${kosulSql}
       GROUP BY chat_jid
       ORDER BY son_ts DESC
       LIMIT ${limit}`,
      params
    );
    // 2) EŞLEŞEN MESAJLAR (WhatsApp gibi "Mesajlar" bölümü).
    //    NOT: messages tablosunda chat_name sütunu YOK — sohbet adını panel kendi belleğinden alır.
    const msgs = await pool.query(
      `SELECT id, chat_jid, text, caption, sender, from_me, ts, time
       FROM messages
       WHERE line_id = $1 AND ts >= $2 AND ${kosulSql}
       ORDER BY ts DESC
       LIMIT 60`,
      params
    );
    return {
      sohbetler: ozet.rows.map(x => ({
        chatJid: x.chat_jid, eslesme: Number(x.eslesme) || 0, sonTs: Number(x.son_ts) || 0,
      })),
      mesajlar: msgs.rows.map(m => ({
        id: m.id, chatJid: m.chat_jid, chatName: '',
        text: m.text || m.caption || '', sender: m.sender || '', fromMe: m.from_me || false,
        ts: Number(m.ts) || 0, time: m.time || '',
      })),
    };
  } catch (e) {
    console.error('⚠️  searchMessages hatasi:', e.message);
    return { sohbetler: [], mesajlar: [] };
  }
}

// Gunde bir kez calistirilir (server.js startCleanup). Sohbet/kisi/ayar KORUNUR;
// sadece eski MESAJLAR silinir, boylece veritabani kucuk ve hizli kalir.
// ============================================================
async function cleanupOld() {
  if (!aktif) return { silinen: 0 };
  try {
    const r = await pool.query('DELETE FROM messages WHERE ts < $1', [eskiEsikMs()]);
    const silinen = r.rowCount || 0;
    if (silinen > 0) console.log(`🧹 Eski mesaj temizligi: ${silinen} mesaj silindi (${SAKLAMA_GUN} gunden eski).`);
    return { silinen };
  } catch (e) {
    console.error('⚠️  cleanupOld hatasi:', e.message);
    return { silinen: 0, error: e.message };
  }
}

// Tek bir mesaji DB'den TAMAMEN sil (gonderilemeyen hayalet mesaj temizligi icin).
// Not: WhatsApp'tan "herkesten sil" islemi DEGIL — o saveMessage ile deleted=true yazar.
// Bu sadece hic gitmemis/hayalet mesaji DB'den kaldirir ki yenileyince geri gelmesin.
async function deleteMessage(chatJid, id, lineId = 'ofis') {
  if (!aktif) return;
  try {
    await pool.query('DELETE FROM messages WHERE line_id=$1 AND chat_jid=$2 AND id=$3', [lineId, chatJid, id]);
  } catch (e) { /* tablo/satir yoksa sessizce gec */ }
}

// ============================================================
// SATIŞ TAKİBİ (pazarlamacı gruba "/trafik2" yazinca)
// ============================================================
// Bir satis kaydet. Ayni mesaj_id ile tekrar gelirse (WhatsApp yansimasi) cift yazmaz.
async function saveSatis(s, lineId = 'ofis') {
  if (!aktif) return { ok: false };
  // ONCE yeni kolonlarla dene (fiyat, odeme_tip, odeme_periyot). Kolonlar henuz
  // eklenmemisse (SQL calistirilmadiysa) ESKI sekilde kaydet -> satis ASLA kaybolmaz.
  try {
    const r = await pool.query(
      `INSERT INTO satislar (id, line_id, chat_jid, chat_name, urun, adet, satici, satici_jid, mesaj_id, ham_mesaj, ts, fiyat, odeme_tip, odeme_periyot, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [s.id, lineId, s.chatJid, s.chatName || '', s.urun, s.adet || 1, s.satici || '', s.saticiJid || '', s.mesajId || '', s.hamMesaj || '', s.ts || Date.now(),
       (s.fiyat ?? null), (s.odemeTip ?? null), (s.odemePeriyot ?? null)]
    );
    return { ok: true, row: r.rows[0] || null, yeni: r.rows.length > 0 };
  } catch (e) {
    // 42703 = kolon yok -> eski kolonlarla kaydet (SQL henuz calistirilmamis)
    if (e.code === '42703' || /column .* does not exist/i.test(e.message || '')) {
      try {
        const r = await pool.query(
          `INSERT INTO satislar (id, line_id, chat_jid, chat_name, urun, adet, satici, satici_jid, mesaj_id, ham_mesaj, ts, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [s.id, lineId, s.chatJid, s.chatName || '', s.urun, s.adet || 1, s.satici || '', s.saticiJid || '', s.mesajId || '', s.hamMesaj || '', s.ts || Date.now()]
        );
        console.warn('⚠️  satislar tablosunda fiyat/odeme kolonlari yok — SQL calistirilinca detaylar da kaydedilecek');
        return { ok: true, row: r.rows[0] || null, yeni: r.rows.length > 0 };
      } catch (e2) {
        console.error('saveSatis hatasi (fallback):', e2.message);
        return { ok: false, error: e2.message };
      }
    }
    console.error('saveSatis hatasi:', e.message);
    return { ok: false, error: e.message };
  }
}

// Bir hattin satislarini getir (tarih araligi opsiyonel). En yeni ustte.
// baslangicTs/bitisTs verilirse o araliktakiler; verilmezse son 500.
async function loadSatislar(lineId = 'ofis', baslangicTs = null, bitisTs = null) {
  if (!aktif) return [];
  try {
    let sql, params;
    if (baslangicTs !== null && bitisTs !== null) {
      sql = 'SELECT * FROM satislar WHERE line_id=$1 AND ts>=$2 AND ts<=$3 ORDER BY ts DESC';
      params = [lineId, baslangicTs, bitisTs];
    } else {
      sql = 'SELECT * FROM satislar WHERE line_id=$1 ORDER BY ts DESC LIMIT 500';
      params = [lineId];
    }
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (e) { return []; }
}

// TUM hatlarin satislari (yonetici hepsini gorur). Tarih araligi opsiyonel.
async function loadTumSatislar(baslangicTs = null, bitisTs = null) {
  if (!aktif) return [];
  try {
    let sql, params;
    if (baslangicTs !== null && bitisTs !== null) {
      sql = 'SELECT * FROM satislar WHERE ts>=$1 AND ts<=$2 ORDER BY ts DESC';
      params = [baslangicTs, bitisTs];
    } else {
      sql = 'SELECT * FROM satislar ORDER BY ts DESC LIMIT 1000';
      params = [];
    }
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (e) { return []; }
}

// Bir satisin adedini DUZENLE (pazarlamaci yanlis yazmissa). Denetim izi tutulur.
async function updateSatisAdet(id, yeniAdet, duzenleyen, yeniUrun = null) {
  if (!aktif) return { ok: false };
  try {
    // once mevcut adet+urunu al (eski_adet kaydi + degisiklik tespiti icin)
    const mevcut = await pool.query('SELECT adet, urun, gun_kapandi FROM satislar WHERE id=$1', [id]);
    if (!mevcut.rows.length) return { ok: false, error: 'Satış bulunamadı' };
    if (mevcut.rows[0].gun_kapandi) return { ok: false, error: 'Bu satış kapatılmış bir güne ait, düzenlenemez.' };
    const eskiAdet = mevcut.rows[0].adet;
    const eskiUrun = mevcut.rows[0].urun;
    // urun verildiyse onu da guncelle, yoksa eskisini koru
    const kullanUrun = (yeniUrun && yeniUrun.trim()) ? yeniUrun.trim() : eskiUrun;
    const r = await pool.query(
      `UPDATE satislar SET adet=$1, urun=$2, duzenlendi=TRUE, duzenleyen=$3, eski_adet=$4 WHERE id=$5 RETURNING *`,
      [yeniAdet, kullanUrun, duzenleyen || '', eskiAdet, id]
    );
    return { ok: true, row: r.rows[0], eskiAdet, eskiUrun, yeniUrun: kullanUrun };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Yonetici bir satisi ONAYLA / onayi kaldir
async function setSatisOnay(id, onayli) {
  if (!aktif) return { ok: false };
  try {
    const r = await pool.query('UPDATE satislar SET onayli=$1 WHERE id=$2 RETURNING *', [!!onayli, id]);
    return { ok: r.rows.length > 0, row: r.rows[0] || null };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Bir satisi sil (yanlis/mukerrer kayit — sadece yonetici)
async function deleteSatis(id) {
  if (!aktif) return { ok: false };
  try {
    await pool.query('DELETE FROM satislar WHERE id=$1', [id]);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// GUNU KAPAT: belirli bir hattin belirli bir gunundeki satislari kilitle (gun_kapandi=true).
// tarih: 'YYYY-MM-DD'. O gunun 00:00-23:59 araligindaki satislar kapatilir.
async function gunuKapat(lineId, tarih, kapatan) {
  if (!aktif) return { ok: false };
  try {
    // gunun baslangic/bitis epoch ms'i (yerel degil, basit UTC gun siniri — sunucu saatine gore)
    const bas = new Date(tarih + 'T00:00:00').getTime();
    const bit = new Date(tarih + 'T23:59:59.999').getTime();
    const upd = await pool.query(
      'UPDATE satislar SET gun_kapandi=TRUE, onayli=TRUE WHERE line_id=$1 AND ts>=$2 AND ts<=$3 RETURNING adet',
      [lineId, bas, bit]
    );
    const toplam = upd.rows.reduce((a, r) => a + (r.adet || 0), 0);
    const kapaliId = lineId + '_' + tarih;
    await pool.query(
      `INSERT INTO kapali_gunler (id, line_id, tarih, kapatan, toplam_adet, kapatildi_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (id) DO UPDATE SET kapatan=EXCLUDED.kapatan, toplam_adet=EXCLUDED.toplam_adet, kapatildi_at=now()`,
      [kapaliId, lineId, tarih, kapatan || '', toplam]
    );
    return { ok: true, toplam, adet: upd.rows.length };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Kapali gunleri getir (bir hattin)
async function loadKapaliGunler(lineId = 'ofis') {
  if (!aktif) return [];
  try {
    const r = await pool.query('SELECT * FROM kapali_gunler WHERE line_id=$1 ORDER BY tarih DESC LIMIT 60', [lineId]);
    return r.rows;
  } catch (e) { return []; }
}

// ============================================================
// TUM VERIYI SIL (panel "Tum verileri sil" butonu)
// ============================================================
// TUM SOHBET/MESAJ verisini sil (panel "Tum verileri sil"). KULLANICILAR korunur.
async function wipeAll() {
  if (!aktif) return;
  await q('TRUNCATE messages, chats, contacts, settings RESTART IDENTITY');
  // users tablosuna DOKUNMA - giris bilgileri kalmali
}

// SADECE GRUPLARI sil (kayitli kisileri ve contacts'i KORU).
// Temiz baslangic icin: gruplar + grup mesajlari + gruba bagli etiket/atama silinir,
// ama bire-bir kisi sohbetleri (is_group=false) ve kayitli kisiler (contacts) kalir.
async function wipeGroups(lineId = null) {
  if (!aktif) return;
  // 1) Once silinecek grup jid'lerini bul (bu hatta ait, grup olanlar)
  const kosul = lineId ? 'WHERE is_group=true AND line_id=$1' : 'WHERE is_group=true';
  const params = lineId ? [lineId] : [];
  const gruplar = await pool.query(`SELECT jid, line_id FROM chats ${kosul}`, params);
  // 2) Bu gruplara ait mesajlari sil
  for (const g of gruplar.rows) {
    await q('DELETE FROM messages WHERE jid=$1 AND line_id=$2', [g.jid, g.line_id]);
    // gruba bagli etiket baglantilari ve atamalar (tablolar varsa)
    try { await q('DELETE FROM chat_labels WHERE chat_jid=$1 AND line_id=$2', [g.jid, g.line_id]); } catch (e) {}
    try { await q('DELETE FROM chat_assignments WHERE chat_jid=$1 AND line_id=$2', [g.jid, g.line_id]); } catch (e) {}
  }
  // 3) Grup sohbetlerini sil (kisiler kalir)
  await q(`DELETE FROM chats ${kosul}`, params);
  // contacts ve users tablosuna DOKUNMA
}

// ============================================================
// KULLANICILAR (users) — giris sistemi
// ============================================================
// Ilk yoneticiyi olustur (yoksa). Burak Pekcan.
async function ensureAdmin(username, password, displayName) {
  if (!aktif) return;
  try {
    // hic kullanici var mi?
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM users');
    if (r.rows[0].n === 0) {
      await pool.query(
        `INSERT INTO users (username, password, display_name, role) VALUES ($1,$2,$3,'admin')`,
        [username, password, displayName || username]
      );
      console.log(`👑 Ilk yonetici olusturuldu: ${username}`);
    }
  } catch (e) { console.error('⚠️  ensureAdmin hatasi:', e.message); }
}

// Giris kontrolu: kullanici adi + sifre dogru mu?
async function checkLogin(username, password) {
  if (!aktif) return null;
  try {
    const r = await pool.query(
      'SELECT id, username, display_name, role FROM users WHERE username=$1 AND password=$2',
      [username, password]
    );
    return r.rows[0] || null;
  } catch (e) { console.error('⚠️  checkLogin hatasi:', e.message); return null; }
}

// Yeni kullanici ekle (yonetici yapar)
async function addUser(username, password, displayName, role) {
  if (!aktif) return { ok: false, error: 'Veritabani kapali' };
  try {
    await pool.query(
      `INSERT INTO users (username, password, display_name, role) VALUES ($1,$2,$3,$4)`,
      [username, password, displayName || username, role || 'agent']
    );
    return { ok: true };
  } catch (e) {
    if ((e.message || '').includes('duplicate') || e.code === '23505') {
      return { ok: false, error: 'Bu kullanıcı adı zaten var' };
    }
    return { ok: false, error: e.message };
  }
}

// Tum kullanicilari listele (yonetici paneli icin - sifresiz)
async function listUsers() {
  if (!aktif) return [];
  try {
    // kullanici tipini (ofis/pazarlama) de getir — kullanici_hatlari ile birlestir.
    // Eslesme yoksa varsayilan 'ofis'.
    const r = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.role, u.created_at,
             COALESCE(kh.tip, 'ofis') AS tip,
             COALESCE(kh.line_id, 'ofis') AS line_id
      FROM users u
      LEFT JOIN kullanici_hatlari kh ON kh.username = u.username
      ORDER BY u.created_at`);
    return r.rows;
  } catch (e) {
    // kullanici_hatlari tablosu henuz yoksa eski sekilde dondur (geriye uyumlu)
    try {
      const r2 = await pool.query('SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at');
      return r2.rows.map(u => ({ ...u, tip: 'ofis', line_id: 'ofis' }));
    } catch (e2) { return []; }
  }
}

// ============================================================
// IC MESAJLAR (internal_messages) — ekip uyeleri arasi birebir
// WhatsApp'tan BAGIMSIZ; sadece panel kullanicilari arasinda.
// Tablo: internal_messages (id, from_user, to_user, text, ts, read_at, created_at)
// from_user / to_user = users.username (giris adi, benzersiz)
// ============================================================

// Iki kullanici icin "konusma anahtari" — sirali, boylece A-B ve B-A ayni cifti gosterir
function _convKey(a, b) {
  return [a, b].sort().join('::');
}

// Yeni ic mesaj kaydet
async function saveInternalMessage(m) {
  if (!aktif) return { ok: false, error: 'DB bagli degil' };
  try {
    // Once dosya sutunlari (media_url, file_name, kind) DAHIL kaydetmeyi dene.
    const r = await pool.query(
      `INSERT INTO internal_messages (id, conv_key, from_user, to_user, text, media_url, file_name, kind, ts, read_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL, now())
       RETURNING id, conv_key, from_user, to_user, text, media_url, file_name, kind, ts, read_at`,
      [m.id, _convKey(m.from, m.to), m.from, m.to, m.text || '', m.mediaUrl || null, m.fileName || null, m.kind || 'text', m.ts || Date.now()]
    );
    return { ok: true, row: r.rows[0] };
  } catch (e) {
    // Dosya sutunlari HENUZ eklenmediyse: dosyasiz (sadece text) kaydet ki mesaj kaybolmasin.
    try {
      const r2 = await pool.query(
        `INSERT INTO internal_messages (id, conv_key, from_user, to_user, text, ts, read_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,NULL, now())
         RETURNING id, conv_key, from_user, to_user, text, ts, read_at`,
        [m.id, _convKey(m.from, m.to), m.from, m.to, m.text || '', m.ts || Date.now()]
      );
      return { ok: true, row: r2.rows[0] };
    } catch (e2) {
      return { ok: false, error: e2.message, _hata: true };
    }
  }
}

// Iki kullanici arasindaki konusmayi getir (son N mesaj, eskiden yeniye)
async function loadInternalConversation(userA, userB, limit = 200) {
  if (!aktif) return [];
  // KRİTİK: conv_key yerine from_user/to_user KOLONLARINDAN çek. Liste (listInternalConversations)
  // da böyle yapıyor -> ikisi TUTARLI olur. Eski mesajlarda conv_key yanlış/boş kaydedilmişse
  // (liste mesajı gösterip sohbet açınca gelmemesinin sebebi buydu) yine de bulunur.
  try {
    const r = await pool.query(
      `SELECT id, from_user, to_user, text, media_url, file_name, kind, ts, read_at
         FROM internal_messages
        WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
        ORDER BY ts ASC
        LIMIT $3`,
      [userA, userB, limit]
    );
    return r.rows;
  } catch (e) {
    // dosya sutunlari yoksa (eski tablo): dosyasiz cek
    try {
      const r2 = await pool.query(
        `SELECT id, from_user, to_user, text, ts, read_at
           FROM internal_messages
          WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
          ORDER BY ts ASC
          LIMIT $3`,
        [userA, userB, limit]
      );
      return r2.rows;
    } catch (e2) { return []; }
  }
}

// Bir kullanicinin TUM konusma ozetleri: kiminle, son mesaj, okunmamis sayisi
// (Ic Mesajlar listesini doldurmak icin)
async function listInternalConversations(username) {
  if (!aktif) return [];
  try {
    // KISIYE OZEL GIZLEME: kullanici bir sohbeti "benden gizle" yaptiysa, o sohbet
    // gizleme zamanindan sonra YENI mesaj gelene kadar listede gorunmez (WhatsApp gibi).
    // Gizleme bilgisi settings'te: key='im_gizli_<username>' -> { other_user: gizlemeTs }
    let gizliler = {};
    try {
      const g = await getSetting('im_gizli_' + username, null);
      if (g && typeof g === 'object') gizliler = g;
    } catch (_) {}
    // Bu kullanicinin dahil oldugu tum mesajlar; karsi tarafa gore grupla
    const r = await pool.query(
      `SELECT
         CASE WHEN from_user = $1 THEN to_user ELSE from_user END AS other_user,
         MAX(ts) AS last_ts,
         (ARRAY_AGG(text ORDER BY ts DESC))[1] AS last_text,
         (ARRAY_AGG(from_user ORDER BY ts DESC))[1] AS last_from,
         COUNT(*) FILTER (WHERE to_user = $1 AND read_at IS NULL) AS unread
       FROM internal_messages
       WHERE from_user = $1 OR to_user = $1
       GROUP BY other_user
       ORDER BY last_ts DESC`,
      [username]
    );
    // gizlenenleri ele: gizleme zamanindan SONRA mesaj yoksa listeden cikar
    const liste = r.rows.filter(row => {
      const gizlemeTs = gizliler[row.other_user];
      if (!gizlemeTs) return true; // gizli degil -> goster
      // gizlemeden sonra yeni mesaj geldiyse tekrar goster, yoksa gizle
      return Number(row.last_ts) > Number(gizlemeTs);
    });
    return liste;
  } catch (e) { return []; }
}

// Bir ic mesaj sohbetini KISIYE OZEL gizle (karsi taraf etkilenmez).
// gizleme zamanini kaydeder; o ana kadarki mesajlar bu kullanicidan gizlenir.
async function hideInternalConversation(username, other) {
  if (!aktif) return { ok: false };
  try {
    let gizliler = {};
    try { const g = await getSetting('im_gizli_' + username, null); if (g && typeof g === 'object') gizliler = g; } catch (_) {}
    gizliler[other] = Date.now(); // su anki zaman -> bu ana kadarki her sey gizli
    await saveSetting('im_gizli_' + username, gizliler);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Bir konusmayi okundu isaretle (karsi taraftan gelen okunmamislar)
async function markInternalRead(reader, other) {
  if (!aktif) return { ok: false };
  try {
    // conv_key yerine kolonlardan (yükleme/liste ile tutarlı) -> bozuk conv_key'de de çalışır
    await pool.query(
      `UPDATE internal_messages SET read_at = now()
        WHERE from_user = $1 AND to_user = $2 AND read_at IS NULL`,
      [other, reader]
    );
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Bir kullanicinin TOPLAM okunmamis ic mesaj sayisi (sekme rozeti icin)
async function internalUnreadCount(username) {
  if (!aktif) return 0;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM internal_messages WHERE to_user = $1 AND read_at IS NULL`,
      [username]
    );
    return r.rows[0]?.n || 0;
  } catch (e) { return 0; }
}

// Ic mesaj SIL — sadece KENDI mesajini silebilir (from_user kontrolu cagiran tarafta).
// "deleted" kolonu varsa onu true yapar (mesaj "silindi" gorunur); yoksa satiri komple siler.
// IC SOHBETI KALICI SIL: iki kisi arasindaki TUM mesajlar DB'den TAMAMEN silinir
// (IKI TARAFTAN da gider). Yeni mesaj gelse bile eski mesajlar ASLA geri gelmez.
// Grup sohbeti (GRUP_CONV_KEY) bu fonksiyonla SILINEMEZ (server tarafinda da engelli).
async function deleteInternalConversation(userA, userB) {
  if (!aktif) return { ok: false };
  try {
    // kolonlardan sil (conv_key bozuksa bile iki taraf arasındaki HER mesajı siler)
    const r = await pool.query(
      `DELETE FROM internal_messages
        WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)`,
      [userA, userB]
    );
    return { ok: true, silinen: r.rowCount };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function deleteInternalMessage(id, requester) {
  if (!aktif) return { ok: false };
  // KALICI SILME (kullanici istegi): kisi sohbetlerinde mesaj DB'den TAMAMEN silinir.
  // "Bu mesaj silindi" izi kalmaz, sohbet yeniden yuklenince geri dusmez.
  try {
    const r = await pool.query(
      `DELETE FROM internal_messages WHERE id = $1 AND from_user = $2 RETURNING id`,
      [id, requester]
    );
    return { ok: r.rowCount > 0, hardDelete: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Ic mesaj DUZENLE — sadece kendi mesajini, sadece METIN. "edited" kolonu varsa isaretler.
async function editInternalMessage(id, requester, yeniMetin) {
  if (!aktif) return { ok: false };
  try {
    const r = await pool.query(
      `UPDATE internal_messages SET text = $3, edited = true
        WHERE id = $1 AND from_user = $2 AND (deleted IS NULL OR deleted = false) RETURNING id`,
      [id, requester, yeniMetin]
    );
    return { ok: r.rowCount > 0 };
  } catch (e) {
    // edited kolonu yoksa: sadece text guncelle
    try {
      const r2 = await pool.query(
        `UPDATE internal_messages SET text = $3 WHERE id = $1 AND from_user = $2 RETURNING id`,
        [id, requester, yeniMetin]
      );
      return { ok: r2.rowCount > 0 };
    } catch (e2) { return { ok: false, error: e2.message }; }
  }
}

// ============================================================
// GRUP SOHBETI: "2 AYLIK SIGORTA MERKEZI" (herkesin ortak grubu)
// internal_messages tablosunu kullanir ama conv_key SABIT: GRUP_CONV_KEY.
// to_user = '*' (herkes). Boylece tum ekip ayni akisi gorur.
// ============================================================
const GRUP_CONV_KEY = '__grup__2aylik_sigorta';

// Gruba mesaj kaydet (text veya dosya)
async function saveGroupMessage(m) {
  if (!aktif) return { ok: false, error: 'DB bagli degil' };
  try {
    const r = await pool.query(
      `INSERT INTO internal_messages (id, conv_key, from_user, to_user, text, media_url, file_name, kind, ts, read_at, created_at)
       VALUES ($1,$2,$3,'*',$4,$5,$6,$7,$8,NULL, now())
       RETURNING id, conv_key, from_user, to_user, text, media_url, file_name, kind, ts`,
      [m.id, GRUP_CONV_KEY, m.from, m.text || '', m.mediaUrl || null, m.fileName || null, m.kind || 'text', m.ts || Date.now()]
    );
    return { ok: true, row: r.rows[0] };
  } catch (e) {
    // dosya kolonlari yoksa: sadece text
    try {
      const r2 = await pool.query(
        `INSERT INTO internal_messages (id, conv_key, from_user, to_user, text, ts, read_at, created_at)
         VALUES ($1,$2,$3,'*',$4,$5,NULL, now())
         RETURNING id, conv_key, from_user, to_user, text, ts`,
        [m.id, GRUP_CONV_KEY, m.from, m.text || '', m.ts || Date.now()]
      );
      return { ok: true, row: r2.rows[0] };
    } catch (e2) { return { ok: false, error: e2.message }; }
  }
}

// Grup mesajlarini getir (son N, eskiden yeniye)
async function loadGroupMessages(limit = 300) {
  if (!aktif) return [];
  try {
    const r = await pool.query(
      `SELECT id, from_user, text, media_url, file_name, kind, ts, deleted, edited
         FROM internal_messages WHERE conv_key = $1 ORDER BY ts ASC LIMIT $2`,
      [GRUP_CONV_KEY, limit]
    );
    return r.rows;
  } catch (e) {
    try {
      const r2 = await pool.query(
        `SELECT id, from_user, text, ts FROM internal_messages WHERE conv_key = $1 ORDER BY ts ASC LIMIT $2`,
        [GRUP_CONV_KEY, limit]
      );
      return r2.rows;
    } catch (e2) { return []; }
  }
}

// Grup mesaji sil (sadece kendi mesajini)
async function deleteGroupMessage(id, requester) {
  if (!aktif) return { ok: false };
  try {
    const r = await pool.query(
      `UPDATE internal_messages SET deleted = true, text = '', media_url = NULL
        WHERE id = $1 AND from_user = $2 AND conv_key = $3 RETURNING id`,
      [id, requester, GRUP_CONV_KEY]
    );
    return { ok: r.rowCount > 0 };
  } catch (e) {
    try {
      const r2 = await pool.query(
        `DELETE FROM internal_messages WHERE id = $1 AND from_user = $2 AND conv_key = $3 RETURNING id`,
        [id, requester, GRUP_CONV_KEY]
      );
      return { ok: r2.rowCount > 0, hardDelete: true };
    } catch (e2) { return { ok: false, error: e2.message }; }
  }
}

// Grup mesaji duzenle (sadece kendi mesajini)
async function editGroupMessage(id, requester, yeniMetin) {
  if (!aktif) return { ok: false };
  try {
    const r = await pool.query(
      `UPDATE internal_messages SET text = $3, edited = true
        WHERE id = $1 AND from_user = $2 AND conv_key = $4 AND (deleted IS NULL OR deleted = false) RETURNING id`,
      [id, requester, yeniMetin, GRUP_CONV_KEY]
    );
    return { ok: r.rowCount > 0 };
  } catch (e) {
    try {
      const r2 = await pool.query(
        `UPDATE internal_messages SET text = $3 WHERE id = $1 AND from_user = $2 AND conv_key = $4 RETURNING id`,
        [id, requester, yeniMetin, GRUP_CONV_KEY]
      );
      return { ok: r2.rowCount > 0 };
    } catch (e2) { return { ok: false, error: e2.message }; }
  }
}

// ============================================================
// ANKET / OYLAMA (polls tablosu + poll_votes)
// ============================================================
// Yeni anket olustur
async function createPoll(p) {
  if (!aktif) return { ok: false, error: 'DB bagli degil' };
  try {
    const r = await pool.query(
      `INSERT INTO polls (id, creator, soru, secenekler, tip, ts, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING *`,
      [p.id, p.creator, p.soru, JSON.stringify(p.secenekler), p.tip || 'anket', p.ts || Date.now()]
    );
    return { ok: true, row: r.rows[0] };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Ankete oy ver (kullanici basina 1 oy; tekrar oy degistirebilir)
async function votePoll(pollId, voter, secenekIndex) {
  if (!aktif) return { ok: false };
  try {
    await pool.query(
      `INSERT INTO poll_votes (poll_id, voter, secenek, ts)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (poll_id, voter) DO UPDATE SET secenek = EXCLUDED.secenek, ts = now()`,
      [pollId, voter, secenekIndex]
    );
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Anket sonuclarini getir (her secenek icin oy sayisi + kim oy verdi)
async function getPollResults(pollId) {
  if (!aktif) return null;
  try {
    const p = await pool.query('SELECT * FROM polls WHERE id = $1', [pollId]);
    if (!p.rows.length) return null;
    const v = await pool.query('SELECT voter, secenek FROM poll_votes WHERE poll_id = $1', [pollId]);
    return { poll: p.rows[0], votes: v.rows };
  } catch (e) { return null; }
}

// Birden cok anketin sonuclarini toplu getir (grup yuklenince)
async function getPollsResults(pollIds) {
  if (!aktif || !pollIds || !pollIds.length) return {};
  try {
    const v = await pool.query('SELECT poll_id, voter, secenek FROM poll_votes WHERE poll_id = ANY($1)', [pollIds]);
    const out = {};
    for (const row of v.rows) {
      if (!out[row.poll_id]) out[row.poll_id] = [];
      out[row.poll_id].push({ voter: row.voter, secenek: row.secenek });
    }
    return out;
  } catch (e) { return {}; }
}

// Kullanici sil
async function deleteUser(id) {
  if (!aktif) return { ok: false };
  try { await pool.query('DELETE FROM users WHERE id=$1', [id]); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Kullanicinin rolunu degistir (yonetici yap / geri al)
async function setUserRole(id, role) {
  if (!aktif) return { ok: false };
  try { await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, id]); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Kullanicinin GORUNEN ADINI, GIRIS ADINI ve/veya SIFRESINI guncelle (yonetici).
// Sadece verilen alanlar degisir (bos birakilanlara dokunulmaz).
// Donus: { ok, error?, username? } — username degistiyse yeni adi doner (oturum/hat eslemesi icin).
async function updateUser(id, { displayName, username, password } = {}) {
  if (!aktif) return { ok: false, error: 'Veritabanı kapalı' };
  try {
    // once mevcut kullaniciyi al (eski giris adini bilmek icin — hat eslemesi guncellenecek)
    const mevcut = await pool.query('SELECT username FROM users WHERE id=$1', [id]);
    if (!mevcut.rows.length) return { ok: false, error: 'Kullanıcı bulunamadı' };
    const eskiUsername = mevcut.rows[0].username;

    const setler = [];
    const params = [];
    let i = 1;
    if (displayName !== undefined && displayName !== null && String(displayName).trim()) {
      setler.push(`display_name=$${i++}`); params.push(String(displayName).trim());
    }
    let yeniUsername = null;
    if (username !== undefined && username !== null && String(username).trim() && String(username).trim() !== eskiUsername) {
      yeniUsername = String(username).trim();
      setler.push(`username=$${i++}`); params.push(yeniUsername);
    }
    if (password !== undefined && password !== null && String(password).length) {
      setler.push(`password=$${i++}`); params.push(String(password));
    }
    if (!setler.length) return { ok: false, error: 'Değiştirilecek bir şey yok' };
    params.push(id);
    await pool.query(`UPDATE users SET ${setler.join(', ')} WHERE id=$${i}`, params);

    // GIRIS ADI degistiyse: kullanici_hatlari ve sessions tablolarindaki eslemeyi de guncelle
    // (yoksa kullanici eski adiyla hatta bagli kalir / oturumu kopar).
    if (yeniUsername) {
      try { await pool.query('UPDATE kullanici_hatlari SET username=$1 WHERE username=$2', [yeniUsername, eskiUsername]); } catch (e) {}
      try { await pool.query('UPDATE sessions SET username=$1 WHERE username=$2', [yeniUsername, eskiUsername]); } catch (e) {}
    }
    return { ok: true, username: yeniUsername || eskiUsername, eskiUsername };
  } catch (e) {
    if ((e.message || '').includes('duplicate') || e.code === '23505') {
      return { ok: false, error: 'Bu kullanıcı adı zaten var' };
    }
    return { ok: false, error: e.message };
  }
}

// ============================================================
// OTURUMLAR (sessions) — token'lar Supabase'de saklanir
// Boylece sunucu yeniden baslayinca kimse "yetki yok" almaz / atilmaz.
// Tablo: sessions (token, username, display_name, role, created_at)
// ============================================================

// Yeni oturum kaydet (giris yapilinca)
async function saveSession(token, username, displayName, role) {
  if (!aktif) return;
  try {
    await pool.query(
      `INSERT INTO sessions (token, username, display_name, role, created_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (token) DO UPDATE SET display_name=EXCLUDED.display_name, role=EXCLUDED.role`,
      [token, username, displayName || '', role || 'agent']
    );
  } catch (e) { /* tablo yoksa sessizce gec — bellek yine calisir */ }
}

// Tum oturumlari yukle (acilista bellege doldurmak icin)
async function loadSessions() {
  if (!aktif) return [];
  try {
    const r = await pool.query('SELECT token, username, display_name, role FROM sessions');
    return r.rows;
  } catch (e) { return []; }
}

// Oturum sil (cikis yapilinca)
async function deleteSession(token) {
  if (!aktif) return;
  try { await pool.query('DELETE FROM sessions WHERE token=$1', [token]); }
  catch (e) {}
}

// Bir kullanicinin rolu degisince, onun acik oturumlarini da guncelle
async function updateSessionRole(username, role) {
  if (!aktif) return;
  try { await pool.query('UPDATE sessions SET role=$1 WHERE username=$2', [role, username]); }
  catch (e) {}
}

// Kullanıcının rolünü users tablosunda güncelle (admin/pzr_yonetici/agent)
async function updateUserRole(username, role) {
  if (!aktif) return { ok: false, error: 'DB kapalı' };
  try {
    await pool.query('UPDATE users SET role=$1 WHERE username=$2', [role, username]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// FOTO/MEDYA İŞARET ("yapıldı" tiki) — messages tablosunda isaretli sütununa yaz.
// Sütun yoksa sessizce geç (eski şema). Migration: ALTER TABLE messages ADD COLUMN isaretli boolean DEFAULT false;
async function setMesajIsaret(msgId, isaretli) {
  if (!aktif) return;
  try {
    await pool.query('UPDATE messages SET isaretli=$1 WHERE id=$2', [!!isaretli, msgId]);
  } catch (e) { /* sütun yoksa veya hata: yoksay */ }
}

// ============================================================
// GRUBA ATAMA (chat_assignments): hangi ekip uyesi hangi grupla ilgileniyor
// ============================================================
// Bir gruba kullanici ata (zaten varsa dokunma)
async function addAssignment(chatJid, username) {
  if (!aktif) return;
  try {
    await pool.query(
      `INSERT INTO chat_assignments (chat_jid, username, created_at) VALUES ($1,$2, now())
       ON CONFLICT (chat_jid, username) DO NOTHING`,
      [chatJid, username]
    );
  } catch (e) {}
}
// Bir gruptan kullaniciyi cikar
async function removeAssignment(chatJid, username) {
  if (!aktif) return;
  try { await pool.query('DELETE FROM chat_assignments WHERE chat_jid=$1 AND username=$2', [chatJid, username]); }
  catch (e) {}
}
// Tum atamalari yukle (acilista) -> { chatJid: [username, ...] }
async function loadAssignments() {
  if (!aktif) return {};
  try {
    const r = await pool.query('SELECT chat_jid, username FROM chat_assignments');
    const out = {};
    for (const row of r.rows) {
      if (!out[row.chat_jid]) out[row.chat_jid] = [];
      out[row.chat_jid].push(row.username);
    }
    return out;
  } catch (e) { return {}; }
}

// ============================================================
// ETIKETLER (labels): WhatsApp Business gibi renkli etiketler
// labels: etiket tanimlari (id, isim, renk)
// chat_labels: hangi grup hangi etikete bagli
// ============================================================
// Yeni etiket olustur
// ============================================================
// IZINLI IP'LER — panele sadece bu IP'lerden normal kullanici girebilir.
// (Yonetici her IP'den girer; bu liste sadece normal kullanicilari sinirlar.)
// ============================================================
async function addAllowedIp(ip, aciklama, kapsam = 'disari') {
  if (!aktif) return;
  try {
    await pool.query(
      `INSERT INTO izinli_ipler (ip, aciklama, kapsam, created_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (ip) DO UPDATE SET aciklama=$2, kapsam=$3`,
      [ip, aciklama || '', kapsam === 'ofis' ? 'ofis' : 'disari']
    );
  } catch (e) {
    // kapsam kolonu henuz yoksa (SQL calistirilmadi) eski sekilde ekle (geriye uyumlu)
    if (e.message && e.message.includes('kapsam')) {
      try {
        await pool.query(
          `INSERT INTO izinli_ipler (ip, aciklama, created_at) VALUES ($1,$2, now())
           ON CONFLICT (ip) DO UPDATE SET aciklama=$2`,
          [ip, aciklama || '']
        );
      } catch (e2) { console.error('addAllowedIp hata:', e2.message); }
    } else {
      console.error('addAllowedIp hata:', e.message);
    }
  }
}
async function removeAllowedIp(ip) {
  if (!aktif) return;
  try { await pool.query('DELETE FROM izinli_ipler WHERE ip=$1', [ip]); }
  catch (e) { console.error('removeAllowedIp hata:', e.message); }
}
// ============================================================
// KULLANICI -> HAT eslesmesi + HATLAR (cok-hesap sistemi)
// ============================================================
// Bir kullaniciyi bir hatta ata (ofis kullanicilari 'ofis', pazarlamacilar kendi hatti)
async function setUserLine(username, lineId, tip) {
  if (!aktif) return;
  try {
    await pool.query(
      `INSERT INTO kullanici_hatlari (username, line_id, tip, created_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (username) DO UPDATE SET line_id=$2, tip=$3`,
      [username, lineId, tip || 'ofis']
    );
  } catch (e) { console.error('setUserLine hata:', e.message); }
}
// Bir kullanicinin hattini getir (yoksa varsayilan 'ofis')
async function getUserLine(username) {
  if (!aktif) return { line_id: 'ofis', tip: 'ofis' };
  try {
    const r = await pool.query('SELECT line_id, tip FROM kullanici_hatlari WHERE username=$1', [username]);
    if (r.rows.length) return r.rows[0];
  } catch (e) {}
  return { line_id: 'ofis', tip: 'ofis' };
}
// Tum kullanici-hat eslesmelerini yukle
async function loadUserLines() {
  if (!aktif) return [];
  try {
    const r = await pool.query('SELECT username, line_id, tip FROM kullanici_hatlari');
    return r.rows;
  } catch (e) { return []; }
}
// Bir hat ekle/guncelle
async function saveLine(lineId, label, tip, owner) {
  if (!aktif) return;
  try {
    await pool.query(
      `INSERT INTO hatlar (line_id, label, tip, owner, created_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (line_id) DO UPDATE SET label=$2, tip=$3`,
      [lineId, label || '', tip || 'ofis', owner || '']
    );
  } catch (e) { console.error('saveLine hata:', e.message); }
}
// Tum hatlari yukle
async function loadLines() {
  if (!aktif) return [];
  try {
    const r = await pool.query('SELECT line_id, label, tip, owner FROM hatlar ORDER BY created_at ASC');
    return r.rows;
  } catch (e) { return []; }
}
// Bir hattin TUM verilerini sil (sohbetler + mesajlar). Pazarlamaci cikinca/hat silinince.
async function deleteLineData(lineId) {
  if (!aktif || lineId === 'ofis') return; // ofis hatti silinemez (guvenlik)
  try {
    await pool.query('DELETE FROM messages WHERE line_id=$1', [lineId]);
    await pool.query('DELETE FROM chats WHERE line_id=$1', [lineId]);
    console.log(`🗑️  '${lineId}' hattinin verileri silindi.`);
  } catch (e) { console.error('deleteLineData hata:', e.message); }
}

async function loadAllowedIps() {
  if (!aktif) return [];
  try {
    // once kapsam kolonuyla dene
    const r = await pool.query('SELECT ip, aciklama, kapsam FROM izinli_ipler ORDER BY created_at ASC');
    return r.rows.map(x => ({ ip: x.ip, aciklama: x.aciklama || '', kapsam: x.kapsam || 'disari' }));
  } catch (e) {
    // kapsam kolonu yoksa (SQL calistirilmadi) eski sekilde — hepsi 'disari' say
    try {
      const r = await pool.query('SELECT ip, aciklama FROM izinli_ipler ORDER BY created_at ASC');
      return r.rows.map(x => ({ ip: x.ip, aciklama: x.aciklama || '', kapsam: 'disari' }));
    } catch (e2) { return []; }
  }
}

async function addLabel(id, name, color) {
  if (!aktif) return;
  try {
    await pool.query(
      `INSERT INTO labels (id, name, color, created_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (id) DO UPDATE SET name=$2, color=$3`,
      [id, name, color]
    );
  } catch (e) {}
}
// Etiketi sil (ve ona bagli tum grup baglantilarini)
async function deleteLabel(id) {
  if (!aktif) return;
  try {
    await pool.query('DELETE FROM chat_labels WHERE label_id=$1', [id]);
    await pool.query('DELETE FROM labels WHERE id=$1', [id]);
  } catch (e) {}
}
// Tum etiketleri yukle -> [{id, name, color}] — sira_no varsa ona göre, yoksa created_at
async function loadLabels() {
  if (!aktif) return [];
  try {
    // sira_no kolonu varsa ona göre sırala (NULLS LAST), yoksa created_at'e düş
    const r = await pool.query(`SELECT id, name, color FROM labels ORDER BY COALESCE(sira_no, 999999) ASC, created_at ASC`);
    return r.rows.map(x => ({ id: x.id, name: x.name, color: x.color }));
  } catch (e) {
    // sira_no kolonu yoksa eski sorguya düş
    try {
      const r2 = await pool.query('SELECT id, name, color FROM labels ORDER BY created_at ASC');
      return r2.rows.map(x => ({ id: x.id, name: x.name, color: x.color }));
    } catch (e2) { return []; }
  }
}
// Etiket sırasını kaydet: [{id, sira}] -> her etiketin sira_no'sunu güncelle
async function etiketSiraKaydet(siralar) {
  if (!aktif) return { ok: false };
  try {
    for (const s of siralar) {
      await pool.query('UPDATE labels SET sira_no=$1 WHERE id=$2', [s.sira, s.id]);
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
// Bir gruba etiket ekle
async function addChatLabel(chatJid, labelId) {
  if (!aktif) return;
  try {
    await pool.query(
      `INSERT INTO chat_labels (chat_jid, label_id) VALUES ($1,$2)
       ON CONFLICT (chat_jid, label_id) DO NOTHING`,
      [chatJid, labelId]
    );
  } catch (e) {}
}
// Bir gruptan etiketi cikar
async function removeChatLabel(chatJid, labelId) {
  if (!aktif) return;
  try { await pool.query('DELETE FROM chat_labels WHERE chat_jid=$1 AND label_id=$2', [chatJid, labelId]); }
  catch (e) {}
}
// Tum grup-etiket baglantilarini yukle -> { chatJid: [labelId, ...] }
async function loadChatLabels() {
  if (!aktif) return {};
  try {
    const r = await pool.query('SELECT chat_jid, label_id FROM chat_labels');
    const out = {};
    for (const row of r.rows) {
      if (!out[row.chat_jid]) out[row.chat_jid] = [];
      out[row.chat_jid].push(row.label_id);
    }
    return out;
  } catch (e) { return {}; }
}

// ============================================================
// POLİÇE YÜKLEMELERİ (police_yuklemeler) — PERFORMANS RAPORU İÇİN
// Panelden SÜRÜKLENİP yüklenen her PDF (poliçe) burada loglanır.
// İletilen (forward) dosyalar BURAYA YAZILMAZ — sadece gerçek yüklemeler.
// "POS" içeren dosyalar da yazılmaz (server.js'te filtrelenir).
// Kim, ne zaman, hangi gruba, hangi branş — yönetici performans raporu için.
// ============================================================
async function savePoliceYukleme(p) {
  if (!aktif) return { ok: false };
  try {
    const r = await pool.query(
      `INSERT INTO police_yuklemeler (id, line_id, kullanici, kullanici_ad, chat_jid, chat_name, dosya_adi, brans, plaka, iki_aylik, ts, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [p.id, p.lineId || 'ofis', p.kullanici || '', p.kullaniciAd || '', p.chatJid || '', p.chatName || '',
       p.dosyaAdi || '', p.brans || '', p.plaka || '', !!p.ikiAylik, p.ts || Date.now()]
    );
    return { ok: true, yeni: r.rows.length > 0, row: r.rows[0] || null };
  } catch (e) {
    // tablo henuz yoksa sessizce gec (SQL calistirilmamis olabilir) — yukleme yine de calisir
    if (!(e.message || '').includes('police_yuklemeler')) console.error('savePoliceYukleme hatasi:', e.message);
    return { ok: false, error: e.message };
  }
}

// Belirli tarih aralığındaki TÜM poliçe yüklemelerini getir (yönetici raporu).
// kullaniciFiltre verilirse sadece o kişininkiler.
async function loadPoliceYuklemeler(baslangicTs = null, bitisTs = null, lineId = null) {
  if (!aktif) return [];
  try {
    let sql = 'SELECT * FROM police_yuklemeler WHERE 1=1';
    const params = [];
    if (baslangicTs !== null && bitisTs !== null) {
      params.push(baslangicTs, bitisTs);
      sql += ` AND ts >= $${params.length - 1} AND ts <= $${params.length}`;
    }
    if (lineId) { params.push(lineId); sql += ` AND line_id = $${params.length}`; }
    sql += ' ORDER BY ts DESC LIMIT 5000';
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (e) { return []; }
}

// ============================================================
// POS TEMİZLİĞİ: yanlışlıkla poliçe sayılmış POS formlarını (PSO/PS/PPOS...) bul & sil.
// posKontrol: server'dan gecen posMuFormu fonksiyonu (dosya adına bakar).
// ============================================================
async function posBenzeriPoliceler(posKontrol, lineId = null) {
  if (!aktif) return [];
  try {
    let sql = 'SELECT * FROM police_yuklemeler WHERE 1=1';
    const params = [];
    if (lineId) { params.push(lineId); sql += ` AND line_id = $${params.length}`; }
    sql += ' ORDER BY ts DESC LIMIT 20000';
    const r = await pool.query(sql, params);
    // POS-benzeri: dosya adı VEYA branş alanı POS yazımı içeriyorsa (yazım hatası ikisinde de olabilir)
    return r.rows.filter(row => posKontrol(row.dosya_adi || '') || posKontrol(row.brans || ''));
  } catch (e) { return []; }
}
async function posBenzeriSil(posKontrol, lineId = null) {
  const bulunan = await posBenzeriPoliceler(posKontrol, lineId);
  if (!bulunan.length) return { ok: true, silinen: 0, kayitlar: [] };
  const idler = bulunan.map(r => r.id);
  return policeIdSil(idler);
}
// Verilen id'lerdeki poliçe kayıtlarını sil (arayüzden seçilenler)
async function policeIdSil(idler) {
  if (!aktif) return { ok: false, error: 'DB kapalı' };
  if (!Array.isArray(idler) || !idler.length) return { ok: true, silinen: 0 };
  try {
    let silinen = 0;
    for (let i = 0; i < idler.length; i += 500) {
      const parca = idler.slice(i, i + 500);
      const r = await pool.query(`DELETE FROM police_yuklemeler WHERE id = ANY($1)`, [parca]);
      silinen += r.rowCount;
    }
    return { ok: true, silinen };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================
// AKTİVİTE MESAJLARI (aktivite_mesajlar) — "ilgileniyorum/kesiyorum" sayımı
// Gruplarda kesim/ilgilenme mesajı yazan kişiyi loglar (yanlış yazım dahil).
// Performans raporunda "kaç kesim mesajı" olarak gösterilir. Ayrı/yan veridir.
// ============================================================
async function saveAktivite(a) {
  if (!aktif) return { ok: false };
  try {
    const r = await pool.query(
      `INSERT INTO aktivite_mesajlar (id, line_id, kullanici, kullanici_ad, chat_jid, chat_name, tur, ham_mesaj, ts, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [a.id, a.lineId || 'ofis', a.kullanici || '', a.kullaniciAd || '', a.chatJid || '', a.chatName || '',
       a.tur || 'kesim', a.hamMesaj || '', a.ts || Date.now()]
    );
    return { ok: true, yeni: r.rows.length > 0 };
  } catch (e) {
    if (!(e.message || '').includes('aktivite_mesajlar')) console.error('saveAktivite hatasi:', e.message);
    return { ok: false, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════
// SONRADAN GELEN ÖDEMELER (muhasebe onayı bekleyen yüklemeler)
// Tablo: sonradan_odemeler (id, yukleyen_kullanici, yukleyen_ad, dosya_url, dosya_ad,
//        dosya_tip, not, durum, created_at)
// durum: 'bekliyor' | 'onaylandi'
// ════════════════════════════════════════════════════════════
async function odemeEkle(o) {
  if (!aktif) return { ok: false, error: 'DB kapalı' };
  // belgeler: [{url, ad, tip}] dizisi. İlk belge eski dosya_url/dosya_ad/dosya_tip alanlarına
  // da yazılır (geriye dönük uyumluluk + eski kayıtlarla aynı gösterim).
  const belgeler = Array.isArray(o.belgeler) && o.belgeler.length ? o.belgeler
    : (o.dosyaUrl ? [{ url: o.dosyaUrl, ad: o.dosyaAd || '', tip: o.dosyaTip || 'dosya' }] : []);
  const ilk = belgeler[0] || { url: '', ad: '', tip: 'dosya' };
  try {
    // Önce belgeler(jsonb) kolonuyla dene
    const r = await pool.query(
      `INSERT INTO sonradan_odemeler (id, yukleyen_kullanici, yukleyen_ad, dosya_url, dosya_ad, dosya_tip, not_metni, durum, belgeler, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'bekliyor',$8, now())
       RETURNING *`,
      [o.id, o.yukleyenKullanici || '', o.yukleyenAd || '', ilk.url, ilk.ad, ilk.tip, o.not || '', JSON.stringify(belgeler)]
    );
    return { ok: true, kayit: r.rows[0] };
  } catch (e) {
    // belgeler kolonu yoksa (42703) eski şemayla kaydet (ilk belge) — veri kaybolmasın
    if ((e.message || '').includes('belgeler') || e.code === '42703') {
      try {
        const r2 = await pool.query(
          `INSERT INTO sonradan_odemeler (id, yukleyen_kullanici, yukleyen_ad, dosya_url, dosya_ad, dosya_tip, not_metni, durum, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'bekliyor', now())
           RETURNING *`,
          [o.id, o.yukleyenKullanici || '', o.yukleyenAd || '', ilk.url, ilk.ad, ilk.tip, o.not || '']
        );
        return { ok: true, kayit: r2.rows[0], tekBelge: true };
      } catch (e2) { return { ok: false, error: e2.message }; }
    }
    return { ok: false, error: e.message };
  }
}
async function odemeleriListele() {
  if (!aktif) return [];
  try {
    // belgeler(jsonb) dahil çek; yoksa 42703 -> eski kolonlarla
    const r = await pool.query(
      `SELECT id, yukleyen_kullanici, yukleyen_ad, dosya_url, dosya_ad, dosya_tip, not_metni, durum, belgeler,
              EXTRACT(EPOCH FROM created_at)*1000 AS ts
       FROM sonradan_odemeler WHERE durum='bekliyor' ORDER BY created_at DESC`);
    return r.rows;
  } catch (e) {
    try {
      const r2 = await pool.query(
        `SELECT id, yukleyen_kullanici, yukleyen_ad, dosya_url, dosya_ad, dosya_tip, not_metni, durum,
                EXTRACT(EPOCH FROM created_at)*1000 AS ts
         FROM sonradan_odemeler WHERE durum='bekliyor' ORDER BY created_at DESC`);
      return r2.rows;
    } catch (e2) { return []; }
  }
}
async function odemeSil(id) {
  if (!aktif) return { ok: false };
  try {
    await pool.query('DELETE FROM sonradan_odemeler WHERE id=$1', [id]);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function odemeBul(id) {
  if (!aktif) return null;
  try {
    const r = await pool.query('SELECT * FROM sonradan_odemeler WHERE id=$1', [id]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}
async function odemeNotGuncelle(id, notMetni) {
  if (!aktif) return { ok: false };
  try {
    await pool.query('UPDATE sonradan_odemeler SET not_metni=$1 WHERE id=$2', [notMetni || '', id]);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function loadAktiviteler(baslangicTs = null, bitisTs = null, lineId = null) {
  if (!aktif) return [];
  try {
    let sql = 'SELECT * FROM aktivite_mesajlar WHERE 1=1';
    const params = [];
    if (baslangicTs !== null && bitisTs !== null) {
      params.push(baslangicTs, bitisTs);
      sql += ` AND ts >= $${params.length - 1} AND ts <= $${params.length}`;
    }
    if (lineId) { params.push(lineId); sql += ` AND line_id = $${params.length}`; }
    sql += ' ORDER BY ts DESC LIMIT 5000';
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (e) { return []; }
}

// Periyodik temizligi baslat: acilista bir kez + her 24 saatte bir calisir.
let _cleanupTimer = null;
function startCleanup() {
  if (_cleanupTimer) return;
  // acilista 1 dakika sonra ilk temizlik (sunucu otursun diye kisa gecikme)
  setTimeout(() => { cleanupOld(); }, 60 * 1000).unref?.();
  // sonra gunde bir
  _cleanupTimer = setInterval(() => { cleanupOld(); }, 24 * 60 * 60 * 1000);
  _cleanupTimer.unref?.();
}

module.exports = {
  init, test, isReady, startKeepAlive,
  saveChat, saveMessage, saveContact, saveSetting, getSetting,
  loadAll, loadMessages, deleteMessage, wipeAll, wipeGroups, searchMessages,
  cleanupOld, startCleanup,
  ensureAdmin, checkLogin, addUser, listUsers, deleteUser, setUserRole, updateUser,
  saveInternalMessage, loadInternalConversation, listInternalConversations,
  markInternalRead, internalUnreadCount,
  deleteInternalMessage, editInternalMessage, deleteInternalConversation,
  hideInternalConversation,
  saveGroupMessage, loadGroupMessages, deleteGroupMessage, editGroupMessage,
  createPoll, votePoll, getPollResults, getPollsResults,
  GRUP_CONV_KEY,
  getBuradayim, toggleBuradayim, clearBuradayim,
  saveSession, loadSessions, deleteSession, updateSessionRole, updateUserRole, setMesajIsaret,
  addAssignment, removeAssignment, loadAssignments,
  addLabel, deleteLabel, loadLabels, etiketSiraKaydet, addChatLabel, removeChatLabel, loadChatLabels,
  addAllowedIp, removeAllowedIp, loadAllowedIps,
  setUserLine, getUserLine, loadUserLines, saveLine, loadLines, deleteLineData,
  saveSatis, loadSatislar, loadTumSatislar, updateSatisAdet, setSatisOnay, deleteSatis, gunuKapat, loadKapaliGunler,
  savePoliceYukleme, loadPoliceYuklemeler, posBenzeriPoliceler, posBenzeriSil, policeIdSil, saveAktivite, loadAktiviteler,
  odemeEkle, odemeleriListele, odemeSil, odemeBul, odemeNotGuncelle,
};
