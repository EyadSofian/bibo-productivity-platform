//! Capture backend benchmark for ADR 0003.
//!
//! Measures Windows Graphics Capture (WGC) against DXGI Desktop Duplication on the
//! machine it runs on, so the backend choice rests on real numbers rather than
//! folklore. Both backends do the same work: acquire a frame and map it to a CPU
//! buffer, which is what an encoder feed costs in the software path.
//!
//! Run:  cargo run --release --bin capture-bench -- [seconds]
//!
//! It writes JSON to stdout and a human summary to stderr. It never writes image
//! files - the media plane has no still-image path (ADR 0002).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::dxgi_duplication_api::DxgiDuplicationApi;
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

/// Latency percentiles in microseconds, plus throughput, for one backend.
#[derive(Debug, Serialize)]
struct BackendResult {
    backend: &'static str,
    ok: bool,
    error: Option<String>,
    width: u32,
    height: u32,
    duration_s: f64,
    frames: u64,
    fps: f64,
    /// Time spent inside the capture callback / acquire call.
    acquire_us_mean: f64,
    acquire_us_p50: u64,
    acquire_us_p95: u64,
    acquire_us_max: u64,
    /// Time to map the GPU texture into a CPU-readable buffer.
    map_us_mean: f64,
    map_us_p95: u64,
    /// Process CPU time consumed during the run, as a share of one core.
    cpu_percent_one_core: f64,
    cursor_included: bool,
    notes: &'static str,
}

fn percentile(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn mean(v: &[u64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.iter().sum::<u64>() as f64 / v.len() as f64
}

fn filetime_to_100ns(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

/// Total (kernel + user) CPU time of this process, in 100ns ticks.
fn process_cpu_100ns() -> u64 {
    unsafe {
        let mut c = FILETIME::default();
        let mut e = FILETIME::default();
        let mut k = FILETIME::default();
        let mut u = FILETIME::default();
        if GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u).is_ok() {
            filetime_to_100ns(k) + filetime_to_100ns(u)
        } else {
            0
        }
    }
}

// ---------------------------------------------------------------- WGC backend

/// Shared counters, so the capture callback can report out to the bench thread.
struct WgcShared {
    frames: AtomicU64,
    stop: AtomicBool,
    width: AtomicU64,
    height: AtomicU64,
}

struct WgcFlags {
    shared: Arc<WgcShared>,
    deadline: Instant,
    acquire_us: Arc<std::sync::Mutex<Vec<u64>>>,
    map_us: Arc<std::sync::Mutex<Vec<u64>>>,
}

struct WgcHandler {
    flags: WgcFlags,
    last: Instant,
}

impl GraphicsCaptureApiHandler for WgcHandler {
    type Flags = WgcFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            flags: ctx.flags,
            last: Instant::now(),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Inter-frame delta doubles as the acquire cost: WGC pushes frames to us,
        // so the meaningful number is how promptly they arrive.
        let now = Instant::now();
        let delta = now.duration_since(self.last).as_micros() as u64;
        self.last = now;

        self.flags
            .shared
            .width
            .store(frame.width() as u64, Ordering::Relaxed);
        self.flags
            .shared
            .height
            .store(frame.height() as u64, Ordering::Relaxed);

        // Map to CPU, which is what a software encoder would pay per frame.
        let t0 = Instant::now();
        let mapped = frame.buffer();
        let map = t0.elapsed().as_micros() as u64;
        if mapped.is_err() {
            return Ok(());
        }

        if let Ok(mut v) = self.flags.acquire_us.lock() {
            v.push(delta);
        }
        if let Ok(mut v) = self.flags.map_us.lock() {
            v.push(map);
        }
        self.flags.shared.frames.fetch_add(1, Ordering::Relaxed);

        if Instant::now() >= self.flags.deadline {
            self.flags.shared.stop.store(true, Ordering::Relaxed);
            capture_control.stop();
        }
        Ok(())
    }
}

fn bench_wgc(seconds: u64, cap_fps: Option<u32>) -> BackendResult {
    let shared = Arc::new(WgcShared {
        frames: AtomicU64::new(0),
        stop: AtomicBool::new(false),
        width: AtomicU64::new(0),
        height: AtomicU64::new(0),
    });
    let acquire_us = Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));
    let map_us = Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));

    let monitor = match Monitor::primary() {
        Ok(m) => m,
        Err(e) => {
            return failed(
                "windows-graphics-capture",
                format!("Monitor::primary: {e:?}"),
            )
        }
    };

    let settings = Settings::new(
        monitor,
        // The operator must see what the person sees, cursor included.
        CursorCaptureSettings::WithCursor,
        // No yellow capture border: it is a recording artefact, and the person is
        // told about monitoring by the app's own indicator instead.
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        match cap_fps {
            // WGC can rate-limit at the source, so a capped session never pays for
            // frames it would immediately throw away.
            Some(fps) => MinimumUpdateIntervalSettings::Custom(Duration::from_micros(
                1_000_000 / u64::from(fps),
            )),
            None => MinimumUpdateIntervalSettings::Default,
        },
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        WgcFlags {
            shared: Arc::clone(&shared),
            deadline: Instant::now() + Duration::from_secs(seconds),
            acquire_us: Arc::clone(&acquire_us),
            map_us: Arc::clone(&map_us),
        },
    );

    let cpu0 = process_cpu_100ns();
    let t0 = Instant::now();
    let run = WgcHandler::start(settings);
    let elapsed = t0.elapsed().as_secs_f64();
    let cpu_100ns = process_cpu_100ns().saturating_sub(cpu0);

    if let Err(e) = run {
        return failed("windows-graphics-capture", format!("{e:?}"));
    }

    let mut acq = acquire_us.lock().map(|v| v.clone()).unwrap_or_default();
    let mut mp = map_us.lock().map(|v| v.clone()).unwrap_or_default();
    // Drop the first sample: it includes one-off session warm-up.
    if !acq.is_empty() {
        acq.remove(0);
    }
    if !mp.is_empty() {
        mp.remove(0);
    }
    acq.sort_unstable();
    mp.sort_unstable();

    let frames = shared.frames.load(Ordering::Relaxed);
    BackendResult {
        backend: if cap_fps.is_some() {
            "windows-graphics-capture@15fps"
        } else {
            "windows-graphics-capture"
        },
        ok: true,
        error: None,
        width: shared.width.load(Ordering::Relaxed) as u32,
        height: shared.height.load(Ordering::Relaxed) as u32,
        duration_s: elapsed,
        frames,
        fps: frames as f64 / elapsed.max(0.001),
        acquire_us_mean: mean(&acq),
        acquire_us_p50: percentile(&acq, 0.50),
        acquire_us_p95: percentile(&acq, 0.95),
        acquire_us_max: acq.last().copied().unwrap_or(0),
        map_us_mean: mean(&mp),
        map_us_p95: percentile(&mp, 0.95),
        cpu_percent_one_core: cpu_100ns as f64 / 10_000_000.0 / elapsed.max(0.001) * 100.0,
        cursor_included: true,
        notes: if cap_fps.is_some() {
            "shipping config: source-capped, cursor composited by the OS"
        } else {
            "event-driven; frames delivered only when the screen changes"
        },
    }
}

// --------------------------------------------------------------- DXGI backend

fn bench_dxgi(seconds: u64) -> BackendResult {
    let monitor = match Monitor::primary() {
        Ok(m) => m,
        Err(e) => {
            return failed(
                "dxgi-desktop-duplication",
                format!("Monitor::primary: {e:?}"),
            )
        }
    };
    let mut dupe = match DxgiDuplicationApi::new(monitor) {
        Ok(d) => d,
        Err(e) => {
            return failed(
                "dxgi-desktop-duplication",
                format!("DxgiDuplicationApi::new: {e:?}"),
            )
        }
    };

    let mut acq = Vec::<u64>::new();
    let mut mp = Vec::<u64>::new();
    let (mut w, mut h) = (0u32, 0u32);
    let mut frames = 0u64;

    let cpu0 = process_cpu_100ns();
    let t0 = Instant::now();
    let deadline = t0 + Duration::from_secs(seconds);

    while Instant::now() < deadline {
        let a0 = Instant::now();
        // 16ms ~ one 60Hz refresh: long enough to catch a frame, short enough that
        // an idle screen does not stall the loop.
        let got = dupe.acquire_next_frame(16);
        let a = a0.elapsed().as_micros() as u64;

        match got {
            Ok(mut frame) => {
                let m0 = Instant::now();
                let mapped = frame.buffer();
                let m = m0.elapsed().as_micros() as u64;
                if let Ok(buf) = mapped {
                    w = buf.width();
                    h = buf.height();
                    acq.push(a);
                    mp.push(m);
                    frames += 1;
                }
            }
            // A timeout means the screen did not change; it is not an error, and it
            // must not be counted as a frame.
            Err(_) => continue,
        }
    }

    let elapsed = t0.elapsed().as_secs_f64();
    let cpu_100ns = process_cpu_100ns().saturating_sub(cpu0);
    if !acq.is_empty() {
        acq.remove(0);
    }
    if !mp.is_empty() {
        mp.remove(0);
    }
    acq.sort_unstable();
    mp.sort_unstable();

    BackendResult {
        backend: "dxgi-desktop-duplication",
        ok: true,
        error: None,
        width: w,
        height: h,
        duration_s: elapsed,
        frames,
        fps: frames as f64 / elapsed.max(0.001),
        acquire_us_mean: mean(&acq),
        acquire_us_p50: percentile(&acq, 0.50),
        acquire_us_p95: percentile(&acq, 0.95),
        acquire_us_max: acq.last().copied().unwrap_or(0),
        map_us_mean: mean(&mp),
        map_us_p95: percentile(&mp, 0.95),
        cpu_percent_one_core: cpu_100ns as f64 / 10_000_000.0 / elapsed.max(0.001) * 100.0,
        // Desktop Duplication reports the cursor separately; it is not composited
        // into the frame, so an implementation must draw it itself.
        cursor_included: false,
        notes: "polled; cursor must be composited manually; breaks on desktop switch",
    }
}

fn failed(backend: &'static str, error: String) -> BackendResult {
    BackendResult {
        backend,
        ok: false,
        error: Some(error),
        width: 0,
        height: 0,
        duration_s: 0.0,
        frames: 0,
        fps: 0.0,
        acquire_us_mean: 0.0,
        acquire_us_p50: 0,
        acquire_us_p95: 0,
        acquire_us_max: 0,
        map_us_mean: 0.0,
        map_us_p95: 0,
        cpu_percent_one_core: 0.0,
        cursor_included: false,
        notes: "backend unavailable on this machine",
    }
}

#[derive(Serialize)]
struct Report {
    seconds_per_backend: u64,
    monitor: String,
    refresh_hz: u32,
    results: Vec<BackendResult>,
}

pub fn run() {
    let seconds: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    let (name, hz) = match Monitor::primary() {
        Ok(m) => (
            m.name().unwrap_or_else(|_| "unknown".into()),
            m.refresh_rate().unwrap_or(0),
        ),
        Err(_) => ("unknown".to_string(), 0),
    };

    eprintln!("capture-bench: {seconds}s per backend on \"{name}\" ({hz} Hz)\n");

    // DXGI first: WGC leaves a dispatcher queue on the thread, and running it last
    // keeps the two measurements independent.
    let dxgi = bench_dxgi(seconds);
    eprintln!(
        "  dxgi  : {:.1} fps, acquire p95 {} us, cpu {:.1}%",
        dxgi.fps, dxgi.acquire_us_p95, dxgi.cpu_percent_one_core
    );

    let wgc = bench_wgc(seconds, None);
    eprintln!(
        "  wgc   : {:.1} fps, delta p95 {} us, cpu {:.1}%",
        wgc.fps, wgc.acquire_us_p95, wgc.cpu_percent_one_core
    );

    let wgc15 = bench_wgc(seconds, Some(15));
    eprintln!(
        "  wgc@15: {:.1} fps, delta p95 {} us, cpu {:.1}%",
        wgc15.fps, wgc15.acquire_us_p95, wgc15.cpu_percent_one_core
    );

    let report = Report {
        seconds_per_backend: seconds,
        monitor: name,
        refresh_hz: hz,
        results: vec![wgc, wgc15, dxgi],
    };
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
