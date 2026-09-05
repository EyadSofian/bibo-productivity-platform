//! End-to-end publish test against a real LiveKit server.
//!
//! This is the test that actually proves V04: frames captured from this machine's
//! screen are encoded and accepted by a real SFU. Nothing else in this crate should
//! be read as evidence that live video works.
//!
//! Skipped unless `LIVEKIT_TEST_URL` is set, so `cargo test` stays hermetic.
//!
//! Local run (no Docker needed — livekit-server ships a standalone binary):
//!
//! ```text
//! livekit-server --dev --bind 127.0.0.1
//! set LIVEKIT_TEST_URL=ws://127.0.0.1:7880
//! set LIVEKIT_TEST_KEY=devkey
//! set LIVEKIT_TEST_SECRET=secret
//! set CARGO_TARGET_DIR=C:\lkb
//! cargo test --test publish_integration -- --nocapture
//! ```

#![cfg(windows)]

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use media_publisher::capture_session::{CaptureConfig, CaptureSession};
use media_publisher::livekit_publisher::LiveKitPublisher;
use media_publisher::metrics::Metrics;

/// Mints a publish-only token with the same grants the backend issues, so the test
/// exercises the real permission shape rather than an admin token.
fn publisher_token(key: &str, secret: &str, room: &str, identity: &str) -> String {
    use livekit_api::access_token::{AccessToken, VideoGrants};

    AccessToken::with_api_key(key, secret)
        .with_identity(identity)
        .with_name(identity)
        .with_grants(VideoGrants {
            room_join: true,
            room: room.to_string(),
            can_publish: true,
            can_subscribe: false,
            ..Default::default()
        })
        .with_ttl(Duration::from_secs(120))
        .to_jwt()
        .expect("failed to mint test token")
}

struct Env {
    url: String,
    key: String,
    secret: String,
}

fn env() -> Option<Env> {
    let url = std::env::var("LIVEKIT_TEST_URL").ok()?;
    let key = std::env::var("LIVEKIT_TEST_KEY").ok()?;
    let secret = std::env::var("LIVEKIT_TEST_SECRET").ok()?;
    Some(Env { url, key, secret })
}

#[test]
fn captures_and_publishes_real_frames_to_a_real_sfu() {
    let Some(e) = env() else {
        eprintln!("LIVEKIT_TEST_URL/KEY/SECRET not set; skipping publish integration test");
        return;
    };

    let room = "biz-itest--session-publish";
    let token = publisher_token(&e.key, &e.secret, room, "device-itest");

    let metrics = Arc::new(Metrics::new());
    let publisher = LiveKitPublisher::connect(&e.url, &token, 1280, 720, 15, Arc::clone(&metrics))
        .expect("publisher should connect to the dev SFU");

    let publisher = Arc::new(std::sync::Mutex::new(publisher));
    let pub_sink = Arc::clone(&publisher);

    let mut session = CaptureSession::start(
        CaptureConfig {
            monitor: 0,
            fps: 15,
            indicator_shown: false,
        },
        Arc::clone(&metrics),
        Box::new(move |frame| {
            if let Ok(mut p) = pub_sink.try_lock() {
                p.publish_frame(frame);
            }
        }),
    )
    .expect("capture should start");

    // Long enough for connection setup plus a couple of seconds of real frames.
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if metrics.frames_published.load(Ordering::Relaxed) >= 15 {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    session.stop();
    let snap = metrics.snapshot();
    eprintln!("publish integration metrics: {snap:?}");

    assert!(
        snap.frames_captured > 0,
        "no frames captured from the screen: {snap:?}"
    );
    assert!(
        snap.frames_published >= 15,
        "expected at least 15 published frames (1s at 15fps), got {}: {snap:?}",
        snap.frames_published
    );
    assert_eq!(snap.encoder_errors, 0, "encoder reported errors: {snap:?}");
    // The spec requires a software fallback to be declared, not silent. libwebrtc
    // uses OpenH264 (software) here, and the metric must say so.
    assert_eq!(
        snap.encoder,
        media_publisher::metrics::EncoderKind::Software,
        "encoder must be declared, not Unknown: {snap:?}"
    );
    // A large drop ratio would mean the publisher cannot keep up with capture.
    let dropped_ratio = snap.frames_dropped as f64 / snap.frames_captured.max(1) as f64;
    assert!(
        dropped_ratio < 0.5,
        "dropped {:.0}% of frames: {snap:?}",
        dropped_ratio * 100.0
    );
}

/// A viewer-shaped token (subscribe only) must be refused when it tries to publish,
/// mirroring the backend test `TestViewerTokenCannotPublish`.
#[test]
fn subscribe_only_token_cannot_publish() {
    let Some(e) = env() else {
        eprintln!("LIVEKIT_TEST_URL/KEY/SECRET not set; skipping");
        return;
    };

    use livekit_api::access_token::{AccessToken, VideoGrants};
    let room = "biz-itest--session-viewer";
    let token = AccessToken::with_api_key(&e.key, &e.secret)
        .with_identity("user-itest")
        .with_grants(VideoGrants {
            room_join: true,
            room: room.to_string(),
            can_publish: false,
            can_subscribe: true,
            ..Default::default()
        })
        .with_ttl(Duration::from_secs(120))
        .to_jwt()
        .expect("mint viewer token");

    let metrics = Arc::new(Metrics::new());
    // Connecting may succeed (the token can join); publishing must not.
    match LiveKitPublisher::connect(&e.url, &token, 1280, 720, 15, metrics) {
        Ok(_) => panic!("a subscribe-only token must not be able to publish a track"),
        Err(err) => eprintln!("correctly refused: {err}"),
    }
}
