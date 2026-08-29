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

/* WHAPI PANEL GORUNUMU — MESAJ METNI ALT ALTA (2026-08)
   OLCULDU (tarayici konsolu): veri panele DOGRU geliyor, sorun CIZIMDE.
     .msg sinifinda 'white-space' HIC yok
     esc() satir sonunu <br> yapmiyor, sadece HTML kacisi yapiyor
   HTML'de ciplak \n BOSLUGA doner -> WhatsApp'ta alt alta yazilan mesaj
   panelde tek paragraf gibi akiyordu (fiyat listeleri, teminat listeleri...).
   'pre-wrap' satir sonlarini korur, ARDISIK BOSLUKLARI da korur ve
   satir kaydirmayi bozmaz — <br> enjeksiyonundan daha guvenli, cunku
   HTML'e dokunmuyoruz. */
.msg,
.msg .im-caption,
.msg-text{
  white-space:pre-wrap;
}
/* Alintilanan mesaj ve tek satirlik alanlar bozulmasin */
.msg .reply-box,
.msg .msg-meta,
.msg time{
  white-space:normal;
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


// ── ALTINCI YAMA: TARAYICI CEVIRISINI KAPAT ─────────────────
// OLCULDU (2026-08, tarayici konsolu): Chrome'un otomatik cevirisi metin
// dugumlerini <font dir="auto" style="vertical-align:inherit"> ile sariyor
// ve bu sirada SATIR SONLARINI YUTUYOR.
//   panel dizisinde : 7 satir sonu   (veri saglam)
//   DOM'da          : 0              (Chrome silmis)
// Sonuc: WhatsApp'ta alt alta yazilan fiyat/teminat listeleri panelde tek
// paragraf gibi akiyordu. KODDA HATA YOKTU. "Arada duzeliyor" denmesinin
// sebebi de buydu: ceviri bazen devreye giriyor bazen girmiyor.
// Panel zaten Turkce, cevrilmesine gerek yok.
const ARA6 = '<meta charset="UTF-8">';
const KOY6 = '<meta charset="UTF-8">\n'
  + '<!-- WHAPI PANEL GORUNUMU: tarayici cevirisi satir sonlarini yutuyordu -->\n'
  + '<meta name="google" content="notranslate">';

// NOT (2026-08): 'liste sabitligi' yamasi UC KEZ denendi ve UC KEZ
// sohbet listesini bosaltti. Kalici olarak KALDIRILDI.
// Denenen: ayni-HTML atlamasi, 450ms zaman penceresi, parmak-basili +
// bekci. Hicbiri guvenli cikmadi; _renderListRaw'i sarmak bu panelde
// riskli. Tiklarken kayma hissi icin baska bir yol bulunmali.

// Dugmenin cagirdigi fonksiyon. Mevcut /api/users/setline ucunu kullanir.
const ARA9 = 'function gorevMenuAc(ev, id, suanki){';
const KOY9 = "/* WHAPI PANEL GORUNUMU — hat degistirme */\nasync function whapiHatDegistir(username, whapiYap){\n  const hedef = whapiYap ? 'WHAPI' : 'BAILEYS (ofis)';\n  if(!confirm(username+' kullanicisi '+hedef+' hattina alinacak.\\n\\nBu kisi ACIKSA yeniden giris yapmali. Devam edilsin mi?')) return;\n  try{\n    const r = await fetch('/api/users/setline',{\n      method:'POST', headers:{'Content-Type':'application/json'},\n      body: JSON.stringify({ token: localStorage.getItem('token'),\n        username: username, tip: whapiYap ? 'whapi' : 'ofis' })\n    });\n    const d = await r.json();\n    if(d.ok){ alert(d.message || (username+' -> '+hedef)); if(typeof loadUsers==='function') loadUsers(); }\n    else alert('Olmadi: '+(d.error||'bilinmeyen hata'));\n  }catch(e){ alert('Baglanti hatasi: '+e.message); }\n}\nfunction gorevMenuAc(ev, id, suanki){";


// ── SEKIZINCI YAMA: HAT DEGISTIR DUGMESI ────────────────────
const ARA8 = "      actions+='<button class=\"um-btn\" onclick=\"rolMenuAc(event,'+u.id+',\\''+esc(u.role||'agent')+'\\')\">Rol ▾</button>';";
const KOY8 = ARA8 + "\n      /* WHAPI PANEL GORUNUMU — HAT DEGISTIR DUGMESI (2026-08)\n         Kullaniciyi Whapi hattina alir, tekrar basilinca Baileys'e (ofis)\n         dondurur. Mevcut /api/users/setline ucunu kullanir — yeni uc YOK,\n         yetki kontrolu ayni. Kullanici YENIDEN GIRIS yapmali. */\n      {\n        const _wh = (u.tip==='whapi');\n        actions+='<button class=\"um-btn'+(_wh?' aktif':'')+'\" '\n          +'onclick=\"whapiHatDegistir(\\''+esc(u.username).replace(/'/g,\"\\\\'\")+'\\','+(_wh?'false':'true')+')\" '\n          +'title=\"'+(_wh?'Whapi hattinda. Basinca Baileys (ofis) hattina geri doner.'\n                        :'Baileys (ofis) hattinda. Basinca Whapi hattina alinir.')+'\">'\n          +(_wh?'🔁 Whapi ✓':'🔁 Whapi\\'ye al')+'</button>';\n      }";


// ── ONUNCU YAMA: ACIL BAILEYS DONUSU ────────────────────────
const ARA10 = "  if(sub) sub.textContent='WhatsApp bağlı değil. Bağlanmak için aşağıdaki butona bas.';\n  wrap.innerHTML='<button class=\"login-btn\" style=\"width:auto;padding:14px 28px\" onclick=\"startWhatsApp()\">📱 WhatsApp\\'a bağlan</button>';";
const KOY10 = "  /* WHAPI PANEL GORUNUMU — ACIL BAILEYS'E DONUS (2026-08)\n     Whapi hatti koptugunda kullanici QR bekleyen bos bir ekranda kaliyordu;\n     Whapi'de QR YOK, o ekran hicbir zaman dolmuyor.\n     Artik: Whapi hattindaysa QR yerine DURUM + tek tusla Baileys'e donus.\n     Yoneticiyi beklemeye gerek yok — is durmasin. */\n  if((window.currentUser&&window.currentUser.lineTip)==='whapi'){\n    if(sub) sub.textContent='Whapi hattı şu an bağlı değil. Çalışmaya devam etmek için Baileys hattına dönebilirsin.';\n    wrap.innerHTML='<div style=\\\"display:flex;flex-direction:column;gap:12px;align-items:center\\\">'\n      +'<div style=\\\"font-size:13px;color:#555;max-width:280px;text-align:center;line-height:1.5\\\">'\n      +'Whapi kanalı whapi.cloud üzerinden yönetilir, burada QR okutulmaz.</div>'\n      +'<button class=\\\"login-btn\\\" style=\\\"width:auto;padding:14px 28px\\\" onclick=\\\"whapiBaileyseDon()\\\">'\n      +'↩️ Baileys hattına dön</button></div>';\n    scr.classList.add('show');\n    return;\n  }\n  if(sub) sub.textContent='WhatsApp bağlı değil. Bağlanmak için aşağıdaki butona bas.';\n  wrap.innerHTML='<button class=\"login-btn\" style=\"width:auto;padding:14px 28px\" onclick=\"startWhatsApp()\">📱 WhatsApp\\'a bağlan</button>';";
const ARA11 = "function startWhatsApp(){";
const KOY11 = "/* WHAPI PANEL GORUNUMU — kullanici KENDINI Baileys'e dondurur.\n   Sunucu tarafi bu yonu yetki istemeden kabul eder (guvenli yon:\n   kimseye ekstra erisim vermez, herkesin varsayilan hatti olan ofis'e\n   ve SADECE kendisi icin). */\nasync function whapiBaileyseDon(){\n  if(!confirm('Baileys (ofis) hattına dönülecek.\\n\\nSayfa yenilenecek ve sohbetlerin oradan gelecek. Devam?')) return;\n  try{\n    const kim=(window.currentUser&&window.currentUser.username)||'';\n    if(!kim){ alert('Kullanıcı bilgisi okunamadı, çıkış yapıp tekrar gir.'); return; }\n    const r=await fetch('/api/users/setline',{method:'POST',\n      headers:{'Content-Type':'application/json'},\n      body:JSON.stringify({token:localStorage.getItem('token'),username:kim,tip:'ofis'})});\n    const d=await r.json();\n    if(d.ok){ alert('Baileys hattına dönüldü. Sayfa yenileniyor.'); location.reload(); }\n    else alert('Olmadı: '+(d.error||'bilinmeyen hata'));\n  }catch(e){ alert('Bağlantı hatası: '+e.message); }\n}\nfunction startWhatsApp(){";

function geriAl() {
  if (!fs.existsSync(YEDEK)) { console.log('✗ yedek yok'); process.exit(1); }
  fs.copyFileSync(YEDEK, HEDEF);
  console.log('✔ geri yuklendi: ' + HEDEF);
  console.log('  panelde CTRL+F5 yap');
}

function kur() {
  console.log('yamalanan dosya: ' + HEDEF);
  let s = fs.readFileSync(HEDEF, 'utf8');
  const kontrol = [['isim etiketi', ARA], ['balon sinifi', ARA2], ['stil blogu', ARA3], ['gruplama', ARA4], ['sirali ekleme', ARA5], ['ceviri kapatma', ARA6], ['hat dugmesi', ARA8], ['hat fonksiyonu', ARA9], ['acil donus', ARA10], ['donus fonksiyonu', ARA11]];

  // KISMI KURULUM (2026-08): dosya ESKI bir yama surumu tasiyabilir.
  // Eskiden burada kosulsuz cikiliyordu; sonuc olarak yeni yamalar (sirali
  // ekleme, ceviri kapatma, liste sabitligi) SESSIZCE uygulanmiyordu.
  // Artik hangi capalarin DURDUGUNA bakiyoruz: hepsi eksikse zaten kurulu,
  // bir kismi eksikse SADECE eksik olanlari ekliyoruz.
  const eksikler = kontrol.filter(([, c]) => s.includes(c));
  if (!eksikler.length) { console.log('• Zaten kurulu, hicbir sey yapilmadi.'); return; }
  if (eksikler.length < kontrol.length) {
    console.log('ℹ  kismi kurulum: ' + eksikler.length + '/' + kontrol.length
      + ' yama eksik, sadece onlar eklenecek');
    for (const [ad] of eksikler) console.log('     • ' + ad);
  }
  // SADECE eklenecek olanlarin capasini dogrula. Kurulu yamalarin capasi
  // zaten degistirilmis oldugu icin bulunamaz — o normal, hata degil.
  const say = (t) => s.split(t).length - 1;
  for (const [ad, t] of eksikler) {
    const n = say(t);
    if (ad === 'stil blogu' ? n < 1 : n !== 1) {
      console.log('✗ ' + ad + ' ' + n + ' kez bulundu. DOKUNULMADI.');
      process.exit(1);
    }
  }
  if (!fs.existsSync(YEDEK)) fs.copyFileSync(HEDEF, YEDEK);
  else console.log('ℹ  yedek zaten var, uzerine YAZILMADI: ' + YEDEK);
  const eslesme = { 'isim etiketi': [ARA, KOY], 'balon sinifi': [ARA2, KOY2],
    'stil blogu': [ARA3, KOY3], 'gruplama': [ARA4, KOY4], 'sirali ekleme': [ARA5, KOY5],
    'ceviri kapatma': [ARA6, KOY6],
    'hat dugmesi': [ARA8, KOY8], 'hat fonksiyonu': [ARA9, KOY9],
    'acil donus': [ARA10, KOY10], 'donus fonksiyonu': [ARA11, KOY11] };
  // DIKKAT: ARA3 ('</style>') dosyada BIRDEN COK var. Her yamayi TEK KEZ
  // uygula ve uygulandigini isaretle — aksi halde ayni CSS iki kez giriyordu
  // (zararsizdi ama dosyayi kirletiyordu ve geri almayi zorlastiriyordu).
  const uygulandi = new Set();
  for (const [ad] of eksikler) {
    if (uygulandi.has(ad)) continue;
    const par = eslesme[ad];
    if (!par) continue;
    const once = s;
    s = s.replace(par[0], par[1]);
    if (s !== once) uygulandi.add(ad);
    else console.log('⚠ ' + ad + ' uygulanamadi (capa degismis olabilir)');
  }
  // NOT: stil blogu yukaridaki eslesme dongusunde uygulaniyor.
  // Burada IKINCI bir uygulama vardi (eski koddan kalma) — ayni CSS'i
  // dosyaya bir kez daha ekliyordu. Kaldirildi.
  fs.writeFileSync(HEDEF, s, 'utf8');
  console.log('✔ yedek: index.html.whapi-oncesi');
  console.log('✔ isim etiketi + balon rengi + gruplama ayrimi + stil eklendi');
  console.log('✔ sirali ekleme eklendi (gec gelen mesaj dogru yere oturuyor)');
  console.log('✔ tarayici cevirisi kapatildi (satir sonlarini yutuyordu)');
  console.log('✔ hat degistir dugmesi eklendi (kullanici yonetiminde)');
  console.log('✔ acil Baileys donus dugmesi eklendi (hat kopunca)');
  console.log('');
  console.log('Sonraki: pm2 restart pekcan  ->  panelde CTRL+F5');
  console.log('Geri alma: node panel-kur.js --geri');
}

if (process.argv.includes('--geri')) geriAl(); else kur();
