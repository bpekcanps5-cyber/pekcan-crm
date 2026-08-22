#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  CANLI YAKALAMA  —  tik ve aciklama sorunlarini tek seferde cozmek icin
#  -------------------------------------------------------------------
#  Hicbir seyi degistirmez. Sadece:
#    1) hangi surumun calistigini,
#    2) WAHA'nin gonderilen mesaj icin GERCEKTE ne olaylar yolladigini,
#    3) tik (ack) bilgisinin hangi alanda geldigini,
#    4) aciklama yenilemenin ne kadar surdugunu
#  yakalar ve ozetler.
#
#  Kullanim:
#      bash CANLI-YAKALA.sh
#  Komut basladiktan sonra PANELDEN BIR MESAJ AT ve bekle.
# ═══════════════════════════════════════════════════════════════════

KEY=$(grep -oP '(?<=^WAHA_API_KEY=).*' /root/waha-crm/.env 2>/dev/null)
OTURUM=$(grep -oP '(?<=^WAHA_OTURUM=).*' /root/waha-crm/.env 2>/dev/null)
[ -z "$OTURUM" ] && OTURUM=test
WURL=$(grep -oP '(?<=^WAHA_URL=).*' /root/waha-crm/.env 2>/dev/null)
[ -z "$WURL" ] && WURL=http://localhost:3001

echo "════════ 1) CALISAN SURUM ════════"
pm2 logs wahacrm --lines 400 --nostream 2>/dev/null | grep -m1 "waha-motor surum" \
  || echo "  ✗ SURUM SATIRI YOK — yeni dosya yuklenmemis!"

echo
echo "════════ 2) WAHA OTURUM AYARI ════════"
curl -s --max-time 8 "$WURL/api/sessions/$OTURUM" -H "X-Api-Key: $KEY" \
  | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception as e:
    print('  okunamadi:', e); raise SystemExit
print('  durum :', d.get('status'))
eng = d.get('engine') or {}
print('  motor :', eng.get('engine') or eng.get('name') or '?')
cfg = d.get('config') or {}
wh = cfg.get('webhooks') or []
print('  kayitli olay adresi sayisi:', len(wh), '  (1 olmali)')
for w in wh:
    print('    -', w.get('url'))
    print('      olaylar:', ','.join(w.get('events') or []))
nw = (cfg.get('noweb') or {}).get('store')
print('  NOWEB deposu:', nw)
" 2>/dev/null || echo "  WAHA'ya ulasilamadi"

echo
echo "════════ 3) SIMDI PANELDEN BIR MESAJ AT ════════"
echo "  25 saniye bekliyorum..."
sleep 25

echo
echo "════════ 4) GONDERIM VE OLAYLAR ════════"
pm2 logs wahacrm --lines 600 --nostream 2>/dev/null \
  | grep -E "gonderim cevabi|mesaj gonderildi|giden mesaj HAM olay|giden mesaj geri geldi|tik ilerledi|tik olayi|TEKE indirildi" \
  | tail -12
echo "  (bos ise: ya mesaj gitmedi ya da eski surum calisiyor)"

echo
echo "════════ 5) HANGI OLAYLAR GELIYOR ════════"
pm2 logs wahacrm --lines 600 --nostream 2>/dev/null | grep -oE "olay ozeti \(.*" | tail -1 \
  || echo "  olay ozeti henuz yazilmadi (200 olayda bir yazilir)"

echo
echo "════════ 6) ACIKLAMA YENILEME HIZI ════════"
JID=$(pm2 logs wahacrm --lines 600 --nostream 2>/dev/null \
  | grep -oE "grup [0-9]{15,}" | tail -1 | awk '{print $2}')
if [ -n "$JID" ]; then
  echo "  denenen grup: $JID"
  START=$(date +%s%N)
  curl -s --max-time 15 "localhost:3211/grup?jid=${JID}@g.us&taze=1" -o /tmp/gs.json
  END=$(date +%s%N)
  echo "  grup servisi cevap suresi: $(( (END-START)/1000000 )) ms"
  head -c 200 /tmp/gs.json; echo
else
  echo "  grup kimligi bulunamadi, atlandi"
fi

echo
echo "════════ 7) GRUP SERVISI ════════"
curl -s --max-time 5 localhost:3211/saglik || echo "  ✗ grup servisi cevap vermiyor"
echo
echo "════════ BITTI — ciktinin TAMAMINI gonder ════════"
