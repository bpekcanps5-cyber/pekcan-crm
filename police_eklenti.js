/* =====================================================================
   POLICE TAKIP PANELI ENTEGRASYONU — server.js eklentisi
   (DUZELTILMIS SURUM — 2026-08)
   ---------------------------------------------------------------------
   Gelen eklentinin islevi aynen korundu, ancak CRM'in KENDI koruma
   katmanlarina baglandi. Ham surum bunlari ATLIYORDU ve bugun yasanan
   "rate-overlimit" kesintisinin aynisini tekrar yasatabilirdi.

   NEYIN NEDEN DEGISTIGI:

   1) GONDERIM ARTIK KUYRUKTAN GECIYOR  (en kritik)
      Ham surum: sock.sendMessage(...) — dogrudan sokete.
      Bu, CRM'in hiz siniri korumasini, sirali gonderim kuyrugunu ve
      yeniden deneme mantigini TAMAMEN atliyordu. Toplu gonderimde
      WhatsApp'i tikayip TUM ekibi etkileyebilirdi.
      Yeni: kuyrukluGonder(...) uzerinden. Boylece police mesajlari da
      normal mesajlarla ayni sirada, ayni korumayla gider.

   2) GRUP SORGULARI ONBELLEKTEN / ONCELIK KAPISINDAN
      Ham surum: her gonderimde s.groupMetadata(jid) — ek sorgu.
      Ham surum: groupFetchAllParticipating() — agir toplu sorgu.
      Yeni: grup listesi CRM'in KENDI sohbet listesinden uretiliyor
      (WhatsApp'a SIFIR sorgu). Yazma izni kontrolu getGroupMeta ile
      onbellekli yapiliyor.

   3) BAGLANTI KONTROLU DUZELTILDI
      Ham surum: s.user varsa "bagli" sayiyordu. s.user baglanti
      koptuktan sonra da dolu kalir -> panel kopukken "bagli" gorurdu.
      Yeni: hattin gercek connected bayragi okunuyor.

   4) HIZ SINIRINDA PANEL DURDURULUYOR
      WhatsApp yavasla dediginde 429 + bekleme suresi doner; panel
      gonderimi duraklatir. Ham surumde bu bilgi yoktu.

   5) SUNUCU TARAFINDA TEKRAR KORUMASI
      Ham surumde tekrar korumasi SADECE tarayicidaydi; sayfa
      yenilenince/baska bilgisayardan girilince ayni gruba ikinci mesaj
      gidebilirdi. Artik sunucu 24 saat icinde ayni gruba ayni referansla
      ikinci mesaji reddediyor.

   6) AYNI ANDA TEK GONDERIM
      Panel hizli istek atarsa bile sunucu tarafinda kilit var.

   7) CRM KAYDI BAGLANDI
      policeCrmKaydet artik yazili ve calisiyor: mesaj CRM sohbet
      gecmisinde "Yenileme Robotu" adiyla gorunuyor, tum panellere
      anlik yayinlaniyor (Iptal Robotu ile ayni mantik).

   NEREYE:  server.js icine, server.listen(...) satirindan ONCE.
   ONCESINDE: .env -> POLICE_API_KEY=uzun-ve-rastgele-bir-anahtar
   SONRASINDA: pm2 restart pekcan
   ===================================================================== */

// --- 0) Ayarlar ---------------------------------------------------------
const POLICE_API_KEY = process.env.POLICE_API_KEY || '';
const POLICE_ROBOT_ADI = 'Yenileme Robotu';   // CRM'de gorunecek gonderen adi
const POLICE_HAT = 'ofis';                    // hangi hattan gonderilecek
const POLICE_TEKRAR_SURESI = 24 * 60 * 60 * 1000;  // ayni gruba 24 saat icinde ikinci mesaj yok

let policeGrupCache = { zaman: null, liste: [] };
const _policeGonderilen = new Map();   // "jid|ref" -> zaman  (tekrar korumasi)
let _policeGonderimSuruyor = false;    // ayni anda tek gonderim

// --- 1) Anahtar kontrolu ------------------------------------------------
function policeYetki(req, res) {
  if (!POLICE_API_KEY) {
    res.status(500).json({ ok: false, error: 'POLICE_API_KEY tanimlanmamis' });
    return false;
  }
  const k = (req.body && req.body.key) || req.headers['x-police-key'] || '';
  if (k !== POLICE_API_KEY) {
    res.status(401).json({ ok: false, error: 'Gecersiz API anahtari' });
    return false;
  }
  return true;
}

// --- 2) Hat ve soket ----------------------------------------------------
// ONEMLI: s.user baglanti koptuktan SONRA da dolu kalir. O yuzden
// "bagli mi" sorusunu hattin kendi connected bayragindan soruyoruz.
function policeHat() { return lines.get(POLICE_HAT) || null; }
function policeSock() {
  const l = policeHat();
  return (l && l.sock) || waSock || null;
}
function policeBagliMi() {
  const l = policeHat();
  return !!(l && l.connected && l.sock);
}

// --- 3) CORS (panel farkli adreste calisiyor) ---------------------------
// NOT: Express surumune gore '/yol/*' kalibi hata verebiliyor. Bu yuzden
// joker yol yerine yol kontrollu ara katman kullaniyoruz — her surumde calisir.
function policeCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-police-key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' && req.path.startsWith('/api/police/wa/')) {
    policeCors(res);
    return res.sendStatus(204);
  }
  next();
});

// --- 4) Durum ------------------------------------------------------------
app.post('/api/police/wa/durum', express.json(), (req, res) => {
  policeCors(res);
  if (!policeYetki(req, res)) return;
  const l = policeHat();
  const s = policeSock();
  const yavas = (typeof hizSinirindaMi === 'function') ? hizSinirindaMi() : false;
  res.json({
    ok: true,
    bagli: policeBagliMi(),
    yavaslama: yavas,                 // true ise panel gonderimi duraklatmali
    hat: (s && s.user) ? (s.user.name || s.user.verifiedName || s.user.id) : null,
    robot: POLICE_ROBOT_ADI,
    gruplar: policeGrupCache.liste.length,
    gruplarZaman: policeGrupCache.zaman,
    sonMesaj: l && l.saglik ? l.saglik.sonBasariliGonderim : 0,
  });
});

// --- 5) Gruplar ----------------------------------------------------------
// WhatsApp'a SIFIR SORGU: liste CRM'in kendi sohbet listesinden uretiliyor.
// CRM zaten gruplari surekli guncel tutuyor (2 dakikada bir toplu tazeleme
// + groups.update anlik bildirimi). Ayrica sorgu atmaya gerek yok.
app.post('/api/police/wa/gruplar', express.json(), async (req, res) => {
  policeCors(res);
  if (!policeYetki(req, res)) return;
  if (!policeBagliMi()) return res.status(409).json({ ok: false, error: 'WhatsApp baglantisi kopuk' });

  try {
    const C = hatChats(POLICE_HAT);
    const liste = [];
    for (const [jid, c] of C) {
      if (!c || !c.isGroup) continue;
      const meta = groupMetaCache.get(jid);
      liste.push({
        jid,
        name: (c.name || '').trim(),
        participants: c.memberCount || 0,
        // announce: "sadece yoneticiler yazabilir" -> onbellekte varsa bildir,
        // yoksa null (gonderim aninda zaten kontrol ediliyor)
        announce: meta && meta.meta ? !!meta.meta.announce : null,
        isAdmin: null,
        aciklama: (c.description || '').slice(0, 200),
      });
    }
    liste.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    policeGrupCache = { zaman: Date.now(), liste };
    console.log(`[POLICE] ${liste.length} grup panele verildi (WhatsApp'a sorgu ATILMADI)`);
    res.json({ ok: true, cached: false, at: policeGrupCache.zaman, groups: liste });
  } catch (e) {
    console.error('[POLICE] grup hatasi:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- 6) CRM sohbet gecmisine yaz ("Yenileme Robotu" adiyla) -------------
// Iptal Robotu ile AYNI mantik: addMessage hem bellege yazar hem tum
// panellere anlik yayinlar hem veritabanina kaydeder.
async function policeCrmKaydet({ jid, text, robot, msgId, test, ref, kim }) {
  addMessage(jid, {
    id: msgId,
    text: text,
    fromMe: true,
    sender: robot || POLICE_ROBOT_ADI,
    robot: true,                       // panelde robot rozetiyle gorunsun
    policeRef: ref || '',              // hangi police icin gonderildi
    policeTest: !!test,
    policeKim: kim || '',
    time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
    durum: 1,
  }, {}, POLICE_HAT);
}

// --- 7) Mesaj gonder -----------------------------------------------------
app.post('/api/police/wa/gonder', express.json(), async (req, res) => {
  policeCors(res);
  if (!policeYetki(req, res)) return;

  const jid = req.body && req.body.jid;
  const text = req.body && req.body.text;
  const ref = (req.body && req.body.ref) || '';
  const test = !!(req.body && req.body.test);
  const robot = (req.body && req.body.robot) || POLICE_ROBOT_ADI;
  const kim = (req.body && req.body.kullanici) || '';

  if (!jid || !text) return res.status(400).json({ ok: false, error: 'jid ve text zorunlu' });
  if (!policeBagliMi()) return res.status(409).json({ ok: false, error: 'WhatsApp baglantisi kopuk' });

  // ── HIZ SINIRI: WhatsApp yavasla dediyse panel BEKLESIN ──
  // Bu, bugun yasanan tikanmanin tekrarini onler. Panel 429 gorunce
  // gonderimi duraklatir; deneme hakki YAKMAZ (bu bir hata degil, bekleme).
  if (typeof hizSinirindaMi === 'function' && hizSinirindaMi()) {
    return res.status(429).json({ ok: false, bekle: 60, yavaslama: true,
      error: 'WhatsApp gecici olarak yavaslatti — gonderim duraklatildi, birazdan devam edilecek' });
  }

  // ── TEKRAR KORUMASI (sunucu tarafi) ──
  // Panelin kendi korumasi tarayicida; sayfa yenilenince ya da baska
  // bilgisayardan girilince unutulur. Bu kontrol sunucuda kalicidir.
  const anahtar = jid + '|' + (ref || text.slice(0, 40));
  if (!test) {
    const oncekiZaman = _policeGonderilen.get(anahtar);
    if (oncekiZaman && (Date.now() - oncekiZaman) < POLICE_TEKRAR_SURESI) {
      const saat = Math.round((Date.now() - oncekiZaman) / 3600000);
      console.log(`[POLICE] TEKRAR ENGELLENDI: ${ref} (${saat} saat once gonderilmis)`);
      return res.status(409).json({ ok: false, tekrar: true,
        error: `Bu poliçe için ${saat} saat önce zaten mesaj gönderilmiş` });
    }
  }

  // ── AYNI ANDA TEK GONDERIM ──
  if (_policeGonderimSuruyor) {
    return res.status(429).json({ ok: false, bekle: 5,
      error: 'Onceki gonderim henuz bitmedi — birazdan tekrar deneyin' });
  }
  _policeGonderimSuruyor = true;

  try {
    const sock = policeSock();

    // ── Grup var mi ve yazma iznimiz var mi? ──
    // getGroupMeta ONBELLEKLI ve CRM'in oncelik kuyrugundan gecer.
    // (Ham surum her mesajda ayri bir groupMetadata sorgusu atiyordu.)
    const meta = await getGroupMeta(jid, 30 * 60 * 1000, sock).catch(() => null);
    if (!meta) throw new Error('Grup bulunamadi (silinmis ya da cikilmis olabilir)');
    if (meta.announce) {
      const benimId = ((sock.user && sock.user.id) || '').split(':')[0] + '@s.whatsapp.net';
      const yonetici = (meta.participants || []).some(p => p.id === benimId && !!p.admin);
      if (!yonetici) throw new Error('Grup sadece yoneticilere yazma izni veriyor');
    }

    // ── GONDERIM: CRM'in KUYRUGUNDAN ──
    // Hiz siniri korumasi, sirali gonderim ve otomatik yeniden deneme
    // burada devrede. Ham surum bunlari atliyordu.
    const gonderilen = await kuyrukluGonder(POLICE_HAT, () => Promise.race([
      sock.sendMessage(jid, { text }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('gonderim zaman asimi')), 25000)),
    ]));

    if (!gonderilen || !gonderilen.key || !gonderilen.key.id) {
      throw new Error('WhatsApp mesaj kimligi dondurmedi');
    }

    if (!test) _policeGonderilen.set(anahtar, Date.now());
    if (_policeGonderilen.size > 5000) {
      const esik = Date.now() - POLICE_TEKRAR_SURESI;
      for (const [k, t] of _policeGonderilen) if (t < esik) _policeGonderilen.delete(k);
    }

    // ── CRM sohbet gecmisine yaz ──
    // Bu blok patlasa bile mesaj GITTI; panele basarili donuyoruz.
    try {
      await policeCrmKaydet({ jid, text, robot, msgId: gonderilen.key.id, test, ref, kim });
    } catch (kayitHatasi) {
      console.error('[POLICE] CRM kaydi yazilamadi:', kayitHatasi.message);
    }

    console.log(`[POLICE]${test ? ' TEST' : ''} ${robot} → ${meta.subject} (${ref}) id=${gonderilen.key.id}`);
    res.json({ ok: true, id: gonderilen.key.id, group: meta.subject, robot, at: Date.now() });
  } catch (e) {
    const rateMi = /rate-overlimit|429/i.test(e.message || '');
    console.error(`[POLICE] gonderim hatasi (${ref}):`, e.message);
    // Hiz siniri bir HATA degil, bekleme sebebidir -> panel deneme hakki yakmasin
    if (rateMi) {
      return res.status(429).json({ ok: false, bekle: 90, yavaslama: true,
        error: 'WhatsApp yavaslatti — gonderim duraklatildi' });
    }
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    _policeGonderimSuruyor = false;
  }
});

/* ===================== POLICE TAKIP ENTEGRASYONU SONU ================== */
