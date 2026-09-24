//! Borderless desktop capture through DXGI Desktop Duplication.
//!
//! Windows Graphics Capture draws a coloured privacy border unless a packaged
//! application has requested the restricted borderless capability. The shipping
//! agent is installed through MSI/NSIS, so scheduled capture uses the desktop
//! duplication API instead. The desktop app still exposes its own monitoring
//! state and local stop control.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC,
    HGDIOBJ, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DrawIconEx, GetCursorInfo, GetIconInfo, GetSystemMetrics, CURSORINFO, CURSOR_SHOWING,
    DI_NORMAL, HICON, ICONINFO, SM_CXSCREEN, SM_CYSCREEN,
};
use windows_capture::dxgi_duplication_api::{
    DxgiDuplicationApi, DxgiDuplicationFormat, Error as DxgiError,
};
use windows_capture::monitor::Monitor;

use crate::metrics::Metrics;

/// What to capture and how fast.
#[derive(Debug, Clone, Copy)]
pub struct CaptureConfig {
    /// Monitor index; 0 is primary.
    pub monitor: u32,
    /// Target frame rate. Desktop updates above this rate are discarded before
    /// they are copied to CPU memory.
    pub fps: u32,
    /// Compatibility field retained on the sidecar wire protocol. Visibility is
    /// provided by the desktop UI/tray rather than a WGC border.
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
pub struct CapturedFrame<'a> {
    pub width: u32,
    pub height: u32,
    /// Tightly packed BGRA8, row pitch == width * 4.
    pub bgra: &'a [u8],
}

/// Receives frames on the capture thread.
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

/// A reusable top-down 32-bit DIB. Drawing the system cursor through GDI keeps
/// the streamed image faithful on adapters that expose the pointer separately
/// from the duplicated desktop surface.
struct CursorCompositor {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    len: usize,
    monitor_left: i32,
    monitor_top: i32,
}

impl CursorCompositor {
    fn new(width: u32, height: u32, monitor_left: i32, monitor_top: i32) -> Result<Self, String> {
        let dc = unsafe { CreateCompatibleDC(None) };
        if dc.0.is_null() {
            return Err("CreateCompatibleDC returned null".into());
        }

        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            // Negative height creates a top-down DIB matching the captured BGRA rows.
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: width.saturating_mul(height).saturating_mul(4),
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let bitmap =
            unsafe { CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) }
                .map_err(|error| {
                    unsafe {
                        let _ = DeleteDC(dc);
                    }
                    format!("CreateDIBSection: {error}")
                })?;
        if bits.is_null() {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
                let _ = DeleteDC(dc);
            }
            return Err("CreateDIBSection returned null pixels".into());
        }
        let previous = unsafe { SelectObject(dc, HGDIOBJ(bitmap.0)) };
        if previous.0.is_null() {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
                let _ = DeleteDC(dc);
            }
            return Err("SelectObject returned null".into());
        }

        Ok(Self {
            dc,
            bitmap,
            previous,
            bits: bits.cast(),
            len: width as usize * height as usize * 4,
            monitor_left,
            monitor_top,
        })
    }

    fn compose<'a>(&'a mut self, frame: &[u8]) -> &'a [u8] {
        if frame.len() != self.len {
            return &[];
        }
        let pixels = unsafe { std::slice::from_raw_parts_mut(self.bits, self.len) };
        pixels.copy_from_slice(frame);

        self.draw_cursor()
    }

    // Desktop Duplication reports Timeout while the desktop is static. An
    // initial frame is still needed for a new viewer, and a slow heartbeat
    // keeps the encoded track alive if nothing on screen changes.
    fn capture_static_desktop(&mut self, width: u32, height: u32) -> Result<&[u8], String> {
        let screen = unsafe { GetDC(None) };
        if screen.0.is_null() {
            return Err("GetDC returned null".into());
        }
        let copied = unsafe {
            BitBlt(
                self.dc,
                0,
                0,
                width as i32,
                height as i32,
                Some(screen),
                self.monitor_left,
                self.monitor_top,
                SRCCOPY | CAPTUREBLT,
            )
        };
        unsafe { ReleaseDC(None, screen) };
        copied.map_err(|error| format!("BitBlt static frame: {error}"))?;
        Ok(self.draw_cursor())
    }

    fn draw_cursor(&mut self) -> &[u8] {
        let pixels = unsafe { std::slice::from_raw_parts_mut(self.bits, self.len) };
        let mut cursor = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetCursorInfo(&mut cursor) }.is_err() || cursor.flags != CURSOR_SHOWING {
            return pixels;
        }

        let icon = HICON(cursor.hCursor.0);
        let mut icon_info = ICONINFO::default();
        if unsafe { GetIconInfo(icon, &mut icon_info) }.is_err() {
            return pixels;
        }
        let x = cursor.ptScreenPos.x - self.monitor_left - icon_info.xHotspot as i32;
        let y = cursor.ptScreenPos.y - self.monitor_top - icon_info.yHotspot as i32;
        let _ = unsafe { DrawIconEx(self.dc, x, y, icon, 0, 0, 0, None, DI_NORMAL) };

        unsafe {
            if !icon_info.hbmMask.0.is_null() {
                let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));
            }
            if !icon_info.hbmColor.0.is_null() {
                let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
            }
        }
        pixels
    }
}

impl Drop for CursorCompositor {
    fn drop(&mut self) {
        unsafe {
            let _ = SelectObject(self.dc, self.previous);
            let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            let _ = DeleteDC(self.dc);
        }
    }
}

/// A running capture. Dropping it stops and joins the worker.
pub struct CaptureSession {
    worker: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
}

impl CaptureSession {
    pub fn start(
        cfg: CaptureConfig,
        metrics: Arc<Metrics>,
        sink: FrameSink,
    ) -> Result<Self, CaptureError> {
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let finished = Arc::new(AtomicBool::new(false));
        let worker_finished = Arc::clone(&finished);
        let (started_tx, started_rx) = mpsc::sync_channel::<Result<(), String>>(1);

        let worker = thread::Builder::new()
            .name("borderless-dxgi-capture".into())
            .spawn(move || {
                let result = run_capture(cfg, metrics, worker_stop, sink, &started_tx);
                if let Err(error) = result {
                    let _ = started_tx.try_send(Err(error));
                }
                worker_finished.store(true, Ordering::Release);
            })
            .map_err(|error| CaptureError::Start(error.to_string()))?;

        match started_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                worker: Some(worker),
                stop,
                finished,
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(CaptureError::Start(error))
            }
            Err(error) => {
                stop.store(true, Ordering::Release);
                let _ = worker.join();
                Err(CaptureError::Start(format!(
                    "capture startup timed out: {error}"
                )))
            }
        }
    }

    pub fn is_finished(&self) -> bool {
        self.worker.as_ref().is_none_or(JoinHandle::is_finished)
    }

    /// A capture worker can die after startup (for example, DXGI recovery
    /// fails after sleep). The sidecar watches this flag while its command pipe
    /// is blocked waiting for input.
    pub fn finished_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.finished)
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        self.stop();
    }
}

fn monitor_for(index: u32) -> Result<Monitor, CaptureError> {
    if index == 0 {
        Monitor::primary().map_err(|_| CaptureError::NoSuchMonitor(0))
    } else {
        Monitor::from_index(index as usize + 1).map_err(|_| CaptureError::NoSuchMonitor(index))
    }
}

fn run_capture(
    cfg: CaptureConfig,
    metrics: Arc<Metrics>,
    stop: Arc<AtomicBool>,
    mut sink: FrameSink,
    started: &mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let monitor = monitor_for(cfg.monitor).map_err(|error| error.to_string())?;
    let mut capture =
        DxgiDuplicationApi::new_options(monitor, &[DxgiDuplicationFormat::Bgra8]).ok();
    let geometry = capture.as_mut().and_then(|api| {
        unsafe { api.output().GetDesc1() }.ok().map(|output| {
            (
                api.width(),
                api.height(),
                output.DesktopCoordinates.left,
                output.DesktopCoordinates.top,
            )
        })
    });
    let (width, height, left, top) = if let Some(geometry) = geometry {
        geometry
    } else if cfg.monitor == 0 {
        // DXGI can refuse duplication immediately after sleep or an adapter
        // reset. GDI can still copy the unlocked primary desktop in that case.
        capture = None;
        metrics.capture_errors.fetch_add(1, Ordering::Relaxed);
        let width = unsafe { GetSystemMetrics(SM_CXSCREEN) };
        let height = unsafe { GetSystemMetrics(SM_CYSCREEN) };
        if width <= 0 || height <= 0 {
            return Err("primary desktop has no captureable geometry".into());
        }
        (width as u32, height as u32, 0, 0)
    } else {
        return Err("DXGI cannot open the requested monitor".into());
    };
    let mut cursor = CursorCompositor::new(width, height, left, top)?;
    let _ = cfg.indicator_shown;
    started
        .send(Ok(()))
        .map_err(|_| "capture caller closed during startup".to_string())?;

    let frame_interval = Duration::from_micros(1_000_000 / u64::from(cfg.fps.max(1)));
    let mut next_frame = Instant::now();
    let mut last_frame = Instant::now() - Duration::from_secs(1);
    let gdi_interval = Duration::from_millis(200);
    let mut scratch = Vec::new();

    while !stop.load(Ordering::Acquire) {
        let mut recover_dxgi = false;
        let mut disable_dxgi = false;
        let next = capture.as_mut().map(|api| api.acquire_next_frame(25));
        match next {
            Some(Ok(mut frame)) => {
                let now = Instant::now();
                if now < next_frame {
                    continue;
                }
                next_frame = now + frame_interval;
                let (frame_width, frame_height) = (frame.width(), frame.height());
                let buffer = match frame.buffer() {
                    Ok(buffer) => buffer,
                    Err(_) => {
                        metrics.capture_errors.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                };
                let packed = buffer.as_nopadding_buffer(&mut scratch);
                let composed = cursor.compose(packed);
                if composed.is_empty() {
                    metrics.capture_errors.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                metrics.set_resolution(frame_width, frame_height);
                metrics.frames_captured.fetch_add(1, Ordering::Relaxed);
                last_frame = now;
                sink(&CapturedFrame {
                    width: frame_width,
                    height: frame_height,
                    bgra: composed,
                });
            }
            Some(Err(DxgiError::Timeout)) | None => {
                if last_frame.elapsed() >= gdi_interval {
                    match cursor.capture_static_desktop(width, height) {
                        Ok(bgra) => {
                            metrics.set_resolution(width, height);
                            metrics.frames_captured.fetch_add(1, Ordering::Relaxed);
                            last_frame = Instant::now();
                            sink(&CapturedFrame {
                                width,
                                height,
                                bgra,
                            });
                        }
                        Err(_) => {
                            metrics.capture_errors.fetch_add(1, Ordering::Relaxed);
                            last_frame = Instant::now();
                        }
                    }
                }
            }
            Some(Err(DxgiError::AccessLost)) => {
                metrics.capture_errors.fetch_add(1, Ordering::Relaxed);
                if stop.load(Ordering::Acquire) {
                    break;
                }
                thread::sleep(Duration::from_millis(200));
                recover_dxgi = true;
            }
            Some(Err(_)) => {
                metrics.capture_errors.fetch_add(1, Ordering::Relaxed);
                // A driver may report errors instead of Timeout while the
                // unlocked desktop is static. Fall back to GDI immediately.
                disable_dxgi = true;
            }
        }
        if recover_dxgi {
            capture =
                DxgiDuplicationApi::new_options(monitor, &[DxgiDuplicationFormat::Bgra8]).ok();
        }
        if disable_dxgi {
            capture = None;
        }
        if capture.is_none() {
            thread::sleep(Duration::from_millis(25));
        }
    }
    Ok(())
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
        let config = CaptureConfig::default();
        assert_eq!((config.monitor, config.fps), (0, 15));
    }

    #[test]
    fn monitor_count_is_at_least_one_on_a_real_desktop() {
        assert!(monitor_count() >= 1, "expected at least one monitor");
    }

    #[test]
    fn capture_delivers_frames_and_stops_promptly() {
        let metrics = Arc::new(Metrics::new());
        let count: FrameCounter = Arc::new(AtomicU32::new(0));
        let seen = Arc::clone(&count);
        let dims = Arc::new(std::sync::Mutex::new((0u32, 0u32)));
        let dims_sink = Arc::clone(&dims);

        let mut session = CaptureSession::start(
            CaptureConfig::default(),
            Arc::clone(&metrics),
            Box::new(move |frame| {
                seen.fetch_add(1, Ordering::Relaxed);
                if let Ok(mut dimensions) = dims_sink.lock() {
                    *dimensions = (frame.width, frame.height);
                }
                assert_eq!(frame.bgra.len(), (frame.width * frame.height * 4) as usize);
            }),
        )
        .expect("capture should start on a machine with a display");

        thread::sleep(Duration::from_millis(1500));
        let before = count.load(Ordering::Relaxed);
        assert!(before > 0, "no frames captured in 1.5s");

        let started = Instant::now();
        session.stop();
        assert!(started.elapsed() < Duration::from_millis(500));
        thread::sleep(Duration::from_millis(200));
        assert_eq!(before, count.load(Ordering::Relaxed));
        assert!(metrics.snapshot().frames_captured > 0);
    }
}
