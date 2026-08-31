//! Agent push channel.
//!
//! The agent used to learn that an owner had asked for a live frame only on its
//! next presence heartbeat, up to 15 seconds later. That wait was the dominant
//! term in the measured 9s-average / 19s-worst time to first frame
//! (docs/FULL_SYSTEM_AUDIT.md §3.4, P0-1).
//!
//! This module holds one long-lived Server-Sent Events connection to the backend
//! and turns pushed commands into local signals. It is strictly an accelerator:
//! every command has a polling path behind it that still works on its own, so an
//! agent that cannot hold this connection open (blocked proxy, flaky link)
//! behaves exactly as it did before -- only slower. Nothing here is a source of
//! truth, and nothing here authorizes capture.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tokio::sync::Notify;

use super::client::BackendClient;
use super::worker::SyncContext;

/// Longest a single connection attempt may take to produce response headers.
/// The stream itself is unbounded, so this client cannot reuse the shared
/// 30-second-timeout client.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const RETRY_MIN: Duration = Duration::from_secs(1);
/// Poll while logged out or before the device id exists. Deliberately separate
/// from the failure backoff: waiting to sign in is not an error.
const NOT_READY_POLL: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(30);
/// Guards against a server that streams without ever framing an event.
const MAX_SSE_BUFFER: usize = 64 * 1024;

/// Signals the push channel raises for the other workers to act on.
#[derive(Default)]
pub struct PushSignals {
    /// An owner asked for one live frame; the presence loop should heartbeat now
    /// rather than at the end of its interval.
    pub capture_now: Notify,
    /// A remote-assistance session is awaiting the employee's decision.
    pub remote_assist: Notify,
    /// Rolling authorization for continuous live-view capture.
    pub live_view: LiveViewSignal,
}

/// A capture authorization that must be continuously renewed to stay valid.
///
/// This is deliberately a deadline rather than an on/off flag. If the push
/// connection drops, the backend restarts, or a renewal is simply lost, the
/// deadline passes and capture stops on its own. A lost message can only ever
/// stop capture early -- never leave it running after the viewer has gone.
#[derive(Default)]
pub struct LiveViewSignal {
    /// Unix milliseconds after which capture is no longer authorized.
    until_ms: AtomicI64,
}

impl LiveViewSignal {
    /// Extends the authorization by `ttl_ms` from now. A non-positive or absurd
    /// TTL is clamped so a malformed server message cannot grant a long window.
    pub fn renew(&self, ttl_ms: i64) {
        let ttl = ttl_ms.clamp(0, MAX_LIVE_VIEW_TTL_MS);
        if ttl == 0 {
            self.clear();
            return;
        }
        self.until_ms.store(now_ms() + ttl, Ordering::Relaxed);
    }

    /// Whether continuous live-view capture is currently authorized.
    pub fn active(&self) -> bool {
        now_ms() < self.until_ms.load(Ordering::Relaxed)
    }

    pub fn clear(&self) {
        self.until_ms.store(0, Ordering::Relaxed);
    }
}

/// Ceiling on any single renewal. The server asks for ~16s; this bounds the
/// damage if that value is ever wrong or tampered with in transit.
const MAX_LIVE_VIEW_TTL_MS: i64 = 60_000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn start(ctx: SyncContext) {
    thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                crate::log_warn!("commands", "runtime build failed: {error}");
                return;
            }
        };
        runtime.block_on(run(ctx));
    });
}

async fn run(ctx: SyncContext) {
    let http = match reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
    {
        Ok(http) => http,
        Err(error) => {
            crate::log_warn!("commands", "client build failed: {error}");
            return;
        }
    };
    let mut backoff = RETRY_MIN;

    loop {
        // Not being logged in yet is not a failure, so it must not grow the
        // backoff -- otherwise signing in could be followed by up to
        // RETRY_MAX of silence before the channel comes up.
        let Some((device_id, base_url)) = connection_target(&ctx) else {
            ctx.push.live_view.clear();
            backoff = RETRY_MIN;
            tokio::time::sleep(NOT_READY_POLL).await;
            continue;
        };

        let outcome = connect_and_read(&ctx, &http, &base_url, &device_id).await;

        // Capture must never outlive the connection that authorized it.
        ctx.push.live_view.clear();

        backoff = match outcome {
            Ok(()) => RETRY_MIN,
            Err(error) => {
                crate::log_warn!("commands", "push channel closed: {error}");
                (backoff * 2).min(RETRY_MAX)
            }
        };
        tokio::time::sleep(backoff).await;
    }
}

fn connection_target(ctx: &SyncContext) -> Option<(String, String)> {
    ctx.auth.session()?;
    let device_id = ctx.settings.current.lock().unwrap().device_id.clone();
    let base_url = crate::settings::backend_base_url();
    if device_id.is_empty() || base_url.is_empty() {
        return None;
    }
    Some((device_id, base_url))
}

/// Holds one SSE connection open, applying commands until it ends. Returns Ok
/// when the connection was established and later closed normally.
async fn connect_and_read(
    ctx: &SyncContext,
    http: &reqwest::Client,
    base_url: &str,
    device_id: &str,
) -> Result<(), String> {
    let mut token = ctx
        .auth
        .session()
        .map(|session| session.access_token)
        .ok_or_else(|| "no access token".to_string())?;
    let url = format!(
        "{}/v1/agent/commands/stream?device_id={device_id}",
        base_url.trim_end_matches('/')
    );

    // This connection outlives the access token that opened it, so a reconnect
    // after the token expires must refresh rather than retry with a stale one --
    // otherwise the channel would stay down until the next login.
    let mut response = http
        .get(&url)
        .bearer_auth(&token)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .send()
        .await
        .map_err(|error| format!("connect failed: {error}"))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let client = BackendClient::new(base_url.to_string(), ctx.auth.clone());
        token = client.refresh().await?;
        response = http
            .get(&url)
            .bearer_auth(&token)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .send()
            .await
            .map_err(|error| format!("connect failed after refresh: {error}"))?;
    }

    if !response.status().is_success() {
        return Err(format!("server refused the stream: {}", response.status()));
    }
    crate::log_info!("commands", "push channel open");

    let mut buffer = String::new();
    // chunk() is the streaming read available without reqwest's "stream"
    // feature, so this needs no new dependency.
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("read failed: {error}"))?
    {
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        for event in drain_events(&mut buffer) {
            apply(ctx, &event);
        }
        if buffer.len() > MAX_SSE_BUFFER {
            return Err("server sent an unframed event larger than the buffer".into());
        }
    }
    Ok(())
}

/// One decoded Server-Sent Event.
#[derive(Debug, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// Pulls every complete event out of `buffer`, leaving any partial trailing
/// record behind. A frame split across chunks is held until it is whole.
pub fn drain_events(buffer: &mut String) -> Vec<SseEvent> {
    // Normalize line endings so a proxy that rewrites them cannot break framing.
    if buffer.contains('\r') {
        *buffer = buffer.replace("\r\n", "\n").replace('\r', "\n");
    }
    let mut events = Vec::new();
    while let Some(boundary) = buffer.find("\n\n") {
        let record: String = buffer.drain(..boundary + 2).collect();
        if let Some(event) = parse_record(&record) {
            events.push(event);
        }
    }
    events
}

fn parse_record(record: &str) -> Option<SseEvent> {
    let mut event = "message".to_string();
    let mut data: Vec<&str> = Vec::new();

    for line in record.split('\n') {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, raw) = match line.split_once(':') {
            Some((field, raw)) => (field, raw),
            None => (line, ""),
        };
        // A single leading space after the colon is framing, not payload.
        let value = raw.strip_prefix(' ').unwrap_or(raw);
        match field {
            "event" => event = value.to_string(),
            "data" => data.push(value),
            _ => {}
        }
    }

    if data.is_empty() {
        return None;
    }
    Some(SseEvent {
        event,
        data: data.join("\n"),
    })
}

#[derive(serde::Deserialize)]
struct CommandPayload {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    expires_in_ms: i64,
}

fn apply(ctx: &SyncContext, event: &SseEvent) {
    if event.event != "command" {
        return; // keepalive pings and anything unknown
    }
    let payload: CommandPayload = match serde_json::from_str(&event.data) {
        Ok(payload) => payload,
        Err(error) => {
            crate::log_warn!("commands", "unreadable command: {error}");
            return;
        }
    };
    match payload.kind.as_str() {
        // notify_one leaves a permit if the worker is mid-pass, so a wake that
        // arrives at a busy moment is applied rather than dropped.
        "capture_now" => ctx.push.capture_now.notify_one(),
        "remote_assist_pending" => ctx.push.remote_assist.notify_one(),
        "live_view_active" => ctx.push.live_view.renew(payload.expires_in_ms),
        other => crate::log_warn!("commands", "ignoring unknown command {other}"),
    }
}

pub fn signals() -> Arc<PushSignals> {
    Arc::new(PushSignals::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(input: &str) -> (Vec<SseEvent>, String) {
        let mut buffer = String::from(input);
        let events = drain_events(&mut buffer);
        (events, buffer)
    }

    #[test]
    fn decodes_a_single_event() {
        let (events, rest) = drain("event: command\ndata: {\"type\":\"capture_now\"}\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "command");
        assert_eq!(events[0].data, "{\"type\":\"capture_now\"}");
        assert!(rest.is_empty());
    }

    #[test]
    fn decodes_several_events_from_one_chunk() {
        let (events, _) = drain("event: ping\ndata: {}\n\nevent: command\ndata: {}\n\n");
        let kinds: Vec<&str> = events.iter().map(|e| e.event.as_str()).collect();
        assert_eq!(kinds, vec!["ping", "command"]);
    }

    /// A record split across TCP chunks must be held until it is whole; acting
    /// on half a payload would mean acting on a command that was never sent.
    #[test]
    fn buffers_a_record_split_across_chunks() {
        let mut buffer = String::new();
        buffer.push_str("event: comm");
        assert!(drain_events(&mut buffer).is_empty());
        buffer.push_str("and\ndata: {\"type\":\"cap");
        assert!(drain_events(&mut buffer).is_empty());
        buffer.push_str("ture_now\"}\n\n");
        let events = drain_events(&mut buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "{\"type\":\"capture_now\"}");
        assert!(buffer.is_empty());
    }

    #[test]
    fn keeps_a_partial_trailing_record() {
        let (events, rest) = drain("event: ping\ndata: {}\n\nevent: comm");
        assert_eq!(events.len(), 1);
        assert_eq!(rest, "event: comm");
    }

    #[test]
    fn normalizes_crlf_line_endings() {
        let (events, _) = drain("event: command\r\ndata: {}\r\n\r\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "command");
    }

    #[test]
    fn ignores_comments_and_unknown_fields() {
        let (events, _) = drain(": keepalive\n\nid: 4\nevent: command\ndata: x\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "x");
    }

    #[test]
    fn strips_exactly_one_leading_space() {
        let (events, _) = drain("event: command\ndata:  padded\n\n");
        assert_eq!(events[0].data, " padded");
    }

    // --- live-view authorization ---

    #[test]
    fn renewal_grants_then_lapses() {
        let signal = LiveViewSignal::default();
        assert!(!signal.active(), "must start unauthorized");

        signal.renew(5_000);
        assert!(signal.active());

        signal.clear();
        assert!(!signal.active(), "clear must revoke immediately");
    }

    /// The window is a deadline, not a flag: a renewal that already expired
    /// grants nothing. This is what makes a lost or delayed message fail closed.
    #[test]
    fn expired_or_empty_renewal_grants_nothing() {
        let signal = LiveViewSignal::default();
        signal.renew(0);
        assert!(!signal.active());
        signal.renew(-1_000);
        assert!(!signal.active());
    }

    /// A malformed or tampered TTL must not buy a long capture window.
    #[test]
    fn renewal_ttl_is_clamped() {
        let signal = LiveViewSignal::default();
        signal.renew(i64::MAX);
        let granted = signal.until_ms.load(Ordering::Relaxed) - now_ms();
        assert!(
            granted <= MAX_LIVE_VIEW_TTL_MS,
            "granted {granted}ms, cap is {MAX_LIVE_VIEW_TTL_MS}ms"
        );
        assert!(signal.active());
    }

    #[test]
    fn short_renewal_expires_on_its_own() {
        let signal = LiveViewSignal::default();
        signal.renew(30);
        assert!(signal.active());
        std::thread::sleep(Duration::from_millis(60));
        assert!(
            !signal.active(),
            "authorization must lapse without a renewal"
        );
    }

    // --- command dispatch ---

    #[test]
    fn command_payload_parses() {
        let payload: CommandPayload =
            serde_json::from_str(r#"{"type":"live_view_active","expires_in_ms":16000}"#).unwrap();
        assert_eq!(payload.kind, "live_view_active");
        assert_eq!(payload.expires_in_ms, 16_000);
    }

    #[test]
    fn command_payload_defaults_missing_expiry() {
        let payload: CommandPayload = serde_json::from_str(r#"{"type":"capture_now"}"#).unwrap();
        assert_eq!(payload.expires_in_ms, 0);
    }
}
