#!/usr/bin/env node
// ============================================================
// whapi-eksik-bul.js — "MESAJLARIN HEPSI GELMIYOR" TESHISI
// ------------------------------------------------------------
// SADECE OKUR. Hicbir sey yazmaz, silmez, degistirmez.
//
// UC KAYNAGI KARSILASTIRIR:
//   1) OFIS  (Baileys)  DB kaydi          -> referans "gercek"
//   2) WHAPI            DB kaydi          -> panelimize DUSEN
//   3) WHAPI API /messages/list           -> Whapi'nin KENDI elindeki
//
// Boylece kaybin NEREDE oldugu ayrisir:
//   • 1'de var, 3'te var, 2'de YOK   -> BIZIM webhook yolumuz kaybetti
//   • 1'de var, 3'te de YOK          -> Whapi hic teslim etmemis (kanal/ayar)
//   • Hattin ilk mesajindan ESKI     -> gecmis senkronu yok (BILINEN EKSIK)
//
// KIMLIKLE ESLESTIRME YAPMAZ. Whapi ve Baileys farkli kimlik uzayi
// kullaniyor (Baileys '3EB0...', Whapi 'PrAYhSY045...'). Karsilastirma
// metin + zaman penceresiyle yapilir. Bu SADECE teshis icindir; canli
// mukerrer elemesi hala YALNIZCA kimlikle yapiliyor.
//
// KULLANIM:
//   node whapi-eksik-bul.js "CAĞ MOTORS"          # grup adiyla ara
//   node whapi-eksik-bul.js 12036...@g.us         # jid ile
//   node whapi-eksik-bul.js "CAĞ MOTORS" --saat 6 # son 6 saat (varsayilan 24)
//   node whapi-eksik-bul.js "CAĞ MOTORS" --whapi  # Whapi API'sine de sor
// ============================================================
const db = require('./db');

const OFIS_LINE = process.env.OFIS_LINE_ID || 'ofis';
const WHAPI_LINE = process.env.WHAPI_LINE_ID || 'whapi';
const TOKEN = process.env.WHAPI_TOKEN || '';
const TABAN = process.env.WHAPI_URL || 'https://gate.whapi.cloud';

// Ayni mesaji iki hatta eslestirme penceresi. Whapi damgasi SANIYE
// hassasiyetinde ve webhook gec gelebiliyor, o yuzden genis tutuldu.
const ESLESME_PENCERESI = 180 * 1000;

const argv = process.argv.slice(2);
const hedefArg = argv.find((a) => !a.startsWith('--')) || '';
const saatIdx = argv.indexOf('--saat');
const SAAT = saatIdx >= 0 ? Number(argv[saatIdx + 1]) || 24 : 24;
const WHAPI_SOR = argv.includes('--whapi');

if (!hedefArg) {
  console.log('Kullanim: node whapi-eksik-bul.js "<grup adi veya jid>" [--saat 24] [--whapi]');
  process.exit(1);
}

// Metni karsilastirilabilir hale getir: bosluk/buyuk-kucuk/emoji farki
// yuzunden ayni mesaj farkli gorunmesin.
function norm(t) {
  return String(t || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .slice(0, 120);
}

function saat(ts) {
  const d = new Date(Number(ts));
  const i = (n) => (n < 10 ? '0' + n : '' + n);
  return i(d.getHours()) + ':' + i(d.getMinutes()) + ':' + i(d.getSeconds());
}

function gunSaat(ts) {
  const d = new Date(Number(ts));
  const i = (n) => (n < 10 ? '0' + n : '' + n);
  return i(d.getDate()) + '.' + i(d.getMonth() + 1) + ' ' + saat(ts);
}

// DB satirini sade kayda cevir
function sadelestir(r) {
  const metin = r.text || r.caption || '';
  return {
    id: r.id,
    ts: Number(r.ts) || 0,
    kind: r.kind || 'text',
    fromMe: !!r.from_me,
    sender: r.sender || '',
    text: metin,
    anahtar: norm(metin) || ('[' + (r.kind || 'medya') + ']'),
  };
}

// A'da olup B'de olmayanlari bul (metin + zaman penceresi)
function eksikleriBul(A, B) {
  const kullanilmis = new Set();
  const eksik = [];
  for (const a of A) {
    let bulundu = false;
    for (let i = 0; i < B.length; i++) {
      if (kullanilmis.has(i)) continue;
      const b = B[i];
      if (b.anahtar !== a.anahtar) continue;
      if (Math.abs(b.ts - a.ts) > ESLESME_PENCERESI) continue;
      kullanilmis.add(i);
      bulundu = true;
      break;
    }
    if (!bulundu) eksik.push(a);
  }
  return eksik;
}

async function whapidenCek(jid, adet) {
  if (!TOKEN) return { hata: 'WHAPI_TOKEN yok' };
  const url = TABAN.replace(/\/$/, '') + '/messages/list/' + encodeURIComponent(jid) + '?count=' + adet;
  try {
    const c = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    const govde = await c.text();
    if (!c.ok) return { hata: 'HTTP ' + c.status };   // token'i ASLA yazma
    const j = JSON.parse(govde);
    const liste = j.messages || [];
    return {
      kayitlar: liste.map((m) => {
        const medya = m.image || m.video || m.audio || m.voice || m.document || m.sticker || null;
        const metin = (m.text && (m.text.body != null ? m.text.body : m.text))
          || (medya && medya.caption) || (medya && (medya.file_name || medya.filename)) || '';
        const ts = m.timestamp ? Number(m.timestamp) * 1000 : 0;
        return { id: m.id, ts, kind: m.type || 'text', fromMe: !!m.from_me,
          sender: m.from_name || '', text: metin, anahtar: norm(metin) || ('[' + (m.type || 'medya') + ']') };
      }),
    };
  } catch (e) {
    return { hata: e.message };
  }
}

function yazdir(baslik, liste, tavan = 40) {
  console.log('\n' + baslik + '  (' + liste.length + ' adet)');
  if (!liste.length) { console.log('   — yok —'); return; }
  for (const m of liste.slice(0, tavan)) {
    const yon = m.fromMe ? '→' : '←';
    const kim = (m.sender || '').slice(0, 18).padEnd(18);
    const tip = m.kind === 'text' ? '    ' : (m.kind || '').slice(0, 4).padEnd(4);
    console.log('   ' + gunSaat(m.ts) + ' ' + yon + ' ' + kim + ' ' + tip + ' ' + String(m.text).replace(/\s+/g, ' ').slice(0, 60));
  }
  if (liste.length > tavan) console.log('   ... ve ' + (liste.length - tavan) + ' tane daha');
}

(async () => {
  await db.init();
  if (!db.isReady()) { console.log('✗ veritabanina baglanilamadi'); process.exit(1); }

  // ── HEDEF SOHBETI BUL ──
  let jid = hedefArg;
  if (!jid.includes('@')) {
    const hepsi = await db.loadAll(OFIS_LINE);
    const arama = norm(hedefArg);
    const adaylar = (hepsi.chats || []).filter((c) => norm(c.name).includes(arama));
    if (!adaylar.length) { console.log('✗ "' + hedefArg + '" adiyla sohbet bulunamadi'); process.exit(1); }
    if (adaylar.length > 1) {
      console.log('ℹ  birden fazla eslesme, ilki kullaniliyor:');
      for (const a of adaylar.slice(0, 6)) console.log('   • ' + a.name + '  ' + a.jid);
    }
    jid = adaylar[0].jid;
    console.log('sohbet: ' + adaylar[0].name);
  }
  console.log('jid   : ' + jid);
  console.log('aralik: son ' + SAAT + ' saat\n');

  const esik = Date.now() - SAAT * 3600 * 1000;

  // ── IKI HATTIN DB KAYITLARI ──
  const ofisHam = await db.loadMessages(jid, 2000, OFIS_LINE);
  const whapiHam = await db.loadMessages(jid, 2000, WHAPI_LINE);

  const ofis = ofisHam.map(sadelestir).filter((m) => m.ts >= esik).sort((a, b) => a.ts - b.ts);
  const whapi = whapiHam.map(sadelestir).filter((m) => m.ts >= esik).sort((a, b) => a.ts - b.ts);

  console.log('═══════════════════════════════════════════════');
  console.log(' OFIS  (Baileys) : ' + String(ofis.length).padStart(4) + ' mesaj'
    + (ofis.length ? '   ' + gunSaat(ofis[0].ts) + ' → ' + gunSaat(ofis[ofis.length - 1].ts) : ''));
  console.log(' WHAPI           : ' + String(whapi.length).padStart(4) + ' mesaj'
    + (whapi.length ? '   ' + gunSaat(whapi[0].ts) + ' → ' + gunSaat(whapi[whapi.length - 1].ts) : ''));
  console.log('═══════════════════════════════════════════════');

  if (!ofis.length) { console.log('\nOfis hattinda bu aralikta mesaj yok, karsilastirilacak sey yok.'); await db.kapat(); return; }

  // Whapi hattinin KAPSADIGI pencere: ilk mesajindan oncesi zaten beklenemez
  const kapsamBas = whapi.length ? whapi[0].ts : Infinity;

  const tumEksik = eksikleriBul(ofis, whapi);
  const kapsamOncesi = tumEksik.filter((m) => m.ts < kapsamBas);
  const kapsamIci = tumEksik.filter((m) => m.ts >= kapsamBas);
  const fazla = eksikleriBul(whapi, ofis);

  yazdir('▸ KAPSAM DISI — hat acilmadan onceki mesajlar (BEKLENEN, bilinen eksik: gecmis senkronu yok)', kapsamOncesi, 10);
  yazdir('▸ GERCEK KAYIP — hat aciktı ama panele DUSMEDI', kapsamIci);
  yazdir('▸ SADECE WHAPI DE OLAN (ofiste yok — normalde bos olmali)', fazla, 10);

  // ── WHAPI API'SINE SOR ──
  if (WHAPI_SOR && kapsamIci.length) {
    console.log('\n─── Whapi API sorgulaniyor (GET /messages/list) ───');
    const c = await whapidenCek(jid, 500);
    if (c.hata) {
      console.log('   ✗ sorulamadi: ' + c.hata);
    } else {
      const apide = c.kayitlar.filter((m) => m.ts >= esik).sort((a, b) => a.ts - b.ts);
      console.log('   Whapi kendi elinde ' + apide.length + ' mesaj gosteriyor');
      const apideDeYok = eksikleriBul(kapsamIci, apide);
      const apideVar = kapsamIci.length - apideDeYok.length;
      console.log('');
      console.log('   Kayip ' + kapsamIci.length + ' mesajdan:');
      console.log('     • ' + apideVar + ' tanesi Whapi de VAR  -> WEBHOOK YOLU kaybetmis (bizim tarafimiz)');
      console.log('     • ' + apideDeYok.length + ' tanesi Whapi de de YOK -> Whapi hic teslim etmemis (kanal/ayar tarafi)');
      yazdir('   ▸ Whapi de de olmayanlar', apideDeYok, 15);
    }
  }

  // ── HUKUM ──
  console.log('\n═══ HUKUM ═══');
  if (!kapsamIci.length && !kapsamOncesi.length) {
    console.log(' ✔ Iki hat bu aralikta AYNI. Eksik mesaj yok.');
  } else {
    if (kapsamOncesi.length) {
      console.log(' • ' + kapsamOncesi.length + ' mesaj hat acilmadan ONCEye ait.');
      console.log('   Bu BUG DEGIL: Whapi gecmis senkronu bagli degil (bilinen eksik).');
      console.log('   Baileys gecmisi otomatik getirir, Whapi getirmez.');
    }
    if (kapsamIci.length) {
      console.log(' ⚠ ' + kapsamIci.length + ' mesaj hat ACIKKEN kaybolmus. Bu GERCEK kayip.');
      if (!WHAPI_SOR) console.log('   Nerede kayboldugunu ogrenmek icin:  --whapi ekleyip tekrar calistir');
    }
    if (fazla.length) {
      console.log(' • ' + fazla.length + ' mesaj sadece Whapi de var (ofis kacirmis olabilir).');
    }
  }
  console.log('');
  await db.kapat();
})().catch((e) => { console.error('hata: ' + e.message); process.exit(1); });
