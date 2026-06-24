// test-db.js — Supabase baglantisini test eder.
// Calistir: node test-db.js
const db = require('./db');

(async () => {
  console.log('Supabase baglantisi test ediliyor...\n');
  db.init();
  const ok = await db.test();
  if (ok) {
    console.log('\n🎉 HER SEY YOLUNDA! Supabase calisiyor.');
    console.log('   Simdi tablolari kontrol ediyorum...');
    // tablolar var mi diye bak
    const r = await db.loadAll();
    console.log(`   → chats tablosu: ${r.chats.length} kayit`);
    console.log(`   → contacts tablosu: ${r.contacts.length} kayit`);
    console.log(`   → settings tablosu: ${Object.keys(r.settings).length} kayit`);
    console.log('\n✓ Tablolar erisilebilir. server.js baglanmaya hazir.');
  } else {
    console.log('\n❌ Baglanti kurulamadi. Yukaridaki hataya bak.');
    console.log('   En sik sebepler:');
    console.log('   1) .env icindeki sifre yanlis (Supabase sifresiyle ayni olmali)');
    console.log('   2) Baglanti adresi eksik/yanlis kopyalanmis');
    console.log('   3) .env dosyasi yanlis yerde (ana klasorde olmali)');
  }
  process.exit(0);
})();
