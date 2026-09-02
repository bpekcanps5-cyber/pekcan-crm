// BORU HATTI DENETCISI — gercek calistirma testi.
// Fonksiyonlar server.js'ten cikarilip sahte ortamda kosturuluyor.
const fs = require('fs');
const path = require('path');
const kaynak = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
let gecti = 0, kaldi = 0;
const ok = (ad, s) => { if (s) { gecti++; console.log('  GECTI  ' + ad); } else { kaldi++; console.log('  KALDI  ' + ad); } };

function cikar(bas, bit) {
  const i = kaynak.indexOf(bas); const j = kaynak.indexOf(bit, i);
  if (i < 0 || j < 0) throw new Error('bulunamadi: ' + bas);
  return kaynak.slice(i, j);
}

// Denetci blogunu al (timer HARIC — turu elle cagiracagiz)
const blok = cikar('const _boru = new Map();', 'if (!global._boruTimer)');
const turKodu = cikar('      if (_boru.size === 0) return;', '    } catch (e) { console.log(\'boru denetcisi:');

// Sahte ortam
let yayinlar = [];
let panelSayisi = 1;
const sahteChats = new Map();
const ortam = {
  wss: { clients: { forEach: (f) => { for (let i = 0; i < panelSayisi; i++) f({ readyState: 1 }); } } },
  hatChats: () => sahteChats,
  broadcastHat: (l, o) => { yayinlar.push({ l, o }); },
  stripRaw: (c) => c,
  lines: new Map([['ofis', { sonAktivite: Date.now() }]]),
  console: { log: () => {} },
};

const kur = new Function('wss', 'hatChats', 'broadcastHat', 'stripRaw', 'lines', 'console',
  blok + '\nfunction _tur(){ try {' + turKodu + '} catch(e){} }\n' +
  'return { giris: boruGiris, cikis: boruCikis, tur: _tur, boru: _boru, ' +
  'say: () => ({ alinan: _boruAlinan, iletilen: _boruIletilen, takilan: _boruTakilan, kurtarilan: _boruKurtarilan }) };');

function yeniOrtam() {
  yayinlar = []; panelSayisi = 1; sahteChats.clear();
  return kur(ortam.wss, ortam.hatChats, ortam.broadcastHat, ortam.stripRaw, ortam.lines, ortam.console);
}

console.log('\n== 1) NORMAL AKIS: mesaj gelir, panele gider ==');
{
  const B = yeniOrtam();
  B.giris('m1', 'grup@g.us', 'ofis', Date.now());
  ok('mesaj takibe alindi', B.boru.size === 1);
  B.cikis('grup@g.us');
  ok('panele ulasinca takipten dustu', B.boru.size === 0);
  B.tur();
  ok('ALARM CALMADI (dogru)', B.say().takilan === 0);
}

console.log('\n== 2) TAKILMA: alindi ama panele ULASMADI ==');
{
  const B = yeniOrtam();
  sahteChats.set('grup@g.us', { jid: 'grup@g.us', messages: [] });
  B.giris('m2', 'grup@g.us', 'ofis', Date.now());
  B.boru.get('m2').t = Date.now() - 12000;  // 12 sn once geldi, hala takili
  B.tur();
  ok('TAKILMA yakalandi', B.say().takilan === 1);
  ok('GOZLEM MODU: yeniden yayin YAPILMADI', yayinlar.length === 0);
  ok('takip listesi temizlendi', B.boru.size === 0);
}

console.log('\n== 3) YANLIS ALARM OLMAMALI: taze mesaj ==');
{
  const B = yeniOrtam();
  B.giris('m3', 'a@s.whatsapp.net', 'ofis', Date.now());
  B.tur();   // daha 10 sn gecmedi
  ok('10 sn dolmadan alarm YOK', B.say().takilan === 0);
  ok('mesaj hala takipte', B.boru.size === 1);
}

console.log('\n== 4) SAKIN SAAT: hic mesaj yoksa denetci sessiz ==');
{
  const B = yeniOrtam();
  for (let i = 0; i < 20; i++) B.tur();
  ok('20 tur bos gecti, alarm YOK', B.say().takilan === 0);
  ok('yayin yapilmadi', yayinlar.length === 0);
}

console.log('\n== 5) PANEL KAPALI: alarm calmamali ==');
{
  const B = yeniOrtam();
  B.giris('m5', 'x@g.us', 'ofis', Date.now());
  B.boru.get('m5').t = Date.now() - 12000;
  panelSayisi = 0;                          // kimse bagli degil
  B.tur();
  ok('panel yokken alarm YOK (dogru)', B.say().takilan === 0);
  ok('kayit temizlendi (bellek sismesin)', B.boru.size === 0);
}

console.log('\n== 6) COKLU TAKILMA: gozlem modunda MUDAHALE YOK ==');
{
  const B = yeniOrtam();
  sahteChats.set('g@g.us', { jid: 'g@g.us', messages: [] });
  const t0 = Date.now();
  ortam.lines.get('ofis').sonAktivite = t0;
  for (let i = 0; i < 5; i++) {
    B.giris('k' + i, 'g@g.us', 'ofis', Date.now());
    B.boru.get('k' + i).t = Date.now() - 12000;
  }
  B.tur();
  ok('5 takilma yakalandi', B.say().takilan === 5);
  ok('GOZLEM MODU: kalp atisi ZORLANMADI', ortam.lines.get('ofis').sonAktivite === t0);
  ok('GOZLEM MODU: hic yayin yapilmadi', yayinlar.length === 0);
}

console.log('\n== 7) GECMIS YUKLEME takibe girmemeli ==');
{
  const B = yeniOrtam();
  B.giris('eski1', 'g@g.us', 'ofis', Date.now() - 3600000);  // 1 saat once
  ok('eski mesaj takibe ALINMADI', B.boru.size === 0);
}

console.log('\n== 7b) BIZIM GONDERDIGIMIZ mesaj izlenmemeli (yanlis alarmin sebebi) ==');
{
  const B = yeniOrtam();
  B.giris('giden1', 'g@g.us', 'ofis', Date.now(), true);   // fromMe = true
  ok('fromMe mesaj takibe ALINMADI', B.boru.size === 0);
  B.giris('gelen1', 'g@g.us', 'ofis', Date.now(), false);
  ok('gelen mesaj takibe alindi', B.boru.size === 1);
}

console.log('\n== 8) BELLEK GUVENLIGI ==');
{
  const B = yeniOrtam();
  for (let i = 0; i < 5000; i++) B.giris('b' + i, 'g@g.us', 'ofis', Date.now());
  ok('tavan asilmadi (<=3000)', B.boru.size <= 3000);
}

console.log('\n== 9) MUKERRER giris tek sayilir ==');
{
  const B = yeniOrtam();
  B.giris('ayni', 'g@g.us', 'ofis', Date.now());
  B.giris('ayni', 'g@g.us', 'ofis', Date.now());
  ok('ayni id iki kez eklenmedi', B.boru.size === 1);
  ok('alinan sayaci 1', B.say().alinan === 1);
}

console.log('\n== 10) id/jid yoksa cokmemeli ==');
{
  const B = yeniOrtam();
  B.giris(null, 'g@g.us', 'ofis', Date.now());
  B.giris('x', null, 'ofis', Date.now());
  B.cikis(null);
  ok('bozuk girdilerde cokmedi', B.boru.size === 0);
}

console.log('\n─────────────────────────────');
console.log('GECTI: ' + gecti + ' | KALDI: ' + kaldi);
process.exit(kaldi ? 1 : 0);
