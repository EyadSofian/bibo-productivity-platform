//! Publishes captured frames to the SFU over WebRTC.
//!
//! Uses the official LiveKit Rust SDK (`livekit` crate), as described in
//! `docs/adr/0003-windows-media-publisher.md`.
//!
//! Invariants:
//!
//! - The publisher holds only a **short-lived publisher token**, minted by the
//!   backend. It never sees an API key or secret, and never logs the token.
//! - The track is published as `TrackSource::Screenshare`, matching the token's
//!   `canPublishSources: ["screen_share"]` grant. A mismatch would be rejected by
//!   the SFU, which is the intended belt-and-braces.
//! - Frames are converted and handed straight to WebRTC. Nothing is buffered to
//!   disk and no still image is ever produced.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use livekit::options::{TrackPublishOptions, VideoCodec};
use livekit::track::{LocalTrack, LocalVideoTrack, TrackSource};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::{native::NativeVideoSource, RtcVideoSource, VideoResolution};
use livekit::{DataPacket, Room, RoomEvent, RoomOptions};
use tokio::sync::mpsc;

use crate::capture_session::CapturedFrame;
use crate::control::{ControlGate, ControlReply, ControlStream, TOPIC_CONTROL, TOPIC_CONTROL_ACK};
use crate::input_injector::{self, InputInjector};
use crate::metrics::{self as m, EncoderKind, Metrics};

/// Track name shown in the SFU and in operator tooling.
const TRACK_NAME: &str = "screen";

#[derive(Debug)]
pub enum PublishError {
    Connect(String),
    Publish(String),
    Runtime(String),
}

impl std::fmt::Display for PublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(e) => write!(f, "livekit connect failed: {e}"),
            Self::Publish(e) => write!(f, "livekit publish failed: {e}"),
            Self::Runtime(e) => write!(f, "async runtime failed: {e}"),
        }
    }
}

impl std::error::Error for PublishError {}

/// A connected room with one published screen track.
pub struct LiveKitPublisher {
    runtime: tokio::runtime::Runtime,
    /// Kept alive for the session: dropping the Room disconnects it.
    ///
    /// `Arc` because the remote-control task needs the same room to receive
    /// DataChannel frames and publish acknowledgements; `Room` is not `Clone`.
    room: Arc<Room>,
    /// Room event stream, taken by [`Self::start_control`]. `None` once taken.
    events: Option<mpsc::UnboundedReceiver<RoomEvent>>,
    source: NativeVideoSource,
    /// Reused between frames so steady-state publishing allocates nothing.
    i420: I420Buffer,
    width: u32,
    height: u32,
    metrics: Arc<Metrics>,
}

impl LiveKitPublisher {
    /// Connects to the room and publishes a screen track.
    ///
    /// `token` is short-lived and is never logged or persisted by this module.
    pub fn connect(
        url: &str,
        token: &str,
        width: u32,
        height: u32,
        fps: u32,
        metrics: Arc<Metrics>,
    ) -> Result<Self, PublishError> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| PublishError::Runtime(e.to_string()))?;

        // The LiveKit SDK spawns tasks when a source or track is created, so these
        // constructors must run inside the runtime context. Without the guard they
        // panic with "there is no reactor running".
        let (source, track) = {
            let _enter = runtime.enter();
            let source = NativeVideoSource::new(
                VideoResolution { width, height },
                /* is_screencast */ true,
            );
            let track = LocalVideoTrack::create_video_track(
                TRACK_NAME,
                RtcVideoSource::Native(source.clone()),
            );
            (source, track)
        };

        let (room, events) = runtime
            .block_on(Room::connect(url, token, RoomOptions::default()))
            .map_err(|e| PublishError::Connect(e.to_string()))?;

        let options = TrackPublishOptions {
            source: TrackSource::Screenshare,
            // H.264 so hardware encoders (NVENC / Quick Sync / AMF) can be used
            // where available; the SFU negotiates the actual codec.
            video_codec: VideoCodec::H264,
            // Screen content at 15fps does not benefit enough from simulcast to
            // justify encoding several layers on the agent's CPU budget.
            simulcast: false,
            ..Default::default()
        };

        runtime
            .block_on(
                room.local_participant()
                    .publish_track(LocalTrack::Video(track), options),
            )
            .map_err(|e| PublishError::Publish(e.to_string()))?;

        // libwebrtc's built-in H.264 on Windows is OpenH264, which is a SOFTWARE
        // encoder - the integration run prints "[OpenH264] ... screen content".
        // Hardware encoding (NVENC / Quick Sync / AMF) needs a custom encoder
        // factory that this build does not install, so reporting anything else
        // here would be a lie. See ticket 147.
        metrics.set_encoder(EncoderKind::Software);
        metrics.set_fps(fps as f32);

        Ok(Self {
            runtime,
            room: Arc::new(room),
            events: Some(events),
            source,
            i420: I420Buffer::new(width, height),
            width,
            height,
            metrics,
        })
    }

    /// Converts one BGRA frame to I420 and hands it to WebRTC.
    ///
    /// Called on the capture thread. It must stay allocation-free in steady state,
    /// which is why the I420 buffer is reused and only reallocated on a resolution
    /// change (monitor swap, resolution change, remote-desktop resize).
    pub fn publish_frame(&mut self, frame: &CapturedFrame<'_>) {
        if frame.width != self.width || frame.height != self.height {
            self.i420 = I420Buffer::new(frame.width, frame.height);
            self.width = frame.width;
            self.height = frame.height;
            self.metrics.set_resolution(frame.width, frame.height);
        }

        let expected = (frame.width as usize) * (frame.height as usize) * 4;
        if frame.bgra.len() < expected {
            // A short buffer means the capture geometry disagrees with the frame;
            // drop it rather than reading out of bounds.
            self.metrics.frames_dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }

        let (stride_y, stride_u, stride_v) = self.i420.strides();
        let (y, u, v) = self.i420.data_mut();

        // libyuv's "ARGB" is BGRA in memory order, which is exactly what WGC gives
        // us with ColorFormat::Bgra8.
        yuv_helper::argb_to_i420(
            frame.bgra,
            frame.width * 4,
            y,
            stride_y,
            u,
            stride_u,
            v,
            stride_v,
            frame.width as i32,
            frame.height as i32,
        );

        let vf = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us: now_micros(),
            frame_metadata: None,
            buffer: &self.i420,
        };
        // capture_frame is called from the capture thread, which is outside the
        // runtime; entering is a cheap thread-local set and is required for the
        // SDK's internal task spawning.
        {
            let _enter = self.runtime.enter();
            self.source.capture_frame(&vf);
        }
        self.metrics
            .frames_published
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Starts the remote-control loop (V07 / ticket 151).
    ///
    /// Consumes room events on the publisher's runtime and turns authorised
    /// control frames into real input. Nothing is injected unless `gate` is
    /// armed, and the gate is checked inside [`ControlStream::accept`] before a
    /// single attacker-controlled byte is parsed.
    ///
    /// Returns false if the event stream was already taken.
    pub fn start_control(&mut self, gate: Arc<ControlGate>) -> bool {
        let Some(mut events) = self.events.take() else {
            return false;
        };
        let room = Arc::clone(&self.room);

        self.runtime.spawn(async move {
            // Per-monitor DPI awareness must be set before the layout is read,
            // or every coordinate is a scaled one and the cursor lands wrong.
            input_injector::set_dpi_awareness();
            let mut injector = InputInjector::new(input_injector::detect());
            let mut stream = ControlStream::new();

            let mut release_tick = tokio::time::interval(Duration::from_millis(10));
            let mut epoch = gate.disarm_epoch();
            loop {
                let ev = tokio::select! {
                    biased;
                    _ = release_tick.tick() => {
                        let next = gate.disarm_epoch();
                        if next != epoch || !gate.is_armed() {
                            injector.release_all();
                            epoch = next;
                        }
                        continue;
                    }
                    ev = events.recv() => match ev { Some(ev) => ev, None => break },
                };
                match ev {
                    RoomEvent::DataReceived { payload, topic, .. } => {
                        if topic.as_deref() != Some(TOPIC_CONTROL) {
                            continue;
                        }
                        let reply = match stream.accept(&payload, &gate, std::time::Instant::now())
                        {
                            Ok(msg) => {
                                let seq = msg.seq();
                                let needs_ack = msg.needs_ack();
                                if let Err(e) = injector.apply(&msg) {
                                    // The message was well-formed but could not
                                    // be applied - a monitor that went away, or
                                    // a key code the OS refuses.
                                    m::warn("control_apply_failed", Some(&e.to_string()));
                                    Some(ControlReply::ControlError {
                                        seq,
                                        code: crate::control::ErrorCode::Malformed,
                                        detail: e.to_string(),
                                    })
                                } else if needs_ack {
                                    Some(ControlReply::ControlAck { seq, ack_seq: seq })
                                } else {
                                    None
                                }
                            }
                            Err(reason) => {
                                // Refusals are counted, not logged per message:
                                // a flood would otherwise become a log flood.
                                Some(ControlReply::ControlError {
                                    seq: 0,
                                    code: reason.code(),
                                    detail: reason.detail(),
                                })
                            }
                        };

                        if let Some(reply) = reply {
                            if let Ok(bytes) = serde_json::to_vec(&reply) {
                                let _ = room
                                    .local_participant()
                                    .publish_data(DataPacket {
                                        payload: bytes,
                                        topic: Some(TOPIC_CONTROL_ACK.to_string()),
                                        reliable: true,
                                        destination_identities: Vec::new(),
                                    })
                                    .await;
                            }
                        }
                    }
                    RoomEvent::Disconnected { .. } => {
                        // The link is gone: stop accepting input and release
                        // anything we are holding, so a dropped connection
                        // cannot leave a key stuck down on this machine.
                        gate.disarm();
                        injector.release_all();
                        return;
                    }
                    _ => {}
                }
            }
            gate.disarm();
            injector.release_all();
        });
        true
    }

    /// Disconnects. Dropping the publisher does the same; this makes it explicit
    /// at the call site where stop ordering matters.
    pub fn close(self) {
        let LiveKitPublisher { runtime, room, .. } = self;
        // Give the SFU a moment to see a clean leave rather than a timeout.
        runtime.block_on(async {
            let _ = room.close().await;
        });
    }
}

fn now_micros() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}
