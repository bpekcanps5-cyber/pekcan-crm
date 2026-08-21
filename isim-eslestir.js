#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   GRUP ADI ESLESTIRME  —  canlidan test hattina
   -------------------------------------------------------------------
   NEDEN BU ARAC VAR:
     Test hatti 'waha_' onekiyle SIFIRDAN basladi, yani grup adlari bos.
     WAHA'nin deposu ise gruplarin %64'unun adini vermiyor.
     AMA o adlarin hepsi ZATEN ELIMIZDE: canli sistem aylardir calisiyor
     ve ayni gruplarin adlarini Supabase'e yazmis. Grup kimlikleri
     (jid) iki tarafta da AYNI — cunku ayni WhatsApp gruplari.

     Dolayisiyla WAHA'dan dilenmeye gerek yok: canlidaki adlari test
     hattina kopyaliyoruz. Bu bir "hile" degil, gercek gecis senaryosu:
     WAHA'ya gercekten gecildiginde DB_HAT_ONEK kaldirilacak ve zaten
     ayni satirlar kullanilacak — yani adlar gunumuzde de yerinde olacak.
     Adsizlik sadece test hattinin bos baslamasindan kaynaklanan bir yan
     etki.

   GUVENLIK:
     - CANLI SATIRLAR SADECE OKUNUR. Tek bir canli kayit degismez.
     - Yazma islemi YALNIZCA test hattina (waha_ofis) yapilir.
     - Once ne yapacagini gosterir, onay ister. '--uygula' ile calisir.

   Kullanim:
       cd /root/waha-crm
       node isim-eslestir.js            # sadece RAPOR verir, yazmaz
       node isim-eslestir.js --uygula   # eslestirmeyi uygular
   ═══════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

function envOku() {
  const s = {};
  for (const d of ['.env', path.join(__dirname, '.env'), '/root/waha-crm/.env']) {
    try {
      for (const satir of fs.readFileSync(d, 'utf8').split('\n')) {
        const m = satir.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
        if (m && !s[m[1]]) s[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
      }
      break;
    } catch (_) {}
  }
  return s;
}
const E = envOku();
const BAGLANTI = process.env.DATABASE_URL || E.DATABASE_URL || process.env.SUPABASE_DB_URL || E.SUPABASE_DB_URL;
const ONEK = process.env.DB_HAT_ONEK || E.DB_HAT_ONEK || 'waha_';
const HAT = 'ofis';
const CANLI = HAT;              // canli satirlar:  line_id = 'ofis'
const TEST = ONEK + HAT;        // test satirlari:  line_id = 'waha_ofis'
const UYGULA = process.argv.includes('--uygula');

const yaz = (...a) => console.log(...a);
const cizgi = (b = '─') => yaz(b.repeat(66));

(async () => {
  if (!BAGLANTI) {
    yaz('HATA: .env icinde DATABASE_URL bulunamadi.');
    process.exit(1);
  }
  let Pool;
  try { ({ Pool } = require('pg')); }
  catch (_) { yaz('HATA: pg modulu yok. CRM klasorunde calistir (cd /root/waha-crm).'); process.exit(1); }

  const havuz = new Pool({
    connectionString: BAGLANTI,
    // Yerel/soket baglantida SSL kapali, Supabase'de acik
    ssl: /(^postgres(ql)?:\/\/[^@]*@\/)|localhost|127\.0\.0\.1/.test(BAGLANTI) ? false : { rejectUnauthorized: false },
    max: 4,
  });

  yaz('');
  cizgi('═');
  yaz('  GRUP ADI ESLESTIRME');
  yaz('  kaynak (SADECE OKUNUR): line_id = "' + CANLI + '"');
  yaz('  hedef  (yazilacak)    : line_id = "' + TEST + '"');
  yaz('  mod                   : ' + (UYGULA ? 'UYGULA' : 'sadece RAPOR (yazmaz)'));
  cizgi('═');

  try {
    // ── Durum ──
    const d = await havuz.query(
      `SELECT line_id,
              count(*) FILTER (WHERE is_group)                                    AS grup,
              count(*) FILTER (WHERE is_group AND name <> '' AND name !~ '^[0-9]') AS adli,
              count(*) FILTER (WHERE is_group AND (name = '' OR name ~ '^[0-9]'))  AS adsiz
         FROM chats WHERE line_id = ANY($1) GROUP BY line_id`,
      [[CANLI, TEST]]
    );
    yaz('\n[1] MEVCUT DURUM');
    for (const r of d.rows) {
      yaz('    ' + String(r.line_id).padEnd(12) + ' grup: ' + String(r.grup).padStart(6)
        + ' | adi olan: ' + String(r.adli).padStart(6) + ' | adi/sayi olan: ' + String(r.adsiz).padStart(6));
    }
    if (!d.rows.find((r) => r.line_id === CANLI)) {
      yaz('\n    HATA: canli hat ("' + CANLI + '") bulunamadi. DB_HAT_ONEK dogru mu?');
      await havuz.end(); process.exit(1);
    }

    // ── Eslesecekler ──
    const e = await havuz.query(
      `SELECT count(*) AS n FROM chats t
         JOIN chats c ON c.line_id = $1 AND c.jid = t.jid
        WHERE t.line_id = $2 AND t.is_group
          AND (t.name = '' OR t.name ~ '^[0-9]')
          AND c.name <> '' AND c.name !~ '^[0-9]'`,
      [CANLI, TEST]
    );
    const eslesen = Number(e.rows[0].n);

    // ── Testte olmayanlar (canlida var) ──
    const y = await havuz.query(
      `SELECT count(*) AS n FROM chats c
        WHERE c.line_id = $1 AND c.is_group AND c.name <> '' AND c.name !~ '^[0-9]'
          AND NOT EXISTS (SELECT 1 FROM chats t WHERE t.line_id = $2 AND t.jid = c.jid)`,
      [CANLI, TEST]
    );
    const yeni = Number(y.rows[0].n);

    yaz('\n[2] YAPILACAK');
    yaz('    adi duzelecek grup      : ' + eslesen);
    yaz('    listeye eklenecek grup  : ' + yeni + '   (canlida var, testte yok)');

    const ornek = await havuz.query(
      `SELECT t.jid, c.name FROM chats t
         JOIN chats c ON c.line_id = $1 AND c.jid = t.jid
        WHERE t.line_id = $2 AND t.is_group
          AND (t.name = '' OR t.name ~ '^[0-9]')
          AND c.name <> '' AND c.name !~ '^[0-9]' LIMIT 5`,
      [CANLI, TEST]
    );
    if (ornek.rows.length) {
      yaz('\n    ornekler:');
      for (const r of ornek.rows) yaz('      ' + r.jid.split('@')[0].padEnd(20) + ' ->  ' + r.name);
    }

    if (!UYGULA) {
      cizgi();
      yaz('  Hicbir sey yazilmadi. Uygulamak icin:');
      yaz('      node isim-eslestir.js --uygula');
      cizgi();
      return;
    }

    // ── UYGULA: 1) mevcut satirlarin adini/aciklamasini duzelt ──
    yaz('\n[3] UYGULANIYOR...');
    const g1 = await havuz.query(
      `UPDATE chats t
          SET name = c.name,
              description = CASE WHEN COALESCE(t.description,'') = '' THEN c.description ELSE t.description END,
              member_count = CASE WHEN COALESCE(t.member_count,0) = 0 THEN c.member_count ELSE t.member_count END,
              avatar = COALESCE(t.avatar, c.avatar),
              updated_at = now()
         FROM chats c
        WHERE c.line_id = $1 AND c.jid = t.jid
          AND t.line_id = $2 AND t.is_group
          AND (t.name = '' OR t.name ~ '^[0-9]')
          AND c.name <> '' AND c.name !~ '^[0-9]'`,
      [CANLI, TEST]
    );
    yaz('    adi duzeltilen  : ' + g1.rowCount);

    // ── 2) canlida olup testte olmayan gruplari ekle (mesajsiz, sadece kimlik) ──
    const g2 = await havuz.query(
      `INSERT INTO chats (line_id, jid, name, is_group, description, avatar, member_count,
                          members, unread, last_time, last_ts, pinned, archived, has_mention, updated_at)
       SELECT $2, c.jid, c.name, true, c.description, c.avatar, c.member_count,
              '[]'::text, 0, '', 0, false, false, false, now()
         FROM chats c
        WHERE c.line_id = $1 AND c.is_group AND c.name <> '' AND c.name !~ '^[0-9]'
          AND NOT EXISTS (SELECT 1 FROM chats t WHERE t.line_id = $2 AND t.jid = c.jid)
       ON CONFLICT (line_id, jid) DO NOTHING`,
      [CANLI, TEST]
    );
    yaz('    listeye eklenen : ' + g2.rowCount);

    const son = await havuz.query(
      `SELECT count(*) FILTER (WHERE is_group) AS grup,
              count(*) FILTER (WHERE is_group AND (name = '' OR name ~ '^[0-9]')) AS adsiz
         FROM chats WHERE line_id = $1`, [TEST]
    );
    yaz('\n[4] SONUC (test hatti)');
    yaz('    toplam grup : ' + son.rows[0].grup);
    yaz('    HALA ADSIZ  : ' + son.rows[0].adsiz);
    cizgi('═');
    yaz('  Simdi CRM yeniden baslatilmali:  pm2 restart wahacrm');
    cizgi('═');
    yaz('');
  } catch (e) {
    yaz('\nHATA: ' + e.message);
    process.exitCode = 1;
  } finally {
    await havuz.end();
  }
})();
