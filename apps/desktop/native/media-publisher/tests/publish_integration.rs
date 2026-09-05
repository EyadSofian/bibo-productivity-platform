//! End-to-end publish test against a real LiveKit server.
//!
//! This is the test that actually proves V04: frames captured from this machine's
//! screen are encoded and accepted by a real SFU. Nothing else in this crate should
//! be read as evidence that live video works.
//!
//! Explicitly ignored by the portable suite; opt in with `--ignored` and the
//! three LIVEKIT_TEST environment variables. Missing setup then fails the test.
//!
//! Local run (no Docker needed — livekit-server ships a standalone binary):
//!
//! ```text
//! livekit-server --dev --bind 127.0.0.1
//! set LIVEKIT_TEST_URL=ws://127.0.0.1:7880
//! set LIVEKIT_TEST_KEY=devkey
//! set LIVEKIT_TEST_SECRET=secret
//! set CARGO_TARGET_DIR=C:\lkb
//! cargo test --test publish_integration -- --ignored --nocapture
//! ```

#![cfg(windows)]

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use media_publisher::capture_session::{CaptureConfig, CaptureSession};
use media_publisher::livekit_publisher::LiveKitPublisher;
use media_publisher::metrics::Metrics;

/// Headless Windows CI: exercise the actual BGRA conversion, native H.264
/// encoder, SFU, and native subscriber decoder without reading anyone's screen.
#[test]
#[ignore = "requires LIVEKIT_TEST_URL/KEY/SECRET, no interactive desktop needed"]
fn publishes_synthetic_frames_and_decodes_them_through_sfu() {
    use futures_util::StreamExt;
    use livekit::track::RemoteTrack;
    use livekit::webrtc::video_stream::native::NativeVideoStream;
    use livekit::{Room, RoomEvent, RoomOptions};
    use livekit_api::access_token::{AccessToken, VideoGrants};
    use media_publisher::capture_session::CapturedFrame;
    use std::sync::atomic::AtomicUsize;

    let e = env().expect("LIVEKIT_TEST_URL/KEY/SECRET must be set");
    let room_name = format!("native-smoke-{}", std::process::id());
    let viewer_token = AccessToken::with_api_key(&e.key, &e.secret)
        .with_identity("native-smoke-viewer")
        .with_grants(VideoGrants {
            room_join: true,
            room: room_name.clone(),
            can_publish: false,
            can_subscribe: true,
            can_publish_data: false,
            ..Default::default()
        })
        .with_ttl(Duration::from_secs(120))
        .to_jwt()
        .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (viewer, mut events) = runtime
        .block_on(Room::connect(&e.url, &viewer_token, RoomOptions::default()))
        .expect("viewer connects");
    let decoded = Arc::new(AtomicUsize::new(0));
    let received = Arc::clone(&decoded);
    let reader = runtime.spawn(async move {
        while let Some(event) = events.recv().await {
            if let RoomEvent::TrackSubscribed {
                track: RemoteTrack::Video(track),
                ..
            } = event
            {
                let mut frames = NativeVideoStream::new(track.rtc_track());
                while let Some(frame) = frames.next().await {
                    if frame.buffer.width() == 640 && frame.buffer.height() == 360 {
                        received.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }
    });
    let token = publisher_token(&e.key, &e.secret, &room_name, "native-smoke-publisher");
    let metrics = Arc::new(Metrics::new());
    let mut publisher =
        LiveKitPublisher::connect(&e.url, &token, 640, 360, 15, Arc::clone(&metrics))
            .expect("publisher connects with production scope");
    let mut pixels = vec![0u8; 640 * 360 * 4];
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut source_frame = 0u8;
    while Instant::now() < deadline && decoded.load(Ordering::Relaxed) < 20 {
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.copy_from_slice(&[source_frame, 100, 200, 255]);
        }
        publisher.publish_frame(&CapturedFrame {
            width: 640,
            height: 360,
            bgra: &pixels,
        });
        source_frame = source_frame.wrapping_add(15);
        std::thread::sleep(Duration::from_millis(66));
    }
    let count = decoded.load(Ordering::Relaxed);
    publisher.close();
    runtime.block_on(viewer.close()).unwrap();
    reader.abort();
    assert!(
        count >= 20,
        "expected 20 remotely decoded frames, got {count}"
    );
    eprintln!("PASS: Windows native publisher -> SFU -> native decoder: {count} frames at 640x360");
}

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
            can_publish_data: false,
            can_publish_sources: vec!["screen_share".to_owned()],
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
#[ignore = "requires an interactive Windows desktop and LIVEKIT_TEST_URL/KEY/SECRET"]
fn captures_and_publishes_real_frames_to_a_real_sfu() {
    let e = env().expect("LIVEKIT_TEST_URL/KEY/SECRET must be set for this integration test");

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
#[ignore = "requires LIVEKIT_TEST_URL/KEY/SECRET"]
fn subscribe_only_token_cannot_publish() {
    let e = env().expect("LIVEKIT_TEST_URL/KEY/SECRET must be set for this integration test");

    use livekit_api::access_token::{AccessToken, VideoGrants};
    let room = "biz-itest--session-viewer";
    let token = AccessToken::with_api_key(&e.key, &e.secret)
        .with_identity("user-itest")
        .with_grants(VideoGrants {
            room_join: true,
            room: room.to_string(),
            can_publish: false,
            can_subscribe: true,
            can_publish_data: false,
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
