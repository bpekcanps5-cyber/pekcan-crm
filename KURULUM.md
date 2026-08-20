# WAHA TEST DÜZENEĞİ — Kurulum

Amaç: **WAHA/GOWS motorunu, canlı sisteme hiç dokunmadan, kendi panelimizle test etmek.**

Ayrı telefon, ayrı numara, ayrı port, ayrı oturum. Baileys sunucusuna hiçbir bağlantısı yok.

---

## ÖNCE BİLMEN GEREKEN

WAHA bir kütüphane değil, **kapsayıcı**. İçinde motor seçiyorsun:

| Motor | Altında ne var | Test etmeye değer mi |
|---|---|---|
| NOWEB | **Baileys** | Hayır — şu an kullandığımızın aynısı |
| WEBJS | Chrome + whatsapp-web.js | Belki — ama her oturum bir tarayıcı, çok ağır |
| **GOWS** | **whatsmeow (Go)** | **Evet** — gerçekten farklı kütüphane |

Bu düzenek **GOWS** ile kurulu. `docker-compose.yml` içinde `WAHA_DEFAULT_ENGINE: GOWS`.

**Dürüst beklenti:** Hız sınırı WhatsApp'ın tarafında. Motor değiştirmek onu değiştirmez.
WAHA'nın gerçek kazancı **süreç ayrımı** — WhatsApp bağlantısı ayrı kutuda çalışır,
panel çökse bile bağlantı ayakta kalır.

---

## KURULUM (5 adım)

### 1. Dosyaları sunucuya at

Canlı projeden **AYRI** bir klasöre:

```
mkdir -p /root/waha-test
```

Bu klasördeki tüm dosyaları oraya kopyala.

### 2. Ayarları gir

```
cd /root/waha-test
cp .env.ornek .env
nano .env
```

İçini doldur (anahtarları sen uydur, uzun ve rastgele olsun):

```
WAHA_API_KEY=uzun-rastgele-bir-anahtar
WAHA_PANEL_SIFRE=waha-arayuz-sifresi
PANEL_KULLANICI=demo
PANEL_SIFRE=demo
```

### 3. Başlat

```
cd /root/waha-test && docker compose up -d && docker compose logs -f
```

Loglarda şunu görmelisin:

```
║  WAHA TEST KOPRUSU calisiyor
║  Panel     : http://localhost:3002
```

### 4. Telefonu bağla

Tarayıcıda: **`http://SUNUCU_IP:3001/dashboard`**
(kullanıcı `admin`, şifre `.env`'e yazdığın `WAHA_PANEL_SIFRE`)

Orada `test` oturumunu göreceksin → **Start** → QR çıkacak →
**ikinci telefondan** okut.

> Kendi ana numaranı **okutma.** Test için ayrı bir numara kullan.

### 5. Paneli aç

**`http://SUNUCU_IP:3002`** → giriş: `demo` / `demo`

Kendi panelin açılacak, ama arkasında WAHA çalışacak.

---

## NEYE BAKACAKSIN

Test ederken şunları not al, karar bunlara göre verilecek:

| Soru | Nasıl bakılır |
|---|---|
| Sohbetler geldi mi, kaç tanesi | Panel açılışında sol liste |
| Grup adları doğru mu | Liste + sohbet başlığı |
| Gelen mesaj kaç saniyede düşüyor | Test telefonundan yaz, panele bak |
| Giden mesaj kaç saniyede gidiyor | Logda `📤 gonderildi (XXX ms)` |
| Kopuyor mu | Logda `🔌 WAHA durum:` satırları |
| Bir gün açık kalınca ne oluyor | Ertesi gün loglara bak |

Bir günlük gözlem yeterli. Kopma sayısını ve gönderim süresini not al —
Baileys'teki rakamlarla karşılaştıracağız.

---

## BU TESTTE OLMAYAN ŞEYLER (bilerek)

Test düzeneği **sade** tutuldu. Şunlar yok:

- Veritabanı (test verisi kalıcı değil, yeniden başlatınca sıfırlanır)
- Etiketler, atamalar, iç mesajlar, satış/ödeme takibi
- İptal robotu, OCR
- Medya indirme (fotoğraf/PDF görünür ama indirilmez)

Bunlar **canlı sistemde çalışmaya devam ediyor.** Test sadece şu soruyu
cevaplamak için: *"WAHA/GOWS bağlantı olarak Baileys'ten iyi mi?"*

Cevap evet ise, kalan parçaları sonra taşırız.

---

## KOMUTLAR

```
# Durum
cd /root/waha-test && docker compose ps

# Loglar (canlı)
docker compose logs -f kopru

# Sadece WAHA logları
docker compose logs -f waha

# Yeniden başlat
docker compose restart

# Tamamen kaldır (oturum dosyaları da silinir, QR gerekir)
docker compose down -v
```

Bağlantı özeti (tarayıcıdan):
```
http://SUNUCU_IP:3002/waha/durum
```

---

## SORUN GİDERME

| Belirti | Sebep |
|---|---|
| `WAHA'ya ulasilamadi` | WAHA kutusu daha açılmamış, 30 sn bekle |
| Panel açılıyor ama sohbet yok | Telefon henüz bağlanmamış, dashboard'dan QR okut |
| `oturum yok, olusturuluyor` | Normal, ilk açılışta olur |
| Mesaj gitmiyor, logda `✗ GONDERILEMEDI` | Hata mesajını bana at |
| Sohbetler geliyor ama mesajlar boş | WAHA sürümünde alan adı farklı olabilir, logu at |

---

## ÖNEMLİ UYARI

Bu düzenek **3001 ve 3002 portlarını** açıyor. Sunucun internete açıksa
bu portlar dışarıdan erişilebilir olur. İkisi de şifreli ama yine de
test bitince kapat:

```
docker compose down
```

Ya da güvenlik duvarıyla sadece kendi IP'ne aç.

---

## KARAR AŞAMASI

Bir günlük testten sonra elimizde şu olacak:

- WAHA'da günlük kopma sayısı
- Ortalama gönderim süresi
- Sohbet/grup listesi düzgün geldi mi

Baileys'in aynı rakamlarıyla karşılaştırıp karar veririz. **Sonuç kötüyse
hiçbir şey kaybetmedik** — canlı sistem hiç etkilenmedi, `docker compose down`
deyip siliyoruz.
