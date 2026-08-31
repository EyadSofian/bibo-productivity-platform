//! Windows platform backend (see docs/12-windows-support-plan.md §3).
//!
//! Selected by `#[cfg(target_os = "windows")]` in `platform/mod.rs`, which
//! re-exports everything below. Windows has no per-feature OS permission prompts,
//! so the permission API reports `Granted` and the request/open-settings calls are
//! no-ops; first-run consent + Settings opt-outs are handled in the UI (M3).
//!
//! Implemented here: idle detection via `GetLastInputInfo` (M1) and keyboard
//! counting via a `WH_KEYBOARD_LL` hook (M2, see `run_keyboard_tap`) — count-only,
//! `lparam` is never read. Active window and screenshots are cross-platform
//! (`active-win-pos-rs` / `xcap`) and live elsewhere.
//!
//! Not yet implemented: session events (lock/unlock, sleep/resume, user switching)
//! — see docs/IMPLEMENTATION_TASKS.md F2.

use super::{ActiveWindowInfo, BrowserAddress, CapabilityRow, Permission, PermissionState};
use crate::settings::Settings;

/// Windows capture/consent rows for the data-driven setup screen. There are no
/// per-feature OS prompts, so state is derived from the user's opt-out toggles and
/// whether they've consented; nothing is requestable or has a Settings deep link.
pub fn capability_rows(s: &Settings) -> Vec<CapabilityRow> {
    let state = |enabled: bool| {
        if s.consented && enabled {
            PermissionState::Granted
        } else {
            PermissionState::Denied
        }
    };
    vec![
        CapabilityRow {
            key: "keystrokes".to_string(),
            label: "Activity & keystroke counts".to_string(),
            description: "Tracks the active app/window and counts keystrokes (counts only — \
                          never which keys are pressed)."
                .to_string(),
            state: state(s.count_keystrokes),
            required: false,
            can_request: false,
            can_open_settings: false,
        },
        CapabilityRow {
            key: "browser_urls".to_string(),
            label: "Browser URLs and time".to_string(),
            description: "Records the active browser address and time spent. The browser extension is preferred; without it, Windows reads only the address bar through UI Automation — never page contents, form values, cookies, or typed keys."
                .to_string(),
            state: state(s.capture_browser_urls),
            required: false,
            can_request: false,
            can_open_settings: false,
        },
        CapabilityRow {
            key: "screenshots".to_string(),
            label: "Screenshots".to_string(),
            description: "Captures periodic screenshots of your screen(s).".to_string(),
            state: state(s.capture_screenshots),
            required: false,
            can_request: false,
            can_open_settings: false,
        },
    ]
}

// ---------- transparent browser address-bar fallback ----------

/// A thread-affine Windows UI Automation client. Construct and use it on the
/// same dedicated tracker thread; `Drop` balances COM initialization there.
pub struct BrowserUrlReader {
    automation: windows::Win32::UI::Accessibility::IUIAutomation,
}

impl BrowserUrlReader {
    pub fn new() -> Option<Self> {
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
        };
        use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

        unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                return None;
            }
            match CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                Ok(automation) => Some(Self { automation }),
                Err(_) => {
                    windows::Win32::System::Com::CoUninitialize();
                    None
                }
            }
        }
    }

    /// Read the exact URL from a known foreground browser's address-bar edit
    /// element. Page edit controls are deliberately rejected by requiring an
    /// address-bar-specific accessibility name/id/class near the browser chrome.
    pub fn read(&self, active: &ActiveWindowInfo) -> Option<BrowserAddress> {
        use windows::core::VARIANT;
        use windows::Win32::UI::Accessibility::{
            IUIAutomationValuePattern, TreeScope_Descendants, UIA_ControlTypePropertyId,
            UIA_EditControlTypeId, UIA_ValuePatternId,
        };
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

        let browser = browser_name(&active.app_name)?;
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }
            let root = self.automation.ElementFromHandle(hwnd).ok()?;
            let root_rect = root.CurrentBoundingRectangle().ok()?;
            let control_type = VARIANT::from(UIA_EditControlTypeId.0);
            let condition = self
                .automation
                .CreatePropertyCondition(UIA_ControlTypePropertyId, &control_type)
                .ok()?;
            let elements = root.FindAll(TreeScope_Descendants, &condition).ok()?;
            let len = elements.Length().ok()?.clamp(0, 512);

            let mut best: Option<(i32, String)> = None;
            for index in 0..len {
                let Ok(element) = elements.GetElement(index) else {
                    continue;
                };
                if element
                    .CurrentIsPassword()
                    .map(|v| v.as_bool())
                    .unwrap_or(true)
                {
                    continue;
                }
                let name = element
                    .CurrentName()
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                let automation_id = element
                    .CurrentAutomationId()
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                let class_name = element
                    .CurrentClassName()
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                let rect = element.CurrentBoundingRectangle().ok();
                let score = address_bar_score(
                    &name,
                    &automation_id,
                    &class_name,
                    rect.map(|r| r.top.saturating_sub(root_rect.top)),
                );
                if score <= 0 {
                    continue;
                }
                let Ok(pattern) =
                    element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                else {
                    continue;
                };
                let Ok(value) = pattern.CurrentValue() else {
                    continue;
                };
                let Some(url) = normalize_address_bar_value(&value.to_string()) else {
                    continue;
                };
                if best.as_ref().is_none_or(|(old, _)| score > *old) {
                    best = Some((score, url));
                }
            }
            best.map(|(_, url)| BrowserAddress {
                url,
                browser: browser.to_string(),
            })
        }
    }
}

impl Drop for BrowserUrlReader {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() }
    }
}

fn browser_name(app_name: &str) -> Option<&'static str> {
    let app = app_name.to_ascii_lowercase();
    if app.contains("msedge") || app == "edge" || app.contains("microsoft edge") {
        Some("Edge")
    } else if app.contains("chrome") {
        Some("Chrome")
    } else if app.contains("brave") {
        Some("Brave")
    } else if app.contains("firefox") {
        Some("Firefox")
    } else if app.contains("vivaldi") {
        Some("Vivaldi")
    } else if app.contains("opera") {
        Some("Opera")
    } else {
        None
    }
}

fn address_bar_score(name: &str, automation_id: &str, class_name: &str, top: Option<i32>) -> i32 {
    // An address bar lives in the browser chrome, not in the document body.
    if top.is_none_or(|v| !(0..=280).contains(&v)) {
        return 0;
    }
    let metadata = format!("{name} {automation_id} {class_name}").to_ascii_lowercase();
    let strong = [
        "address and search bar",
        "address bar",
        "search or enter address",
        "enter address",
        "location bar",
        "omnibox",
        "urlbar",
        "chrome_omniboxview",
    ];
    strong
        .iter()
        .position(|marker| metadata.contains(marker))
        .map(|index| 100 - index as i32)
        .unwrap_or(0)
}

fn normalize_address_bar_value(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty()
        || value.len() > 4096
        || value.chars().any(char::is_whitespace)
        || value.starts_with("chrome://")
        || value.starts_with("edge://")
        || value.starts_with("about:")
        || value.starts_with("file:")
    {
        return None;
    }
    if value.starts_with("https://") || value.starts_with("http://") {
        return Some(value.to_string());
    }
    // Chrome/Edge sometimes omit the scheme in the exposed address-bar value.
    // Only normalize values that look like a hostname; search terms stay out.
    let host = value.split('/').next().unwrap_or_default();
    if host.contains('.') && !host.starts_with('.') && !host.ends_with('.') {
        Some(format!("https://{value}"))
    } else {
        None
    }
}

#[cfg(test)]
mod browser_url_tests {
    use super::*;

    #[test]
    fn recognises_supported_browser_process_names() {
        assert_eq!(browser_name("chrome.exe"), Some("Chrome"));
        assert_eq!(browser_name("msedge.exe"), Some("Edge"));
        assert_eq!(browser_name("Brave Browser"), Some("Brave"));
        assert_eq!(browser_name("notepad.exe"), None);
    }

    #[test]
    fn accepts_web_addresses_but_rejects_private_browser_pages_and_search_terms() {
        assert_eq!(
            normalize_address_bar_value("https://example.com/a?q=1"),
            Some("https://example.com/a?q=1".into())
        );
        assert_eq!(
            normalize_address_bar_value("example.com/path"),
            Some("https://example.com/path".into())
        );
        for rejected in [
            "chrome://settings",
            "about:blank",
            "hello world",
            "file:///secret",
        ] {
            assert_eq!(normalize_address_bar_value(rejected), None);
        }
    }

    #[test]
    fn requires_address_bar_metadata_in_the_browser_chrome() {
        assert!(address_bar_score("Address and search bar", "", "", Some(90)) > 0);
        assert_eq!(address_bar_score("Search", "", "", Some(90)), 0);
        assert_eq!(
            address_bar_score("Address and search bar", "", "", Some(600)),
            0
        );
    }
}

/// No-op on Windows: there is no System Settings pane to grant a per-feature
/// permission. Opt-outs live in the app's own Settings screen.
pub fn open_settings(_p: Permission) {}

/// Windows has no per-feature OS permission model — everything is available
/// unless the user opts out in-app, so report `Granted`.
pub fn permission_status(_p: Permission) -> PermissionState {
    PermissionState::Granted
}

/// No OS prompt to request on Windows; capture works unless opted out in-app.
pub fn request_screen_recording() -> bool {
    true
}

/// No OS prompt to request on Windows.
pub fn request_input_monitoring() -> bool {
    true
}

/// No OS prompt to request on Windows.
pub fn request_accessibility() -> bool {
    true
}

/// Low-level keyboard hook callback. Runs on the thread that installed the hook
/// (see `run_keyboard_tap`). COUNT ONLY — we increment on key-down and never read
/// the key code / scan code from `lparam`, preserving the same privacy guarantee
/// as the macOS event tap.
unsafe extern "system" fn keyboard_hook_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use std::sync::atomic::Ordering;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, HC_ACTION, HHOOK, WM_KEYDOWN, WM_SYSKEYDOWN,
    };

    // Only act on HC_ACTION; anything < 0 must be passed straight through.
    if code == HC_ACTION as i32 {
        let msg = wparam.0 as u32;
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            super::KEY_PRESS_COUNT.fetch_add(1, Ordering::Relaxed);
        }
    }
    // hhk is ignored by the OS; pass a null handle.
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

/// Install a `WH_KEYBOARD_LL` low-level keyboard hook and pump messages so it
/// fires (low-level hooks are delivered to the installing thread's message queue).
/// Blocks while active; the caller (`trackers::start_keyboard`) runs this on a
/// dedicated thread in a retry loop. Returns `false` immediately if the hook can't
/// be installed, so the caller idles and retries instead of busy-looping.
///
/// Note (see plan §8): a low-level hook cannot observe input routed to a
/// higher-integrity/elevated foreground app — counts simply pause for that window;
/// the app never crashes.
pub fn run_keyboard_tap() -> bool {
    use windows::Win32::Foundation::HINSTANCE;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
        MSG, WH_KEYBOARD_LL,
    };

    unsafe {
        // hMod = NULL is permitted for WH_KEYBOARD_LL; the proc lives in-process.
        let hook = match SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(keyboard_hook_proc),
            HINSTANCE::default(),
            0,
        ) {
            Ok(h) => h,
            Err(_) => return false,
        };

        // Message loop: GetMessageW blocks and lets the system deliver hook
        // callbacks on this thread. We never post WM_QUIT, so this runs until the
        // process exits; on the unexpected `0`/`-1` return we fall through and
        // unhook so the caller can retry.
        let mut msg = MSG::default();
        loop {
            let r = GetMessageW(&mut msg, None, 0, 0).0;
            if r == 0 || r == -1 {
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        let _ = UnhookWindowsHookEx(hook);
    }
    true
}

/// Seconds since the last user input (keyboard or mouse), via `GetLastInputInfo`.
/// Needs no special permission. Like the macOS path, it grows while the session is
/// locked or the display is asleep, so those states count as idle.
pub fn idle_seconds() -> f64 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    unsafe {
        if GetLastInputInfo(&mut info).as_bool() {
            // Both are 32-bit millisecond tick counts that wrap ~every 49 days;
            // wrapping_sub gives the correct elapsed interval across a wrap.
            let idle_ms = GetTickCount().wrapping_sub(info.dwTime);
            idle_ms as f64 / 1000.0
        } else {
            0.0
        }
    }
}
