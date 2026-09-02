// RATE TESPIT GOZLEM TESTI (2026-09)
// Olculen celiski: 64 "HIZ SINIRI" tetiklendi ama loglarda "rate-overlimit"
// metni 8 kez gecti. Bu test, desenin YANLIS ESLESEBILDIGINI gosterir ve
// gozlem satirinin davranisi DEGISTIRMEDIGINI dogrular.
//
// Bu test bir DUZELTMEYI degil, bir SUPHEYI belgeler. Desen KASITLI olarak
// eski haliyle birakildi — once canlidan kanit, sonra mudahale.
const fs = require('fs');
const path = require('path');

const kaynak = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
let gecti = 0, kaldi = 0;
function ok(ad, sart) {
  if (sart) { gecti++; console.log('  GECTI  ' + ad); }
  else { kaldi++; console.log('  KALDI  ' + ad); }
}

// Deseni server.js'ten AYNEN al (kopyalamiyoruz — kaynagin kendisi test ediliyor)
const satir = (kaynak.match(/^const _RATE_DESEN = (.+);$/m) || [])[1];
if (!satir) throw new Error('_RATE_DESEN bulunamadi');
const DESEN = eval(satir);

// Yardimci: kuyrukluGonder'in kurdugu metni birebir taklit et
function hataMetni(e) {
  return (e && e.message ? e.message : '') + ' ' + (e && e.data ? JSON.stringify(e.data) : '');
}
const rateMi = (e) => DESEN.test(hataMetni(e));

// ═══ TEST 1: DESEN TEK YERDE ═══════════════════════════════════════
console.log('\n== TEST 1: desen tek kaynaktan geliyor ==');
{
  ok('desen sabite alindi', /const _RATE_DESEN =/.test(kaynak));
  ok('karar _RATE_DESEN kullaniyor', /const rateMi = _RATE_DESEN\.test\(m\)/.test(kaynak));
  ok('olcum de AYNI deseni kullaniyor', /m\.match\(_RATE_DESEN\)/.test(kaynak));
  ok('desende g bayragi YOK (lastIndex tuzagi)', !DESEN.flags.includes('g'));
  ok('kod icinde ikinci bir kopya desen kalmadi',
     (kaynak.match(/\/rate\.\?overlimit\|429\|too many\|rate\.\?limit\/i/g) || []).length === 1);
}

// ═══ TEST 2: GERCEK LIMITLER YAKALANMAYA DEVAM EDIYOR ══════════════
console.log('\n== TEST 2: gercek hiz limitleri hala yakalaniyor (koruma sokulmedi) ==');
{
  ok('rate-overlimit yakalandi', rateMi({ message: 'rate-overlimit' }));
  ok('rate overlimit (bosluklu) yakalandi', rateMi({ message: 'rate overlimit' }));
  ok('too many requests yakalandi', rateMi({ message: 'Too Many Requests' }));
  ok('rate-limit yakalandi', rateMi({ message: 'rate-limit exceeded' }));
  ok('gercek 429 kodu yakalandi', rateMi({ message: 'request failed', data: { statusCode: 429 } }));
}

// ═══ TEST 3: YANLIS ESLESME — SUPHENIN KANITI ══════════════════════
console.log('\n== TEST 3: yanlis eslesme mumkun mu? (kullanicinin GERCEK gruplari) ==');
{
  // 1 Eylul "YAVAS gonderim" logundan alinan gercek grup numaralari
  const gercekGruplar = [
    '120363421720128576',
    '120363407400080038',
    '120363423033016718',
    '120363409289068485',
    '120363026532175909',
    '280139241939152',
    '120363429013002261',   // <-- icinde 429 GECIYOR
    '120363423723816823',
  ];
  const kirli = gercekGruplar.filter(j => /429/.test(j));
  ok('kullanicinin gruplarindan en az biri "429" iceriyor', kirli.length >= 1);
  console.log('         ilgili grup(lar): ' + kirli.join(', '));

  // O gruba giden SIRADAN bir zaman asimi ne olarak siniflaniyor?
  const masumHata = {
    message: 'gonderim zaman asimi',
    data: { to: '120363429013002261@g.us' },
  };
  ok('SIRADAN zaman asimi "hiz limiti" sayiliyor (YANLIS ESLESME GERCEK)', rateMi(masumHata) === true);

  // Ayni hata, 429 icermeyen bir grupta
  const temizHata = {
    message: 'gonderim zaman asimi',
    data: { to: '120363421720128576@g.us' },
  };
  ok('ayni hata temiz grupta hiz limiti SAYILMIYOR', rateMi(temizHata) === false);
  console.log('         -> ayni hata, farkli grup, ZIT sonuc. Desen JID\'e bakiyor.');

  // Mesaj kimligi uzerinden de kacabilir
  ok('mesaj kimliginde 429 gecerse de yanlis eslesiyor',
     rateMi({ message: 'baglanti kapandi', data: { id: '3EB0429A17C2' } }) === true);
}

// ═══ TEST 4: GOZLEM DAVRANISI DEGISTIRMIYOR ════════════════════════
console.log('\n== TEST 4: gozlem satiri zararsiz mi? ==');
{
  const blok = kaynak.slice(kaynak.indexOf('if (rateMi) {'), kaynak.indexOf('BEKLEMELER'));
  ok('gozlem SADECE ilk denemede yaziyor (log seli yok)', /if \(_deneme === 0\) \{[\s\S]{0,400}?RATE TESPIT/.test(blok));
  ok('gozlem console.log, hicbir sey dondurmuyor', /console\.log\(`🔬 RATE TESPIT/.test(blok));
  ok('fren cagrisi yerinde duruyor', /_rateSinirinaTakildi\(lineId, d, _deneme === 0, true\)/.test(blok));
  ok('hata metni kirpiliyor (log sismesin)', /slice\(0, 90\)/.test(blok) && /slice\(0, 140\)/.test(blok));

  // Sabitler DEGISMEDI — gonderim merdivenine dokunulmadi (DEVAM-4 §7 kural 3)
  ok('merdiven 5/15/45 aynen duruyor', /const BEKLEMELER = \[5000, 15000, 45000\]/.test(kaynak));
  ok('MESAJ_FREN 12sn aynen duruyor', /const MESAJ_FREN = 12 \* 1000/.test(kaynak));
  ok('MESAJ_BEKLE_TAVAN 20sn aynen duruyor', /const MESAJ_BEKLE_TAVAN = 20 \* 1000/.test(kaynak));
  ok('ESZAMANLI_KANAL 6 aynen duruyor', /const ESZAMANLI_KANAL = 6/.test(kaynak));
  ok('RATE_SOGUMA merdiveni aynen duruyor', /RATE_SOGUMA = \[30 \* 1000, 2 \* 60 \* 1000, 5 \* 60 \* 1000, 15 \* 60 \* 1000\]/.test(kaynak));
}

console.log('\n─────────────────────────────');
console.log('GECTI: ' + gecti + ' | KALDI: ' + kaldi);
console.log('\nNOT: Test 3 gecmesi "hata bulundu" demektir, "duzeltildi" demek DEGIL.');
console.log('     Desen kasitli olarak degistirilmedi. Once canlidan kanit.');
process.exit(kaldi ? 1 : 0);
