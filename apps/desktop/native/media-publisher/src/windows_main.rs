//! Sidecar entry point.
//!
//! Lifecycle: connect to the agent's pipe, wait for `Start`, capture (and publish),
//! report state and metrics, stop immediately on `Stop` or when the pipe closes.
//!
//! A closed pipe means the agent is gone. That is treated as an implicit stop: the
//! sidecar must never outlive the agent and keep capturing the screen.
//!
//! Usage:
//!   media-publisher --pipe <name>   connect to the agent (normal operation)
//!   media-publisher --selftest      capture locally for a few seconds and report
//!
//! `--selftest` exists so the capture path can be verified on a machine without a
//! backend. It publishes nothing.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use media_publisher::agent_ipc::{
    connect_pipe, write_event, Command, CommandReader, Event, IpcError, PipeCommandSource,
    PublisherState,
};
use media_publisher::capture_session::{self, CaptureConfig, CaptureSession};
use media_publisher::control::ControlGate;
use media_publisher::livekit_publisher::LiveKitPublisher;
use media_publisher::metrics::{self, CaptureIssue, Metrics};

/// How often metrics are pushed to the agent while publishing.
const METRICS_INTERVAL: Duration = Duration::from_secs(2);
/// How often the running capture is checked while waiting for commands.
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);
/// WGC can report ready while the graphics device is still being recreated after
/// Windows resumes. A capture is usable only after it delivers a frame.
const CAPTURE_START_ATTEMPTS: u8 = 3;
const CAPTURE_FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(3);
const CAPTURE_RETRY_DELAY: Duration = Duration::from_millis(750);
/// Recovery rounds (each is up to CAPTURE_START_ATTEMPTS starts) before the
/// sidecar gives up and reports a typed capture failure. Three rounds fit inside
/// the viewer's connection deadline.
const MAX_RECOVERY_ROUNDS: u32 = 3;
/// WGC only delivers frames when the screen changes, so silence is normal on an
/// idle desktop. A silent capture is probed by rebuilding it -- a fresh session
/// always delivers an initial frame -- and the probe interval backs off while
/// the desktop stays idle so a healthy capture is not rebuilt continuously.
const STALL_PROBE_MIN: Duration = Duration::from_secs(15);
const STALL_PROBE_MAX: Duration = Duration::from_secs(120);
/// A health tick that sees this much wall-clock time pass was suspended: the
/// machine slept, and the capture's graphics device did not survive it.
const SUSPEND_GAP: Duration = Duration::from_secs(5);
const DISPLAY_CHECK_INTERVAL: Duration = Duration::from_secs(2);

pub fn run() {
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--version") {
        println!("media-publisher {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    if args.iter().any(|a| a == "--selftest") {
        std::process::exit(selftest());
    }

    let pipe = args
        .windows(2)
        .find(|w| w[0] == "--pipe")
        .map(|w| w[1].clone());

    let Some(pipe) = pipe else {
        metrics::error("bad_arguments", Some("--pipe <name> is required"));
        std::process::exit(2);
    };

    std::process::exit(serve(&pipe));
}

/// Local capture check: no pipe, no publishing, no files written.
fn selftest() -> i32 {
    metrics::info("selftest_start", Some("capturing locally for 3s"));
    let m = Arc::new(Metrics::new());
    let counter = Arc::new(Mutex::new(0u64));
    let seen = Arc::clone(&counter);

    let session = CaptureSession::start(
        CaptureConfig::default(),
        Arc::clone(&m),
        Box::new(move |_frame| {
            if let Ok(mut c) = seen.lock() {
                *c += 1;
            }
        }),
    );

    let mut session = match session {
        Ok(s) => s,
        Err(e) => {
            metrics::error("capture_failed", Some(&e.to_string()));
            return 1;
        }
    };

    let t0 = Instant::now();
    std::thread::sleep(Duration::from_secs(3));
    let elapsed = t0.elapsed().as_secs_f32();
    session.stop();

    let frames = *counter.lock().unwrap_or_else(|e| e.into_inner());
    m.set_fps(frames as f32 / elapsed.max(0.001));
    let snap = m.snapshot();
    metrics::log("info", "selftest_done", None, Some(&snap));

    if frames == 0 {
        metrics::error("no_frames", Some("capture produced no frames"));
        return 1;
    }
    0
}

/// Normal operation: serve the agent over the named pipe.
fn serve(pipe: &str) -> i32 {
    let stream = match connect_pipe(pipe) {
        Ok(s) => s,
        Err(e) => {
            // The agent creates the pipe before spawning us, so this is fatal.
            metrics::error("pipe_connect_failed", Some(&e.to_string()));
            return 3;
        }
    };
    let writer = match stream.try_clone() {
        Ok(w) => Arc::new(Mutex::new(w)),
        Err(e) => {
            metrics::error("pipe_clone_failed", Some(&e.to_string()));
            return 3;
        }
    };

    // Commands are read on their own thread and handed over a channel, so the
    // main thread stays free to supervise the capture between commands.
    let (commands_tx, commands) = mpsc::channel::<Result<Command, IpcError>>();
    std::thread::spawn(move || {
        let mut reader = CommandReader::new(PipeCommandSource::new(stream));
        loop {
            let next = reader.next();
            let finished = next.is_err();
            if commands_tx.send(next).is_err() || finished {
                return;
            }
        }
    });

    let m = Arc::new(Metrics::new());
    let mut live: Option<Live> = None;
    // Starts disarmed. Remote control is never available merely because a
    // session is publishing - the agent must arm it explicitly, and only after
    // the backend has authorised the operator.
    let control_gate = Arc::new(ControlGate::new());

    let emit = |ev: &Event| {
        if let Ok(mut w) = writer.lock() {
            let _ = write_event(&mut *w, ev);
        }
    };
    emit(&Event::State {
        state: PublisherState::Idle,
        detail: None,
    });

    // Metrics ticker. A separate thread so a slow capture callback cannot starve it.
    {
        let writer = Arc::clone(&writer);
        let m = Arc::clone(&m);
        std::thread::spawn(move || loop {
            std::thread::sleep(METRICS_INTERVAL);
            let snap = m.snapshot();
            if let Ok(mut w) = writer.lock() {
                if write_event(&mut *w, &Event::Metrics(snap)).is_err() {
                    return; // pipe gone; the main loop will notice and stop
                }
            } else {
                return;
            }
        });
    }

    loop {
        let command = match commands.recv_timeout(HEALTH_INTERVAL) {
            Ok(command) => command,
            Err(RecvTimeoutError::Timeout) => {
                if let Some(active) = live.as_mut() {
                    match active.check(&m, &emit) {
                        Ok(()) => {}
                        Err(LiveEnd::Capture(issue, detail)) => {
                            drop(live.take());
                            emit(&Event::Fatal {
                                code: "capture_failed".into(),
                                detail: format!("{}: {detail}", issue.as_str()),
                            });
                            return 4;
                        }
                        Err(LiveEnd::RoomDisconnected) => {
                            drop(live.take());
                            // Recoverable: the agent restarts the publisher
                            // with a fresh token instead of failing the session.
                            emit(&Event::Fatal {
                                code: "room_disconnected".into(),
                                detail: "livekit room disconnected".into(),
                            });
                            return 7;
                        }
                    }
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => Err(IpcError::Closed),
        };

        match command {
            Ok(Command::SetControl { armed }) => {
                if armed {
                    control_gate.arm();
                } else {
                    control_gate.disarm();
                }
                // No detail beyond the flag: what was typed is never logged.
                metrics::info(
                    if armed {
                        "control_armed"
                    } else {
                        "control_disarmed"
                    },
                    None,
                );
                emit(&Event::State {
                    state: PublisherState::Publishing,
                    detail: Some(
                        if armed {
                            "control_armed"
                        } else {
                            "control_disarmed"
                        }
                        .to_string(),
                    ),
                });
            }

            Ok(Command::Ping { seq }) => emit(&Event::Pong { seq }),

            Ok(Command::GetMetrics) => emit(&Event::Metrics(m.snapshot())),

            Ok(Command::Start(cfg)) => {
                // The token is never logged: only its shape, via redact().
                metrics::info(
                    "start_requested",
                    Some(&format!(
                        "room_len={} token={} {}x{}@{}",
                        cfg.room.len(),
                        metrics::redact(&cfg.token),
                        cfg.width,
                        cfg.height,
                        cfg.fps
                    )),
                );
                emit(&Event::State {
                    state: PublisherState::Starting,
                    detail: None,
                });
                let requested_at = Instant::now();

                drop(live.take());

                // Connect before capturing: if the SFU refuses us there is no
                // reason to have touched the screen at all.
                let mut publisher = match LiveKitPublisher::connect(
                    &cfg.url,
                    &cfg.token,
                    cfg.width,
                    cfg.height,
                    cfg.fps,
                    Arc::clone(&m),
                ) {
                    Ok(p) => p,
                    Err(e) => {
                        emit(&Event::Fatal {
                            code: "connection_failed".into(),
                            detail: e.to_string(),
                        });
                        return 6;
                    }
                };
                emit(&Event::State {
                    state: PublisherState::Publishing,
                    detail: None,
                });

                // Start the control loop now so the DataChannel is being read
                // from the moment we are in the room. It injects nothing until
                // the gate is armed by a SetControl command.
                if !publisher.start_control(Arc::clone(&control_gate)) {
                    metrics::warn("control_loop_unavailable", Some("events already taken"));
                }

                let mut active = Live::new(
                    CaptureConfig {
                        monitor: cfg.monitor,
                        fps: cfg.fps,
                        indicator_shown: cfg.indicator_shown,
                    },
                    Arc::new(Mutex::new(publisher)),
                    requested_at,
                );
                if let Err((issue, detail)) = active.start_first(&m, &emit) {
                    emit(&Event::Fatal {
                        code: "capture_failed".into(),
                        detail: format!("{}: {detail}", issue.as_str()),
                    });
                    return 4;
                }
                live = Some(active);
            }

            Ok(Command::Stop { reason }) => {
                // Disarm before stopping capture: a session that is ending must
                // not accept one last input on the way out.
                control_gate.disarm();
                drop(live.take());
                emit(&Event::State {
                    state: PublisherState::Stopped,
                    detail: Some(reason),
                });
                return 0;
            }

            // Pipe closed: the agent is gone, so capture must stop too.
            Err(IpcError::Closed) => {
                drop(live.take());
                metrics::warn("agent_disconnected", Some("stopping capture"));
                return 0;
            }

            Err(e) => {
                metrics::error("ipc_error", Some(&e.to_string()));
                drop(live.take());
                return 5;
            }
        }
    }
}

/// A publishing session: the room connection plus a capture that is rebuilt
/// whenever it stops being trustworthy -- after sleep, a display reset, a
/// monitor change, or when frames simply stop -- without tearing down the
/// LiveKit connection the viewer is attached to.
struct Live {
    config: CaptureConfig,
    publisher: Arc<Mutex<LiveKitPublisher>>,
    session: Option<CaptureSession>,
    /// Milliseconds since `epoch` of the last published frame; 0 before any.
    last_frame: Arc<AtomicU64>,
    epoch: Instant,
    requested_at: Instant,
    display: Option<(u32, u32, u32)>,
    next_display_check: Instant,
    last_tick_wall: SystemTime,
    stall_limit: Duration,
    /// Frame-clock value right after the last rebuild, to tell a probe's
    /// initial frame apart from frames produced by real screen activity.
    rebuilt_at_frame: u64,
    recovery_rounds: u32,
    retry_at: Option<Instant>,
    pending_issue: CaptureIssue,
    room_disconnected: Arc<AtomicBool>,
}

/// Why the session cannot continue.
enum LiveEnd {
    Capture(CaptureIssue, String),
    RoomDisconnected,
}

type CaptureFailure = (CaptureIssue, String);

impl Live {
    fn new(
        config: CaptureConfig,
        publisher: Arc<Mutex<LiveKitPublisher>>,
        requested_at: Instant,
    ) -> Self {
        let now = Instant::now();
        let room_disconnected = publisher
            .lock()
            .map(|p| p.disconnect_signal())
            .unwrap_or_else(|_| Arc::new(AtomicBool::new(false)));
        Self {
            room_disconnected,
            config,
            publisher,
            session: None,
            last_frame: Arc::new(AtomicU64::new(0)),
            epoch: now,
            requested_at,
            display: capture_session::display_signature(),
            next_display_check: now + DISPLAY_CHECK_INTERVAL,
            last_tick_wall: SystemTime::now(),
            stall_limit: STALL_PROBE_MIN,
            rebuilt_at_frame: 0,
            recovery_rounds: 0,
            retry_at: None,
            pending_issue: CaptureIssue::None,
        }
    }

    fn frame_clock_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    /// The first capture of a session gets the same bounded recovery as a
    /// rebuild: a machine that just woke up often needs a second attempt.
    fn start_first(
        &mut self,
        m: &Arc<Metrics>,
        emit: &dyn Fn(&Event),
    ) -> Result<(), CaptureFailure> {
        self.rebuild(None, m, emit)?;
        while self.session.is_none() {
            let wait = self.retry_at.map_or(Duration::ZERO, |at| {
                at.saturating_duration_since(Instant::now())
            });
            std::thread::sleep(wait);
            let issue = self.pending_issue;
            self.rebuild(Some(issue), m, emit)?;
        }
        Ok(())
    }

    /// One health tick. Returns an error only when the session cannot continue.
    fn check(&mut self, m: &Arc<Metrics>, emit: &dyn Fn(&Event)) -> Result<(), LiveEnd> {
        if self.room_disconnected.load(Ordering::Acquire) {
            return Err(LiveEnd::RoomDisconnected);
        }
        self.check_capture(m, emit)
            .map_err(|(issue, detail)| LiveEnd::Capture(issue, detail))
    }

    fn check_capture(
        &mut self,
        m: &Arc<Metrics>,
        emit: &dyn Fn(&Event),
    ) -> Result<(), CaptureFailure> {
        let now = Instant::now();
        let wall = SystemTime::now();
        let gap = wall.duration_since(self.last_tick_wall).unwrap_or_default();
        self.last_tick_wall = wall;

        let mut reason = None;
        if gap >= SUSPEND_GAP {
            reason = Some(CaptureIssue::ResumedFromSleep);
        }
        match &self.session {
            None => {
                if self.retry_at.is_some_and(|at| now < at) {
                    return Ok(());
                }
                reason = reason.or(Some(self.pending_issue));
            }
            Some(session) if session.is_finished() => {
                reason = reason.or(Some(CaptureIssue::CaptureClosed));
            }
            Some(_) => {}
        }
        if reason.is_none() && now >= self.next_display_check {
            self.next_display_check = now + DISPLAY_CHECK_INTERVAL;
            // A failed query means the display stack is mid-reset; decide next tick.
            if let Some(current) = capture_session::display_signature() {
                if self.display.is_some_and(|built| built != current) {
                    reason = Some(CaptureIssue::DisplayChanged);
                }
                self.display = Some(current);
            }
        }
        if reason.is_none() {
            let last = self.last_frame.load(Ordering::Acquire);
            if last > self.rebuilt_at_frame + 2_000 {
                // Real screen activity since the last rebuild: the capture is
                // healthy, so go back to probing promptly after a silence.
                self.stall_limit = STALL_PROBE_MIN;
            }
            let silent_for = self.frame_clock_ms().saturating_sub(last);
            if silent_for >= self.stall_limit.as_millis() as u64 {
                reason = Some(CaptureIssue::CaptureStalled);
            }
        }
        match reason {
            Some(issue) => self.rebuild(Some(issue), m, emit),
            None => Ok(()),
        }
    }

    /// Tears the capture down and builds a fresh one. `trigger` is `None` for
    /// the first capture of the session.
    fn rebuild(
        &mut self,
        trigger: Option<CaptureIssue>,
        m: &Arc<Metrics>,
        emit: &dyn Fn(&Event),
    ) -> Result<(), CaptureFailure> {
        if let Some(mut old) = self.session.take() {
            old.stop();
        }
        // A stall probe on an idle desktop is routine and invisible to the
        // viewer; only a real loss of capture is announced as reconnecting.
        let announced = trigger.filter(|issue| *issue != CaptureIssue::CaptureStalled);
        if let Some(issue) = announced {
            metrics::warn("capture_recovering", Some(issue.as_str()));
            m.set_capture_issue(issue);
            emit(&Event::State {
                state: PublisherState::Reconnecting,
                detail: Some(issue.as_str().to_string()),
            });
        }

        match start_capture_with_recovery(
            self.config,
            Arc::clone(m),
            Arc::clone(&self.publisher),
            Arc::clone(&self.last_frame),
            self.epoch,
            self.requested_at,
        ) {
            Ok(session) => {
                self.session = Some(session);
                self.retry_at = None;
                self.recovery_rounds = 0;
                self.rebuilt_at_frame = self.last_frame.load(Ordering::Acquire);
                self.display = capture_session::display_signature().or(self.display);
                self.last_tick_wall = SystemTime::now();
                if announced.is_some() {
                    m.capture_restarts.fetch_add(1, Ordering::Relaxed);
                }
                self.stall_limit = if trigger == Some(CaptureIssue::CaptureStalled) {
                    (self.stall_limit * 2).min(STALL_PROBE_MAX)
                } else {
                    STALL_PROBE_MIN
                };
                if trigger.is_none() || announced.is_some() {
                    emit(&Event::State {
                        state: PublisherState::Capturing,
                        detail: announced.map(|issue| format!("recovered_from_{}", issue.as_str())),
                    });
                }
                Ok(())
            }
            Err((issue, detail)) => {
                self.recovery_rounds += 1;
                // "No first frame" after a known trigger is a symptom; the
                // trigger (sleep, display change) is the reason worth showing.
                let reported = match trigger {
                    Some(t)
                        if issue == CaptureIssue::NoFirstFrame
                            && t != CaptureIssue::CaptureStalled =>
                    {
                        t
                    }
                    _ => issue,
                };
                m.set_capture_issue(reported);
                m.capture_errors.fetch_add(1, Ordering::Relaxed);
                if announced.is_none() && trigger.is_some() {
                    // The probe found a dead capture: now the viewer should know.
                    emit(&Event::State {
                        state: PublisherState::Reconnecting,
                        detail: Some(reported.as_str().to_string()),
                    });
                }
                metrics::warn(
                    "capture_recovery_failed",
                    Some(&format!(
                        "round={} issue={} {detail}",
                        self.recovery_rounds,
                        reported.as_str()
                    )),
                );
                if self.recovery_rounds >= MAX_RECOVERY_ROUNDS {
                    return Err((reported, detail));
                }
                self.pending_issue = reported;
                let backoff = Duration::from_secs(1u64 << (self.recovery_rounds - 1).min(3));
                self.retry_at = Some(Instant::now() + backoff);
                self.last_tick_wall = SystemTime::now();
                Ok(())
            }
        }
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        if let Some(mut session) = self.session.take() {
            session.stop();
        }
    }
}

/// Builds a Windows Graphics Capture session and waits for it to prove itself
/// with a published frame. Each attempt creates a fresh WinRT worker, D3D11
/// device and frame pool; retrying LiveKit would not repair any of those.
fn start_capture_with_recovery(
    config: CaptureConfig,
    metrics: Arc<Metrics>,
    publisher: Arc<Mutex<LiveKitPublisher>>,
    last_frame: Arc<AtomicU64>,
    epoch: Instant,
    requested_at: Instant,
) -> Result<CaptureSession, CaptureFailure> {
    let mut last_error = (
        CaptureIssue::StartFailed,
        String::from("capture did not start"),
    );

    for attempt in 1..=CAPTURE_START_ATTEMPTS {
        let first_frame = Arc::new(AtomicBool::new(false));
        let frame_seen = Arc::clone(&first_frame);
        let publisher = Arc::clone(&publisher);
        let sink_metrics = Arc::clone(&metrics);
        let last_frame = Arc::clone(&last_frame);

        let mut session = match CaptureSession::start(
            config,
            Arc::clone(&metrics),
            Box::new(move |frame| {
                match publisher.try_lock() {
                    Ok(mut p) => {
                        p.publish_frame(frame);
                        // The capture is only ready once a frame has been handed
                        // to the WebRTC source, not merely received from WGC.
                        frame_seen.store(true, Ordering::Release);
                        let at = (epoch.elapsed().as_millis() as u64).max(1);
                        last_frame.store(at, Ordering::Release);
                        if sink_metrics.first_frame_ms.load(Ordering::Relaxed) == 0 {
                            let since_start = requested_at
                                .elapsed()
                                .as_millis()
                                .clamp(1, u32::MAX as u128);
                            sink_metrics
                                .first_frame_ms
                                .store(since_start as u32, Ordering::Relaxed);
                        }
                    }
                    // Never block the capture thread waiting on the publisher.
                    Err(_) => {
                        sink_metrics.frames_dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }),
        ) {
            Ok(session) => session,
            Err(error) => {
                last_error = (error.issue(), error.to_string());
                metrics::warn(
                    "capture_start_attempt_failed",
                    Some(&format!("attempt={attempt} error={}", last_error.1)),
                );
                if attempt < CAPTURE_START_ATTEMPTS {
                    std::thread::sleep(CAPTURE_RETRY_DELAY);
                }
                continue;
            }
        };

        let deadline = Instant::now() + CAPTURE_FIRST_FRAME_TIMEOUT;
        while Instant::now() < deadline {
            if first_frame.load(Ordering::Acquire) {
                metrics::info("capture_ready", Some(&format!("attempt={attempt}")));
                return Ok(session);
            }
            if session.is_finished() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }

        session.stop();
        metrics.capture_errors.fetch_add(1, Ordering::Relaxed);
        last_error = (
            CaptureIssue::NoFirstFrame,
            format!(
                "attempt={attempt} produced no frame within {}ms",
                CAPTURE_FIRST_FRAME_TIMEOUT.as_millis()
            ),
        );
        metrics::warn("capture_first_frame_timeout", Some(&last_error.1));
        if attempt < CAPTURE_START_ATTEMPTS {
            std::thread::sleep(CAPTURE_RETRY_DELAY);
        }
    }

    Err(last_error)
}
