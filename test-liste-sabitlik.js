const fs=require('fs');
const s=fs.readFileSync('index.html','utf8');
const bas=s.indexOf('/* WHAPI PANEL GORUNUMU — LISTE SABITLIGI');
const son=s.indexOf('})();',bas)+5;
const kod=s.slice(bas,son);

let yazilan=[];
const el={ _h:'', scrollTop:0,
  get innerHTML(){return this._h;}, set innerHTML(v){ this._h=v; yazilan.push(v); } };
const dl={};
global.document={getElementById:id=>id==='chatList'?el:null,
  addEventListener:(e,f)=>{(dl[e]=dl[e]||[]).push(f);}};
global.window={};
// GERCEK cizimin yaptigi gibi: once listeyi yaz, sonra bos ise "Sonuc bulunamadi"
let bosMu=false;
let _renderListRaw=function(){
  el.innerHTML = bosMu ? '' : global.__HTML;
  if(bosMu) el.innerHTML='<div>Sonuç bulunamadı.</div>';
};
const f=new Function('document','window','_renderListRaw','setTimeout',kod+'\n return _renderListRaw;');
_renderListRaw=f(global.document,global.window,_renderListRaw,setTimeout);

let g=0,k=0;const T=(a,o,b)=>{const ok=JSON.stringify(o)===JSON.stringify(b);
 ok?(g++,console.log('  ✓ '+a)):(k++,console.log('  ✗ '+a+'  beklenen:'+JSON.stringify(b)+'  olan:'+JSON.stringify(o)))};
const bek=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
console.log('\n═══ 1) ILK ACILIS: liste DOLU gelmeli (onceki hata buydu) ═══\n');
global.__HTML='<div>sohbet A</div><div>sohbet B</div>';
_renderListRaw();
T('liste DOLU', el.innerHTML, '<div>sohbet A</div><div>sohbet B</div>');
T('bos kalmadi', el.innerHTML.length>0, true);

console.log('\n═══ 2) CIFT YAZIM yutulmuyor ("Sonuc bulunamadi" dali) ═══\n');
yazilan=[]; bosMu=true;
_renderListRaw();
T('ikinci yazim GECTI', el.innerHTML, '<div>Sonuç bulunamadı.</div>');
T('iki yazim da yapildi', yazilan.length, 2);
bosMu=false;

console.log('\n═══ 3) Ayni cizim tekrar tekrar -> hep DOLU kalir ═══\n');
_renderListRaw();_renderListRaw();_renderListRaw();
T('liste hala dolu', el.innerHTML, '<div>sohbet A</div><div>sohbet B</div>');

console.log('\n═══ 4) KULLANICI DOKUNURKEN cizim ERTELENIR ═══\n');
(dl['pointerdown']||[]).forEach(f=>f());
global.__HTML='<div>YENI</div>';
_renderListRaw();
T('tiklama aninda DOM degismedi', el.innerHTML, '<div>sohbet A</div><div>sohbet B</div>');
console.log('      (450 ms bekleniyor...)');
await bek(650);
T('bekleyince cizildi', el.innerHTML, '<div>YENI</div>');

console.log('\n═══ 5) KAYDIRMA korunuyor ═══\n');
el.scrollTop=980; global.__HTML='<div>X</div>';
_renderListRaw();
T('scrollTop degismedi', el.scrollTop, 980);

console.log('\n═══ SONUC ═══\n  gecen: '+g+'   kalan: '+k+'\n');
process.exit(k?1:0);
})();
