// EKIP KIMLIGI TESTI (2026-09) — "musteri ama panel kullanicisi gibi gorunuyor"
//
// SIKAYET: gruptaki musteri "Mustafa", ekipte de "Mustafa" adinda panel
// kullanicisi var -> musteri EKIP ROZETI aliyor.
// SEBEP: ekipUyesiMi SADECE ISME bakiyordu. Isim kimlik degildir.
// COZUM: .env'deki EKIP_NUMARALAR ile NUMARA karsilastirmasi.
//
// Iki yerde zarar veriyordu:
//   server.js:senderOfis  -> panel rozeti
//   server.js:sayilsinMi  -> "ilgileniyorum" sayimi (RAPOR BOZULUYOR)
const fs = require('fs');
const path = require('path');

const kaynak = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
let gecti = 0, kaldi = 0;
function ok(ad, sart) {
  if (sart) { gecti++; console.log('  GECTI  ' + ad); }
  else { kaldi++; console.log('  KALDI  ' + ad); }
}

// Kimlik kodunu server.js'ten CIKAR
const kod = kaynak.slice(kaynak.indexOf('const EKIP_NUMARALAR = new Set()'),
                         kaynak.indexOf('// başlangıçta + her 2 dakikada bir'));

function kur(envDegeri, ekipIsimleri = []) {
  const adlar = new Set(ekipIsimleri.map(x => x.toLocaleLowerCase('tr').trim()));
  const process_ = { env: { EKIP_NUMARALAR: envDegeri } };
  const f = new Function('process', 'panelKullaniciAdlari', '_normAd', 'lidToPn', 'console',
    kod + '\nreturn { ekipMi: ekipUyesiMi, yukle: ekipNumaralariYukle, set: EKIP_NUMARALAR, hane: _sonOnHane };');
  return f(process_, adlar, (s) => (s || '').toLocaleLowerCase('tr').trim(), new Map(), { log: () => {} });
}

// ═══ TEST 1: SIKAYETIN TA KENDISI ══════════════════════════════════
console.log('\n== TEST 1: "Mustafa" sikayeti ==');
{
  // Ekipte Mustafa adinda panel kullanicisi var. Numarasi: 905321112233
  const F = kur('905321112233', ['mustafa', 'efe riza']);

  // GERCEK ekip uyesi Mustafa
  ok('gercek ekip Mustafa -> EKIP (rozet dogru)',
     F.ekipMi('Mustafa', '905321112233@s.whatsapp.net') === true);

  // MUSTERI Mustafa — ayni isim, BASKA numara
  ok('MUSTERI Mustafa -> EKIP DEGIL (sikayet cozuldu)',
     F.ekipMi('Mustafa', '905559998877@s.whatsapp.net') === false);
  console.log('         -> ayni isim, farkli numara, DOGRU sonuc');

  // Ekipte hic olmayan isim
  ok('ekipte olmayan isim -> EKIP DEGIL', F.ekipMi('Ahmet', '905551112233@s.whatsapp.net') === false);
}

// ═══ TEST 2: NUMARA YAZIM SERBESTLIGI ══════════════════════════════
console.log('\n== TEST 2: numara nasil yazilirsa yazilsin bulunmali ==');
{
  const F = kur('+90 532 111 22 33, 0533-999-8877 ; 5324445566', ['mustafa']);
  ok('3 numara da yuklendi', F.set.size === 3);
  ok('+90 bosluklu yazim eslesiyor', F.ekipMi('Mustafa', '905321112233@s.whatsapp.net') === true);
  ok('0 ile baslayan yazim eslesiyor', F.ekipMi('Mustafa', '905339998877@s.whatsapp.net') === true);
  ok('bassiz yazim eslesiyor', F.ekipMi('Mustafa', '905324445566@s.whatsapp.net') === true);
  ok('90 onekli/oneksiz ayni kisi sayiliyor', F.ekipMi('Mustafa', '5321112233@s.whatsapp.net') === true);
  ok('jid\'de cihaz eki (:12) sorun cikarmiyor', F.ekipMi('Mustafa', '905321112233:12@s.whatsapp.net') === true);
}

// ═══ TEST 3: GERI UYUM — ENV BOSSA HICBIR SEY BOZULMAZ ═════════════
console.log('\n== TEST 3: EKIP_NUMARALAR bos ise eski davranis ==');
{
  const F = kur('', ['mustafa']);
  ok('numara yuklenmedi', F.set.size === 0);
  ok('env bosken ISIM eslesmesi calisiyor (eski davranis)',
     F.ekipMi('Mustafa', '905559998877@s.whatsapp.net') === true);
  ok('env bosken ekipte olmayan isim yine false', F.ekipMi('Ahmet', '9055@s.whatsapp.net') === false);
  console.log('         -> bu dosya kurulunca hicbir sey bozulmaz, numara girilince duzelir');
}

// ═══ TEST 4: NUMARA COZULEMEZSE GUVENLI DAVRANIS ═══════════════════
console.log('\n== TEST 4: numara yoksa/cozulemezse ==');
{
  const F = kur('905321112233', ['mustafa']);
  ok('jid hic verilmezse isme dusuyor (eski davranis)', F.ekipMi('Mustafa') === true);
  ok('jid bossa isme dusuyor', F.ekipMi('Mustafa', '') === true);
  ok('anlamsiz kisa numara -> isme dusuyor', F.ekipMi('Mustafa', '123@s.whatsapp.net') === true);
  ok('ad da jid de yoksa false', F.ekipMi('', '') === false);
  ok('null degerler cokertmiyor', F.ekipMi(null, null) === false);
}

// ═══ TEST 5: LID COZUMU ════════════════════════════════════════════
console.log('\n== TEST 5: LID -> numara cevrimi ==');
{
  const adlar = new Set(['mustafa']);
  const lidHarita = new Map([['77777@lid', '905321112233@s.whatsapp.net']]);
  const f = new Function('process', 'panelKullaniciAdlari', '_normAd', 'lidToPn', 'console',
    kod + '\nreturn ekipUyesiMi;');
  const ekipMi = f({ env: { EKIP_NUMARALAR: '905321112233' } }, adlar,
                   (s) => (s || '').toLocaleLowerCase('tr').trim(), lidHarita, { log: () => {} });
  ok('bilinen LID gercek numaraya cevrilip EKIP bulunuyor', ekipMi('Mustafa', '77777@lid') === true);
  ok('bilinmeyen LID -> isme dusuyor (guvenli)', ekipMi('Mustafa', '88888@lid') === true);
}

// ═══ TEST 6: KOD BAGLANTILARI ══════════════════════════════════════
console.log('\n== TEST 6: her iki kullanim yeri de jid veriyor mu? ==');
{
  ok('panel ROZETI jid ile karar veriyor',
     /ekipUyesiMi\(kayitliIsim, _gonderenJid\)/.test(kaynak));
  ok('AKTIVITE sayimi jid ile karar veriyor',
     /ekipUyesiMi\(aktKisiAdiOn, senderJid \|\| m\.key\.participant \|\| ''\)/.test(kaynak));
  ok('jid\'siz cagri kalmadi (whapi disi)',
     !/ekipUyesiMi\((kayitliIsim|aktKisiAdiOn)\)/.test(kaynak));
  ok('fonksiyon iki parametre aliyor', /function ekipUyesiMi\(ad, jid\)/.test(kaynak));
  ok('sahte rozet sayaci var (etki olculebilsin)', /_sahteRozetSayaci\+\+/.test(kaynak));
  ok('acilista ekip numaralari yukleniyor', /^ekipNumaralariYukle\(\);$/m.test(kaynak));
  ok('env bos ise uyari loglaniyor', /EKIP_NUMARALAR bos/.test(kaynak));
}

// ═══ TEST 7: RAPOR BOZULMASI DA DUZELDI ════════════════════════════
console.log('\n== TEST 7: "ilgileniyorum" sayimi ==');
{
  const F = kur('905321112233', ['mustafa']);
  // Musteri "ilgileniyorum" yazarsa ekip aktivitesi SAYILMAMALI
  ok('musterinin mesaji ekip aktivitesi SAYILMIYOR (rapor duzeldi)',
     F.ekipMi('Mustafa', '905559998877@s.whatsapp.net') === false);
  ok('gercek ekip uyesinin mesaji SAYILIYOR',
     F.ekipMi('Mustafa', '905321112233@s.whatsapp.net') === true);
}

// ═══ TEST 8: ONCEKI DUZELTMELER YERINDE ════════════════════════════
console.log('\n== TEST 8: hicbir sey bozulmadi ==');
{
  ok('bosluk denetcisi duruyor', /function boslukDenetle/.test(kaynak));
  ok('bosluk dogrulamasi eklendi', /BOSLUK KURTARILDI/.test(kaynak));
  ok('uyarlanan sessizlik bekcisi duruyor', /uyarlananSessizlikEsigi\(line\)/.test(kaynak));
  ok('cikis dugmesi korumasi duruyor', /GUVENLI TAZELEME/.test(kaynak));
  ok('QR yol duzeltmesi duruyor', /path\.join\(AUTH_BASE, 'ofis', 'creds\.json'\)/.test(kaynak));
  ok('rate desen duzeltmesi duruyor', /\(\?<!\[0-9\]\)429\(\?!\[0-9\]\)/.test(kaynak));
  ok('gonderim merdiveni 5/15/45 aynen', /const BEKLEMELER = \[5000, 15000, 45000\]/.test(kaynak));
  ok('IPTAL ROBOTU hala ekip sayiliyor', /panelKullaniciAdlari\.add\(_normAd\('İPTAL ROBOTU'\)\)/.test(kaynak));
}

console.log('\n─────────────────────────────');
console.log('GECTI: ' + gecti + ' | KALDI: ' + kaldi);
process.exit(kaldi ? 1 : 0);
