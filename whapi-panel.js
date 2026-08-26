#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   WHAPI MINI PANEL          (CANLI SISTEME DOKUNMAZ)
   ---------------------------------------------------------------------
   AYRI bir surectir. server.js'i, Supabase'i, Baileys oturumunu
   ELLEMEZ. Kendi portunda calisir, veriyi BELLEKTE tutar.
   Kapatinca her sey silinir — kalici hicbir yere yazmaz.

   AMAC: "Whapi ile mesaj geliyor mu, gidiyor mu, medya iniyor mu"
   sorusunu GERCEK BIR ARAYUZLE gormek. Sifirdan baslar.

   KULLANIM:
       export WHAPI_TOKEN='...'
       node whapi-panel.js            (varsayilan port 3999)
       node whapi-panel.js 4001

   Tarayicidan:  https://pkcnweb3444.site/whapi-deneme
   Whapi webhook URL'si de AYNI adres.
   ═══════════════════════════════════════════════════════════════════════ */
const http = require('http');

const TOKEN = process.env.WHAPI_TOKEN || '';
const TABAN = (process.env.WHAPI_URL || 'https://gate.whapi.cloud').replace(/\/+$/, '');
const PORT = Number(process.argv[2]) || 3999;
const ONEK = '/whapi-deneme';          // nginx bu yolu bu surece yonlendiriyor

// ── BELLEKTEKI DEPO (kalici degil) ───────────────────────────────────
const sohbetler = new Map();   // chatId -> { id, ad, grup, mesajlar[], sonZaman }
const gorulenId = new Set();   // mukerrer webhook korumasi
let sayac = { gelen: 0, giden: 0, medya: 0, mukerrer: 0, webhook: 0 };
const baslangic = Date.now();

function sohbetAl(id, ad, grup) {
  if (!sohbetler.has(id)) sohbetler.set(id, { id, ad: ad || id.split('@')[0], grup: !!grup, mesajlar: [], sonZaman: 0 });
  const s = sohbetler.get(id);
  if (ad && ad !== s.ad) s.ad = ad;      // ad sonradan gelirse guncelle
  return s;
}

function mesajEkle(m) {
  const id = m.chat_id || m.from || m.to || 'bilinmeyen';
  const grup = /@g\.us|@group/i.test(String(id));
  const s = sohbetAl(id, m.chat_name || (m.from_me ? null : m.from_name), grup);

  // MUKERRER KORUMASI: ayni mesaj ID iki kez gelirse ikinci kez ekleme
  if (m.id) {
    if (gorulenId.has(m.id)) { sayac.mukerrer++; return { mukerrer: true }; }
    gorulenId.add(m.id);
    if (gorulenId.size > 20000) gorulenId.clear();
  }

  const tur = m.type || 'text';
  const medya = m.image || m.document || m.video || m.audio || m.voice || m.sticker;
  const kayit = {
    id: m.id || '',
    benden: !!m.from_me,
    gonderen: m.from_name || (m.from_me ? 'Ben' : ''),
    tur,
    metin: (m.text && (m.text.body || m.text)) || m.caption || '',
    medyaLink: medya && medya.link ? medya.link : '',
    dosyaAdi: medya ? (medya.file_name || '') : '',
    mime: medya ? (medya.mime_type || '') : '',
    zaman: (m.timestamp ? Number(m.timestamp) * 1000 : Date.now()),
  };
  s.mesajlar.push(kayit);
  if (s.mesajlar.length > 300) s.mesajlar = s.mesajlar.slice(-300);
  s.sonZaman = kayit.zaman;
  if (kayit.benden) sayac.giden++; else sayac.gelen++;
  if (medya) sayac.medya++;
  return { mukerrer: false, kayit, sohbet: s };
}

// ── WHAPI'YE GONDER ───────────────────────────────────────────────────
async function whapiGonder(hedef, metin) {
  if (!TOKEN) return { ok: false, hata: 'WHAPI_TOKEN yok' };
  const kontrol = new AbortController();
  const t = setTimeout(() => kontrol.abort(), 30000);
  try {
    const y = await fetch(TABAN + '/messages/text', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: hedef, body: metin }),
      signal: kontrol.signal,
    });
    const v = await y.json().catch(() => ({}));
    if (!y.ok) return { ok: false, hata: 'HTTP ' + y.status, detay: v };
    const id = (v.message && (v.message.id || v.message.key?.id)) || v.id || v.sent_id || '';
    // Kendi mesajimizi hemen panele yansit (webhook da gelirse mukerrer korumasi yakalar)
    if (id) mesajEkle({ id, chat_id: hedef, from_me: true, type: 'text', text: { body: metin } });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, hata: e.name === 'AbortError' ? 'zaman asimi' : e.message };
  } finally { clearTimeout(t); }
}

// ── ARAYUZ ────────────────────────────────────────────────────────────
const SAYFA = `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Whapi Mini Panel</title><style>
:root{--mur:#1c2b3a;--kagit:#f7f5f0;--kagit2:#fffefb;--cizgi:#d9d2c4;--soluk:#6b7a89;--yesil:#2d6a4f;--muhur:#a8321e}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--kagit);color:var(--mur);font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column}
header{background:var(--mur);color:#fff;padding:9px 15px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header b{font:600 15px/1 ui-serif,Georgia,serif}
header .r{font-size:12px;opacity:.85}
header .u{background:#ffffff1f;padding:2px 8px;border-radius:3px;font-size:12px}
main{flex:1;display:flex;min-height:0}
#sol{width:290px;border-right:1px solid var(--cizgi);overflow-y:auto;background:var(--kagit2);flex:0 0 auto}
.sb{padding:9px 13px;border-bottom:1px solid #eee9dd;cursor:pointer}
.sb:hover{background:#fdfbf5}.sb.aktif{background:#eef3f7;box-shadow:inset 3px 0 0 var(--mur)}
.sb .ad{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb .son{font-size:12px;color:var(--soluk);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#sag{flex:1;display:flex;flex-direction:column;min-width:0}
#basl{padding:10px 15px;border-bottom:1px solid var(--cizgi);background:var(--kagit2);font-weight:600}
#akis{flex:1;overflow-y:auto;padding:14px}
.m{max-width:72%;margin-bottom:9px;padding:7px 11px;border-radius:8px;background:var(--kagit2);border:1px solid var(--cizgi);word-wrap:break-word}
.m.ben{margin-left:auto;background:#eaf5ee;border-color:#bcdcc8}
.m .k{font-size:11px;color:var(--soluk);margin-bottom:2px}
.m .z{font-size:10.5px;color:#93a1ae;text-align:right;margin-top:3px}
.m img{max-width:230px;border-radius:5px;display:block;margin-top:5px}
.m a{color:var(--mur)}
#alt{padding:10px;border-top:1px solid var(--cizgi);display:flex;gap:8px;background:var(--kagit2)}
#alt input{flex:1;padding:9px 12px;border:1px solid var(--cizgi);border-radius:4px;font:14px inherit}
#alt button{padding:9px 20px;border:1px solid var(--mur);background:var(--mur);color:#fff;border-radius:4px;cursor:pointer;font:14px inherit}
#alt button:disabled{opacity:.45;cursor:not-allowed}
.bos{padding:40px;text-align:center;color:var(--soluk)}
</style></head><body>
<header>
  <b>Whapi Mini Panel</b>
  <span class="u" id="uDurum">bağlanıyor…</span>
  <span class="r" id="uSayac"></span>
  <span class="r" style="margin-left:auto">canlı sisteme dokunmaz · veri bellekte</span>
</header>
<main>
  <div id="sol"><div class="bos">Henüz sohbet yok.<br><br>Gruba telefondan mesaj at.</div></div>
  <div id="sag">
    <div id="basl">Sohbet seç</div>
    <div id="akis"><div class="bos">Soldan bir sohbet seç.</div></div>
    <div id="alt"><input id="girdi" placeholder="Mesaj yaz…" disabled><button id="gonder" disabled>Gönder</button></div>
  </div>
</main>
<script>
const K='${ONEK}';let aktif=null,sonImza='';
const esc=(s)=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const saat=(t)=>new Date(t).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'});
async function yenile(){
  try{
    const r=await fetch(K+'/veri');const d=await r.json();
    document.getElementById('uDurum').textContent=d.token?'token var':'TOKEN YOK';
    document.getElementById('uSayac').textContent=
      \`webhook \${d.sayac.webhook} · gelen \${d.sayac.gelen} · giden \${d.sayac.giden} · medya \${d.sayac.medya} · mükerrer engellenen \${d.sayac.mukerrer}\`;
    const imza=JSON.stringify(d.sohbetler.map(s=>[s.id,s.n,s.sonZaman]));
    if(imza!==sonImza){sonImza=imza;solCiz(d.sohbetler);}
    if(aktif)await akisCiz();
  }catch(e){document.getElementById('uDurum').textContent='sunucuya ulaşılamıyor';}
}
function solCiz(liste){
  const sol=document.getElementById('sol');
  if(!liste.length){sol.innerHTML='<div class="bos">Henüz sohbet yok.<br><br>Gruba telefondan mesaj at.</div>';return;}
  sol.innerHTML=liste.map(s=>
    \`<div class="sb \${s.id===aktif?'aktif':''}" onclick="sec('\${s.id}')">
      <div class="ad">\${s.grup?'👥':'👤'} \${esc(s.ad)}</div>
      <div class="son">\${esc(s.son||'')} · \${s.n} mesaj</div></div>\`).join('');
}
async function sec(id){
  aktif=id;sonImza='';
  document.getElementById('girdi').disabled=false;
  document.getElementById('gonder').disabled=false;
  await yenile();
}
async function akisCiz(){
  const r=await fetch(K+'/veri?sohbet='+encodeURIComponent(aktif));const d=await r.json();
  if(!d.sohbet)return;
  document.getElementById('basl').textContent=(d.sohbet.grup?'👥 ':'👤 ')+d.sohbet.ad;
  const akis=document.getElementById('akis');
  const alttaydi=akis.scrollTop+akis.clientHeight>=akis.scrollHeight-60;
  akis.innerHTML=d.sohbet.mesajlar.map(m=>{
    let ic='';
    if(m.metin)ic+=esc(m.metin);
    if(m.medyaLink){
      if((m.mime||'').startsWith('image/'))ic+=\`<img src="\${esc(m.medyaLink)}" alt="görsel">\`;
      else ic+=\`<div style="margin-top:5px">📎 <a href="\${esc(m.medyaLink)}" target="_blank">\${esc(m.dosyaAdi||m.tur)}</a></div>\`;
    }
    if(!ic)ic='<i style="color:#93a1ae">('+esc(m.tur)+')</i>';
    return \`<div class="m \${m.benden?'ben':''}">
      \${m.benden?'':'<div class="k">'+esc(m.gonderen||'')+'</div>'}
      <div>\${ic}</div><div class="z">\${saat(m.zaman)}</div></div>\`;
  }).join('')||'<div class="bos">Bu sohbette mesaj yok.</div>';
  if(alttaydi)akis.scrollTop=akis.scrollHeight;
}
document.getElementById('gonder').onclick=async()=>{
  const g=document.getElementById('girdi'),b=document.getElementById('gonder');
  const t=g.value.trim();if(!t||!aktif)return;
  b.disabled=true;b.textContent='…';
  try{
    const r=await fetch(K+'/gonder',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({hedef:aktif,metin:t})});
    const d=await r.json();
    if(d.ok){g.value='';sonImza='';await yenile();}
    else alert('Gönderilemedi: '+(d.hata||'bilinmeyen')+'\\n'+JSON.stringify(d.detay||{}).slice(0,200));
  }catch(e){alert('Sunucu hatası: '+e.message);}
  b.disabled=false;b.textContent='Gönder';
};
document.getElementById('girdi').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('gonder').click();});
yenile();setInterval(yenile,2000);
</script></body></html>`;

// ── SUNUCU ────────────────────────────────────────────────────────────
function govdeOku(istek) {
  return new Promise((coz) => {
    let h = '';
    istek.on('data', (p) => { h += p; if (h.length > 8e6) istek.destroy(); });
    istek.on('end', () => coz(h));
  });
}

const sunucu = http.createServer(async (istek, cevap) => {
  let yol = (istek.url || '/').split('?')[0];
  if (yol.startsWith(ONEK)) yol = yol.slice(ONEK.length) || '/';
  const sorgu = new URL(istek.url, 'http://x').searchParams;
  const json = (v, kod = 200) => { cevap.writeHead(kod, { 'Content-Type': 'application/json; charset=utf-8' }); cevap.end(JSON.stringify(v)); };

  // WEBHOOK — Whapi buraya POST atar
  if (istek.method === 'POST' && (yol === '/' || yol === '')) {
    const ham = await govdeOku(istek);
    json({ ok: true });                       // once onayla, tekrar denemesin
    sayac.webhook++;
    let v = null; try { v = JSON.parse(ham); } catch (_) { return; }
    const mesajlar = v.messages || (v.message ? [v.message] : []);
    for (const m of mesajlar) {
      const s = mesajEkle(m);
      const ad = m.chat_name || m.from_name || '';
      const uyari = [];
      if (/@g\.us/.test(String(m.chat_id || '')) && !ad) uyari.push('GRUP ADI YOK');
      if (!m.id) uyari.push('MESAJ ID YOK');
      console.log(`  ${s.mukerrer ? '⟳ mukerrer' : '✓'} ${m.type || 'text'}  ${ad || m.chat_id || '?'}` +
        (uyari.length ? `   \x1b[31m${uyari.join(' / ')}\x1b[0m` : ''));
    }
    return;
  }

  // GONDERIM
  if (istek.method === 'POST' && yol === '/gonder') {
    const ham = await govdeOku(istek);
    let g = {}; try { g = JSON.parse(ham); } catch (_) {}
    if (!g.hedef || !g.metin) return json({ ok: false, hata: 'hedef ve metin gerekli' }, 400);
    const r = await whapiGonder(g.hedef, g.metin);
    console.log(`  ${r.ok ? '↗ gonderildi' : '✘ gonderilemedi'}  ${g.hedef}  ${r.ok ? r.id : r.hata}`);
    return json(r);
  }

  // VERI
  if (yol === '/veri') {
    const tek = sorgu.get('sohbet');
    if (tek) {
      const s = sohbetler.get(tek);
      return json({ sohbet: s ? { id: s.id, ad: s.ad, grup: s.grup, mesajlar: s.mesajlar } : null });
    }
    const liste = [...sohbetler.values()]
      .sort((a, b) => b.sonZaman - a.sonZaman)
      .map((s) => {
        const son = s.mesajlar[s.mesajlar.length - 1];
        return { id: s.id, ad: s.ad, grup: s.grup, n: s.mesajlar.length, sonZaman: s.sonZaman,
                 son: son ? (son.metin || son.dosyaAdi || son.tur) : '' };
      });
    return json({ sohbetler: liste, sayac, token: !!TOKEN, ayakta: Math.round((Date.now() - baslangic) / 1000) });
  }

  // PANEL
  cevap.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  cevap.end(SAYFA);
});

sunucu.listen(PORT, () => {
  const C = { b:'\x1b[1m', y:'\x1b[32m', s:'\x1b[33m', g:'\x1b[90m', x:'\x1b[0m' };
  console.log(`${C.b}\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  WHAPI MINI PANEL — canli sisteme DOKUNMAZ                    ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝${C.x}`);
  console.log(`  ${C.y}✔ Dinleniyor: 0.0.0.0:${PORT}${C.x}`);
  console.log(`  ${TOKEN ? C.y + '✔ token yuklendi' : C.s + '⚠ WHAPI_TOKEN yok — mesaj GONDEREMEZSIN (alma calisir)'}${C.x}`);
  console.log(`\n  ${C.b}Tarayicidan ac:${C.x}  https://pkcnweb3444.site${ONEK}`);
  console.log(`  ${C.b}Whapi webhook URL'si de AYNI adres.${C.x}`);
  console.log(`\n  ${C.g}Veri BELLEKTE — kapatinca silinir. Supabase'e hicbir sey yazilmaz.`);
  console.log(`  Gruba telefondan mesaj at, panelde belirsin. Cikis: Ctrl+C${C.x}\n`);
});
sunucu.on('error', (e) => {
  console.error(`\nPort ${PORT} acilamadi: ${e.message}`);
  if (e.code === 'EADDRINUSE') console.error(`Once eskisini durdur:  pkill -f whapi-`);
  process.exit(1);
});
