#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  MESAJ NEDEN DUSMUYOR?  —  tek komut, 20 saniye
#  Hicbir seyi degistirmez.
# ═══════════════════════════════════════════════════════════════════
KEY=$(grep -oP '(?<=^WAHA_API_KEY=).*' /root/waha-crm/.env 2>/dev/null)
OTURUM=$(grep -oP '(?<=^WAHA_OTURUM=).*' /root/waha-crm/.env 2>/dev/null); [ -z "$OTURUM" ] && OTURUM=test
WURL=$(grep -oP '(?<=^WAHA_URL=).*' /root/waha-crm/.env 2>/dev/null); [ -z "$WURL" ] && WURL=http://localhost:3001

echo "════ 1) SURUM ════"
pm2 logs wahacrm --lines 400 --nostream 2>/dev/null | grep -m1 "waha-motor surum" || echo "  SURUM YOK -> dosya yuklenmemis"

echo
echo "════ 2) OTURUM + OLAY ADRESLERI ════"
curl -s --max-time 8 "$WURL/api/sessions/$OTURUM" -H "X-Api-Key: $KEY" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  durum:',d.get('status'))
wh=(d.get('config') or {}).get('webhooks') or []
print('  kayitli olay adresi:',len(wh))
for w in wh: print('   -',w.get('url'))
" 2>/dev/null || echo "  WAHA'ya ulasilamadi"

echo
echo "════ 3) KOPRU DINLIYOR MU ════"
ss -tlnp 2>/dev/null | grep -q ':3210' && echo "  port 3210: ACIK" || echo "  port 3210: KAPALI (!)"

echo
echo "════ 4) KUTUDAN KOPRUYE ULASILIYOR MU ════"
docker exec waha-test node -e "
fetch('http://host.docker.internal:3210/olay/0',{method:'POST',headers:{'Content-Type':'application/json'},body:'{\"event\":\"deneme\"}'})
 .then(r=>console.log('  host.docker.internal -> ULASTI',r.status))
 .catch(e=>console.log('  host.docker.internal -> ULASAMADI',e.message))
" 2>/dev/null || echo "  test edilemedi"

echo
echo "════ 5) SON OLAY OZETI ════"
pm2 logs wahacrm --lines 500 --nostream 2>/dev/null | grep -oE "olay ozeti \(.*" | tail -1 || echo "  olay ozeti yok -> HIC OLAY GELMEMIS"

echo
echo "════ 6) SON GELEN MESAJLAR ════"
pm2 logs wahacrm --lines 300 --nostream 2>/dev/null | grep -E "\[notify\]" | tail -5 || echo "  hic mesaj dusmemis"
echo
echo "════ BITTI ════"
