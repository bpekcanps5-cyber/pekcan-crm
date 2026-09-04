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
  const f = new Function('process', 'panelKullaniciAdlari', '_normAd', 'lidToPn', 'console', '_envDosyasindanOku',
    kod + '\nreturn { ekipMi: ekipUyesiMi, yukle: ekipNumaralariYukle, set: EKIP_NUMARALAR, hane: _sonOnHane };');
  // .env dosyasi YOK taklidi -> process.env yoluna dussun
  return f(process_, adlar, (s) => (s || '').toLocaleLowerCase('tr').trim(), new Map(), { log: () => {} }, () => '');
}

// ═══ TEST 1: SIKAYETIN TA KENDISI (numara listesi YOK — normal durum) ═
// GERCEK KURULUM: ekip uyelerinin KENDI WhatsApp numarasi YOK.
// Herkes tek ofis hattindan, PANEL uzerinden yaziyor.
console.log('\n== TEST 1: "Mustafa" sikayeti — ekip panelden yaziyor ==');
{
  const F = kur('', ['mustafa', 'efe riza']);   // EKIP_NUMARALAR BOS (normal durum)

  // Gruba KENDI telefonundan yazan "Mustafa" -> MUSTERI, rozet ALMAMALI
  ok('gruba telefonundan yazan "Mustafa" -> EKIP DEGIL (sikayet cozuldu)',
     F.ekipMi('Mustafa', '905559998877@s.whatsapp.net') === false);

  // Ekipte ayni isim olmasi hicbir sey degistirmemeli
  ok('ekipte ayni isim olmasi rozet KAZANDIRMIYOR',
     F.ekipMi('Efe Rıza', '905551112222@s.whatsapp.net') === false);

  // Ekipte hic olmayan isim de tabii ki degil
  ok('ekipte olmayan isim -> EKIP DEGIL', F.ekipMi('Ahmet', '905551112233@s.whatsapp.net') === false);
  console.log('         -> gruba telefondan yazan HERKES musteri; ekip zaten panelden yaziyor');

  // WhatsApp disi cagri (jid yok): ic mesajlasma / robot -> eski davranis
  ok('jid YOKSA (ic mesajlasma/robot) isim davranisi korunuyor',
     F.ekipMi('Mustafa') === true);
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

// ═══ TEST 3: ISTISNA — biri telefonundan da yaziyorsa ══════════════
console.log('\n== TEST 3: EKIP_NUMARALAR dolu ise (istisna durum) ==');
{
  const F = kur('905321112233', ['mustafa']);
  ok('listedeki numara -> EKIP (rozet dogru)',
     F.ekipMi('Mustafa', '905321112233@s.whatsapp.net') === true);
  ok('listede olmayan ayni isim -> EKIP DEGIL',
     F.ekipMi('Mustafa', '905559998877@s.whatsapp.net') === false);
  console.log('         -> normalde bu listeye gerek yok, bos kalabilir');
}

// ═══ TEST 4: GUVENLI VARSAYILANLAR ════════════════════════════════
console.log('\n== TEST 4: sinir durumlar ==');
{
  const F = kur('', ['mustafa']);
  ok('jid bossa isme dusuyor (ic cagri sayilir)', F.ekipMi('Mustafa', '') === true);
  ok('ad da jid de yoksa false', F.ekipMi('', '') === false);
  ok('null degerler cokertmiyor', F.ekipMi(null, null) === false);
  ok('jid varsa isim ASLA yetmiyor', F.ekipMi('Mustafa', '9@s.whatsapp.net') === false);

  const G = kur('905321112233', ['mustafa']);
  ok('numara listesi varken cozulemeyen kisa jid -> yine EKIP DEGIL',
     G.ekipMi('Mustafa', '123@s.whatsapp.net') === false);
}

// ═══ TEST 5: LID COZUMU ════════════════════════════════════════════
console.log('\n== TEST 5: LID -> numara cevrimi ==');
{
  const adlar = new Set(['mustafa']);
  const lidHarita = new Map([['77777@lid', '905321112233@s.whatsapp.net']]);
  const f = new Function('process', 'panelKullaniciAdlari', '_normAd', 'lidToPn', 'console', '_envDosyasindanOku',
    kod + '\nreturn ekipUyesiMi;');
  const ekipMi = f({ env: { EKIP_NUMARALAR: '905321112233' } }, adlar,
                   (s) => (s || '').toLocaleLowerCase('tr').trim(), lidHarita, { log: () => {} }, () => '');
  ok('bilinen LID gercek numaraya cevrilip EKIP bulunuyor', ekipMi('Mustafa', '77777@lid') === true);
  ok('bilinmeyen LID -> EKIP DEGIL (isim aldatamaz)', ekipMi('Mustafa', '88888@lid') === false);
}

// ═══ TEST 6: KOD BAGLANTILARI ══════════════════════════════════════
console.log('\n== TEST 6: her iki kullanim yeri de jid veriyor mu? ==');
{
  ok('ROZET: numara listesi bos ise gruba yazan ASLA rozet almiyor',
     /senderOfis = !!\(EKIP_NUMARALAR\.size && kayitliIsim/.test(kaynak));
  ok('AKTIVITE: fromMe (panel) veya acik numara listesi',
     /const sayilsinMi = fromMe\s*\n\s*\|\| \(EKIP_NUMARALAR\.size > 0/.test(kaynak));
  ok('jid varsa isim eslesmesi devre disi', /if \(jid\) return false;/.test(kaynak));
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
  const F = kur('', ['mustafa']);
  ok('MUSTERININ "ilgileniyorum"u ekip aktivitesi SAYILMIYOR (rapor duzeldi)',
     F.ekipMi('Mustafa', '905559998877@s.whatsapp.net') === false);
  console.log('         -> panelden yazilan (fromMe) sayilmaya devam ediyor');
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


// ═══ TEST 9: pm2 ORTAM DEGISKENI TUZAGI ════════════════════════════
console.log('\n== TEST 9: .env dosyasi dogrudan okunuyor mu? ==');
{
  const adlar = new Set(['mustafa']);
  const mk = (envDosya, processEnv) => {
    const f = new Function('process', 'panelKullaniciAdlari', '_normAd', 'lidToPn', 'console', '_envDosyasindanOku',
      kod + '\nreturn { ekipMi: ekipUyesiMi, set: EKIP_NUMARALAR };');
    return f({ env: { EKIP_NUMARALAR: processEnv } }, adlar,
             (s) => (s || '').toLocaleLowerCase('tr').trim(), new Map(), { log: () => {} },
             (ad) => (ad === 'EKIP_NUMARALAR' ? envDosya : ''));
  };

  // GERCEK SENARYO: .env'de numara VAR ama pm2 process.env'e enjekte ETMEMIS
  const A = mk('905321112233', undefined);
  ok('pm2 process.env bos olsa da .env DOSYASINDAN okunuyor', A.set.size === 1);
  ok('=> duz "pm2 restart" ile ozellik CALISIYOR',
     A.ekipMi('Mustafa', '905559998877@s.whatsapp.net') === false);
  console.log('         -> kodun kendi uyarisi (satir ~9931) bu tuzagi anlatiyor');

  // .env yoksa process.env yedegi
  const B = mk('', '905321112233');
  ok('.env okunamazsa process.env yedegi calisiyor', B.set.size === 1);

  // ikisi de yoksa eski davranis
  const C = mk('', undefined);
  ok('ikisi de yoksa gruba yazan ASLA ekip degil (dogru varsayilan)',
     C.ekipMi('Mustafa', '905559998877@s.whatsapp.net') === false);

  ok('kod once .env dosyasini deniyor', /_envDosyasindanOku\('EKIP_NUMARALAR'\)/.test(kaynak));
  ok('process.env yedek olarak duruyor', /if \(!ham\) ham = process\.env\.EKIP_NUMARALAR/.test(kaynak));
  ok('2 dakikada bir tazeleniyor (restart gerekmesin)', /ekipNumaralariYukle\(true\)/.test(kaynak));
  ok('degisiklik yoksa log yazmiyor', /if \(onceki !== sonraki\)/.test(kaynak));
}

console.log('\n─────────────────────────────');
console.log('GECTI: ' + gecti + ' | KALDI: ' + kaldi);
process.exit(kaldi ? 1 : 0);
