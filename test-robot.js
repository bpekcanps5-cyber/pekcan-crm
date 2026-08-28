// test-robot.js — ROBOT ARTIK YANLIS GRUBA MESAJ ATAMAZ
const fs=require('fs'),path=require('path'),os=require('os');
const G=fs.mkdtempSync(path.join(os.tmpdir(),'robot-'));
fs.mkdirSync(path.join(G,'guvence'),{recursive:true});fs.mkdirSync(path.join(G,'media'),{recursive:true});
process.env.WHAPI_TOKEN='T';process.env.WHAPI_WEBHOOK_SECRET='g';process.env.WHAPI_LINE_ID='whapi';
for(const f of['whapi-hat.js','whapi-cevirici.js','whapi-adapter.js'])
  fs.copyFileSync(path.join(__dirname,f),path.join(G,f));
const SN=s=>Math.floor((Date.now()-s*1000)/1000);
const pdf=(id,jid,s=0)=>({id,chat_id:jid,from:'905111111111',from_name:'K',type:'document',
  document:{link:'https://x/f.pdf',mime_type:'application/pdf',file_name:'dekont.pdf'},timestamp:SN(s)});
global.fetch=async u=>{u=String(u);
 if(u.includes('/health'))return{ok:1,status:200,headers:{get:()=>null},
  text:async()=>JSON.stringify({status:{code:4},user:{id:'905399265441'}})};
 if(u.includes('/messages/list'))return{ok:1,status:200,headers:{get:()=>null},
  text:async()=>JSON.stringify({messages:eskiler})};
 if(u.includes('x/f.pdf'))return{ok:1,status:200,headers:{get:n=>n==='content-type'?'application/pdf':null},
  arrayBuffer:async()=>new ArrayBuffer(8)};
 return{ok:1,status:200,headers:{get:()=>null},text:async()=>'{}'};};
let eskiler=[];
const chats=new Map();
const robotCagrilari=[];
const B={addMessage:(j,m,meta={})=>{if(!chats.has(j))chats.set(j,{jid:j,messages:[],lastTs:Date.now()});
  const c=chats.get(j);if(m.id&&c.messages.some(x=>x.id===m.id))return;c.messages.push(m);c.lastTs=Date.now();},
 broadcastHat:()=>{},hatChats:()=>chats,stripBirMesaj:m=>m,lines:new Map(),
 createLine:(id,l,o)=>({id,label:l,owner:o,chats:new Map(),sock:null,connected:false,saglik:{}}),
 db:{isReady:()=>1,saveMessage:async()=>{},saveChat:async()=>{},loadAll:async()=>({chats:[]})},
 MEDIA_DIR:path.join(G,'media'),kisiAdiBul:()=>'',ekipUyesiMi:()=>0,log:()=>{},
 robotMedyaGeldi:(a)=>robotCagrilari.push(a)};
const yollar={};
const hat=require(path.join(G,'whapi-hat.js'));
const K=hat.kur(B,{post:(y,a,h)=>{yollar[y]=h}},{json:()=>(q,s,n)=>n&&n()});
const cagir=async b=>{await yollar['/whapi/gelen/:gizli']({params:{gizli:'g'},body:b},
 {status(){return this},json(){return this},end(){return this}})};
const bek=ms=>new Promise(r=>setTimeout(r,ms));
let g=0,k=0;const T=(a,o,b)=>{const ok=JSON.stringify(o)===JSON.stringify(b);
 ok?(g++,console.log('  ✓ '+a)):(k++,console.log('  ✗ '+a+'\n      beklenen: '+JSON.stringify(b)+'\n      olan    : '+JSON.stringify(o)))};
(async()=>{
 await K.hattiBaslat();
 console.log('\n═══ 1) CEKIM/TELAFI ESKI BELGELERI ROBOTA VERMEZ ═══\n');
 console.log(' 5 ayri grupta 2 gun onceki PDF var, cekim hepsini geri getiriyor:');
 eskiler=['1@g.us','2@g.us','3@g.us','4@g.us','5@g.us'].map((j,i)=>pdf('E'+i,j,2*24*3600));
 for(const j of ['1@g.us','2@g.us','3@g.us','4@g.us','5@g.us'])
   chats.set(j,{jid:j,messages:[],lastTs:Date.now()});
 await K.cekim(); await bek(400);
 T('robot HIC tetiklenmedi (eskiden 5 gruba mesaj atardi)',robotCagrilari.length,0);

 console.log('\n═══ 2) WHAPI_ROBOT=0 iken CANLI belge de tetiklemez ═══\n');
 robotCagrilari.length=0;
 await cagir({messages:[pdf('C1','1@g.us',0)]}); await bek(400);
 T('acil kapatma calisiyor',robotCagrilari.length,0);

 console.log('\n═══ 3) WHAPI_ROBOT=1 iken SADECE canli+taze belge tetikler ═══\n');
 delete require.cache[path.join(G,'whapi-hat.js')];
 process.env.WHAPI_ROBOT='1';
 const yollar2={};
 const hat2=require(path.join(G,'whapi-hat.js'));
 const robot2=[];
 const B2={...B,robotMedyaGeldi:a=>robot2.push(a)};
 const K2=hat2.kur(B2,{post:(y,a,h)=>{yollar2[y]=h}},{json:()=>(q,s,n)=>n&&n()});
 await K2.hattiBaslat();
 const cagir2=async b=>{await yollar2['/whapi/gelen/:gizli']({params:{gizli:'g'},body:b},
  {status(){return this},json(){return this},end(){return this}})};
 await cagir2({messages:[pdf('Y1','1@g.us',0)]}); await bek(400);
 T('CANLI + TAZE belge robota gitti',robot2.length,1);
 T('dogru gruba gitti',robot2[0]&&robot2[0].jid,'1@g.us');

 robot2.length=0;
 await cagir2({messages:[pdf('Y2','2@g.us',3600)]}); await bek(400);   // 1 saat once
 T('CANLI ama ESKI (1 saat) belge gitmedi',robot2.length,0);

 robot2.length=0;
 eskiler=[pdf('Y3','3@g.us',2*24*3600)];
 await K2.cekim(); await bek(400);
 T('CEKIM ile gelen belge gitmedi',robot2.length,0);

 console.log('\n═══ SONUC ═══\n  gecen: '+g+'   kalan: '+k+'\n');
 process.exit(k?1:0);
})();
