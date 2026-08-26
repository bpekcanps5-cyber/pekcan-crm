#!/usr/bin/env node
// ============================================================
// whapi-kur.js — server.js'e WHAPI kancalarini ekler
// ------------------------------------------------------------
// IKI yere dokunur, baska hicbir yere:
//   1) startWA() basina yonlendirme  -> whapi hatti Baileys'e HIC girmez
//   2) acilista whapi hattini baslatma + webhook ucunu kaydetme
//
// GUVENLI: once yedek alir, degisiklik yapamazsa DOKUNMAZ,
// sonunda soz dizimi kontrolu yapar, bozuksa YEDEGI GERI YUKLER.
// Iki kez calistirirsan ikinci kez hicbir sey yapmaz.
//
// Kullanim:  node whapi-kur.js
// Geri alma: node whapi-kur.js --geri
// ============================================================
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HEDEF = path.join(__dirname, 'server.js');
const YEDEK = path.join(__dirname, 'server.js.whapi-oncesi');

const ISARET = '/* ═══ WHAPI KANCASI ═══';

// ── 1) startWA yonlendirmesi ────────────────────────────────
const ARA_1 = "async function startWA(lineId = 'ofis') {\n";
const KOY_1 = `async function startWA(lineId = 'ofis') {
  ${ISARET} Bu hat Whapi ise Baileys yoluna HIC girme. */
  if (lineId === (process.env.WHAPI_LINE_ID || 'whapi')) {
    const _w = global._whapiKurulum;
    if (!_w) { console.log('[whapi] kurulum henuz hazir degil, atlandi'); return; }
    return _w.hattiBaslat().catch((e) => console.error('[whapi] baslatma hatasi:', e.message));
  }
  /* ═══ WHAPI KANCASI SONU ═══ */
`;

// ── 2) acilista baslatma ────────────────────────────────────
const ARA_2 = "  startWA(); // <-- veri yüklendikten SONRA\n";
const KOY_2 = `  ${ISARET} Whapi ikinci hat: webhook ucunu kaydet ve hatti ayaga kaldir.
     Baileys yolu bu bloktan ETKILENMEZ; hata olsa bile ofis hatti calisir. */
  try {
    const whapiHat = require('./whapi-hat');
    global._whapiKurulum = whapiHat.kur({
      addMessage, broadcastHat, hatChats, stripBirMesaj,
      lines, createLine, db, MEDIA_DIR,
      iletimDenetleTamam,
      kisiAdiBul: (jid) => savedContacts.get(jid) || contactNames.get(jid) || '',
      log: (...a) => console.log(...a),
    }, app, express);
    if (process.env.WHAPI_TOKEN) {
      global._whapiKurulum.hattiBaslat()
        .then(() => console.log('[whapi] ikinci hat hazir'))
        .catch((e) => console.error('[whapi] hat baslatilamadi:', e.message));
    } else {
      console.log('[whapi] WHAPI_TOKEN yok — ikinci hat KAPALI (ofis normal calisiyor)');
    }
  } catch (e) {
    console.error('[whapi] kurulum atlandi:', e.message);
  }
  /* ═══ WHAPI KANCASI SONU ═══ */

  startWA(); // <-- veri yüklendikten SONRA
`;

function geriAl() {
  if (!fs.existsSync(YEDEK)) { console.log('✗ yedek yok, geri alinamiyor'); process.exit(1); }
  fs.copyFileSync(YEDEK, HEDEF);
  console.log('✔ server.js yedekten geri yuklendi (Whapi kancalari kaldirildi)');
  console.log('  simdi: pm2 restart pekcan');
}

function sozDizimi(dosya) {
  try { execFileSync(process.execPath, ['--check', dosya], { stdio: 'pipe' }); return null; }
  catch (e) { return String(e.stderr || e.message).slice(0, 400); }
}

function kur() {
  if (!fs.existsSync(HEDEF)) { console.log('✗ server.js bulunamadi. Proje klasorunde calistir.'); process.exit(1); }

  for (const d of ['whapi-hat.js', 'whapi-cevirici.js', 'whapi-adapter.js']) {
    if (!fs.existsSync(path.join(__dirname, d))) { console.log('✗ eksik dosya: ' + d); process.exit(1); }
  }

  let kaynak = fs.readFileSync(HEDEF, 'utf8');

  if (kaynak.includes(ISARET)) {
    console.log('• Kancalar ZATEN kurulu. Hicbir sey yapilmadi.');
    console.log('  Yeniden kurmak icin once:  node whapi-kur.js --geri');
    return;
  }

  const n1 = kaynak.split(ARA_1).length - 1;
  const n2 = kaynak.split(ARA_2).length - 1;
  if (n1 !== 1) { console.log(`✗ startWA baslangici ${n1} kez bulundu (1 olmaliydi). DOKUNULMADI.`); process.exit(1); }
  if (n2 !== 1) { console.log(`✗ acilis satiri ${n2} kez bulundu (1 olmaliydi). DOKUNULMADI.`); process.exit(1); }

  if (!fs.existsSync(YEDEK)) fs.copyFileSync(HEDEF, YEDEK);
  console.log('✔ yedek: server.js.whapi-oncesi');

  kaynak = kaynak.replace(ARA_1, KOY_1).replace(ARA_2, KOY_2);

  const gecici = path.join(__dirname, 'server.whapi-gecici.js');
  fs.writeFileSync(gecici, kaynak, 'utf8');

  const hata = sozDizimi(gecici);
  if (hata) {
    fs.unlinkSync(gecici);
    console.log('✗ yama sonrasi soz dizimi BOZUK — server.js\'e DOKUNULMADI:\n' + hata);
    process.exit(1);
  }

  fs.renameSync(gecici, HEDEF);

  const eski = fs.readFileSync(YEDEK, 'utf8').split('\n').length;
  const yeni = kaynak.split('\n').length;
  console.log('✔ iki kanca eklendi (' + eski + ' -> ' + yeni + ' satir)');
  console.log('✔ soz dizimi saglam');
  console.log('');
  console.log('Sonraki adim:  pm2 restart pekcan --update-env');
  console.log('Geri alma   :  node whapi-kur.js --geri');
}

if (process.argv.includes('--geri')) geriAl(); else kur();
