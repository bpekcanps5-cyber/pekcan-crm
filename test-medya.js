// test-medya.js — INMEMIS MEDYA KURTARMA
const fs=require('fs'),path=require('path'),os=require('os');
const G=fs.mkdtempSync(path.join(os.tmpdir(),'med-'));
fs.mkdirSync(path.join(G,'guvence'),{recursive:true});fs.mkdirSync(path.join(G,'media'),{recursive:true});
process.env.WHAPI_TOKEN='T';process.env.WHAPI_WEBHOOK_SECRET='g';process.env.WHAPI_LINE_ID='whapi';
for(const f of['whapi-hat.js','whapi-cevirici.js','whapi-adapter.js'])
  fs.copyFileSync(path.join(__dirname,f),path.join(G,f));
const SN=s=>Math.floor((Date.now()-s*1000)/1000);
const foto=(id,s=0)=>({id,chat_id:'1@g.us',from:'905111111111',from_name:'K',type:'image',
  image:{link:'https://x/f.jpg',mime_type:'image/jpeg',preview:'AAA'},timestamp:SN(s)});
let indirmeBasarili=false, indirmeSayaci=0;
global.fetch=async u=>{u=String(u);
 if(u.includes('/health'))return{ok:1,status:200,headers:{get:()=>null},
  text:async()=>JSON.stringify({status:{code:4},user:{id:'905399265440'}})};
 if(u.includes('/messages/list'))return{ok:1,status:200,headers:{get:()=>null},
  text:async()=>JSON.stringify({messages:liste})};
 if(u.includes('x/f.jpg')){indirmeSayaci++;
  if(!indirmeBasarili) return{ok:false,status:500,headers:{get:()=>null},text:async()=>'kapali'};
  return{ok:1,status:200,headers:{get:n=>n==='content-type'?'image/jpeg':null},
   arrayBuffer:async()=>new ArrayBuffer(16)};}
 return{ok:1,status:200,headers:{get:()=>null},text:async()=>'{}'};};
let liste=[];
const chats=new Map();
let eklemeSayisi=0;
const B={addMessage:(j,m,meta={})=>{
  if(!chats.has(j))chats.set(j,{jid:j,messages:[],lastTs:Date.now()});
  const c=chats.get(j);
  const v=c.messages.find(x=>x.id===m.id);
  if(v){ if(m.mediaUrl!==undefined) v.mediaUrl=m.mediaUrl; return; }  // server.js gibi
  eklemeSayisi++; c.messages.push(m); c.lastTs=Date.now();},
 broadcastHat:()=>{},hatChats:()=>chats,stripBirMesaj:m=>m,lines:new Map(),
 createLine:(id,l,o)=>({id,label:l,owner:o,chats:new Map(),sock:null,connected:false,saglik:{}}),
 db:{isReady:()=>1,saveMessage:async()=>{},saveChat:async()=>{},loadAll:async()=>({chats:[]})},
 MEDIA_DIR:path.join(G,'media'),kisiAdiBul:()=>'',ekipUyesiMi:()=>0,log:()=>{}};
const yollar={};
const hat=require(path.join(G,'whapi-hat.js'));
const K=hat.kur(B,{post:(y,a,h)=>{yollar[y]=h||a}},{json:()=>(q,s,n)=>n&&n()});
const cagir=async b=>{await yollar['/whapi/gelen/:gizli']({params:{gizli:'g'},body:b},
 {status(){return this},json(){return this},end(){return this}})};
const bek=ms=>new Promise(r=>setTimeout(r,ms));
let g=0,k=0;const T=(a,o,b)=>{const ok=JSON.stringify(o)===JSON.stringify(b);
 ok?(g++,console.log('  ✓ '+a)):(k++,console.log('  ✗ '+a+'  beklenen:'+JSON.stringify(b)+'  olan:'+JSON.stringify(o)))};
const m1=()=>chats.get('1@g.us').messages[0];

(async()=>{
 await K.hattiBaslat();
 console.log('\n═══ 1) FOTO GELDI ama indirme BASARISIZ ═══\n');
 indirmeBasarili=false;
 await cagir({messages:[foto('F1',60)]});
 await bek(200);
 T('mesaj panele eklendi', chats.get('1@g.us').messages.length, 1);
 T('mediaUrl BOS (foto inmedi)', m1().mediaUrl, null);

 console.log('\n═══ 2) ESKI DAVRANIS: cekim mukerrer deyip GECERDI ═══\n');
 liste=[foto('F1',60)];
 indirmeBasarili=true;              // artik indirilebilir
 const oncekiIndirme=indirmeSayaci;
 await K.cekim(); await bek(300);
 T('indirme YENIDEN denendi', indirmeSayaci>oncekiIndirme, true);
 T('FOTO GELDI (mediaUrl doldu)', typeof m1().mediaUrl==='string' && m1().mediaUrl.length>0, true);

 console.log('\n═══ 3) MESAJ IKINCI KEZ EKLENMEDI ═══\n');
 T('panelde hala 1 mesaj', chats.get('1@g.us').messages.length, 1);
 T('addMessage yeni kayit acmadi', eklemeSayisi, 1);

 console.log('\n═══ 4) MEDYA INDIKTEN SONRA bir daha denenmiyor ═══\n');
 const s2=indirmeSayaci;
 await K.cekim(); await bek(200);
 await K.cekim(); await bek(200);
 T('bosuna indirme YOK (sonsuz dongu yok)', indirmeSayaci, s2);

 console.log('\n═══ 5) METIN mesajda kurtarma tetiklenmiyor ═══\n');
 await cagir({messages:[{id:'T1',chat_id:'1@g.us',from:'905111111111',type:'text',
   text:{body:'merhaba'},timestamp:SN(5)}]});
 liste=[{id:'T1',chat_id:'1@g.us',from:'905111111111',type:'text',
   text:{body:'merhaba'},timestamp:SN(5)}];
 const s3=indirmeSayaci;
 await K.cekim(); await bek(200);
 T('metin icin indirme denenmedi', indirmeSayaci, s3);

 console.log('\n═══ SONUC ═══\n  gecen: '+g+'   kalan: '+k+'\n');
 process.exit(k?1:0);
})();
