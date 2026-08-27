// whapi-hat.js testi. server.js SAHTE, ag SAHTE, disk GERCEK (gecici klasor).
const fs = require('fs');
const path = require('path');
const os = require('os');

const GECICI = fs.mkdtempSync(path.join(os.tmpdir(), 'whapitest-'));
fs.mkdirSync(path.join(GECICI, 'guvence'), { recursive: true });
fs.mkdirSync(path.join(GECICI, 'media'), { recursive: true });

process.env.WHAPI_TOKEN = 'GIZLI_TOKEN_123';
process.env.WHAPI_WEBHOOK_SECRET = 'dogru-gizli-dize';
process.env.WHAPI_LINE_ID = 'whapi';

// __dirname'i gecici klasore cevir ki guvence dosyasi oraya yazilsin
const gercekYol = path.join(__dirname, 'whapi-hat.js');
let kaynak = fs.readFileSync(gercekYol, 'utf8');
kaynak = kaynak.replace("require('./whapi-cevirici')", JSON.stringify(path.join(__dirname, 'whapi-cevirici.js')).replace(/^"|"$/g, "'").replace(/^/, "require('").replace(/$/, "')").replace("require('require('", "require('").replace("')')", "')"));
fs.writeFileSync(path.join(GECICI, 'whapi-hat.js'), fs.readFileSync(gercekYol, 'utf8'));
fs.copyFileSync(path.join(__dirname, 'whapi-cevirici.js'), path.join(GECICI, 'whapi-cevirici.js'));
fs.copyFileSync(path.join(__dirname, 'whapi-adapter.js'), path.join(GECICI, 'whapi-adapter.js'));

// ── SAHTE AG ──
let indirilenler = 0;
global.fetch = async (url, ayar = {}) => {
  if (String(url).includes('/health')) {
    return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ channel_id: 'THOROD-HWYTD', uptime: 100, status: { code: 4, text: 'AUTH' }, user: { id: '905458126770' } }) };
  }
  if (String(url).includes('wasabisys.com')) {
    indirilenler += 1;
    const veri = Buffer.from('SAHTE-DOSYA-ICERIGI');
    return { ok: true, status: 200,
      headers: { get: (h) => (h === 'content-length' ? String(veri.length) : 'application/pdf') },
      arrayBuffer: async () => veri };
  }
  if (String(url).includes('/groups/')) {
    return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ id: '120363423265440017@g.us', name: 'VOLKAN AYDEMİR - sigortası', description: 'grup aciklamasi',
        participants: [{ id: '905458126770', rank: 'creator' }, { id: '905399265441', rank: 'member' }] }) };
  }
  if (String(url).includes('/messages/')) {
    return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ sent: true, message: { id: 'WHAPI_GIDEN_1' } }) };
  }
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
};

// ── SAHTE server.js BAGLAMI ──
const cagrilar = { addMessage: [], broadcast: [], saveMessage: [], saveChat: [] };
const chats = new Map();

function sahteAddMessage(jid, message, meta = {}, lineId) {
  cagrilar.addMessage.push({ jid, id: message.id, kind: message.kind, mediaUrl: message.mediaUrl, lineId });
  if (!chats.has(jid)) chats.set(jid, { jid, name: meta.name || '', isGroup: !!meta.isGroup, messages: [], description: '', memberCount: 0 });
  const chat = chats.get(jid);
  const varolan = chat.messages.find((x) => x.id === message.id);
  if (varolan) { if (message.mediaUrl) varolan.mediaUrl = message.mediaUrl; return; }
  chat.messages.push({ ...message });
  if (meta.name) chat.name = meta.name;
}

const baglam = {
  addMessage: sahteAddMessage,
  broadcastHat: (lineId, obj) => cagrilar.broadcast.push({ lineId, type: obj.type }),
  hatChats: () => chats,
  stripBirMesaj: (m) => { const { raw, key, ...r } = m; return r; },
  lines: new Map(),
  createLine: (id, label, owner) => ({ id, label, owner, chats: new Map(), sock: null, connected: false, saglik: {} }),
  db: {
    isReady: () => true,
    saveMessage: async (jid, m, l) => { cagrilar.saveMessage.push({ jid, id: m.id, l }); },
    saveChat: async (c, l) => { cagrilar.saveChat.push({ jid: c.jid, l }); },
    loadAll: async () => ({ chats: [] }),
  },
  MEDIA_DIR: path.join(GECICI, 'media'),
  kisiAdiBul: (jid) => (String(jid).startsWith('905111111111') ? 'YUSUF (OFIS)' : ''),
  ekipUyesiMi: (ad) => ad === 'MOTOR TEST',
  log: () => {},
};

// ── SAHTE EXPRESS ──
const yollar = {};
const sahteApp = { post: (yol, ara, isleyici) => { yollar[yol] = isleyici; } };
const sahteExpress = { json: () => (req, res, next) => next && next() };

async function cagir(gizli, govde) {
  const isleyici = yollar['/whapi/gelen/:gizli'];
  let kod = 0, cevap = null;
  const res = { status(k) { kod = k; return this; }, json(v) { if (!kod) kod = 200; cevap = v; return this; }, end() { if (!kod) kod = 200; return this; } };
  await isleyici({ params: { gizli }, body: govde }, res);
  return { kod, cevap };
}

// ── TESTLER ──
let gecti = 0, kaldi = 0;
function bekle(ad, olan, beklenen) {
  const ok = JSON.stringify(olan) === JSON.stringify(beklenen);
  if (ok) { gecti++; console.log('  ✓ ' + ad); }
  else { kaldi++; console.log('  ✗ ' + ad + '\n      beklenen: ' + JSON.stringify(beklenen) + '\n      olan    : ' + JSON.stringify(olan)); }
}

const hat = require(path.join(GECICI, 'whapi-hat.js'));
const kurulum = hat.kur(baglam, sahteApp, sahteExpress);

const METIN = JSON.parse(fs.readFileSync(path.join(__dirname, 'ornek.jsonl'), 'utf8').split('\n')[0]);
const BELGE = JSON.parse(fs.readFileSync(path.join(__dirname, 'ornek.jsonl'), 'utf8').split('\n').find((s) => s.includes('"document"')));
const TEPKI = JSON.parse(fs.readFileSync(path.join(__dirname, 'ornek.jsonl'), 'utf8').split('\n').find((s) => s.includes('"reaction"')));
const SIL = JSON.parse(fs.readFileSync(path.join(__dirname, 'ornek.jsonl'), 'utf8').split('\n').find((s) => s.includes('"delete"')));

const bekleMs = (n) => new Promise((c) => setTimeout(c, n));

(async () => {
  console.log('═══ HAT BASLATMA (once bu olmali) ═══\n');
  const line = await kurulum.hattiBaslat();
  bekle('line olustu', !!line, true);
  bekle('motor isaretlendi', line.motor, 'whapi');
  bekle('line.sock DOLU', !!line.sock, true);
  bekle('bagli', line.connected, true);
  bekle('kendi numarasi', line.myNumber, '905458126770');
  bekle('QR YOK', line.lastQR, null);

  console.log('\n═══ WEBHOOK UCU ═══\n');

  console.log(' Guvenlik:');
  let r = await cagir('yanlis-dize', METIN);
  bekle('yanlis gizli dize -> 404', r.kod, 404);
  bekle('yanlis dizede mesaj ISLENMEDI', cagrilar.addMessage.length, 0);

  console.log('\n Normal mesaj:');
  r = await cagir('dogru-gizli-dize', METIN);
  bekle('dogru dize -> 200', r.kod, 200);
  bekle('addMessage cagrildi', cagrilar.addMessage.length, 1);
  bekle('dogru hatta gitti', cagrilar.addMessage[0].lineId, 'whapi');
  bekle('dogru jid', cagrilar.addMessage[0].jid, '120363423265440017@g.us');

  console.log('\n MUKERRER (Whapi 24 kez tekrar deneyebilir):');
  r = await cagir('dogru-gizli-dize', METIN);
  bekle('ikinci kez 200 doner (Whapi pes etsin)', r.kod, 200);
  bekle('ama addMessage TEKRAR cagrilmadi', cagrilar.addMessage.length, 1);

  console.log('\n Kalici mukerrer korumasi (surec yeniden baslasa da):');
  const dosya = path.join(GECICI, 'guvence', 'whapi-gorulen.txt');
  // DAVRANIS DEGISTI (2026-08): diske yazma artik TAMPONLU ve ASENKRON.
  // Sicak yolda fs.appendFileSync vardi; saniyede bir cekim yapinca olay
  // dongusunu kilitliyordu. Kimlik bellege ANINDA giriyor (mukerrer korumasi
  // hemen aktif), disk yazmasi tamponlaniyor. Testte tamponu elle bosaltiyoruz;
  // gercekte 2 saniyede bir, 50 kimlikte bir ve surec kapanirken bosaliyor.
  kurulum.bosalt();
  await bekleMs(60);
  bekle('gorulen kimlik diske yazildi', fs.existsSync(dosya), true);
  bekle('dosyada mesaj kimligi var', fs.readFileSync(dosya, 'utf8').includes('KjtJaYFqP.PbwA-guABq53lT6_BEQ'), true);

  console.log('\n Belge + medya indirme:');
  const oncekiIndirme = indirilenler;
  await cagir('dogru-gizli-dize', BELGE);
  bekle('belge mesaji eklendi', cagrilar.addMessage.length, 2);
  bekle('mesaj mediaUrl BEKLEMEDI (once null)', cagrilar.addMessage[1].mediaUrl, null);
  await new Promise((c) => setTimeout(c, 250));
  bekle('medya arka planda indirildi', indirilenler > oncekiIndirme, true);
  bekle('addMessage mediaUrl ile TEKRAR cagrildi', cagrilar.addMessage.length, 3);
  const url = cagrilar.addMessage[2].mediaUrl;
  console.log('   -> ' + url);
  bekle('uzanti dosya adindan alindi (.docx)', String(url).endsWith('.docx'), true);
  bekle('dosya gercekten diske yazildi', fs.existsSync(path.join(GECICI, 'media', String(url).replace('/media/', ''))), true);

  console.log('\n Tepki (yeni mesaj OLUSTURMAMALI):');
  const oncekiMesaj = cagrilar.addMessage.length;
  // hedef mesaji once ekleyelim
  sahteAddMessage('120363423265440017@g.us', { id: 'pSjUcKSo4SLCXN9uNpzGkg-wgIBq53lT6_BEQ', kind: 'text', text: 'hedef' }, {}, 'whapi');
  const oncekiKayit = cagrilar.saveMessage.length;
  await cagir('dogru-gizli-dize', TEPKI);
  bekle('yeni mesaj eklenmedi', cagrilar.addMessage.length, oncekiMesaj + 1);
  const hedef = chats.get('120363423265440017@g.us').messages.find((m) => m.id === 'pSjUcKSo4SLCXN9uNpzGkg-wgIBq53lT6_BEQ');
  bekle('hedef mesaja emoji islendi', hedef.reaction, '👍');
  bekle('DB\'ye yazildi (yenileyince kaybolmasin)', cagrilar.saveMessage.length > oncekiKayit, true);

  console.log('\n Silme:');
  sahteAddMessage('120363423265440017@g.us', { id: 'Kg_x0N.fsFX58w-gr4Bq53lT6_BEQ', kind: 'image', text: 'silinecek' }, {}, 'whapi');
  await cagir('dogru-gizli-dize', SIL);
  const silinen = chats.get('120363423265440017@g.us').messages.find((m) => m.id === 'Kg_x0N.fsFX58w-gr4Bq53lT6_BEQ');
  bekle('deleted isaretlendi', silinen.deleted, true);
  bekle('metin temizlendi', silinen.text, '');

  console.log('\n Hedefi olmayan tepki (bellekte yok) — COKMEMELI:');
  const yetim = JSON.parse(JSON.stringify(TEPKI));
  yetim.messages[0].action.target = 'HIC_OLMAYAN_ID';
  yetim.messages[0].id = 'yetim1';
  r = await cagir('dogru-gizli-dize', yetim);
  bekle('yine 200 doner', r.kod, 200);

  console.log('\n Bozuk govde — COKMEMELI:');
  r = await cagir('dogru-gizli-dize', { bozuk: true });
  bekle('bos zarf 200', r.kod, 200);
  r = await cagir('dogru-gizli-dize', null);
  bekle('null govde 200', r.kod, 200);

  console.log('\n KENDI HATLARIMIZ (ofis Baileys mesaji musteri gibi gorunmesin):');
  // ofis hattini lines'a ekle — gercekte server.js ekliyor
  baglam.lines.set('ofis', { id: 'ofis', myNumber: '905399265440', chats: new Map() });
  const yap = (frm, ad) => ({ messages: [{ id: 'S_' + frm, chat_id: '120363423265440017@g.us', type: 'text', timestamp: Math.floor(Date.now() / 1000), from: frm, from_name: ad, text: { body: 'x' }, chat_name: 'G' }] });

  await cagir('dogru-gizli-dize', yap('905399265440', 'OPERASYON MERKEZİ'));
  const ofisMsj = chats.get('120363423265440017@g.us').messages.find((m) => m.id === 'S_905399265440');
  bekle('ofis Baileys hatti EKIP olarak isaretlendi', ofisMsj.senderOfis, true);

  await cagir('dogru-gizli-dize', yap('905111111111', 'yusuf'));
  const kayitli = chats.get('120363423265440017@g.us').messages.find((m) => m.id === 'S_905111111111');
  bekle('rehberde kayitli kisi EKIP sayildi', kayitli.senderOfis, true);
  bekle('KAYITLI isim pushName yerine kullanildi', kayitli.sender, 'YUSUF (OFIS)');

  await cagir('dogru-gizli-dize', yap('905999888777', 'Bilinmeyen Musteri'));
  const musteri = chats.get('120363423265440017@g.us').messages.find((m) => m.id === 'S_905999888777');
  bekle('gercek musteri EKIP DEGIL', !!musteri.senderOfis, false);
  bekle('musteri adi korundu', musteri.sender, 'Bilinmeyen Musteri');

  console.log('\n AYNI METIN IKI KEZ YAZILIRSA IKISI DE DUSMELI (mesaj kaybi olmasin):');
  const n0 = cagrilar.addMessage.length;
  const cizgi = (id) => ({ messages: [{ id, chat_id: '120363423265440017@g.us', type: 'text', timestamp: Math.floor(Date.now() / 1000), from: '905393793449', from_name: 'Volkan', text: { body: '------------' } }] });
  await cagir('dogru-gizli-dize', cizgi('CIZGI_1'));
  await cagir('dogru-gizli-dize', cizgi('CIZGI_2'));
  bekle('iki ayri cizgi de eklendi', cagrilar.addMessage.length, n0 + 2);
  const cizgiler = chats.get('120363423265440017@g.us').messages.filter((m) => m.text === '------------');
  bekle('sohbette IKI kayit var', cizgiler.length, 2);

  console.log('\n Ayni KIMLIK iki kez gelirse elenmeli:');
  const n1 = cagrilar.addMessage.length;
  await cagir('dogru-gizli-dize', cizgi('CIZGI_1'));
  bekle('mukerrer kimlik elendi', cagrilar.addMessage.length, n1);

  console.log('\n DIGER PANELDEN YAZAN KISININ ADI (WhatsApp hesap adi degil):');
  // ofis hatti ayni mesaji PANEL KULLANICISININ adiyla kaydetmis
  const ofisChats = new Map();
  const simdiMs = Date.now();
  // GERCEK DURUM: ofis hattinda BASKA bir kimlik var (3EB0...), whapi'de PrAY...
  ofisChats.set('120363423265440017@g.us', { jid: '120363423265440017@g.us', messages: [
    { id: '3EB018852634E3927CF54A', fromMe: true, sender: 'Emrecan Say', text: 'poliçe kesildi', ts: simdiMs - 650 },
    { id: '3EB0658AB54121DC2F6780', fromMe: true, sender: 'Efe Rıza', text: 'zeyil yapıldı', ts: simdiMs - 40000 },
  ] });
  baglam.lines.set('ofis', { id: 'ofis', myNumber: '905399265440', chats: ofisChats });
  const eskiHatChats = baglam.hatChats;
  baglam.hatChats = (lid) => (lid === 'ofis' ? ofisChats : chats);

  await cagir('dogru-gizli-dize', { messages: [{ id: 'PrAYhSY045J89Uo-gl4', chat_id: '120363423265440017@g.us', type: 'text', timestamp: Math.floor(simdiMs / 1000), from: '905399265440', from_name: 'OPERASYON MERKEZİ', text: { body: 'poliçe kesildi' } }] });
  const gelen = chats.get('120363423265440017@g.us').messages.find((m) => m.id === 'PrAYhSY045J89Uo-gl4');
  bekle('FARKLI kimlige ragmen panel kullanicisi bulundu', gelen.sender, 'Emrecan Say');
  bekle('ekip rozeti kondu', gelen.senderOfis, true);

  console.log('\n AYNI CIZGIYI IKI KISI CEKERSE HERKESE KENDI ADI (kritik):');
  const t0 = Date.now();
  ofisChats.get('120363423265440017@g.us').messages.push(
    { id: '3EB0_ERTAN', fromMe: true, sender: 'Ertan', text: '-------------', ts: t0 - 600 },
    { id: '3EB0_EFE',   fromMe: true, sender: 'Efe Rıza', text: '-------------', ts: t0 + 3000 },
  );
  // Ertan'in cizgisi once dusuyor
  await cagir('dogru-gizli-dize', { messages: [{ id: 'W_ERTAN', chat_id: '120363423265440017@g.us', type: 'text', timestamp: Math.floor(t0 / 1000), from: '905399265440', from_name: 'OPERASYON MERKEZİ', text: { body: '-------------' } }] });
  // Efe'nin cizgisi 3 saniye sonra
  await cagir('dogru-gizli-dize', { messages: [{ id: 'W_EFE', chat_id: '120363423265440017@g.us', type: 'text', timestamp: Math.floor((t0 + 3600) / 1000), from: '905399265440', from_name: 'OPERASYON MERKEZİ', text: { body: '-------------' } }] });
  const mE = chats.get('120363423265440017@g.us').messages.find((m) => m.id === 'W_ERTAN');
  const mF = chats.get('120363423265440017@g.us').messages.find((m) => m.id === 'W_EFE');
  bekle('birinci cizgi -> Ertan', mE.sender, 'Ertan');
  bekle('ikinci cizgi -> Efe Rıza (karismadi)', mF.sender, 'Efe Rıza');

  console.log('\n Zaman penceresi DISINDA ayni metin ESLESMEMELI:');
  await cagir('dogru-gizli-dize', { messages: [{ id: 'ESKI_ES_1', chat_id: '120363423265440017@g.us', type: 'text', timestamp: Math.floor(simdiMs / 1000), from: '905399265440', from_name: 'OPERASYON MERKEZİ', text: { body: 'zeyil yapıldı' } }] });
  const uzak = chats.get('120363423265440017@g.us').messages.find((m) => m.id === 'ESKI_ES_1');
  bekle('40sn onceki mesajla eslesmedi', uzak.sender, 'OPERASYON MERKEZİ');

  console.log('\n Panelde OLMAYAN kisi (gercek musteri) DEGISMEMELI:');
  await cagir('dogru-gizli-dize', { messages: [{ id: 'MUSTERI_1', chat_id: '120363423265440017@g.us', type: 'text', timestamp: Math.floor(Date.now() / 1000), from: '905999000111', from_name: 'Ahmet Bey', text: { body: 'merhaba' } }] });
  const mus = chats.get('120363423265440017@g.us').messages.find((m) => m.id === 'MUSTERI_1');
  bekle('musteri adi korundu', mus.sender, 'Ahmet Bey');
  bekle('musteri ekip DEGIL', !!mus.senderOfis, false);
  baglam.hatChats = eskiHatChats;

  console.log('\n ACIKLAMA: Whapi vermiyorsa OFIS hattindan tamamla:');
  let ofisSoruldu = 0;
  // Artik DOGRUDAN ofis soketine soruluyor (kuyruk yok, daha hizli)
  const ofisSoket = { groupMetadata: async () => { ofisSoruldu++; return { subject: 'G', desc: 'BAILEYS ACIKLAMASI', participants: [] }; } };
  baglam.lines.set('ofis', { id: 'ofis', myNumber: '905399265440', connected: true, sock: ofisSoket, chats: ofisChats });
  const gjid = '120363499000111@g.us';
  chats.set(gjid, { jid: gjid, name: 'G', isGroup: true, messages: [], description: '', avatar: null, memberCount: 0 });
  const eskiFetch2 = global.fetch;
  global.fetch = async (u) => {
    if (String(u).includes('/health')) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: { code: 4, text: 'AUTH' }, user: { id: '905458126770' } }) };
    // Whapi cevabinda description alani YOK (gercek durum)
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: gjid, name: 'ÖZ KARDEŞLER 56', chat_pic: 'http://f', participants_count: 24 }) };
  };
  await cagir('dogru-gizli-dize', { messages: [{ id: 'AC_1', chat_id: gjid, type: 'text', timestamp: Math.floor(Date.now() / 1000), from: '905999000222', from_name: 'Musteri', text: { body: 'selam' } }] });
  await bekleMs(900);
  bekle('ofis hattina soruldu', ofisSoruldu > 0, true);
  bekle('aciklama Baileys\'ten geldi', chats.get(gjid).description, 'BAILEYS ACIKLAMASI');

  console.log('\n OFIS KOPUKSA ofis hattina HIC dokunma:');
  baglam.lines.set('ofis', { id: 'ofis', myNumber: '905399265440', connected: false, sock: null, chats: ofisChats });
  const oncekiSoru = ofisSoruldu;
  const gjid2 = '120363499000222@g.us';
  chats.set(gjid2, { jid: gjid2, name: 'G2', isGroup: true, messages: [], description: '', avatar: null, memberCount: 0 });
  await cagir('dogru-gizli-dize', { messages: [{ id: 'AC_2', chat_id: gjid2, type: 'text', timestamp: Math.floor(Date.now() / 1000), from: '905999000333', text: { body: 'x' } }] });
  await bekleMs(500);
  bekle('ofis kopukken sorgu ATILMADI', ofisSoruldu, oncekiSoru);
  global.fetch = eskiFetch2;

  console.log('\n IPTAL ROBOTU (anlik ac/kapa):');
  const robotaGelenler = [];
  let robotAcik = true;
  // server.js'in gercek davranisi: ILK SATIRDA bayragi okur
  baglam.robotMedyaGeldi = (x) => { if (!robotAcik) return; robotaGelenler.push(x); };

  const pdfZarf = (id) => ({ messages: [{ id, chat_id: '120363423265440017@g.us', type: 'document',
    timestamp: Math.floor(Date.now() / 1000), from: '905999000444', from_name: 'Musteri',
    document: { link: 'https://s3.eu-central-1.wasabisys.com/x.pdf', mime_type: 'application/pdf',
      file_name: 'ADEM OTO TRAFİK SİG 34 KHL 196.pdf' } }] });

  await cagir('dogru-gizli-dize', pdfZarf('ROBOT_1'));
  await bekleMs(300);
  bekle('robot ACIKKEN belge geldi', robotaGelenler.length, 1);
  if (robotaGelenler.length) {
    const r = robotaGelenler[0];
    bekle('dogru hat', r.lineId, 'whapi');
    bekle('kind document', r.kind, 'document');
    bekle('mesaj kimligi tasindi', r.m.key.id, 'ROBOT_1');
    bekle('PDF mime tasindi (PDF tespiti icin)', r.m.message.documentMessage.mimetype, 'application/pdf');
    bekle('diskteki dosya yolu', String(r.url).startsWith('/media/'), true);
    bekle('uzanti .pdf korundu', String(r.url).endsWith('.pdf'), true);
  }

  console.log('\n Robot KAPATILINCA aninda durmali:');
  robotAcik = false;
  const oncekiN = robotaGelenler.length;
  await cagir('dogru-gizli-dize', pdfZarf('ROBOT_2'));
  await bekleMs(300);
  bekle('kapaliyken belge islenmedi', robotaGelenler.length, oncekiN);

  console.log('\n Tekrar ACILINCA aninda calismali:');
  robotAcik = true;
  await cagir('dogru-gizli-dize', pdfZarf('ROBOT_3'));
  await bekleMs(300);
  bekle('acilinca yeniden isledi', robotaGelenler.length, oncekiN + 1);

  console.log('\n TIK (yeni):');
  sahteAddMessage('120363423265440017@g.us', { id: 'GIDEN_1', kind: 'text', text: 'panelden', fromMe: true, durum: 2 }, {}, 'whapi');
  let iletimTemizlendi = false;
  baglam.iletimDenetleTamam = () => { iletimTemizlendi = true; };
  await cagir('dogru-gizli-dize', { statuses: [{ id: 'GIDEN_1', code: 4, status: 'read', recipient_id: '120363423265440017@g.us', viewer_id: '905546084466' }], event: { type: 'statuses', event: 'put' } });
  const giden = chats.get('120363423265440017@g.us').messages.find((m) => m.id === 'GIDEN_1');
  bekle('durum 4 (okundu) islendi', giden.durum, 4);
  bekle('panele msgStatus yayinlandi', cagrilar.broadcast.some((x) => x.type === 'msgStatus'), true);
  bekle('iletim denetcisi TEMIZLENDI (yanlis alarm bitti)', iletimTemizlendi, true);

  console.log('\n ESKI MESAJ (pdo_sync gecmis seli):');
  const oncekiSayi = cagrilar.addMessage.length;
  const eskiTs = Math.floor(Date.now() / 1000) - 200 * 86400;
  await cagir('dogru-gizli-dize', { messages: [{ id: 'ESKI_1', chat_id: '120363499999999@g.us', type: 'text', timestamp: eskiTs, from: '905', text: { body: 'cok eski' }, chat_name: 'Eski Grup' }] });
  bekle('eski mesaj panele DUSMEDI', cagrilar.addMessage.length, oncekiSayi);
  bekle('eski grup OLUSTURULMADI', chats.has('120363499999999@g.us'), false);

  console.log('\n Panel bu hattan mesaj gonderebiliyor mu:');
  const sent = await line.sock.sendMessage('120363423265440017@g.us', { text: 'panelden' });
  bekle('Baileys bicimli cevap dondu', !!(sent && sent.key && sent.key.id), true);
  bekle('gercek Whapi kimligi tasindi', sent.key.id, 'WHAPI_GIDEN_1');
  bekle('fromMe isaretli', sent.key.fromMe, true);

  console.log('\n GONDERIM ONAYI -> ANINDA TEK TIK (saat ikonu kalmasin):');
  // server.js gibi davran: once gonder, SONRA mesaji ekle
  const gonderim = line.sock.sendMessage('120363423265440017@g.us', { text: 'tek tik testi' });
  const s2 = await gonderim;
  // server.js grup mesajina baslangic durumu 1 (saat) veriyor
  sahteAddMessage('120363423265440017@g.us', { id: s2.key.id, kind: 'text', text: 'tek tik testi', fromMe: true, sender: 'MOTOR TEST', durum: 1, ts: Date.now() }, {}, 'whapi');
  const msj = chats.get('120363423265440017@g.us').messages.find((m) => m.id === s2.key.id);
  bekle('baslangicta saat ikonu (durum 1)', msj.durum, 1);
  await bekleMs(900);
  bekle('kisa sure sonra TEK TIK (durum 2)', msj.durum, 2);
  bekle('panele msgStatus gitti', cagrilar.broadcast.filter((x) => x.type === 'msgStatus').length > 0, true);

  console.log('\n Sonra gelen gercek makbuz TIKI YUKSELTMELI:');
  await cagir('dogru-gizli-dize', { statuses: [{ id: s2.key.id, code: 4, status: 'read', recipient_id: '120363423265440017@g.us' }] });
  bekle('okundu (durum 4) oldu', msj.durum, 4);

  console.log('\n Whapi kimlik DONDURMEZSE sahte basari uretmemeli:');
  const eskiFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' });
  let hataAldi = false;
  try { await line.sock.sendMessage('120363423265440017@g.us', { text: 'x' }); } catch (_) { hataAldi = true; }
  bekle('hata firlatti (panel kirmizi unlem gosterecek)', hataAldi, true);
  global.fetch = eskiFetch;

  console.log('\n═══ SONUC ═══');
  console.log(`  gecen: ${gecti}   kalan: ${kaldi}`);
  try { fs.rmSync(GECICI, { recursive: true, force: true }); } catch (_) {}
  process.exit(kaldi ? 1 : 0);
})();
