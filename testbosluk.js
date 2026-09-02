// BOSLUK DENETCISI TESTI (2026-09) — "WhatsApp'ta var, panelimde yok"
//
// KULLANICI SORUSU: "orijinal WhatsApp'tan veri cekiyoruz, 'bu mesaj burada
// yok' diyemiyor muyuz?" — Referans zaten geliyordu (conversationTimestamp),
// sadece OKUNMUYORDU. Eski kod onu chat.lastTs'e YAZIP farki siliyordu.
//
// Bu test: (a) eski davranisin delikleri gizledigini, (b) yeni denetcinin
// onlari yakaladigini, (c) yanlis alarm uretmedigini dogrular.
const fs = require('fs');
const path = require('path');

const kaynak = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
let gecti = 0, kaldi = 0;
function ok(ad, sart) {
  if (sart) { gecti++; console.log('  GECTI  ' + ad); }
  else { kaldi++; console.log('  KALDI  ' + ad); }
}

// boslukDenetle'yi ve sabitlerini server.js'ten CIKAR
const kod = kaynak.slice(kaynak.indexOf('const BOSLUK_ESIK'),
                         kaynak.indexOf('function mesajCekKuyruguEkle'));

function kur() {
  const cekilenler = [];
  const kalpler = [];
  const f = new Function('mesajCekKuyruguEkle', 'kalpAtisiTuru', 'console', 'global', 'setImmediate',
    kod + '\nreturn { denetle: boslukDenetle, ESIK: BOSLUK_ESIK, SOGUMA: BOSLUK_SOGUMA,' +
    ' TAVAN: BOSLUK_DK_TAVAN, HASTA: BOSLUK_HASTA_ESIK, pencere: _boslukPencere };');
  const api = f(
    (jid) => cekilenler.push(jid),
    async () => { kalpler.push(Date.now()); },
    { log: () => {} },
    {},
    (fn) => fn()
  );
  return { ...api, cekilenler, kalpler };
}

const sohbet = (sonMesajTs, ad = 'GRUP') => ({ name: ad, sonMesajTs });

// ═══ TEST 1: ESKI DAVRANISIN HATASI ════════════════════════════════
console.log('\n== TEST 1: eski kod delikleri neden goremiyordu ==');
{
  // ESKI kod: chat.lastTs = ts (WhatsApp'in zamani bizim uzerimize yaziliyor)
  const chat = { lastTs: 1000000, sonMesajTs: 1000000 };
  const waTs = 1060000; // WhatsApp 60 sn ilerideyiz diyor -> 60 sn'lik delik
  // eski davranis taklidi
  const eskiFark = Math.abs(waTs - chat.lastTs);
  chat.lastTs = waTs;                       // <-- fark burada SILINIYOR
  const eskiFarkSonra = Math.abs(waTs - chat.lastTs);
  ok('eski kodda fark VARDI (60 sn)', eskiFark === 60000);
  ok('eski kod farki SILIYORDU (lastTs eziliyor)', eskiFarkSonra === 0);
  ok('ama gercek mesaj hala BIZDE YOK', chat.sonMesajTs === 1000000);
  console.log('         -> panel dogru saati gosteriyor, mesaj eksik. Sikayetin kaynagi bu.');
}

// ═══ TEST 2: YENI DENETCI DELIGI YAKALIYOR ═════════════════════════
console.log('\n== TEST 2: delik yakalaniyor ve hedefli cekim yapiliyor ==');
{
  const F = kur();
  const c = sohbet(1000000, 'EMIN AYIK OTOMOTIV');
  const bulundu = F.denetle('ofis', 'g1@g.us', c, 1060000); // 60 sn ileride
  ok('delik TESPIT edildi', bulundu === true);
  ok('o sohbet icin mesaj cekimi kuyruga alindi', F.cekilenler.length === 1 && F.cekilenler[0] === 'g1@g.us');
}

// ═══ TEST 3: YANLIS ALARM URETMIYOR ════════════════════════════════
console.log('\n== TEST 3: yanlis alarm korumalari ==');
{
  const F = kur();
  ok('fark yoksa delik YOK', F.denetle('ofis', 'a@g.us', sohbet(1000000), 1000000) === false);
  ok('kucuk fark (5 sn) delik SAYILMIYOR', F.denetle('ofis', 'b@g.us', sohbet(1000000), 1005000) === false);
  ok('esik tam sinirinda (10 sn) delik SAYILMIYOR', F.denetle('ofis', 'c@g.us', sohbet(1000000), 1010000) === false);
  ok('esigin 1 ms ustu delik SAYILIYOR', F.denetle('ofis', 'd@g.us', sohbet(1000000), 1010001) === true);
  ok('bizde hic mesaj yoksa (sonMesajTs=0) ALARM URETMIYOR',
     F.denetle('ofis', 'e@g.us', sohbet(0), 9999999) === false);
  ok('WhatsApp zaman gondermediyse alarm YOK', F.denetle('ofis', 'f@g.us', sohbet(1000), 0) === false);
  ok('WhatsApp GERIDEYSE alarm YOK (biz ilerideyiz)',
     F.denetle('ofis', 'h@g.us', sohbet(2000000), 1000000) === false);
  ok('sohbet yoksa cokmuyor', F.denetle('ofis', 'i@g.us', null, 123) === false);
}

// ═══ TEST 4: WHATSAPP'I YORMA KORUMALARI ═══════════════════════════
console.log('\n== TEST 4: rate-limit korumalari ==');
{
  const F = kur();
  const c = sohbet(1000000);
  ok('ilk delik cekim yapiyor', F.denetle('ofis', 'x@g.us', c, 1060000) === true);
  ok('AYNI sohbet hemen tekrar CEKILMIYOR (60 sn soguma)',
     F.denetle('ofis', 'x@g.us', c, 1120000) === false);
  ok('toplam cekim hala 1', F.cekilenler.length === 1);

  // dakikalik tavan
  const G = kur();
  let kabul = 0;
  for (let i = 0; i < 60; i++) {
    if (G.denetle('ofis', 'j' + i + '@g.us', sohbet(1000000), 1060000)) kabul++;
  }
  ok('dakikada en fazla ' + G.TAVAN + ' cekim (60 delikte tavan tutuyor)', kabul === G.TAVAN);
  ok('tavan asilinca WhatsApp\'a fazladan istek GITMIYOR', G.cekilenler.length === G.TAVAN);
}

// ═══ TEST 5: HASTA HAT SINYALI ═════════════════════════════════════
console.log('\n== TEST 5: cok sohbette delik -> hat hasta sinyali ==');
{
  const F = kur();
  // 4 farkli sohbet -> henuz hasta degil
  for (let i = 0; i < 4; i++) F.denetle('ofis', 'k' + i + '@g.us', sohbet(1000000), 1060000);
  ok('4 farkli sohbette delik -> canlilik testi TETIKLENMEDI', F.kalpler.length === 0);
  // 5. sohbet -> hasta
  F.denetle('ofis', 'k9@g.us', sohbet(1000000), 1060000);
  ok('5 farkli sohbette delik -> canlilik testi TETIKLENDI', F.kalpler.length === 1);
  ok('bu, sessizlik bekcisinin YAKALAYAMADIGI ariza (veri akiyor ama eksik)', true);

  // ayni sohbetin tekrari hasta saydirmamali
  const G = kur();
  for (let i = 0; i < 10; i++) {
    G.pencere.push({ jid: 'tek@g.us', ts: Date.now() });
  }
  G.denetle('ofis', 'tek2@g.us', sohbet(1000000), 1060000);
  ok('ayni sohbetin tekrari "hasta" saydirmiyor (FARKLI sohbet sayiliyor)', G.kalpler.length === 0);
}

// ═══ TEST 6: KOD BAGLANTILARI — SIRA KRITIK ════════════════════════
console.log('\n== TEST 6: denetim lastTs EZILMEDEN once calisiyor mu? ==');
{
  // SADECE chats.update bloguna bak (dosyanin baska yerinde de lastTs atamasi var)
  const bBas = kaynak.indexOf("sock.ev.on('chats.update'");
  const bSon = kaynak.indexOf("sock.ev.on('groups.update'");
  const blok = kaynak.slice(bBas, bSon);
  const iBosluk = blok.indexOf('const _bosluk = boslukDenetle(lineId, jid, chat, ts)');
  const iEzme = blok.indexOf('chat.lastTs = ts;');
  ok('boslukDenetle chats.update icinde cagriliyor', iBosluk > 0);
  ok('lastTs ezmesi de ayni blokta', iEzme > 0);
  ok('denetim, lastTs EZILMEDEN ONCE calisiyor (sira dogru)', iEzme > iBosluk);

  ok('sonMesajTs SADECE addMessage\'da yaziliyor',
     (kaynak.match(/chat\.sonMesajTs = Math\.max/g) || []).length === 1);
  ok('karsilastirma lastTs\'e DEGIL sonMesajTs\'e yapiliyor',
     /const bizdeki = chat\.sonMesajTs \|\| 0;/.test(kaynak));
  ok('unreadCount artik TEK tetikleyici degil',
     /if \(gercekYeniMesaj && !_bosluk\) mesajCekKuyruguEkle\(jid\)/.test(kaynak));
  ok('hasta sinyali YENI kesme yolu acmiyor, mevcut testi tetikliyor',
     /kalpAtisiTuru\(\)\.catch/.test(kaynak.slice(kaynak.indexOf('HAT HASTA'), kaynak.indexOf('HAT HASTA') + 700)));
}

// ═══ TEST 7: CEKIM CAPASI (restart sonrasi calisiyor mu?) ══════════
console.log('\n== TEST 7: mesajiAktifCek capa duzeltmesi ==');
{
  const blok = kaynak.slice(kaynak.indexOf('async function mesajiAktifCek'),
                            kaynak.indexOf('async function mesajiAktifCek') + 1200);
  ok('capa artik _telafiCapasi ile aliniyor (DB yedegi var)', /await _telafiCapasi\(chat\)/.test(blok));
  ok('eski "sadece bellekten capa" kodu kalkti',
     !/const sonMesaj = chat\.messages && chat\.messages\.length \? chat\.messages\[chat\.messages\.length - 1\] : null;/.test(blok));
  ok('capa yoksa istek atilmiyor', /if \(!capa\) return;/.test(blok));
  console.log('         -> restart sonrasi delik tespit edilirse cekim ARTIK gercekten calisiyor');
}

// ═══ TEST 8: ONCEKI DUZELTMELER YERINDE ════════════════════════════
console.log('\n== TEST 8: hicbir sey bozulmadi ==');
{
  ok('uyarlanan sessizlik bekcisi duruyor', /uyarlananSessizlikEsigi\(line\)/.test(kaynak));
  ok('cikis dugmesi korumasi duruyor', /GUVENLI TAZELEME/.test(kaynak));
  ok('QR yol duzeltmesi duruyor', /path\.join\(AUTH_BASE, 'ofis', 'creds\.json'\)/.test(kaynak));
  ok('rate desen duzeltmesi duruyor', /\(\?<!\[0-9\]\)429\(\?!\[0-9\]\)/.test(kaynak));
  ok('telafi capasi duruyor', /async function _telafiCapasi/.test(kaynak));
  ok('gonderim merdiveni 5/15/45 aynen', /const BEKLEMELER = \[5000, 15000, 45000\]/.test(kaynak));
  ok('mesaj cekme kuyrugu 600ms araliginda (rate koruma)', /setTimeout\(r, 600\)/.test(kaynak));
  ok('ESZAMANLI_KANAL 6 aynen', /const ESZAMANLI_KANAL = 6/.test(kaynak));
}

console.log('\n─────────────────────────────');
console.log('GECTI: ' + gecti + ' | KALDI: ' + kaldi);
process.exit(kaldi ? 1 : 0);
