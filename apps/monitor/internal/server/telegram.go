package server

import (
	"log"
	"net/http"
	"net/url"
	"time"
)

type telegram struct {
	token  string
	chatID string
	client *http.Client
}

func newTelegram(token, chatID string) *telegram {
	return &telegram{token: token, chatID: chatID, client: &http.Client{Timeout: 15 * time.Second}}
}

func (t *telegram) send(text string) {
	if t.token == "" || t.chatID == "" {
		log.Printf("telegram (disabled): %s", text)
		return
	}
	resp, err := t.client.PostForm("https://api.telegram.org/bot"+t.token+"/sendMessage", url.Values{
		"chat_id": {t.chatID},
		"text":    {text},
	})
	if err != nil {
		log.Printf("telegram send: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("telegram send: %s", resp.Status)
	}
}
