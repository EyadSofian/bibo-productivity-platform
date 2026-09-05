//! Metrics and safe structured logging for the sidecar.
//!
//! Two hard rules, enforced here rather than left to callers:
//!
//! 1. **Nothing secret is ever logged.** No publisher token, no signed URL, no
//!    room-join credential. [`redact`] exists so a value that might carry one is
//!    reduced to a shape, never a value.
//! 2. **No screen content is ever logged.** Metrics describe the stream (rate, size,
//!    codec, drops), never what is on it.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Which encoder is actually running.
///
/// This is reported rather than assumed: a machine silently falling back to the
/// software encoder is a support problem we want visible, not a mystery CPU cost.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncoderKind {
    /// Hardware H.264 (NVENC / Quick Sync / AMF).
    Hardware,
    /// Software H.264. Declared explicitly - see the note above.
    Software,
    /// Not yet negotiated.
    Unknown,
}

impl EncoderKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Hardware => "hardware",
            Self::Software => "software",
            Self::Unknown => "unknown",
        }
    }
}

/// Live counters for one publishing session. Cheap enough to update per frame.
#[derive(Debug, Default)]
pub struct Metrics {
    pub frames_captured: AtomicU64,
    pub frames_published: AtomicU64,
    /// Frames dropped because the encoder or transport could not keep up.
    pub frames_dropped: AtomicU64,
    pub capture_errors: AtomicU64,
    pub encoder_errors: AtomicU64,
    pub reconnects: AtomicU32,
    pub width: AtomicU32,
    pub height: AtomicU32,
    /// Millifps (fps * 1000), so the counter stays integral and lock-free.
    pub fps_milli: AtomicU32,
    pub hardware_encoder: AtomicBool,
    pub encoder_resolved: AtomicBool,
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_resolution(&self, w: u32, h: u32) {
        self.width.store(w, Ordering::Relaxed);
        self.height.store(h, Ordering::Relaxed);
    }

    pub fn set_fps(&self, fps: f32) {
        self.fps_milli
            .store((fps * 1000.0) as u32, Ordering::Relaxed);
    }

    pub fn set_encoder(&self, kind: EncoderKind) {
        match kind {
            EncoderKind::Unknown => self.encoder_resolved.store(false, Ordering::Relaxed),
            other => {
                self.hardware_encoder
                    .store(other == EncoderKind::Hardware, Ordering::Relaxed);
                self.encoder_resolved.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn encoder(&self) -> EncoderKind {
        if !self.encoder_resolved.load(Ordering::Relaxed) {
            EncoderKind::Unknown
        } else if self.hardware_encoder.load(Ordering::Relaxed) {
            EncoderKind::Hardware
        } else {
            EncoderKind::Software
        }
    }

    /// Point-in-time snapshot, safe to send over IPC and to the backend.
    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            frames_captured: self.frames_captured.load(Ordering::Relaxed),
            frames_published: self.frames_published.load(Ordering::Relaxed),
            frames_dropped: self.frames_dropped.load(Ordering::Relaxed),
            capture_errors: self.capture_errors.load(Ordering::Relaxed),
            encoder_errors: self.encoder_errors.load(Ordering::Relaxed),
            reconnects: self.reconnects.load(Ordering::Relaxed),
            width: self.width.load(Ordering::Relaxed),
            height: self.height.load(Ordering::Relaxed),
            fps: self.fps_milli.load(Ordering::Relaxed) as f32 / 1000.0,
            encoder: self.encoder(),
        }
    }
}

/// Serialisable metrics. Contains no identifiers, no tokens and no screen content.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetricsSnapshot {
    pub frames_captured: u64,
    pub frames_published: u64,
    pub frames_dropped: u64,
    pub capture_errors: u64,
    pub encoder_errors: u64,
    pub reconnects: u32,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    pub encoder: EncoderKind,
}

/// Reduces a possibly-sensitive string to a non-reversible shape.
///
/// Used for anything that could be a token or signed URL. The output records that a
/// value was present and how long it was - never any of its bytes.
pub fn redact(value: &str) -> String {
    if value.is_empty() {
        return "<empty>".into();
    }
    format!("<redacted:{}chars>", value.len())
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// One structured log line.
#[derive(Serialize)]
struct LogLine<'a> {
    ts_ms: u128,
    level: &'a str,
    event: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metrics: Option<&'a MetricsSnapshot>,
}

/// Emits one JSON log line to stderr.
///
/// stderr, not stdout: stdout is reserved for the IPC framing when the sidecar is
/// run with a pipe, so logs can never corrupt the protocol.
pub fn log(level: &str, event: &str, detail: Option<&str>, metrics: Option<&MetricsSnapshot>) {
    let line = LogLine {
        ts_ms: now_millis(),
        level,
        event,
        detail,
        metrics,
    };
    if let Ok(s) = serde_json::to_string(&line) {
        eprintln!("{s}");
    }
}

pub fn info(event: &str, detail: Option<&str>) {
    log("info", event, detail, None);
}

pub fn warn(event: &str, detail: Option<&str>) {
    log("warn", event, detail, None);
}

pub fn error(event: &str, detail: Option<&str>) {
    log("error", event, detail, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_never_reveals_the_value() {
        let token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret-part";
        let out = redact(token);
        assert!(
            !out.contains("eyJ"),
            "redact leaked the token prefix: {out}"
        );
        assert!(
            !out.contains("secret"),
            "redact leaked token content: {out}"
        );
        assert_eq!(out, format!("<redacted:{}chars>", token.len()));
    }

    #[test]
    fn redact_handles_empty() {
        assert_eq!(redact(""), "<empty>");
    }

    #[test]
    fn encoder_defaults_to_unknown_until_resolved() {
        let m = Metrics::new();
        assert_eq!(m.encoder(), EncoderKind::Unknown);
        m.set_encoder(EncoderKind::Software);
        assert_eq!(m.encoder(), EncoderKind::Software);
        m.set_encoder(EncoderKind::Hardware);
        assert_eq!(m.encoder(), EncoderKind::Hardware);
    }

    #[test]
    fn software_fallback_is_declared_not_hidden() {
        let m = Metrics::new();
        m.set_encoder(EncoderKind::Software);
        let snap = m.snapshot();
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("\"encoder\":\"software\""), "got {json}");
    }

    #[test]
    fn snapshot_carries_no_identifiers_or_content() {
        let m = Metrics::new();
        m.set_resolution(1280, 720);
        m.set_fps(15.0);
        m.frames_captured.fetch_add(10, Ordering::Relaxed);
        let json = serde_json::to_string(&m.snapshot()).unwrap();
        for banned in ["token", "url", "room", "device", "user", "session"] {
            assert!(!json.contains(banned), "metrics leaked {banned}: {json}");
        }
    }

    #[test]
    fn fps_roundtrips_through_the_integer_counter() {
        let m = Metrics::new();
        m.set_fps(14.6);
        assert!((m.snapshot().fps - 14.6).abs() < 0.01);
    }
}
