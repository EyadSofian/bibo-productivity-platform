//! Media supervisor (ticket 148) — the piece that lets an operator actually watch.
//!
//! Responsibilities, and deliberately nothing else:
//!
//! - Poll the backend for a session this device should publish for.
//! - Exchange device identity for a **short-lived publisher token**.
//! - Own the named pipe, spawn the sidecar, and hand it the token.
//! - Relay the sidecar's state and metrics back to the backend so a device-side
//!   failure surfaces to the operator instead of an endless "waiting for agent".
//! - Stop the sidecar the moment the session ends, policy stops it, or the user
//!   logs out.
//!
//! What it does NOT do: capture, encode, or touch WebRTC. That is the sidecar's
//! job, in its own process, so a capture crash cannot take down this app.
//!
//! The IPC types below mirror `apps/desktop/native/media-publisher/src/agent_ipc.rs`.
//! They are duplicated rather than shared because the sidecar is a separate crate
//! with its own workspace; the sidecar's tests pin the wire format.

#[cfg(windows)]
pub mod pipe;
#[cfg(windows)]
mod windows_privacy;

use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::settings::SettingsState;
use crate::sync::auth::AuthState;
use crate::sync::client::BackendClient;

/// How often the agent asks the backend whether it should be publishing.
const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Delay before the first poll so startup is not blocked.
const STARTUP_DELAY: Duration = Duration::from_secs(8);

// ---------- IPC wire types (mirror of the sidecar's agent_ipc) ----------

#[derive(Clone, Serialize)]
pub struct PublishConfig {
    pub url: String,
    pub token: String,
    pub room: String,
    pub monitor: u32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Compatibility field. The integrated publisher always keeps the OS border.
    pub indicator_shown: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Start(PublishConfig),
    Stop {
        reason: String,
    },
    /// Arms or disarms remote control. `false` is the emergency stop (V07).
    SetControl {
        armed: bool,
    },
    Ping {
        seq: u64,
    },
    GetMetrics,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    State {
        state: String,
        #[serde(default)]
        detail: Option<String>,
    },
    Metrics(serde_json::Value),
    Warning {
        code: String,
        detail: String,
    },
    Fatal {
        code: String,
        detail: String,
    },
    Pong {
        seq: u64,
    },
}

// ---------- status surfaced to the UI ----------

/// Live monitoring status. The desktop UI reads this to show the **visible
/// indicator** required by ADR 0002: the person on the device always knows when
/// their screen is being watched.
#[derive(Default)]
pub struct MediaStatus {
    /// True while the sidecar is capturing or publishing.
    pub active: AtomicBool,
    pub stop_requested: AtomicBool,
    /// Current publisher state, in the sidecar's vocabulary.
    pub state: Mutex<String>,
    current_session: Mutex<String>,
    /// Last error, empty when healthy.
    pub last_error: Mutex<String>,
    /// True while an operator is authorised to drive this machine (V07).
    ///
    /// Separate from `active` on purpose: being watched and being *driven* are
    /// different things to the person sitting at the keyboard, and the UI shows
    /// them differently.
    pub controlled: AtomicBool,
}

impl MediaStatus {
    pub fn set_state(&self, state: &str) {
        *self.state.lock().unwrap() = state.to_string();
        // "capturing" and "publishing" are the states where the screen is being read.
        self.active.store(
            matches!(state, "capturing" | "publishing"),
            Ordering::Relaxed,
        );
    }

    pub fn set_error(&self, msg: &str) {
        *self.last_error.lock().unwrap() = msg.to_string();
    }

    pub fn set_controlled(&self, on: bool) {
        self.controlled.store(on, Ordering::Relaxed);
    }

    pub fn is_controlled(&self) -> bool {
        self.controlled.load(Ordering::Relaxed)
    }

    pub fn begin_session(&self, id: &str) {
        let mut current = self.current_session.lock().unwrap();
        *current = id.to_string();
        *self.last_error.lock().unwrap() = String::new();
        self.set_state("starting");
    }

    pub fn set_session_state(&self, id: &str, state: &str) -> bool {
        let current = self.current_session.lock().unwrap();
        if *current != id {
            return false;
        }
        self.set_state(state);
        true
    }

    pub fn set_session_error(&self, id: &str, error: &str) {
        let current = self.current_session.lock().unwrap();
        if *current == id {
            self.set_error(error);
        }
    }

    pub fn clear_session(&self, id: &str) {
        let mut current = self.current_session.lock().unwrap();
        if *current == id {
            current.clear();
            self.reset_status();
        }
    }

    pub fn clear(&self) {
        let mut current = self.current_session.lock().unwrap();
        current.clear();
        self.reset_status();
    }

    fn reset_status(&self) {
        self.active.store(false, Ordering::Relaxed);
        // Nothing is being captured, so nothing can be driven either. Clearing
        // this here means every teardown path turns the control indicator off,
        // without each one having to remember to.
        self.controlled.store(false, Ordering::Relaxed);
        *self.state.lock().unwrap() = "idle".into();
    }
}

/// Everything the supervisor needs.
#[derive(Clone)]
pub struct MediaContext {
    pub auth: Arc<AuthState>,
    pub settings: Arc<SettingsState>,
    pub status: Arc<MediaStatus>,
    pub control: Arc<crate::trackers::TrackerControl>,
}

/// Spawns the supervisor on its own thread. Returns immediately.
///
/// Non-Windows builds are a no-op: the sidecar is Windows-only today.
pub fn start(ctx: MediaContext) {
    #[cfg(windows)]
    {
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    crate::log_warn!("media", "supervisor runtime failed: {e}");
                    return;
                }
            };
            rt.block_on(supervise(ctx));
        });
    }
    #[cfg(not(windows))]
    {
        let _ = ctx;
    }
}

fn capture_allowed(ctx: &MediaContext) -> bool {
    if ctx.status.stop_requested.load(Ordering::Acquire)
        || !ctx.control.category_allowed("screen")
        || !ctx.control.capture_screenshots.load(Ordering::Acquire)
        || ctx.auth.session().is_none()
    {
        return false;
    }
    #[cfg(windows)]
    {
        if !windows_privacy::capture_allowed() {
            return false;
        }
        let Some(window) = crate::platform::active_window() else {
            return false;
        };
        let skip = ctx.control.screenshot_skip_apps.read().unwrap();
        if crate::trackers::should_skip(&window.app_name, &skip) {
            return false;
        }
    }
    true
}

#[cfg(windows)]
async fn supervise(ctx: MediaContext) {
    tokio::time::sleep(STARTUP_DELAY).await;
    let mut active: Option<ActiveSession> = None;
    loop {
        let device_id = ctx.settings.current.lock().unwrap().device_id.clone();
        if !capture_allowed(&ctx) || device_id.is_empty() {
            if let Some(mut s) = active.take() {
                s.stop("local_policy_stop", &ctx);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        let client = BackendClient::new(crate::settings::backend_base_url(), Arc::clone(&ctx.auth));
        let result = {
            let poll = tokio::time::timeout(
                Duration::from_secs(2),
                client.agent_media_session(&device_id),
            );
            tokio::pin!(poll);
            loop {
                tokio::select! {
                    result = &mut poll => break result.unwrap_or_else(|_| Err("media authorization timed out".into())),
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {
                        if !capture_allowed(&ctx) {
                            if let Some(mut s) = active.take() { s.stop("local_policy_stop", &ctx); }
                            break Ok(None);
                        }
                    }
                }
            }
        };
        match result {
            Ok(Some(sess)) if capture_allowed(&ctx) => {
                let same = active
                    .as_ref()
                    .is_some_and(|s| s.session_id == sess.session_id);
                if !same {
                    if let Some(mut old) = active.take() {
                        old.stop("superseded", &ctx);
                    }
                    match start_session(&client, &ctx, &device_id, &sess.session_id).await {
                        Ok(s) => active = Some(s),
                        Err(_) => {
                            ctx.status.set_error("publisher_start_failed");
                            let _ = tokio::time::timeout(
                                Duration::from_secs(2),
                                client.report_media_agent_state(
                                    &sess.session_id,
                                    "capture_failed",
                                    "",
                                    None,
                                ),
                            )
                            .await;
                        }
                    }
                } else if active.as_mut().is_some_and(|s| s.exited()) {
                    active = None;
                    ctx.status.clear();
                }
            }
            // Authorization uncertainty is a stop, never permission to continue.
            _ => {
                if let Some(mut s) = active.take() {
                    s.stop("authorization_unavailable", &ctx);
                }
            }
        }
        // Local stop/privacy changes remain responsive between server polls.
        let until = std::time::Instant::now() + POLL_INTERVAL;
        while std::time::Instant::now() < until {
            if !capture_allowed(&ctx) {
                if let Some(mut s) = active.take() {
                    s.stop("local_policy_stop", &ctx);
                }
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

/// A running sidecar for one session.
#[cfg(windows)]
struct ActiveSession {
    session_id: String,
    child: std::process::Child,
    writer: std::fs::File,
    /// What we last told the sidecar about remote control. Tracked so a change
    /// is sent once rather than on every five-second poll.
    control_armed: bool,
    // Held so the pipe stays open for the lifetime of the session.
    _server: pipe::PipeServer,
}

#[cfg(windows)]
impl ActiveSession {
    fn exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)) | Err(_))
    }

    /// Arms or disarms remote control on the sidecar.
    ///
    /// Returns false if the command could not be written, in which case the
    /// caller must NOT record the new state - retrying on the next poll is the
    /// right behaviour, especially for a disarm that failed to send.
    fn set_control(&mut self, armed: bool) -> bool {
        let cmd = Command::SetControl { armed };
        let Ok(mut line) = serde_json::to_vec(&cmd) else {
            return false;
        };
        line.push(b'\n');
        self.writer.write_all(&line).is_ok() && self.writer.flush().is_ok()
    }

    /// Stops the sidecar: ask politely, then make sure.
    fn stop(&mut self, reason: &str, ctx: &MediaContext) {
        // Disarm before stopping. If the process lingers for any reason, it must
        // not still be accepting input while it winds down.
        if self.control_armed {
            let _ = self.set_control(false);
            self.control_armed = false;
        }
        let cmd = Command::Stop {
            reason: reason.to_string(),
        };
        if let Ok(mut line) = serde_json::to_vec(&cmd) {
            line.push(b'\n');
            let _ = self.writer.write_all(&line);
            let _ = self.writer.flush();
        }
        // Emergency stop has a 500ms budget; do not wait longer than that for a
        // graceful exit before killing the process.
        let deadline = std::time::Instant::now() + Duration::from_millis(400);
        while std::time::Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        ctx.status.clear();
        crate::log_info!("media", "publisher stopped: {reason}");
    }
}

/// Resolves the sidecar executable.
///
/// Order: explicit override, then next to this executable (how it ships), then the
/// dev build output. Returning an error rather than guessing means a missing sidecar
/// is a clear message, not a silent no-op.
#[cfg(windows)]
fn sidecar_path() -> Result<std::path::PathBuf, String> {
    if let Ok(p) = std::env::var("CTRACKING_MEDIA_PUBLISHER") {
        let p = std::path::PathBuf::from(p);
        if p.exists() {
            return Ok(p);
        }
        return Err(format!(
            "CTRACKING_MEDIA_PUBLISHER points at a missing file: {}",
            p.display()
        ));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Tauri's externalBin installs the sidecar next to the app executable.
            // It normally strips the target triple, but accept the suffixed name too
            // so a change in Tauri's naming does not silently disable live view.
            for name in [
                "media-publisher.exe",
                "media-publisher-x86_64-pc-windows-msvc.exe",
            ] {
                let p = dir.join(name);
                if p.exists() {
                    return Ok(p);
                }
            }
        }
    }
    Err("media-publisher.exe not found next to the app; set CTRACKING_MEDIA_PUBLISHER".into())
}

#[cfg(windows)]
async fn start_session(
    client: &BackendClient,
    ctx: &MediaContext,
    device_id: &str,
    session_id: &str,
) -> Result<ActiveSession, String> {
    let exe = sidecar_path()?;

    // Token first: if the backend refuses, nothing has touched the screen.
    let creds = tokio::time::timeout(
        Duration::from_secs(2),
        client.media_publisher_token(session_id, device_id),
    )
    .await
    .map_err(|_| "publisher authorization timed out")??;
    if !capture_allowed(ctx) {
        return Err("local policy stopped capture".into());
    }

    let name = pipe::pipe_name(session_id);
    let mut server = pipe::PipeServer::create(&name)?;

    let mut child = std::process::Command::new(&exe)
        .arg("--pipe")
        .arg(&name)
        .spawn()
        .map_err(|e| format!("spawn sidecar: {e}"))?;

    // The sidecar connects immediately; if it cannot, do not leave it running.
    if let Err(e) = server.wait_for_client_while(Duration::from_secs(5), || {
        capture_allowed(ctx) && matches!(child.try_wait(), Ok(None))
    }) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }

    let (reader, mut writer) = match server.split() {
        Ok(x) => x,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };

    if !capture_allowed(ctx) {
        let _ = child.kill();
        let _ = child.wait();
        return Err("local policy stopped capture".into());
    }

    let cfg = PublishConfig {
        url: creds.url,
        token: creds.token,
        room: creds.room,
        monitor: 0,
        width: 1280,
        height: 720,
        fps: 15,
        indicator_shown: false,
    };
    let mut line = serde_json::to_vec(&Command::Start(cfg)).map_err(|e| e.to_string())?;
    line.push(b'\n');
    let sent = writer.write_all(&line).and_then(|_| writer.flush());

    // The token is now the sidecar's problem; drop our copy of the line buffer so it
    // does not linger in this process's memory any longer than necessary.
    line.iter_mut().for_each(|b| *b = 0);
    if let Err(e) = sent {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("send start: {e}"));
    }

    ctx.status.begin_session(session_id);
    spawn_event_reader(reader, ctx.clone(), client.clone(), session_id.to_string());
    crate::log_info!("media", "publisher started for session {session_id}");

    Ok(ActiveSession {
        session_id: session_id.to_string(),
        child,
        writer,
        // Remote input remains disabled in this live-video integration.
        control_armed: false,
        _server: server,
    })
}

/// Reads sidecar events and relays them to status + backend.
#[cfg(windows)]
fn spawn_event_reader(
    reader: std::fs::File,
    ctx: MediaContext,
    client: BackendClient,
    session_id: String,
) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(_) => return,
        };
        let mut lines = BufReader::new(reader).lines();
        while let Some(Ok(line)) = lines.next() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let ev: Event = match serde_json::from_str(line) {
                Ok(e) => e,
                Err(_) => continue,
            };
            match ev {
                Event::State { state, detail } => {
                    if !ctx.status.set_session_state(&session_id, &state) {
                        break;
                    }
                    let d = detail.unwrap_or_default();
                    rt.block_on(async {
                        let _ = client
                            .report_media_agent_state(&session_id, &state, &d, None)
                            .await;
                    });
                }
                Event::Metrics(m) => {
                    rt.block_on(async {
                        let _ = client
                            .report_media_agent_state(&session_id, "metrics", "", Some(m))
                            .await;
                    });
                }
                Event::Warning { code, detail } => {
                    crate::log_warn!("media", "sidecar warning {code}: {detail}");
                }
                Event::Fatal { code, detail } => {
                    ctx.status.set_session_error(&session_id, &code);
                    if !ctx.status.set_session_state(&session_id, &code) {
                        break;
                    }
                    rt.block_on(async {
                        let _ = client
                            .report_media_agent_state(&session_id, &code, &detail, None)
                            .await;
                    });
                    break;
                }
                Event::Pong { .. } => {}
            }
        }
        ctx.status.clear_session(&session_id);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_command_serialises_to_the_sidecar_wire_format() {
        let cmd = Command::Start(PublishConfig {
            url: "wss://x".into(),
            token: "t".into(),
            room: "biz-a--session-1".into(),
            monitor: 0,
            width: 1280,
            height: 720,
            fps: 15,
            indicator_shown: false,
        });
        let s = serde_json::to_string(&cmd).unwrap();
        assert!(s.contains("\"cmd\":\"start\""), "got {s}");
        assert!(s.contains("\"fps\":15"), "got {s}");
        // Never assert that a potentially hidden app window is a visible indicator.
        assert!(s.contains("\"indicator_shown\":false"), "got {s}");
    }

    #[test]
    fn an_old_reader_cannot_clear_a_new_session_indicator() {
        let s = MediaStatus::default();
        s.begin_session("old");
        s.begin_session("new");
        assert!(s.set_session_state("new", "publishing"));
        assert!(!s.set_session_state("old", "stopped"));
        s.clear_session("old");
        assert!(s.active.load(Ordering::Relaxed));
        s.clear_session("new");
        assert!(!s.active.load(Ordering::Relaxed));
    }

    #[test]
    fn stop_command_carries_a_reason() {
        let s = serde_json::to_string(&Command::Stop {
            reason: "policy_stop".into(),
        })
        .unwrap();
        assert!(s.contains("\"cmd\":\"stop\""), "got {s}");
        assert!(s.contains("policy_stop"), "got {s}");
    }

    #[test]
    fn events_from_the_sidecar_parse() {
        let ev: Event = serde_json::from_str(r#"{"event":"state","state":"publishing"}"#).unwrap();
        match ev {
            Event::State { state, .. } => assert_eq!(state, "publishing"),
            other => panic!("expected state, got {other:?}"),
        }
        let ev: Event =
            serde_json::from_str(r#"{"event":"fatal","code":"capture_failed","detail":"x"}"#)
                .unwrap();
        assert!(matches!(ev, Event::Fatal { .. }));
    }

    /// The indicator must be on exactly while the screen is being read.
    #[test]
    fn status_active_tracks_capture_states() {
        let s = MediaStatus::default();
        for (state, expected) in [
            ("idle", false),
            ("starting", false),
            ("capturing", true),
            ("publishing", true),
            ("reconnecting", false),
            ("stopped", false),
            ("capture_failed", false),
        ] {
            s.set_state(state);
            assert_eq!(
                s.active.load(Ordering::Relaxed),
                expected,
                "state {state} should set active={expected}"
            );
        }
    }

    /// End-to-end agent -> sidecar handshake over the real named pipe.
    ///
    /// This is the proof that supervision actually works: the agent creates the
    /// pipe, spawns the real sidecar binary, hands it a Start command, and the
    /// sidecar reports back through to `publishing`.
    ///
    /// Skipped unless the sidecar binary and a LiveKit dev server are available:
    ///
    /// ```text
    /// livekit-server --dev --bind 127.0.0.1
    /// set CTRACKING_MEDIA_PUBLISHER=C:\lkb\debug\media-publisher.exe
    /// set LIVEKIT_TEST_URL=ws://127.0.0.1:7880
    /// set LIVEKIT_TEST_TOKEN=<publish token for the room below>
    /// cargo test media::tests::agent_drives_sidecar -- --nocapture --ignored
    /// ```
    #[cfg(windows)]
    #[test]
    #[ignore = "needs the sidecar binary and a live SFU; run explicitly"]
    fn agent_drives_sidecar_to_publishing() {
        let Ok(exe) = std::env::var("CTRACKING_MEDIA_PUBLISHER") else {
            eprintln!("CTRACKING_MEDIA_PUBLISHER not set; skipping");
            return;
        };
        let url = std::env::var("LIVEKIT_TEST_URL").unwrap_or_default();
        let token = std::env::var("LIVEKIT_TEST_TOKEN").unwrap_or_default();
        if url.is_empty() || token.is_empty() {
            eprintln!("LIVEKIT_TEST_URL / LIVEKIT_TEST_TOKEN not set; skipping");
            return;
        }

        let session = format!("agenttest-{}", std::process::id());
        let name = pipe::pipe_name(&session);
        let mut server = pipe::PipeServer::create(&name).expect("create pipe");

        let mut child = std::process::Command::new(&exe)
            .arg("--pipe")
            .arg(&name)
            .spawn()
            .expect("spawn sidecar");

        server
            .wait_for_client()
            .expect("sidecar should connect to the pipe");
        let (reader, mut writer) = server.split().expect("split pipe");

        let cfg = PublishConfig {
            url,
            token,
            room: "biz-itest--session-agent".into(),
            monitor: 0,
            width: 1280,
            height: 720,
            fps: 15,
            indicator_shown: false,
        };
        let mut line = serde_json::to_vec(&Command::Start(cfg)).unwrap();
        line.push(b'\n');
        writer.write_all(&line).expect("send start");
        writer.flush().unwrap();

        // Walk the state machine until publishing (or give up).
        let mut seen: Vec<String> = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(25);
        let mut lines = BufReader::new(reader).lines();
        while std::time::Instant::now() < deadline {
            let Some(Ok(l)) = lines.next() else { break };
            let l = l.trim().to_string();
            if l.is_empty() {
                continue;
            }
            if let Ok(ev) = serde_json::from_str::<Event>(&l) {
                match ev {
                    Event::State { state, .. } => {
                        eprintln!("sidecar state: {state}");
                        seen.push(state.clone());
                        if state == "publishing" || state == "capturing" {
                            break;
                        }
                    }
                    Event::Fatal { code, detail } => {
                        let _ = child.kill();
                        panic!("sidecar fatal {code}: {detail}");
                    }
                    _ => {}
                }
            }
        }

        let mut stop = serde_json::to_vec(&Command::Stop {
            reason: "test_done".into(),
        })
        .unwrap();
        stop.push(b'\n');
        let _ = writer.write_all(&stop);
        let _ = writer.flush();
        std::thread::sleep(Duration::from_millis(500));
        let _ = child.kill();

        assert!(
            seen.iter().any(|s| s == "publishing" || s == "capturing"),
            "sidecar never reached publishing/capturing; saw {seen:?}"
        );
    }

    #[test]
    fn set_control_serialises_to_the_sidecar_wire_format() {
        let on = serde_json::to_string(&Command::SetControl { armed: true }).unwrap();
        assert!(on.contains(r#""cmd":"set_control""#), "got {on}");
        assert!(on.contains(r#""armed":true"#), "got {on}");

        let off = serde_json::to_string(&Command::SetControl { armed: false }).unwrap();
        assert!(off.contains(r#""armed":false"#), "got {off}");
    }

    /// An older backend, or any response missing the field, must read as "not
    /// armed". Defaulting the other way would hand out control on a parse quirk.
    #[test]
    fn a_session_without_the_control_flag_is_not_armed() {
        let s: crate::sync::client::AgentSession =
            serde_json::from_str(r#"{"session_id":"s1","state":"live","room":"r"}"#).unwrap();
        assert!(!s.control_armed);

        let s: crate::sync::client::AgentSession = serde_json::from_str(
            r#"{"session_id":"s1","state":"live","room":"r","control_armed":true}"#,
        )
        .unwrap();
        assert!(s.control_armed);
    }

    /// Being watched and being driven are different facts for the person at the
    /// keyboard, so they are tracked and shown separately.
    #[test]
    fn control_indicator_is_independent_of_the_capture_indicator() {
        let s = MediaStatus::default();
        s.set_state("publishing");
        assert!(s.active.load(Ordering::Relaxed));
        assert!(!s.is_controlled(), "capturing alone must not imply control");

        s.set_controlled(true);
        assert!(s.is_controlled());

        s.set_controlled(false);
        assert!(
            s.active.load(Ordering::Relaxed),
            "disarming must not stop capture"
        );
    }

    /// Every teardown path must turn the control indicator off, so no route out
    /// of a session can leave it claiming someone is still driving.
    #[test]
    fn clearing_status_also_turns_the_control_indicator_off() {
        let s = MediaStatus::default();
        s.set_state("publishing");
        s.set_controlled(true);
        s.clear();
        assert!(!s.is_controlled());
        assert!(!s.active.load(Ordering::Relaxed));
    }

    #[test]
    fn clearing_status_turns_the_indicator_off() {
        let s = MediaStatus::default();
        s.set_state("publishing");
        assert!(s.active.load(Ordering::Relaxed));
        s.clear();
        assert!(!s.active.load(Ordering::Relaxed));
    }
}
