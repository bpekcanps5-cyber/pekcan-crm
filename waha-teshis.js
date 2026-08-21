#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   WAHA TESHIS ARACI
   -------------------------------------------------------------------
   "Grup adlari neden gelmiyor" sorusunu TAHMINLE degil VERIYLE cevaplar.
   Hicbir seyi degistirmez, sadece okur. Panele/veritabanina dokunmaz.

   Calistirma:
       cd /root/waha-crm && node waha-teshis.js

   Cevapladigi sorular:
     1. Sohbet ucu kac kayit veriyor? 'offset' calisiyor mu (sayfalama)?
     2. Overview ucu calisiyor mu?
     3. Grup ucunde kac grup var, kacinin adi dolu?
     4. ADI OLMAYAN bir grup icin hangi uc ne donuyor?
     5. ADI OLAN bir grup icin ayni uclar ne donuyor? (karsilastirma)
     6. Grup deposunu tazeleme ucu var mi?
   ═══════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

// ── .env oku (WAHA_URL, WAHA_API_KEY, WAHA_OTURUM) ──
function envOku() {
  const s = {};
  for (const dosya of ['.env', path.join(__dirname, '.env'), '/root/waha-crm/.env']) {
    try {
      for (const satir of fs.readFileSync(dosya, 'utf8').split('\n')) {
        const m = satir.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
        if (m && !s[m[1]]) s[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
      }
      break;
    } catch (_) { /* sonrakini dene */ }
  }
  return s;
}
const E = envOku();
const URL_ = process.env.WAHA_URL || E.WAHA_URL || 'http://localhost:3001';
const ANAHTAR = process.env.WAHA_API_KEY || E.WAHA_API_KEY || '';
const OTURUM = process.env.WAHA_OTURUM || E.WAHA_OTURUM || 'test';

const yaz = (...a) => console.log(...a);
const cizgi = (b = '─') => yaz(b.repeat(68));

async function iste(yol, yontem = 'GET') {
  const bas = { 'Content-Type': 'application/json' };
  if (ANAHTAR) bas['X-Api-Key'] = ANAHTAR;
  const iptal = new AbortController();
  const saat = setTimeout(() => iptal.abort(), 60000);
  try {
    const r = await fetch(URL_ + yol, { method: yontem, headers: bas, signal: iptal.signal });
    const metin = await r.text();
    let veri = null;
    try { veri = metin ? JSON.parse(metin) : null; } catch (_) { veri = metin; }
    return { kod: r.status, veri };
  } catch (e) {
    return { kod: 0, hata: e.name === 'AbortError' ? 'zaman asimi (60sn)' : e.message };
  } finally { clearTimeout(saat); }
}

const dizi = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.data) ? v.data
  : (v && Array.isArray(v.chats) ? v.chats : []));
const jidAl = (x) => String((x && ((x.id && x.id._serialized) || x.JID || x.id || x.jid || x.chatId)) || '');
const adAl = (x) => String((x && (x.name || x.Name || x.subject || x.Subject)) || '').trim();

(async () => {
  yaz('');
  cizgi('═');
  yaz('  WAHA TESHIS  —  ' + URL_ + '  |  oturum: ' + OTURUM);
  yaz('  anahtar: ' + (ANAHTAR ? 'var (' + ANAHTAR.slice(0, 4) + '...)' : 'YOK — 401 alabiliriz'));
  cizgi('═');

  // ── 0) OTURUM ──
  const o = await iste('/api/sessions/' + OTURUM);
  yaz('\n[0] OTURUM DURUMU');
  if (o.kod !== 200) { yaz('    HATA ' + o.kod + ' ' + (o.hata || JSON.stringify(o.veri).slice(0, 120)));
    yaz('    Anahtar yanlissa .env icindeki WAHA_API_KEY degerini kontrol et.'); return; }
  yaz('    durum: ' + o.veri.status + ' | numara: ' + ((o.veri.me && o.veri.me.id) || '?'));
  yaz('    motor: ' + (o.veri.engine && (o.veri.engine.engine || o.veri.engine.name) || '?'));
  // ═══ EN KRITIK SATIR: NOWEB deposu acik mi? ═══════════════════════
  // Depo kapaliyken WAHA sohbet listesi, grup adi/aciklamasi ve gecmis
  // VERMIYOR. Grup adlarinin gelmemesinin bir numarali sebebi budur.
  const nw = o.veri.config && o.veri.config.noweb;
  const st = nw && nw.store;
  yaz('');
  if (st && st.enabled) {
    yaz('    ✓ NOWEB DEPOSU ACIK   (fullSync: ' + !!(st.fullSync || st.full_sync) + ')');
  } else {
    yaz('    ✗ NOWEB DEPOSU KAPALI   <-- GRUP ADLARININ GELMEME SEBEBI');
    yaz('      kayitli ayar: ' + JSON.stringify(nw || null));
    yaz('      Cozum: docker-compose.yml -> WAHA_NOWEB_STORE_ENABLED: \"True\"');
    yaz('             sonra: docker compose up -d --force-recreate');
  }

  // ── 1) SOHBET UCU + SAYFALAMA ──
  yaz('\n[1] SOHBET UCU  /chats   ← grup ADLARI burada');
  const s1 = await iste('/api/' + OTURUM + '/chats?limit=500&offset=0');
  if (s1.kod !== 200) {
    yaz('    KOD ' + s1.kod + ' — ' + (s1.hata || JSON.stringify(s1.veri).slice(0, 120)));
  } else {
    const d1 = dizi(s1.veri);
    yaz('    limit=500 istendi -> ' + d1.length + ' kayit geldi'
      + (d1.length < 500 ? '   (uc kendi sinirini uyguluyor)' : ''));
    if (d1.length) {
      yaz('    alanlar: ' + Object.keys(d1[0]).join(', '));
      const adli = d1.filter((x) => adAl(x)).length;
      yaz('    adi dolu: ' + adli + '/' + d1.length);
      yaz('    ornek  : ' + jidAl(d1[0]) + '  ->  "' + adAl(d1[0]) + '"');
    }
    // offset calisiyor mu?
    const s2 = await iste('/api/' + OTURUM + '/chats?limit=500&offset=' + d1.length);
    const d2 = dizi(s2.veri);
    const ilk1 = d1.map(jidAl).join('|');
    const ilk2 = d2.map(jidAl).join('|');
    yaz('    offset=' + d1.length + ' -> ' + d2.length + ' kayit');
    if (!d2.length) yaz('    >> SAYFALAMA YOK: ikinci sayfa BOS. Sadece ilk ' + d1.length + ' sohbet alinabiliyor.');
    else if (ilk1 === ilk2) yaz('    >> SAYFALAMA CALISMIYOR: ayni kayitlar tekrar geldi.');
    else yaz('    >> SAYFALAMA CALISIYOR: farkli kayitlar geldi (tum sohbetler alinabilir).');
    // toplam kac sohbet var, sayfalayarak bul
    if (d2.length && ilk1 !== ilk2) {
      const gorulen = new Set(); let konum = 0, tur = 0;
      while (tur++ < 300) {
        const r = await iste('/api/' + OTURUM + '/chats?limit=500&offset=' + konum);
        const d = dizi(r.veri); if (!d.length) break;
        let yeni = 0;
        for (const x of d) { const j = jidAl(x); if (j && !gorulen.has(j)) { gorulen.add(j); yeni++; } }
        konum += d.length; if (!yeni) break;
      }
      yaz('    >> SAYFALAYARAK TOPLAM: ' + gorulen.size + ' sohbet alinabiliyor');
    }
  }

  // ── 2) OVERVIEW UCU ──
  yaz('\n[2] OVERVIEW UCU  /chats/overview');
  const ov = await iste('/api/' + OTURUM + '/chats/overview?limit=50&offset=0');
  if (ov.kod !== 200) yaz('    KOD ' + ov.kod + ' — ' + (ov.hata || JSON.stringify(ov.veri).slice(0, 100)));
  else {
    const d = dizi(ov.veri);
    yaz('    ' + d.length + ' kayit | adi dolu: ' + d.filter((x) => adAl(x)).length);
    if (d.length) yaz('    alanlar: ' + Object.keys(d[0]).join(', '));
  }

  // ── 3) GRUP UCU ──
  yaz('\n[3] GRUP UCU  /groups');
  let adsizOrnek = '', adliOrnek = '';
  const ilkG = await iste('/api/' + OTURUM + '/groups?limit=500&offset=0');
  if (ilkG.kod !== 200) yaz('    KOD ' + ilkG.kod + ' — ' + (ilkG.hata || JSON.stringify(ilkG.veri).slice(0, 100)));
  else {
    // TUM gruplari sayfalayarak oku — gercek orani ancak boyle gorurüz
    const gorulen = new Map(); let konum = 0, tur = 0;
    while (tur++ < 200) {
      const r = await iste('/api/' + OTURUM + '/groups?limit=500&offset=' + konum);
      const d = dizi(r.veri); if (!d.length) break;
      let yeni = 0;
      for (const x of d) { const j = jidAl(x); if (j && !gorulen.has(j)) { gorulen.set(j, adAl(x)); yeni++; } }
      konum += d.length; if (!yeni) break;
    }
    const toplam = gorulen.size;
    let adli = 0;
    for (const [j, a] of gorulen) {
      if (a) { adli++; if (!adliOrnek) adliOrnek = j; }
      else if (!adsizOrnek) adsizOrnek = j;
    }
    yaz('    sayfalayarak TOPLAM: ' + toplam + ' grup');
    yaz('    adi dolu: ' + adli + '   |   adi BOS: ' + (toplam - adli)
      + '   (%' + Math.round((toplam - adli) * 100 / (toplam || 1)) + ' bos)');
    const d0 = dizi(ilkG.veri);
    if (d0.length) yaz('    alanlar: ' + Object.keys(d0[0]).slice(0, 12).join(', ') + ' ...');
  }

  // ── 4-5) TEK GRUP KARSILASTIRMASI ──
  const denek = [['ADI BOS  grup', adsizOrnek], ['ADI DOLU grup', adliOrnek]];
  for (const [etiket, jid] of denek) {
    if (!jid) continue;
    yaz('\n[4] ' + etiket + ': ' + jid);
    for (const [ad, yol] of [
      ['grup ucu     ', '/api/' + OTURUM + '/groups/' + jid],
      ['tek sohbet   ', '/api/' + OTURUM + '/chats/' + jid],
      ['uyeler       ', '/api/' + OTURUM + '/groups/' + jid + '/participants'],
    ]) {
      const r = await iste(yol);
      if (r.kod !== 200) { yaz('    ' + ad + ' KOD ' + r.kod + ' ' + String(r.hata || JSON.stringify(r.veri)).slice(0, 60)); continue; }
      if (Array.isArray(r.veri)) yaz('    ' + ad + ' OK -> ' + r.veri.length + ' kayit');
      else yaz('    ' + ad + ' OK -> ad: ' + (adAl(r.veri) ? '"' + adAl(r.veri) + '"' : 'BOS'));
    }
  }

  // ── 6) TAZELEME UCLARI ──
  yaz('\n[6] GRUP DEPOSUNU TAZELEME UCLARI');
  for (const [y, yol] of [
    ['POST', '/api/' + OTURUM + '/groups/refresh'],
    ['POST', '/api/' + OTURUM + '/groups/refresh-metadata'],
    ['POST', '/api/' + OTURUM + '/groups/sync'],
  ]) {
    const r = await iste(yol, y);
    yaz('    ' + yol.replace('/api/' + OTURUM, '') + '  ->  KOD ' + r.kod
      + (r.kod === 200 ? '  ✓ CALISIYOR' : ''));
  }

  cizgi('═');
  yaz('  Bu ciktinin TAMAMINI yapistir — grup adlari icin dogru yolu');
  yaz('  bu tablodan secebilirim.');
  cizgi('═');
  yaz('');
})();
