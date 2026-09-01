//! Continuous live-view capture.
//!
//! Runs only while the push channel holds a current live-view authorization
//! (`PushSignals::live_view`), which the backend renews for as long as an owner
//! actually has the player open. When renewals stop -- viewer closed the tab,
//! connection dropped, backend restarted -- the deadline passes and this loop
//! goes back to sleep on its own.
//!
//! These frames are ephemeral. They are held in backend memory with a short TTL
//! and never written to Postgres or to disk, which is what makes ~1 FPS
//! affordable: routing them through the retained screenshot pipeline instead
//! would store 3600 images per hour of viewing.
//!
//! Scheduled screenshots are a separate, unchanged path. This loop does not
//! write to the local database and does not affect retention.

use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use super::client::BackendClient;
use super::worker::SyncContext;

/// ~1.1 FPS, matching the remote-assistance cadence. Fast enough to follow what
/// someone is doing, slow enough to stay well inside the agent's CPU budget.
const FRAME_INTERVAL: Duration = Duration::from_millis(900);
/// How often to re-check for an authorization while idle.
const IDLE_POLL: Duration = Duration::from_millis(500);
/// A normal HTTPS fallback for environments that interrupt long-lived command
/// streams. This is intentionally much slower than the frame rate and reuses a
/// single HTTP client/connection.
const STATUS_POLL: Duration = Duration::from_secs(4);

pub fn start(ctx: SyncContext) {
    thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                crate::log_warn!("live_view", "runtime build failed: {error}");
                return;
            }
        };
        runtime.block_on(run(ctx));
    });
}

async fn run(ctx: SyncContext) {
    let mut streaming = false;
    let mut backend: Option<(String, BackendClient)> = None;
    let mut next_status_poll = tokio::time::Instant::now();

    loop {
        if !ctx.auth.is_logged_in() {
            ctx.push.live_view.clear();
            backend = None;
            tokio::time::sleep(IDLE_POLL).await;
            continue;
        }
        let device_id = ctx.settings.current.lock().unwrap().device_id.clone();
        let base_url = crate::settings::backend_base_url();
        if device_id.is_empty() || base_url.is_empty() {
            tokio::time::sleep(IDLE_POLL).await;
            continue;
        }

        if backend.as_ref().is_none_or(|(url, _)| url != &base_url) {
            backend = Some((
                base_url.clone(),
                BackendClient::new(base_url.clone(), ctx.auth.clone()),
            ));
        }
        let client = &backend.as_ref().expect("backend client initialized").1;

        // The push channel is the fast path. This status request is the missing
        // fallback: it starts capture when the command stream is down and keeps
        // renewing an active viewer until that stream returns.
        if tokio::time::Instant::now() >= next_status_poll {
            match client.live_view_status(&device_id).await {
                Ok(ttl_ms) if ttl_ms > 0 => ctx.push.live_view.renew(ttl_ms),
                Ok(_) => ctx.push.live_view.clear(),
                Err(error) => crate::log_warn!("live_view", "status fallback failed: {error}"),
            }
            next_status_poll = tokio::time::Instant::now() + STATUS_POLL;
        }

        if !ctx.push.live_view.active() {
            if streaming {
                crate::log_info!("live_view", "authorization lapsed; capture stopped");
                streaming = false;
            }
            tokio::time::sleep(IDLE_POLL).await;
            continue;
        }

        // Policy is re-checked on every frame, not once when the session opens.
        // A schedule that ends, a pause, an owner disabling the device, or a
        // revoked screen-recording permission must stop capture mid-session.
        if !capture_permitted(&ctx) {
            if streaming {
                crate::log_info!("live_view", "capture policy closed; capture stopped");
                streaming = false;
            }
            tokio::time::sleep(IDLE_POLL).await;
            continue;
        }

        if !streaming {
            crate::log_info!("live_view", "viewer attached; streaming");
            streaming = true;
        }

        let started = tokio::time::Instant::now();
        if let Some(frame) = crate::trackers::capture_remote_frame(&ctx.control) {
            match client
                .live_view_upload_frame(&device_id, &frame.bytes, frame.width, frame.height)
                .await
            {
                Ok(true) => {}
                // The backend reports that nobody is watching any more. Stop
                // immediately instead of waiting for the deadline to pass.
                Ok(false) => {
                    crate::log_info!("live_view", "no viewer attached; capture stopped");
                    ctx.push.live_view.clear();
                    streaming = false;
                }
                Err(error) => crate::log_warn!("live_view", "frame upload failed: {error}"),
            }
        }

        // Pace from the start of the capture so a slow frame does not add to the
        // interval; a frame that overran simply yields to the next tick.
        let elapsed = started.elapsed();
        if elapsed < FRAME_INTERVAL {
            tokio::time::sleep(FRAME_INTERVAL - elapsed).await;
        } else {
            tokio::task::yield_now().await;
        }
    }
}

/// The same gate the one-shot live capture applies, evaluated per frame.
fn capture_permitted(ctx: &SyncContext) -> bool {
    use crate::platform::{permission_status, Permission, PermissionState};

    ctx.control.category_allowed("screen")
        && ctx.control.capture_screenshots.load(Ordering::Relaxed)
        && permission_status(Permission::ScreenRecording) == PermissionState::Granted
}

#[cfg(test)]
mod tests {
    use super::{FRAME_INTERVAL, STATUS_POLL};
    use std::time::Duration;

    #[test]
    fn fallback_renews_well_before_authorization_expires() {
        // Kept in step with backend live.LiveViewTTL. Four chances to renew
        // means one failed status request cannot blank an otherwise live view.
        assert!(STATUS_POLL * 4 <= Duration::from_secs(16));
    }

    #[test]
    fn status_fallback_is_not_on_the_frame_hot_path() {
        assert!(STATUS_POLL > FRAME_INTERVAL * 3);
    }
}
