//! Injects remote-control input into the interactive desktop (V07 / ticket 151).
//!
//! Two halves, deliberately separated:
//!
//! 1. [`MonitorLayout`] - **pure geometry**. Turns a normalised 0..1 point inside
//!    one monitor into the absolute virtual-desktop coordinate `SendInput` wants.
//!    This is where DPI scaling and multi-monitor layouts are actually handled,
//!    and it is unit-tested against real layouts without touching the OS.
//! 2. [`InputInjector`] - the `SendInput` calls themselves.
//!
//! # DPI
//!
//! The process declares itself per-monitor DPI aware (v2) at startup, so every
//! metric Windows reports is in **physical pixels**. Without that, a 150%-scaled
//! monitor reports virtualised coordinates and the cursor lands in the wrong
//! place - visibly wrong on the secondary monitor and subtly wrong on the primary.
//!
//! # Stuck modifiers
//!
//! Every key and button we press is remembered until it is released. On stop -
//! including emergency stop - [`InputInjector::release_all`] releases them. Left
//! out, an operator disconnecting mid-chord would leave the employee's machine
//! with Ctrl or a mouse button held down and no way to know why.

#[cfg(windows)]
use std::collections::HashSet;

use crate::control::{Button, ControlMessage, Point};

#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};

/// One wheel notch, as Windows defines it.
const WHEEL_DELTA: i32 = 120;

/// `SendInput`'s absolute coordinate space is 0..65535 on each axis.
const ABS_MAX: f64 = 65_535.0;

#[derive(Debug, PartialEq)]
pub enum InjectError {
    /// The message named a monitor that does not exist.
    UnknownMonitor(u32),
    /// Virtual-key code outside the 1..=254 range Windows defines.
    BadKeyCode(u32),
    /// `SendInput` accepted fewer events than we gave it.
    SendFailed { sent: u32, expected: u32 },
    /// The virtual desktop reported a zero or negative size.
    DegenerateLayout,
}

impl std::fmt::Display for InjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownMonitor(i) => write!(f, "no such monitor: {i}"),
            // The code is not printed: a sequence of key codes is the typed text.
            Self::BadKeyCode(_) => write!(f, "virtual-key code out of range"),
            Self::SendFailed { sent, expected } => {
                write!(f, "SendInput accepted {sent} of {expected} events")
            }
            Self::DegenerateLayout => write!(f, "virtual desktop has no area"),
        }
    }
}

impl std::error::Error for InjectError {}

/// One monitor's rectangle in virtual-desktop pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Monitor {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

/// The monitors as the agent sees them, plus the bounding virtual desktop.
///
/// On Windows the virtual desktop origin can be negative: a monitor placed to
/// the left of the primary starts at a negative x. Every mapping below is
/// relative to `virtual_left`/`virtual_top` for exactly that reason.
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorLayout {
    pub monitors: Vec<Monitor>,
    pub virtual_left: i32,
    pub virtual_top: i32,
    pub virtual_width: i32,
    pub virtual_height: i32,
}

impl MonitorLayout {
    /// Builds a layout from explicit rectangles, deriving the bounding box.
    /// Used by tests and by [`detect`].
    pub fn from_monitors(monitors: Vec<Monitor>) -> Self {
        let left = monitors.iter().map(|m| m.left).min().unwrap_or(0);
        let top = monitors.iter().map(|m| m.top).min().unwrap_or(0);
        let right = monitors.iter().map(|m| m.left + m.width).max().unwrap_or(0);
        let bottom = monitors.iter().map(|m| m.top + m.height).max().unwrap_or(0);
        Self {
            monitors,
            virtual_left: left,
            virtual_top: top,
            virtual_width: right - left,
            virtual_height: bottom - top,
        }
    }

    pub fn monitor(&self, index: u32) -> Option<&Monitor> {
        self.monitors.get(index as usize)
    }

    /// Maps a normalised in-monitor point to an absolute virtual-desktop pixel.
    pub fn absolute(&self, p: Point) -> Result<(i32, i32), InjectError> {
        let m = self
            .monitor(p.monitor)
            .ok_or(InjectError::UnknownMonitor(p.monitor))?;
        // (width - 1) so x = 1.0 lands on the last pixel, not one past the edge.
        let x = m.left + (f64::from(p.x) * f64::from((m.width - 1).max(0))).round() as i32;
        let y = m.top + (f64::from(p.y) * f64::from((m.height - 1).max(0))).round() as i32;
        Ok((x, y))
    }

    /// Maps a normalised point to `SendInput`'s 0..65535 absolute space.
    pub fn to_send_input(&self, p: Point) -> Result<(i32, i32), InjectError> {
        if self.virtual_width <= 0 || self.virtual_height <= 0 {
            return Err(InjectError::DegenerateLayout);
        }
        let (ax, ay) = self.absolute(p)?;
        let span_x = f64::from((self.virtual_width - 1).max(1));
        let span_y = f64::from((self.virtual_height - 1).max(1));
        let nx = (f64::from(ax - self.virtual_left) * ABS_MAX / span_x).round() as i32;
        let ny = (f64::from(ay - self.virtual_top) * ABS_MAX / span_y).round() as i32;
        Ok((nx.clamp(0, 65_535), ny.clamp(0, 65_535)))
    }
}

/// Whether a virtual-key code is one Windows actually defines.
fn valid_vk(code: u32) -> bool {
    (1..=254).contains(&code)
}

/// Applies control messages to the desktop, tracking what is held down.
#[derive(Debug)]
#[cfg(windows)]
pub struct InputInjector {
    layout: MonitorLayout,
    held_keys: HashSet<u16>,
    held_buttons: HashSet<Button>,
}

#[cfg(windows)]
impl InputInjector {
    pub fn new(layout: MonitorLayout) -> Self {
        Self {
            layout,
            held_keys: HashSet::new(),
            held_buttons: HashSet::new(),
        }
    }

    pub fn layout(&self) -> &MonitorLayout {
        &self.layout
    }

    /// Replaces the layout after a monitor is added, removed or rearranged.
    pub fn set_layout(&mut self, layout: MonitorLayout) {
        self.layout = layout;
    }

    /// Keys currently held by *us*. Used by tests and by the stop path.
    pub fn held_key_count(&self) -> usize {
        self.held_keys.len()
    }

    pub fn held_button_count(&self) -> usize {
        self.held_buttons.len()
    }

    /// Applies one validated control message.
    ///
    /// The message must already have passed [`crate::control::ControlStream`]:
    /// this function assumes bounds and rate have been checked, and concerns
    /// itself only with turning a valid intent into `SendInput` calls.
    pub fn apply(&mut self, msg: &ControlMessage) -> Result<(), InjectError> {
        match msg {
            ControlMessage::PointerMove { at, .. } => self.move_pointer(*at),
            ControlMessage::PointerButton {
                button, down, at, ..
            } => {
                self.move_pointer(*at)?;
                self.button(*button, *down)
            }
            ControlMessage::Wheel { dx, dy, .. } => self.wheel(*dx, *dy),
            ControlMessage::KeyDown { key, .. } => self.key(key.code, true),
            ControlMessage::KeyUp { key, .. } => self.key(key.code, false),
            ControlMessage::KeyText { text, .. } => self.text(&text.text),
            // Liveness only; nothing reaches the desktop.
            ControlMessage::ControlPing { .. } => Ok(()),
        }
    }

    /// Releases everything we are holding. Called on stop, session end and
    /// emergency stop so no key or button is left stuck on the employee's machine.
    pub fn release_all(&mut self) {
        let keys: Vec<u16> = self.held_keys.drain().collect();
        for vk in keys {
            let _ = self.send_key_raw(vk, false);
        }
        let buttons: Vec<Button> = self.held_buttons.drain().collect();
        for b in buttons {
            let _ = self.send_button_raw(b, false);
        }
    }

    fn move_pointer(&mut self, at: Point) -> Result<(), InjectError> {
        let (nx, ny) = self.layout.to_send_input(at)?;
        self.send_mouse(
            nx,
            ny,
            0,
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        )
    }

    fn button(&mut self, button: Button, down: bool) -> Result<(), InjectError> {
        if down {
            self.held_buttons.insert(button);
        } else {
            self.held_buttons.remove(&button);
        }
        self.send_button_raw(button, down)
    }

    fn key(&mut self, code: u32, down: bool) -> Result<(), InjectError> {
        if !valid_vk(code) {
            return Err(InjectError::BadKeyCode(code));
        }
        let vk = code as u16;
        if down {
            self.held_keys.insert(vk);
        } else {
            self.held_keys.remove(&vk);
        }
        self.send_key_raw(vk, down)
    }
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
impl InputInjector {
    fn send_mouse(
        &self,
        dx: i32,
        dy: i32,
        mouse_data: i32,
        flags: MOUSE_EVENT_FLAGS,
    ) -> Result<(), InjectError> {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: mouse_data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        send(&[input])
    }

    fn send_button_raw(&self, button: Button, down: bool) -> Result<(), InjectError> {
        let flags = match (button, down) {
            (Button::Left, true) => MOUSEEVENTF_LEFTDOWN,
            (Button::Left, false) => MOUSEEVENTF_LEFTUP,
            (Button::Right, true) => MOUSEEVENTF_RIGHTDOWN,
            (Button::Right, false) => MOUSEEVENTF_RIGHTUP,
            (Button::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
            (Button::Middle, false) => MOUSEEVENTF_MIDDLEUP,
        };
        self.send_mouse(0, 0, 0, flags)
    }

    fn wheel(&self, dx: f32, dy: f32) -> Result<(), InjectError> {
        if dy != 0.0 {
            let amount = (dy * WHEEL_DELTA as f32).round() as i32;
            self.send_mouse(0, 0, amount, MOUSEEVENTF_WHEEL)?;
        }
        if dx != 0.0 {
            let amount = (dx * WHEEL_DELTA as f32).round() as i32;
            self.send_mouse(0, 0, amount, MOUSEEVENTF_HWHEEL)?;
        }
        Ok(())
    }

    fn send_key_raw(&self, vk: u16, down: bool) -> Result<(), InjectError> {
        let flags = if down {
            KEYBD_EVENT_FLAGS(0)
        } else {
            KEYEVENTF_KEYUP
        };
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        send(&[input])
    }

    /// Types text as Unicode, bypassing the keyboard layout entirely.
    ///
    /// `KEYEVENTF_UNICODE` sends the character itself rather than a scan code,
    /// so a Cyrillic or Arabic character arrives correctly regardless of which
    /// layout the employee has active - which a virtual-key path cannot do.
    fn text(&self, s: &str) -> Result<(), InjectError> {
        let mut inputs: Vec<INPUT> = Vec::with_capacity(s.len() * 2);
        for unit in s.encode_utf16() {
            for up in [false, true] {
                let flags = if up {
                    KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                } else {
                    KEYEVENTF_UNICODE
                };
                inputs.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(0),
                            wScan: unit,
                            dwFlags: flags,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                });
            }
        }
        if inputs.is_empty() {
            return Ok(());
        }
        send(&inputs)
    }
}

#[cfg(windows)]
fn send(inputs: &[INPUT]) -> Result<(), InjectError> {
    let expected = inputs.len() as u32;
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent != expected {
        return Err(InjectError::SendFailed { sent, expected });
    }
    Ok(())
}

/// Reads the current monitor layout from Windows, in physical pixels.
#[cfg(windows)]
pub fn detect() -> MonitorLayout {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    };

    /// `MONITORINFOF_PRIMARY`. The `windows` crate does not re-export it, and it
    /// is fixed at 1 in `winuser.h`.
    const MONITORINFOF_PRIMARY: u32 = 1;

    // Primary first, so `monitor: 0` always means the primary display and the
    // viewer's default needs no knowledge of enumeration order.
    let mut primary: Vec<Monitor> = Vec::new();
    let mut others: Vec<Monitor> = Vec::new();

    unsafe extern "system" fn cb(h: HMONITOR, _dc: HDC, _r: *mut RECT, data: LPARAM) -> BOOL {
        let out = unsafe { &mut *(data.0 as *mut (Vec<Monitor>, Vec<Monitor>)) };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetMonitorInfoW(h, &mut info) }.as_bool() {
            let r = info.rcMonitor;
            let m = Monitor {
                left: r.left,
                top: r.top,
                width: r.right - r.left,
                height: r.bottom - r.top,
            };
            if info.dwFlags & MONITORINFOF_PRIMARY != 0 {
                out.0.push(m);
            } else {
                out.1.push(m);
            }
        }
        BOOL(1) // keep enumerating
    }

    let mut acc = (primary, others);
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(cb),
            LPARAM(&mut acc as *mut (Vec<Monitor>, Vec<Monitor>) as isize),
        );
    }
    (primary, others) = acc;

    primary.extend(others);
    if primary.is_empty() {
        // No monitor reported: a degenerate layout that refuses every point is
        // safer than guessing a resolution and clicking somewhere arbitrary.
        return MonitorLayout {
            monitors: Vec::new(),
            virtual_left: 0,
            virtual_top: 0,
            virtual_width: 0,
            virtual_height: 0,
        };
    }
    MonitorLayout::from_monitors(primary)
}

/// Declares this process per-monitor DPI aware so every coordinate Windows
/// reports is a physical pixel. Call once, before [`detect`].
#[cfg(windows)]
pub fn set_dpi_awareness() {
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    // Failure means the manifest already set awareness, which is fine.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{Key, Modifiers, Point};

    fn p(x: f32, y: f32, monitor: u32) -> Point {
        Point { x, y, monitor }
    }

    /// A single 1920x1080 primary display.
    fn single() -> MonitorLayout {
        MonitorLayout::from_monitors(vec![Monitor {
            left: 0,
            top: 0,
            width: 1920,
            height: 1080,
        }])
    }

    /// Primary 1920x1080, plus a 2560x1440 monitor placed to its LEFT, which is
    /// where Windows uses negative coordinates.
    fn dual_left() -> MonitorLayout {
        MonitorLayout::from_monitors(vec![
            Monitor {
                left: 0,
                top: 0,
                width: 1920,
                height: 1080,
            },
            Monitor {
                left: -2560,
                top: 0,
                width: 2560,
                height: 1440,
            },
        ])
    }

    #[test]
    fn maps_the_corners_of_a_single_display() {
        let l = single();
        assert_eq!(l.absolute(p(0.0, 0.0, 0)).unwrap(), (0, 0));
        assert_eq!(l.absolute(p(1.0, 1.0, 0)).unwrap(), (1919, 1079));
        assert_eq!(l.absolute(p(0.5, 0.5, 0)).unwrap(), (960, 540));
    }

    #[test]
    fn maps_to_the_full_send_input_range() {
        let l = single();
        assert_eq!(l.to_send_input(p(0.0, 0.0, 0)).unwrap(), (0, 0));
        assert_eq!(l.to_send_input(p(1.0, 1.0, 0)).unwrap(), (65_535, 65_535));
    }

    #[test]
    fn derives_a_virtual_desktop_that_spans_both_monitors() {
        let l = dual_left();
        assert_eq!(l.virtual_left, -2560);
        assert_eq!(l.virtual_top, 0);
        assert_eq!(l.virtual_width, 1920 + 2560);
        assert_eq!(l.virtual_height, 1440);
    }

    #[test]
    fn a_point_on_the_secondary_monitor_lands_on_the_secondary_monitor() {
        let l = dual_left();
        // Centre of monitor 1 (the left-hand 2560x1440 one).
        // 0.5 * (2560-1) = 1279.5, which rounds away from zero to 1280.
        let (ax, ay) = l.absolute(p(0.5, 0.5, 1)).unwrap();
        assert_eq!((ax, ay), (-2560 + 1280, 720));
        assert!(ax < 0, "a monitor left of primary must map to negative x");

        // And it must stay inside that monitor's rectangle after normalising.
        let (nx, _) = l.to_send_input(p(0.5, 0.5, 1)).unwrap();
        let back = l.virtual_left
            + (f64::from(nx) * f64::from(l.virtual_width - 1) / ABS_MAX).round() as i32;
        assert!(
            (-2560..0).contains(&back),
            "mapped back to {back}, outside monitor 1"
        );
    }

    #[test]
    fn the_left_edge_of_the_leftmost_monitor_is_absolute_zero() {
        let l = dual_left();
        assert_eq!(l.to_send_input(p(0.0, 0.0, 1)).unwrap().0, 0);
    }

    #[test]
    fn the_primary_origin_is_not_zero_when_a_monitor_sits_to_its_left() {
        // This is the bug a naive "x * 65535 / screen_width" would produce: the
        // primary monitor's origin is 2560px into the virtual desktop, not 0.
        let l = dual_left();
        let (nx, _) = l.to_send_input(p(0.0, 0.0, 0)).unwrap();
        assert!(
            nx > 30_000,
            "primary origin mapped to {nx}, ignoring the left monitor"
        );
    }

    #[test]
    fn refuses_a_point_on_a_monitor_that_does_not_exist() {
        let l = single();
        assert_eq!(
            l.absolute(p(0.5, 0.5, 7)).unwrap_err(),
            InjectError::UnknownMonitor(7)
        );
    }

    #[test]
    fn refuses_to_map_anything_when_there_are_no_monitors() {
        let l = MonitorLayout::from_monitors(vec![]);
        assert_eq!(
            l.to_send_input(p(0.5, 0.5, 0)).unwrap_err(),
            InjectError::DegenerateLayout
        );
    }

    #[test]
    fn a_high_dpi_monitor_is_just_a_bigger_rectangle() {
        // A 3840x2160 panel at 200% scaling reports 3840x2160 physical pixels
        // once the process is per-monitor DPI aware. The mapping is therefore
        // ordinary; the DPI work is entirely in declaring awareness.
        let l = MonitorLayout::from_monitors(vec![Monitor {
            left: 0,
            top: 0,
            width: 3840,
            height: 2160,
        }]);
        assert_eq!(l.absolute(p(0.5, 0.5, 0)).unwrap(), (1920, 1080));
        assert_eq!(l.to_send_input(p(1.0, 1.0, 0)).unwrap(), (65_535, 65_535));
    }

    #[test]
    fn rejects_virtual_key_codes_outside_the_defined_range() {
        assert!(!valid_vk(0));
        assert!(!valid_vk(255));
        assert!(!valid_vk(70_000));
        assert!(valid_vk(0x41)); // 'A'
        assert!(valid_vk(0x11)); // Ctrl
    }

    #[test]
    #[cfg(windows)]
    fn a_bad_key_code_is_refused_before_it_reaches_the_os() {
        let mut inj = InputInjector::new(single());
        let msg = ControlMessage::KeyDown {
            seq: 1,
            key: Key {
                code: 70_000,
                modifiers: Modifiers::default(),
            },
        };
        assert_eq!(
            inj.apply(&msg).unwrap_err(),
            InjectError::BadKeyCode(70_000)
        );
        assert_eq!(
            inj.held_key_count(),
            0,
            "a refused key must not be recorded as held"
        );
    }

    #[test]
    fn a_bad_key_codes_error_does_not_print_the_code() {
        // The code IS the character; printing it would defeat the redaction in
        // control.rs.
        let rendered = InjectError::BadKeyCode(0x41).to_string();
        assert!(!rendered.contains("65"));
        assert!(!rendered.contains("41"));
    }

    #[test]
    #[cfg(windows)]
    fn a_pointer_message_for_an_unknown_monitor_is_refused() {
        let mut inj = InputInjector::new(single());
        let msg = ControlMessage::PointerMove {
            seq: 1,
            at: p(0.5, 0.5, 9),
        };
        assert_eq!(inj.apply(&msg).unwrap_err(), InjectError::UnknownMonitor(9));
    }

    #[test]
    #[cfg(windows)]
    fn ping_never_reaches_the_desktop() {
        let mut inj = InputInjector::new(single());
        // Would fail if it tried to map coordinates or press anything.
        assert!(inj.apply(&ControlMessage::ControlPing { seq: 1 }).is_ok());
        assert_eq!(inj.held_key_count(), 0);
        assert_eq!(inj.held_button_count(), 0);
    }
}

#[cfg(windows)]
impl Drop for InputInjector {
    fn drop(&mut self) {
        self.release_all();
    }
}
