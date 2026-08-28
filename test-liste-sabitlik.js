// Enjekte edilen LISTE SABITLIGI kodunu index.html'den CIKARIP calistirir.
const fs=require('fs');
const s=fs.readFileSync('index.html','utf8');
const bas=s.indexOf('/* WHAPI PANEL GORUNUMU — LISTE SABITLIGI');
const son=s.indexOf('})();',bas)+5;
const kod=s.slice(bas,son);

// ── Sahte DOM ──
let yazmaSayisi=0;
const proto={};
Object.defineProperty(proto,'innerHTML',{
  configurable:true,
  get(){return this._h||'';},
  set(v){ yazmaSayisi++; this._h=v; }
});
const el=Object.create(proto);
el._h=''; el.scrollTop=0;
global.Element={prototype:proto};
const dinleyiciler={};
global.document={
  getElementById:id=>id==='chatList'?el:null,
  addEventListener:(e,f)=>{(dinleyiciler[e]=dinleyiciler[e]||[]).push(f);}
};
global.window={};
let asilCagri=0;
let _renderListRaw=function(){ asilCagri++; el.innerHTML=global.__HTML; };

// enjekte edilen kodu calistir
const f=new Function('document','window','Element','_renderListRaw','setTimeout',
  kod+'\n return _renderListRaw;');
_renderListRaw=f(global.document,global.window,global.Element,_renderListRaw,setTimeout);

let g=0,k=0;const T=(a,o,b)=>{const ok=JSON.stringify(o)===JSON.stringify(b);
 ok?(g++,console.log('  ✓ '+a)):(k++,console.log('  ✗ '+a+'  beklenen:'+JSON.stringify(b)+'  olan:'+JSON.stringify(o)))};
const bek=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
console.log('\n═══ 1) AYNI HTML tekrar DOM a yazilmiyor ═══\n');
global.__HTML='<div>sohbet A</div>';
_renderListRaw(); _renderListRaw(); _renderListRaw();
T('asil cizim 3 kez calisti', asilCagri, 3);
T('DOM a SADECE 1 kez yazildi', yazmaSayisi, 1);

console.log('\n═══ 2) HTML DEGISINCE yaziliyor ═══\n');
global.__HTML='<div>sohbet A</div><div>sohbet B</div>';
_renderListRaw();
T('degisince yazildi', yazmaSayisi, 2);

console.log('\n═══ 3) KULLANICI DOKUNURKEN cizilmiyor ═══\n');
(dinleyiciler['pointerdown']||[]).forEach(f=>f());   // kullanici tikladi
const oncekiCagri=asilCagri;
global.__HTML='<div>C</div>';
_renderListRaw();
T('tiklama aninda DOM a DOKUNULMADI', asilCagri, oncekiCagri);
console.log('      (450 ms bekleniyor...)');
await bek(600);
T('bekleyince cizim YAPILDI', asilCagri, oncekiCagri+1);

console.log('\n═══ 4) KAYDIRMA konumu korunuyor ═══\n');
el.scrollTop=1250;
global.__HTML='<div>D</div>';
_renderListRaw();
T('scrollTop degismedi', el.scrollTop, 1250);

console.log('\n═══ SONUC ═══\n  gecen: '+g+'   kalan: '+k+'\n');
process.exit(k?1:0);
})();
