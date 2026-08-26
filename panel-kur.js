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

const HEDEF = path.join(__dirname, 'index.html');
const YEDEK = path.join(__dirname, 'index.html.whapi-oncesi');
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
/* WHAPI PANEL GORUNUMU — panel kullanicisi mesaj balonu */
.msg.panel-msg{
  background:linear-gradient(0deg,rgba(37,99,235,.10),rgba(37,99,235,.10)),var(--balon,#fff);
  border:1px solid rgba(37,99,235,.32);
  box-shadow:0 1px 3px rgba(37,99,235,.10);
}
.msg.panel-msg .msg-text{color:inherit}
.msg.panel-msg .meta{opacity:.75}
body.dark .msg.panel-msg, .dark .msg.panel-msg{
  background:linear-gradient(0deg,rgba(96,165,250,.16),rgba(96,165,250,.16)),var(--balon,#1f2937);
  border-color:rgba(96,165,250,.42);
  box-shadow:0 1px 3px rgba(0,0,0,.25);
}
</style>`;

function geriAl() {
  if (!fs.existsSync(YEDEK)) { console.log('✗ yedek yok'); process.exit(1); }
  fs.copyFileSync(YEDEK, HEDEF);
  console.log('✔ index.html yedekten geri yuklendi');
  console.log('  panelde CTRL+F5 yap');
}

function kur() {
  if (!fs.existsSync(HEDEF)) { console.log('✗ index.html bulunamadi'); process.exit(1); }
  let s = fs.readFileSync(HEDEF, 'utf8');
  if (s.includes(ISARET)) { console.log('• Zaten kurulu, hicbir sey yapilmadi.'); return; }
  const say = (t) => s.split(t).length - 1;
  const kontrol = [['isim etiketi', ARA], ['balon sinifi', ARA2], ['stil blogu', ARA3]];
  for (const [ad, t] of kontrol) {
    const n = say(t);
    if (ad === 'stil blogu' ? n < 1 : n !== 1) {
      console.log('✗ ' + ad + ' ' + n + ' kez bulundu. DOKUNULMADI.');
      process.exit(1);
    }
  }
  if (!fs.existsSync(YEDEK)) fs.copyFileSync(HEDEF, YEDEK);
  s = s.replace(ARA, KOY).replace(ARA2, KOY2);
  // stil: SON </style> etiketine ekle
  const sonStil = s.lastIndexOf(ARA3);
  s = s.slice(0, sonStil) + KOY3 + s.slice(sonStil + ARA3.length);
  fs.writeFileSync(HEDEF, s, 'utf8');
  console.log('✔ yedek: index.html.whapi-oncesi');
  console.log('✔ isim etiketi + balon rengi + stil eklendi');
  console.log('');
  console.log('Sonraki: pm2 restart pekcan  ->  panelde CTRL+F5');
  console.log('Geri alma: node panel-kur.js --geri');
}

if (process.argv.includes('--geri')) geriAl(); else kur();
