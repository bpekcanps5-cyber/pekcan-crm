#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   WHAPI DENEME — pekcan-crm            (CANLI SISTEME DOKUNMAZ)
   ---------------------------------------------------------------------
   Bu betik AYRI bir surectir. server.js'i, veritabanini, Baileys
   oturumunu ELLEMEZ. Whapi kanali FARKLI bir numarada oldugu icin
   ofis hattiyla hicbir temasi yoktur.

   NEDEN BU SIRAYLA:
     WAHA denemesini olduren sey mesaj gonderememek DEGILDI —
     gruplarin %64'unun ADI GELMIYORDU. Once o soruyu soruyoruz;
     cevabi kotuyse digerlerini denemeye gerek kalmaz.

   TOKEN: koda YAZILMAZ, ortam degiskeninden okunur.
       export WHAPI_TOKEN='...'

   KULLANIM:
     node whapi-deneme.js saglik            kanal ayakta mi
     node whapi-deneme.js gruplar           ASIL TEST: grup adlari geliyor mu
     node whapi-deneme.js sohbetler         tum sohbetler
     node whapi-deneme.js gonder <chatId> "mesaj"
     node whapi-deneme.js dinle [port]      webhook alicisi (varsayilan 3999)
   ═══════════════════════════════════════════════════════════════════════ */
const http = require('http');

const TOKEN = process.env.WHAPI_TOKEN || '';
const TABAN = (process.env.WHAPI_URL || 'https://gate.whapi.cloud').replace(/\/+$/, '');
const C = { b:'\x1b[1m', k:'\x1b[31m', s:'\x1b[33m', y:'\x1b[32m', g:'\x1b[90m', x:'\x1b[0m' };
const iyi=(t)=>console.log(`  ${C.y}✔ ${t}${C.x}`);
const uya=(t)=>console.log(`  ${C.s}⚠ ${t}${C.x}`);
const kotu=(t)=>console.log(`  ${C.k}✘ ${t}${C.x}`);
const baslik=(t)=>console.log(`\n${C.b}══ ${t} ${'═'.repeat(Math.max(0,58-t.length))}${C.x}`);

// Webhook alicisi token ISTEMEZ — sadece POST dinleyen bir sunucudur.
// Token yalnizca API cagiran komutlar icin gerekli.
const TOKENSIZ_KOMUTLAR = ['dinle', ''];
const _komut = (process.argv[2] || '').toLowerCase();
if (!TOKEN && !TOKENSIZ_KOMUTLAR.includes(_komut)) {
  console.error(`\n${C.k}WHAPI_TOKEN ayarlanmamis.${C.x}`);
  console.error(`\n  export WHAPI_TOKEN='panelden-aldigin-token'`);
  console.error(`  node whapi-deneme.js gruplar\n`);
  console.error(`  ${C.s}NOT: token'i ekran goruntusunde paylastiysan panelden YENILE.${C.x}\n`);
  process.exit(1);
}

// Token'i ASLA ekrana basma — sadece son 4 hane
const tokenIzi = TOKEN ? ('…' + TOKEN.slice(-4)) : '(yok)';

async function cagir(yol, secenek = {}) {
  const url = TABAN + yol;
  const kontrol = new AbortController();
  const zamanAsimi = setTimeout(() => kontrol.abort(), 30000);
  try {
    const y = await fetch(url, {
      method: secenek.method || 'GET',
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Accept': 'application/json',
        ...(secenek.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: secenek.body ? JSON.stringify(secenek.body) : undefined,
      signal: kontrol.signal,
    });
    const ham = await y.text();
    let veri = null;
    try { veri = JSON.parse(ham); } catch (_) { veri = { _ham: ham.slice(0, 400) }; }
    return { durum: y.status, ok: y.ok, veri };
  } catch (e) {
    return { durum: 0, ok: false, hata: e.name === 'AbortError' ? '30 saniyede yanit yok' : e.message };
  } finally { clearTimeout(zamanAsimi); }
}

// Whapi ucu surumden surume degisebiliyor — birkac yolu sirayla dene.
async function ilkCalisan(yollar) {
  const denenen = [];
  for (const y of yollar) {
    const c = await cagir(y);
    denenen.push(`${y} → ${c.durum || c.hata}`);
    if (c.ok) return { ...c, yol: y, denenen };
  }
  return { ok: false, denenen };
}

function listeCikar(veri) {
  if (!veri) return [];
  if (Array.isArray(veri)) return veri;
  for (const a of ['groups', 'chats', 'messages', 'data', 'result', 'items']) {
    if (Array.isArray(veri[a])) return veri[a];
  }
  return [];
}

// ── SAGLIK ────────────────────────────────────────────────────────────
async function saglik() {
  baslik('KANAL SAGLIGI');
  console.log(`  ${C.g}sunucu: ${TABAN}   token: ${tokenIzi}${C.x}`);
  const c = await ilkCalisan(['/health', '/settings', '/me']);
  if (!c.ok) {
    kotu('Kanala ulasilamadi');
    c.denenen.forEach((d) => console.log(`    ${C.g}${d}${C.x}`));
    console.log(`\n  ${C.s}401/403 ise token yanlis veya yenilenmis.`);
    console.log(`  0 / zaman asimi ise sunucudan disari cikis kapali olabilir.${C.x}`);
    return false;
  }
  iyi(`Kanal cevap veriyor (${c.yol})`);
  const v = c.veri || {};
  const durum = v.status || v.state || (v.user ? 'authenticated' : null);
  if (durum) console.log('  durum: ' + JSON.stringify(durum));
  return true;
}

// ── ASIL TEST: GRUPLAR ────────────────────────────────────────────────
async function gruplar() {
  baslik('GRUP TESTI — WAHA burada kalmisti');
  const c = await ilkCalisan(['/groups?count=100', '/groups', '/chats?count=100&type=group']);
  if (!c.ok) {
    kotu('Grup listesi alinamadi');
    c.denenen.forEach((d) => console.log(`    ${C.g}${d}${C.x}`));
    return;
  }
  const liste = listeCikar(c.veri);
  console.log(`  ${C.g}uc: ${c.yol}${C.x}`);
  console.log(`  donen kayit: ${liste.length}`);
  if (!liste.length) {
    uya('Hic grup donmedi. Deneme surumunde 5 sohbet siniri var —');
    uya('once telefondan gruplara mesaj atip kanala tanitman gerekebilir.');
    return;
  }

  let adliVar = 0, adsiz = 0, katilimciVar = 0;
  const ornek = [];
  for (const g of liste) {
    const ad = g.name || g.subject || g.title || g.chat_name || '';
    const kat = g.participants || g.members || g.participantsCount || g.size;
    if (ad && String(ad).trim()) adliVar++; else adsiz++;
    if (kat != null && !(Array.isArray(kat) && kat.length === 0)) katilimciVar++;
    if (ornek.length < 10) {
      ornek.push({
        id: (g.id || g.chat_id || g.jid || '?').toString(),
        ad: ad || '(BOS)',
        kat: Array.isArray(kat) ? kat.length : (kat ?? '?'),
      });
    }
  }

  console.log('');
  console.log(`  ${'GRUP ADI'.padEnd(34)}${'KATILIMCI'.padStart(10)}   ID`);
  console.log('  ' + '─'.repeat(72));
  for (const o of ornek) {
    const renk = o.ad === '(BOS)' ? C.k : '';
    console.log('  ' + renk + o.ad.slice(0, 32).padEnd(34) + C.x +
      String(o.kat).padStart(10) + `   ${C.g}${o.id.slice(0, 26)}${C.x}`);
  }

  console.log('');
  const yuzde = Math.round(adliVar * 100 / liste.length);
  console.log(`  adi GELEN     : ${adliVar}/${liste.length}  (%${yuzde})`);
  console.log(`  adi BOS       : ${adsiz}`);
  console.log(`  katilimci var : ${katilimciVar}/${liste.length}`);
  console.log('');
  if (yuzde === 100) {
    iyi('BUTUN grup adlari geldi — WAHA burada kaliyordu, Whapi gecti.');
    console.log(`  ${C.g}Not: deneme surumunde az grup var. Ucretliye gecince 50+ grupla`);
    console.log(`  TEKRAR olcmek gerekir; sorun genelde olcekte cikiyor.${C.x}`);
  } else if (yuzde >= 90) {
    uya(`%${yuzde} — cogu geldi ama ${adsiz} grubun adi bos. Az sayida grupla bu oran riskli.`);
  } else {
    kotu(`%${yuzde} — WAHA'daki sorunun AYNISI. Bu haliyle kullanilamaz.`);
  }
}

// ── SOHBETLER ─────────────────────────────────────────────────────────
async function sohbetler() {
  baslik('SOHBET LISTESI');
  const c = await ilkCalisan(['/chats?count=50', '/chats']);
  if (!c.ok) { kotu('Sohbet listesi alinamadi'); c.denenen.forEach((d)=>console.log(`    ${C.g}${d}${C.x}`)); return; }
  const liste = listeCikar(c.veri);
  console.log(`  ${liste.length} sohbet\n`);
  for (const s of liste.slice(0, 20)) {
    const id = (s.id || s.chat_id || '?').toString();
    const grupMu = /@g\.us|@group/i.test(id);
    console.log('  ' + (grupMu ? '👥' : '👤') + ' ' +
      String(s.name || s.subject || '(ad yok)').slice(0, 34).padEnd(36) +
      `${C.g}${id.slice(0, 30)}${C.x}`);
  }
  console.log(`\n  ${C.g}Gonderim testi icin yukaridaki bir GRUP id'sini kullan.${C.x}`);
}

// ── GONDERIM ──────────────────────────────────────────────────────────
async function gonder(hedef, metin) {
  baslik('GONDERIM TESTI');
  if (!hedef) { kotu('chatId gerekli:  node whapi-deneme.js gonder <chatId> "mesaj"'); return; }
  const govde = { to: hedef, body: metin || 'Pekcan CRM deneme mesaji' };
  console.log(`  hedef : ${hedef}`);
  console.log(`  metin : ${govde.body}`);
  const t0 = Date.now();
  const c = await cagir('/messages/text', { method: 'POST', body: govde });
  const sure = Date.now() - t0;
  console.log(`  sure  : ${sure} ms`);
  if (!c.ok) {
    kotu(`Gonderilemedi (HTTP ${c.durum || c.hata})`);
    console.log('  ' + C.g + JSON.stringify(c.veri).slice(0, 300) + C.x);
    return;
  }
  const v = c.veri || {};
  const id = (v.message && (v.message.id || v.message.key?.id)) || v.id || v.sent_id;
  if (id) {
    iyi('Gonderildi, mesaj ID alindi');
    console.log(`  ${C.g}id: ${id}${C.x}`);
    console.log(`\n  ${C.s}TELEFONDAN KONTROL ET: mesaj gruba gercekten dustu mu?${C.x}`);
    console.log(`  ${C.g}API "gonderdim" der ama WhatsApp teslim etmemis olabilir.${C.x}`);
  } else {
    uya('Cevap basarili ama mesaj ID yok — teslim dogrulanamaz');
    console.log('  ' + C.g + JSON.stringify(v).slice(0, 300) + C.x);
  }
}

// ── WEBHOOK ALICISI ───────────────────────────────────────────────────
function dinle(port) {
  port = Number(port) || 3999;
  baslik('WEBHOOK ALICISI');
  let sayac = 0;
  const sunucu = http.createServer((istek, cevap) => {
    if (istek.method !== 'POST') {
      cevap.writeHead(200, { 'Content-Type': 'text/plain' });
      return cevap.end('whapi deneme alicisi ayakta\n');
    }
    let ham = '';
    istek.on('data', (p) => { ham += p; if (ham.length > 6e6) istek.destroy(); });
    istek.on('end', () => {
      // ONCE 200 don — Whapi tekrar denemesin
      cevap.writeHead(200, { 'Content-Type': 'application/json' });
      cevap.end('{"ok":true}');
      sayac++;
      let v = null; try { v = JSON.parse(ham); } catch (_) {}
      const zaman = new Date().toLocaleTimeString('tr-TR');
      console.log(`\n${C.b}── #${sayac}  ${zaman}  (${ham.length} bayt) ──${C.x}`);
      if (!v) { console.log('  ' + ham.slice(0, 300)); return; }
      const mesajlar = v.messages || (v.message ? [v.message] : []);
      if (mesajlar.length) {
        for (const m of mesajlar) {
          const kimden = m.chat_id || m.from || '?';
          const grupMu = /@g\.us|@group/i.test(String(kimden));
          const tur = m.type || 'text';
          const metin = (m.text && (m.text.body || m.text)) || m.caption || '';
          console.log(`  ${grupMu ? '👥 GRUP' : '👤 ozel'}  tur=${tur}`);
          console.log(`  kimden : ${kimden}`);
          console.log(`  gonderen adi : ${m.from_name || m.chat_name || '(YOK)'}`);
          console.log(`  mesaj id : ${m.id || '(YOK)'}`);
          if (metin) console.log(`  metin  : ${String(metin).slice(0, 120)}`);
          if (m.image || m.document || m.video || m.audio) {
            const md = m.image || m.document || m.video || m.audio;
            console.log(`  ${C.s}MEDYA${C.x} : link=${md.link ? 'VAR' : 'YOK'}  mime=${md.mime_type || '?'}  ad=${md.file_name || '-'}`);
          }
          // Kontrol listesi
          if (grupMu && !(m.chat_name || m.from_name)) {
            kotu('GRUP ADI GELMEDI — WAHA sorununun aynisi');
          }
          if (!m.id) kotu('Mesaj ID yok — mukerrer korumasi kurulamaz');
        }
      } else {
        const anahtarlar = Object.keys(v).join(', ');
        console.log(`  ${C.g}mesaj yok. alanlar: ${anahtarlar}${C.x}`);
        console.log('  ' + JSON.stringify(v).slice(0, 300));
      }
    });
  });
  sunucu.listen(port, () => {
    iyi(`Dinleniyor: 0.0.0.0:${port}`);
    console.log(`\n  ${C.b}Whapi panelinde Webhook URL'ye sunu yaz:${C.x}`);
    console.log(`     https://SENIN-ALAN-ADIN/whapi-deneme`);
    console.log(`\n  ${C.b}nginx'e su bloku ekle (server { } icine):${C.x}`);
    console.log(`${C.g}     location /whapi-deneme {`);
    console.log(`         proxy_pass http://127.0.0.1:${port};`);
    console.log(`         proxy_set_header Host $host;`);
    console.log(`     }${C.x}`);
    console.log(`\n  ${C.s}"Kalici web kancasi" (persist) dugmesini ACIK yap.${C.x}`);
    console.log(`  ${C.g}Sonra gruba telefondan mesaj at, burada gorunecek. Cikis: Ctrl+C${C.x}`);
  });
  sunucu.on('error', (e) => {
    kotu(`Port ${port} acilamadi: ${e.message}`);
    if (e.code === 'EADDRINUSE') console.log(`  ${C.g}Baska port dene: node whapi-deneme.js dinle 4001${C.x}`);
  });
}

// ── GIRIS ─────────────────────────────────────────────────────────────
(async () => {
  const [komut, a1, a2] = process.argv.slice(2);
  console.log(`${C.b}\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  WHAPI DENEME — canli sisteme DOKUNMAZ                        ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝${C.x}`);
  switch ((komut || '').toLowerCase()) {
    case 'saglik':    await saglik(); break;
    case 'gruplar':   if (await saglik()) await gruplar(); break;
    case 'sohbetler': if (await saglik()) await sohbetler(); break;
    case 'gonder':    if (await saglik()) await gonder(a1, a2); break;
    case 'dinle':     dinle(a1); return;   // surekli calisir
    default:
      console.log(`\n  Komutlar:`);
      console.log(`    saglik              kanal ayakta mi`);
      console.log(`    gruplar             ${C.b}ASIL TEST${C.x} — grup adlari geliyor mu`);
      console.log(`    sohbetler           sohbet listesi (gonderim icin id bul)`);
      console.log(`    gonder <id> "..."   gruba mesaj at`);
      console.log(`    dinle [port]        webhook alicisi\n`);
  }
  console.log('');
})().catch((e) => { console.error('\nHata: ' + e.message); process.exit(1); });
