//! IPC between the Rust agent and this sidecar.
//!
//! **Transport.** A local Windows named pipe, `\\.\pipe\bibotracking-media-<session>`.
//! The *agent* creates the pipe server (and owns its ACL, restricted to the current
//! user); the sidecar connects as a client. That way the sidecar never has to secure
//! a name in the pipe namespace, and a stale sidecar cannot squat the name a future
//! agent expects.
//!
//! **Framing.** Newline-delimited JSON, one message per line. Every message is a
//! tagged enum, so the wire format is self-describing and an unknown variant is a
//! clean error rather than a silent misparse.
//!
//! **Direction.** [`Command`] is agent → sidecar. [`Event`] is sidecar → agent.
//!
//! **What must never cross this pipe:** anything but the fields declared below. In
//! particular the sidecar never receives an API secret - only a short-lived publisher
//! token minted by the backend - and never sends screen content or a token back.

use std::io::{BufRead, BufReader, Read, Write};

use serde::{Deserialize, Serialize};

use crate::metrics::MetricsSnapshot;

/// Default pipe name for a session. The session id keeps concurrent agents apart.
pub fn pipe_name(session_id: &str) -> String {
    format!(r"\\.\pipe\bibotracking-media-{session_id}")
}

/// Capture and publish parameters chosen by the agent from org policy.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct PublishConfig {
    /// LiveKit room URL (`wss://...`). Not a secret.
    pub url: String,
    /// Short-lived publisher token minted by the backend.
    ///
    /// The sidecar holds this in memory only: it is never logged, never written to
    /// disk, and never echoed back over the pipe.
    pub token: String,
    /// Opaque room name, scoped to the authorized session by the backend.
    pub room: String,
    /// Monitor index to capture; 0 is primary.
    #[serde(default)]
    pub monitor: u32,
    /// Target long-edge width in pixels.
    #[serde(default = "default_width")]
    pub width: u32,
    /// Target height in pixels.
    #[serde(default = "default_height")]
    pub height: u32,
    /// Target capture rate. WGC rate-limits at the source (ADR 0003).
    #[serde(default = "default_fps")]
    pub fps: u32,
    /// Compatibility field; the integrated capture path always draws the OS border.
    #[serde(default)]
    pub indicator_shown: bool,
}

impl std::fmt::Debug for PublishConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PublishConfig")
            .field("token", &"<redacted>")
            .field("monitor", &self.monitor)
            .field("width", &self.width)
            .field("height", &self.height)
            .field("fps", &self.fps)
            .finish_non_exhaustive()
    }
}

const fn default_width() -> u32 {
    1280
}
const fn default_height() -> u32 {
    720
}
const fn default_fps() -> u32 {
    15
}

/// Agent → sidecar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    /// Begin capturing and publishing.
    Start(PublishConfig),
    /// Stop immediately. Used for session end, policy stop and emergency stop, so it
    /// must take effect without waiting for the current frame to finish publishing.
    Stop { reason: String },
    /// Arms or disarms remote control (V07).
    ///
    /// `armed: false` is the **emergency stop**. It must take effect on the very
    /// next control message, so the sidecar flips an atomic rather than tearing
    /// anything down, and releases whatever keys and buttons it is holding.
    ///
    /// The agent only ever sends `armed: true` after the backend has authorised
    /// the operator and written the audit record; the sidecar does not talk to
    /// the backend and cannot make this decision itself.
    SetControl { armed: bool },
    /// Liveness probe; answered with [`Event::Pong`].
    Ping { seq: u64 },
    /// Ask for a metrics sample now rather than waiting for the next tick.
    GetMetrics,
}

/// Lifecycle state of the publisher. Mirrors the states the web player renders, so
/// an operator sees the same vocabulary the agent reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublisherState {
    Idle,
    Starting,
    Capturing,
    Publishing,
    Reconnecting,
    Stopped,
    CaptureFailed,
    EncoderFailed,
    ConnectionFailed,
}

/// Sidecar → agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    /// State transition. `detail` is a short typed reason, never screen content.
    State {
        state: PublisherState,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// Periodic metrics sample.
    Metrics(MetricsSnapshot),
    /// A non-fatal problem worth surfacing.
    Warning {
        code: String,
        detail: String,
    },
    /// A fatal problem; the sidecar exits after sending this.
    Fatal {
        code: String,
        detail: String,
    },
    Pong {
        seq: u64,
    },
}

/// Errors from the IPC layer.
#[derive(Debug)]
pub enum IpcError {
    Io(std::io::Error),
    Decode(serde_json::Error),
    /// The peer closed the pipe.
    Closed,
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "ipc io: {e}"),
            Self::Decode(e) => write!(f, "ipc decode: {e}"),
            Self::Closed => write!(f, "ipc closed by peer"),
        }
    }
}

impl std::error::Error for IpcError {}

impl From<std::io::Error> for IpcError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// Writes one [`Event`] as a single newline-terminated JSON line.
pub fn write_event<W: Write>(w: &mut W, ev: &Event) -> Result<(), IpcError> {
    let mut line = serde_json::to_vec(ev).map_err(IpcError::Decode)?;
    line.push(b'\n');
    w.write_all(&line)?;
    // Flush per message: the agent's state machine must not wait on a buffer.
    w.flush()?;
    Ok(())
}

/// Writes one [`Command`] as a single newline-terminated JSON line.
pub fn write_command<W: Write>(w: &mut W, cmd: &Command) -> Result<(), IpcError> {
    let mut line = serde_json::to_vec(cmd).map_err(IpcError::Decode)?;
    line.push(b'\n');
    w.write_all(&line)?;
    w.flush()?;
    Ok(())
}

/// Reads newline-delimited [`Command`]s from the agent.
pub struct CommandReader<R: Read> {
    inner: BufReader<R>,
    buf: String,
}

impl<R: Read> CommandReader<R> {
    pub fn new(r: R) -> Self {
        Self {
            inner: BufReader::new(r),
            buf: String::new(),
        }
    }

    /// Blocks for the next command. Returns [`IpcError::Closed`] at end of pipe.
    pub fn next(&mut self) -> Result<Command, IpcError> {
        loop {
            self.buf.clear();
            let n = self.inner.read_line(&mut self.buf)?;
            if n == 0 {
                return Err(IpcError::Closed);
            }
            let line = self.buf.trim();
            // Tolerate keepalive blank lines rather than treating them as errors.
            if line.is_empty() {
                continue;
            }
            return serde_json::from_str(line).map_err(IpcError::Decode);
        }
    }
}

/// Reads newline-delimited [`Event`]s from the sidecar. Used by the agent and tests.
pub struct EventReader<R: Read> {
    inner: BufReader<R>,
    buf: String,
}

impl<R: Read> EventReader<R> {
    pub fn new(r: R) -> Self {
        Self {
            inner: BufReader::new(r),
            buf: String::new(),
        }
    }

    pub fn next(&mut self) -> Result<Event, IpcError> {
        loop {
            self.buf.clear();
            let n = self.inner.read_line(&mut self.buf)?;
            if n == 0 {
                return Err(IpcError::Closed);
            }
            let line = self.buf.trim();
            if line.is_empty() {
                continue;
            }
            return serde_json::from_str(line).map_err(IpcError::Decode);
        }
    }
}

/// Connects to the agent's named pipe.
///
/// The agent creates the server before spawning us, so a failure here means the agent
/// is gone or the name is wrong - both fatal, and both better surfaced immediately
/// than retried silently.
#[cfg(windows)]
pub fn connect_pipe(name: &str) -> std::io::Result<std::fs::File> {
    use std::fs::OpenOptions;
    OpenOptions::new().read(true).write(true).open(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::{EncoderKind, Metrics};

    /// A Start command that says nothing about the indicator must NOT be read as
    /// permission to hide the OS capture border. Capture becoming quieter through
    /// a missing field is exactly the failure this default exists to prevent.
    #[test]
    fn a_start_without_the_indicator_flag_keeps_the_os_capture_border() {
        let cfg: PublishConfig =
            serde_json::from_str(r#"{"url":"wss://x","token":"t","room":"r"}"#).unwrap();
        assert!(
            !cfg.indicator_shown,
            "missing indicator_shown must default to false, i.e. keep the border"
        );
    }

    #[test]
    fn set_control_roundtrips_and_names_the_emergency_stop_explicitly() {
        // The agent's only way to arm or emergency-stop remote control. It must
        // survive the wire exactly, because a dropped `armed: false` would leave
        // an operator in control of someone's machine after being told to stop.
        for armed in [true, false] {
            let cmd = Command::SetControl { armed };
            let mut buf = Vec::new();
            write_command(&mut buf, &cmd).unwrap();

            let line = String::from_utf8(buf.clone()).unwrap();
            assert!(
                line.contains(r#""cmd":"set_control""#),
                "wire form changed: {line}"
            );

            let mut r = CommandReader::new(std::io::Cursor::new(buf));
            assert_eq!(r.next().unwrap(), cmd);
        }
    }

    #[test]
    fn command_roundtrip_start() {
        let cfg = PublishConfig {
            url: "wss://sfu.example".into(),
            token: "tok".into(),
            room: "biz-a--session-1".into(),
            monitor: 0,
            width: 1280,
            height: 720,
            fps: 15,
            indicator_shown: true,
        };
        let cmd = Command::Start(cfg.clone());
        let mut out = Vec::new();
        write_command(&mut out, &cmd).unwrap();
        assert!(out.ends_with(b"\n"), "messages must be newline framed");

        let mut r = CommandReader::new(&out[..]);
        assert_eq!(r.next().unwrap(), cmd);
    }

    #[test]
    fn publish_config_defaults_match_the_shipping_profile() {
        // Only the fields the agent must always supply are required; the capture
        // profile defaults to the ADR 0003 shipping configuration.
        let json = r#"{"cmd":"start","url":"wss://x","token":"t","room":"r"}"#;
        let cmd: Command = serde_json::from_str(json).unwrap();
        match cmd {
            Command::Start(c) => {
                assert_eq!((c.width, c.height, c.fps, c.monitor), (1280, 720, 15, 0));
            }
            other => panic!("expected Start, got {other:?}"),
        }
    }

    #[test]
    fn multiple_messages_are_framed_independently() {
        let mut out = Vec::new();
        write_command(&mut out, &Command::Ping { seq: 1 }).unwrap();
        write_command(&mut out, &Command::GetMetrics).unwrap();
        write_command(
            &mut out,
            &Command::Stop {
                reason: "policy_stop".into(),
            },
        )
        .unwrap();

        let mut r = CommandReader::new(&out[..]);
        assert_eq!(r.next().unwrap(), Command::Ping { seq: 1 });
        assert_eq!(r.next().unwrap(), Command::GetMetrics);
        assert_eq!(
            r.next().unwrap(),
            Command::Stop {
                reason: "policy_stop".into()
            }
        );
        assert!(matches!(r.next(), Err(IpcError::Closed)));
    }

    #[test]
    fn event_roundtrip_and_state_vocabulary() {
        let ev = Event::State {
            state: PublisherState::Publishing,
            detail: None,
        };
        let mut out = Vec::new();
        write_event(&mut out, &ev).unwrap();
        let s = String::from_utf8(out.clone()).unwrap();
        assert!(s.contains("\"state\":\"publishing\""), "got {s}");

        let mut r = EventReader::new(&out[..]);
        assert_eq!(r.next().unwrap(), ev);
    }

    #[test]
    fn metrics_event_reports_the_encoder_in_use() {
        let m = Metrics::new();
        m.set_encoder(EncoderKind::Software);
        m.set_resolution(1280, 720);
        let mut out = Vec::new();
        write_event(&mut out, &Event::Metrics(m.snapshot())).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("\"encoder\":\"software\""), "got {s}");
    }

    /// The token travels agent -> sidecar and must never come back the other way.
    #[test]
    fn no_event_variant_can_carry_a_token() {
        let events = vec![
            Event::State {
                state: PublisherState::Capturing,
                detail: Some("monitor 0".into()),
            },
            Event::Warning {
                code: "encoder_fallback".into(),
                detail: "hardware unavailable".into(),
            },
            Event::Fatal {
                code: "capture_failed".into(),
                detail: "device lost".into(),
            },
            Event::Pong { seq: 7 },
            Event::Metrics(Metrics::new().snapshot()),
        ];
        for ev in events {
            let s = serde_json::to_string(&ev).unwrap();
            assert!(!s.contains("token"), "event exposes a token field: {s}");
            assert!(!s.contains("wss://"), "event exposes a URL: {s}");
        }
    }

    #[test]
    fn blank_lines_are_ignored_not_fatal() {
        let mut out = Vec::new();
        out.extend_from_slice(b"\n\n");
        write_command(&mut out, &Command::GetMetrics).unwrap();
        let mut r = CommandReader::new(&out[..]);
        assert_eq!(r.next().unwrap(), Command::GetMetrics);
    }

    #[test]
    fn malformed_line_is_a_decode_error_not_a_panic() {
        let data = b"{not json}\n";
        let mut r = CommandReader::new(&data[..]);
        assert!(matches!(r.next(), Err(IpcError::Decode(_))));
    }

    #[test]
    fn pipe_name_is_session_scoped() {
        let a = pipe_name("session-a");
        let b = pipe_name("session-b");
        assert_ne!(a, b, "two sessions must not share a pipe");
        assert!(a.starts_with(r"\\.\pipe\"), "got {a}");
    }
}

#[cfg(test)]
mod credential_debug_tests {
    use super::*;
    #[test]
    fn start_command_debug_does_not_expose_credentials() {
        let cmd: Command = serde_json::from_str(r#"{"cmd":"start","url":"wss://private-host","token":"secret-publisher-token","room":"private-room"}"#).unwrap();
        let debug = format!("{cmd:?}");
        assert!(!debug.contains("secret-publisher-token"));
        assert!(!debug.contains("private-host"));
        assert!(!debug.contains("private-room"));
        assert!(debug.contains("redacted"));
    }
}
