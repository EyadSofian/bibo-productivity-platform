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

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use media_publisher::agent_ipc::{
    connect_pipe, write_event, Command, CommandReader, Event, IpcError, PublisherState,
};
use media_publisher::capture_session::{CaptureConfig, CaptureSession};
use media_publisher::control::ControlGate;
use media_publisher::livekit_publisher::LiveKitPublisher;
use media_publisher::metrics::{self, Metrics};

/// How often metrics are pushed to the agent while publishing.
const METRICS_INTERVAL: Duration = Duration::from_secs(2);

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
    let mut reader = CommandReader::new(stream);

    let m = Arc::new(Metrics::new());
    let mut session: Option<CaptureSession> = None;
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
        match reader.next() {
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

                if let Some(mut old) = session.take() {
                    old.stop();
                }

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

                // Owned by the capture callback; the capture thread is the only
                // thread that touches it, so a plain Mutex is enough.
                let publisher = Arc::new(Mutex::new(publisher));
                let pub_for_sink = Arc::clone(&publisher);
                let m_sink = Arc::clone(&m);

                let started = CaptureSession::start(
                    CaptureConfig {
                        monitor: cfg.monitor,
                        fps: cfg.fps,
                        indicator_shown: cfg.indicator_shown,
                    },
                    Arc::clone(&m),
                    Box::new(move |frame| {
                        match pub_for_sink.try_lock() {
                            Ok(mut p) => p.publish_frame(frame),
                            // Never block the capture thread waiting on the
                            // publisher: dropping a frame is better than stalling
                            // capture and building a backlog.
                            Err(_) => {
                                m_sink.frames_dropped.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }),
                );

                match started {
                    Ok(s) => {
                        session = Some(s);
                        emit(&Event::State {
                            state: PublisherState::Capturing,
                            detail: None,
                        });
                    }
                    Err(e) => {
                        m.capture_errors.fetch_add(1, Ordering::Relaxed);
                        emit(&Event::Fatal {
                            code: "capture_failed".into(),
                            detail: e.to_string(),
                        });
                        return 4;
                    }
                }
            }

            Ok(Command::Stop { reason }) => {
                // Disarm before stopping capture: a session that is ending must
                // not accept one last input on the way out.
                control_gate.disarm();
                if let Some(mut s) = session.take() {
                    s.stop();
                }
                emit(&Event::State {
                    state: PublisherState::Stopped,
                    detail: Some(reason),
                });
                return 0;
            }

            // Pipe closed: the agent is gone, so capture must stop too.
            Err(IpcError::Closed) => {
                if let Some(mut s) = session.take() {
                    s.stop();
                }
                metrics::warn("agent_disconnected", Some("stopping capture"));
                return 0;
            }

            Err(e) => {
                metrics::error("ipc_error", Some(&e.to_string()));
                if let Some(mut s) = session.take() {
                    s.stop();
                }
                return 5;
            }
        }
    }
}
