//! Platform abstraction layer.
//!
//! Trackers, commands, and `lib.rs` call the stable API defined here; the active
//! OS backend (`macos.rs` / `windows.rs`) is selected by `cfg` and re-exported.
//! OS-specific input/idle, screen-capture permission checks, and Settings deep
//! links live in the backend modules so version/OS branches don't leak into the
//! trackers. Truly cross-platform bits (active window, the key-press counter,
//! shared types) stay here.
//!
//! See docs/12-windows-support-plan.md §2 for the port plan.

use serde::Serialize;

// ---------- active OS backend ----------

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

// ---------- shared types ----------

/// Permission state reported to the UI (see docs/03-macos-permissions.md). On
/// Windows there are no per-feature OS prompts, so the backend reports `Granted`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionState {
    Granted,
    Denied,
    /// Granted by the OS but a tracker still can't use it — usually needs an app
    /// relaunch (e.g. the event tap). Surfaced by the trackers, not this module.
    #[allow(dead_code)] // Constructed by platform-specific recovery flows.
    NeedsRestart,
}

/// A capability the app gates on. Named after the macOS TCC permissions; on
/// Windows the backend treats them all as granted (consent is opt-out, not OS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Accessibility,
    InputMonitoring,
    ScreenRecording,
}

impl Permission {
    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "accessibility" => Some(Self::Accessibility),
            "input_monitoring" => Some(Self::InputMonitoring),
            "screen_recording" => Some(Self::ScreenRecording),
            _ => None,
        }
    }
}

/// One row of the permissions/consent setup screen, built per-OS so the React UI
/// can render whatever it's given (see docs/12 §2). macOS yields the 3 TCC rows;
/// Windows yields capture/consent rows derived from the user's opt-out settings.
#[derive(Debug, Clone, Serialize)]
pub struct CapabilityRow {
    /// Stable identifier the UI passes back to `open_permission_settings` / `request_*`.
    pub key: String,
    pub label: String,
    pub description: String,
    pub state: PermissionState,
    /// The app can't function fully without it (drives "required" styling).
    pub required: bool,
    /// An in-app `request_*` call can prompt for it (macOS only).
    pub can_request: bool,
    /// A System Settings deep link exists for it (macOS only).
    pub can_open_settings: bool,
}

/// Foreground window info (task 7). `title` is `None` when unavailable (e.g. the
/// window name isn't exposed without Screen Recording on newer macOS).
#[derive(Debug, Clone)]
pub struct ActiveWindowInfo {
    pub app_name: String,
    pub title: Option<String>,
    pub pid: i64,
}

/// A browser address read from the browser's own address-bar accessibility
/// element. It deliberately contains no page body, cookies, form values, or keys.
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserAddress {
    pub url: String,
    pub browser: String,
}

/// Total key-down presses observed since the last flush. The OS backend's
/// keyboard counter increments it; the keyboard flusher swaps it out into
/// per-minute buckets. The key itself is never decoded or stored.
pub static KEY_PRESS_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Mouse button presses (left, right, middle, extra) since the last flush.
/// Counted, never located: no coordinate or target window is kept.
pub static MOUSE_CLICK_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Scroll-wheel notches (vertical or horizontal) since the last flush.
pub static SCROLL_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Pointer travel in screen pixels since the last flush. Only the length of
/// each movement is summed; where the pointer went is discarded at once.
pub static MOUSE_MOVE_PX: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Length of one pointer movement, rounded to whole pixels. Shared by both OS
/// backends so a hop on macOS and on Windows count the same.
pub fn move_distance(dx: i64, dy: i64) -> u64 {
    let (dx, dy) = (dx as f64, dy as f64);
    (dx * dx + dy * dy).sqrt().round() as u64
}

/// One minute's worth of input counts, swapped out of the counters together.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InputCounts {
    pub keys: u64,
    pub clicks: u64,
    pub scrolls: u64,
    pub mouse_px: u64,
}

impl InputCounts {
    /// Take everything counted since the last call and reset the counters.
    pub fn take() -> Self {
        use std::sync::atomic::Ordering::Relaxed;
        Self {
            keys: KEY_PRESS_COUNT.swap(0, Relaxed),
            clicks: MOUSE_CLICK_COUNT.swap(0, Relaxed),
            scrolls: SCROLL_COUNT.swap(0, Relaxed),
            mouse_px: MOUSE_MOVE_PX.swap(0, Relaxed),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.keys == 0 && self.clicks == 0 && self.scrolls == 0 && self.mouse_px == 0
    }
}

#[cfg(test)]
mod input_tests {
    use super::*;

    #[test]
    fn move_distance_is_euclidean_and_rounded() {
        assert_eq!(move_distance(3, 4), 5);
        assert_eq!(move_distance(-3, -4), 5);
        assert_eq!(move_distance(0, 0), 0);
        assert_eq!(move_distance(1, 1), 1); // 1.414 rounds down
    }

    #[test]
    fn empty_counts_report_empty() {
        assert!(InputCounts::default().is_empty());
        assert!(!InputCounts {
            clicks: 1,
            ..Default::default()
        }
        .is_empty());
    }
}

// ---------- cross-platform implementations ----------

/// The active foreground window, or `None` if there isn't one / it can't be read.
/// `active-win-pos-rs` is cross-platform (macOS + Windows), so this lives here.
pub fn active_window() -> Option<ActiveWindowInfo> {
    match active_win_pos_rs::get_active_window() {
        Ok(w) => {
            let title = w.title.trim();
            Some(ActiveWindowInfo {
                app_name: w.app_name,
                title: if title.is_empty() {
                    None
                } else {
                    Some(title.to_string())
                },
                pid: w.process_id as i64,
            })
        }
        Err(_) => None,
    }
}
