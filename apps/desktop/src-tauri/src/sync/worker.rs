//! Background sync worker (task 53).
//!
//! Pushes pending local rows (`synced = 0`) to the backend on a timer (~5 min)
//! and once shortly after app start. One pass per table, batched. On a 2xx the
//! backend echoes the accepted `client_uuid`s and we flip exactly those to
//! `synced = 1` — never deleting local rows (docs/11). Failures back off
//! exponentially so a down backend isn't hammered.
//!
//! Offline / logged-out / no backend → the pass is a no-op and rows stay pending,
//! which is the whole point of local-first.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use super::auth::AuthState;
use super::client::BackendClient;
use super::BATCH_LIMIT;
use crate::storage::{Db, SyncTable};
use crate::trackers::MonitoringRule;

/// Base interval between sync passes (5 min). Backoff multiplies this on failure.
const BASE_INTERVAL: Duration = Duration::from_secs(300);
/// Cap the backoff so we still retry roughly every 16 min when the backend is down.
const MAX_INTERVAL: Duration = Duration::from_secs(16 * 60);
/// Short delay before the first pass so startup isn't blocked.
const STARTUP_DELAY: Duration = Duration::from_secs(10);

/// Sync status surfaced to the UI / menu bar (task 53).
#[derive(Default)]
pub struct SyncStatus {
    /// Unix seconds of the last *successful* pass (0 = never).
    pub last_sync_ts: AtomicI64,
    /// Rows still pending after the last pass.
    pub pending: AtomicU64,
    /// Last error message, if the last pass failed (empty = ok).
    pub last_error: Mutex<String>,
}

impl SyncStatus {
    fn record_success(&self, pending: i64) {
        self.last_sync_ts
            .store(crate::now_unix(), Ordering::Relaxed);
        self.pending.store(pending.max(0) as u64, Ordering::Relaxed);
        *self.last_error.lock().unwrap() = String::new();
    }

    fn record_error(&self, msg: String, pending: i64) {
        self.pending.store(pending.max(0) as u64, Ordering::Relaxed);
        *self.last_error.lock().unwrap() = msg;
    }
}

/// Everything a sync pass needs. Cloneable handles shared with the worker thread.
#[derive(Clone)]
pub struct SyncContext {
    pub db: Arc<Db>,
    pub auth: Arc<AuthState>,
    pub status: Arc<SyncStatus>,
    /// Backend base URL + device_id are read fresh each pass so settings changes
    /// (and the first-run device_id) take effect without a restart.
    pub settings: Arc<crate::settings::SettingsState>,
    /// Applies the server-managed per-device monitoring switch immediately to
    /// every capture loop while keeping the employee's own pause separate.
    pub control: Arc<crate::trackers::TrackerControl>,
}

/// Spawn the worker on its own thread with a dedicated single-thread tokio runtime
/// (mirrors `server::start`). Returns immediately.
pub fn start(ctx: SyncContext) {
    thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                crate::log_warn!("sync", "runtime build failed: {e}");
                return;
            }
        };
        rt.block_on(run(ctx));
    });
}

async fn run(ctx: SyncContext) {
    tokio::time::sleep(STARTUP_DELAY).await;
    let mut backoff = BASE_INTERVAL;

    loop {
        match run_once(&ctx).await {
            PassOutcome::Ok => {
                backoff = BASE_INTERVAL;
            }
            PassOutcome::Skipped => {
                // Logged out / no backend configured — wait the normal interval.
                backoff = BASE_INTERVAL;
            }
            PassOutcome::Failed => {
                // Down/offline — grow the wait, capped.
                backoff = (backoff * 2).min(MAX_INTERVAL);
            }
        }
        tokio::time::sleep(backoff).await;
    }
}

pub enum PassOutcome {
    Ok,
    Skipped,
    Failed,
}

/// One full sync pass over all tables. Public so a command can trigger a manual
/// "sync now" later. Returns the outcome that drives the backoff.
pub async fn run_once(ctx: &SyncContext) -> PassOutcome {
    // Logged out → nothing to authenticate the push; stay pending.
    if !ctx.auth.is_logged_in() {
        return PassOutcome::Skipped;
    }

    let base_url = crate::settings::backend_base_url();
    let device_id = ctx.settings.current.lock().unwrap().device_id.clone();
    // business_id is resolved at login and lives on the session.
    let business_id = ctx.auth.session().and_then(|s| s.business_id);
    if base_url.is_empty() || device_id.is_empty() {
        return PassOutcome::Skipped;
    }

    let client = BackendClient::new(base_url, ctx.auth.clone());
    let mut failed = false;
    // Register/heartbeat before resolving F41. This makes company/employee
    // profiles effective on the first real data upload, not five minutes later.
    match client
        .sync_batch(&device_id, business_id.as_deref(), &[], &[], &[])
        .await
    {
        Ok(result) => ctx
            .control
            .monitoring_enabled
            .store(result.monitoring_enabled, Ordering::Relaxed),
        Err(e) => {
            ctx.status.record_error(e, pending_total(ctx));
            return PassOutcome::Failed;
        }
    }

    match client.fetch_monitoring_profile(&device_id).await {
        Ok(profile) => {
            let rules: HashMap<String, MonitoringRule> = profile
                .details
                .into_iter()
                .map(|detail| {
                    (
                        detail.tracking_key,
                        MonitoringRule {
                            enabled: detail.tracking_val.as_bool().unwrap_or(false),
                            days_of_week: detail.days_of_week,
                            start_minute: detail.start_minute,
                            end_minute: detail.end_minute,
                            timezone: detail.timezone,
                        },
                    )
                })
                .collect();
            ctx.control.replace_monitoring_rules(rules);
        }
        Err(e) => crate::log_warn!("sync", "monitoring profile refresh failed: {e}"),
    }

    // --- JSON batch: activity + keystrokes + browser ---
    loop {
        let activity = match ctx.db.pending_activity(BATCH_LIMIT) {
            Ok(v) => v,
            Err(e) => {
                ctx.status
                    .record_error(format!("db: {e}"), pending_total(ctx));
                return PassOutcome::Failed;
            }
        };
        let keystrokes = ctx.db.pending_keystrokes(BATCH_LIMIT).unwrap_or_default();
        let browser = ctx.db.pending_browser(BATCH_LIMIT).unwrap_or_default();

        let empty = activity.is_empty() && keystrokes.is_empty() && browser.is_empty();
        if empty {
            break;
        }

        match client
            .sync_batch(
                &device_id,
                business_id.as_deref(),
                &activity,
                &keystrokes,
                &browser,
            )
            .await
        {
            Ok(result) => {
                ctx.control
                    .monitoring_enabled
                    .store(result.monitoring_enabled, Ordering::Relaxed);
                let accepted = result.accepted;
                let _ = ctx.db.mark_synced(SyncTable::Activity, &accepted.activity);
                let _ = ctx
                    .db
                    .mark_synced(SyncTable::Keystroke, &accepted.keystrokes);
                let _ = ctx.db.mark_synced(SyncTable::Browser, &accepted.browser);

                // Even with no data, the request is the device heartbeat and
                // refreshes the remote monitoring switch.
                if empty {
                    break;
                }

                // If the backend accepted nothing, break to avoid an infinite loop
                // on a poison row; it'll be retried next pass.
                if accepted.activity.is_empty()
                    && accepted.keystrokes.is_empty()
                    && accepted.browser.is_empty()
                {
                    break;
                }
                // Full batches likely mean more pending — loop again. Partial → done.
                if activity.len() < BATCH_LIMIT as usize
                    && keystrokes.len() < BATCH_LIMIT as usize
                    && browser.len() < BATCH_LIMIT as usize
                {
                    break;
                }
            }
            Err(e) => {
                ctx.status.record_error(e, pending_total(ctx));
                failed = true;
                break;
            }
        }
    }

    // --- Screenshots: one multipart upload each ---
    if !failed && ctx.control.monitoring_enabled.load(Ordering::Relaxed) {
        match ctx.db.pending_screenshots(BATCH_LIMIT) {
            Ok(shots) => {
                for shot in shots {
                    match client
                        .sync_screenshot(&device_id, business_id.as_deref(), &shot)
                        .await
                    {
                        Ok(accepted) => {
                            let _ = ctx.db.mark_synced(SyncTable::Screenshot, &accepted);
                        }
                        // Only a genuine network failure (offline) should abort the
                        // pass and trigger backoff. A per-shot rejection or an
                        // unreadable file shouldn't block the other screenshots.
                        Err(e) if e.starts_with("network error") => {
                            ctx.status.record_error(e, pending_total(ctx));
                            failed = true;
                            break;
                        }
                        Err(e) => {
                            crate::log_warn!(
                                "sync",
                                "screenshot {} skipped: {e}",
                                shot.client_uuid
                            );
                            continue;
                        }
                    }
                }
            }
            Err(e) => {
                ctx.status
                    .record_error(format!("db: {e}"), pending_total(ctx));
                failed = true;
            }
        }
    }

    // Match the backend's JSON-batch semantics while remotely paused: retain
    // local history but acknowledge old screenshot outbox entries so enabling
    // the device later cannot upload images from the disabled window.
    if !failed && !ctx.control.monitoring_enabled.load(Ordering::Relaxed) {
        loop {
            let shots = match ctx.db.pending_screenshots(BATCH_LIMIT) {
                Ok(shots) => shots,
                Err(e) => {
                    ctx.status
                        .record_error(format!("db: {e}"), pending_total(ctx));
                    failed = true;
                    break;
                }
            };
            if shots.is_empty() {
                break;
            }
            let ids: Vec<String> = shots.into_iter().map(|shot| shot.client_uuid).collect();
            let _ = ctx.db.mark_synced(SyncTable::Screenshot, &ids);
            if ids.len() < BATCH_LIMIT as usize {
                break;
            }
        }
    }

    let pending = pending_total(ctx);
    if failed {
        PassOutcome::Failed
    } else {
        ctx.status.record_success(pending);
        PassOutcome::Ok
    }
}

fn pending_total(ctx: &SyncContext) -> i64 {
    ctx.db.pending_count().unwrap_or(0)
}
