# WAHA MOTORU — Kurulum

Artık ayrı bir köprü yok. **Ana sunucunun kendisi** WAHA ile çalışıyor.
Yani robot, satışlar, ödemeler, kullanıcılar, etiketler, iç mesajlar,
veritabanı — hepsi aynen çalışıyor. Sadece altındaki WhatsApp motoru değişti.

---

## CANLI SİSTEM ETKİLENMEZ

`server.js`'e `MOTOR` diye bir ayar eklendi. **Varsayılanı `baileys`.**

- Canlı sunucun `MOTOR` ayarı olmadan çalıştığı için **hiçbir şey değişmedi**
- WAHA kodu yalnızca `MOTOR=waha` verildiğinde yükleniyor
- Test için **ayrı bir kopya**, ayrı port, ayrı hat kimliğiyle çalışacak

---

## 1) DOSYALARI YÜKLE

GitHub'a şunları at:
- `server.js` (güncellendi)
- `waha-motor.js` (yeni)

Sonra sunucuda:

```
cd /root/pekcan-crm && git fetch --all && git reset --hard origin/main && echo INDI
```

> Bu komut `pm2 restart` **içermiyor** — canlı sistem çalışmaya devam ediyor.

---

## 2) TEST KOPYASINI HAZIRLA

Canlı klasörden ayrı bir kopya:

```
rm -rf /root/waha-crm
cp -r /root/pekcan-crm /root/waha-crm
cd /root/waha-crm
rm -rf auth .git
```

> `auth` siliniyor çünkü o Baileys oturumu — WAHA'da kullanılmıyor.
> `.git` siliniyor ki yanlışlıkla canlıya bir şey gönderilmesin.

---

## 3) TEST AYARLARINI GİR

```
nano /root/waha-crm/.env
```

Dosyanın **sonuna** şunları ekle (üstteki Supabase satırlarına dokunma):

```
MOTOR=waha
WAHA_URL=http://localhost:3001
WAHA_API_KEY=kediMavi7834Kirmizi
WAHA_OTURUM=test
WAHA_KANCA_PORT=3210
WAHA_KANCA_URL=http://localhost:3210
PORT=3005
LINE_ID=wahatest
```

Kaydet: **Ctrl+O** → Enter → **Ctrl+X**

Ne işe yarıyor:

| Ayar | Anlamı |
|---|---|
| `MOTOR=waha` | Baileys yerine WAHA kullan |
| `WAHA_API_KEY` | WAHA kutusundaki anahtarla **aynı** olmalı |
| `PORT=3005` | Test paneli bu portta (canlı kendi portunda kalır) |
| `LINE_ID=wahatest` | Ayrı hat kimliği — **veriler canlıyla karışmaz** |

---

## 4) WAHA KUTUSU AÇIK OLSUN

Zaten kurulu. Sadece köprü kutusunu kapat, artık gerekmiyor:

```
cd /root/waha-test && docker compose stop kopru && docker compose ps
```

`waha-test` (WAHA'nın kendisi) **açık kalsın**, `waha-kopru` dursun.

---

## 5) BAŞLAT

```
cd /root/waha-crm && pm2 start server.js --name wahacrm && pm2 logs wahacrm --lines 40
```

Şunu görmelisin:

```
╔══════════════════════════════════════════════════════════
║  MOTOR: WAHA  (Baileys DEVRE DISI)
║  WAHA   : http://localhost:3001  (oturum: test)
║  Panelin ve sunucunun geri kalani AYNEN calisiyor.
╚══════════════════════════════════════════════════════════
```

Sonra `[waha] olay koprusu dinliyor` ve bağlantı kurulunca sohbetler.

---

## 6) PANELİ AÇ

```
http://SUNUCU_IP:3005
```

Kendi kullanıcı adın ve şifrenle gir — **canlıdaki kullanıcılar geçerli**
(aynı veritabanı). Sohbetler ayrı hatta olduğu için karışmaz.

Güvenlik duvarı:

```
ufw allow from SENIN_IP to any port 3005
```

---

## KOMUTLAR

```
pm2 logs wahacrm --lines 50      # test sunucusu logu
pm2 restart wahacrm              # yeniden başlat
pm2 stop wahacrm                 # durdur
pm2 delete wahacrm               # tamamen kaldır

pm2 logs pekcan --lines 50       # CANLI sunucu (dokunulmadı)
```

---

## ŞİMDİ NEYE BAKACAKSIN

Artık her şey çalışıyor olmalı — panel canlıdakiyle **birebir aynı**.
Normal çalışıyormuş gibi kullan ve şunları not al:

| Soru | Nerede görülür |
|---|---|
| Günde kaç kopma oluyor | `pm2 logs wahacrm \| grep -c "Baglanti koptu"` |
| Mesaj gönderme süresi | Panelde tik ne kadar sürede çift oluyor |
| Grup numaraları geliyor mu | Grup adına tıkla → üye listesi |
| PDF açılıyor mu | Gelen bir PDF'e tıkla |
| Robot çalışıyor mu | Gruba sözleşme fotoğrafı düşünce |

Bir gün açık bırak, ertesi gün Baileys'in rakamlarıyla karşılaştırırız.

---

## SORUN GİDERME

| Belirti | Sebep |
|---|---|
| `MOTOR: WAHA` yazmıyor | `.env`'de `MOTOR=waha` yok ya da `pm2 restart` gerekiyor |
| `WAHA 401` | `WAHA_API_KEY` iki tarafta farklı |
| `WAHA 404: session` | WAHA'da `test` oturumu yok, dashboard'dan başlat |
| Sohbet gelmiyor | Telefon bağlı değil, dashboard'dan QR okut |
| PDF inmiyor | WAHA'da `WHATSAPP_DOWNLOAD_MEDIA` açık olmalı (docker-compose'da var) |
| Olay gelmiyor | `WAHA_KANCA_URL` WAHA kutusundan erişilebilir olmalı |

**Önemli:** WAHA kutusu Docker içinde, test sunucusu Docker dışında.
WAHA'nın olayları `localhost:3210`'a gönderebilmesi gerekiyor. Sorun olursa
`docker-compose.yml` içindeki `WHATSAPP_HOOK_URL` değerini
`http://host.docker.internal:3210/olay` yap ve şu satırı ekle:

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

---

## GERİ DÖNÜŞ

Beğenmezsen tek komut:

```
pm2 delete wahacrm && rm -rf /root/waha-crm
```

Canlı sistem hiç etkilenmedi, olduğu gibi çalışmaya devam ediyor.
