// test-yenileme.js — SICAK YENILEME BAILEYS'E DOKUNUYOR MU
const fs=require('fs'),path=require('path'),os=require('os');
const G=fs.mkdtempSync(path.join(os.tmpdir(),'yen-'));
fs.mkdirSync(path.join(G,'guvence'),{recursive:true});fs.mkdirSync(path.join(G,'media'),{recursive:true});
process.env.WHAPI_TOKEN='T';process.env.WHAPI_WEBHOOK_SECRET='g';process.env.WHAPI_LINE_ID='whapi';
for(const f of['whapi-hat.js','whapi-cevirici.js','whapi-adapter.js'])
  fs.copyFileSync(path.join(__dirname,f),path.join(G,f));
global.fetch=async u=>String(u).includes('/health')
 ?{ok:1,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({status:{code:4},user:{id:'905399265440'}})}
 :{ok:1,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({messages:[]})};

// BAILEYS hattini taklit et — yenileme buna DOKUNMAMALI
const baileys={id:'ofis',myNumber:'905399265440',connected:true,sock:{DOKUNULMADI:true},
  chats:new Map([['1@g.us',{jid:'1@g.us',messages:[{id:'B1',text:'ofis mesaji'}],lastTs:Date.now()}]])};
const whapiChats=new Map();
const B={addMessage:(j,m,meta={})=>{if(!whapiChats.has(j))whapiChats.set(j,{jid:j,messages:[],lastTs:0});
  const c=whapiChats.get(j);if(m.id&&c.messages.some(x=>x.id===m.id))return;c.messages.push(m);c.lastTs=Date.now()},
 broadcastHat:()=>{},hatChats:l=>l==='ofis'?baileys.chats:whapiChats,stripBirMesaj:m=>m,
 lines:new Map([['ofis',baileys]]),
 createLine:(id,l,o)=>({id,label:l,owner:o,chats:new Map(),sock:null,connected:false,saglik:{}}),
 db:{isReady:()=>1,saveMessage:async()=>{},saveChat:async()=>{},loadAll:async()=>({chats:[]})},
 MEDIA_DIR:path.join(G,'media'),kisiAdiBul:()=>'',ekipUyesiMi:()=>0,log:()=>{}};

// Express taklidi: KAC KEZ yol kaydedildigini sayar
const yollar={}; let kayitSayisi=0;
const app={post:(y,a,h)=>{kayitSayisi++;yollar[y]=h||a}};
const express={json:()=>(q,s,n)=>n&&n()};
const hat=require(path.join(G,'whapi-hat.js'));
const K=hat.kur(B,app,express);
const cagir=async(yol,gizli,govde)=>{let kod=0;
 await yollar[yol]({params:{gizli},body:govde},
  {status(x){kod=x;return this},json(){if(!kod)kod=200;return this},end(){if(!kod)kod=200;return this}});
 return kod};
const bek=ms=>new Promise(r=>setTimeout(r,ms));
let g=0,k=0;const T=(a,o,b)=>{const ok=JSON.stringify(o)===JSON.stringify(b);
 ok?(g++,console.log('  ✓ '+a)):(k++,console.log('  ✗ '+a+'\n      beklenen: '+JSON.stringify(b)+'\n      olan    : '+JSON.stringify(o)))};
const SN=()=>Math.floor(Date.now()/1000);
const msj=id=>({id,chat_id:'2@g.us',from:'905111111111',type:'text',text:{body:'m'+id},timestamp:SN()});

(async()=>{
 await K.hattiBaslat();
 const ilkKayit=kayitSayisi;
 console.log('\n═══ 1) YENILEME ONCESI ═══\n');
 await cagir('/whapi/gelen/:gizli','g',{messages:[msj('A1')]});
 T('webhook calisiyor',whapiChats.get('2@g.us').messages.length,1);
 T('yol kayit sayisi (webhook + yenileme)',ilkKayit,2);

 console.log('\n═══ 2) SICAK YENILEME ═══\n');
 const kod=await cagir('/whapi/yenile/:gizli','g',{});
 await bek(200);
 T('yenileme ucu 200 dondu',kod,200);
 T('yol TEKRAR kaydedilmedi',kayitSayisi,ilkKayit);

 console.log('\n═══ 3) BAILEYS DOKUNULMAMIS MI ═══\n');
 T('ofis soketi ayni nesne',baileys.sock.DOKUNULMADI,true);
 T('ofis hala bagli',baileys.connected,true);
 T('ofis mesajlari duruyor',baileys.chats.get('1@g.us').messages.length,1);
 T('lines haritasinda ofis var',B.lines.has('ofis'),true);

 console.log('\n═══ 4) YENILEME SONRASI WEBHOOK CALISIYOR MU ═══\n');
 await cagir('/whapi/gelen/:gizli','g',{messages:[msj('A2')]});
 T('yeni surum mesaji isledi',whapiChats.get('2@g.us').messages.length,2);

 console.log('\n═══ 5) MUKERRER KORUMASI YENILEMEDEN SAG CIKTI MI ═══\n');
 await cagir('/whapi/gelen/:gizli','g',{messages:[msj('A1')]});
 T('eski kimlik hala mukerrer sayiliyor',whapiChats.get('2@g.us').messages.length,2);

 console.log('\n═══ 6) YANLIS GIZLI DIZE ═══\n');
 T('yenileme ucu 404',await cagir('/whapi/yenile/:gizli','yanlis',{}),404);

 console.log('\n═══ 7) IKI KEZ YENILE — kopya zamanlayici olusuyor mu ═══\n');
 await cagir('/whapi/yenile/:gizli','g',{});await bek(150);
 await cagir('/whapi/yenile/:gizli','g',{});await bek(150);
 T('yol sayisi hala ayni',kayitSayisi,ilkKayit);
 await cagir('/whapi/gelen/:gizli','g',{messages:[msj('A3')]});
 T('mesaj TEK kez eklendi (kopya isleyici yok)',whapiChats.get('2@g.us').messages.length,3);

 console.log('\n═══ SONUC ═══\n  gecen: '+g+'   kalan: '+k+'\n');
 process.exit(k?1:0);
})();
