#!/usr/bin/env node
// ============================================================
// whapi-kur.js — server.js'e WHAPI kancalarini ekler
// ------------------------------------------------------------
// IKI yere dokunur, baska hicbir yere:
//   1) startWA() basina yonlendirme  -> whapi hatti Baileys'e HIC girmez
//   2) acilista whapi hattini baslatma + webhook ucunu kaydetme
//
// GUVENLI: once yedek alir, degisiklik yapamazsa DOKUNMAZ,
// sonunda soz dizimi kontrolu yapar, bozuksa YEDEGI GERI YUKLER.
// Iki kez calistirirsan ikinci kez hicbir sey yapmaz.
//
// Kullanim:  node whapi-kur.js
// Geri alma: node whapi-kur.js --geri
// ============================================================
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HEDEF = path.join(__dirname, 'server.js');
const YEDEK = path.join(__dirname, 'server.js.whapi-oncesi');

const ISARET = '/* ═══ WHAPI KANCASI ═══';

// ── 1) startWA yonlendirmesi ────────────────────────────────
const ARA_1 = "async function startWA(lineId = 'ofis') {\n";
const KOY_1 = `async function startWA(lineId = 'ofis') {
  ${ISARET} Bu hat Whapi ise Baileys yoluna HIC girme. */
  if (lineId === (process.env.WHAPI_LINE_ID || 'whapi')) {
    const _w = global._whapiKurulum;
    if (!_w) { console.log('[whapi] kurulum henuz hazir degil, atlandi'); return; }
    return _w.hattiBaslat().catch((e) => console.error('[whapi] baslatma hatasi:', e.message));
  }
  /* ═══ WHAPI KANCASI SONU ═══ */
`;

// ── 2) acilista baslatma ────────────────────────────────────
const ARA_2 = "  startWA(); // <-- veri yüklendikten SONRA\n";
const KOY_2 = `  ${ISARET} Whapi ikinci hat: webhook ucunu kaydet ve hatti ayaga kaldir.
     Baileys yolu bu bloktan ETKILENMEZ; hata olsa bile ofis hatti calisir. */
  try {
    const whapiHat = require('./whapi-hat');
    global._whapiKurulum = whapiHat.kur({
      addMessage, broadcastHat, hatChats, stripBirMesaj,
      lines, createLine, db, MEDIA_DIR,
      iletimDenetleTamam,
      kisiAdiBul: (jid) => savedContacts.get(jid) || contactNames.get(jid) || '',
      ekipUyesiMi, getGroupMeta, robotMedyaGeldi,
      kisiAdiKaydet: (jid, ad) => { try { contactNames.set(jid, ad); } catch (_) {} },
    }, app, express);
    if (process.env.WHAPI_TOKEN) {
      global._whapiKurulum.hattiBaslat()
        .then(() => console.log('[whapi] ikinci hat hazir'))
        .catch((e) => console.error('[whapi] hat baslatilamadi:', e.message));
    } else {
      console.log('[whapi] WHAPI_TOKEN yok — ikinci hat KAPALI (ofis normal calisiyor)');
    }
  } catch (e) {
    console.error('[whapi] kurulum atlandi:', e.message);
  }
  /* ═══ WHAPI KANCASI SONU ═══ */

  startWA(); // <-- veri yüklendikten SONRA
`;


// ── DORDUNCU KANCA: ZAMAN DAMGASI EZILMESI ──────────────────
// addMessage icinde:  message.ts = now;   <- VARIS zamani, KOSULSUZ.
// Baileys'te mesaj aninda geldigi icin varis ≈ gercek zaman, sorun
// gorunmuyordu. Whapi webhook'u gec gelince mesaj panelde YANLIS YERE
// dusuyor: saati '13:44' yaziyor ama 13:48'in altinda duruyor.
// Ayni sebeple panel-kullanicisi eslestirmesi de (3 sn'lik pencere)
// tutmuyor, gonderen adi 'OPERASYON MERKEZI' kaliyordu.
//
// GUVENLIK: server.js'teki 13 addMessage cagri yerinin HICBIRI 'ts'
// gecirmiyor (tek tek kontrol edildi). Yani Baileys yolunda message.ts
// her zaman undefined -> now'a duser -> DAVRANIS AYNEN KORUNUR.
// Sadece cevirici gercek damga koydugunda o damga KORUNUR.
const ARA_4 = '  message.ts = now; // gercek zaman damgasi (siralama icin)\n';
const KOY_4 = `  ${ISARET} Cevirici GERCEK WhatsApp zaman damgasi koyduysa EZME.
     Baileys yolu ts gecirmedigi icin orada davranis DEGISMEZ. */
  message.ts = (typeof message.ts === 'number' && message.ts > 0) ? message.ts : now;
  /* ═══ WHAPI KANCASI SONU ═══ */
`;



// ── BESINCI KANCA: KULLANICIYI WHAPI HATTINA AL ─────────────
// Kullanici yonetiminde tek dugmeyle kisiyi Whapi hattina alip geri
// Baileys'e dondurebilmek icin. MEVCUT ucu genisletiyoruz (/api/users/setline)
// — yeni uc acmiyoruz, yetki kontrolu ve akis aynen kaliyor.
// GECICI GECIS: ayni dugme tekrar basilinca 'ofis' yapar.
const ARA_5 = "  if (!isAdmin(req.body?.token)) return res.json({ ok: false, error: 'Yetki yok' });\n  const username = (req.body?.username || '').trim();\n  const tip = req.body?.tip === 'pazarlama' ? 'pazarlama' : 'ofis';";
const KOY_5 = `  ${ISARET} Iki degisiklik:
     1) 'whapi' tipi eklendi -> kullanici Whapi hattina alinabilsin.
     2) KENDINI OFISE DONDURME yetki istemez. Whapi hatti koptugunda
        kullanici kendi ekranindaki dugmeyle ANINDA Baileys'e donebilsin;
        yoneticiyi beklemek zorunda kalmasin.
        Bu YON GUVENLI: kimseye ekstra erisim vermez, herkesin zaten
        varsayilan hatti olan 'ofis'e dondurur ve SADECE KENDISI icin.
     Diger tum islemler eskisi gibi YONETICI ister. */
  const _wsess = req.body?.token ? sessions.get(req.body.token) : null;
  const _wtip = req.body?.tip;
  const _whedef = (req.body?.username || '').trim();
  const _wkendiGeriDonus = !!(_wsess && _whedef && _wsess.username === _whedef
    && (!_wtip || _wtip === 'ofis'));
  if (!_wkendiGeriDonus && !isAdmin(req.body?.token)) {
    return res.json({ ok: false, error: 'Yetki yok' });
  }
  const username = _whedef;
  const tip = (_wtip === 'pazarlama' || _wtip === 'whapi') ? _wtip : 'ofis';
  if (tip === 'ofis') setTimeout(() => _whapiOturumTazele(username, 'ofis', 'ofis'), 30);
  /* ═══ WHAPI KANCASI SONU ═══ */
`;

// Oturumu BELLEKTE tazele + o kullanicinin panelini otomatik yenile.
// whoami lineId'yi yalnizca HIC yoksa DB'den okuyor; bu yuzden oturum
// acikken DB'yi degistirmek YETMIYORDU, kullanici cikip girmek zorundaydi.
const ARA_7 = "app.post('/api/users/setline', express.json(), async (req, res) => {";
const KOY_7 = `${ISARET} Hat degisince oturumu BELLEKTE tazele ve paneli yenile.
   Boylece kullanici cikip girmek ZORUNDA KALMAZ. */
function _whapiOturumTazele(kullanici, hatId, hatTip) {
  try {
    for (const [, s] of sessions) {
      if (s && s.username === kullanici) { s.lineId = hatId; s.lineTip = hatTip; }
    }
  } catch (_) {}
  try {
    wss.clients.forEach((c) => {
      if (c.readyState === 1 && c._username === kullanici) {
        c._lineId = hatId;
        try { c.send(JSON.stringify({ type: 'hatDegisti', lineId: hatId, tip: hatTip })); } catch (_) {}
      }
    });
  } catch (_) {}
}
/* ═══ WHAPI KANCASI SONU ═══ */
app.post('/api/users/setline', express.json(), async (req, res) => {`;

const ARA_6 = "    if (tip === 'pazarlama') {";
const KOY_6 = `    ${ISARET} Whapi hattina alma dali. */
    if (tip === 'whapi') {
      const _wl = process.env.WHAPI_LINE_ID || 'whapi';
      await db.setUserLine(username, _wl, 'whapi');
      _whapiOturumTazele(username, _wl, 'whapi');
      console.log('🔧 Kullanici ' + username + ' WHAPI hattina alindi -> hat: ' + _wl);
      return res.json({ ok: true, username, lineId: _wl, tip: 'whapi',
        message: username + ' artik WHAPI hattinda.' });
    }
    /* ═══ WHAPI KANCASI SONU ═══ */
    if (tip === 'pazarlama') {`;


// ── ALTINCI KANCA: "HEPSINI OKUNDU YAP" ANINDA OLSUN ────────
// DERT: dugmeye basinca sayaclar tek tek, cok yavas sifirlaniyordu.
// SEBEP: dongu her sohbet icin  await SOCK.readMessages(...)  yapiyordu.
// Okunmamis 200 sohbet varsa 200 AG ISTEGI ARKA ARKAYA beklenir; islem
// dakikalar surer, kullanici yarisini gorup "calismiyor" der.
// COZUM: panel durumunu ONCE ve TOPLUCA guncelle (aninda 0 olur), okundu
// makbuzlarini ARKA PLANDA kucuk gruplar halinde yolla. Makbuz gitmese
// bile panel dogru; WhatsApp tarafi birkac saniye icinde yetisir.
const ARA_8 = `      else if (msg.type === 'markAllRead' && SOCK && CONNECTED) {
        for (const chat of C.values()) {
          if (chat.unread > 0 || chat.hasMention) {
            chat.unread = 0;
            chat.hasMention = false;
            try {
              const keys = chat.messages.filter(m => !m.fromMe && m.key).slice(-20).map(m => m.key);
              if (keys.length) await SOCK.readMessages(keys);
            } catch (e) {}
            if (db.isReady()) db.saveChat(chat, _LID).catch(() => {});
            broadcastHat(_LID, { type: 'message', jid: chat.jid, chat: stripRaw(chat) });
          }
        }
      }`;

const KOY_8 = `      else if (msg.type === 'markAllRead' && SOCK && CONNECTED) {
        ${ISARET} Once ANINDA sifirla + panele bildir, makbuzlari SONRA yolla. */
        const _okBekleyen = [];
        for (const chat of C.values()) {
          if (chat.unread > 0 || chat.hasMention) {
            chat.unread = 0;
            chat.hasMention = false;
            if (db.isReady()) db.saveChat(chat, _LID).catch(() => {});
            broadcastHat(_LID, { type: 'message', jid: chat.jid, chat: stripRaw(chat) });
            try {
              const keys = chat.messages.filter(m => !m.fromMe && m.key).slice(-20).map(m => m.key);
              if (keys.length) _okBekleyen.push(keys);
            } catch (e) {}
          }
        }
        // Panel ARTIK 0 gosteriyor. Makbuzlar arka planda, 5'erli gruplar
        // halinde gider; hata olsa bile panel dogru kalir.
        (async () => {
          for (let i = 0; i < _okBekleyen.length; i += 5) {
            const grup = _okBekleyen.slice(i, i + 5);
            await Promise.all(grup.map((k) => {
              try { return SOCK.readMessages(k).catch(() => {}); } catch (e) { return null; }
            }));
            await new Promise((r) => setTimeout(r, 120));
          }
        })().catch(() => {});
        console.log('👁 Hepsi okundu: ' + _okBekleyen.length + ' sohbet sifirlandi (makbuzlar arka planda)');
      }`;

// ── UCUNCU KANCA: addMessage EKSIK ARGUMAN HATASI ───────────
// addMessage(jid, message, meta = {}, lineId = 'ofis')
// Panelden gonderme yollarinda META ATLANMIS, hat kimligi onun yerine
// veriliyor:   addMessage(jid, {...}, _LID)
// Sonuc: _LID meta sanilir, GERCEK hat 'ofis'e duser.
//   • Panelden gonderilen mesaj OFIS bellegine yazilir
//   • Kendi hattinda BULUNAMAZ  -> silme/duzenleme calismaz
//     ("mesaj bulundu=false" satirinin sebebi budur)
//   • Ayrica whapi/pazarlama mesajlari ofis hattina karisir
// DUZELTME: eksik meta argumanini ekle.  }, _LID)  ->  }, {}, _LID)
// 'ofis' icin davranis DEGISMEZ (meta olarak string gecmek ile {} gecmek
// ayni sonucu veriyordu), pazarlama hatlari da bu duzeltmeden FAYDALANIR.
// DIKKAT: duz metin araması YANLIS sonuc verir, cunku dogru yazilmis
//   addMessage(..., { name: x }, _LID);
// cagrisi da '}, _LID);' dizisini ICERIR ve bozulur.
// Bu yuzden SADECE satir basinda (girintiden sonra) duran kapanisi hedefliyoruz:
//        }, _LID);      <- nesne kapanisi, meta EKSIK
const DESEN_3 = /(\n[ \t]*)\}, _LID\);/g;

function ucuncuKanca(kaynak) {
  let n = 0;
  const yeni = kaynak.replace(DESEN_3, (t, girinti) => { n += 1; return girinti + '}, {}, _LID);'; });
  return { kaynak: yeni, n };
}

function geriAl() {
  if (!fs.existsSync(YEDEK)) { console.log('✗ yedek yok, geri alinamiyor'); process.exit(1); }
  fs.copyFileSync(YEDEK, HEDEF);
  console.log('✔ server.js yedekten geri yuklendi (Whapi kancalari kaldirildi)');
  console.log('  simdi: pm2 restart pekcan');
}

function sozDizimi(dosya) {
  try { execFileSync(process.execPath, ['--check', dosya], { stdio: 'pipe' }); return null; }
  catch (e) { return String(e.stderr || e.message).slice(0, 400); }
}

function kur() {
  if (!fs.existsSync(HEDEF)) { console.log('✗ server.js bulunamadi. Proje klasorunde calistir.'); process.exit(1); }

  for (const d of ['whapi-hat.js', 'whapi-cevirici.js', 'whapi-adapter.js']) {
    if (!fs.existsSync(path.join(__dirname, d))) { console.log('✗ eksik dosya: ' + d); process.exit(1); }
  }

  let kaynak = fs.readFileSync(HEDEF, 'utf8');

  if (kaynak.includes(ISARET)) {
    console.log('• Kancalar ZATEN kurulu. Hicbir sey yapilmadi.');
    console.log('  Yeniden kurmak icin once:  node whapi-kur.js --geri');
    return;
  }

  const n1 = kaynak.split(ARA_1).length - 1;
  const n2 = kaynak.split(ARA_2).length - 1;
  const n4 = kaynak.split(ARA_4).length - 1;
  const n5 = kaynak.split(ARA_5).length - 1;
  const n6 = kaynak.split(ARA_6).length - 1;
  const n7 = kaynak.split(ARA_7).length - 1;
  const n8 = kaynak.split(ARA_8).length - 1;
  if (n1 !== 1) { console.log(`✗ startWA baslangici ${n1} kez bulundu (1 olmaliydi). DOKUNULMADI.`); process.exit(1); }
  if (n2 !== 1) { console.log(`✗ acilis satiri ${n2} kez bulundu (1 olmaliydi). DOKUNULMADI.`); process.exit(1); }
  if (n4 !== 1) { console.log(`✗ 'message.ts = now' satiri ${n4} kez bulundu (1 olmaliydi). DOKUNULMADI.`); process.exit(1); }
  if (n5 !== 1) { console.log(`✗ setline tip satiri ${n5} kez bulundu (1 olmaliydi). DOKUNULMADI.`); process.exit(1); }
  if (n6 !== 1) { console.log(`✗ setline pazarlama dali ${n6} kez bulundu (1 olmaliydi). DOKUNULMADI.`); process.exit(1); }
  if (n7 !== 1) { console.log(`✗ setline ucu ${n7} kez bulundu (1 olmaliydi). DOKUNULMADI.`); process.exit(1); }
  if (n8 !== 1) { console.log(`✗ markAllRead blogu ${n8} kez bulundu (1 olmaliydi). DOKUNULMADI.`); process.exit(1); }

  if (!fs.existsSync(YEDEK)) fs.copyFileSync(HEDEF, YEDEK);
  console.log('✔ yedek: server.js.whapi-oncesi');

  kaynak = kaynak.replace(ARA_1, KOY_1).replace(ARA_2, KOY_2).replace(ARA_4, KOY_4).replace(ARA_7, KOY_7).replace(ARA_5, KOY_5).replace(ARA_6, KOY_6).replace(ARA_8, KOY_8);
  const u = ucuncuKanca(kaynak);
  kaynak = u.kaynak;

  const gecici = path.join(__dirname, 'server.whapi-gecici.js');
  fs.writeFileSync(gecici, kaynak, 'utf8');

  const hata = sozDizimi(gecici);
  if (hata) {
    fs.unlinkSync(gecici);
    console.log('✗ yama sonrasi soz dizimi BOZUK — server.js\'e DOKUNULMADI:\n' + hata);
    process.exit(1);
  }

  fs.renameSync(gecici, HEDEF);

  const eski = fs.readFileSync(YEDEK, 'utf8').split('\n').length;
  const yeni = kaynak.split('\n').length;
  console.log('✔ uc kanca eklendi (' + eski + ' -> ' + yeni + ' satir)');
  console.log('✔ addMessage eksik arguman hatasi duzeltildi (' + u.n + ' yerde)');
  console.log('✔ zaman damgasi ezilmesi durduruldu (gercek ts korunuyor)');
  console.log('✔ kullanici WHAPI hattina alinabilir (kullanici yonetiminde dugme)');
  console.log('✔ hepsini okundu yap ANINDA calisiyor (makbuzlar arka planda)');
  console.log('✔ soz dizimi saglam');
  console.log('');
  console.log('Sonraki adim:  pm2 restart pekcan --update-env');
  console.log('Geri alma   :  node whapi-kur.js --geri');
}



if (process.argv.includes('--geri')) geriAl(); else kur();
