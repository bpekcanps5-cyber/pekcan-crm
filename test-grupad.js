// test-grupad.js — ADSIZ GRUP ADININ DUZELMESI
const fs=require('fs'),path=require('path'),os=require('os');
const G=fs.mkdtempSync(path.join(os.tmpdir(),'gad-'));
fs.mkdirSync(path.join(G,'guvence'),{recursive:true});fs.mkdirSync(path.join(G,'media'),{recursive:true});
process.env.WHAPI_TOKEN='T';process.env.WHAPI_WEBHOOK_SECRET='g';process.env.WHAPI_LINE_ID='whapi';
for(const f of['whapi-hat.js','whapi-cevirici.js','whapi-adapter.js'])
  fs.copyFileSync(path.join(__dirname,f),path.join(G,f));
let grupCevapVersin=false, grupIstek=0;
global.fetch=async u=>{u=String(u);
 if(u.includes('/health'))return{ok:1,status:200,headers:{get:()=>null},
  text:async()=>JSON.stringify({status:{code:4},user:{id:'905399265440'}})};
 if(u.includes('/groups/')){grupIstek++;
  if(!grupCevapVersin)return{ok:false,status:500,headers:{get:()=>null},text:async()=>'{"error":"gecici"}'};
  return{ok:1,status:200,headers:{get:()=>null},
   text:async()=>JSON.stringify({id:'120363161070593814@g.us',name:'CAG MOTORS AYLIK',participants:[]})};}
 if(u.includes('/messages/list'))return{ok:1,status:200,headers:{get:()=>null},text:async()=>'{"messages":[]}'};
 return{ok:1,status:200,headers:{get:()=>null},text:async()=>'{}'};};
const chats=new Map();
const loglar=[];
const B={addMessage:(j,m,meta={})=>{if(!chats.has(j))chats.set(j,{jid:j,name:meta.name||'',messages:[],lastTs:Date.now()});},
 broadcastHat:()=>{},hatChats:()=>chats,stripBirMesaj:m=>m,lines:new Map(),
 createLine:(id,l,o)=>({id,label:l,owner:o,chats:new Map(),sock:null,connected:false,saglik:{}}),
 db:{isReady:()=>1,saveMessage:async()=>{},saveChat:async()=>{},loadAll:async()=>({chats:[]})},
 MEDIA_DIR:path.join(G,'media'),kisiAdiBul:()=>'',ekipUyesiMi:()=>0,log:(...a)=>loglar.push(a.join(' '))};
const yollar={};
const hat=require(path.join(G,'whapi-hat.js'));
const K=hat.kur(B,{post:(y,a,h)=>{yollar[y]=h||a}},{json:()=>(q,s,n)=>n&&n()});
const bek=ms=>new Promise(r=>setTimeout(r,ms));
let g=0,k=0;const T=(a,o,b)=>{const ok=JSON.stringify(o)===JSON.stringify(b);
 ok?(g++,console.log('  ✓ '+a)):(k++,console.log('  ✗ '+a+'  beklenen:'+JSON.stringify(b)+'  olan:'+JSON.stringify(o)))};
const JID='120363161070593814@g.us';

(async()=>{
 await K.hattiBaslat();
 console.log('\n═══ 1) GRUP ADI CEKIMI BASARISIZ ═══\n');
 chats.set(JID,{jid:JID,name:'120363161070593814',messages:[],lastTs:Date.now()});
 grupCevapVersin=false;
 K.grupTazele(JID,true); await bek(300);
 T('ad hala ciplak kimlik', chats.get(JID).name, '120363161070593814');
 const h=loglar.find(x=>x.includes('grup bilgisi alinamadi'));
 T('hata LOGLANDI (eskiden sessizce yutuluyordu)', !!h, true);

 console.log('\n═══ 2) TARAMA yeniden deniyor (eskiden 30 dk beklerdi) ═══\n');
 grupCevapVersin=true;
 const o=grupIstek;
 K.adsizTara(); await bek(400);
 T('yeniden istek atildi', grupIstek>o, true);
 T('AD DUZELDI', chats.get(JID).name, 'CAG MOTORS AYLIK');

 console.log('\n═══ 3) ADI OLAN grup bosuna sorgulanmiyor ═══\n');
 const o2=grupIstek;
 K.adsizTara(); await bek(300);
 T('istek atilmadi', grupIstek, o2);

 console.log('\n═══ 4) adsizMi dogru ayirt ediyor ═══\n');
 chats.clear();
 chats.set('a@g.us',{jid:'a@g.us',name:'120363161070593814',lastTs:Date.now()});
 chats.set('b@g.us',{jid:'b@g.us',name:'',lastTs:Date.now()});
 chats.set('c@g.us',{jid:'c@g.us',name:'ATLAS AUTO 2026',lastTs:Date.now()});
 chats.set('d@g.us',{jid:'d@g.us',name:'34 ABC 123',lastTs:Date.now()});
 grupCevapVersin=true;
 const o3=grupIstek;
 K.adsizTara(); await bek(400);
 T('sadece 2 adsiz grup sorgulandi', grupIstek-o3, 2);

 console.log('\n═══ SONUC ═══\n  gecen: '+g+'   kalan: '+k+'\n');
 process.exit(k?1:0);
})();
