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
  const n = s.split(ARA).length - 1;
  if (n !== 1) { console.log('✗ hedef satir ' + n + ' kez bulundu (1 olmaliydi). DOKUNULMADI.'); process.exit(1); }
  if (!fs.existsSync(YEDEK)) fs.copyFileSync(HEDEF, YEDEK);
  s = s.replace(ARA, KOY);
  fs.writeFileSync(HEDEF, s, 'utf8');
  console.log('✔ yedek: index.html.whapi-oncesi');
  console.log('✔ gorsel kanca eklendi');
  console.log('');
  console.log('Sonraki: pm2 restart pekcan  ->  panelde CTRL+F5');
  console.log('Geri alma: node panel-kur.js --geri');
}

if (process.argv.includes('--geri')) geriAl(); else kur();
