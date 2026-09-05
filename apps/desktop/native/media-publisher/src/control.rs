//! Remote-control protocol (V07 / ticket 151).
//!
//! Control travels over the **WebRTC DataChannel** of the same LiveKit room that
//! carries the video - never over REST polling, and never over the agent pipe.
//! The viewer publishes on topic [`TOPIC_CONTROL`]; the agent answers on
//! [`TOPIC_CONTROL_ACK`].
//!
//! # What this module refuses to do
//!
//! The wire enum below is the **complete** set of things a remote operator can
//! ask for. There is no shell command, no file transfer, and no clipboard
//! transfer - not disabled, absent. An unrecognised `type`, or an extra field on
//! a recognised one, is a hard rejection rather than a silently-ignored key: see
//! [`allowed_keys`], which exists because serde's `deny_unknown_fields` does not
//! survive `#[serde(flatten)]` and would otherwise be strictness in name only.
//!
//! # Not logging what the user types
//!
//! [`Key`] and [`Text`] carry keystrokes, which may be a password. Their `Debug`
//! impls print only a shape, never the value, so no logging path can leak them
//! even by accident. This is enforced by tests.
//!
//! # Coordinates
//!
//! Pointer positions are **normalised 0.0..1.0 within one monitor**, never
//! device pixels. The viewer does not know the agent's DPI, scaling factor or
//! monitor layout, and must not have to: [`crate::input_injector`] maps a
//! normalised point onto the real virtual desktop.

use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// DataChannel topic for viewer → agent control messages.
pub const TOPIC_CONTROL: &str = "control";
/// DataChannel topic for agent → viewer acknowledgements and errors.
pub const TOPIC_CONTROL_ACK: &str = "control-ack";

/// Hard ceiling on a single control frame. A control message is tens of bytes;
/// anything approaching this is malformed or hostile.
pub const MAX_FRAME_BYTES: usize = 4 * 1024;

/// Longest `key_text` we will inject in one message.
pub const MAX_TEXT_CHARS: usize = 256;

/// Sustained message ceiling. 15fps video with pointer coalescing needs well
/// under this; it exists so a misbehaving or hostile viewer cannot flood the
/// input queue.
pub const MAX_MESSAGES_PER_SEC: u32 = 240;

/// Mouse buttons we accept. Deliberately only the three standard ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// Keyboard modifier state, sent with every key event so the agent never has to
/// infer sticky state from a stream that may have dropped a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Modifiers {
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    /// Windows key. Accepted but see `input_injector` for what is refused.
    #[serde(default)]
    pub meta: bool,
}

/// A normalised pointer position inside one monitor.
#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    /// 0.0 = left edge, 1.0 = right edge of `monitor`.
    pub x: f32,
    /// 0.0 = top edge, 1.0 = bottom edge of `monitor`.
    pub y: f32,
    /// Which monitor the point is relative to. 0 is primary.
    #[serde(default)]
    pub monitor: u32,
}

impl fmt::Debug for Point {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Positions are not secret, but they are noisy; keep them short.
        write!(f, "({:.3},{:.3})@{}", self.x, self.y, self.monitor)
    }
}

impl Point {
    /// True when the point is inside the unit square. Anything else is a bug or
    /// an attempt to steer the cursor somewhere it was never shown.
    pub fn in_bounds(&self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && (0.0..=1.0).contains(&self.x)
            && (0.0..=1.0).contains(&self.y)
    }
}

/// A key event's payload. Separate struct so its `Debug` can redact.
#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Key {
    /// Windows virtual-key code.
    pub code: u32,
    #[serde(default)]
    pub modifiers: Modifiers,
}

impl fmt::Debug for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never print `code`: the sequence of codes IS the typed text, and the
        // typed text may be a password.
        f.write_str("Key(<redacted>)")
    }
}

/// Unicode text injection. Separate struct so its `Debug` can redact.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Text {
    pub text: String,
}

impl fmt::Debug for Text {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Length only. The value may be a password.
        write!(f, "Text(<redacted {} chars>)", self.text.chars().count())
    }
}

/// Viewer → agent. This is the whole vocabulary of remote control.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlMessage {
    PointerMove {
        seq: u64,
        #[serde(flatten)]
        at: Point,
    },
    PointerButton {
        seq: u64,
        button: Button,
        down: bool,
        #[serde(flatten)]
        at: Point,
    },
    Wheel {
        seq: u64,
        /// Horizontal ticks; positive is right.
        #[serde(default)]
        dx: f32,
        /// Vertical ticks; positive is up, matching WHEEL_DELTA's sign.
        #[serde(default)]
        dy: f32,
    },
    KeyDown {
        seq: u64,
        #[serde(flatten)]
        key: Key,
    },
    KeyUp {
        seq: u64,
        #[serde(flatten)]
        key: Key,
    },
    KeyText {
        seq: u64,
        #[serde(flatten)]
        text: Text,
    },
    ControlPing {
        seq: u64,
    },
}

impl ControlMessage {
    pub fn seq(&self) -> u64 {
        match self {
            Self::PointerMove { seq, .. }
            | Self::PointerButton { seq, .. }
            | Self::Wheel { seq, .. }
            | Self::KeyDown { seq, .. }
            | Self::KeyUp { seq, .. }
            | Self::KeyText { seq, .. }
            | Self::ControlPing { seq } => *seq,
        }
    }

    /// Sensitive messages are acknowledged so the viewer knows a click or key
    /// actually landed. Pointer moves are not: they are coalesced and lossy by
    /// design, and acking every one would double the message rate.
    pub fn needs_ack(&self) -> bool {
        !matches!(self, Self::PointerMove { .. })
    }
}

/// Agent → viewer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlReply {
    ControlAck {
        seq: u64,
        ack_seq: u64,
    },
    ControlError {
        seq: u64,
        code: ErrorCode,
        detail: String,
    },
}

/// Why a control message was refused. A closed set so the viewer can react
/// programmatically rather than parsing prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Remote control is not currently permitted (emergency stop, or never armed).
    NotArmed,
    /// The message arrived faster than [`MAX_MESSAGES_PER_SEC`].
    RateLimited,
    /// Sequence number was not ahead of the last accepted one.
    OutOfOrder,
    /// Payload failed validation (bad coordinates, oversized text, unknown type).
    Malformed,
}

/// Why a frame was rejected before it reached the injector.
#[derive(Debug, Clone, PartialEq)]
pub enum RejectReason {
    NotArmed,
    RateLimited,
    OutOfOrder { seq: u64, last: u64 },
    TooLarge { bytes: usize },
    Malformed(String),
}

impl RejectReason {
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::NotArmed => ErrorCode::NotArmed,
            Self::RateLimited => ErrorCode::RateLimited,
            Self::OutOfOrder { .. } => ErrorCode::OutOfOrder,
            Self::TooLarge { .. } | Self::Malformed(_) => ErrorCode::Malformed,
        }
    }

    /// A short, non-sensitive description. Never contains message payload.
    pub fn detail(&self) -> String {
        match self {
            Self::NotArmed => "remote control is not armed".into(),
            Self::RateLimited => "message rate exceeded".into(),
            Self::OutOfOrder { seq, last } => format!("seq {seq} not ahead of {last}"),
            Self::TooLarge { bytes } => format!("frame of {bytes} bytes exceeds cap"),
            // The parse error names the offending *field*, never its value.
            Self::Malformed(what) => format!("malformed control frame: {what}"),
        }
    }
}

/// The emergency stop.
///
/// Each message checks the armed flag. A disarm generation also notifies the
/// injector's 10ms release loop, so held inputs are released even if no further
/// control message arrives or the gate is immediately rearmed. Runtime latency
/// still needs measurement on the target Windows machine.
#[derive(Debug, Default)]
pub struct ControlGate {
    armed: AtomicBool,
    disarm_epoch: AtomicU64,
    /// Counts messages actually applied, for the audit trail.
    applied: AtomicU64,
    rejected: AtomicU64,
}

impl ControlGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Arms control. Called only after the backend has authorised the session.
    pub fn arm(&self) {
        self.armed.store(true, Ordering::Release);
    }

    /// Emergency stop. Safe to call from any thread, including a signal path.
    pub fn disarm(&self) {
        self.armed.store(false, Ordering::Release);
        self.disarm_epoch.fetch_add(1, Ordering::AcqRel);
    }

    pub fn disarm_epoch(&self) -> u64 {
        self.disarm_epoch.load(Ordering::Acquire)
    }

    pub fn is_armed(&self) -> bool {
        self.armed.load(Ordering::Acquire)
    }

    pub fn applied(&self) -> u64 {
        self.applied.load(Ordering::Relaxed)
    }

    pub fn rejected(&self) -> u64 {
        self.rejected.load(Ordering::Relaxed)
    }
}

/// Fixed-window rate limiter. A token bucket would be smoother, but a window is
/// easier to reason about when the question is "can a viewer flood us".
#[derive(Debug)]
struct RateWindow {
    started: Instant,
    count: u32,
    limit: u32,
}

impl RateWindow {
    fn new(limit: u32) -> Self {
        Self {
            started: Instant::now(),
            count: 0,
            limit,
        }
    }

    /// Returns false when the caller is over budget for the current second.
    fn allow(&mut self, now: Instant) -> bool {
        if now.duration_since(self.started) >= Duration::from_secs(1) {
            self.started = now;
            self.count = 0;
        }
        if self.count >= self.limit {
            return false;
        }
        self.count += 1;
        true
    }
}

/// Validates and orders an inbound control stream.
///
/// One session owns one `ControlStream`. It is **not** `Sync` on purpose: all
/// control messages for a session are processed on a single thread, so ordering
/// is a property of the type rather than a convention.
#[derive(Debug)]
pub struct ControlStream {
    last_seq: u64,
    rate: RateWindow,
    /// Latest pending pointer move, if any. See [`Self::take_pending_move`].
    pending_move: Option<Point>,
    coalesced: u64,
}

impl Default for ControlStream {
    fn default() -> Self {
        Self::new()
    }
}

impl ControlStream {
    pub fn new() -> Self {
        Self {
            last_seq: 0,
            rate: RateWindow::new(MAX_MESSAGES_PER_SEC),
            pending_move: None,
            coalesced: 0,
        }
    }

    /// How many pointer moves were superseded before being applied. Reported in
    /// metrics so a laggy link is visible rather than merely felt.
    pub fn coalesced(&self) -> u64 {
        self.coalesced
    }

    /// Parses and validates one DataChannel frame.
    ///
    /// `now` is injected so the rate limiter is testable without sleeping.
    pub fn accept(
        &mut self,
        frame: &[u8],
        gate: &ControlGate,
        now: Instant,
    ) -> Result<ControlMessage, RejectReason> {
        // Order matters: the gate is checked before anything is parsed, so a
        // stopped session does no work at all on attacker-controlled bytes.
        if !gate.is_armed() {
            gate.rejected.fetch_add(1, Ordering::Relaxed);
            return Err(RejectReason::NotArmed);
        }
        if frame.len() > MAX_FRAME_BYTES {
            gate.rejected.fetch_add(1, Ordering::Relaxed);
            return Err(RejectReason::TooLarge { bytes: frame.len() });
        }
        if !self.rate.allow(now) {
            gate.rejected.fetch_add(1, Ordering::Relaxed);
            return Err(RejectReason::RateLimited);
        }

        // Shape first: an unknown type or a smuggled field is refused before
        // serde is asked to build anything from the bytes.
        if let Err(why) = check_shape(frame) {
            gate.rejected.fetch_add(1, Ordering::Relaxed);
            return Err(RejectReason::Malformed(why));
        }

        let msg: ControlMessage = serde_json::from_slice(frame).map_err(|_| {
            gate.rejected.fetch_add(1, Ordering::Relaxed);
            // The parse error itself is not echoed: it can quote input.
            RejectReason::Malformed("frame did not match its declared type".into())
        })?;

        let seq = msg.seq();
        if seq <= self.last_seq {
            gate.rejected.fetch_add(1, Ordering::Relaxed);
            return Err(RejectReason::OutOfOrder {
                seq,
                last: self.last_seq,
            });
        }

        if let Err(why) = validate(&msg) {
            gate.rejected.fetch_add(1, Ordering::Relaxed);
            return Err(RejectReason::Malformed(why));
        }

        self.last_seq = seq;
        gate.applied.fetch_add(1, Ordering::Relaxed);

        // Pointer moves are coalesced: only the newest position matters, so a
        // backlog collapses to one move instead of replaying a stale path.
        if let ControlMessage::PointerMove { at, .. } = &msg {
            if self.pending_move.is_some() {
                self.coalesced += 1;
            }
            self.pending_move = Some(*at);
        }

        Ok(msg)
    }

    /// Takes the most recent coalesced pointer position, if one is pending.
    pub fn take_pending_move(&mut self) -> Option<Point> {
        self.pending_move.take()
    }
}

/// The exact set of keys each message type may carry.
///
/// This exists because serde's `deny_unknown_fields` **does not survive
/// `#[serde(flatten)]`**: a flattened struct is deserialised from a buffered map
/// that drops the attribute, so the strictness it looks like we have would in
/// fact be absent. Rather than trust an attribute that silently does nothing on
/// exactly the variants carrying keystrokes, the allowlist is spelled out.
fn allowed_keys(kind: &str) -> Option<&'static [&'static str]> {
    Some(match kind {
        "pointer_move" => &["type", "seq", "x", "y", "monitor"][..],
        "pointer_button" => &["type", "seq", "button", "down", "x", "y", "monitor"][..],
        "wheel" => &["type", "seq", "dx", "dy"][..],
        "key_down" | "key_up" => &["type", "seq", "code", "modifiers"][..],
        "key_text" => &["type", "seq", "text"][..],
        "control_ping" => &["type", "seq"][..],
        _ => return None,
    })
}

/// Rejects anything that is not exactly one of the declared message shapes.
///
/// Error strings deliberately contain **no attacker-controlled text**: the type
/// and field names come from the frame, so echoing them would put remote input
/// into our logs.
fn check_shape(frame: &[u8]) -> Result<(), String> {
    let v: serde_json::Value =
        serde_json::from_slice(frame).map_err(|_| "not valid JSON".to_string())?;
    let obj = v.as_object().ok_or("frame is not a JSON object")?;
    let kind = obj
        .get("type")
        .and_then(|t| t.as_str())
        .ok_or("frame has no string `type`")?;
    let allowed = allowed_keys(kind).ok_or("unknown message type")?;
    if obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("frame carries a field this message type does not define".into());
    }
    Ok(())
}

/// Semantic validation, past what the type system already guarantees.
fn validate(msg: &ControlMessage) -> Result<(), String> {
    match msg {
        ControlMessage::PointerMove { at, .. } | ControlMessage::PointerButton { at, .. } => {
            if !at.in_bounds() {
                return Err("pointer position outside 0..1".into());
            }
        }
        ControlMessage::Wheel { dx, dy, .. } => {
            if !dx.is_finite() || !dy.is_finite() {
                return Err("wheel delta not finite".into());
            }
            if dx.abs() > 100.0 || dy.abs() > 100.0 {
                return Err("wheel delta out of range".into());
            }
        }
        ControlMessage::KeyText { text, .. } => {
            if text.text.chars().count() > MAX_TEXT_CHARS {
                return Err("key_text too long".into());
            }
            if text.text.is_empty() {
                return Err("key_text empty".into());
            }
        }
        ControlMessage::KeyDown { .. }
        | ControlMessage::KeyUp { .. }
        | ControlMessage::ControlPing { .. } => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn armed() -> ControlGate {
        let g = ControlGate::new();
        g.arm();
        g
    }

    fn accept(
        s: &mut ControlStream,
        g: &ControlGate,
        json: &str,
    ) -> Result<ControlMessage, RejectReason> {
        s.accept(json.as_bytes(), g, Instant::now())
    }

    #[test]
    fn accepts_each_allowed_message_type() {
        let g = armed();
        let mut s = ControlStream::new();
        for (i, json) in [
            r#"{"type":"pointer_move","seq":1,"x":0.5,"y":0.5}"#,
            r#"{"type":"pointer_button","seq":2,"button":"left","down":true,"x":0.1,"y":0.2}"#,
            r#"{"type":"wheel","seq":3,"dy":3.0}"#,
            r#"{"type":"key_down","seq":4,"code":65}"#,
            r#"{"type":"key_up","seq":5,"code":65}"#,
            r#"{"type":"key_text","seq":6,"text":"hi"}"#,
            r#"{"type":"control_ping","seq":7}"#,
        ]
        .iter()
        .enumerate()
        {
            assert!(
                accept(&mut s, &g, json).is_ok(),
                "message {i} rejected: {json}"
            );
        }
    }

    #[test]
    fn refuses_message_types_that_do_not_exist() {
        // The spec forbids shell, file transfer and clipboard. They are not
        // "disabled" anywhere - they simply cannot be expressed, and an attempt
        // to send one is a parse error.
        let g = armed();
        let mut s = ControlStream::new();
        for json in [
            r#"{"type":"exec","seq":1,"cmd":"powershell"}"#,
            r#"{"type":"file_transfer","seq":1,"path":"C:\\secret"}"#,
            r#"{"type":"clipboard_set","seq":1,"text":"x"}"#,
            r#"{"type":"clipboard_get","seq":1}"#,
        ] {
            let err = accept(&mut s, &g, json).unwrap_err();
            assert_eq!(err.code(), ErrorCode::Malformed, "{json} was not refused");
        }
    }

    #[test]
    fn refuses_unknown_fields_smuggled_into_a_known_type() {
        let g = armed();
        let mut s = ControlStream::new();
        let err = accept(
            &mut s,
            &g,
            r#"{"type":"key_text","seq":1,"text":"hi","exec":"calc.exe"}"#,
        )
        .unwrap_err();
        assert_eq!(err.code(), ErrorCode::Malformed);
    }

    #[test]
    fn emergency_stop_refuses_the_very_next_message() {
        let g = armed();
        let mut s = ControlStream::new();
        assert!(accept(&mut s, &g, r#"{"type":"control_ping","seq":1}"#).is_ok());

        g.disarm();

        let err = accept(&mut s, &g, r#"{"type":"control_ping","seq":2}"#).unwrap_err();
        assert_eq!(err, RejectReason::NotArmed);
    }

    #[test]
    fn emergency_stop_is_far_inside_the_500ms_budget() {
        let g = armed();
        let mut s = ControlStream::new();
        let t0 = Instant::now();
        g.disarm();
        let err = accept(&mut s, &g, r#"{"type":"control_ping","seq":1}"#).unwrap_err();
        let elapsed = t0.elapsed();

        assert_eq!(err, RejectReason::NotArmed);
        assert!(
            elapsed < Duration::from_millis(500),
            "stop took {elapsed:?}"
        );
    }

    #[test]
    fn a_stream_that_was_never_armed_accepts_nothing() {
        let g = ControlGate::new(); // not armed
        let mut s = ControlStream::new();
        assert_eq!(
            accept(&mut s, &g, r#"{"type":"control_ping","seq":1}"#).unwrap_err(),
            RejectReason::NotArmed
        );
    }

    #[test]
    fn rejects_replayed_and_out_of_order_sequences() {
        let g = armed();
        let mut s = ControlStream::new();
        assert!(accept(&mut s, &g, r#"{"type":"control_ping","seq":5}"#).is_ok());

        for seq in [5u64, 4, 1] {
            let json = format!(r#"{{"type":"control_ping","seq":{seq}}}"#);
            let err = accept(&mut s, &g, &json).unwrap_err();
            assert_eq!(err.code(), ErrorCode::OutOfOrder, "seq {seq} was accepted");
        }
        // A later sequence still works, so a replay does not wedge the stream.
        assert!(accept(&mut s, &g, r#"{"type":"control_ping","seq":6}"#).is_ok());
    }

    #[test]
    fn rate_limits_a_flood_within_one_window() {
        let g = armed();
        let mut s = ControlStream::new();
        let now = Instant::now();

        let mut accepted = 0u32;
        for seq in 1..=(MAX_MESSAGES_PER_SEC + 50) {
            let json = format!(r#"{{"type":"control_ping","seq":{seq}}}"#);
            if s.accept(json.as_bytes(), &g, now).is_ok() {
                accepted += 1;
            }
        }
        assert_eq!(accepted, MAX_MESSAGES_PER_SEC);

        // The next window lets traffic through again.
        let later = now + Duration::from_millis(1_100);
        let json = format!(
            r#"{{"type":"control_ping","seq":{}}}"#,
            MAX_MESSAGES_PER_SEC + 100
        );
        assert!(s.accept(json.as_bytes(), &g, later).is_ok());
    }

    #[test]
    fn refuses_an_oversized_frame_without_parsing_it() {
        let g = armed();
        let mut s = ControlStream::new();
        let big = vec![b'a'; MAX_FRAME_BYTES + 1];
        assert!(matches!(
            s.accept(&big, &g, Instant::now()).unwrap_err(),
            RejectReason::TooLarge { .. }
        ));
    }

    #[test]
    fn refuses_pointer_positions_outside_the_screen() {
        let g = armed();
        let mut s = ControlStream::new();
        for (i, json) in [
            r#"{"type":"pointer_move","seq":1,"x":1.5,"y":0.5}"#,
            r#"{"type":"pointer_move","seq":1,"x":-0.1,"y":0.5}"#,
            r#"{"type":"pointer_move","seq":1,"x":0.5,"y":1e30}"#,
        ]
        .iter()
        .enumerate()
        {
            let mut fresh = ControlStream::new();
            let err = fresh
                .accept(json.as_bytes(), &g, Instant::now())
                .unwrap_err();
            assert_eq!(err.code(), ErrorCode::Malformed, "case {i} accepted");
        }
        let _ = &mut s;
    }

    #[test]
    fn refuses_text_longer_than_the_cap() {
        let g = armed();
        let mut s = ControlStream::new();
        let long = "x".repeat(MAX_TEXT_CHARS + 1);
        let json = format!(r#"{{"type":"key_text","seq":1,"text":"{long}"}}"#);
        assert_eq!(
            accept(&mut s, &g, &json).unwrap_err().code(),
            ErrorCode::Malformed
        );
    }

    #[test]
    fn coalesces_pointer_moves_to_the_newest_position() {
        let g = armed();
        let mut s = ControlStream::new();
        for (seq, x) in [(1, 0.1f32), (2, 0.2), (3, 0.9)] {
            let json = format!(r#"{{"type":"pointer_move","seq":{seq},"x":{x},"y":0.5}}"#);
            accept(&mut s, &g, &json).unwrap();
        }

        let p = s.take_pending_move().expect("a move should be pending");
        assert_eq!(p.x, 0.9, "coalescing must keep the newest position");
        assert_eq!(s.coalesced(), 2);
        assert!(s.take_pending_move().is_none(), "taking must clear it");
    }

    #[test]
    fn sensitive_messages_are_acked_and_pointer_moves_are_not() {
        let key = ControlMessage::KeyDown {
            seq: 1,
            key: Key {
                code: 65,
                modifiers: Modifiers::default(),
            },
        };
        let click = ControlMessage::PointerButton {
            seq: 2,
            button: Button::Left,
            down: true,
            at: Point {
                x: 0.5,
                y: 0.5,
                monitor: 0,
            },
        };
        let mv = ControlMessage::PointerMove {
            seq: 3,
            at: Point {
                x: 0.5,
                y: 0.5,
                monitor: 0,
            },
        };

        assert!(key.needs_ack());
        assert!(click.needs_ack());
        assert!(
            !mv.needs_ack(),
            "acking every move would double the message rate"
        );
    }

    #[test]
    fn debug_never_reveals_what_was_typed() {
        // A password typed through remote control must not reach any log, and
        // the only way to guarantee that is for the value to be unprintable.
        let secret = "hunter2-correct-horse";
        let text = Text {
            text: secret.into(),
        };
        let rendered = format!("{text:?}");
        assert!(
            !rendered.contains(secret),
            "Debug leaked the text: {rendered}"
        );
        assert!(rendered.contains("redacted"));

        let key = Key {
            code: 0x41,
            modifiers: Modifiers {
                shift: true,
                ..Default::default()
            },
        };
        let rendered = format!("{key:?}");
        assert!(!rendered.contains("65") && !rendered.contains("0x41"));
        assert!(rendered.contains("redacted"));

        // ...and through the enclosing message, which is what actually gets logged.
        let msg = ControlMessage::KeyText {
            seq: 1,
            text: Text {
                text: secret.into(),
            },
        };
        assert!(!format!("{msg:?}").contains(secret));
    }

    #[test]
    fn rejection_details_never_echo_the_frame() {
        // Rejection details are logged. If they quoted the frame, a hostile
        // viewer could write arbitrary text into our logs - and a mistyped
        // password could land there too.
        let g = armed();
        let mut s = ControlStream::new();
        let marker = "INJECTED-LOG-LINE";
        for json in [
            format!(r#"{{"type":"{marker}","seq":1}}"#),
            format!(r#"{{"type":"key_text","seq":1,"text":"hi","{marker}":1}}"#),
            format!(r#"{{"type":"key_text","seq":1,"text":{{"nested":"{marker}"}}}}"#),
        ] {
            let err = s.accept(json.as_bytes(), &g, Instant::now()).unwrap_err();
            assert!(
                !err.detail().contains(marker),
                "rejection echoed the frame: {}",
                err.detail()
            );
        }
    }

    #[test]
    fn gate_counts_applied_and_rejected_for_the_audit_trail() {
        let g = armed();
        let mut s = ControlStream::new();
        accept(&mut s, &g, r#"{"type":"control_ping","seq":1}"#).unwrap();
        accept(&mut s, &g, r#"{"type":"control_ping","seq":1}"#).unwrap_err();

        assert_eq!(g.applied(), 1);
        assert_eq!(g.rejected(), 1);
    }

    #[test]
    fn replies_round_trip_over_the_wire() {
        let ack = ControlReply::ControlAck { seq: 9, ack_seq: 4 };
        let json = serde_json::to_string(&ack).unwrap();
        assert!(json.contains(r#""type":"control_ack""#));
        assert_eq!(serde_json::from_str::<ControlReply>(&json).unwrap(), ack);

        let err = ControlReply::ControlError {
            seq: 10,
            code: ErrorCode::RateLimited,
            detail: "message rate exceeded".into(),
        };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains(r#""code":"rate_limited""#));
        assert_eq!(serde_json::from_str::<ControlReply>(&json).unwrap(), err);
    }
}

#[cfg(test)]
mod release_notification_tests {
    use super::ControlGate;
    #[test]
    fn disarm_is_observable_even_when_immediately_rearmed() {
        let gate = ControlGate::new();
        gate.arm();
        let before = gate.disarm_epoch();
        gate.disarm();
        gate.arm();
        assert!(gate.is_armed());
        assert_ne!(gate.disarm_epoch(), before);
    }
}
