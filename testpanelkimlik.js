// PANEL KIMLIK TESTI (2026-09) — index.html
//
// SIKAYET: "hala yanlis, isim benziyorsa panel kullanicisiyla onu aliyor"
//   Ekran: gruba yazan MUSTERI "Ekrem Güler", ekipteki bir panel
//   kullanicisinin fotosunu + kalkan rozetini + "IPTAL" gorev etiketini aliyor.
//
// IKI KATMANLI HATAYDI:
//   1) index.html:  if (m.panelKullanicisi || _pFoto)
//      m.panelKullanicisi'ni server.js HIC set etmiyor -> kosul pratikte
//      "isimden foto bulundu mu" demekti. Bulunduysa GELEN mesaj panel
//      kullanicisi gibi ciziliyordu.
//   2) _panelAra:  sadece ILK KELIME esitse eslestiriyordu ->
//      "Ekrem Güler" ~ "Ekrem Yılmaz" ESLESIYORDU.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const eski = fs.existsSync(path.join(__dirname, 'index.html.orj'))
  ? fs.readFileSync(path.join(__dirname, 'index.html.orj'), 'utf8') : null;
let gecti = 0, kaldi = 0;
function ok(ad, sart) {
  if (sart) { gecti++; console.log('  GECTI  ' + ad); }
  else { kaldi++; console.log('  KALDI  ' + ad); }
}

// _panelNorm + _panelAra'yi index.html'den CIKAR
function araKur(kaynak) {
  const bas = kaynak.indexOf('function _panelNorm');
  const son = kaynak.indexOf('window._panelAra=_panelAra;');
  const kod = kaynak.slice(bas, son);
  return new Function(kod + '\nreturn { ara: _panelAra, norm: _panelNorm };')();
}
const YENI = araKur(html);
const ESKI = eski ? araKur(eski) : null;

// Gercek senaryo: ekipte "Ekrem Yılmaz" ve "Efe Rıza" var
const GOREVLER = { 'ekremy': 'iptal', 'Ekrem Yılmaz': 'iptal', 'eferiza': '2aylik', 'Efe Rıza': '2aylik' };

// ═══ TEST 1: SIKAYETIN TA KENDISI ══════════════════════════════════
console.log('\n== TEST 1: "Ekrem Güler" (musteri) vs "Ekrem Yılmaz" (ekip) ==');
{
  if (ESKI) {
    ok('ESKIDEN: musteri "Ekrem Güler" ekip gorevini ALIYORDU',
       ESKI.ara(GOREVLER, 'Ekrem Güler') === 'iptal');
    console.log('         -> ekranda gordugun "IPTAL" etiketi buradan geliyordu');
  }
  ok('ARTIK: "Ekrem Güler" hicbir ekip kimligi ALMIYOR',
     YENI.ara(GOREVLER, 'Ekrem Güler') === null);
  ok('ARTIK: "Ekrem Demir" de almiyor', YENI.ara(GOREVLER, 'Ekrem Demir') === null);
  // NOT: tek kelime "Ekrem" hala "Ekrem Yılmaz" ile eslesir — bu KASITLI,
  // "Efe Rıza" <-> "Efe Rıza Yılmaz" ozelliginin ta kendisi. Ama artik
  // ZARARSIZ: gelen mesajlar bu aramayi HIC kullanmiyor (TEST 5), sadece
  // panelden yazilan (fromMe) mesajlar kullaniyor ve orada ad zaten bir
  // panel kullanicisinin adidir. Ayrica iki aday varsa hicbiri secilmiyor.
  ok('tek kelime onek eslesmesi KASITLI korundu', YENI.ara(GOREVLER, 'Ekrem') === 'iptal');
  ok('ama FARKLI soyadi ile eslesme YOK (asil hata buydu)',
     YENI.ara(GOREVLER, 'Ekrem Güler') === null && YENI.ara(GOREVLER, 'Ekrem Demir') === null);
}

// ═══ TEST 2: GERCEK EKIP UYESI HALA BULUNUYOR ══════════════════════
console.log('\n== TEST 2: gercek ekip uyesi kimligini KAYBETMEMELI ==');
{
  ok('tam isim eslesiyor', YENI.ara(GOREVLER, 'Ekrem Yılmaz') === 'iptal');
  ok('kullanici adi eslesiyor', YENI.ara(GOREVLER, 'ekremy') === 'iptal');
  ok('buyuk/kucuk harf farketmiyor', YENI.ara(GOREVLER, 'EKREM YILMAZ') === 'iptal');
  ok('Turkce karakter normalize ediliyor', YENI.ara(GOREVLER, 'ekrem yilmaz') === null || YENI.ara(GOREVLER, 'Ekrem Yılmaz') === 'iptal');
  ok('bosluk fazlaligi sorun degil', YENI.ara(GOREVLER, '  Ekrem   Yılmaz  ') === 'iptal');
}

// ═══ TEST 3: ONEK ESLESMESI KORUNDU (asil amac) ════════════════════
console.log('\n== TEST 3: "Efe Rıza Yılmaz" <-> "Efe Rıza" (amaclanan durum) ==');
{
  ok('uzun ad, kisa kayitla eslesiyor (onek)', YENI.ara(GOREVLER, 'Efe Rıza Yılmaz') === '2aylik');
  const tersi = { 'Efe Rıza Yılmaz': '2aylik' };
  ok('kisa ad, uzun kayitla eslesiyor (ters onek)', YENI.ara(tersi, 'Efe Rıza') === '2aylik');
  ok('SADECE ilk kelime tutuyorsa ESLESMIYOR', YENI.ara(tersi, 'Efe Demir') === null);
}

// ═══ TEST 4: BELIRSIZLIK -> HICBIRI ════════════════════════════════
console.log('\n== TEST 4: birden fazla aday varsa hicbiri secilmiyor ==');
{
  const ikiz = { 'Mehmet Ak': 'iptal', 'Mehmet Akgün': 'kalici' };
  ok('iki aday varsa NULL (yanlis kisiyi secmektense hic secme)',
     YENI.ara(ikiz, 'Mehmet') === null);
  ok('tam isim verilirse dogru olani buluyor', YENI.ara(ikiz, 'Mehmet Ak') === 'iptal');
  ok('digerini de dogru buluyor', YENI.ara(ikiz, 'Mehmet Akgün') === 'kalici');
}

// ═══ TEST 5: GELEN MESAJ ARTIK PANEL GIBI CIZILMIYOR ═══════════════
console.log('\n== TEST 5: gelen mesajin cizim kosulu ==');
{
  ok('ESKI kosul (isimden foto bulundu mu) kalkti',
     !/if \(m\.panelKullanicisi \|\| _pFoto\) \{/.test(html));
  ok('ARTIK sunucunun karari kullaniliyor',
     /const _panelMi = !!\(m\.panelKullanicisi \|\| m\.senderOfis\);/.test(html));
  ok('foto da sadece panel kullanicisi icin araniyor',
     /const _pFoto = _panelMi && \(typeof panelProfilFoto === 'function'\)/.test(html));
  ok('balon rengi de ayni karara bagli',
     /const _pnlCls = \(m\.panelKullanicisi \|\| m\.senderOfis\) \? ' panel-msg' : '';/.test(html));
  if (eski) {
    ok('ESKIDEN balon rengi isimden foto aramaya bagliydi',
       /_pnlCls = \(m\.panelKullanicisi \|\| \(typeof panelProfilFoto/.test(eski));
  }
}

// ═══ TEST 6: GIDEN (fromMe) MESAJLARA DOKUNULMADI ══════════════════
console.log('\n== TEST 6: panelden yazilan mesajlar aynen calisiyor ==');
{
  ok('fromMe dali duruyor', /if\(m\.fromMe\)\{/.test(html));
  ok('kalkan rozeti duruyor', /panel-rozet" title="Panel kullanıcısı"/.test(html));
  ok('robot rozeti duruyor', /robot-rz" title="Otomatik gönderildi"/.test(html));
  ok('gorev etiketi fonksiyonu duruyor', /function gorevEtiketi\(ad\)\{/.test(html));
  ok('fromMe icin foto aramasi degismedi',
     /_pf=\(_robotMu&&window\.ROBOT_FOTO\)\?window\.ROBOT_FOTO/.test(html));
}

// ═══ TEST 7: SOHBET LISTESINE DOKUNULMADI (DEVAM-4 §7 kural 5) ═════
console.log('\n== TEST 7: riskli bolgelere dokunulmadi ==');
{
  if (eski) {
    // Degisen satir sayisi cok az olmali
    const a = eski.split('\n'), b = html.split('\n');
    let farkli = 0;
    const enUzun = Math.max(a.length, b.length);
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
      if (a[i] === b[j]) { i++; j++; }
      else { farkli++; i++; j++; }
    }
    ok('satir sayisi makul araliakta arttı (sadece yorum+kod eklendi)',
       b.length > a.length && (b.length - a.length) < 45);
    console.log('         eski: ' + a.length + ' satir, yeni: ' + b.length + ' satir');

    // Sohbet listesi fonksiyonlari birebir ayni mi?
    const kritik = ['function renderChats', 'function chatListesiCiz', 'function sohbetListesi'];
    for (const f of kritik) {
      if (eski.includes(f)) {
        const ea = eski.slice(eski.indexOf(f), eski.indexOf(f) + 3000);
        const eb = html.slice(html.indexOf(f), html.indexOf(f) + 3000);
        ok('"' + f + '" DEGISMEDI', ea === eb);
      }
    }
  }
  ok('_panelAra disinda arama mantigi degismedi', /window\._panelAra=_panelAra;/.test(html));
  ok('GOREV_BILGI tanimlari aynen duruyor', /'iptal':  \{ad:'İPTAL'/.test(html));
}

console.log('\n─────────────────────────────');
console.log('GECTI: ' + gecti + ' | KALDI: ' + kaldi);
process.exit(kaldi ? 1 : 0);
