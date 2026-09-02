// RATE DESEN DUZELTMESI TESTI (2026-09)
//
// OLCULEN SORUN (1 Eylul canli log):
//   HIZ SINIRI: 64 | Mesaj freni: 375 | en yavas gonderim 20.6sn (= tavan)
//   ama "rate-overlimit" metni logda sadece 8 kez.
// SEBEP: desen ciplak "429" ariyordu; arama metnine e.data JSON'u da katiliyor
//   ve WhatsApp grup JID'leri uzun sayilar. Kullanicinin GERCEK grubu
//   120363429013002261 icinde "429" geciyor -> siradan zaman asimi "hiz limiti"
//   sayilip tum hatti tek siraya dusuruyordu.
// DUZELTME: 429 artik sadece TEK BASINA sayi (durum kodu) olarak eslesir.
//
// Fonksiyonlar/desenler server.js'ten CIKARILIP burada calistirilir.
const fs = require('fs');
const path = require('path');

const kaynak = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
let gecti = 0, kaldi = 0;
function ok(ad, sart) {
  if (sart) { gecti++; console.log('  GECTI  ' + ad); }
  else { kaldi++; console.log('  KALDI  ' + ad); }
}

// Desenleri server.js'ten AYNEN al (kopyalamiyoruz — kaynagin kendisi test ediliyor)
function desenAl(ad) {
  const s = (kaynak.match(new RegExp('^const ' + ad + ' = (.+);$', 'm')) || [])[1];
  if (!s) throw new Error(ad + ' bulunamadi');
  return eval(s);
}
const YENI = desenAl('_RATE_DESEN');
const ESKI = desenAl('_RATE_DESEN_ESKI');

// kuyrukluGonder'in kurdugu arama metnini birebir taklit et
const metin = (e) => (e && e.message ? e.message : '') + ' ' + (e && e.data ? JSON.stringify(e.data) : '');
const yeni = (e) => YENI.test(metin(e));
const eski = (e) => ESKI.test(metin(e));

// Kullanicinin 1 Eylul "YAVAS gonderim" logundan alinan GERCEK gruplari
const GERCEK_GRUPLAR = [
  '120363421720128576', '120363407400080038', '120363423033016718',
  '120363409289068485', '120363026532175909', '280139241939152',
  '120363429013002261', '120363423723816823',
];

// ═══ TEST 1: GERCEK HIZ LIMITLERI HALA YAKALANIYOR ═════════════════
// En kritik test. Duzeltme korumayi SOKMEMELI.
console.log('\n== TEST 1: gercek hiz limitleri hala yakalaniyor (koruma duruyor) ==');
{
  ok('rate-overlimit', yeni({ message: 'rate-overlimit' }));
  ok('rate overlimit (bosluklu)', yeni({ message: 'rate overlimit' }));
  ok('Too Many Requests', yeni({ message: 'Too Many Requests' }));
  ok('rate-limit exceeded', yeni({ message: 'rate-limit exceeded' }));
  ok('rate limit (bosluklu)', yeni({ message: 'rate limit reached' }));
  ok('statusCode 429 (durum kodu)', yeni({ message: 'request failed', data: { statusCode: 429 } }));
  ok('metinde "status code 429"', yeni({ message: 'Request failed with status code 429' }));
  ok('tek basina 429', yeni({ message: '429' }));
  ok('data icinde code:429', yeni({ message: 'hata', data: { code: 429 } }));
  ok('BUYUK/kucuk harf farketmiyor', yeni({ message: 'RATE-OVERLIMIT' }));
}

// ═══ TEST 2: SAHTE FREN ARTIK OLMUYOR ══════════════════════════════
console.log('\n== TEST 2: sahte fren duzeldi (kullanicinin GERCEK gruplariyla) ==');
{
  const kirli = GERCEK_GRUPLAR.filter(j => /429/.test(j));
  ok('kullanicinin gruplarindan biri "429" iceriyor (hatanin kaynagi)', kirli.length >= 1);
  console.log('         ilgili grup: ' + kirli.join(', '));

  const zamanAsimi = { message: 'gonderim zaman asimi', data: { to: '120363429013002261@g.us' } };
  ok('ESKIDEN: siradan zaman asimi "hiz limiti" sayiliyordu', eski(zamanAsimi) === true);
  ok('ARTIK  : hiz limiti SAYILMIYOR (sahte fren onlendi)', yeni(zamanAsimi) === false);

  const kopma = { message: 'baglanti kapandi', data: { id: '3EB0429A17C2' } };
  ok('mesaj kimliginde 429 -> eskiden fren, artik degil', eski(kopma) === true && yeni(kopma) === false);

  const kisi = { message: 'zaman asimi', data: { to: '905321234429@s.whatsapp.net' } };
  ok('telefon numarasi 429 ile bitiyor -> eskiden fren, artik degil', eski(kisi) === true && yeni(kisi) === false);

  // Ayni hata, iki farkli grup -> ARTIK ayni sonuc (eskiden zit sonuc veriyordu)
  const a = { message: 'gonderim zaman asimi', data: { to: '120363429013002261@g.us' } };
  const b = { message: 'gonderim zaman asimi', data: { to: '120363421720128576@g.us' } };
  ok('ESKIDEN ayni hata farkli grupta ZIT sonuc veriyordu', eski(a) !== eski(b));
  ok('ARTIK ayni hata her grupta AYNI sonuc veriyor', yeni(a) === yeni(b));

  // Kullanicinin TUM gruplari icin: masum hata artik hicbirinde fren tetiklemiyor
  const frenleyen = GERCEK_GRUPLAR.filter(j => yeni({ message: 'gonderim zaman asimi', data: { to: j + '@g.us' } }));
  ok('8 gercek grubun HICBIRI masum hatada fren tetiklemiyor', frenleyen.length === 0);
  const eskiFrenleyen = GERCEK_GRUPLAR.filter(j => eski({ message: 'gonderim zaman asimi', data: { to: j + '@g.us' } }));
  console.log('         (eskiden ' + eskiFrenleyen.length + '/' + GERCEK_GRUPLAR.length + ' grup masum hatada fren tetikliyordu)');
}

// ═══ TEST 3: DESEN HIJYENI ═════════════════════════════════════════
console.log('\n== TEST 3: desen hijyeni ==');
{
  ok('yeni desende g bayragi YOK (lastIndex tuzagi)', !YENI.flags.includes('g'));
  ok('eski desende g bayragi YOK', !ESKI.flags.includes('g'));
  ok('karar YENI deseni kullaniyor', /const rateMi = _RATE_DESEN\.test\(m\)/.test(kaynak));
  ok('police ucu de YENI deseni kullaniyor', (kaynak.match(/_RATE_DESEN\.test\(m\)/g) || []).length === 2);
  ok('ESKI desen SADECE sayacta kullaniliyor', (kaynak.match(/_RATE_DESEN_ESKI/g) || []).length === 2);
  ok('kod icinde elle yazilmis kopya desen kalmadi',
     (kaynak.match(/\/rate\.\?overlimit\|429\|too many\|rate\.\?limit\/i/g) || []).length === 1);

  // ayni .test() iki kez cagrilinca ayni sonucu vermeli (lastIndex kontrolu)
  const t = 'rate-overlimit';
  ok('ayni metin ust uste 3 kez ayni sonucu veriyor',
     YENI.test(t) === true && YENI.test(t) === true && YENI.test(t) === true);
}

// ═══ TEST 4: OLCUM KAYBOLMADI ══════════════════════════════════════
console.log('\n== TEST 4: duzeltme ise yaradi mi, sayabiliyor muyuz? ==');
{
  ok('SAHTE FREN ONLENDI sayaci var', /_sahteFrenSayaci\+\+/.test(kaynak));
  ok('sayac sadece ilk denemede artiyor (log seli yok)',
     /if \(!rateMi && _deneme === 0 && _RATE_DESEN_ESKI\.test\(m\)\)/.test(kaynak));
  ok('gercek limitler de loglaniyor (RATE TESPIT)', /🔬 RATE TESPIT/.test(kaynak));
  ok('hata metinleri kirpiliyor (log sismesin)',
     (kaynak.match(/slice\(0, 90\)/g) || []).length >= 2 && (kaynak.match(/slice\(0, 140\)/g) || []).length >= 2);
}

// ═══ TEST 5: BASKA HICBIR SEYE DOKUNULMADI ═════════════════════════
console.log('\n== TEST 5: gonderim davranisi degismedi (DEVAM-4 §7 kural 3) ==');
{
  ok('merdiven 5/15/45 aynen duruyor', /const BEKLEMELER = \[5000, 15000, 45000\]/.test(kaynak));
  ok('MESAJ_FREN 12sn aynen', /const MESAJ_FREN = 12 \* 1000/.test(kaynak));
  ok('MESAJ_BEKLE_TAVAN 20sn aynen', /const MESAJ_BEKLE_TAVAN = 20 \* 1000/.test(kaynak));
  ok('ESZAMANLI_KANAL 6 aynen', /const ESZAMANLI_KANAL = 6/.test(kaynak));
  ok('ESZAMANLI_KISITLI 1 aynen', /const ESZAMANLI_KISITLI = 1/.test(kaynak));
  ok('RATE_SOGUMA 30sn/2dk/5dk/15dk aynen',
     /RATE_SOGUMA = \[30 \* 1000, 2 \* 60 \* 1000, 5 \* 60 \* 1000, 15 \* 60 \* 1000\]/.test(kaynak));
  ok('bellek esikleri 3000/5000 aynen',
     /BELLEK_UYARI_MB = 3000/.test(kaynak) && /BELLEK_KRITIK_MB = 5000/.test(kaynak));
  ok('_rateSinirinaTakildi cagrisi yerinde',
     /_rateSinirinaTakildi\(lineId, d, _deneme === 0, true\)/.test(kaynak));
}

console.log('\n─────────────────────────────');
console.log('GECTI: ' + gecti + ' | KALDI: ' + kaldi);
process.exit(kaldi ? 1 : 0);
