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

(async () => {
  console.log('═══ WEBHOOK UCU ═══\n');

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

  console.log('\n═══ HAT BASLATMA ═══\n');
  const line = await kurulum.hattiBaslat();
  bekle('line olustu', !!line, true);
  bekle('motor isaretlendi (startWA Baileys\'e girmeyecek)', line.motor, 'whapi');
  bekle('line.sock DOLU (panel gonderme kodu bunu arar)', !!line.sock, true);
  bekle('sock whapi adaptoru', line.sock._motor, 'whapi');
  bekle('bagli', line.connected, true);
  bekle('kendi numarasi ogrenildi', line.myNumber, '905458126770');
  bekle('QR YOK', line.lastQR, null);

  console.log('\n Panel bu hattan mesaj gonderebiliyor mu:');
  const sent = await line.sock.sendMessage('120363423265440017@g.us', { text: 'panelden' });
  bekle('Baileys bicimli cevap dondu', !!(sent && sent.key && sent.key.id), true);
  bekle('gercek Whapi kimligi tasindi', sent.key.id, 'WHAPI_GIDEN_1');
  bekle('fromMe isaretli', sent.key.fromMe, true);

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
