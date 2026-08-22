#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  TEK KOMUTLA DURUM KONTROLU
#  Hangi surum calisiyor, grup servisi ayakta mi, tik olayi geliyor mu?
#  Hicbir seyi degistirmez, sadece bakar.
# ═══════════════════════════════════════════════════════════════════
echo "════════ 1) CALISAN SURUM ════════"
pm2 logs wahacrm --lines 300 --nostream 2>/dev/null | grep -m1 "waha-motor surum" \
  || echo "  ✗ SURUM SATIRI YOK -> yeni dosya yuklenmemis veya pm2 restart yapilmamis"

echo
echo "════════ 2) GRUP SERVISI ════════"
pm2 list 2>/dev/null | grep -q grupservisi && echo "  pm2'de kayitli: EVET" || echo "  pm2'de kayitli: HAYIR"
curl -s --max-time 5 localhost:3211/saglik || echo "  ✗ servis cevap vermiyor (port 3211)"
echo
curl -s --max-time 8 "localhost:3211/grup?jid=120363424150672415@g.us" | head -c 220
echo

echo
echo "════════ 3) GONDERIM / TIK ════════"
pm2 logs wahacrm --lines 400 --nostream 2>/dev/null \
  | grep -E "gonderim cevabi|mesaj gonderildi|tik olayi|kimlik bicimi|olay ozeti" | tail -8 \
  || echo "  ilgili satir yok"

echo
echo "════════ 4) OLAY SAYILARI ════════"
pm2 logs wahacrm --lines 400 --nostream 2>/dev/null | grep -m1 "olay ozeti" \
  || echo "  olay ozeti henuz yazilmadi"
