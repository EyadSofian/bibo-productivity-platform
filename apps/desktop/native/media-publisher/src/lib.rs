//! Windows screen-capture sidecar for the BiBoTracking video-first media plane.
//!
//! The sidecar is a **separate process** from the Tauri agent: a capture or encoder
//! crash must never take down the agent UI. It holds no API secret - it receives a
//! short-lived publisher token over IPC and forgets it on stop.
//!
//! See `docs/adr/0002-video-first-media-plane.md` and
//! `docs/adr/0003-windows-media-publisher.md`.

pub mod agent_ipc;
#[cfg(windows)]
pub mod capture_session;
pub mod control;
pub mod input_injector;
#[cfg(windows)]
pub mod livekit_publisher;
pub mod metrics;
