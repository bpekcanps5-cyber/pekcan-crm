// test-cekim.js — SUREKLI CEKIM
const fs=require('fs'),path=require('path'),os=require('os');
const G=fs.mkdtempSync(path.join(os.tmpdir(),'cekim-'));
fs.mkdirSync(path.join(G,'guvence'),{recursive:true});fs.mkdirSync(path.join(G,'media'),{recursive:true});
process.env.WHAPI_TOKEN='T';process.env.WHAPI_WEBHOOK_SECRET='g';process.env.WHAPI_LINE_ID='whapi';
process.env.WHAPI_CEKIM_SN='1';
for(const f of['whapi-hat.js','whapi-cevirici.js','whapi-adapter.js'])
  fs.copyFileSync(path.join(__dirname,f),path.join(G,f));
const SN=s=>Math.floor((Date.now()-s*1000)/1000);
const msj=(id,t,s=0,jid='1@g.us')=>({id,chat_id:jid,from:'905111111111',from_name:'Kadir',
  type:'text',text:{body:t},timestamp:SN(s),chat_name:'CAG MOTORS'});

let genelVar=true, genelListe=[], sohbetListe=[], hizSiniri=false;
const istek={genel:0,sohbet:0};
global.fetch=async(u)=>{u=String(u);
 if(u.includes('/health'))return{ok:1,status:200,headers:{get:()=>null},
   text:async()=>JSON.stringify({status:{code:4,text:'AUTH'},user:{id:'905399265441'}})};
 if(u.includes('/messages/list')){
   if(hizSiniri)return{ok:false,status:429,headers:{get:()=>null},text:async()=>'{"error":"too many"}'};
   const sohbetli=/\/messages\/list\/[^?]/.test(u);
   if(!sohbetli){istek.genel++;
     if(!genelVar)return{ok:false,status:404,headers:{get:()=>null},text:async()=>'{"error":"not found"}'};
     return{ok:1,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({messages:genelListe})};}
   istek.sohbet++;
   return{ok:1,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({messages:sohbetListe})};}
 if(u.includes('/groups/'))return{ok:1,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({id:'1@g.us',name:'CAG MOTORS'})};
 return{ok:1,status:200,headers:{get:()=>null},text:async()=>'{}'};};

const chats=new Map(),loglar=[];
const B={addMessage:(j,m,meta={})=>{if(!chats.has(j))chats.set(j,{jid:j,name:meta.name||'',messages:[],lastTs:0});
  const c=chats.get(j);if(m.id&&c.messages.some(x=>x.id===m.id))return;
  m.ts=(typeof m.ts==='number'&&m.ts>0)?m.ts:Date.now();c.messages.push(m);c.lastTs=Date.now();},
 broadcastHat:()=>{},hatChats:()=>chats,stripBirMesaj:m=>m,lines:new Map(),
 createLine:(id,l,o)=>({id,label:l,owner:o,chats:new Map(),sock:null,connected:false,saglik:{}}),
 db:{isReady:()=>1,saveMessage:async()=>{},saveChat:async()=>{},loadAll:async()=>({chats:[]})},
 MEDIA_DIR:path.join(G,'media'),kisiAdiBul:()=>'',ekipUyesiMi:()=>0,log:(...a)=>loglar.push(a.join(' '))};
const yollar={};
const hat=require(path.join(G,'whapi-hat.js'));
const K=hat.kur(B,{post:(y,a,h)=>{yollar[y]=h}},{json:()=>(q,s,n)=>n&&n()});
const bek=ms=>new Promise(r=>setTimeout(r,ms));
let g=0,k=0;const T=(a,o,b)=>{const ok=JSON.stringify(o)===JSON.stringify(b);
 ok?(g++,console.log('  ✓ '+a)):(k++,console.log('  ✗ '+a+'\n      beklenen: '+JSON.stringify(b)+'\n      olan    : '+JSON.stringify(o)))};
const mt=j=>chats.get(j)?chats.get(j).messages.map(m=>m.text):[];

(async()=>{
 await K.hattiBaslat();

 console.log('\n═══ 1) GENEL KIP: webhook HIC calismasa da mesaj geliyor ═══\n');
 genelListe=[msj('G1','webhook hic gelmedi ama BU GELDI',3),msj('G2','bu da',2)];
 await K.cekim();
 T('kip GENEL secildi',K.cekimKip(),'genel');
 T('webhook olmadan 2 mesaj geldi',mt('1@g.us'),['webhook hic gelmedi ama BU GELDI','bu da']);

 console.log('\n═══ 2) MUKERRER URETMIYOR (10 tur) ═══\n');
 for(let i=0;i<10;i++) await K.cekim();
 T('10 tur sonrasi hala 2 mesaj',mt('1@g.us').length,2);
 const idler=chats.get('1@g.us').messages.map(m=>m.id);
 T('kimlikler benzersiz',idler.length,new Set(idler).size);

 console.log('\n═══ 3) YENI MESAJ 1 SANIYEDE DUSUYOR ═══\n');
 genelListe=genelListe.concat([msj('G3','yeni mesaj',0)]);
 const t0=Date.now();
 await bek(1300);
 T('yeni mesaj cekimle geldi',mt('1@g.us').includes('yeni mesaj'),true);
 console.log('      gecen sure: '+(Date.now()-t0)+' ms');

 console.log('\n═══ 4) GENEL UC YOKSA SOHBET KIPINE DUSUYOR ═══\n');
 chats.clear();loglar.length=0;genelVar=false;
 chats.set('1@g.us',{jid:'1@g.us',name:'CAG MOTORS',messages:[],lastTs:Date.now()});
 sohbetListe=[msj('S1','sohbet kipiyle geldi',5)];
 await K.cekim();await K.cekim();
 T('kip SOHBETe dustu',K.cekimKip(),'sohbet');
 T('sohbet kipinde de mesaj geliyor',mt('1@g.us').includes('sohbet kipiyle geldi'),true);
 const kd=loglar.find(l=>l.includes('kipi: SOHBET'));
 console.log('      '+(kd||''));

 console.log('\n═══ 5) 429 GELINCE GERI CEKILIYOR ═══\n');
 loglar.length=0;hizSiniri=true;
 await K.cekim();await K.cekim();
 const hs=loglar.filter(l=>l.includes('HIZ SINIRI'));
 T('429 yakalandi, aralik acildi',hs.length>=1,true);
 console.log('      '+(hs[0]||''));
 hizSiniri=false;

 console.log('\n═══ 6) ISTEK YUKU ═══\n');
 console.log('      genel uc istegi : '+istek.genel);
 console.log('      sohbet istegi   : '+istek.sohbet);
 console.log('      GENEL kipte 1 sn = saniyede 1 istek (tum sohbetler)');

 console.log('\n═══ SONUC ═══\n  gecen: '+g+'   kalan: '+k+'\n');
 process.exit(k?1:0);
})();
