// test-gonderen.js — MUSTERI vs PANEL KULLANICISI ayrimi
const fs=require('fs'),path=require('path'),os=require('os');
const G=fs.mkdtempSync(path.join(os.tmpdir(),'gnd-'));
fs.mkdirSync(path.join(G,'guvence'),{recursive:true});fs.mkdirSync(path.join(G,'media'),{recursive:true});
process.env.WHAPI_TOKEN='T';process.env.WHAPI_WEBHOOK_SECRET='g';process.env.WHAPI_LINE_ID='whapi';
for(const f of['whapi-hat.js','whapi-cevirici.js','whapi-adapter.js'])
  fs.copyFileSync(path.join(__dirname,f),path.join(G,f));
global.fetch=async u=>String(u).includes('/health')
 ?{ok:1,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({status:{code:4},user:{id:'905399265440'}})}
 :{ok:1,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({messages:[]})};

// Rehber: MUSTERI de kayitli, EKIP UYESI de kayitli
const rehber={'905551112233@s.whatsapp.net':'MUSTAFA',            // MUSTERI (ruhsat atan)
              '905554445566@s.whatsapp.net':'Emre Sevindik'};     // EKIP UYESI
const panelKullanicilari=new Set(['emre sevindik']);              // gercek panel listesi
const norm=a=>String(a||'').toLocaleLowerCase('tr-TR').trim();

const now=Date.now();
const ofisChats=new Map([['1@g.us',{jid:'1@g.us',messages:[
  {id:'O1',text:'MEHMETLER OTO GALERI',fromMe:true,sender:'Emre Sevindik',ts:now-500}],lastTs:now}]]);
const wc=new Map();
const B={addMessage:(j,m,meta={})=>{if(!wc.has(j))wc.set(j,{jid:j,messages:[],lastTs:0});
  const c=wc.get(j);if(m.id&&c.messages.some(x=>x.id===m.id))return;c.messages.push(m);c.lastTs=Date.now()},
 broadcastHat:()=>{},hatChats:l=>l==='ofis'?ofisChats:wc,stripBirMesaj:m=>m,
 lines:new Map([['ofis',{id:'ofis',myNumber:'905399265440'}]]),
 createLine:(id,l,o)=>({id,label:l,owner:o,chats:new Map(),sock:null,connected:false,saglik:{}}),
 db:{isReady:()=>1,saveMessage:async()=>{},saveChat:async()=>{},loadAll:async()=>({chats:[]})},
 MEDIA_DIR:path.join(G,'media'),
 kisiAdiBul:j=>rehber[j]||'',
 ekipUyesiMi:a=>panelKullanicilari.has(norm(a)),
 log:()=>{}};
const yollar={};
const hat=require(path.join(G,'whapi-hat.js'));
const K=hat.kur(B,{post:(y,a,h)=>{yollar[y]=h||a}},{json:()=>(q,s,n)=>n&&n()});
const cagir=async b=>{await yollar['/whapi/gelen/:gizli']({params:{gizli:'g'},body:b},
 {status(){return this},json(){return this},end(){return this}})};
const bek=ms=>new Promise(r=>setTimeout(r,ms));
let g=0,k=0;const T=(a,o,b)=>{const ok=JSON.stringify(o)===JSON.stringify(b);
 ok?(g++,console.log('  ✓ '+a)):(k++,console.log('  ✗ '+a+'\n      beklenen: '+JSON.stringify(b)+'\n      olan    : '+JSON.stringify(o)))};
const SN=s=>Math.floor((Date.now()-s*1000)/1000);
const bul=id=>wc.get('1@g.us').messages.find(m=>m.id===id);

(async()=>{
 await K.hattiBaslat();

 console.log('\n═══ 1) MUSTERI (rehberde kayitli ama ekip DEGIL) ═══\n');
 await cagir({messages:[{id:'M1',chat_id:'1@g.us',from:'905551112233',from_name:'Mustafa Bagci',
   type:'image',image:{mime_type:'image/jpeg'},timestamp:SN(1)}]});
 const m1=bul('M1');
 console.log('      gonderen : '+m1.sender);
 T('kayitli ismi gorunuyor', m1.sender, 'MUSTAFA');
 T('EKIP ROZETI YOK (senderOfis)', !!m1.senderOfis, false);
 T('panel cercevesi YOK', !!m1.panelKullanicisi, false);

 console.log('\n═══ 2) EKIP UYESI (gercek panel kullanicisi) ═══\n');
 await cagir({messages:[{id:'E1',chat_id:'1@g.us',from:'905554445566',from_name:'Emre',
   type:'text',text:{body:'ilgileniyorum'},timestamp:SN(1)}]});
 const e1=bul('E1');
 console.log('      gonderen : '+e1.sender);
 T('kayitli ismi gorunuyor', e1.sender, 'Emre Sevindik');
 T('EKIP ROZETI VAR', e1.senderOfis, true);

 console.log('\n═══ 3) REHBERDE OLMAYAN musteri ═══\n');
 await cagir({messages:[{id:'Y1',chat_id:'1@g.us',from:'905559998877',from_name:'Ahmet Yilmaz',
   type:'text',text:{body:'merhaba'},timestamp:SN(1)}]});
 const y1=bul('Y1');
 console.log('      gonderen : '+y1.sender);
 T('WhatsApp adi kullaniliyor', y1.sender, 'Ahmet Yilmaz');
 T('EKIP ROZETI YOK', !!y1.senderOfis, false);

 console.log('\n═══ 4) PANELDEN yazilan mesaj (ayni telefon -> fromMe) ═══\n');
 await cagir({messages:[{id:'P1',chat_id:'1@g.us',from:'905399265440',from_me:true,
   type:'text',text:{body:'MEHMETLER OTO GALERI'},timestamp:Math.floor((now-500)/1000)}]});
 await bek(100);
 const p1=bul('P1');
 console.log('      gonderen : '+p1.sender);
 T('GERCEK panel kullanicisi adi', p1.sender, 'Emre Sevindik');
 T('panel cercevesi VAR', p1.panelKullanicisi, true);

 console.log('\n═══ SONUC ═══\n  gecen: '+g+'   kalan: '+k+'\n');
 process.exit(k?1:0);
})();
