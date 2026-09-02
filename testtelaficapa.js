// TELAFI CAPA DUZELTMESI TESTI (2026-09)
// Olculen sorun: restart sonrasi loadFromDB() sohbetleri `messages: []` ile
// yukluyor, telafi capasiz kaliyor, 30 grubun 30'u atlanıyor (denendi = 0).
// Bu test ONCE eski davranisi taklit edip hatayi gosterir, SONRA duzeltmenin
// ayni senaryoda calistigini dogrular.
//
// Fonksiyonlar server.js'ten CIKARILIP burada calistirilir. Sahte sock, sahte db.
const fs = require('fs');
const path = require('path');

const kaynak = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
let gecti = 0, kaldi = 0;
function ok(ad, sart) {
  if (sart) { gecti++; console.log('  GECTI  ' + ad); }
  else { kaldi++; console.log('  KALDI  ' + ad); }
}

function cikar(baslangic, bitis) {
  const i = kaynak.indexOf(baslangic);
  if (i < 0) throw new Error('bulunamadi: ' + baslangic);
  const j = kaynak.indexOf(bitis, i);
  if (j < 0) throw new Error('sonu bulunamadi: ' + baslangic);
  return kaynak.slice(i, j + bitis.length);
}

// ── telafi kodunu server.js'ten cikar ──────────────────────────────
const TELAFI_KOD = cikar('async function _telafiCapasi(c)',
  "} catch (e) { console.log('⚠️ Kaçan mesaj telafisi hatası:', e.message); }\n}");

// Bekleme cagrilarini sifirla — test 12 saniye surmesin.
const HIZLI = TELAFI_KOD
  .replace(/setTimeout\(r, 2000\)/g, 'setTimeout(r, 0)')
  .replace(/setTimeout\(r, 400\)/g, 'setTimeout(r, 0)');

// Kurucu: sahte bagimliliklarla telafiyi ayaga kaldirir.
function kur({ chats, db, hizSinirindaMi, mesajTrafigiVar, console: cons }) {
  const f = new Function('chats', 'db', 'hizSinirindaMi', 'mesajTrafigiVar', 'console',
    HIZLI + '\nreturn { telafi: kacanMesajTelafi, capa: _telafiCapasi };');
  return f(chats, db, hizSinirindaMi, mesajTrafigiVar, cons || { log: () => {} });
}

// Sahte sock: fetchMessageHistory cagrilarini sayar.
function sahteSock(opts = {}) {
  const s = { cagrilar: [] };
  if (opts.fetchYok) return s;
  s.fetchMessageHistory = async (adet, key, ts) => { s.cagrilar.push({ adet, key, ts }); };
  return s;
}

// Sahte db: loadMessages(jid, limit, line) -> son mesaj satiri.
function sahteDb(opts = {}) {
  return {
    isReady: () => opts.hazir !== false,
    _sorgular: [],
    async loadMessages(jid, limit, line) {
      this._sorgular.push({ jid, limit, line });
      if (opts.patla) throw new Error('db patladi');
      if (opts.bos) return [];
      return [{ key_data: { id: 'DB-' + jid, remoteJid: jid }, ts: 1700000000000 }];
    },
  };
}

// 30 grup + 5 birebir sohbet uret. bellekteMesaj=false -> restart taklidi.
function sahteChats({ bellekteMesaj = false, grupSayisi = 30 } = {}) {
  const m = new Map();
  for (let i = 0; i < grupSayisi; i++) {
    const jid = 'g' + i + '@g.us';
    m.set(jid, {
      jid, isGroup: true, lastTs: 1700000000000 + i,
      messages: bellekteMesaj ? [{ id: 'BELLEK-' + i, key: { id: 'BELLEK-' + i }, ts: 1700000000000 + i }] : [],
    });
  }
  for (let i = 0; i < 5; i++) {
    const jid = '9053' + i + '@s.whatsapp.net';
    m.set(jid, { jid, isGroup: false, lastTs: 1799999999999, messages: [] });
  }
  return m;
}

const YOK = () => false;

(async () => {

// ═══ TEST 1: OLCULEN HATA — restart sonrasi capa yok ═══════════════
console.log('\n== TEST 1: restart senaryosu (olculen hata) ==');
{
  // ESKI davranis taklidi: sadece bellekten capa. DB'yi kapatarak birebir taklit.
  const db = sahteDb({ hazir: false });
  const chats = sahteChats({ bellekteMesaj: false });
  const sock = sahteSock();
  const { telafi } = kur({ chats, db, hizSinirindaMi: YOK, mesajTrafigiVar: YOK });
  await telafi(sock);
  ok('DB kapaliyken + bellek bos -> 0 istek (eski hata aynen ureliyor)', sock.cagrilar.length === 0);
}
{
  // DUZELTME: ayni senaryo, DB acik.
  const db = sahteDb();
  const chats = sahteChats({ bellekteMesaj: false });
  const sock = sahteSock();
  const { telafi } = kur({ chats, db, hizSinirindaMi: YOK, mesajTrafigiVar: YOK });
  await telafi(sock);
  ok('DUZELTME: restart sonrasi 30 grup icin istek atildi (eskiden 0 idi)', sock.cagrilar.length === 30);
  ok('capa DB\'den geldi (anahtar DB- onekli)', sock.cagrilar.every(c => c.key.id.startsWith('DB-')));
  ok('DB\'ye sadece 1\'er mesaj soruldu (agir sorgu yok)', db._sorgular.every(s => s.limit === 1));
  ok('DB sorgusu ofis hatti icin yapildi', db._sorgular.every(s => s.line === 'ofis'));
}

// ═══ TEST 2: BELLEK CAPASI ONCELIKLI ═══════════════════════════════
console.log('\n== TEST 2: bellekte mesaj varsa DB\'ye gidilmez ==');
{
  const db = sahteDb();
  const chats = sahteChats({ bellekteMesaj: true });
  const sock = sahteSock();
  const { telafi } = kur({ chats, db, hizSinirindaMi: YOK, mesajTrafigiVar: YOK });
  await telafi(sock);
  ok('30 istek atildi', sock.cagrilar.length === 30);
  ok('capa bellekten alindi', sock.cagrilar.every(c => c.key.id.startsWith('BELLEK-')));
  ok('DB hic sorgulanmadi (gereksiz yuk yok)', db._sorgular.length === 0);
}

// ═══ TEST 3: KAPSAM DEGISMEDI (kullanici karari) ═══════════════════
console.log('\n== TEST 3: kapsam dar kaldi — sadece gruplar, en fazla 30 ==');
{
  const db = sahteDb();
  const chats = sahteChats({ bellekteMesaj: false, grupSayisi: 100 });
  const sock = sahteSock();
  const { telafi } = kur({ chats, db, hizSinirindaMi: YOK, mesajTrafigiVar: YOK });
  await telafi(sock);
  ok('100 grup olsa bile en fazla 30 istek', sock.cagrilar.length === 30);
  ok('BIREBIR sohbetler dahil edilmedi (kullanici karari)',
     db._sorgular.every(s => s.jid.endsWith('@g.us')));
  ok('her gruptan 3 mesaj istendi (derinlik degismedi)',
     sock.cagrilar.every(c => c.adet === 3));
  ok('en aktif gruplar secildi (lastTs buyukten kucuge)',
     db._sorgular[0].jid === 'g99@g.us');
}

// ═══ TEST 4: HIZ LIMITI BEKCISI ════════════════════════════════════
console.log('\n== TEST 4: hiz limiti bekcisi (WhatsApp kopmasin) ==');
{
  const db = sahteDb();
  const chats = sahteChats({ bellekteMesaj: false });
  const sock = sahteSock();
  const { telafi } = kur({ chats, db, hizSinirindaMi: () => true, mesajTrafigiVar: YOK });
  await telafi(sock);
  ok('limitteyken hic istek atilmadi', sock.cagrilar.length === 0);
  ok('limitteyken DB bile sorgulanmadi', db._sorgular.length === 0);
}
{
  // 10 grup sonra limite girilirse yarida kesilmeli
  let sayac = 0;
  const db = sahteDb();
  const chats = sahteChats({ bellekteMesaj: false });
  const sock = sahteSock();
  const { telafi } = kur({
    chats, db, mesajTrafigiVar: YOK,
    hizSinirindaMi: () => (++sayac > 11),   // 1 giris kontrolu + 10 tur
  });
  await telafi(sock);
  ok('tur ortasinda limite girilince DURDU (30 degil)', sock.cagrilar.length === 10);
}

// ═══ TEST 5: DAYANIKLILIK ══════════════════════════════════════════
console.log('\n== TEST 5: dayaniklilik ==');
{
  const db = sahteDb({ patla: true });
  const chats = sahteChats({ bellekteMesaj: false });
  const sock = sahteSock();
  const { telafi } = kur({ chats, db, hizSinirindaMi: YOK, mesajTrafigiVar: YOK });
  let hata = null;
  try { await telafi(sock); } catch (e) { hata = e; }
  ok('DB patlasa bile telafi cokmez', hata === null);
  ok('DB patlayinca istek atilmaz (uydurma capa yok)', sock.cagrilar.length === 0);
}
{
  const db = sahteDb({ bos: true });
  const chats = sahteChats({ bellekteMesaj: false });
  const sock = sahteSock();
  const { telafi } = kur({ chats, db, hizSinirindaMi: YOK, mesajTrafigiVar: YOK });
  await telafi(sock);
  ok('DB\'de mesaj yoksa istek atilmaz', sock.cagrilar.length === 0);
}
{
  const db = sahteDb();
  const chats = sahteChats({ bellekteMesaj: false });
  const sock = sahteSock({ fetchYok: true });
  const { telafi } = kur({ chats, db, hizSinirindaMi: YOK, mesajTrafigiVar: YOK });
  let hata = null;
  try { await telafi(sock); } catch (e) { hata = e; }
  ok('fetchMessageHistory yoksa cokmeden cikar', hata === null);
  ok('fetchMessageHistory yoksa DB bosuna sorgulanmaz', db._sorgular.length === 0);
}

// ═══ TEST 6: ZAMANLAMA (cagri yerleri) ═════════════════════════════
console.log('\n== TEST 6: cagri zamanlamasi — grup firtinasina denk gelmesin ==');
{
  const ilkBlok = kaynak.slice(kaynak.indexOf('if (ilkKurulum) {'), kaynak.indexOf('} else {', kaynak.indexOf('if (ilkKurulum) {')));
  const yeniBaglantiBlok = kaynak.slice(kaynak.indexOf('} else {', kaynak.indexOf('if (ilkKurulum) {')), kaynak.indexOf('---- PAZARLAMA HATTI ----'));

  ok('ilk kurulumda agir cekim 8sn', /fetchAllGroups\(\), 8000/.test(ilkBlok));
  ok('ilk kurulumda telafi 120sn (firtinadan SONRA)',
     /kacanMesajTelafi\(sock\)[\s\S]{0,40}?12000\d/.test(ilkBlok));
  ok('yeniden baglanmada telafi 6sn (firtina yok)',
     /kacanMesajTelafi\(sock\)[\s\S]{0,40}?6000/.test(yeniBaglantiBlok));
  ok('telafi tam olarak 2 yerden cagriliyor',
     (kaynak.match(/kacanMesajTelafi\(sock\)\.catch/g) || []).length === 2);
  ok('eski kosulsuz 6sn cagrisi kaldirildi',
     !/broadcastHat\(lineId[\s\S]{0,600}?kacanMesajTelafi[\s\S]{0,40}?6000[\s\S]{0,80}?if \(lineId === 'ofis'\) \{\n        \/\/ ---- OFIS/.test(kaynak));
}

console.log('\n─────────────────────────────');
console.log('GECTI: ' + gecti + ' | KALDI: ' + kaldi);
process.exit(kaldi ? 1 : 0);

})();
