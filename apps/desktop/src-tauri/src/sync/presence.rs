//! Near-real-time presence heartbeat (F16 foundation).
//!
//! This is deliberately independent of the five-minute telemetry uploader. It
//! sends only the current state/app/window every 30 seconds so the owner can see
//! what is open now. When monitoring is paused or disallowed, the heartbeat
//! continues as `online` without foreground metadata.

use std::thread;
use std::time::Duration;

use super::client::{BackendClient, PresenceSignal};
use super::worker::SyncContext;

const STARTUP_DELAY: Duration = Duration::from_secs(3);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

pub fn start(ctx: SyncContext) {
    thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(error) => {
                crate::log_warn!("presence", "runtime build failed: {error}");
                return;
            }
        };
        rt.block_on(run(ctx));
    });
}

async fn run(ctx: SyncContext) {
    tokio::time::sleep(STARTUP_DELAY).await;
    let mut previous: Option<(String, Option<String>, Option<String>)> = None;
    let mut since = crate::now_unix();

    loop {
        if let Some(session) = ctx.auth.session() {
            let device_id = ctx.settings.current.lock().unwrap().device_id.clone();
            let base_url = crate::settings::backend_base_url();
            if !device_id.is_empty() && !base_url.is_empty() {
                let (state, app, window_title) = current_signal(&ctx);
                let identity = (state.clone(), app.clone(), window_title.clone());
                if previous.as_ref() != Some(&identity) {
                    since = crate::now_unix();
                    previous = Some(identity);
                }

                let client = BackendClient::new(base_url, ctx.auth.clone());
                let signal = PresenceSignal {
                    state,
                    app,
                    window_title,
                    since,
                };
                if let Err(error) = client
                    .presence_heartbeat(&device_id, session.business_id.as_deref(), &signal)
                    .await
                {
                    crate::log_warn!("presence", "heartbeat failed: {error}");
                }
            }
        }
        tokio::time::sleep(HEARTBEAT_INTERVAL).await;
    }
}

fn current_signal(ctx: &SyncContext) -> (String, Option<String>, Option<String>) {
    // Presence is still useful while collection is paused, but foreground
    // metadata must obey the same local + remote + schedule controls as activity.
    if !ctx.control.category_allowed("activity") {
        return ("online".into(), None, None);
    }

    let idle = crate::platform::idle_seconds();
    let threshold = ctx
        .control
        .idle_threshold_s
        .load(std::sync::atomic::Ordering::Relaxed) as f64;
    let state = if idle >= threshold { "idle" } else { "active" };
    match crate::platform::active_window() {
        Some(window) => (state.into(), Some(window.app_name), window.title),
        None => ("online".into(), None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_interval_stays_inside_offline_timeout() {
        assert!(HEARTBEAT_INTERVAL < Duration::from_secs(90));
    }
}
