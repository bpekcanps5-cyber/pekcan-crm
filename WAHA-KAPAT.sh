#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  WAHA DENEMESINI KAPAT  —  pekcan-crm
#  ---------------------------------------------------------------------
#  WAHA denemesi birakildi. Bu betik geriye kalan test yigini kaldirir:
#     - wahacrm      (test CRM sureci)
#     - grupservisi  (whatsmeow yan servisi)
#     - waha-*       (Docker kutulari)
#     - /root/waha-crm, /root/waha-test, /root/grup-servisi, /root/wm-sonda
#     - /root/pekcan-crm/waha-motor.js  (artik hicbir yerden cagrilmiyor)
#     - Supabase'de line_id='waha_ofis' satirlari
#
#  CANLI SISTEME DOKUNMAZ:
#     - 'pekcan' sureci calismaya devam eder, restart bile edilmez
#     - line_id='ofis' satirlarina TEK BIR SILME sorgusu atilmaz
#     - ortak tablolar (contacts / chat_labels / chat_assignments) ellenmez
#     - public/media/ klasorune dokunulmaz
#
#  SILMEZ, YEDEGE ALIR. Fikrin degisirse geri donebilirsin.
#
#  KULLANIM:
#     bash WAHA-KAPAT.sh            -> sadece gosterir, HICBIR SEY YAPMAZ
#     bash WAHA-KAPAT.sh --uygula   -> uygular
# ═══════════════════════════════════════════════════════════════════════
set +e
UYGULA=0
[ "$1" = "--uygula" ] && UYGULA=1
TARIH=$(date +%Y%m%d-%H%M)

yap() {
  if [ $UYGULA -eq 1 ]; then eval "$1"; else echo "      [deneme modu] $1"; fi
}

echo "═══════════════════════════════════════════════════════════════"
if [ $UYGULA -eq 1 ]; then
  echo "  WAHA KAPATMA  —  UYGULANIYOR"
else
  echo "  WAHA KAPATMA  —  DENEME MODU (hicbir sey degismeyecek)"
fi
echo "═══════════════════════════════════════════════════════════════"

# ── 1) CANLI SISTEM: sadece bakiyoruz ────────────────────────────────
echo
echo "── 1) CANLI SISTEM (dokunulmayacak) ──"
if pm2 list 2>/dev/null | grep -q "pekcan"; then
  pm2 list 2>/dev/null | grep "pekcan"
else
  echo "  ⚠ 'pekcan' sureci gorunmuyor!"
  echo "    Devam etmeden once kontrol et:  pm2 list"
  [ $UYGULA -eq 1 ] && { echo "    Guvenlik icin duruyorum."; exit 1; }
fi

# ── 2) TEST SURECLERI ────────────────────────────────────────────────
echo
echo "── 2) TEST SURECLERI ──"
bulundu=0
for p in wahacrm grupservisi grup-servisi waha-kopru; do
  if pm2 list 2>/dev/null | grep -qw "$p"; then
    bulundu=1
    echo "    $p bulundu -> durdurulup silinecek"
    yap "pm2 stop $p >/dev/null 2>&1"
    yap "pm2 delete $p >/dev/null 2>&1"
  fi
done
[ $bulundu -eq 0 ] && echo "    test sureci yok"
yap "pm2 save >/dev/null 2>&1"

# ── 3) DOCKER ────────────────────────────────────────────────────────
echo
echo "── 3) DOCKER KUTULARI ──"
if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q waha; then
  docker ps -a --filter name=waha --format '    {{.Names}}  ({{.Status}})'
  yap "(cd /root/waha-crm 2>/dev/null && docker compose down >/dev/null 2>&1)"
  yap "(cd /root/waha-test 2>/dev/null && docker compose down >/dev/null 2>&1)"
  yap "docker rm -f \$(docker ps -aq --filter name=waha) >/dev/null 2>&1"
else
  echo "    waha kutusu yok"
fi

# ── 4) KLASORLER: silinmiyor, yedege aliniyor ────────────────────────
echo
echo "── 4) KLASORLER (SILINMIYOR, yedege aliniyor) ──"
bulundu=0
for d in /root/waha-crm /root/waha-test /root/grup-servisi /root/wm-sonda; do
  if [ -d "$d" ]; then
    bulundu=1
    echo "    $d  ->  ${d}.yedek-$TARIH"
    yap "mv '$d' '${d}.yedek-$TARIH'"
  fi
done
[ $bulundu -eq 0 ] && echo "    temizlenecek klasor yok"

# ── 5) CANLI PROJEDEKI ARTIK DOSYA ───────────────────────────────────
echo
echo "── 5) /root/pekcan-crm ICINDEKI WAHA ARTIGI ──"
if [ -f /root/pekcan-crm/waha-motor.js ]; then
  echo "    waha-motor.js bulundu (yeni server.js artik onu cagirmiyor)"
  yap "mv /root/pekcan-crm/waha-motor.js /root/waha-motor.js.yedek-$TARIH"
else
  echo "    waha-motor.js yok"
fi
if [ -f /root/pekcan-crm/.env ]; then
  if grep -qE '^(MOTOR|WAHA_|DB_HAT_ONEK)' /root/pekcan-crm/.env 2>/dev/null; then
    echo "    ⚠ .env icinde WAHA satirlari var:"
    grep -nE '^(MOTOR|WAHA_|DB_HAT_ONEK)' /root/pekcan-crm/.env | sed 's/^/        /'
    yap "cp /root/pekcan-crm/.env /root/pekcan-crm/.env.yedek-$TARIH"
    yap "sed -i -E '/^(MOTOR|WAHA_|DB_HAT_ONEK)/d' /root/pekcan-crm/.env"
    echo "        (yedegi alindi, satirlar silinecek)"
  else
    echo "    .env temiz"
  fi
fi

# ── 6) SUPABASE: SADECE TEST HATTI ───────────────────────────────────
echo
echo "── 6) SUPABASE — sadece test hatti ──"
echo "    SILINECEK : line_id = 'waha_ofis'"
echo "    KORUNACAK : line_id = 'ofis'  (CANLI)"
if [ $UYGULA -eq 1 ]; then
  cd /root/pekcan-crm 2>/dev/null && node -e "
    process.on('uncaughtException', e => { console.log('    calistirilamadi: ' + e.message); process.exit(0); });
    require('dotenv').config();
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL;
    if (!url) { console.log('    DATABASE_URL yok — atlandi'); process.exit(0); }
    const p = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    (async () => {
      const once = await p.query(\"SELECT count(*) n FROM chats WHERE line_id='ofis'\");
      const m = await p.query(\"DELETE FROM messages WHERE line_id='waha_ofis'\");
      const c = await p.query(\"DELETE FROM chats    WHERE line_id='waha_ofis'\");
      const sonra = await p.query(\"SELECT count(*) n FROM chats WHERE line_id='ofis'\");
      console.log('    silinen test  : ' + c.rowCount + ' sohbet, ' + m.rowCount + ' mesaj');
      console.log('    CANLI sohbet  : ' + once.rows[0].n + ' -> ' + sonra.rows[0].n +
                  (once.rows[0].n === sonra.rows[0].n ? '   ✔ degismedi' : '   ✘ DIKKAT!'));
      await p.end();
    })().catch(e => console.log('    hata: ' + e.message));
  "
else
  echo "      [deneme modu] DELETE FROM messages/chats WHERE line_id='waha_ofis'"
fi

# ── 7) ELLE YAPILACAK ────────────────────────────────────────────────
echo
echo "── 7) TELEFONDAN YAPILACAK (betik yapamaz) ──"
echo "    WhatsApp > Ayarlar > Bagli cihazlar"
echo "    WAHA denemesi sirasinda eklenen cihazlari KALDIR."
echo "    Panelin kendi cihazini KALDIRMA — canli sistem odur."
echo "    Fazla bagli cihaz, kopmalarin bilinen sebeplerinden biridir."

echo
echo "═══════════════════════════════════════════════════════════════"
if [ $UYGULA -eq 0 ]; then
  echo "  Hicbir sey yapilmadi. Yukaridakiler dogruysa:"
  echo "      bash WAHA-KAPAT.sh --uygula"
else
  echo "  Bitti. Canli sistem ('pekcan') restart bile edilmedi."
  echo "  Kontrol:  pm2 list"
  echo "  Yedekler: /root/*.yedek-$TARIH"
fi
echo "═══════════════════════════════════════════════════════════════"
