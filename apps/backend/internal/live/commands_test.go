package live

import (
	"sync"
	"testing"
	"time"
)

func TestCommandReachesSubscribedAgent(t *testing.T) {
	bus := NewCommandBus()
	ch, cancel := bus.Subscribe("device-1")
	defer cancel()

	bus.Publish("device-1", Command{Type: CommandCaptureNow})
	select {
	case got := <-ch:
		if got.Type != CommandCaptureNow {
			t.Fatalf("got %q, want %q", got.Type, CommandCaptureNow)
		}
	case <-time.After(time.Second):
		t.Fatal("agent never received the command")
	}
}

func TestCommandsAreScopedToTheirDevice(t *testing.T) {
	bus := NewCommandBus()
	mine, cancelMine := bus.Subscribe("device-1")
	defer cancelMine()
	other, cancelOther := bus.Subscribe("device-2")
	defer cancelOther()

	bus.Publish("device-1", Command{Type: CommandCaptureNow})

	select {
	case <-mine:
	case <-time.After(time.Second):
		t.Fatal("addressed device did not receive the command")
	}
	select {
	case got := <-other:
		t.Fatalf("command leaked to another device: %#v", got)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestEveryAgentOnADeviceReceivesTheCommand(t *testing.T) {
	bus := NewCommandBus()
	a, cancelA := bus.Subscribe("device-1")
	defer cancelA()
	b, cancelB := bus.Subscribe("device-1")
	defer cancelB()

	bus.Publish("device-1", Command{Type: CommandLiveViewActive, ExpiresInMs: 16000})
	for name, ch := range map[string]<-chan Command{"a": a, "b": b} {
		select {
		case got := <-ch:
			if got.ExpiresInMs != 16000 {
				t.Fatalf("%s got expiry %d", name, got.ExpiresInMs)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s never received the command", name)
		}
	}
}

// A wedged agent must never stall the operator's request path.
func TestPublishNeverBlocksOnAStalledAgent(t *testing.T) {
	bus := NewCommandBus()
	_, cancel := bus.Subscribe("device-1")
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 1000; i++ {
			bus.Publish("device-1", Command{Type: CommandCaptureNow})
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Publish blocked on an agent that was not reading")
	}
}

func TestPublishToDisconnectedDeviceIsANoop(t *testing.T) {
	bus := NewCommandBus()
	bus.Publish("nobody-home", Command{Type: CommandCaptureNow}) // must not panic
	if bus.Connected("nobody-home") != 0 {
		t.Fatal("publishing created a phantom subscriber")
	}
}

func TestCancelReleasesTheDeviceEntry(t *testing.T) {
	bus := NewCommandBus()
	ch, cancel := bus.Subscribe("device-1")
	if bus.Connected("device-1") != 1 || bus.Devices() != 1 {
		t.Fatalf("connected=%d devices=%d", bus.Connected("device-1"), bus.Devices())
	}

	cancel()
	if _, open := <-ch; open {
		t.Fatal("cancel did not close the channel")
	}
	if bus.Connected("device-1") != 0 || bus.Devices() != 0 {
		t.Fatalf("entry leaked: connected=%d devices=%d", bus.Connected("device-1"), bus.Devices())
	}
	cancel() // idempotent
}

func TestConcurrentCommandPublishAndSubscribe(t *testing.T) {
	bus := NewCommandBus()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				bus.Publish("device-1", Command{Type: CommandCaptureNow})
			}
		}()
	}
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				ch, cancel := bus.Subscribe("device-1")
				select {
				case <-ch:
				default:
				}
				cancel()
			}
		}()
	}
	wg.Wait()
	if bus.Devices() != 0 {
		t.Fatalf("device entries leaked: %d", bus.Devices())
	}
}

// The renewal window must be comfortably longer than the renewal interval, so a
// single dropped renewal does not stop an active stream -- while still being
// short enough that an abandoned session stops promptly.
func TestLiveViewTTLToleratesADroppedRenewal(t *testing.T) {
	if LiveViewTTL <= 2*LiveViewRenewInterval {
		t.Fatalf("TTL %v must exceed two renewal intervals (%v)", LiveViewTTL, LiveViewRenewInterval)
	}
	if LiveViewTTL > 30*time.Second {
		t.Fatalf("TTL %v is too long: an abandoned viewer would keep capture running", LiveViewTTL)
	}
}
