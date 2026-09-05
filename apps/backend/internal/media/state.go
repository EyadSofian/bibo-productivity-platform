package media

import "fmt"

// State is where a media session is in its lifecycle.
//
// The finer states exist for diagnosis. Collapsing authorizing, waiting for the
// agent, and negotiating into one "starting" state makes every stalled session
// look the same, and "the live view didn't work" is precisely the report that
// needs to be answerable without a developer attached to the process.
type State string

const (
	// StateRequested is the first persisted state: a viewer asked, nothing has
	// been checked yet.
	StateRequested State = "requested"
	// StateAuthorizing means permissions and policy are being evaluated.
	StateAuthorizing State = "authorizing"
	// StateWaitingForAgent means the session is authorized and the device has
	// been told to publish, but has not appeared yet.
	StateWaitingForAgent State = "waiting_for_agent"
	// StateNegotiating means the agent is connecting to the SFU: ICE, DTLS, the
	// first keyframe.
	StateNegotiating State = "negotiating"
	// StateLive means media is flowing.
	StateLive State = "live"
	// StateReconnecting means an established session lost transport and is
	// recovering. It is not a failure until it times out.
	StateReconnecting State = "reconnecting"
	// StateEnding means teardown has started: the room is closing and any
	// recording is being finalized.
	StateEnding State = "ending"
	// StateEnded is terminal and successful.
	StateEnded State = "ended"
	// StateFailed is terminal and carries a FailureCode.
	StateFailed State = "failed"
)

// FailureCode explains a session in StateFailed. These are the codes the API
// returns and the UI renders, so they are part of the contract: a viewer must be
// told which of these happened, never a generic "unavailable".
type FailureCode string

const (
	// FailDeniedByPolicy: the monitoring policy forbids this, e.g. outside the
	// configured schedule or inside a privacy blackout.
	FailDeniedByPolicy FailureCode = "DENIED_BY_POLICY"
	// FailAgentOffline: the device is not reachable.
	FailAgentOffline FailureCode = "AGENT_OFFLINE"
	// FailTokenExpired: a media token expired before it was used.
	FailTokenExpired FailureCode = "TOKEN_EXPIRED"
	// FailICEFailed: transport could not be established, typically a network
	// that blocks both direct UDP and TURN.
	FailICEFailed FailureCode = "ICE_FAILED"
	// FailCaptureFailed: the agent could not capture the screen.
	FailCaptureFailed FailureCode = "CAPTURE_FAILED"
	// FailEncoderFailed: the agent could not encode, including a hardware
	// encoder that disappeared mid-session.
	FailEncoderFailed FailureCode = "ENCODER_FAILED"
	// FailRoomFailed: the provider rejected or lost the room.
	FailRoomFailed FailureCode = "ROOM_FAILED"
	// FailTimeout: a state was held longer than its budget without progressing.
	FailTimeout FailureCode = "TIMEOUT"
)

// AllFailureCodes is every terminal failure, for validation and for exhaustive
// UI copy. A code the UI has no message for is a bug the tests catch here.
var AllFailureCodes = []FailureCode{
	FailDeniedByPolicy, FailAgentOffline, FailTokenExpired, FailICEFailed,
	FailCaptureFailed, FailEncoderFailed, FailRoomFailed, FailTimeout,
}

// ValidFailureCode reports whether code is one the contract defines.
func ValidFailureCode(code FailureCode) bool {
	for _, c := range AllFailureCodes {
		if c == code {
			return true
		}
	}
	return false
}

// transitions is the whole state machine. Anything not listed is illegal, which
// is the point: a session cannot go back to live from ended, cannot skip
// authorization, and cannot reach live without negotiating first.
//
// Every non-terminal state can reach StateFailed, because every one of them can
// time out or have the provider fall over underneath it.
var transitions = map[State][]State{
	StateRequested:       {StateAuthorizing, StateEnding, StateEnded, StateFailed},
	StateAuthorizing:     {StateWaitingForAgent, StateEnding, StateEnded, StateFailed},
	StateWaitingForAgent: {StateNegotiating, StateEnding, StateEnded, StateFailed},
	StateNegotiating:     {StateLive, StateEnding, StateEnded, StateFailed},
	StateLive:            {StateReconnecting, StateEnding, StateEnded, StateFailed},
	StateReconnecting:    {StateLive, StateEnding, StateEnded, StateFailed},
	StateEnding:          {StateEnded, StateFailed},
	StateEnded:           nil,
	StateFailed:          nil,
}

// Terminal reports whether a session in this state can never change again.
func (s State) Terminal() bool { return s == StateEnded || s == StateFailed }

// Active reports whether a session is doing anything a viewer could watch or
// wait for. Used to decide whether a new request joins an existing session.
func (s State) Active() bool { return !s.Terminal() }

// Valid reports whether s is a state the machine defines.
func (s State) Valid() bool {
	_, ok := transitions[s]
	return ok
}

// CanTransition reports whether from → to is legal.
func CanTransition(from, to State) bool {
	for _, allowed := range transitions[from] {
		if allowed == to {
			return true
		}
	}
	return false
}

// Transition validates a state change, returning an error that names both
// states. Callers pass this error up rather than silently clamping: a rejected
// transition means two things disagree about where the session is, and hiding
// that produces sessions stuck in states nobody can explain.
func Transition(from, to State) error {
	if !from.Valid() {
		return fmt.Errorf("unknown state %q", from)
	}
	if !to.Valid() {
		return fmt.Errorf("unknown target state %q", to)
	}
	if from == to {
		// Idempotent re-entry is not an error: a retried callback, or two
		// viewers reporting the same transition, must not fail.
		return nil
	}
	if !CanTransition(from, to) {
		return fmt.Errorf("illegal media session transition %s -> %s", from, to)
	}
	return nil
}
