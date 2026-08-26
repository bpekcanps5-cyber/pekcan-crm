#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   GUVENILIRLIK TESHISI — pekcan-crm            (SALT OKUNUR)
   ---------------------------------------------------------------------
   Bu betik HICBIR SEY DEGISTIRMEZ. Ne siler, ne yazar, ne restart eder.
   Canli sistem calisirken calistirilir.

   AMAC: kodu okuyarak CEVAPLANAMAYAN sorulari, calisan sistemden
   kanita dayali olarak cevaplamak:
     1) Supabase'de mukerrer korumasi (unique constraint) GERCEKTEN var mi?
     2) Sorgular indeks kullaniyor mu, tablo mu tariyor?
     3) Ayni WhatsApp oturumu icin birden fazla surec calisiyor mu?
     4) Surec ne siklikta yeniden basliyor, sebebi ne?
     5) Baileys oturum klasoru sismis mi?
     6) Bellek sinirina takilip cokuyor mu?
     7) Web sunucusu ile WhatsApp ayni surecte mi?
     8) Mesaj guvence kuyrugunda takilmis kayit var mi?

   KULLANIM:  cd /root/pekcan-crm && node guvenilirlik-teshis.js
   ═══════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
try { require('dotenv').config(); } catch (_) {}

const C = { b:'\x1b[1m', k:'\x1b[31m', s:'\x1b[33m', y:'\x1b[32m', g:'\x1b[90m', x:'\x1b[0m' };
const baslik = (t) => console.log(`\n${C.b}══ ${t} ${'═'.repeat(Math.max(0, 60 - t.length))}${C.x}`);
const satir = (a, b, r) => console.log('  ' + String(a).padEnd(36) + (r||'') + b + C.x);
const iyi  = (t) => console.log(`  ${C.y}✔ ${t}${C.x}`);
const uya  = (t) => console.log(`  ${C.s}⚠ ${t}${C.x}`);
const kotu = (t) => console.log(`  ${C.k}✘ ${t}${C.x}`);
const mb = (b) => (b/1048576).toFixed(1) + ' MB';
const bulgu = [];

(async () => {
console.log(`${C.b}\n╔══════════════════════════════════════════════════════════════╗`);
console.log(`║  GUVENILIRLIK TESHISI  ${new Date().toLocaleString('tr-TR').padEnd(38)}║`);
console.log(`║  SALT OKUNUR — hicbir sey degistirilmez.                      ║`);
console.log(`╚══════════════════════════════════════════════════════════════╝${C.x}`);

// ── 1) SUREC: kac tane, ne siklikta restart ───────────────────────────
baslik('1) SUREC DURUMU');
let pekcanSayi = 0;
try {
  const liste = JSON.parse(execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' }));
  for (const p of liste) {
    const m = p.pm2_env || {};
    const bellek = (p.monit && p.monit.memory) || 0;
    const rs = m.restart_time || 0;
    const ayakta = m.pm_uptime ? Math.round((Date.now() - m.pm_uptime) / 60000) : 0;
    satir(p.name, `${m.status}  ${mb(bellek)}  restart:${rs}  ayakta:${ayakta}dk`);
    if (/pekcan/i.test(p.name)) {
      pekcanSayi++;
      if (m.exec_mode === 'cluster_mode' && (m.instances || 1) > 1) {
        kotu(`CLUSTER MODU ve ${m.instances} kopya — ayni WhatsApp oturumunu ${m.instances} surec kullaniyor!`);
        bulgu.push('KRITIK: pekcan cluster modunda birden fazla kopya calisiyor. Ayni oturuma coklu baglanti WhatsApp tarafindan cakisma sayilir ve kopma yapar. fork moduna alinmali.');
      }
      if (rs > 30) bulgu.push(`Surec ${rs} kez yeniden basladi. Her restart = baglanti kopmasi + o anda kuyruktakilerin riski.`);
      if (m.max_memory_restart) {
        satir('  bellek siniri', m.max_memory_restart);
        const sinir = parseInt(m.max_memory_restart) * (/G/i.test(m.max_memory_restart) ? 1024 : 1) * 1048576;
        if (bellek > sinir * 0.8) {
          kotu(`Bellek sinira yaklasti (${mb(bellek)} / ${m.max_memory_restart}) — OOM restart yakin`);
          bulgu.push('Bellek sinira yaklasiyor; pm2 sureci oldurup yeniden baslatiyor olabilir.');
        }
      } else {
        uya('max_memory_restart AYARLI DEGIL — bellek sizarsa surec sessizce buyur');
      }
    }
  }
  if (pekcanSayi > 1) {
    kotu(`${pekcanSayi} adet 'pekcan' sureci var — AYNI OTURUMA COKLU BAGLANTI`);
    bulgu.push(`KRITIK: ${pekcanSayi} adet pekcan sureci. Fazlalar silinmeli.`);
  } else if (pekcanSayi === 1) iyi('Tek pekcan sureci — coklu baglanti yok');
} catch (e) { uya('pm2 okunamadi: ' + e.message); }

// Ayni portu/oturumu tutan baska node var mi
try {
  const ps = execSync("ps -eo pid,etimes,rss,args 2>/dev/null | grep -i '[s]erver.js' || true", { encoding: 'utf8' }).trim();
  const n = ps ? ps.split('\n').length : 0;
  satir('server.js calistiran surec', String(n));
  if (n > 1) {
    kotu('Birden fazla server.js sureci — pm2 disinda elle baslatilmis olabilir');
    bulgu.push('KRITIK: birden fazla server.js sureci calisiyor.');
    console.log(C.g + ps.split('\n').map(l => '      ' + l.slice(0, 90)).join('\n') + C.x);
  }
} catch (_) {}

// ── 2) WEB + WHATSAPP AYNI SURECTE MI ─────────────────────────────────
baslik('2) MIMARI');
try {
  const s = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const express = /require\(['"]express['"]\)/.test(s);
  const baileys = /@whiskeysockets\/baileys/.test(s);
  if (express && baileys) {
    uya('Web sunucusu ile WhatsApp AYNI surecte');
    console.log(`  ${C.g}Panelde agir bir istek (rapor, PDF, OCR) event dongusunu bloklarsa`);
    console.log(`  WhatsApp da o sure boyunca sagir kalir. Kopmanin gizli sebeplerinden.${C.x}`);
    bulgu.push('Web ve WhatsApp ayni surecte — agir istek WhatsApp akisini durdurabilir.');
  }
  satir('kod satiri', String(s.split('\n').length));
  satir('sock.ev.on sayisi', String((s.match(/\.ev\.on\(/g) || []).length));
  satir('outbox var mi', /outbox|gidenKuyruk/i.test(s) ? 'VAR' : 'YOK', /outbox/i.test(s) ? C.y : C.k);
  if (!/outbox/i.test(s)) bulgu.push('GIDEN MESAJ KUYRUGU (outbox) YOK — baglanti kopukken gonderilen mesaj kaybolur.');
} catch (e) { uya('server.js okunamadi: ' + e.message); }

// ── 3) OTURUM KLASORU ─────────────────────────────────────────────────
baslik('3) BAILEYS OTURUMU');
for (const ad of ['auth', 'auth_info_baileys', 'auth_info']) {
  const yol = path.join(__dirname, ad);
  if (!fs.existsSync(yol)) continue;
  let toplamDosya = 0, toplamBoyut = 0;
  const gez = (p) => {
    for (const d of fs.readdirSync(p)) {
      const t = path.join(p, d);
      try {
        const st = fs.statSync(t);
        if (st.isDirectory()) gez(t);
        else { toplamDosya++; toplamBoyut += st.size; }
      } catch (_) {}
    }
  };
  try { gez(yol); } catch (_) {}
  satir(`${ad}/`, `${toplamDosya} dosya, ${mb(toplamBoyut)}`);
  if (toplamDosya > 3000) {
    kotu(`${toplamDosya} dosya COK FAZLA — Baileys her acilista bunlari okuyor`);
    bulgu.push(`Oturum klasorunde ${toplamDosya} dosya birikmis; baglanti yavasliyor ve kopmalara katki yapiyor.`);
  } else if (toplamDosya > 1500) uya(`${toplamDosya} dosya — takip edilmeli`);
  else iyi(`${toplamDosya} dosya — normal`);
  // creds.json yasi: oturum ne zamandir ayakta
  try {
    const c = fs.statSync(path.join(yol, 'ofis', 'creds.json'));
    satir('  creds.json son degisim', new Date(c.mtime).toLocaleString('tr-TR'));
  } catch (_) {
    try {
      const c = fs.statSync(path.join(yol, 'creds.json'));
      satir('  creds.json son degisim', new Date(c.mtime).toLocaleString('tr-TR'));
    } catch (_) {}
  }
}

// ── 4) MESAJ GUVENCE KUYRUGU ──────────────────────────────────────────
baslik('4) MESAJ GUVENCE KUYRUGU');
const gk = path.join(__dirname, 'guvence');
if (!fs.existsSync(gk)) uya('guvence/ klasoru yok — katman hic calismamis olabilir');
else {
  for (const [ad, dosya] of [['bekleyen', 'bekleyen.jsonl'], ['olu mektup', 'olu-mektup.jsonl']]) {
    const y = path.join(gk, dosya);
    if (!fs.existsSync(y)) { satir(ad, 'dosya yok'); continue; }
    const ham = fs.readFileSync(y, 'utf8');
    const satirlar = ham.split('\n').filter((x) => x.trim());
    if (dosya === 'bekleyen.jsonl') {
      // yazilmis olanlari dus, gercek bekleyen sayisini bul
      const acik = new Map();
      for (const l of satirlar) {
        let k; try { k = JSON.parse(l); } catch (_) { continue; }
        if (k.t === 'y' && k.id) acik.delete(k.id);
        else if (k.id && k.jid) acik.set(k.id, k);
      }
      satir(ad, `${acik.size} mesaj bekliyor  (gunluk ${mb(ham.length)})`);
      if (acik.size > 50) {
        kotu(`${acik.size} mesaj veritabanina YAZILAMAMIS`);
        bulgu.push(`Guvence kuyrugunda ${acik.size} mesaj bekliyor — veritabani yazimi tikaniyor.`);
      } else if (acik.size) uya(`${acik.size} mesaj bekliyor`);
      else iyi('bekleyen yok');
      // en eskisi ne kadar bekliyor
      let enEski = 0;
      for (const k of acik.values()) if (k.eklendi && (Date.now() - k.eklendi) > enEski) enEski = Date.now() - k.eklendi;
      if (enEski > 300000) {
        kotu(`en eski bekleyen ${Math.round(enEski / 60000)} dakikadir yazilamiyor`);
        bulgu.push('Guvence kuyrugunda TAKILMIS kayit var (5 dakikadan uzun).');
      }
    } else {
      satir(ad, `${satirlar.length} KALICI KAYIP mesaj`);
      if (satirlar.length) {
        kotu(`${satirlar.length} mesaj hic kaydedilemedi (olu mektup)`);
        bulgu.push(`${satirlar.length} mesaj kalici olarak kaybedilmis — olu-mektup.jsonl incelenmeli.`);
      }
    }
  }
}

// ── 5) VERITABANI: MUKERRER KORUMASI VE INDEKSLER ─────────────────────
baslik('5) VERITABANI BUTUNLUGU');
const url = process.env.DATABASE_URL;
if (!url) { kotu('DATABASE_URL yok — veritabani bolumu atlandi'); return son(); }
let pool;
try {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
} catch (e) { kotu('pg yuklenemedi: ' + e.message); return son(); }

try {
  // A) messages tablosunda BENZERSIZ kisit var mi? (mukerrer korumasinin temeli)
  const kis = await pool.query(`
    SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) AS tanim
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'messages' AND c.contype IN ('p','u')`);
  if (!kis.rows.length) {
    kotu('messages tablosunda BENZERSIZ KISIT YOK');
    console.log(`  ${C.g}Kodda "ON CONFLICT (line_id, chat_jid, id)" yaziyor. Bu kisit YOKSA`);
    console.log(`  sorgu HATA verir ve mesaj HIC KAYDEDILMEZ. Mesaj kaybinin en olasi sebebi.${C.x}`);
    bulgu.push('KRITIK: messages tablosunda (line_id, chat_jid, id) benzersiz kisiti YOK. Kod ON CONFLICT kullaniyor; kisit olmadan bu sorgu basarisiz olur ve mesaj kaydedilmez.');
  } else {
    for (const r of kis.rows) satir(r.conname, r.tanim);
    const dogru = kis.rows.some((r) => /line_id/.test(r.tanim) && /chat_jid/.test(r.tanim) && /\bid\b/.test(r.tanim));
    if (dogru) iyi('ON CONFLICT hedefi mevcut — mukerrer korumasi CALISIYOR');
    else {
      kotu('Kisit var ama (line_id, chat_jid, id) uclusuyle ESLESMIYOR');
      bulgu.push('KRITIK: benzersiz kisit var fakat kodun ON CONFLICT hedefiyle ayni degil.');
    }
  }

  // B) Indeksler
  const idx = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='messages'`);
  satir('messages indeks sayisi', String(idx.rows.length), idx.rows.length ? '' : C.k);
  for (const r of idx.rows) console.log(`    ${C.g}· ${r.indexname}${C.x}`);

  // C) Tablo taramasi mi indeks mi
  const st = await pool.query(`
    SELECT relname, n_live_tup, seq_scan, idx_scan, n_dead_tup,
           pg_total_relation_size(relid) AS boyut
    FROM pg_stat_user_tables WHERE relname IN ('messages','chats') ORDER BY relname`);
  for (const r of st.rows) {
    const seq = Number(r.seq_scan) || 0, ix = Number(r.idx_scan) || 0;
    const oran = (seq + ix) ? Math.round(seq * 100 / (seq + ix)) : 0;
    satir(r.relname, `${Number(r.n_live_tup).toLocaleString('tr-TR')} satir, ${mb(Number(r.boyut))}, %${oran} tablo taramasi`);
    if (oran > 50 && seq > 5000) {
      kotu(`${r.relname}: sorgular tabloyu bastan sona tariyor — indeks eksik`);
      bulgu.push(`"${r.relname}" tablosunda %${oran} tablo taramasi. Yavas sorgu -> yazma tikanmasi -> mesaj kaybi.`);
    }
    if (Number(r.n_dead_tup) > 100000) uya(`${r.relname}: ${Number(r.n_dead_tup).toLocaleString('tr-TR')} olu satir (VACUUM gerekli)`);
  }

  // D) GERCEK MUKERRER VAR MI (kanit)
  const dup = await pool.query(`
    SELECT count(*) AS n FROM (
      SELECT line_id, chat_jid, id FROM messages
      GROUP BY line_id, chat_jid, id HAVING count(*) > 1 LIMIT 500) t`);
  const dn = Number(dup.rows[0].n);
  satir('mukerrer mesaj (ayni id)', String(dn), dn ? C.k : C.y);
  if (dn) bulgu.push(`Veritabaninda ${dn}+ mukerrer mesaj var — benzersiz kisit calismiyor.`);
  else iyi('Mukerrer mesaj yok');

  // E) SON AKIS: mesaj gercekten geliyor mu
  const akis = await pool.query(`
    SELECT max(ts) AS son, count(*) FILTER (WHERE ts > $1) AS son1s,
           count(*) FILTER (WHERE ts > $2) AS son24s FROM messages`,
    [Date.now() - 3600000, Date.now() - 86400000]);
  const a = akis.rows[0];
  if (a.son) {
    const dk = Math.round((Date.now() - Number(a.son)) / 60000);
    satir('son mesaj', `${dk} dakika once`, dk > 60 ? C.s : C.y);
    satir('son 1 saatte', String(a.son1s));
    satir('son 24 saatte', String(a.son24s));
    if (dk > 120 && Number(a.son24s) > 0) {
      kotu('2 saattir hic mesaj yok ama dun akis vardi — ZOMBI BAGLANTI olabilir');
      bulgu.push('2 saattir mesaj kaydedilmemis. Baglanti "acik" gorunup akisin durmasi (zombi baglanti) suphesi.');
    }
  }
  await pool.end();
} catch (e) {
  kotu('veritabani sorgusu basarisiz: ' + e.message);
  try { await pool.end(); } catch (_) {}
}

son();

function son() {
  baslik('SONUC');
  if (!bulgu.length) iyi('Bu kontrollerde belirgin bir sorun bulunamadi.');
  else bulgu.forEach((b, i) => console.log(`  ${C.s}${i + 1}.${C.x} ${b}`));
  console.log(`\n  ${C.g}Bu ciktiyi oldugu gibi paylas.${C.x}\n`);
}
})().catch((e) => { console.error('\nTeshis calistirilamadi: ' + e.message); process.exit(1); });
