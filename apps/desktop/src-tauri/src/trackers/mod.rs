//! Background trackers (see docs/01-architecture.md).
//!
//! Currently: active-window + idle (task 7). Keyboard (17) and screenshots (19)
//! plug in later. Each tracker reads `TrackerControl` for live settings and writes
//! through `crate::storage`.
//!
//! The decision logic lives in `WindowTracker::tick`, a pure function over
//! (active?, window, threshold, now) → optional sample-to-flush, so it's unit
//! tested without real timers or platform calls.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use std::path::Path;

use chrono::{DateTime, Datelike, Timelike, Utc};
use chrono_tz::Tz;

pub mod os_state;

use crate::platform::ActiveWindowInfo;
use crate::storage::{ActivitySample, Db, Screenshot};

/// How often the active-window/idle loop polls.
const POLL: Duration = Duration::from_secs(1);
/// Seconds of active time each tick represents.
const TICK_S: i64 = 1;
/// Default idle threshold — no input for this long pauses time counting.
pub const DEFAULT_IDLE_THRESHOLD_S: u64 = 60;
/// Flush an ongoing interval at least this often so the dashboard stays fresh and
/// a crash can't lose more than this much active time.
const MAX_CHUNK_S: i64 = 60;

/// Live, shareable control surface for the trackers. The UI flips these (pause,
/// idle threshold) and the loop reads them each tick.
pub struct TrackerControl {
    pub paused: AtomicBool,
    /// Server-managed per-device switch. This is separate from the employee's
    /// local pause so clicking Resume cannot override an owner's fleet policy.
    pub monitoring_enabled: AtomicBool,
    /// Resolved F41 schedule by capture category. An absent key preserves the
    /// legacy behavior; a present but malformed timezone fails closed.
    pub monitoring_rules: RwLock<HashMap<String, MonitoringRule>>,
    pub idle_threshold_s: AtomicU64,
    pub screenshot_interval_s: AtomicU64,
    pub screenshot_retention_days: AtomicU64,
    /// Store only the site origin (scheme://host) for browser visits, not full URLs.
    pub domain_only: AtomicBool,
    /// Record browser URL + duration (extension preferred, Windows fallback).
    pub capture_browser_urls: AtomicBool,
    /// Last authenticated browser-extension ingest. The Windows address-bar
    /// fallback yields to it so one browsing interval is never stored twice.
    pub extension_last_seen: AtomicI64,
    /// Capture periodic screenshots (user opt-out; Windows: also gated on consent).
    pub capture_screenshots: AtomicBool,
    /// The retired still-screenshot pipeline may run at all.
    ///
    /// This is NOT a preference and NOT an opt-out -- those are
    /// `capture_screenshots` and `monitoring_rules`. Screen monitoring is video
    /// (docs/adr/0002-video-first-media-plane.md) and still images are no longer
    /// a monitoring artifact, so this defaults to **false** and only the
    /// platform, through `GET /v1/policy`, can raise it during the migration.
    ///
    /// It is deliberately independent of `managed_locked`: a device that is
    /// unmanaged, offline, standalone, or has never reached the backend also
    /// does not capture, because the default is off rather than on.
    pub still_capture_enabled: AtomicBool,
    /// SHOT_MODE_PRIVACY | SHOT_MODE_NORMAL.
    pub screenshot_mode: AtomicU8,
    /// Skip the whole capture tick while any of these apps is frontmost
    /// (case-insensitive whole-word match on the active window's app name).
    /// Prefilled with the curated sensitive-app rules by default; user-editable.
    pub screenshot_skip_apps: RwLock<Vec<String>>,
    /// Count keystrokes (user opt-out; Windows: also gated on consent).
    pub count_keystrokes: AtomicBool,
    /// The signed-in organization's capture policy is locked. Local pause/quit
    /// controls yield to this flag; the server-owned monitoring switch remains
    /// the authoritative way for the owner to stop collection.
    pub managed_locked: AtomicBool,
    /// Where the live-frame compression ladder succeeded last time. Live frames
    /// arrive about once a second and a screen's compressibility changes slowly,
    /// so resuming here turns the common case into a single encode instead of a
    /// full walk down the ladder (audit P0-3).
    pub remote_ladder_rung: AtomicUsize,
}

impl TrackerControl {
    pub fn new() -> Self {
        TrackerControl {
            paused: AtomicBool::new(false),
            monitoring_enabled: AtomicBool::new(true),
            monitoring_rules: RwLock::new(HashMap::new()),
            idle_threshold_s: AtomicU64::new(DEFAULT_IDLE_THRESHOLD_S),
            screenshot_interval_s: AtomicU64::new(DEFAULT_SCREENSHOT_INTERVAL_S),
            screenshot_retention_days: AtomicU64::new(DEFAULT_RETENTION_DAYS),
            domain_only: AtomicBool::new(false),
            capture_browser_urls: AtomicBool::new(true),
            extension_last_seen: AtomicI64::new(0),
            capture_screenshots: AtomicBool::new(true),
            still_capture_enabled: AtomicBool::new(false),
            screenshot_mode: AtomicU8::new(SHOT_MODE_PRIVACY),
            screenshot_skip_apps: RwLock::new(default_privacy_apps_flat()),
            count_keystrokes: AtomicBool::new(true),
            managed_locked: AtomicBool::new(false),
            remote_ladder_rung: AtomicUsize::new(0),
        }
    }

    pub fn is_capture_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed) || !self.monitoring_enabled.load(Ordering::Relaxed)
    }

    pub fn replace_monitoring_rules(&self, rules: HashMap<String, MonitoringRule>) {
        *self.monitoring_rules.write().unwrap() = rules;
    }

    pub fn category_schedule_allows(&self, key: &str) -> bool {
        self.monitoring_rules
            .read()
            .unwrap()
            .get(key)
            .map(|rule| rule.active_at(Utc::now()))
            .unwrap_or(true)
    }

    pub fn category_allowed(&self, key: &str) -> bool {
        !self.is_capture_paused() && self.category_schedule_allows(key)
    }
}

#[derive(Debug, Clone)]
pub struct MonitoringRule {
    pub enabled: bool,
    pub days_of_week: Vec<u8>,
    pub start_minute: u16,
    pub end_minute: u16,
    pub timezone: String,
}

impl MonitoringRule {
    fn active_at(&self, now: DateTime<Utc>) -> bool {
        if !self.enabled {
            return false;
        }
        let Ok(timezone) = self.timezone.parse::<Tz>() else {
            return false;
        };
        let local = now.with_timezone(&timezone);
        let minute = (local.hour() * 60 + local.minute()) as u16;
        let iso_day = local.weekday().number_from_monday() as u8;
        if self.start_minute == 0 && self.end_minute == 1440 {
            return self.days_of_week.contains(&iso_day);
        }
        if self.start_minute < self.end_minute {
            return self.days_of_week.contains(&iso_day)
                && minute >= self.start_minute
                && minute < self.end_minute;
        }
        if minute >= self.start_minute {
            return self.days_of_week.contains(&iso_day);
        }
        if minute < self.end_minute {
            let previous = (local - chrono::Duration::days(1))
                .weekday()
                .number_from_monday() as u8;
            return self.days_of_week.contains(&previous);
        }
        false
    }
}

/// Screenshot capture modes (see `Settings::screenshot_mode`): privacy captures
/// only the active window; normal captures every display.
pub const SHOT_MODE_PRIVACY: u8 = 0;
pub const SHOT_MODE_NORMAL: u8 = 1;

/// Map the persisted mode string to its atomic value. "full_screen" is the
/// pre-rename value of "normal"; anything else (including the pre-rename
/// "active_window" and unknown/future strings) falls back to privacy — the
/// default, and the mode that captures the least.
pub fn shot_mode_from_str(s: &str) -> u8 {
    match s {
        "normal" | "full_screen" => SHOT_MODE_NORMAL,
        _ => SHOT_MODE_PRIVACY,
    }
}

/// Baked-in copy of the curated sensitive-app list, grouped by category —
/// the offline fallback for the backend's `/v1/public/screenshot-privacy-apps`
/// (single source of truth: `handlers/privacyapps.go` — keep in sync). In
/// privacy mode a capture tick is skipped while any of these is frontmost.
pub const DEFAULT_PRIVACY_APPS: &[(&str, &[&str])] = &[
    (
        "Chat",
        &[
            "Zalo",
            "WhatsApp",
            "Telegram",
            "Signal",
            "Viber",
            "WeChat",
            "Weixin",
            "QQ",
            "LINE",
            "KakaoTalk",
            "Discord",
            "Messages",
            "FaceTime",
            "Element",
            "Threema",
            "Wire",
            "Beeper",
            "Ferdium",
            "Rambox",
            "Caprine",
        ],
    ),
    (
        "Security",
        &[
            "1Password",
            "Bitwarden",
            "LastPass",
            "KeePass",
            "KeePassXC",
            "Keeper",
            "NordPass",
            "Proton Pass",
            "Enpass",
            "RoboForm",
            "Keychain Access",
            "Passwords",
            "Ledger Live",
            "Trezor Suite",
            "Exodus",
            "Electrum",
            "Sparrow",
            "Proton VPN",
            "NordVPN",
            "TeamViewer",
            "AnyDesk",
        ],
    ),
    (
        "Work",
        &[
            "Slack",
            "Microsoft Teams",
            "Zoom",
            "zoom.us",
            "Webex",
            "DingTalk",
            "Lark",
            "Feishu",
            "Mattermost",
            "Rocket.Chat",
        ],
    ),
    (
        "Mail",
        &[
            "Mail",
            "Outlook",
            "Thunderbird",
            "Spark",
            "Proton Mail",
            "eM Client",
            "Mailbird",
            "Superhuman",
            "Airmail",
        ],
    ),
];

/// The baked-in list flattened for the matcher.
pub fn default_privacy_apps_flat() -> Vec<String> {
    DEFAULT_PRIVACY_APPS
        .iter()
        .flat_map(|(_, apps)| apps.iter().map(|a| a.to_string()))
        .collect()
}

impl Default for TrackerControl {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// In-progress active-window interval, accumulating ACTIVE seconds only.
#[derive(Clone)]
struct Interval {
    start_ts: i64,
    app_name: String,
    title: Option<String>,
    pid: Option<i64>,
    duration_s: i64,
}

impl Interval {
    fn sample(&self) -> ActivitySample {
        ActivitySample {
            ts: self.start_ts,
            app_name: self.app_name.clone(),
            window_title: self.title.clone(),
            pid: self.pid,
            duration_s: self.duration_s,
        }
    }
}

/// Pure decision core for active-window tracking. Holds the open interval; each
/// `tick` returns `Some(sample)` when an interval should be persisted.
#[derive(Default)]
pub struct WindowTracker {
    current: Option<Interval>,
}

impl WindowTracker {
    /// Advance one poll step.
    /// - `active`: is the user present (idle < threshold) and not paused?
    /// - `win`: the foreground window, if any.
    ///
    /// Returns a sample to flush, or `None`.
    fn tick(
        &mut self,
        active: bool,
        win: Option<ActiveWindowInfo>,
        threshold_s: i64,
        now: i64,
    ) -> Option<ActivitySample> {
        // Not active (idle / paused) or no foreground window → close any interval.
        if !active {
            return self.close_idle(threshold_s);
        }
        let win = match win {
            Some(w) => w,
            None => return self.close(),
        };

        match self.current {
            Some(ref mut iv) if iv.app_name == win.app_name && iv.title == win.title => {
                iv.duration_s += TICK_S;
                if iv.duration_s >= MAX_CHUNK_S {
                    // Persist the chunk, then keep counting the same window fresh.
                    let out = iv.sample();
                    iv.start_ts = now;
                    iv.duration_s = 0;
                    Some(out)
                } else {
                    None
                }
            }
            _ => {
                let flushed = self.current.take().map(|iv| iv.sample());
                self.current = Some(Interval {
                    start_ts: now,
                    app_name: win.app_name,
                    title: win.title,
                    pid: Some(win.pid),
                    duration_s: TICK_S,
                });
                flushed
            }
        }
    }

    /// Close the interval because we went idle: drop the grace window we counted
    /// before detecting idle (retroactive trim), then emit it.
    fn close_idle(&mut self, threshold_s: i64) -> Option<ActivitySample> {
        self.current.take().and_then(|mut iv| {
            iv.duration_s = (iv.duration_s - threshold_s).max(0);
            if iv.duration_s > 0 {
                Some(iv.sample())
            } else {
                None
            }
        })
    }

    /// Close the interval as-is (e.g. no foreground window).
    fn close(&mut self) -> Option<ActivitySample> {
        self.current
            .take()
            .filter(|iv| iv.duration_s > 0)
            .map(|iv| iv.sample())
    }
}

/// Spawn the active-window + idle tracker on a background thread.
pub fn start(db: Arc<Db>, control: Arc<TrackerControl>) {
    thread::spawn(move || run(db, control));
}

// ---------- Windows browser address-bar fallback ----------

/// The extension reports at one-minute checkpoints. Keep native observations in
/// memory for longer than that before persisting them; if an authenticated
/// extension ingest arrives, discard the buffer and let the richer extension
/// record win. This prevents duplicate time while still supporting an install
/// with no extension.
#[cfg(any(target_os = "windows", test))]
const BROWSER_FALLBACK_GRACE_S: i64 = 90;
#[cfg(any(target_os = "windows", test))]
const BROWSER_FALLBACK_CHUNK_S: i64 = 60;

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct BrowserObservation {
    url: String,
    page_title: Option<String>,
    browser: String,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone)]
struct BrowserInterval {
    start_ts: i64,
    last_ts: i64,
    observation: BrowserObservation,
    duration_s: i64,
}

#[cfg(any(target_os = "windows", test))]
impl BrowserInterval {
    fn visit(self) -> Option<crate::storage::BrowserVisit> {
        (self.duration_s > 0).then_some(crate::storage::BrowserVisit {
            ts: self.start_ts,
            url: self.observation.url,
            page_title: self.observation.page_title,
            browser: Some(self.observation.browser),
            duration_s: self.duration_s,
        })
    }
}

#[cfg(any(target_os = "windows", test))]
#[derive(Default)]
struct BrowserFallbackTracker {
    current: Option<BrowserInterval>,
    pending: Vec<crate::storage::BrowserVisit>,
}

#[cfg(any(target_os = "windows", test))]
impl BrowserFallbackTracker {
    fn close_current(&mut self) {
        if let Some(visit) = self.current.take().and_then(BrowserInterval::visit) {
            self.pending.push(visit);
        }
    }

    /// Advance the native fallback and return visits old enough to be sure the
    /// extension did not report them. `active=false` closes the current page.
    fn tick(
        &mut self,
        active: bool,
        observation: Option<BrowserObservation>,
        extension_seen_at: i64,
        now: i64,
    ) -> Vec<crate::storage::BrowserVisit> {
        let extension_is_fresh = extension_seen_at > 0
            && now.saturating_sub(extension_seen_at) <= BROWSER_FALLBACK_GRACE_S;
        if extension_is_fresh {
            self.current = None;
            self.pending.clear();
            return Vec::new();
        }

        let observation = active.then_some(observation).flatten();
        match (self.current.as_mut(), observation) {
            (Some(cur), Some(next)) if cur.observation == next => {
                // A delayed poll must not invent a long active interval after
                // sleep/resume. The idle gate handles ordinary inactivity.
                let elapsed = now.saturating_sub(cur.last_ts).min(5);
                cur.duration_s += elapsed;
                cur.last_ts = now;
                if cur.duration_s >= BROWSER_FALLBACK_CHUNK_S {
                    self.close_current();
                    self.current = Some(BrowserInterval {
                        start_ts: now,
                        last_ts: now,
                        observation: next,
                        duration_s: 0,
                    });
                }
            }
            (_, Some(next)) => {
                self.close_current();
                self.current = Some(BrowserInterval {
                    start_ts: now,
                    last_ts: now,
                    observation: next,
                    duration_s: 0,
                });
            }
            (_, None) => self.close_current(),
        }

        let mut ready = Vec::new();
        self.pending.retain(|visit| {
            if now.saturating_sub(visit.ts) >= BROWSER_FALLBACK_GRACE_S {
                ready.push(visit.clone());
                false
            } else {
                true
            }
        });
        ready
    }
}

/// On Windows, read only the foreground browser's accessibility address-bar
/// value. It is separately opt-out/consent/schedule gated and yields to the
/// browser extension whenever the extension is active.
#[cfg(target_os = "windows")]
pub fn start_browser_fallback(db: Arc<Db>, control: Arc<TrackerControl>) {
    thread::spawn(move || {
        let Some(reader) = crate::platform::BrowserUrlReader::new() else {
            crate::log_warn!("browser-fallback", "Windows UI Automation unavailable");
            return;
        };
        let mut tracker = BrowserFallbackTracker::default();
        loop {
            thread::sleep(Duration::from_secs(2));
            let now = now_ts();
            let enabled = control.category_allowed("websites")
                && control.capture_browser_urls.load(Ordering::Relaxed)
                && crate::platform::idle_seconds()
                    < control.idle_threshold_s.load(Ordering::Relaxed) as f64;
            let observation = if enabled {
                crate::platform::active_window().and_then(|active| {
                    reader.read(&active).map(|address| BrowserObservation {
                        url: address.url,
                        page_title: active.title,
                        browser: address.browser,
                    })
                })
            } else {
                None
            };
            let extension_seen = control.extension_last_seen.load(Ordering::Relaxed);
            for mut visit in tracker.tick(enabled, observation, extension_seen, now) {
                if control.domain_only.load(Ordering::Relaxed) {
                    visit.url = crate::server::origin_only(&visit.url);
                    visit.page_title = None;
                }
                if let Err(e) = db.insert_browser_visit(&visit, None) {
                    crate::log_warn!("browser-fallback", "failed to write browser visit: {e}");
                }
            }
        }
    });
}

// ---------- keyboard counter (task 17) ----------

/// Keypress counts are flushed at this cadence.
const KEY_FLUSH: Duration = Duration::from_secs(15);
/// Counts are bucketed by this window (start-of-bucket epoch is the key).
const KEY_BUCKET_S: i64 = 60;

/// Default seconds between periodic screenshots.
pub const DEFAULT_SCREENSHOT_INTERVAL_S: u64 = 300;

/// Default days to keep screenshots before cleanup.
pub const DEFAULT_RETENTION_DAYS: u64 = 30;

/// Spawn the keyboard counter: a minimal CoreGraphics tap that only *counts* key
/// presses (the key is never decoded or stored — see `platform::run_keyboard_tap`),
/// plus a flusher that writes per-minute counts. Pause-aware.
pub fn start_keyboard(db: Arc<Db>, control: Arc<TrackerControl>) {
    // Flusher: move the tap's running count into the current bucket.
    {
        thread::spawn(move || loop {
            thread::sleep(KEY_FLUSH);
            let n = crate::platform::KEY_PRESS_COUNT.swap(0, Ordering::Relaxed);
            // Drop counts accumulated while paused or with keystroke counting opted
            // out / not yet consented (don't persist them).
            if n > 0
                && control.category_allowed("keystrokes")
                && control.count_keystrokes.load(Ordering::Relaxed)
            {
                let now = now_ts();
                let bucket = now - now.rem_euclid(KEY_BUCKET_S);
                if let Err(e) = db.add_keystrokes(bucket, n as i64) {
                    crate::log_warn!("keyboard", "failed to write keystroke_bucket: {e}");
                }
            }
        });
    }

    // Tap: blocks while active; returns if it can't be created (permission not yet
    // granted) — retry so it starts as soon as the user grants Input Monitoring.
    // Only attempt once granted: the bare CGEventTapCreate attempt registers the
    // app with TCC and can surface the OS prompt, which must stay user-initiated.
    thread::spawn(|| loop {
        use crate::platform::{permission_status, Permission, PermissionState};
        if permission_status(Permission::InputMonitoring) == PermissionState::Granted {
            crate::platform::run_keyboard_tap();
        }
        thread::sleep(Duration::from_secs(3));
    });
}

// ---------- screenshots (task 19) ----------

/// Whether the retired still-screenshot pipeline may produce an image right now.
///
/// Checked on every capture attempt rather than once at startup, so a policy
/// fetch that closes the pipeline stops capture without waiting for a restart.
/// See `TrackerControl::still_capture_enabled`.
pub fn still_capture_permitted(control: &TrackerControl) -> bool {
    control.still_capture_enabled.load(Ordering::Relaxed)
}

/// Hard ceiling on a stored/uploaded screenshot. The backend enforces its own
/// (larger) guard; we keep every shot comfortably under this. See docs/11.
const SCREENSHOT_MAX_BYTES: usize = 50 * 1024;

/// Candidate long-edge sizes (px) and WebP qualities, tried in order. We step
/// quality down first, then resolution, until a shot fits SCREENSHOT_MAX_BYTES.
const SHOT_MAX_DIMS: [u32; 3] = [1366, 1152, 960];
const SHOT_QUALITIES: [f32; 5] = [55.0, 45.0, 35.0, 25.0, 20.0];
const REMOTE_FRAME_MAX_BYTES: usize = 180 * 1024;
const REMOTE_FRAME_MAX_DIMS: [u32; 4] = [1600, 1366, 1152, 960];
const REMOTE_FRAME_QUALITIES: [f32; 5] = [65.0, 55.0, 45.0, 35.0, 25.0];

pub struct RemoteFrame {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Downscale to a max long-edge and encode lossy WebP, returning the smallest
/// result that fits SCREENSHOT_MAX_BYTES. If even the floor (smallest dims +
/// lowest quality) exceeds the cap, the smallest encoding produced is returned.
/// Returns the encoded bytes plus the final (width, height).
fn compress_to_webp(img: &xcap::image::RgbaImage) -> (Vec<u8>, u32, u32) {
    compress_webp_to_limit(img, &SHOT_MAX_DIMS, &SHOT_QUALITIES, SCREENSHOT_MAX_BYTES)
}

/// Downscale to `max_dim` on the long edge, or `None` when the image already fits
/// and can be encoded in place. Returning `None` rather than a copy matters: the
/// source is a full-screen RGBA buffer (14 MB at 2560x1440).
fn scaled_to(img: &xcap::image::RgbaImage, max_dim: u32) -> Option<xcap::image::RgbaImage> {
    use xcap::image::imageops::{self, FilterType};

    let (ow, oh) = (img.width(), img.height());
    if ow.max(oh) <= max_dim {
        return None;
    }
    let scale = max_dim as f32 / ow.max(oh) as f32;
    let nw = (ow as f32 * scale).round().max(1.0) as u32;
    let nh = (oh as f32 * scale).round().max(1.0) as u32;
    Some(imageops::resize(img, nw, nh, FilterType::Triangle))
}

/// A frame that fit the cap, plus the rung of the ladder that produced it.
struct LadderResult {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    /// Flat index into the (dims x qualities) ladder — feed back as `start`.
    rung: usize,
}

/// Walk the (resolution, quality) ladder from `start` and return the first
/// encoding at or under `max_bytes`.
///
/// `start` exists because this is called once per live frame, and a screen does
/// not usually change compressibility between frames. Restarting at the top every
/// time made a dense screen cost up to 4 resizes + 20 WebP encodes per frame —
/// measured at 456 ms against a 900 ms frame interval, i.e. more than half a core
/// on the fastest hardware available (see docs/FULL_SYSTEM_AUDIT.md §3.2).
/// Resuming where the last frame succeeded makes the common case a single encode.
fn compress_ladder(
    img: &xcap::image::RgbaImage,
    max_dims: &[u32],
    qualities: &[f32],
    max_bytes: usize,
    start: usize,
) -> LadderResult {
    let rungs = max_dims.len() * qualities.len();
    let start = start.min(rungs.saturating_sub(1));

    let mut smallest: Option<LadderResult> = None;
    // The resize is the expensive half, so it is done once per resolution and
    // reused across that resolution's quality attempts.
    let mut current_dim = usize::MAX;
    let mut owned: Option<xcap::image::RgbaImage> = None;

    for rung in start..rungs {
        let dim_i = rung / qualities.len();
        if dim_i != current_dim {
            current_dim = dim_i;
            owned = scaled_to(img, max_dims[dim_i]);
        }
        let src = owned.as_ref().unwrap_or(img);
        let (w, h) = (src.width(), src.height());

        let bytes = webp::Encoder::from_rgba(src.as_raw(), w, h)
            .encode(qualities[rung % qualities.len()])
            .to_vec();

        if bytes.len() <= max_bytes {
            return LadderResult {
                bytes,
                width: w,
                height: h,
                rung,
            };
        }
        if smallest
            .as_ref()
            .is_none_or(|best| bytes.len() < best.bytes.len())
        {
            smallest = Some(LadderResult {
                bytes,
                width: w,
                height: h,
                rung,
            });
        }
    }

    // Nothing fit the cap (an extremely detailed screen) — keep the smallest. If
    // `start` was already the floor, that single attempt is the result.
    smallest.expect("at least one encoding attempt")
}

/// Ladder entry point for callers with no hint to carry (periodic screenshots,
/// which run minutes apart, so resuming would not pay for itself).
fn compress_webp_to_limit(
    img: &xcap::image::RgbaImage,
    max_dims: &[u32],
    qualities: &[f32],
    max_bytes: usize,
) -> (Vec<u8>, u32, u32) {
    let out = compress_ladder(img, max_dims, qualities, max_bytes, 0);
    (out.bytes, out.width, out.height)
}

/// Capture the primary screen for an accepted remote-assistance session without
/// writing it to the activity database. The configured sensitive-app skip list
/// remains authoritative even during support.
pub fn capture_remote_frame(control: &TrackerControl) -> Option<RemoteFrame> {
    if let Some(active) = crate::platform::active_window() {
        let skip = control.screenshot_skip_apps.read().unwrap();
        if should_skip(&active.app_name, &skip) {
            return None;
        }
    }

    let monitor = xcap::Monitor::all().ok()?.into_iter().next()?;
    let image = monitor.capture_image().ok()?;

    let start = control.remote_ladder_rung.load(Ordering::Relaxed);
    let out = compress_ladder(
        &image,
        &REMOTE_FRAME_MAX_DIMS,
        &REMOTE_FRAME_QUALITIES,
        REMOTE_FRAME_MAX_BYTES,
        start,
    );

    // Remember where this frame landed. When the result is comfortably under the
    // cap the screen has become easier to compress, so aim one rung higher next
    // time; that way a temporarily busy screen does not permanently degrade
    // quality for the rest of the session. Costs nothing extra: the recovery
    // attempt is the next frame's first encode either way.
    let next = if out.bytes.len() * 100 < REMOTE_FRAME_MAX_BYTES * 55 {
        out.rung.saturating_sub(1)
    } else {
        out.rung
    };
    control.remote_ladder_rung.store(next, Ordering::Relaxed);

    Some(RemoteFrame {
        bytes: out.bytes,
        width: out.width,
        height: out.height,
    })
}

/// The active app is on the privacy skip-list. Forgiving match: case-insensitive,
/// and the entry only has to appear as a whole word in the reported app name —
/// "Zalo" matches "zalo", "Zalo PC", and "zalo - the best app", while "LINE"
/// does not match "Outline".
pub(crate) fn should_skip(app_name: &str, skip_apps: &[String]) -> bool {
    let name = app_name.to_lowercase();
    skip_apps.iter().any(|s| {
        let pat = s.trim().to_lowercase();
        !pat.is_empty() && contains_word(&name, &pat)
    })
}

/// `pat` occurs in `name` bounded by non-alphanumeric characters (or the string
/// ends), so partial words never match.
fn contains_word(name: &str, pat: &str) -> bool {
    let mut from = 0;
    while let Some(off) = name[from..].find(pat) {
        let b = from + off;
        let e = b + pat.len();
        let before = name[..b].chars().next_back();
        let after = name[e..].chars().next();
        if before.is_none_or(|c| !c.is_alphanumeric()) && after.is_none_or(|c| !c.is_alphanumeric())
        {
            return true;
        }
        from = b + name[b..].chars().next().map_or(1, |c| c.len_utf8());
    }
    false
}

/// Active-window mode: capture only the frontmost window. Candidates are the
/// app's (pid-matched) non-minimized windows; among them prefer the one whose
/// title equals the active window's title, then the topmost by z-order — an app
/// can have several windows (e.g. two Chrome windows) and size says nothing
/// about which is in front. Returns `None` on any lookup/capture miss so the
/// caller falls back to a full-screen shot.
fn capture_active_window(
    db: &Db,
    dir: &Path,
    active: &ActiveWindowInfo,
    now: i64,
) -> Option<usize> {
    let windows = xcap::Window::all().ok()?;
    let title = active.title.as_deref().unwrap_or("");
    let win = windows
        .into_iter()
        .filter(|w| {
            w.pid().map(|p| p as i64 == active.pid).unwrap_or(false)
                && !w.is_minimized().unwrap_or(true)
        })
        .max_by_key(|w| {
            let title_match = !title.is_empty() && w.title().map(|t| t == title).unwrap_or(false);
            (title_match, w.z().unwrap_or(i32::MIN))
        })?;
    let img = win.capture_image().ok()?;
    let (bytes, w, h) = compress_to_webp(&img);
    let path = dir.join(format!("{now}_window.webp"));
    if let Err(e) = std::fs::write(&path, &bytes) {
        crate::log_warn!("screenshot", "save failed: {e}");
        return None;
    }
    let shot = Screenshot {
        ts: now,
        file_path: path.to_string_lossy().into_owned(),
        display_id: None,
        width: Some(w as i64),
        height: Some(h as i64),
    };
    if let Err(e) = db.insert_screenshot(&shot) {
        crate::log_warn!("screenshot", "db insert failed: {e}");
        return None;
    }
    Some(1)
}

/// Take one capture tick: skip entirely when the frontmost app is on the
/// skip-list; otherwise capture per the configured mode (active-window shots
/// fall back to full screen on a miss), compress to ≤50 KB WebP under `dir`,
/// and record each shot in the DB. Returns how many shots were saved.
/// Requires Screen Recording.
pub fn capture_once(db: &Db, dir: &Path, control: &TrackerControl) -> usize {
    // The authoritative gate. This function is the only place a still image is
    // written to disk and to the local database, so the check lives here rather
    // than only in its callers: a future caller cannot reintroduce stored
    // screenshots by forgetting it.
    if !still_capture_permitted(control) {
        return 0;
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        crate::log_warn!("screenshot", "create dir failed: {e}");
        return 0;
    }

    let mode = control.screenshot_mode.load(Ordering::Relaxed);
    let active = crate::platform::active_window();
    // The skip-list is a privacy-mode feature (normal mode captures everything).
    if mode == SHOT_MODE_PRIVACY {
        if let Some(ref win) = active {
            let skip = control.screenshot_skip_apps.read().unwrap();
            if should_skip(&win.app_name, &skip) {
                crate::log_info!(
                    "screenshot",
                    "skipped tick: {} is on the skip-list",
                    win.app_name
                );
                return 0;
            }
        }
    }

    let now = now_ts();
    if mode == SHOT_MODE_PRIVACY {
        if let Some(saved) = active
            .as_ref()
            .and_then(|win| capture_active_window(db, dir, win, now))
        {
            return saved;
        }
        // Frontmost window not capturable (desktop focus, transient surface,
        // window gone) — never silently drop the tick: full-screen fallback.
        crate::log_info!(
            "screenshot",
            "active-window capture missed; falling back to full screen"
        );
    }

    let monitors = match xcap::Monitor::all() {
        Ok(m) => m,
        Err(e) => {
            crate::log_warn!("screenshot", "enumerate monitors failed: {e}");
            return 0;
        }
    };

    let mut saved = 0;
    for (i, monitor) in monitors.into_iter().enumerate() {
        let img = match monitor.capture_image() {
            Ok(img) => img,
            Err(e) => {
                crate::log_warn!("screenshot", "capture failed: {e}");
                continue;
            }
        };
        // Compress to a small WebP; store the *encoded* dimensions so width/height
        // match the bytes on disk (and what the backend records).
        let (bytes, w, h) = compress_to_webp(&img);
        let path = dir.join(format!("{now}_display{i}.webp"));
        if let Err(e) = std::fs::write(&path, &bytes) {
            crate::log_warn!("screenshot", "save failed: {e}");
            continue;
        }
        let shot = Screenshot {
            ts: now,
            file_path: path.to_string_lossy().into_owned(),
            display_id: Some(i as i64),
            width: Some(w as i64),
            height: Some(h as i64),
        };
        if let Err(e) = db.insert_screenshot(&shot) {
            crate::log_warn!("screenshot", "db insert failed: {e}");
            continue;
        }
        saved += 1;
    }
    saved
}

/// Spawn the screenshot retention job (task 29): periodically delete screenshots
/// older than the configured age cap, removing both files and DB rows.
pub fn start_cleanup(db: Arc<Db>, control: Arc<TrackerControl>) {
    thread::spawn(move || loop {
        let days = control
            .screenshot_retention_days
            .load(Ordering::Relaxed)
            .max(1);
        let cutoff = now_ts() - (days as i64) * 86_400;
        match db.delete_screenshots_before(cutoff) {
            Ok(paths) => {
                for p in paths {
                    let _ = std::fs::remove_file(&p);
                }
            }
            Err(e) => crate::log_warn!("cleanup", "screenshot prune failed: {e}"),
        }
        // Run hourly (and once shortly after startup via the first sleep being short).
        thread::sleep(Duration::from_secs(3600));
    });
}

/// Spawn the periodic screenshot taker. Permission-gated and pause-aware.
///
/// The loop itself is retired: `still_capture_enabled` defaults to false, so this
/// thread parks on its interval and captures nothing unless the platform
/// re-opens the legacy pipeline for a migration deploy. The thread is still
/// spawned rather than skipped so that a policy fetch can take effect without a
/// restart -- and so the gate is evaluated per tick, not once at startup.
pub fn start_screenshots(db: Arc<Db>, control: Arc<TrackerControl>, dir: std::path::PathBuf) {
    use crate::platform::{permission_status, Permission, PermissionState};
    thread::spawn(move || loop {
        let interval = control.screenshot_interval_s.load(Ordering::Relaxed).max(5);
        thread::sleep(Duration::from_secs(interval));
        if !still_capture_permitted(&control) {
            continue;
        }
        if !control.category_allowed("screen") {
            continue;
        }
        // Opt-out (and, on Windows, consent) gate.
        if !control.capture_screenshots.load(Ordering::Relaxed) {
            continue;
        }
        if permission_status(Permission::ScreenRecording) != PermissionState::Granted {
            continue;
        }
        capture_once(&db, &dir, &control);
    });
}

fn run(db: Arc<Db>, control: Arc<TrackerControl>) {
    let mut tracker = WindowTracker::default();
    // Runs alongside the window tracker on the same poll: one records which app
    // had focus, the other records what the machine itself was doing, so idle and
    // suspended time exist as data instead of as missing rows (audit P0-2).
    let mut states = os_state::StateTracker::default();

    loop {
        thread::sleep(POLL);

        let threshold = control.idle_threshold_s.load(Ordering::Relaxed) as i64;
        let paused = !control.category_allowed("applications");
        // Idle covers screen-locked / display-asleep too: no input → idle grows.
        let idle = crate::platform::idle_seconds();
        let active = !paused && idle < threshold as f64;
        let now = now_ts();

        let win = if active {
            crate::platform::active_window()
        } else {
            None
        };

        if let Some(sample) = tracker.tick(active, win, threshold, now) {
            if sample.duration_s > 0 {
                if let Err(e) = db.insert_activity_sample(&sample) {
                    crate::log_warn!("tracker", "failed to write activity_sample: {e}");
                    crate::obs::capture_error(&e);
                }
            }
        }

        let closed = states.tick(now, idle, threshold, !paused);
        if !closed.is_empty() {
            let rows: Vec<crate::storage::OsStateRow> = closed
                .iter()
                .map(|s| crate::storage::OsStateRow {
                    ts: s.start_ts,
                    state: s.state.as_str().to_string(),
                    duration_s: s.duration_s,
                })
                .collect();
            if let Err(e) = db.insert_os_states(&rows) {
                crate::log_warn!("tracker", "failed to write os_state: {e}");
                crate::obs::capture_error(&e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The retirement is a default, not a configuration step. A device that has
    /// never contacted the backend -- fresh install, standalone, offline -- must
    /// already be off, because it is the absence of a signal, not its presence,
    /// that has to be safe.
    #[test]
    fn still_capture_is_off_until_the_platform_says_otherwise() {
        let control = TrackerControl::new();
        assert!(
            !still_capture_permitted(&control),
            "a new TrackerControl must not permit still capture"
        );

        control.still_capture_enabled.store(true, Ordering::Relaxed);
        assert!(still_capture_permitted(&control));

        control
            .still_capture_enabled
            .store(false, Ordering::Relaxed);
        assert!(
            !still_capture_permitted(&control),
            "closing the pipeline mid-session must take effect immediately"
        );
    }

    /// capture_once is the only writer of stored screenshots, so the gate has to
    /// hold there even when every other condition would allow a capture: an
    /// unpaused device, the screen category allowed, the opt-in on.
    #[test]
    fn capture_once_writes_nothing_while_still_capture_is_retired() {
        let dir =
            std::env::temp_dir().join(format!("ctracking-v02-{}-{}", std::process::id(), now_ts()));
        let db = Db::open_in_memory().expect("in-memory db");
        let control = TrackerControl::new();
        control.capture_screenshots.store(true, Ordering::Relaxed);
        control.monitoring_enabled.store(true, Ordering::Relaxed);

        let saved = capture_once(&db, &dir, &control);

        assert_eq!(saved, 0, "capture_once saved {saved} shot(s) while retired");
        assert!(
            !dir.exists(),
            "capture_once created {} -- it must return before touching the filesystem",
            dir.display()
        );
        assert_eq!(
            db.screenshots_between(0, i64::MAX).unwrap().len(),
            0,
            "a screenshot row was written while the pipeline is retired"
        );
    }

    fn win(app: &str, title: &str) -> ActiveWindowInfo {
        ActiveWindowInfo {
            app_name: app.to_string(),
            title: Some(title.to_string()),
            pid: 1,
        }
    }

    /// Build a synthetic "screen": a smooth gradient (compresses well) plus a
    /// noisy strip (hard to compress), at a large 2560x1440 so resolution must
    /// be reduced. Exercises the full quality+resolution fallback.
    fn synthetic_screen() -> xcap::image::RgbaImage {
        let (w, h) = (2560u32, 1440u32);
        xcap::image::RgbaImage::from_fn(w, h, |x, y| {
            let noisy = y < h / 4; // top quarter is high-frequency noise
            let n = if noisy {
                ((x.wrapping_mul(2654435761)
                    .wrapping_add(y.wrapping_mul(40503)))
                    & 0xFF) as u8
            } else {
                0
            };
            xcap::image::Rgba([
                ((x * 255 / w) as u8).wrapping_add(n),
                ((y * 255 / h) as u8).wrapping_add(n),
                128u8.wrapping_add(n),
                255,
            ])
        })
    }

    #[test]
    fn screenshot_compresses_under_cap() {
        let img = synthetic_screen();
        let (bytes, w, h) = compress_to_webp(&img);
        assert!(
            bytes.len() <= SCREENSHOT_MAX_BYTES,
            "compressed size {} exceeds cap {}",
            bytes.len(),
            SCREENSHOT_MAX_BYTES
        );
        // It's a valid WebP (RIFF....WEBP container).
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WEBP");
        // Large source → downscaled to one of the candidate long edges.
        assert!(w.max(h) <= SHOT_MAX_DIMS[0], "not downscaled: {w}x{h}");
        assert!(w > 0 && h > 0);
    }

    #[test]
    fn small_screen_not_upscaled() {
        // A source already under the smallest candidate keeps its dimensions.
        let img =
            xcap::image::RgbaImage::from_pixel(800, 600, xcap::image::Rgba([20, 60, 90, 255]));
        let (bytes, w, h) = compress_to_webp(&img);
        assert!(bytes.len() <= SCREENSHOT_MAX_BYTES);
        assert_eq!((w, h), (800, 600));
    }

    #[test]
    fn skip_list_matches_whole_words_case_insensitively() {
        let list = vec![
            "Zalo".to_string(),
            "keychain access".to_string(),
            "LINE".to_string(),
        ];
        assert!(should_skip("Zalo", &list));
        assert!(should_skip("zalo", &list));
        assert!(should_skip("ZALO", &list));
        assert!(should_skip("Zalo PC", &list));
        assert!(should_skip("zalo - the best app", &list));
        assert!(should_skip("zalo.exe", &list));
        assert!(should_skip("Keychain Access", &list));
        assert!(should_skip("line", &list));
        // Whole words only — no partial-word matching.
        assert!(!should_skip("Outline", &list));
        assert!(!should_skip("Zalos", &list));
        assert!(!should_skip("Slack", &list));
        assert!(!should_skip("Anything", &[]));
        // Blank entries never match everything.
        assert!(!should_skip("Anything", &["  ".to_string()]));
    }

    #[test]
    fn shot_mode_parses_with_safe_fallback() {
        assert_eq!(shot_mode_from_str("privacy"), SHOT_MODE_PRIVACY);
        assert_eq!(shot_mode_from_str("normal"), SHOT_MODE_NORMAL);
        // Pre-rename values from old settings.json / policies.
        assert_eq!(shot_mode_from_str("full_screen"), SHOT_MODE_NORMAL);
        assert_eq!(shot_mode_from_str("active_window"), SHOT_MODE_PRIVACY);
        // Unknown / future values fall back to privacy (captures the least).
        assert_eq!(shot_mode_from_str(""), SHOT_MODE_PRIVACY);
        assert_eq!(shot_mode_from_str("blur"), SHOT_MODE_PRIVACY);
    }

    #[test]
    fn baked_privacy_apps_cover_known_sensitive_apps() {
        let apps = default_privacy_apps_flat();
        assert!(apps.len() > 50);
        // Spot-check the matcher against reported-name variants.
        assert!(should_skip("Zalo", &apps));
        assert!(should_skip("Telegram Desktop", &apps));
        assert!(should_skip("zoom.us", &apps));
        assert!(should_skip("Weixin", &apps));
        assert!(should_skip("Microsoft Outlook", &apps));
        assert!(!should_skip("Google Chrome", &apps));
        assert!(!should_skip("Visual Studio Code", &apps));
    }

    #[test]
    fn accumulates_then_flushes_on_window_change() {
        let mut t = WindowTracker::default();
        // Same window for 3 ticks → no flush yet.
        assert!(t.tick(true, Some(win("Code", "a")), 60, 100).is_none());
        assert!(t.tick(true, Some(win("Code", "a")), 60, 101).is_none());
        assert!(t.tick(true, Some(win("Code", "a")), 60, 102).is_none());
        // Switch window → previous interval flushes with 3s.
        let flushed = t.tick(true, Some(win("Chrome", "b")), 60, 103).unwrap();
        assert_eq!(flushed.app_name, "Code");
        assert_eq!(flushed.duration_s, 3);
        assert_eq!(flushed.ts, 100);
    }

    #[test]
    fn idle_trims_grace_window() {
        let mut t = WindowTracker::default();
        let threshold = 5;
        // 8 active ticks on one window.
        for i in 0..8 {
            assert!(t
                .tick(true, Some(win("Code", "a")), threshold, 100 + i)
                .is_none());
        }
        // Go idle → trim `threshold` seconds of grace from the 8 counted.
        let flushed = t.tick(false, None, threshold, 108).unwrap();
        assert_eq!(flushed.duration_s, 8 - threshold);
    }

    #[test]
    fn short_interval_fully_idle_writes_nothing() {
        let mut t = WindowTracker::default();
        let threshold = 60;
        // Only 2s of activity, then idle: 2 - 60 clamps to 0 → no row.
        t.tick(true, Some(win("Code", "a")), threshold, 100);
        t.tick(true, Some(win("Code", "a")), threshold, 101);
        assert!(t.tick(false, None, threshold, 102).is_none());
    }

    #[test]
    fn long_interval_chunks_at_max() {
        let mut t = WindowTracker::default();
        let mut flushes = 0;
        // Run one window for MAX_CHUNK_S + a bit; expect a chunk flush at the cap.
        for i in 0..(MAX_CHUNK_S + 3) {
            if t.tick(true, Some(win("Code", "a")), 600, 100 + i).is_some() {
                flushes += 1;
            }
        }
        assert_eq!(flushes, 1, "should flush exactly one chunk at the cap");
    }

    #[test]
    fn no_foreground_window_closes_interval() {
        let mut t = WindowTracker::default();
        t.tick(true, Some(win("Code", "a")), 60, 100);
        t.tick(true, Some(win("Code", "a")), 60, 101);
        // Active but no foreground window → flush what we had.
        let flushed = t.tick(true, None, 60, 102).unwrap();
        assert_eq!(flushed.app_name, "Code");
        assert_eq!(flushed.duration_s, 2);
    }

    #[test]
    fn monitoring_rule_handles_overnight_window() {
        let rule = MonitoringRule {
            enabled: true,
            days_of_week: vec![1],
            start_minute: 22 * 60,
            end_minute: 2 * 60,
            timezone: "UTC".into(),
        };
        let monday = DateTime::parse_from_rfc3339("2026-08-24T22:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let tuesday_inside = DateTime::parse_from_rfc3339("2026-08-25T01:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let tuesday_outside = DateTime::parse_from_rfc3339("2026-08-25T02:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(rule.active_at(monday));
        assert!(rule.active_at(tuesday_inside));
        assert!(!rule.active_at(tuesday_outside));
    }

    #[test]
    fn monitoring_rule_handles_dst_and_invalid_timezone_safely() {
        let mut rule = MonitoringRule {
            enabled: true,
            days_of_week: vec![7],
            start_minute: 60,
            end_minute: 180,
            timezone: "America/New_York".into(),
        };
        let before_jump = DateTime::parse_from_rfc3339("2026-03-08T06:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let after_jump = DateTime::parse_from_rfc3339("2026-03-08T07:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(rule.active_at(before_jump));
        assert!(!rule.active_at(after_jump));
        rule.timezone = "not/a-timezone".into();
        assert!(
            !rule.active_at(before_jump),
            "invalid schedules fail closed"
        );
    }

    fn browser(url: &str) -> BrowserObservation {
        BrowserObservation {
            url: url.into(),
            page_title: Some("Page".into()),
            browser: "Chrome".into(),
        }
    }

    #[test]
    fn browser_fallback_waits_for_extension_grace_then_flushes_active_time() {
        let mut tracker = BrowserFallbackTracker::default();
        assert!(tracker
            .tick(true, Some(browser("https://a.test/one")), 0, 0)
            .is_empty());
        for now in (2..=60).step_by(2) {
            assert!(tracker
                .tick(true, Some(browser("https://a.test/one")), 0, now)
                .is_empty());
        }
        let ready = tracker.tick(true, Some(browser("https://a.test/one")), 0, 90);
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].url, "https://a.test/one");
        assert_eq!(ready[0].duration_s, 60);
    }

    #[test]
    fn browser_fallback_discards_buffer_when_extension_reports() {
        let mut tracker = BrowserFallbackTracker::default();
        tracker.tick(true, Some(browser("https://a.test")), 0, 0);
        for now in (2..=60).step_by(2) {
            tracker.tick(true, Some(browser("https://a.test")), 0, now);
        }
        assert!(tracker
            .tick(true, Some(browser("https://a.test")), 61, 61)
            .is_empty());
        assert!(tracker.current.is_none());
        assert!(tracker.pending.is_empty());
    }

    #[test]
    fn browser_fallback_closes_page_on_url_change() {
        let mut tracker = BrowserFallbackTracker::default();
        tracker.tick(true, Some(browser("https://a.test")), 0, 10);
        tracker.tick(true, Some(browser("https://a.test")), 0, 15);
        tracker.tick(true, Some(browser("https://b.test")), 0, 20);
        let ready = tracker.tick(false, None, 0, 100);
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].url, "https://a.test");
        assert_eq!(ready[0].duration_s, 5);
    }

    // ---------- capture-path measurements (audit baseline) ----------
    //
    // Ignored by default: these time the real resize+encode ladder and take a
    // few seconds. Run explicitly with
    //   cargo test --release -- --ignored --nocapture capture_cost
    // The numbers back the live-view findings in docs/FULL_SYSTEM_AUDIT.md.

    #[test]
    #[ignore = "measurement, not an assertion; run with --ignored --nocapture"]
    fn capture_cost_remote_frame_ladder() {
        use std::time::Instant;

        let img = synthetic_screen();
        println!("\nsource: {}x{} RGBA", img.width(), img.height());

        // Whole ladder, exactly as capture_remote_frame calls it.
        let mut total = std::time::Duration::ZERO;
        let runs = 5;
        let mut last = (Vec::<u8>::new(), 0u32, 0u32);
        for _ in 0..runs {
            let t = Instant::now();
            last = compress_webp_to_limit(
                &img,
                &REMOTE_FRAME_MAX_DIMS,
                &REMOTE_FRAME_QUALITIES,
                REMOTE_FRAME_MAX_BYTES,
            );
            total += t.elapsed();
        }
        let (bytes, w, h) = last;
        println!(
            "remote frame ladder: {:?}/frame -> {}x{} {} KiB (cap {} KiB)",
            total / runs,
            w,
            h,
            bytes.len() / 1024,
            REMOTE_FRAME_MAX_BYTES / 1024
        );

        // Cost split: one resize vs one encode, so we can see which dominates
        // and how much a failed ladder step costs.
        use xcap::image::imageops::{self, FilterType};
        let t = Instant::now();
        let resized = imageops::resize(&img, 1600, 900, FilterType::Triangle);
        println!("single resize 2560x1440 -> 1600x900: {:?}", t.elapsed());

        for &q in REMOTE_FRAME_QUALITIES.iter() {
            let t = Instant::now();
            let out = webp::Encoder::from_rgba(resized.as_raw(), 1600, 900).encode(q);
            println!(
                "  encode q={q}: {:?} -> {} KiB",
                t.elapsed(),
                out.to_vec().len() / 1024
            );
        }

        let t = Instant::now();
        let _ = img.clone();
        println!("img.clone() of source: {:?}", t.elapsed());
    }

    #[test]
    #[ignore = "measurement, not an assertion; run with --ignored --nocapture"]
    fn capture_cost_periodic_screenshot_ladder() {
        use std::time::Instant;
        let img = synthetic_screen();
        let t = Instant::now();
        let (bytes, w, h) = compress_to_webp(&img);
        println!(
            "\nperiodic screenshot ladder: {:?} -> {}x{} {} KiB",
            t.elapsed(),
            w,
            h,
            bytes.len() / 1024
        );
    }

    /// A screen that resists compression: full-frame high-frequency noise, which
    /// is what a dense IDE/spreadsheet looks like to a lossy encoder.
    #[cfg(test)]
    fn noisy_screen() -> xcap::image::RgbaImage {
        let (w, h) = (2560u32, 1440u32);
        xcap::image::RgbaImage::from_fn(w, h, |x, y| {
            let n = |k: u32| {
                (x.wrapping_mul(2654435761)
                    .wrapping_add(y.wrapping_mul(40503))
                    .wrapping_add(k.wrapping_mul(2246822519))
                    >> 13) as u8
            };
            xcap::image::Rgba([n(1), n(2), n(3), 255])
        })
    }

    #[test]
    #[ignore = "measurement, not an assertion; run with --ignored --nocapture"]
    fn capture_cost_worst_case_ladder() {
        use std::time::Instant;
        let img = noisy_screen();
        let t = Instant::now();
        let (bytes, w, h) = compress_webp_to_limit(
            &img,
            &REMOTE_FRAME_MAX_DIMS,
            &REMOTE_FRAME_QUALITIES,
            REMOTE_FRAME_MAX_BYTES,
        );
        println!(
            "\nworst-case remote ladder: {:?} -> {}x{} {} KiB",
            t.elapsed(),
            w,
            h,
            bytes.len() / 1024
        );

        let t = Instant::now();
        let (bytes, w, h) = compress_to_webp(&img);
        println!(
            "worst-case screenshot ladder: {:?} -> {}x{} {} KiB",
            t.elapsed(),
            w,
            h,
            bytes.len() / 1024
        );
    }

    /// The measurement that matters for live view: a *stream* of frames, which is
    /// how the ladder is actually used, rather than one cold frame.
    #[test]
    #[ignore = "measurement, not an assertion; run with --ignored --nocapture capture_cost"]
    fn capture_cost_streaming_with_resume() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Instant;

        let img = noisy_screen();
        let frames = 10;

        // Cold ladder every frame — the behaviour before the fix.
        let t = Instant::now();
        for _ in 0..frames {
            let _ = compress_ladder(
                &img,
                &REMOTE_FRAME_MAX_DIMS,
                &REMOTE_FRAME_QUALITIES,
                REMOTE_FRAME_MAX_BYTES,
                0,
            );
        }
        let cold = t.elapsed() / frames;

        // Resuming from the previous frame's rung — the behaviour after.
        let hint = AtomicUsize::new(0);
        let t = Instant::now();
        for _ in 0..frames {
            let out = compress_ladder(
                &img,
                &REMOTE_FRAME_MAX_DIMS,
                &REMOTE_FRAME_QUALITIES,
                REMOTE_FRAME_MAX_BYTES,
                hint.load(Ordering::Relaxed),
            );
            hint.store(out.rung, Ordering::Relaxed);
        }
        let warm = t.elapsed() / frames;

        println!("\nstreaming {frames} dense frames:");
        println!("  cold ladder each frame: {cold:?}/frame");
        println!("  resuming from last rung: {warm:?}/frame");
        println!(
            "  frame interval is {}ms",
            crate::sync::remote_assist::FRAME_INTERVAL.as_millis()
        );
    }
}
