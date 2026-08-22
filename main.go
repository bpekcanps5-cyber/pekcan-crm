// ═══════════════════════════════════════════════════════════════════
//  GRUP SERVISI  —  whatsmeow'un canli grup sorgusu
//  -------------------------------------------------------------------
//  NEDEN VAR:
//    WAHA grup bilgisini KENDI DEPOSUNDAN okuyor; depo eksik oldugu icin
//    gruplarin %64'unde bos donuyor. whatsmeow'un GetGroupInfo cagrisi
//    ise WhatsApp'a CANLI soruyor ve gercek cevabi getiriyor.
//    Sonda ile olculdu: toplu cagri 2720/7487 verdi, tek tek sorunca
//    denenen 10 grubun 10'unun da adi geldi.
//
//  NE YAPMIYOR:
//    Mesaj gondermez, mesaj almaz, medya indirmez. Onlari WAHA yapiyor
//    ve calisiyor. Bu servis SADECE grup bilgisi veriyor.
//
//  CIHAZ:
//    sonda.db'yi kullanir — yani sondanin okuttugun QR'ini. Telefona
//    IKINCI bir bagli cihaz EKLENMEZ.
//
//  KULLANIM:
//    GET /grup?jid=120363...@g.us
//      -> {"jid":"...","name":"...","topic":"...","participantCount":24,
//          "participants":[{"id":"90555...@s.whatsapp.net","admin":true}]}
//    GET /saglik   -> {"bagli":true}
// ═══════════════════════════════════════════════════════════════════

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"bytes"
	"net/url"
)

type uye struct {
	ID    string `json:"id"`    // GERCEK NUMARA (varsa)
	LID   string `json:"lid"`   // gizli kimlik
	Name  string `json:"name"`  // WhatsApp'taki gorunen ad
	Admin bool   `json:"admin"`
}

type grupCevap struct {
	JID              string `json:"jid"`
	Name             string `json:"name"`
	Topic            string `json:"topic"`
	ParticipantCount int    `json:"participantCount"`
	Participants     []uye  `json:"participants"`
}

type onbellekKayit struct {
	veri grupCevap
	ts   time.Time
}

var (
	istemci  *whatsmeow.Client
	onbellek = map[string]onbellekKayit{}
	kilit    sync.RWMutex
	// Ayni grubu ust uste sormayalim; WhatsApp'i yormaz, panel hizlanir.
	// Panelin "aciklamayi yenile" tusu icin kisa tutuluyor; ayrica
	// ?taze=1 ile tamamen atlanabiliyor.
	onbellekSuresi = 60 * time.Second
)

// ═══════════════════════════════════════════════════════════════════
//  TIK (TESLIM/OKUNDU) BILDIRIMI  —  WAHA bunu vermiyor
//  -------------------------------------------------------------------
//  OLCUM: 3800 olayda 'message.ack' SIFIR. WAHA olay listesine yaziyor
//  ama tik olayini hic gondermiyor. Bu yuzden panelde tek tik / cift tik
//  hic degismiyordu.
//
//  Bu servis zaten WhatsApp'a bagli ve teslim bildirimlerini
//  (events.Receipt) goruyor. Onlari WAHA'nin bicimide ('message.ack')
//  kopruye iletiyoruz — koprude tek satir degismiyor, oradaki mevcut
//  tik isleyicisi calisiyor.
//
//  WhatsApp -> WAHA olcegi:
//     teslim edildi      -> ack 2  (cift tik)
//     okundu / kendinden -> ack 3  (mavi tik)
//     dinlendi (ses)     -> ack 4
// ═══════════════════════════════════════════════════════════════════
var (
	kopruAdres = ""
	kopruOturum = ""
	tikSayaci  = 0
)

func tikGonder(mesajID, sohbet string, ack int, benim bool) {
	if kopruAdres == "" {
		return
	}
	govde := map[string]any{
		"event":   "message.ack",
		"session": kopruOturum,
		"payload": map[string]any{
			"id":     mesajID,
			"chatId": sohbet,
			"fromMe": benim,
			"ack":    ack,
		},
	}
	ham, err := json.Marshal(govde)
	if err != nil {
		return
	}
	istemciHTTP := &http.Client{Timeout: 8 * time.Second}
	r, err := istemciHTTP.Post(kopruAdres, "application/json", bytes.NewReader(ham))
	if err != nil {
		if tikSayaci < 3 {
			fmt.Println("tik iletilemedi:", err)
		}
		tikSayaci++
		return
	}
	r.Body.Close()
	tikSayaci++
	if tikSayaci <= 5 {
		fmt.Printf("tik iletildi #%d: %s ack=%d\n", tikSayaci, mesajID, ack)
	}
}

func main() {
	port := os.Getenv("GRUP_PORT")
	if port == "" {
		port = "3211"
	}
	dbYol := os.Getenv("GRUP_DB")
	if dbYol == "" {
		dbYol = "sonda.db" // sondanin cihazi — yeni QR gerekmez
	}

	kayit := waLog.Stdout("wm", "ERROR", true)
	ctx := context.Background()

	depo, err := sqlstore.New(ctx, "sqlite3", "file:"+dbYol+"?_foreign_keys=on", kayit)
	if err != nil {
		fmt.Println("veritabani acilamadi:", err)
		return
	}
	cihaz, err := depo.GetFirstDevice(ctx)
	if err != nil || cihaz == nil {
		fmt.Println("kayitli cihaz yok — once sondayi calistirip QR okut:", err)
		return
	}

	kopruAdres = os.Getenv("KOPRU_URL")
	if kopruAdres == "" {
		kopruAdres = "http://127.0.0.1:3210/olay/0"
	}
	kopruOturum = os.Getenv("KOPRU_OTURUM")
	if kopruOturum == "" {
		kopruOturum = "test"
	}
	if _, err := url.Parse(kopruAdres); err != nil {
		fmt.Println("KOPRU_URL hatali:", err)
	}

	istemci = whatsmeow.NewClient(cihaz, kayit)

	// Teslim/okundu bildirimlerini kopruye ilet
	istemci.AddEventHandler(func(olay interface{}) {
		v, tamam := olay.(*events.Receipt)
		if !tamam {
			return
		}
		ack := 2 // teslim edildi -> cift tik
		if v.Type == types.ReceiptTypeRead || v.Type == types.ReceiptTypeReadSelf {
			ack = 3 // okundu -> mavi tik
		} else if v.Type == types.ReceiptTypePlayed {
			ack = 4
		}
		sohbet := v.Chat.String()
		for _, mid := range v.MessageIDs {
			tikGonder(string(mid), sohbet, ack, true)
		}
	})

	if err := istemci.Connect(); err != nil {
		fmt.Println("baglanilamadi:", err)
		return
	}
	fmt.Println("grup servisi: WhatsApp'a baglanildi")

	// Baglanti kopabilir; sessizce yeniden baglan.
	go func() {
		for {
			time.Sleep(20 * time.Second)
			if !istemci.IsConnected() {
				fmt.Println("grup servisi: baglanti koptu, yeniden baglaniyorum...")
				if err := istemci.Connect(); err != nil {
					fmt.Println("  olmadi:", err)
				}
			}
		}
	}()

	http.HandleFunc("/saglik", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"bagli":       istemci.IsConnected(),
			"onbellek":    len(onbellek),
			"tikGonderim": tikSayaci,
			"kopru":       kopruAdres,
		})
	})

	http.HandleFunc("/grup", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		ham := strings.TrimSpace(r.URL.Query().Get("jid"))
		if ham == "" {
			http.Error(w, `{"hata":"jid gerekli"}`, 400)
			return
		}
		if !strings.Contains(ham, "@") {
			ham += "@g.us"
		}

		// ?taze=1 gelirse onbellegi ATLA — panel "yenile" dedi demektir,
		// grup aciklamasi az once degismis olabilir.
		taze := r.URL.Query().Get("taze") == "1"
		if !taze {
			kilit.RLock()
			k, varMi := onbellek[ham]
			kilit.RUnlock()
			if varMi && time.Since(k.ts) < onbellekSuresi {
				json.NewEncoder(w).Encode(k.veri)
				return
			}
		}

		jid, err := types.ParseJID(ham)
		if err != nil {
			http.Error(w, `{"hata":"jid cozulemedi"}`, 400)
			return
		}

		// ═══ CANLI SORGU — WAHA'nin yapamadigi sey ═══════════════════
		sorguCtx, iptal := context.WithTimeout(context.Background(), 20*time.Second)
		defer iptal()
		bilgi, err := istemci.GetGroupInfo(sorguCtx, jid)
		if err != nil {
			http.Error(w, `{"hata":"`+strings.ReplaceAll(err.Error(), `"`, `'`)+`"}`, 502)
			return
		}

		cevap := grupCevap{
			JID:              bilgi.JID.String(),
			Name:             strings.TrimSpace(bilgi.Name),
			Topic:            strings.TrimSpace(bilgi.Topic),
			ParticipantCount: len(bilgi.Participants),
		}
		// ═══ NUMARA HANGI ALANDA? (2026-08) ═════════════════════════
		// WhatsApp grup uyelerini artik GIZLI KIMLIKLE (@lid) veriyor.
		// Gercek numara AYRI alanda: PhoneNumber.
		// Eskiden JID gonderiyorduk, o da @lid oldugu icin panelde
		// "Bilinmeyen kisi / numara gizli" yaziyordu.
		// Sira: PhoneNumber -> (lid degilse) JID -> son care LID
		// Cihaz eki (:12) atiliyor, sadece .User kismi kullaniliyor.
		for _, p := range bilgi.Participants {
			numara := ""
			if p.PhoneNumber.User != "" {
				numara = p.PhoneNumber.User + "@s.whatsapp.net"
			}
			if numara == "" && p.JID.User != "" && p.JID.Server != "lid" {
				numara = p.JID.User + "@s.whatsapp.net"
			}
			lidStr := ""
			if p.LID.User != "" {
				lidStr = p.LID.User + "@lid"
			} else if p.JID.Server == "lid" && p.JID.User != "" {
				lidStr = p.JID.User + "@lid"
			}
			if numara == "" {
				numara = lidStr // gercekten gizli kalmis
			}
			cevap.Participants = append(cevap.Participants, uye{
				ID:    numara,
				LID:   lidStr,
				Name:  strings.TrimSpace(p.DisplayName),
				Admin: p.IsAdmin || p.IsSuperAdmin,
			})
		}

		// Sadece ISE YARAR cevabi sakla
		if cevap.Name != "" {
			kilit.Lock()
			onbellek[ham] = onbellekKayit{veri: cevap, ts: time.Now()}
			kilit.Unlock()
		}
		json.NewEncoder(w).Encode(cevap)
	})

	go func() {
		fmt.Println("grup servisi dinliyor: http://127.0.0.1:" + port)
		if err := http.ListenAndServe("127.0.0.1:"+port, nil); err != nil {
			fmt.Println("sunucu hatasi:", err)
		}
	}()

	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c
	istemci.Disconnect()
}
