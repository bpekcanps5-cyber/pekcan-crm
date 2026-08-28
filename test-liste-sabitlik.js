const fs=require('fs');
const s=fs.readFileSync('yamali.html','utf8');
const bas=s.indexOf('/* WHAPI PANEL GORUNUMU — LISTE SABITLIGI (v2)');
const son=s.indexOf('})();',bas)+5;
const kod=s.slice(bas,son);

function kurulum(){
  const el={_h:'',scrollTop:0,get innerHTML(){return this._h;},set innerHTML(v){this._h=v;}};
  const dl={};
  const doc={getElementById:id=>id==='chatList'?el:null,
    addEventListener:(e,f)=>{(dl[e]=dl[e]||[]).push(f);}};
  const win={};
  const durum={cagri:0,html:''};
  let r=function(){ durum.cagri++; el.innerHTML=durum.html; el.innerHTML=durum.html; };
  const f=new Function('document','window','_renderListRaw','setTimeout',kod+'\n return _renderListRaw;');
  r=f(doc,win,r,setTimeout);
  return {el,durum,r,olay:e=>(dl[e]||[]).forEach(g=>g())};
}
let g=0,k=0;const T=(a,o,b)=>{const ok=JSON.stringify(o)===JSON.stringify(b);
 ok?(g++,console.log('  ✓ '+a)):(k++,console.log('  ✗ '+a+'  beklenen:'+JSON.stringify(b)+'  olan:'+JSON.stringify(o)))};
const bek=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
console.log('\n═══ 1) SAYFA ACILIRKEN PARMAK BASILI — ilk cizim ERTELENMEZ ═══\n');
{const A=kurulum(); A.durum.html='<div>A</div><div>B</div>';
 A.olay('pointerdown');            // sayfa acilirken basili
 A.r();
 T('ilk cizim YAPILDI (liste bos acilmaz)', A.el.innerHTML, '<div>A</div><div>B</div>');}

console.log('\n═══ 2) NORMAL ACILIS ═══\n');
const B=kurulum(); B.durum.html='<div>A</div><div>B</div>';
B.r();
T('liste dolu', B.el.innerHTML, '<div>A</div><div>B</div>');

console.log('\n═══ 3) TIKLAMA sirasinda cizim ERTELENIR ═══\n');
B.olay('pointerdown');
B.durum.html='<div>YENI</div>';
const c1=B.durum.cagri;
B.r();
T('parmak basiliyken DOM degismedi', B.el.innerHTML, '<div>A</div><div>B</div>');
T('asil cizim cagrilmadi', B.durum.cagri, c1);

console.log('\n═══ 4) PARMAK KALKINCA hemen cizilir ═══\n');
B.olay('pointerup');
T('pointerup sonrasi cizildi', B.el.innerHTML, '<div>YENI</div>');

console.log('\n═══ 5) BEKCI — pointerup HIC gelmezse ═══\n');
B.olay('pointerdown');
B.durum.html='<div>BEKCI</div>';
B.r();
T('once ertelendi', B.el.innerHTML, '<div>YENI</div>');
console.log('      (1200 ms bekleniyor, pointerup YOK)');
await bek(1400);
T('BEKCI cizdi — liste ASLA kalici bos kalmaz', B.el.innerHTML, '<div>BEKCI</div>');

console.log('\n═══ 6) 30 hizli cizim ═══\n');
for(let i=0;i<30;i++){ B.durum.html='<div>tur'+i+'</div>'; B.r(); }
T('son tur cizildi', B.el.innerHTML, '<div>tur29</div>');

console.log('\n═══ 7) TIKLA-BIRAK 20 kez ust uste ═══\n');
for(let i=0;i<20;i++){ B.olay('pointerdown'); B.durum.html='<div>t'+i+'</div>'; B.r(); B.olay('pointerup'); }
T('hepsi cizildi, bos kalmadi', B.el.innerHTML, '<div>t19</div>');

console.log('\n═══ 8) KAYDIRMA korunuyor ═══\n');
B.el.scrollTop=1400; B.durum.html='<div>X</div>'; B.r();
T('scrollTop korundu', B.el.scrollTop, 1400);

console.log('\n═══ SONUC ═══\n  gecen: '+g+'   kalan: '+k+'\n');
process.exit(k?1:0);
})();
