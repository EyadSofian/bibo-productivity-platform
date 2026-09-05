package media

import "testing"

// The happy path must be reachable in exactly the order the machine claims.
func TestHappyPathReachesLive(t *testing.T) {
	path := []State{
		StateRequested, StateAuthorizing, StateWaitingForAgent,
		StateNegotiating, StateLive, StateEnding, StateEnded,
	}
	for i := 0; i+1 < len(path); i++ {
		if err := Transition(path[i], path[i+1]); err != nil {
			t.Fatalf("%s -> %s: %v", path[i], path[i+1], err)
		}
	}
}

// A session cannot skip authorization or negotiation on its way to live. These
// are the shortcuts a well-meaning refactor would introduce.
func TestCannotSkipStraightToLive(t *testing.T) {
	for _, from := range []State{StateRequested, StateAuthorizing, StateWaitingForAgent} {
		if err := Transition(from, StateLive); err == nil {
			t.Errorf("%s -> live was allowed; authorization or negotiation was skipped", from)
		}
	}
}

// Terminal means terminal. A resumed room or a late provider callback must not
// be able to revive an ended session.
func TestTerminalStatesAreFinal(t *testing.T) {
	for _, from := range []State{StateEnded, StateFailed} {
		if !from.Terminal() {
			t.Errorf("%s should be terminal", from)
		}
		for _, to := range []State{StateLive, StateRequested, StateNegotiating, StateReconnecting} {
			if err := Transition(from, to); err == nil {
				t.Errorf("%s -> %s was allowed; a terminal session was revived", from, to)
			}
		}
	}
}

// A dropped connection recovers rather than failing, and can drop again.
func TestReconnectCycles(t *testing.T) {
	if err := Transition(StateLive, StateReconnecting); err != nil {
		t.Fatalf("live -> reconnecting: %v", err)
	}
	if err := Transition(StateReconnecting, StateLive); err != nil {
		t.Fatalf("reconnecting -> live: %v", err)
	}
	if err := Transition(StateReconnecting, StateFailed); err != nil {
		t.Fatalf("reconnecting -> failed: %v", err)
	}
}

// Every non-terminal state can fail: each of them has a timeout, and the
// provider can fall over underneath any of them.
func TestEveryNonTerminalStateCanFail(t *testing.T) {
	for state := range transitions {
		if state.Terminal() {
			continue
		}
		if err := Transition(state, StateFailed); err != nil {
			t.Errorf("%s cannot reach failed: %v", state, err)
		}
	}
}

// Every non-terminal state can be ended by a viewer giving up or an operator
// stopping the session. A state with no way out is a stuck session.
func TestEveryNonTerminalStateCanBeEnded(t *testing.T) {
	for state := range transitions {
		if state.Terminal() {
			continue
		}
		if err := Transition(state, StateEnded); err != nil {
			t.Errorf("%s cannot be ended: %v", state, err)
		}
	}
}

// Re-entering the same state is idempotent: a retried callback, or two viewers
// reporting the same transition, must not produce an error.
func TestSameStateIsIdempotent(t *testing.T) {
	for state := range transitions {
		if err := Transition(state, state); err != nil {
			t.Errorf("%s -> %s: %v", state, state, err)
		}
	}
}

func TestUnknownStatesRejected(t *testing.T) {
	if err := Transition("live", "watching"); err == nil {
		t.Error("transition to an unknown state was allowed")
	}
	if err := Transition("starting", StateLive); err == nil {
		t.Error("transition from an unknown state was allowed")
	}
	if State("starting").Valid() {
		t.Error("an unknown state reported itself valid")
	}
}

func TestFailureCodesAreClosed(t *testing.T) {
	for _, code := range AllFailureCodes {
		if !ValidFailureCode(code) {
			t.Errorf("%s is listed but does not validate", code)
		}
	}
	if ValidFailureCode("SOMETHING_WENT_WRONG") {
		t.Error("an undefined failure code validated; the UI would have no message for it")
	}
}
