#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  TEMIZ BASLATMA  —  QR gelmiyorsa / mesaj dusmuyorsa
#  Sirayla her seyi bilinen iyi bir duruma getirir ve DOGRULAR.
#  CANLI SISTEME (pekcan) DOKUNMAZ.
# ═══════════════════════════════════════════════════════════════════
set +e
KEY=$(grep -oP '(?<=^WAHA_API_KEY=).*' /root/waha-crm/.env 2>/dev/null)
OTURUM=$(grep -oP '(?<=^WAHA_OTURUM=).*' /root/waha-crm/.env 2>/dev/null); [ -z "$OTURUM" ] && OTURUM=test

echo "════ 1) CRM DURDURULUYOR ════"
pm2 stop wahacrm >/dev/null 2>&1; echo "  durduruldu"

echo
echo "════ 2) WAHA OTURUMU SIFIRDAN ════"
cd /root/waha-crm
curl -s -X POST "localhost:3001/api/sessions/$OTURUM/logout" -H "X-Api-Key: $KEY" -o /dev/null
curl -s -X DELETE "localhost:3001/api/sessions/$OTURUM"      -H "X-Api-Key: $KEY" -o /dev/null
docker compose restart >/dev/null 2>&1
echo "  WAHA yeniden basladi, 25 saniye bekleniyor..."
sleep 25

echo
echo "════ 3) KOPRU PORTU ════"
ss -tlnp 2>/dev/null | grep -q ':3210' && echo "  3210 hala acik (eski surec?) -> pm2 stop yapildi, normalde kapali olmali" \
  || echo "  3210 kapali (dogru, CRM kapali)"

echo
echo "════ 4) CRM BASLATILIYOR ════"
pm2 start wahacrm >/dev/null 2>&1 || pm2 restart wahacrm >/dev/null 2>&1
sleep 12

echo
echo "════ 5) SONUC ════"
pm2 logs wahacrm --lines 200 --nostream 2>/dev/null | grep -m1 "waha-motor surum"
pm2 logs wahacrm --lines 200 --nostream 2>/dev/null | grep -E "oturum durumu|QR panele gonderildi|NOWEB DEPOSU|olay koprusu" | tail -6
echo
echo "  Panele git: QR gelmis olmali."
echo "  Gelmediyse su satiri gonder: pm2 logs wahacrm --lines 40 --nostream | grep 'oturum durumu'"
