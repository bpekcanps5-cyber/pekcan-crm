// Adaptor testi: fetch SAHTE. Ag'a hic cikmaz.
// Olculen sey: panelin gonderdigi Baileys icerigi -> Whapi'ye giden istek.
const TOKEN = 'GIZLI_TOKEN_123';
let sonIstek = null;
let sahteCevap = { message: { id: 'WHAPI_MSG_1' } };
let sahteDurum = 200;

global.fetch = async (url, ayar = {}) => {
  sonIstek = {
    url,
    yontem: ayar.method || 'GET',
    yetki: (ayar.headers || {}).Authorization,
    govde: ayar.body ? JSON.parse(ayar.body) : null,
  };
  return {
    ok: sahteDurum >= 200 && sahteDurum < 300,
    status: sahteDurum,
    text: async () => JSON.stringify(sahteCevap),
  };
};

const { olustur } = require('./whapi-adapter');
const sock = olustur({ token: TOKEN, taban: 'https://gate.whapi.cloud' });

let gecti = 0, kaldi = 0;
function bekle(ad, olan, beklenen) {
  const ok = JSON.stringify(olan) === JSON.stringify(beklenen);
  if (ok) { gecti++; console.log('  ✓ ' + ad); }
  else { kaldi++; console.log('  ✗ ' + ad + '\n      beklenen: ' + JSON.stringify(beklenen) + '\n      olan    : ' + JSON.stringify(olan)); }
}

const GRUP = '120363423265440017@g.us';
const KISI = '905399265441@s.whatsapp.net';

(async () => {
  console.log('═══ PANELIN GONDERDIGI -> WHAPI\'YE GIDEN ═══\n');

  console.log(' Metin (gruba):');
  let s = await sock.sendMessage(GRUP, { text: 'merhaba' });
  console.log('   -> ' + sonIstek.yontem + ' ' + sonIstek.url.replace('https://gate.whapi.cloud', '') + '  ' + JSON.stringify(sonIstek.govde));
  bekle('uc', sonIstek.url, 'https://gate.whapi.cloud/messages/text');
  bekle('grup jid tam gonderildi', sonIstek.govde.to, GRUP);
  bekle('Baileys bicimli cevap', s.key.id, 'WHAPI_MSG_1');
  bekle('cevapta fromMe', s.key.fromMe, true);
  bekle('cevapta dogru jid', s.key.remoteJid, GRUP);

  console.log('\n Metin (kisiye) — ciplak numaraya cevrilmeli:');
  await sock.sendMessage(KISI, { text: 'selam' });
  console.log('   -> to=' + JSON.stringify(sonIstek.govde.to));
  bekle('kisi jid ciplak numara oldu', sonIstek.govde.to, '905399265441');

  console.log('\n Alintili yanit (Baileys {quoted: ham} -> Whapi kimlik):');
  await sock.sendMessage(GRUP, { text: 'yanit' }, { quoted: { key: { id: 'ESKI_ID_9' } } });
  console.log('   -> ' + JSON.stringify(sonIstek.govde));
  bekle('quoted kimlige cevrildi', sonIstek.govde.quoted, 'ESKI_ID_9');

  console.log('\n Etiketleme (mentions):');
  await sock.sendMessage(GRUP, { text: '@905551112233 bak', mentions: ['905551112233@s.whatsapp.net'] });
  bekle('mentions ciplak numara', sonIstek.govde.mentions, ['905551112233']);

  console.log('\n Fotograf (Buffer -> base64 data-url):');
  await sock.sendMessage(GRUP, { image: Buffer.from([0xff, 0xd8, 0xff]), caption: 'police', mimetype: 'image/jpeg' });
  console.log('   -> ' + sonIstek.url.replace('https://gate.whapi.cloud', '') + '  media=' + JSON.stringify(String(sonIstek.govde.media).slice(0, 34)) + '...');
  bekle('uc', sonIstek.url, 'https://gate.whapi.cloud/messages/image');
  bekle('media data-url oldu', String(sonIstek.govde.media).startsWith('data:image/jpeg;base64,'), true);
  bekle('caption tasindi', sonIstek.govde.caption, 'police');

  console.log('\n Belge — dosya adi KRITIK (plaka/donem orada):');
  await sock.sendMessage(GRUP, {
    document: Buffer.from([0x25, 0x50]),
    fileName: 'ADEM OTO TRAFİK SİG 34 KHL 196 8 AĞUSTOS 2026.pdf',
    mimetype: 'application/pdf',
  });
  console.log('   -> filename=' + JSON.stringify(sonIstek.govde.filename));
  bekle('uc', sonIstek.url, 'https://gate.whapi.cloud/messages/document');
  bekle('Turkce dosya adi bozulmadi', sonIstek.govde.filename, 'ADEM OTO TRAFİK SİG 34 KHL 196 8 AĞUSTOS 2026.pdf');
  bekle('mime tasindi', sonIstek.govde.mime_type, 'application/pdf');

  console.log('\n Video / ses / cikartma uclari:');
  await sock.sendMessage(GRUP, { video: Buffer.from([1]) });
  bekle('video', sonIstek.url.endsWith('/messages/video'), true);
  await sock.sendMessage(GRUP, { audio: Buffer.from([1]), mimetype: 'audio/ogg' });
  bekle('audio', sonIstek.url.endsWith('/messages/audio'), true);
  await sock.sendMessage(GRUP, { sticker: Buffer.from([1]) });
  bekle('sticker', sonIstek.url.endsWith('/messages/sticker'), true);

  console.log('\n Tepki / silme / duzenleme (yontem DOGRU olmali):');
  await sock.sendMessage(GRUP, { react: { text: '👍', key: { id: 'HEDEF_1' } } });
  console.log('   tepki   -> ' + sonIstek.yontem + ' ' + sonIstek.url.replace('https://gate.whapi.cloud', ''));
  bekle('tepki yontemi PUT', sonIstek.yontem, 'PUT');
  bekle('tepki emojisi', sonIstek.govde.emoji, '👍');

  await sock.sendMessage(GRUP, { delete: { id: 'HEDEF_2' } });
  console.log('   silme   -> ' + sonIstek.yontem + ' ' + sonIstek.url.replace('https://gate.whapi.cloud', ''));
  bekle('silme yontemi DELETE', sonIstek.yontem, 'DELETE');

  await sock.sendMessage(GRUP, { text: 'yeni metin', edit: { id: 'HEDEF_3' } });
  console.log('   duzenle -> ' + sonIstek.yontem + ' ' + sonIstek.url.replace('https://gate.whapi.cloud', ''));
  bekle('duzenleme yontemi PUT', sonIstek.yontem, 'PUT');
  bekle('duzenleme govdesi', sonIstek.govde.body, 'yeni metin');

  console.log('\n Grup bilgisi (Whapi -> Baileys bicimi):');
  sahteCevap = {
    id: GRUP, name: 'VOLKAN AYDEMİR - sigortası', description: 'aciklama',
    participants: [
      { id: '905458126770', rank: 'creator' },
      { id: '905399265441@s.whatsapp.net', rank: 'admin' },
      { id: '905393793449', rank: 'member' },
    ],
  };
  const meta = await sock.groupMetadata(GRUP);
  console.log('   -> subject=' + JSON.stringify(meta.subject) + '  uye=' + meta.participants.length);
  bekle('subject alanina cevrildi', meta.subject, 'VOLKAN AYDEMİR - sigortası');
  bekle('desc alanina cevrildi', meta.desc, 'aciklama');
  bekle('uye sayisi', meta.participants.length, 3);
  bekle('creator admin sayildi', meta.participants[0].admin, 'admin');
  bekle('admin admin sayildi', meta.participants[1].admin, 'admin');
  bekle('member admin DEGIL', meta.participants[2].admin, null);
  bekle('uye jid CRM bicimi', meta.participants[0].id, '905458126770@s.whatsapp.net');

  console.log('\n Saglik (kendi numarasini ogrenme):');
  sahteCevap = { channel_id: 'THOROD-HWYTD', uptime: 8836, status: { code: 4, text: 'AUTH' }, user: { id: '905458126770', is_business: true } };
  const sg = await sock._hazirla();
  console.log('   -> bagli=' + sg.bagli + '  numara=' + sg.numara);
  bekle('bagli tespiti', sg.bagli, true);
  bekle('kendi numarasi', sg.numara, '905458126770');
  bekle('sock.user Baileys bicimi', sock.user.id, '905458126770@s.whatsapp.net');

  console.log('\n TOKEN SIZINTISI KONTROLU:');
  sahteDurum = 401;
  sahteCevap = { error: { message: 'invalid token ' + TOKEN + ' rejected' } };
  let hataMetni = '';
  try { await sock.sendMessage(GRUP, { text: 'x' }); } catch (e) { hataMetni = e.message; }
  console.log('   hata metni: ' + JSON.stringify(hataMetni.slice(0, 90)));
  bekle('token hata mesajinda YOK', hataMetni.includes(TOKEN), false);
  bekle('yerine *** kondu', hataMetni.includes('***'), true);

  console.log('\n Hiz siniri (429) — kuyruk katmani tanisin:');
  sahteDurum = 429;
  sahteCevap = { error: { message: 'too many requests' } };
  let rateHata = '';
  try { await sock.sendMessage(GRUP, { text: 'x' }); } catch (e) { rateHata = e.message; }
  console.log('   hata metni: ' + JSON.stringify(rateHata.slice(0, 60)));
  bekle('rate-overlimit ifadesi var', rateHata.includes('rate-overlimit'), true);

  console.log('\n Soket kilifi (server.js soketiKapat cagiriyor):');
  sahteDurum = 200;
  let coktu = false;
  try { sock.ev.removeAllListeners(); sock.end(new Error('x')); sock.ws.close(); } catch (_) { coktu = true; }
  bekle('kapatma cagrilari cokmuyor', coktu, false);
  bekle('motor isareti', sock._motor, 'whapi');

  console.log('\n═══ SONUC ═══');
  console.log(`  gecen: ${gecti}   kalan: ${kaldi}`);
  process.exit(kaldi ? 1 : 0);
})();
