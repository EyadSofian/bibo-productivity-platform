//! Locally authorized Windows remote assistance.
//!
//! The backend can only create a pending request. This worker displays a native
//! prompt on the employee computer unless the user enabled unattended assistance
//! once in local settings. Every session keeps an always-on-top Stop control visible
//! and ends on either participant's request or the fifteen-minute server expiry.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::client::{BackendClient, RemoteAssistAction, RemoteAssistSession};
use super::worker::SyncContext;

const IDLE_POLL: Duration = Duration::from_secs(2);
const ACTIVE_POLL: Duration = Duration::from_millis(180);
pub(crate) const FRAME_INTERVAL: Duration = Duration::from_millis(900);
const STATUS_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Serialize)]
pub struct RemoteAssistStatus {
    pub active: bool,
    pub session_id: String,
    pub owner_name: String,
    pub expires_at: String,
}

#[derive(Default)]
pub struct RemoteAssistState {
    current: Mutex<Option<RemoteAssistStatus>>,
    stop_requested: AtomicBool,
}

impl RemoteAssistState {
    pub fn status(&self) -> Option<RemoteAssistStatus> {
        self.current.lock().unwrap().clone()
    }

    pub fn request_stop(&self) -> bool {
        if self.current.lock().unwrap().is_none() {
            return false;
        }
        self.stop_requested.store(true, Ordering::Relaxed);
        true
    }

    fn activate(&self, session: &RemoteAssistSession) {
        self.stop_requested.store(false, Ordering::Relaxed);
        *self.current.lock().unwrap() = Some(RemoteAssistStatus {
            active: true,
            session_id: session.id.clone(),
            owner_name: session.owner_name.clone(),
            expires_at: session.expires_at.clone(),
        });
    }

    fn clear(&self) {
        self.stop_requested.store(false, Ordering::Relaxed);
        *self.current.lock().unwrap() = None;
    }
}

pub fn start(ctx: SyncContext) {
    thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                crate::log_warn!("remote_assist", "runtime build failed: {error}");
                return;
            }
        };
        runtime.block_on(run(ctx));
    });
}

async fn run(ctx: SyncContext) {
    let mut active: Option<RemoteAssistSession> = None;
    let mut backend: Option<(String, BackendClient)> = None;
    let mut last_action_id = 0_i64;
    let mut last_frame = tokio::time::Instant::now() - FRAME_INTERVAL;
    let mut last_status = tokio::time::Instant::now() - STATUS_INTERVAL;

    loop {
        let Some(_auth_session) = ctx.auth.session() else {
            finish_local(&ctx);
            active = None;
            backend = None;
            tokio::time::sleep(IDLE_POLL).await;
            continue;
        };
        let device_id = ctx.settings.current.lock().unwrap().device_id.clone();
        let base_url = crate::settings::backend_base_url();
        if device_id.is_empty() || base_url.is_empty() {
            tokio::time::sleep(IDLE_POLL).await;
            continue;
        }
        if backend.as_ref().is_none_or(|(url, _)| url != &base_url) {
            backend = Some((
                base_url.clone(),
                BackendClient::new(base_url, ctx.auth.clone()),
            ));
        }
        // Reuse reqwest's pool across the 120ms input loop and 900ms frame
        // uploads. Constructing a new client here previously forced repeated
        // DNS/TLS setup and made pointer/keyboard control feel several beats
        // behind even on a healthy connection.
        let client = &backend.as_ref().expect("backend client initialized").1;

        if active.is_none() {
            match client.remote_assist_pending(&device_id).await {
                Ok(Some(pending)) => {
                    // This opt-in can only be changed on the employee computer. It
                    // avoids a repeated prompt without making remote access hidden.
                    let preapproved = ctx
                        .settings
                        .current
                        .lock()
                        .unwrap()
                        .remote_assist_preapproved;
                    let accepted = preapproved || ask_employee(&ctx, &pending);
                    match client.remote_assist_decide(&pending.id, accepted).await {
                        Ok(decided) if accepted && decided.status == "active" => {
                            ctx.remote_assist.activate(&decided);
                            show_indicator(&ctx.app);
                            active = Some(decided);
                            last_action_id = 0;
                            last_frame = tokio::time::Instant::now() - FRAME_INTERVAL;
                            last_status = tokio::time::Instant::now() - STATUS_INTERVAL;
                        }
                        Ok(_) => finish_local(&ctx),
                        Err(error) => crate::log_warn!(
                            "remote_assist",
                            "could not submit employee decision: {error}"
                        ),
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    crate::log_warn!("remote_assist", "pending poll failed: {error}")
                }
            }
            // Cut the idle poll short when the push channel reports a pending
            // request, so the employee's consent prompt appears at once.
            tokio::select! {
                _ = tokio::time::sleep(IDLE_POLL) => {}
                _ = ctx.push.remote_assist.notified() => {}
            }
            continue;
        }

        let session = active.as_ref().expect("checked active session");
        if ctx
            .remote_assist
            .stop_requested
            .swap(false, Ordering::Relaxed)
        {
            if let Err(error) = client.remote_assist_end(&session.id).await {
                crate::log_warn!("remote_assist", "employee stop failed: {error}");
            }
            finish_local(&ctx);
            active = None;
            continue;
        }

        if last_status.elapsed() >= STATUS_INTERVAL {
            last_status = tokio::time::Instant::now();
            match client.remote_assist_session(&session.id).await {
                Ok(status) if status.status == "active" => {}
                Ok(_) => {
                    finish_local(&ctx);
                    active = None;
                    continue;
                }
                Err(error) => {
                    crate::log_warn!("remote_assist", "status poll failed: {error}")
                }
            }
        }

        match client
            .remote_assist_actions(&session.id, last_action_id)
            .await
        {
            Ok(actions) => {
                for action in actions {
                    last_action_id = last_action_id.max(action.id);
                    if let Err(error) = execute_remote_action(&action) {
                        crate::log_warn!("remote_assist", "input rejected: {error}");
                    }
                }
            }
            Err(error) => crate::log_warn!("remote_assist", "action poll failed: {error}"),
        }

        if last_frame.elapsed() >= FRAME_INTERVAL {
            last_frame = tokio::time::Instant::now();
            if let Some(frame) = crate::trackers::capture_remote_frame(&ctx.control) {
                if let Err(error) = client
                    .remote_assist_upload_frame(
                        &session.id,
                        &frame.bytes,
                        frame.width,
                        frame.height,
                    )
                    .await
                {
                    crate::log_warn!("remote_assist", "frame upload failed: {error}");
                }
            }
        }

        tokio::time::sleep(ACTIVE_POLL).await;
    }
}

fn ask_employee(ctx: &SyncContext, session: &RemoteAssistSession) -> bool {
    if let Some(window) = ctx.app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let locale = ctx.settings.current.lock().unwrap().locale.clone();
    let (title, message, accept, decline) = if locale.starts_with("ar") {
        (
            "طلب مساعدة عن بُعد",
            format!(
                "{} يطلب جلسة مساعدة عن بُعد. عند القبول سيتمكن من مشاهدة الشاشة والتحكم في الماوس ولوحة المفاتيح لمدة أقصاها 15 دقيقة. سيظل زر إيقاف ظاهرًا طوال الجلسة.",
                session.owner_name
            ),
            "قبول لمدة 15 دقيقة",
            "رفض",
        )
    } else {
        (
            "Remote assistance request",
            format!(
                "{} is requesting remote assistance. If you accept, they can view this screen and control the mouse and keyboard for up to 15 minutes. A visible Stop button stays on screen for the whole session.",
                session.owner_name
            ),
            "Accept for 15 minutes",
            "Decline",
        )
    };

    ctx.app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            accept.to_string(),
            decline.to_string(),
        ))
        .blocking_show()
}

fn show_indicator(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("remote-assist") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let result = WebviewWindowBuilder::new(
        app,
        "remote-assist",
        WebviewUrl::App("index.html?remote-assist=1".into()),
    )
    .title("BiBoTracking — Remote Assist")
    .inner_size(360.0, 88.0)
    .min_inner_size(320.0, 78.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(false)
    .build();
    if let Err(error) = result {
        crate::log_warn!("remote_assist", "indicator window failed: {error}");
    }
}

fn finish_local(ctx: &SyncContext) {
    ctx.remote_assist.clear();
    if let Some(window) = ctx.app.get_webview_window("remote-assist") {
        let _ = window.close();
    }
}

#[cfg(not(target_os = "windows"))]
fn execute_remote_action(_action: &RemoteAssistAction) -> Result<(), String> {
    Err("remote input is supported on Windows only".into())
}

#[cfg(target_os = "windows")]
fn execute_remote_action(action: &RemoteAssistAction) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT, VIRTUAL_KEY,
        VK_BACK, VK_DELETE, VK_DOWN, VK_ESCAPE, VK_LEFT, VK_RETURN, VK_RIGHT, VK_TAB, VK_UP,
    };

    fn send(inputs: &[INPUT]) -> Result<(), String> {
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize == inputs.len() {
            Ok(())
        } else {
            Err(format!("SendInput accepted {sent}/{} events", inputs.len()))
        }
    }
    fn mouse(
        flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
        x: i32,
        y: i32,
    ) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: x,
                    dy: y,
                    mouseData: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }
    fn keyboard(
        vk: VIRTUAL_KEY,
        scan: u16,
        flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS,
    ) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    match action.kind.as_str() {
        "move" | "click" => {
            let x = action
                .payload
                .get("x")
                .and_then(|v| v.as_f64())
                .ok_or("missing x")?;
            let y = action
                .payload
                .get("y")
                .and_then(|v| v.as_f64())
                .ok_or("missing y")?;
            let px = (x.clamp(0.0, 1.0) * 65_535.0).round() as i32;
            let py = (y.clamp(0.0, 1.0) * 65_535.0).round() as i32;
            let move_input = mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, px, py);
            if action.kind == "move" {
                return send(&[move_input]);
            }
            let right = action.payload.get("button").and_then(|v| v.as_str()) == Some("right");
            let (down, up) = if right {
                (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
            } else {
                (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
            };
            send(&[move_input, mouse(down, 0, 0), mouse(up, 0, 0)])
        }
        "key" => {
            let key = action
                .payload
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or("missing key")?;
            let vk = match key {
                "Enter" => VK_RETURN,
                "Tab" => VK_TAB,
                "Escape" => VK_ESCAPE,
                "Backspace" => VK_BACK,
                "Delete" => VK_DELETE,
                "ArrowUp" => VK_UP,
                "ArrowDown" => VK_DOWN,
                "ArrowLeft" => VK_LEFT,
                "ArrowRight" => VK_RIGHT,
                _ => return Err("unsupported key".into()),
            };
            send(&[
                keyboard(vk, 0, Default::default()),
                keyboard(vk, 0, KEYEVENTF_KEYUP),
            ])
        }
        "text" => {
            let value = action
                .payload
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or("missing text")?;
            let mut inputs = Vec::with_capacity(value.len() * 2);
            for unit in value.encode_utf16() {
                inputs.push(keyboard(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE));
                inputs.push(keyboard(
                    VIRTUAL_KEY(0),
                    unit,
                    KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                ));
            }
            send(&inputs)
        }
        _ => Err("unsupported action".into()),
    }
}
