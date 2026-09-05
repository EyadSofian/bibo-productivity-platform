//! HTTP client for the backend (tasks 51 + 53).
//!
//! Wraps `reqwest` with the two cross-cutting concerns from docs/11:
//! - **Bearer auth** from the current [`super::auth::Session`].
//! - **Auto-refresh on 401** via `POST /v1/auth/refresh`, retrying the call once.
//!
//! All request/response shapes mirror the backend contract exactly (see docs/11
//! "Sync"). Errors are surfaced as `String` to match the existing command style.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::auth::{AuthState, Session};
use crate::storage::{
    PendingActivity, PendingBrowser, PendingKeystroke, PendingOsState, PendingScreenshot,
};

/// A backend client bound to a base URL and the shared auth state.
#[derive(Clone)]
pub struct BackendClient {
    http: reqwest::Client,
    base_url: String,
    auth: Arc<AuthState>,
}

// ---------- public (no token) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicBusiness {
    pub business_id: String,
    pub name: String,
    pub owner_name: String,
}

/// `GET /v1/public/businesses` wraps the list under `businesses`.
#[derive(Deserialize)]
struct PublicBusinessesResp {
    businesses: Vec<PublicBusiness>,
}

#[derive(Serialize)]
struct LoginReq<'a> {
    email: &'a str,
    password: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    business_id: Option<&'a str>,
}

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    refresh_token: String,
}

/// `POST /v1/auth/login` nests the tokens under `tokens` (alongside `user`),
/// whereas `POST /v1/auth/refresh` returns them at the top level. Mirror the
/// backend exactly rather than assume a uniform shape.
#[derive(Deserialize)]
struct LoginResp {
    tokens: TokenResp,
}

#[derive(Serialize)]
struct RefreshReq<'a> {
    refresh_token: &'a str,
}

/// `GET /v1/policy` — the org's capture policy for the signed-in employee.
/// `managed` is false for standalone users (no org), in which case the desktop
/// keeps its local defaults.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Policy {
    pub managed: bool,
    #[serde(default)]
    pub allow_employee_override: bool,
    #[serde(default)]
    pub screenshot_interval_s: Option<u64>,
    #[serde(default)]
    pub idle_threshold_s: Option<u64>,
    #[serde(default)]
    pub screenshot_retention_days: Option<u64>,
    /// 'team' | 'family' — drives the onboarding copy (employee vs kid).
    #[serde(default)]
    pub kind: Option<String>,
    /// Whether the retired still-screenshot pipeline may run. Absent on an older
    /// backend, which is treated as "still retired": the agent never turns
    /// capture back on because a field was missing from the response.
    #[serde(default)]
    pub still_capture_enabled: Option<bool>,
    /// "full_screen" | "active_window" — org-set screenshot capture mode.
    #[serde(default)]
    pub screenshot_mode: Option<String>,
    /// App names whose capture ticks are skipped entirely while frontmost.
    #[serde(default)]
    pub screenshot_skip_apps: Option<Vec<String>>,
}

/// One category of the backend's curated sensitive-app list
/// (`GET /v1/public/screenshot-privacy-apps`). Serialized back to the UI as-is.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivacyAppCategory {
    pub key: String,
    pub apps: Vec<String>,
}

#[derive(Deserialize)]
struct PrivacyAppsResp {
    categories: Vec<PrivacyAppCategory>,
}

/// `GET /v1/public/screenshot-privacy-apps` — the curated sensitive-app list
/// (privacy-mode auto-skip + UI suggestions). Public, no auth: personal
/// (no-account) users need it too, so this is a free function that doesn't
/// require a session. Callers fall back to the baked-in
/// `trackers::DEFAULT_PRIVACY_APPS` on any error.
pub async fn fetch_privacy_apps(base_url: &str) -> Result<Vec<PrivacyAppCategory>, String> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();
    let url = format!(
        "{}/v1/public/screenshot-privacy-apps",
        base_url.trim_end_matches('/')
    );
    let resp = http.get(url).send().await.map_err(net_err)?;
    if !resp.status().is_success() {
        return Err(status_err(resp).await);
    }
    let parsed: PrivacyAppsResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parsed.categories)
}

// ---------- sync batch contract (docs/11) ----------

#[derive(Serialize)]
struct BatchReq<'a> {
    device_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_label: Option<&'a str>,
    device_os: &'a str,
    agent_version: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    business_id: Option<&'a str>,
    activity: &'a [PendingActivity],
    keystrokes: &'a [PendingKeystroke],
    browser: &'a [PendingBrowser],
    /// Device-state timeline. Older backends ignore the unknown field, so a new
    /// agent stays compatible with a backend that has not been deployed yet.
    os_states: &'a [PendingOsState],
}

/// The backend echoes back exactly the `client_uuid`s it accepted, per kind.
#[derive(Debug, Deserialize, Default)]
pub struct BatchAccepted {
    #[serde(default)]
    pub activity: Vec<String>,
    #[serde(default)]
    pub keystrokes: Vec<String>,
    #[serde(default)]
    pub browser: Vec<String>,
    /// Absent when talking to a backend that predates the state timeline, which
    /// leaves those rows pending rather than marking them wrongly synced.
    #[serde(default)]
    pub os_states: Vec<String>,
}

#[derive(Deserialize)]
struct BatchResp {
    accepted: BatchAccepted,
    #[serde(default = "default_true")]
    monitoring_enabled: bool,
}

fn default_true() -> bool {
    true
}

pub struct BatchResult {
    pub accepted: BatchAccepted,
    pub monitoring_enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResolvedMonitoringDetail {
    pub tracking_key: String,
    pub tracking_val: serde_json::Value,
    pub days_of_week: Vec<u8>,
    pub start_minute: u16,
    pub end_minute: u16,
    pub timezone: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResolvedMonitoringProfile {
    pub details: Vec<ResolvedMonitoringDetail>,
}

#[derive(Deserialize)]
struct ScreenshotResp {
    accepted: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceSnapshot {
    pub cpu_pct: f32,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub disk_used_bytes: u64,
    pub disk_total_bytes: u64,
    pub network_rx_bps: u64,
    pub network_tx_bps: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PresenceSignal {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    pub since: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources: Option<ResourceSnapshot>,
}

#[derive(Deserialize)]
struct PresenceResp {
    #[serde(default = "default_true")]
    monitoring_enabled: bool,
    #[serde(default)]
    capture_requested: bool,
}

#[derive(Deserialize)]
struct LiveViewStatusResp {
    #[serde(default)]
    active: bool,
    #[serde(default)]
    expires_in_ms: i64,
}

fn live_view_ttl(status: &LiveViewStatusResp) -> i64 {
    if status.active {
        status.expires_in_ms.max(0)
    } else {
        0
    }
}

pub struct PresenceResult {
    pub monitoring_enabled: bool,
    pub capture_requested: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteAssistSession {
    pub id: String,
    pub device_id: String,
    pub owner_name: String,
    pub status: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub struct RemoteAssistAction {
    pub id: i64,
    pub kind: String,
    pub payload: serde_json::Value,
}

#[derive(Deserialize)]
struct RemoteAssistSessionResp {
    session: RemoteAssistSession,
}

#[derive(Deserialize)]
struct RemoteAssistActionsResp {
    actions: Vec<RemoteAssistAction>,
}

#[derive(Serialize)]
struct RemoteAssistDecisionReq {
    accepted: bool,
}

#[derive(Serialize)]
struct PresenceReq<'a> {
    device_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    business_id: Option<&'a str>,
    state: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    app: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    window_title: Option<&'a str>,
    since: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    resources: Option<&'a ResourceSnapshot>,
}

impl BackendClient {
    pub fn new(base_url: String, auth: Arc<AuthState>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        BackendClient {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            auth,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    // ---------- public / auth ----------

    /// `GET /v1/public/businesses` — powers the login picker. No token needed.
    pub async fn list_businesses(&self) -> Result<Vec<PublicBusiness>, String> {
        let resp = self
            .http
            .get(self.url("/v1/public/businesses"))
            .send()
            .await
            .map_err(net_err)?;
        if !resp.status().is_success() {
            return Err(status_err(resp).await);
        }
        let parsed: PublicBusinessesResp = resp.json().await.map_err(|e| e.to_string())?;
        Ok(parsed.businesses)
    }

    /// `POST /v1/auth/login`. On success returns the session (does NOT persist it —
    /// the command stores it so the keychain write is explicit).
    pub async fn login(
        &self,
        email: &str,
        password: &str,
        business_id: Option<&str>,
    ) -> Result<Session, String> {
        let resp = self
            .http
            .post(self.url("/v1/auth/login"))
            .json(&LoginReq {
                email,
                password,
                business_id,
            })
            .send()
            .await
            .map_err(net_err)?;
        if !resp.status().is_success() {
            return Err(status_err(resp).await);
        }
        let parsed: LoginResp = resp.json().await.map_err(|e| e.to_string())?;
        Ok(Session {
            access_token: parsed.tokens.access_token,
            refresh_token: parsed.tokens.refresh_token,
            email: email.to_string(),
            business_id: business_id.map(|s| s.to_string()),
        })
    }

    /// `POST /v1/auth/refresh`. Updates the stored tokens in place on success.
    /// Returns the new access token. Caller (the 401 retry path) re-issues the
    /// original request with it.
    pub(crate) async fn refresh(&self) -> Result<String, String> {
        let refresh_token = self
            .auth
            .session()
            .map(|s| s.refresh_token)
            .ok_or_else(|| "not logged in".to_string())?;
        let resp = self
            .http
            .post(self.url("/v1/auth/refresh"))
            .json(&RefreshReq {
                refresh_token: &refresh_token,
            })
            .send()
            .await
            .map_err(net_err)?;
        if !resp.status().is_success() {
            // Refresh itself failed (expired/revoked) → force logout so the UI prompts.
            let _ = self.auth.clear();
            return Err("session expired, please sign in again".to_string());
        }
        let t: TokenResp = resp.json().await.map_err(|e| e.to_string())?;
        self.auth
            .update_tokens(t.access_token.clone(), t.refresh_token)?;
        Ok(t.access_token)
    }

    /// `GET /v1/policy` with auto-refresh on 401.
    pub async fn fetch_policy(&self) -> Result<Policy, String> {
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .get(self.url("/v1/policy"))
                .bearer_auth(&token)
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            return resp.json().await.map_err(|e| e.to_string());
        }
        Err("fetch_policy: unreachable retry exhaustion".into())
    }

    /// Fetch the F41 profile resolved for this exact installation. The server
    /// verifies that the signed-in employee owns the device (or is its manager).
    pub async fn fetch_monitoring_profile(
        &self,
        device_id: &str,
    ) -> Result<ResolvedMonitoringProfile, String> {
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .get(self.url("/v1/monitoring-profiles/resolved"))
                .query(&[("device_id", device_id)])
                .bearer_auth(&token)
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            return resp.json().await.map_err(|e| e.to_string());
        }
        Err("fetch_monitoring_profile: unreachable retry exhaustion".into())
    }

    /// Current access token, or an error if logged out.
    fn access_token(&self) -> Result<String, String> {
        self.auth
            .session()
            .map(|s| s.access_token)
            .ok_or_else(|| "not logged in".to_string())
    }

    // ---------- sync (task 53) ----------

    /// `POST /v1/sync/batch` with auto-refresh on 401. Returns the accepted uuids
    /// per kind. `device_id` and the (optional) `business_id` come from settings/
    /// session.
    pub async fn sync_batch(
        &self,
        device_id: &str,
        business_id: Option<&str>,
        activity: &[PendingActivity],
        keystrokes: &[PendingKeystroke],
        browser: &[PendingBrowser],
        os_states: &[PendingOsState],
    ) -> Result<BatchResult, String> {
        let label = hostname::get()
            .ok()
            .and_then(|name| name.into_string().ok())
            .filter(|name| !name.trim().is_empty());
        let os = os_info::get().to_string();
        let body = BatchReq {
            device_id,
            device_label: label.as_deref(),
            device_os: &os,
            agent_version: env!("CARGO_PKG_VERSION"),
            business_id,
            activity,
            keystrokes,
            browser,
            os_states,
        };

        // First attempt + one retry after a refresh on 401.
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = match self
                .http
                .post(self.url("/v1/sync/batch"))
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    crate::log_warn!("sync", "POST /v1/sync/batch network error: {e}");
                    return Err(net_err(e));
                }
            };

            let status = resp.status();
            if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                crate::log_info!("sync", "POST /v1/sync/batch -> 401, refreshing token");
                token = self.refresh().await?;
                continue;
            }
            if !status.is_success() {
                crate::log_warn!("sync", "POST /v1/sync/batch -> {status}");
                return Err(status_err(resp).await);
            }
            let parsed: BatchResp = resp.json().await.map_err(|e| e.to_string())?;
            crate::log_info!(
                "sync",
                "POST /v1/sync/batch -> {} (act={} keys={} br={} states={})",
                status.as_u16(),
                activity.len(),
                keystrokes.len(),
                browser.len(),
                os_states.len()
            );
            return Ok(BatchResult {
                accepted: parsed.accepted,
                monitoring_enabled: parsed.monitoring_enabled,
            });
        }
        Err("sync_batch: unreachable retry exhaustion".into())
    }

    /// Cheap 30-second presence signal, independent of the five-minute batch.
    pub async fn presence_heartbeat(
        &self,
        device_id: &str,
        business_id: Option<&str>,
        signal: &PresenceSignal,
    ) -> Result<PresenceResult, String> {
        let body = PresenceReq {
            device_id,
            business_id,
            state: &signal.state,
            app: signal.app.as_deref(),
            window_title: signal.window_title.as_deref(),
            since: signal.since,
            resources: signal.resources.as_ref(),
        };
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .post(self.url("/v1/presence/heartbeat"))
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            let parsed: PresenceResp = resp.json().await.map_err(|e| e.to_string())?;
            return Ok(PresenceResult {
                monitoring_enabled: parsed.monitoring_enabled,
                capture_requested: parsed.capture_requested,
            });
        }
        Err("presence_heartbeat: unreachable retry exhaustion".into())
    }

    /// Poll for a pending, device-authorized remote assistance request for this
    /// signed-in employee/device pair. A 204 means there is no request.
    pub async fn remote_assist_pending(
        &self,
        device_id: &str,
    ) -> Result<Option<RemoteAssistSession>, String> {
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .get(self.url(&format!("/v1/devices/{device_id}/remote-assist/pending")))
                .bearer_auth(&token)
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if resp.status() == reqwest::StatusCode::NO_CONTENT {
                return Ok(None);
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            let parsed: RemoteAssistSessionResp = resp.json().await.map_err(|e| e.to_string())?;
            return Ok(Some(parsed.session));
        }
        Err("remote_assist_pending: unreachable retry exhaustion".into())
    }

    pub async fn remote_assist_decide(
        &self,
        session_id: &str,
        accepted: bool,
    ) -> Result<RemoteAssistSession, String> {
        let body = RemoteAssistDecisionReq { accepted };
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .post(self.url(&format!("/v1/remote-assist/{session_id}/decision")))
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            let parsed: RemoteAssistSessionResp = resp.json().await.map_err(|e| e.to_string())?;
            return Ok(parsed.session);
        }
        Err("remote_assist_decide: unreachable retry exhaustion".into())
    }

    pub async fn remote_assist_session(
        &self,
        session_id: &str,
    ) -> Result<RemoteAssistSession, String> {
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .get(self.url(&format!("/v1/remote-assist/{session_id}")))
                .bearer_auth(&token)
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            let parsed: RemoteAssistSessionResp = resp.json().await.map_err(|e| e.to_string())?;
            return Ok(parsed.session);
        }
        Err("remote_assist_session: unreachable retry exhaustion".into())
    }

    pub async fn remote_assist_end(&self, session_id: &str) -> Result<(), String> {
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .post(self.url(&format!("/v1/remote-assist/{session_id}/end")))
                .bearer_auth(&token)
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            return Ok(());
        }
        Err("remote_assist_end: unreachable retry exhaustion".into())
    }

    pub async fn remote_assist_actions(
        &self,
        session_id: &str,
        after: i64,
    ) -> Result<Vec<RemoteAssistAction>, String> {
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .get(self.url(&format!(
                    "/v1/remote-assist/{session_id}/actions?after={after}"
                )))
                .bearer_auth(&token)
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            let parsed: RemoteAssistActionsResp = resp.json().await.map_err(|e| e.to_string())?;
            return Ok(parsed.actions);
        }
        Err("remote_assist_actions: unreachable retry exhaustion".into())
    }

    pub async fn remote_assist_upload_frame(
        &self,
        session_id: &str,
        bytes: &[u8],
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .post(self.url(&format!("/v1/remote-assist/{session_id}/frame")))
                .bearer_auth(&token)
                .header(reqwest::header::CONTENT_TYPE, "image/webp")
                .header("X-Frame-Width", width)
                .header("X-Frame-Height", height)
                .body(bytes.to_vec())
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            return Ok(());
        }
        Err("remote_assist_upload_frame: unreachable retry exhaustion".into())
    }

    /// `POST /v1/agent/live/frame` — one ephemeral live-view frame.
    ///
    /// Returns `false` when the backend reports that no viewer is attached any
    /// more, which tells the capture loop to stop rather than keep encoding
    /// frames nobody will see.
    pub async fn live_view_upload_frame(
        &self,
        device_id: &str,
        bytes: &[u8],
        width: u32,
        height: u32,
    ) -> Result<bool, String> {
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .post(self.url(&format!("/v1/agent/live/frame?device_id={device_id}")))
                .bearer_auth(&token)
                .header(reqwest::header::CONTENT_TYPE, "image/webp")
                .header("X-Frame-Width", width)
                .header("X-Frame-Height", height)
                .body(bytes.to_vec())
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            // 409 is the backend saying the last viewer left. 403 means the
            // owner switched monitoring off or archived the device: in both
            // cases capture must stop, not retry.
            if resp.status() == reqwest::StatusCode::CONFLICT
                || resp.status() == reqwest::StatusCode::FORBIDDEN
            {
                return Ok(false);
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            return Ok(true);
        }
        Err("live_view_upload_frame: unreachable retry exhaustion".into())
    }

    /// `GET /v1/agent/live/status` — low-rate fallback for a command SSE stream
    /// that is blocked or temporarily disconnected. Returns a renewable TTL in
    /// milliseconds, or zero when nobody is watching this device.
    pub async fn live_view_status(&self, device_id: &str) -> Result<i64, String> {
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .get(self.url(&format!("/v1/agent/live/status?device_id={device_id}")))
                .bearer_auth(&token)
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if resp.status() == reqwest::StatusCode::FORBIDDEN {
                return Ok(0);
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            let parsed: LiveViewStatusResp = resp.json().await.map_err(|e| e.to_string())?;
            return Ok(live_view_ttl(&parsed));
        }
        Err("live_view_status: unreachable retry exhaustion".into())
    }

    /// `POST /v1/sync/screenshots` (multipart) for a single screenshot, with the
    /// same 401→refresh→retry behavior. Returns the accepted uuid(s).
    pub async fn sync_screenshot(
        &self,
        device_id: &str,
        business_id: Option<&str>,
        shot: &PendingScreenshot,
    ) -> Result<Vec<String>, String> {
        // Screenshots are already compressed to a small WebP at capture time, so
        // upload the file as-is. Read once; reused across the (rare) retry.
        let bytes = std::fs::read(&shot.file_path)
            .map_err(|e| format!("read screenshot {}: {e}", shot.file_path))?;
        let file_name = format!("{}.webp", shot.client_uuid);

        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let mut form = reqwest::multipart::Form::new()
                .text("client_uuid", shot.client_uuid.clone())
                .text("device_id", device_id.to_string())
                .text("ts", shot.ts.to_string())
                .text("updated_at", shot.updated_at.to_string());
            if let Some(w) = shot.width {
                form = form.text("width", w.to_string());
            }
            if let Some(h) = shot.height {
                form = form.text("height", h.to_string());
            }
            if let Some(d) = shot.display_id {
                form = form.text("display_id", d.to_string());
            }
            if let Some(b) = business_id {
                form = form.text("business_id", b.to_string());
            }
            let part = reqwest::multipart::Part::bytes(bytes.clone())
                .file_name(file_name.clone())
                .mime_str("image/webp")
                .map_err(|e| e.to_string())?;
            form = form.part("image", part);

            let resp = self
                .http
                .post(self.url("/v1/sync/screenshots"))
                .bearer_auth(&token)
                .multipart(form)
                .send()
                .await
                .map_err(net_err)?;

            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            let parsed: ScreenshotResp = resp.json().await.map_err(|e| e.to_string())?;
            return Ok(parsed.accepted);
        }
        Err("sync_screenshot: unreachable retry exhaustion".into())
    }
}

/// Network-level failure (connection refused, DNS, timeout). The worker treats
/// these as "offline / backend down" → backoff, not a hard error.
fn net_err(e: reqwest::Error) -> String {
    format!("network error: {e}")
}

/// Turn a non-2xx response into a readable error, including the body if short.
async fn status_err(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if body.is_empty() {
        format!("backend returned {status}")
    } else {
        format!("backend returned {status}: {body}")
    }
}

#[cfg(test)]
mod policy_tests {
    use super::Policy;

    /// A backend that predates V02 has no still_capture_enabled field. Silence
    /// must read as "retired", never as "allowed" -- otherwise rolling the agent
    /// forward before the backend would restore stored screenshots.
    #[test]
    fn absent_still_capture_field_is_not_permission() {
        let policy: Policy = serde_json::from_str(
            r#"{"managed":true,"allow_employee_override":false,"screenshot_interval_s":300}"#,
        )
        .expect("older policy payload should still parse");

        assert_eq!(policy.still_capture_enabled, None);
        assert!(
            !policy.still_capture_enabled.unwrap_or(false),
            "a missing field must resolve to retired"
        );
    }

    #[test]
    fn explicit_still_capture_field_is_honoured_both_ways() {
        for (raw, want) in [("true", true), ("false", false)] {
            let policy: Policy = serde_json::from_str(&format!(
                r#"{{"managed":true,"allow_employee_override":false,"still_capture_enabled":{raw}}}"#
            ))
            .expect("policy payload should parse");
            assert_eq!(policy.still_capture_enabled, Some(want));
        }
    }
}

#[cfg(test)]
mod live_view_status_tests {
    use super::{live_view_ttl, LiveViewStatusResp};

    #[test]
    fn inactive_status_never_renews_capture() {
        let status = LiveViewStatusResp {
            active: false,
            expires_in_ms: 30_000,
        };
        assert_eq!(live_view_ttl(&status), 0);
    }

    #[test]
    fn active_status_clamps_invalid_ttl() {
        let valid = LiveViewStatusResp {
            active: true,
            expires_in_ms: 30_000,
        };
        let invalid = LiveViewStatusResp {
            active: true,
            expires_in_ms: -1,
        };
        assert_eq!(live_view_ttl(&valid), 30_000);
        assert_eq!(live_view_ttl(&invalid), 0);
    }
}

/// What the backend says this device should be doing.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AgentSession {
    pub session_id: String,
    pub state: String,
    pub room: String,
    /// Whether an operator has been authorised to drive this machine (V07).
    ///
    /// Defaults to **false** when the field is absent, so an older backend - or a
    /// malformed response - can never be read as permission to accept input.
    #[serde(default)]
    pub control_armed: bool,
}

/// Short-lived publish credentials. Never logged, never written to disk.
#[derive(Clone, serde::Deserialize)]
pub struct PublisherToken {
    #[serde(default)]
    pub session_id: String,
    pub url: String,
    pub token: String,
    pub room: String,
}

#[derive(serde::Serialize)]
struct PublisherTokenReq<'a> {
    session_id: &'a str,
    device_id: &'a str,
}

impl BackendClient {
    /// `GET /v1/media/agent/session` — is there a session this device should
    /// publish for? `Ok(None)` on 204, which is the normal idle answer.
    pub async fn agent_media_session(
        &self,
        device_id: &str,
    ) -> Result<Option<AgentSession>, String> {
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .get(self.url("/v1/media/agent/session"))
                .query(&[("device_id", device_id)])
                .bearer_auth(&token)
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if resp.status() == reqwest::StatusCode::NO_CONTENT {
                return Ok(None);
            }
            // The media plane is optional; a 503 means it is switched off, which is
            // not an error worth logging on every poll.
            if resp.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE {
                return Ok(None);
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            return resp.json().await.map(Some).map_err(|e| e.to_string());
        }
        Err("agent_media_session: unreachable retry exhaustion".into())
    }

    /// `POST /v1/media/sessions/:id/publisher-token` — exchange device identity for a
    /// publish-only, short-TTL token. The value is returned to the caller and is
    /// never logged here.
    pub async fn media_publisher_token(
        &self,
        session_id: &str,
        device_id: &str,
    ) -> Result<PublisherToken, String> {
        let body = PublisherTokenReq {
            session_id,
            device_id,
        };
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .post(self.url(&format!("/v1/media/sessions/{session_id}/publisher-token")))
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            return resp.json().await.map_err(|e| e.to_string());
        }
        Err("media_publisher_token: unreachable retry exhaustion".into())
    }

    /// `POST /v1/agent/media/sessions/:id/state` — tell the backend what the
    /// publisher is doing, so a device-side failure surfaces to the operator
    /// instead of showing as an endless "waiting for agent".
    pub async fn report_media_agent_state(
        &self,
        session_id: &str,
        state: &str,
        detail: &str,
        metrics: Option<serde_json::Value>,
    ) -> Result<(), String> {
        let (state, failure_code) = match state {
            "publishing" => ("live", ""),
            "connecting" => ("negotiating", ""),
            "reconnecting" => ("reconnecting", ""),
            "capture_failed" => ("failed", "CAPTURE_FAILED"),
            "encoder_failed" => ("failed", "ENCODER_FAILED"),
            "connection_failed" => ("failed", "ICE_FAILED"),
            "stopped" => ("ended", ""),
            _ => return Ok(()),
        };
        let _ = (detail, metrics);
        let body = serde_json::json!({"state": state, "failure_code": failure_code});
        let mut token = self.access_token()?;
        for attempt in 0..2 {
            let resp = self
                .http
                .post(self.url(&format!("/v1/agent/media/sessions/{session_id}/state")))
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .map_err(net_err)?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(status_err(resp).await);
            }
            return Ok(());
        }
        Err("report_media_agent_state: unreachable retry exhaustion".into())
    }
}
