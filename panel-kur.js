#!/usr/bin/env node
// ============================================================
// panel-kur.js — index.html'e TEK gorsel degisiklik ekler
// ------------------------------------------------------------
// NE YAPAR: Gruptan gelen ama BIZIM PANEL KULLANICIMIZ tarafindan
// yazilmis mesajlari, panelden gonderilmis mesajlarla AYNI gorunumde
// cizer (kalkan rozeti + profil fotosu + gorev rengi).
// Boylece "normal WhatsApp'tan gelmis" gibi durmaz.
//
// GUVENLI: yedek alir, tek bir yeri degistirir, iki kez calistirilirsa
// ikinci kez hicbir sey yapmaz, dosya bozulursa yedegi geri yukler.
//   node panel-kur.js          kurar
//   node panel-kur.js --geri   geri alir
// ============================================================
const fs = require('fs');
const path = require('path');

// DOGRU DOSYAYI BUL — KRITIK
// server.js panelin HTML'ini su satirla servis ediyor:
//     app.use(express.static(path.join(__dirname, 'public')))
// Yani tarayiciya giden dosya  public/index.html  olabilir.
// Proje kokundeki index.html sadece bir kopya/kaynak olabilir ve
// onu yamalamak PANELDE HICBIR SEY DEGISTIRMEZ.
// Bu yuzden ADAYLARI kontrol edip GERCEKTEN servis edileni seciyoruz.
function hedefBul() {
  const adaylar = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'index.html'),
  ];
  const bulunan = adaylar.filter((y) => fs.existsSync(y));
  if (!bulunan.length) { console.log('✗ index.html hicbir yerde bulunamadi'); process.exit(1); }
  if (bulunan.length > 1) {
    const a = fs.readFileSync(bulunan[0], 'utf8');
    const b = fs.readFileSync(bulunan[1], 'utf8');
    console.log('ℹ  iki index.html var:');
    console.log('   public/index.html : ' + a.length + ' bayt  (TARAYICIYA GIDEN)');
    console.log('   index.html        : ' + b.length + ' bayt');
    if (a !== b) console.log('   ⚠  ICERIKLERI FARKLI');
  }
  return bulunan[0];   // public/ once
}

const HEDEF = hedefBul();
const YEDEK = HEDEF + '.whapi-oncesi';
const ISARET = '/* WHAPI PANEL GORUNUMU */';

const ARA = `        name='<div class="sender-name clickable'+(ofisMu?' ofis-uye':'')+'" style="color:'+colorFor(m.sender)+'"'
             +' data-jid="'+sj+'" data-ad="'+sn+'" title="'+sn+' \u2014 ki\u015fi bilgisi"'
             +' onclick="gonderenAc(this)">'+ofisRozet+sn+'</div>';`;

const KOY = `        ${ISARET}
        // Bu mesaji BIZIM panel kullanicimiz yazdiysa (sunucu isaretledi ya da
        // o isim icin panel profil fotosu var), panelden gonderilmis mesajlarla
        // AYNI gorunumu kullan: kalkan rozeti + profil fotosu + gorev rengi.
        const _pFoto = (typeof panelProfilFoto === 'function') ? (panelProfilFoto(sn) || '') : '';
        if (m.panelKullanicisi || _pFoto) {
          const _pGr = (typeof gorevRengi === 'function') ? gorevRengi(sn) : null;
          const _pAv = _pFoto ? '<span class="tn-foto" style="background-image:url(\\'' + _pFoto + '\\')"></span>' : '';
          const _pRz = '<span class="panel-rozet" title="Panel kullan\u0131c\u0131s\u0131"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg></span>';
          const _pEt = (typeof gorevEtiketi === 'function') ? gorevEtiketi(sn) : '';
          name = '<div class="sender-name team-name clickable' + (_pGr ? ' gorevli' : '') + '"'
               + (_pGr ? ' style="color:' + _pGr + ' !important;border-color:' + _pGr + '4d;background:' + _pGr + '1a"' : '')
               + ' onclick="panelKisiGoster(\\'' + sn.replace(/'/g, "\\\\'") + '\\')" title="Panel kullan\u0131c\u0131s\u0131"'
               + '>' + _pAv + _pRz + sn + _pEt + '</div>';
        } else {
        name='<div class="sender-name clickable'+(ofisMu?' ofis-uye':'')+'" style="color:'+colorFor(m.sender)+'"'
             +' data-jid="'+sj+'" data-ad="'+sn+'" title="'+sn+' \u2014 ki\u015fi bilgisi"'
             +' onclick="gonderenAc(this)">'+ofisRozet+sn+'</div>';
        }
        /* WHAPI PANEL GORUNUMU SONU */`;


// ── IKINCI YAMA: balonun tamami farkli renkte ───────────────
const ARA2 = `    return sep+'<div class="msg '+cls+grpCls+selCls+menCls+failCls+acilCls+(secimModu?' secim-modu':'')+'" data-mid="'+esc(m.id||'')+'">'`;
const KOY2 = `    ${ISARET}
    // Panel kullanicisinin yazdigi mesaj: balonun TAMAMI farkli renkte.
    const _pnlCls = (m.panelKullanicisi || (typeof panelProfilFoto === 'function' && panelProfilFoto(m.sender || ''))) ? ' panel-msg' : '';
    /* WHAPI PANEL GORUNUMU SONU */
    return sep+'<div class="msg '+cls+grpCls+selCls+menCls+failCls+acilCls+_pnlCls+(secimModu?' secim-modu':'')+'" data-mid="'+esc(m.id||'')+'">'`;

const ARA3 = `</style>`;
const KOY3 = `
/* WHAPI PANEL GORUNUMU — GRUP ACIKLAMASI ALT ALTA (2026-08)
   DERT: aciklama WhatsApp'ta alt alta, panelde yan yana akiyordu.
   OLCULDU: veri DOGRU — DB'de satir sonlari duruyor:
     "HASAN YAVUZKURT \n\nANLIK ODEME\n\nOTOMOBIL 900\nKAMYONET 900"
   whapi ve ofis hatlarinda BIREBIR ayni, yani Whapi'ye ozel degil.
   SEBEP: sunucudaki public/index.html eski surum, 'white-space:pre-wrap'
   satiri yok. Kod tarafi (dt.textContent = c.description) zaten dogru.
   Burada kimlige DEGIL, birden fazla secicinin hepsine birden uyguluyoruz
   ki dosyanin hangi surumu olursa olsun tutsun. */
#groupDescText,
.group-desc #groupDescText,
.gd-icerik #groupDescText{
  white-space:pre-wrap !important;
  word-break:break-word;
}
/* Kisaltilmis halde de satir sonlari korunsun; 2 yerine 3 satir goster */
.group-desc #groupDescText.collapsed{
  -webkit-line-clamp:3;
}

/* WHAPI PANEL GORUNUMU — panel kullanicisi mesaj balonu */
.msg.panel-msg{
  background:linear-gradient(0deg,rgba(37,99,235,.10),rgba(37,99,235,.10)),var(--balon,#fff);
  border:1px solid rgba(37,99,235,.32);
  box-shadow:0 1px 3px rgba(37,99,235,.10);
}
.msg.panel-msg .msg-text{color:inherit}
/* Panel kullanicisi isim hapi — panelden gonderilen mesajlarla AYNI gorunum */
.msg.panel-msg .sender-name.team-name{
  display:inline-flex;align-items:center;gap:4px;
  padding:2px 9px 2px 4px;border-radius:999px;
  background:rgba(37,99,235,.16);border:1px solid rgba(37,99,235,.45);
  font-weight:600;letter-spacing:.1px;
}
body.dark .msg.panel-msg .sender-name.team-name,
.dark .msg.panel-msg .sender-name.team-name{
  background:rgba(96,165,250,.20);border-color:rgba(96,165,250,.55);
}
.msg.panel-msg .meta{opacity:.75}
body.dark .msg.panel-msg, .dark .msg.panel-msg{
  background:linear-gradient(0deg,rgba(96,165,250,.16),rgba(96,165,250,.16)),var(--balon,#1f2937);
  border-color:rgba(96,165,250,.42);
  box-shadow:0 1px 3px rgba(0,0,0,.25);
}
</style>`;


// ── UCUNCU YAMA: ayni numaradan gelen FARKLI kisileri ayir ──
// SORUN: ofis hattindan gelen TUM mesajlarin senderJid'i AYNI (hattin numarasi).
// Panel bunlari "ayni gonderen" sayip ismi sadece ILKINE yaziyordu; Ertan'in ve
// Emrecan'in mesajlari en ustteki "Efe Riza" basliginin altinda gorunuyordu.
// COZUM: numara ayni olsa bile COZULMUS ISIM farkliysa AYRI gonderen say.
const ARA4 = `      const pj=prev.senderJid||'', mj=m.senderJid||'';
      if(pj && mj){
        ayniGonderen = (pj===mj);
      } else {`;
const KOY4 = `      const pj=prev.senderJid||'', mj=m.senderJid||'';
      if(pj && mj){
        ${ISARET}
        // Ayni numara AMA farkli panel kullanicisi -> AYRI gonderen (isim gorunsun)
        const _pAd=(prev.sender||''), _mAd=(m.sender||'');
        ayniGonderen = (pj===mj) && (!_pAd || !_mAd || _pAd===_mAd);
        /* WHAPI PANEL GORUNUMU SONU */
      } else {`;

// ── BESINCI YAMA: gec gelen mesaj DOGRU YERE otursun ────────
// handleMsgAppend mesaji her zaman SONA ekliyordu. Baileys'te mesaj
// aninda geldigi icin gelis sirasi = gercek sira, sorun gorunmuyordu.
// Whapi webhook'u gec gelince mesaj panelde YANLIS YERE dusuyor:
// saati '13:44' yaziyor ama 13:48'in altinda duruyor.
//
// Sondan geriye tarayip ilk uygun konuma sokuyoruz. Mesajlar cogunlukla
// sirali geldigi icin bu pratikte tek karsilastirma (O(1)).
// ESITLIK BOZUCU: Whapi zaman damgasi SANIYE hassasiyetinde. Ayni ts'li
// mesajlarda '>' kullandigimiz icin yeni gelen esitin ARKASINA gecer,
// yani ayni saniyedeki mesajlar GELIS SIRASINI korur.
const ARA5 = `    c.messages.push(m);
    if(c.messages.length>400) c.messages=c.messages.slice(-400);`;
const KOY5 = `    /* WHAPI PANEL GORUNUMU */
    // SIRALI EKLEME: gec gelen mesaj kendi zamanina otursun (sona degil).
    { const _ts=Number(m.ts||0);
      let _i=c.messages.length;
      while(_i>0 && Number(c.messages[_i-1].ts||0)>_ts) _i--;
      if(_i===c.messages.length) c.messages.push(m); else c.messages.splice(_i,0,m); }
    if(c.messages.length>400) c.messages=c.messages.slice(-400);`;

function geriAl() {
  if (!fs.existsSync(YEDEK)) { console.log('✗ yedek yok'); process.exit(1); }
  fs.copyFileSync(YEDEK, HEDEF);
  console.log('✔ geri yuklendi: ' + HEDEF);
  console.log('  panelde CTRL+F5 yap');
}

function kur() {
  console.log('yamalanan dosya: ' + HEDEF);
  let s = fs.readFileSync(HEDEF, 'utf8');
  if (s.includes(ISARET)) { console.log('• Zaten kurulu, hicbir sey yapilmadi.'); return; }
  const say = (t) => s.split(t).length - 1;
  const kontrol = [['isim etiketi', ARA], ['balon sinifi', ARA2], ['stil blogu', ARA3], ['gruplama', ARA4], ['sirali ekleme', ARA5]];
  for (const [ad, t] of kontrol) {
    const n = say(t);
    if (ad === 'stil blogu' ? n < 1 : n !== 1) {
      console.log('✗ ' + ad + ' ' + n + ' kez bulundu. DOKUNULMADI.');
      process.exit(1);
    }
  }
  if (!fs.existsSync(YEDEK)) fs.copyFileSync(HEDEF, YEDEK);
  s = s.replace(ARA, KOY).replace(ARA2, KOY2).replace(ARA4, KOY4).replace(ARA5, KOY5);
  // stil: SON </style> etiketine ekle
  const sonStil = s.lastIndexOf(ARA3);
  s = s.slice(0, sonStil) + KOY3 + s.slice(sonStil + ARA3.length);
  fs.writeFileSync(HEDEF, s, 'utf8');
  console.log('✔ yedek: index.html.whapi-oncesi');
  console.log('✔ isim etiketi + balon rengi + gruplama ayrimi + stil eklendi');
  console.log('✔ sirali ekleme eklendi (gec gelen mesaj dogru yere oturuyor)');
  console.log('');
  console.log('Sonraki: pm2 restart pekcan  ->  panelde CTRL+F5');
  console.log('Geri alma: node panel-kur.js --geri');
}

if (process.argv.includes('--geri')) geriAl(); else kur();
