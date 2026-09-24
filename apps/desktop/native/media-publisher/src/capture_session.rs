//! Screen capture via Windows Graphics Capture.
//!
//! Backend choice and the measurements behind it: `docs/adr/0003-windows-media-publisher.md`.
//!
//! Properties this module guarantees:
//!
//! - Runs in the **interactive user session**. There is no service mode and no hidden
//!   capture path (ADR 0002, invariant 6).
//! - The **cursor is captured**, because the operator must see what the person sees.
//! - The frame rate is capped **at the source**, so frames we would discard are never
//!   produced - this is where WGC's CPU advantage over DXGI comes from.
//! - **Nothing is ever written to disk.** Frames are handed to a sink and dropped.
//! - `stop()` takes effect immediately, which is what session end, policy stop and
//!   emergency stop all require.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

use crate::metrics::Metrics;

/// What to capture and how fast.
#[derive(Debug, Clone, Copy)]
pub struct CaptureConfig {
    /// Monitor index; 0 is primary.
    pub monitor: u32,
    /// Target frame rate, applied as a source-side minimum update interval.
    pub fps: u32,
    /// Compatibility field; the OS capture border is always enabled.
    pub indicator_shown: bool,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            monitor: 0,
            fps: 15,
            indicator_shown: false,
        }
    }
}

/// One captured frame, borrowed for the duration of the sink call.
///
/// Borrowed rather than owned so the common path copies nothing: a sink that only
/// needs to hand the bytes to an encoder never allocates.
pub struct CapturedFrame<'a> {
    pub width: u32,
    pub height: u32,
    /// Tightly packed BGRA8, row pitch == width * 4.
    pub bgra: &'a [u8],
}

/// Receives frames. Called on the capture thread, so it must not block for long:
/// WGC delivers the next frame on the same thread.
pub type FrameSink = Box<dyn FnMut(&CapturedFrame<'_>) + Send + 'static>;

#[derive(Debug)]
pub enum CaptureError {
    NoSuchMonitor(u32),
    Start(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoSuchMonitor(i) => write!(f, "monitor {i} not found"),
            Self::Start(e) => write!(f, "capture failed to start: {e}"),
        }
    }
}

impl std::error::Error for CaptureError {}

struct Flags {
    sink: FrameSink,
    metrics: Arc<Metrics>,
    stop: Arc<AtomicBool>,
    /// Reused between frames so the un-padded copy allocates once, not per frame.
    scratch: Vec<u8>,
}

struct Handler {
    flags: Flags,
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Flags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { flags: ctx.flags })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Checked first so a stop request is honoured even under a frame backlog.
        if self.flags.stop.load(Ordering::Relaxed) {
            capture_control.stop();
            return Ok(());
        }

        let (w, h) = (frame.width(), frame.height());
        let buffer = match frame.buffer() {
            Ok(b) => b,
            Err(_) => {
                self.flags
                    .metrics
                    .capture_errors
                    .fetch_add(1, Ordering::Relaxed);
                return Ok(());
            }
        };

        // GPU textures are row-padded; encoders want tight rows. as_nopadding_buffer
        // reuses our scratch buffer when a copy is needed and borrows when it is not.
        let scratch = std::mem::take(&mut self.flags.scratch);
        let mut scratch = scratch;
        let bgra = buffer.as_nopadding_buffer(&mut scratch);

        self.flags.metrics.set_resolution(w, h);
        self.flags
            .metrics
            .frames_captured
            .fetch_add(1, Ordering::Relaxed);
        (self.flags.sink)(&CapturedFrame {
            width: w,
            height: h,
            bgra,
        });

        self.flags.scratch = scratch;
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // The capture item went away (monitor unplugged, session switch). The
        // supervisor decides whether to restart; we only record it.
        self.flags
            .metrics
            .capture_errors
            .fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

/// A running capture. Dropping it stops the capture.
pub struct CaptureSession {
    control: Option<CaptureControl<Handler, Box<dyn std::error::Error + Send + Sync>>>,
    stop: Arc<AtomicBool>,
}

impl CaptureSession {
    /// Starts capturing on a background thread.
    ///
    /// Returns once capture has been handed to its own thread, so the caller keeps
    /// control and can stop at any time.
    pub fn start(
        cfg: CaptureConfig,
        metrics: Arc<Metrics>,
        sink: FrameSink,
    ) -> Result<Self, CaptureError> {
        let monitor = if cfg.monitor == 0 {
            Monitor::primary().map_err(|_| CaptureError::NoSuchMonitor(0))?
        } else {
            // from_index is 1-based in windows-capture; our config is 0-based.
            Monitor::from_index(cfg.monitor as usize + 1)
                .map_err(|_| CaptureError::NoSuchMonitor(cfg.monitor))?
        };

        let stop = Arc::new(AtomicBool::new(false));
        let fps = cfg.fps.max(1);

        // Keep the OS capture border even when the app window is hidden.
        let border = DrawBorderSettings::WithBorder;

        let settings = Settings::new(
            monitor,
            // The operator sees what the person sees.
            CursorCaptureSettings::WithCursor,
            border,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(Duration::from_micros(
                1_000_000 / u64::from(fps),
            )),
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            Flags {
                sink,
                metrics,
                stop: Arc::clone(&stop),
                scratch: Vec::new(),
            },
        );

        let control = Handler::start_free_threaded(settings)
            .map_err(|e| CaptureError::Start(format!("{e:?}")))?;

        Ok(Self {
            control: Some(control),
            stop,
        })
    }

    /// True once the capture thread has finished.
    pub fn is_finished(&self) -> bool {
        self.control
            .as_ref()
            .is_none_or(CaptureControl::is_finished)
    }

    /// Stops capture. Idempotent, and safe to call from any thread.
    ///
    /// The flag is set first so an in-flight frame callback returns without
    /// delivering, which is what emergency stop needs.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(control) = self.control.take() {
            let _ = control.stop();
        }
    }
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Number of monitors currently attached, for multi-monitor planning.
pub fn monitor_count() -> u32 {
    Monitor::enumerate().map(|m| m.len() as u32).unwrap_or(0)
}

/// Shared frame counter used by tests and by the supervisor's health check.
pub type FrameCounter = Arc<AtomicU32>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_the_shipping_profile() {
        let c = CaptureConfig::default();
        assert_eq!((c.monitor, c.fps), (0, 15));
    }

    #[test]
    fn monitor_count_is_at_least_one_on_a_real_desktop() {
        // The build machine always has a display; a zero here means enumeration
        // broke rather than that the machine is headless.
        assert!(monitor_count() >= 1, "expected at least one monitor");
    }

    /// Capture must actually produce frames with the cursor setting we ship.
    #[test]
    fn capture_delivers_frames_and_stops_promptly() {
        use std::sync::atomic::AtomicU32;

        let metrics = Arc::new(Metrics::new());
        let count: FrameCounter = Arc::new(AtomicU32::new(0));
        let seen = Arc::clone(&count);
        let dims = Arc::new(std::sync::Mutex::new((0u32, 0u32)));
        let dims_sink = Arc::clone(&dims);

        let mut session = CaptureSession::start(
            CaptureConfig {
                monitor: 0,
                fps: 15,
                indicator_shown: false,
            },
            Arc::clone(&metrics),
            Box::new(move |f| {
                seen.fetch_add(1, Ordering::Relaxed);
                if let Ok(mut d) = dims_sink.lock() {
                    *d = (f.width, f.height);
                }
                // A frame must be a full BGRA image, not a partial row.
                assert_eq!(f.bgra.len(), (f.width * f.height * 4) as usize);
            }),
        )
        .expect("capture should start on a machine with a display");

        // Give WGC time to deliver a few frames at 15fps.
        std::thread::sleep(Duration::from_millis(1500));

        let before = count.load(Ordering::Relaxed);
        assert!(before > 0, "no frames captured in 1.5s");

        let t0 = std::time::Instant::now();
        session.stop();
        let stop_ms = t0.elapsed().as_millis();

        // Emergency stop has a 500ms budget (V07); capture teardown must fit inside it.
        assert!(
            stop_ms < 500,
            "stop took {stop_ms}ms, over the 500ms budget"
        );

        std::thread::sleep(Duration::from_millis(300));
        let after = count.load(Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(
            after,
            count.load(Ordering::Relaxed),
            "frames still arriving after stop()"
        );

        assert!(metrics.snapshot().frames_captured > 0);
    }
}
