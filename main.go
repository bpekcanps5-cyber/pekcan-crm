// ═══════════════════════════════════════════════════════════════════
//  WHATSMEOW SONDASI  —  tek soruyu cevaplar
//  -------------------------------------------------------------------
//  SORU: whatsmeow, 8500 grubun ADINI ve ACIKLAMASINI eksiksiz veriyor
//        mu?  (WAHA/GOWS %64'unu bos donduruyordu, is bu yuzden tikandi)
//
//  Bu program BASKA HICBIR SEY YAPMAZ:
//    - Mesaj gondermez, silmez, hicbir seye yazmaz
//    - CRM'e, Supabase'e, canli sisteme dokunmaz
//    - Sadece baglanir, grup listesini okur, sayar ve yazar
//
//  Cevap "evet" cikarsa tam koprüyu yazariz. "hayir" cikarsa 10 dakika
//  kaybetmis oluruz, haftalar degil.
//
//  ONEMLI: Yeni bir cihaz baglantisi acar (QR okutulacak). Telefonunda
//  "Bagli cihazlar" listesinde bir yer kaplar; is bitince cikaracagiz.
// ═══════════════════════════════════════════════════════════════════

package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/mdp/qrterminal/v3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func cizgi() { fmt.Println(strings.Repeat("=", 64)) }

func main() {
	kayit := waLog.Stdout("wm", "ERROR", true) // gurultu olmasin

	depo, err := sqlstore.New("sqlite3", "file:sonda.db?_foreign_keys=on", kayit)
	if err != nil {
		fmt.Println("veritabani acilamadi:", err)
		return
	}
	cihaz, err := depo.GetFirstDevice()
	if err != nil {
		fmt.Println("cihaz okunamadi:", err)
		return
	}

	istemci := whatsmeow.NewClient(cihaz, kayit)

	if istemci.Store.ID == nil {
		// Ilk kurulum: QR okut
		qrKanal, _ := istemci.GetQRChannel(context.Background())
		if err := istemci.Connect(); err != nil {
			fmt.Println("baglanilamadi:", err)
			return
		}
		for olay := range qrKanal {
			if olay.Event == "code" {
				fmt.Println("\nTelefonda: Ayarlar > Bagli cihazlar > Cihaz bagla")
				fmt.Println("Asagidaki kodu okut:")
				qrterminal.GenerateHalfBlock(olay.Code, qrterminal.L, os.Stdout)
			} else {
				fmt.Println("QR durumu:", olay.Event)
			}
		}
	} else {
		if err := istemci.Connect(); err != nil {
			fmt.Println("baglanilamadi:", err)
			return
		}
	}

	fmt.Println("\nbaglandi, WhatsApp senkronu bekleniyor (20 sn)...")
	time.Sleep(20 * time.Second)

	// ═══ ASIL SORU ═══════════════════════════════════════════════════
	gruplar, err := istemci.GetJoinedGroups()
	if err != nil {
		fmt.Println("\nGRUP LISTESI ALINAMADI:", err)
		istemci.Disconnect()
		return
	}

	adli, adsiz, aciklamali, uyeli := 0, 0, 0, 0
	var adsizOrnek []string
	for _, g := range gruplar {
		if strings.TrimSpace(g.Name) != "" {
			adli++
		} else {
			adsiz++
			if len(adsizOrnek) < 5 {
				adsizOrnek = append(adsizOrnek, g.JID.String())
			}
		}
		if strings.TrimSpace(g.Topic) != "" {
			aciklamali++
		}
		if len(g.Participants) > 0 {
			uyeli++
		}
	}

	fmt.Println()
	cizgi()
	fmt.Println("  WHATSMEOW SONUCU")
	cizgi()
	fmt.Printf("  toplam grup      : %d\n", len(gruplar))
	fmt.Printf("  ADI OLAN         : %d\n", adli)
	fmt.Printf("  adi BOS          : %d\n", adsiz)
	fmt.Printf("  aciklamasi olan  : %d\n", aciklamali)
	fmt.Printf("  uye listesi olan : %d\n", uyeli)
	cizgi()

	// Ornek kayitlar — gercekten dolu mu, gozle gorelim
	sort.Slice(gruplar, func(i, j int) bool { return gruplar[i].Name < gruplar[j].Name })
	fmt.Println("  ILK 5 GRUP:")
	for i, g := range gruplar {
		if i >= 5 {
			break
		}
		ack := strings.TrimSpace(g.Topic)
		if len(ack) > 40 {
			ack = ack[:40] + "..."
		}
		fmt.Printf("    %-34s | %2d uye | %s\n",
			kisalt(g.Name, 34), len(g.Participants), ack)
	}
	if adsiz > 0 {
		fmt.Println("\n  ADI BOS OLANLARDAN ORNEK:")
		for _, j := range adsizOrnek {
			fmt.Println("    " + j)
		}
	}
	cizgi()
	if adsiz == 0 && adli > 0 {
		fmt.Println("  ✓ HEPSININ ADI GELDI — whatsmeow bu isi yapiyor.")
	} else if adli > adsiz {
		fmt.Printf("  ~ Cogu geldi (%d/%d). WAHA'dan iyi ama tam degil.\n", adli, len(gruplar))
	} else {
		fmt.Println("  ✗ Buyuk kismi bos — sorun kutuphanede degil, hesapta/olcekte.")
	}
	cizgi()
	fmt.Println("\n  Bu ciktiyi oldugu gibi yapistir.")
	fmt.Println("  Cikmak icin Ctrl+C (baglanti kapanir, cihaz kayitli kalir).")

	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c
	istemci.Disconnect()
}

func kisalt(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
