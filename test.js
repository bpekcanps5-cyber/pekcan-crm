const fs = require('fs');
const { zarfCevir } = require('./whapi-cevirici');

const BENIM = '905399265441';   // Whapi kanalinin kendi numarasi
const satirlar = fs.readFileSync(__dirname + '/ornek.jsonl', 'utf8').split('\n').filter((s) => s.trim());

let gecti = 0, kaldi = 0;
function bekle(ad, olan, beklenen) {
  const ok = JSON.stringify(olan) === JSON.stringify(beklenen);
  if (ok) { gecti++; console.log('  ✓ ' + ad); }
  else { kaldi++; console.log('  ✗ ' + ad + '\n      beklenen: ' + JSON.stringify(beklenen) + '\n      olan    : ' + JSON.stringify(olan)); }
}

console.log('═══ 1) HER KAYIT NEYE CEVRILDI ═══\n');
const hepsi = [];
for (const s of satirlar) {
  const isler = zarfCevir(JSON.parse(s), BENIM);
  for (const i of isler) {
    hepsi.push(i);
    if (i.tur === 'mesaj') {
      console.log(`  mesaj    kind=${(i.message.kind + '        ').slice(0, 10)} fromMe=${String(i.message.fromMe).padEnd(5)} medya=${i.indir ? 'VAR' : '-  '} onizleme=${i.onizleme ? 'VAR' : '-  '} | ${JSON.stringify((i.message.text || '').slice(0, 22))}`);
    } else if (i.tur === 'tepki') {
      console.log(`  tepki    emoji=${i.emoji}  hedef=${i.hedefId.slice(0, 14)}  benMi=${i.benMi}`);
    } else if (i.tur === 'sil') {
      console.log(`  sil      hedef=${i.hedefId.slice(0, 14)}`);
    } else if (i.tur === 'duzenle') {
      console.log(`  duzenle  hedef=${i.hedefId.slice(0, 14)}  yeni=${JSON.stringify(i.yeniMetin)}`);
    } else {
      console.log(`  ATLA     sebep=${i.sebep}`);
    }
  }
}

console.log('\n═══ 2) DOGRULAMALAR ═══\n');

const mesajlar = hepsi.filter((x) => x.tur === 'mesaj');

console.log(' fromMe tespiti (from_me bayragi HEPSINDE false geliyordu):');
const kendi = mesajlar.filter((m) => m.message.senderJid.startsWith(BENIM));
bekle('kendi numaramdan gelenler fromMe=true', kendi.every((m) => m.message.fromMe === true), true);
const volkan = mesajlar.filter((m) => m.message.senderJid.startsWith('905393793449'));
bekle('baskasindan gelenler fromMe=false', volkan.every((m) => m.message.fromMe === false), true);
bekle('kendi mesajlarinda sender="Ben"', kendi.every((m) => m.message.sender === 'Ben'), true);

console.log('\n Belge:');
const belge = mesajlar.find((m) => m.message.kind === 'document');
bekle('kind', belge.message.kind, 'document');
bekle('text = dosya adi', belge.message.text, 'BEYAN.docx');
bekle('fileName korundu', belge.message.fileName, 'BEYAN.docx');
bekle('caption ayri', belge.message.caption, 'BEYAN');
bekle('indirme linki var', !!belge.indir.link, true);

console.log('\n Fotograf:');
const foto = mesajlar.find((m) => m.message.kind === 'image');
bekle('kind', foto.message.kind, 'image');
bekle('caption text alanina da yazildi', foto.message.text, 'altina yazi');
bekle('onizleme (thumb) var', !!foto.onizleme, true);
bekle('mediaUrl once null', foto.message.mediaUrl, null);

console.log('\n Alintili yanit:');
const alinti = mesajlar.find((m) => m.message.replyTo);
bekle('alinti id', alinti.message.replyTo.id, 'PsrpvOFMJsFp1l0-wpQBq53lT6_BEQ');
bekle('alinti metni', alinti.message.replyTo.text, '11111111111111111111111');
bekle('alintilanan kisi', alinti.message.replyTo.sender, '905458126770');

console.log('\n Action turleri (mesaj OLUSTURMAMALI):');
bekle('tepki sayisi', hepsi.filter((x) => x.tur === 'tepki').length, 1);
bekle('silme sayisi', hepsi.filter((x) => x.tur === 'sil').length, 1);
bekle('duzenleme sayisi', hepsi.filter((x) => x.tur === 'duzenle').length, 1);
const duz = hepsi.find((x) => x.tur === 'duzenle');
bekle('duzenlenen yeni metin', duz.yeniMetin, '————33———');
bekle('action mesaj olarak eklenmedi', mesajlar.some((m) => m.message.kind === 'action'), false);

console.log('\n Bilinmeyen tip:');
const bilinmeyen = mesajlar.find((m) => m.message.kind === 'undecryptable');
bekle('undecryptable oldu', bilinmeyen.message.kind, 'undecryptable');
bekle('kullaniciya aciklama var', bilinmeyen.message.text.includes('alınamadı'), true);

console.log('\n Turkce karakter:');
bekle('grup adi bozulmadi', mesajlar[0].meta.name, 'VOLKAN AYDEMİR - sigorta');
bekle('gonderen adi bozulmadi', mesajlar[0].message.senderPush, 'Pekcan Sigorta Aracılık Hizmetleri');

console.log('\n jid bicimi:');
bekle('grup jid degismedi', mesajlar[0].jid, '120363423265440017@g.us');
bekle('isGroup dogru', mesajlar[0].isGroup, true);
bekle('senderJid CRM bicimi', mesajlar[0].message.senderJid, '905399265441@s.whatsapp.net');

console.log('\n Ucgen durumlar:');
const { mesajCevir } = require('./whapi-cevirici');
bekle('bos kayit atlanir', mesajCevir(null, BENIM).tur, 'atla');
bekle('id yoksa atlanir', mesajCevir({ chat_id: 'x@g.us' }, BENIM).tur, 'atla');
bekle('status@broadcast atlanir', mesajCevir({ id: '1', chat_id: 'status@broadcast' }, BENIM).tur, 'atla');
bekle('ciplak numara -> kisi jid', mesajCevir({ id: '1', chat_id: '905551112233', type: 'text', text: { body: 'a' } }, BENIM).jid, '905551112233@s.whatsapp.net');
bekle('bozuk zarf cokmez', zarfCevir('bu json degil', BENIM).length, 0);

console.log('\n═══ SONUC ═══');
console.log(`  gecen: ${gecti}   kalan: ${kaldi}`);
process.exit(kaldi ? 1 : 0);
