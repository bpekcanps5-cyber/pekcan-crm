#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  TEK SORU: WAHA mesaj verisinde 'ack' (tik) alani var mi?
#  Cevap "var"  -> tik cikarilabilir, kod calismali
#  Cevap "yok"  -> WAHA bu bilgiyi hic vermiyor, grup servisinden alinir
#  Hicbir seyi degistirmez.
# ═══════════════════════════════════════════════════════════════════
KEY=$(grep -oP '(?<=^WAHA_API_KEY=).*' /root/waha-crm/.env 2>/dev/null)
OTURUM=$(grep -oP '(?<=^WAHA_OTURUM=).*' /root/waha-crm/.env 2>/dev/null); [ -z "$OTURUM" ] && OTURUM=test
WURL=$(grep -oP '(?<=^WAHA_URL=).*' /root/waha-crm/.env 2>/dev/null); [ -z "$WURL" ] && WURL=http://localhost:3001

# Son mesaj gonderdigin grubu logdan bul
JID=$(pm2 logs wahacrm --lines 400 --nostream 2>/dev/null \
      | grep -oE "mesaj gonderildi.*_[0-9]{15,}@g\.us" | tail -1 | grep -oE "[0-9]{15,}@g\.us")
[ -z "$JID" ] && JID=$(pm2 logs wahacrm --lines 400 --nostream 2>/dev/null \
      | grep -oE "grup [0-9]{15,}" | tail -1 | awk '{print $2}')@g.us

echo "════ 1) SURUM ════"
pm2 logs wahacrm --lines 400 --nostream 2>/dev/null | grep -m1 "waha-motor surum" || echo "  SURUM YOK -> dosya yuklenmemis"

echo
echo "════ 2) GRUP SERVISI ════"
curl -s --max-time 5 localhost:3211/saglik || echo "  cevap yok (servis kapali)"
echo

echo
echo "════ 3) WAHA MESAJ VERISI  (grup: $JID) ════"
curl -s --max-time 12 "$WURL/api/$OTURUM/chats/$JID/messages?limit=3&downloadMedia=false" \
  -H "X-Api-Key: $KEY" > /tmp/msg.json 2>/dev/null

python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/msg.json'))
except Exception as e:
    print('  okunamadi:', e)
    print('  ham:', open('/tmp/msg.json').read()[:200]); raise SystemExit
if isinstance(d, dict): d = d.get('data') or []
if not d:
    print('  mesaj gelmedi (bos liste)'); raise SystemExit
print('  gelen mesaj sayisi:', len(d))
m = d[0]
print('  ust alanlar:', ', '.join(list(m.keys())[:16]))
print()
gidenler = [x for x in d if x.get('fromMe')]
hedef = gidenler[0] if gidenler else m
print('  --- ORNEK (giden mesaj) ---')
for k in ('id','fromMe','ack','ackName','status'):
    if k in hedef: print('   ', k, '=', hedef[k])
ic = hedef.get('_data') or {}
if isinstance(ic, dict):
    for k in ('status','ack'):
        if k in ic: print('    _data.'+k, '=', ic[k])
print()
varMi = any(('ack' in x) or ('status' in (x.get('_data') or {})) for x in d)
print('  >>> ACK ALANI:', 'VAR ✅  (tik cikarilabilir)' if varMi else 'YOK ❌  (WAHA tik bilgisi vermiyor)')
PY
echo
echo "════ 4) TIK KAYITLARI ════"
pm2 logs wahacrm --lines 400 --nostream 2>/dev/null | grep -E "tik \(sorarak\)|tik olayi|tik ilerledi" | tail -5 \
  || echo "  tik satiri yok"
pm2 logs grupservisi --lines 200 --nostream 2>/dev/null | grep -E "tik iletildi|tik iletilemedi" | tail -3 \
  || echo "  grup servisinde tik satiri yok"
echo
echo "════ BITTI ════"
