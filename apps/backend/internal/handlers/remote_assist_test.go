package handlers

import (
	"encoding/json"
	"testing"
)

func TestValidateRemoteAction(t *testing.T) {
	valid := []remoteActionReq{
		{Kind: "click", Payload: json.RawMessage(`{"x":0,"y":1,"button":"left"}`)},
		{Kind: "move", Payload: json.RawMessage(`{"x":0.5,"y":0.5}`)},
		{Kind: "key", Payload: json.RawMessage(`{"key":"Enter"}`)},
		{Kind: "text", Payload: json.RawMessage(`{"text":"hello"}`)},
	}
	for _, action := range valid {
		if !validateRemoteAction(action) {
			t.Errorf("valid action rejected: %#v", action)
		}
	}

	invalid := []remoteActionReq{
		{Kind: "click", Payload: json.RawMessage(`{"x":-1,"y":0,"button":"left"}`)},
		{Kind: "click", Payload: json.RawMessage(`{"x":0.5,"y":0.5,"button":"middle"}`)},
		{Kind: "move", Payload: json.RawMessage(`{"x":2,"y":0.5}`)},
		{Kind: "key", Payload: json.RawMessage(`{"key":"Meta"}`)},
		{Kind: "text", Payload: json.RawMessage(`{"text":""}`)},
		{Kind: "shell", Payload: json.RawMessage(`{"command":"whoami"}`)},
	}
	for _, action := range invalid {
		if validateRemoteAction(action) {
			t.Errorf("invalid action accepted: %#v", action)
		}
	}
}
