//! Near-real-time presence heartbeat (F16 foundation).
//!
//! This is deliberately independent of the five-minute telemetry uploader. It
//! sends only the current state/app/window every 15 seconds so the owner can see
//! what is open now. When monitoring is paused or disallowed, the heartbeat
//! continues as `online` without foreground metadata.

use std::sync::atomic::Ordering;
use std::thread;
use std::time::{Duration, Instant};

use super::client::{BackendClient, PresenceSignal, ResourceSnapshot};
use super::worker::SyncContext;
use sysinfo::{Disks, Networks, System};

const STARTUP_DELAY: Duration = Duration::from_secs(3);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

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
    let mut resources = ResourceSampler::new();
    tokio::time::sleep(STARTUP_DELAY).await;
    let mut previous: Option<(String, Option<String>, Option<String>)> = None;
    let mut since = crate::now_unix();

    loop {
        if let Some(session) = ctx.auth.session() {
            let device_id = ctx.settings.current.lock().unwrap().device_id.clone();
            let base_url = crate::settings::backend_base_url();
            if !device_id.is_empty() && !base_url.is_empty() {
                let (state, app, window_title) = current_signal(&ctx);
                let collection_allowed = ctx.control.category_allowed("applications");
                let identity = (state.clone(), app.clone(), window_title.clone());
                if previous.as_ref() != Some(&identity) {
                    since = crate::now_unix();
                    previous = Some(identity);
                }

                let client = BackendClient::new(base_url, ctx.auth.clone());
                let resource_snapshot = if collection_allowed {
                    Some(resources.sample())
                } else {
                    resources.reset_baseline();
                    None
                };
                let signal = PresenceSignal {
                    state,
                    app,
                    window_title,
                    since,
                    resources: resource_snapshot,
                };
                match client
                    .presence_heartbeat(&device_id, session.business_id.as_deref(), &signal)
                    .await
                {
                    Ok(result) => {
                        ctx.control
                            .monitoring_enabled
                            .store(result.monitoring_enabled, Ordering::Relaxed);
                        if result.capture_requested {
                            capture_requested_frame(
                                &ctx,
                                &client,
                                &device_id,
                                session.business_id.as_deref(),
                            )
                            .await;
                        }
                    }
                    Err(error) => crate::log_warn!("presence", "heartbeat failed: {error}"),
                }
            }
        }
        // Wait out the interval, or cut it short when the push channel says an
        // owner just asked for a frame. The heartbeat is still what carries and
        // atomically consumes the request, so an agent with no push channel
        // behaves exactly as before -- it just waits the full interval.
        tokio::select! {
            _ = tokio::time::sleep(HEARTBEAT_INTERVAL) => {}
            _ = ctx.push.capture_now.notified() => {}
        }
    }
}

async fn capture_requested_frame(
    ctx: &SyncContext,
    client: &BackendClient,
    device_id: &str,
    business_id: Option<&str>,
) {
    use crate::platform::{permission_status, Permission, PermissionState};
    use crate::storage::SyncTable;

    if !ctx.control.category_allowed("screen")
        || !ctx.control.capture_screenshots.load(Ordering::Relaxed)
        || permission_status(Permission::ScreenRecording) != PermissionState::Granted
    {
        crate::log_info!(
            "presence",
            "live frame skipped by capture policy or permission"
        );
        return;
    }

    let Some(data_dir) = ctx.settings.path.parent() else {
        return;
    };
    let shots_dir = data_dir.join("screenshots");
    let capture_started_at = crate::now_unix();
    if crate::trackers::capture_once(&ctx.db, &shots_dir, &ctx.control) == 0 {
        return;
    }

    // Upload only the frame(s) created for this request. Older unsynced images
    // remain in the normal worker queue and cannot block the live preview.
    let shots = match ctx.db.pending_screenshots_since(capture_started_at, 16) {
        Ok(shots) => shots,
        Err(error) => {
            crate::log_warn!("presence", "live frame query failed: {error}");
            return;
        }
    };
    for shot in shots {
        match client.sync_screenshot(device_id, business_id, &shot).await {
            Ok(accepted) => {
                let _ = ctx.db.mark_synced(SyncTable::Screenshot, &accepted);
            }
            Err(error) => {
                crate::log_warn!("presence", "live frame upload failed: {error}");
                break;
            }
        }
    }
}

struct ResourceSampler {
    system: System,
    networks: Networks,
    disks: Disks,
    last_sample: Instant,
}

impl ResourceSampler {
    fn new() -> Self {
        let mut system = System::new();
        system.refresh_cpu_usage();
        system.refresh_memory();
        Self {
            system,
            networks: Networks::new_with_refreshed_list(),
            disks: Disks::new_with_refreshed_list(),
            last_sample: Instant::now(),
        }
    }

    fn sample(&mut self) -> ResourceSnapshot {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.networks.refresh(true);
        self.disks.refresh(true);

        let elapsed = self.last_sample.elapsed().as_secs_f64().max(1.0);
        self.last_sample = Instant::now();
        let (network_rx, network_tx) =
            self.networks.iter().fold((0_u64, 0_u64), |sum, (_, data)| {
                (
                    sum.0.saturating_add(data.received()),
                    sum.1.saturating_add(data.transmitted()),
                )
            });
        let (disk_total, disk_available) = self.disks.iter().fold((0_u64, 0_u64), |sum, disk| {
            (
                sum.0.saturating_add(disk.total_space()),
                sum.1.saturating_add(disk.available_space()),
            )
        });

        ResourceSnapshot {
            cpu_pct: self.system.global_cpu_usage().clamp(0.0, 100.0),
            memory_used_bytes: self.system.used_memory(),
            memory_total_bytes: self.system.total_memory(),
            disk_used_bytes: disk_total.saturating_sub(disk_available),
            disk_total_bytes: disk_total,
            network_rx_bps: rate_per_second(network_rx, elapsed),
            network_tx_bps: rate_per_second(network_tx, elapsed),
        }
    }

    fn reset_baseline(&mut self) {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.networks.refresh(true);
        self.disks.refresh(true);
        self.last_sample = Instant::now();
    }
}

fn rate_per_second(bytes: u64, elapsed_s: f64) -> u64 {
    if !elapsed_s.is_finite() || elapsed_s <= 0.0 {
        return 0;
    }
    ((bytes as f64 / elapsed_s).max(0.0).min(u64::MAX as f64)) as u64
}

fn current_signal(ctx: &SyncContext) -> (String, Option<String>, Option<String>) {
    // Presence is still useful while collection is paused, but foreground
    // metadata must obey the same local + remote + schedule controls as activity.
    if !ctx.control.category_allowed("applications") {
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

    #[test]
    fn network_rate_handles_elapsed_time_and_invalid_input() {
        assert_eq!(rate_per_second(3_000, 2.0), 1_500);
        assert_eq!(rate_per_second(3_000, 0.0), 0);
        assert_eq!(rate_per_second(3_000, f64::NAN), 0);
    }
}
