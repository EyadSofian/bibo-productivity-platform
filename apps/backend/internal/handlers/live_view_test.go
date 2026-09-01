package handlers

import (
	"testing"

	"ctracking/backend/internal/live"
)

func TestAgentLiveViewStatusFollowsViewerLifecycle(t *testing.T) {
	hub := live.NewHub()
	deviceID := "b26c3607-e66a-4e20-b488-89b21174be13"

	active, ttl := agentLiveViewStatus(hub, deviceID)
	if active || ttl != 0 {
		t.Fatalf("without a viewer got active=%v ttl=%d, want false and zero", active, ttl)
	}

	_, cancel := hub.Subscribe(live.DeviceKey(deviceID))
	active, ttl = agentLiveViewStatus(hub, deviceID)
	if !active || ttl != live.LiveViewTTL.Milliseconds() {
		t.Fatalf("with a viewer got active=%v ttl=%d, want true and %d", active, ttl, live.LiveViewTTL.Milliseconds())
	}

	cancel()
	active, ttl = agentLiveViewStatus(hub, deviceID)
	if active || ttl != 0 {
		t.Fatalf("after viewer disconnect got active=%v ttl=%d, want false and zero", active, ttl)
	}
}
