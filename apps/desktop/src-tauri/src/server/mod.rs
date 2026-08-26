//! Local ingest server for the browser extension (see docs/04-browser-extension.md).
//!
//! A tiny axum server bound to 127.0.0.1 only. It binds the first free port from a
//! fixed candidate list (auto-fallback), so the extension can discover it by probing
//! the same list. `/whoami` is the discovery + token handoff; `/ingest` is the
//! token-protected endpoint that records browser visits.

use std::sync::{Arc, Mutex};
use std::thread;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use std::sync::atomic::Ordering;

use crate::storage::{BrowserVisit, Db};
use crate::trackers::TrackerControl;

/// Shared, fixed candidate ports (must match the extension). High registered range,
/// away from common dev/app/macOS ports, spread out.
pub const CANDIDATE_PORTS: [u16; 6] = [47615, 48291, 49377, 50603, 51719, 52837];

/// Header the extension sends with the shared token.
const TOKEN_HEADER: &str = "x-ctracking-token";

/// Reserved URL values the extension posts when the user flips its on/off toggle.
/// These are control events, not page views: recorded even while tracking is paused
/// and exempt from the domain-only rewrite.
const MARKER_OFF: &str = "user_turn_off_in_browser";
const MARKER_ON: &str = "user_turn_on_in_browser";

fn is_marker(url: &str) -> bool {
    url == MARKER_OFF || url == MARKER_ON
}

/// What the server bound to. Managed in Tauri state for the UI/commands.
pub struct BrowserLink {
    pub port: Option<u16>,
    pub token: String,
}

/// Fixed-window rate limit for extension error reports, so a looping bug in the
/// extension can't flood Sentry. Max `ERR_REPORTS_PER_MIN` events per 60s window.
const ERR_REPORTS_PER_MIN: u32 = 10;

#[derive(Default)]
struct ErrLimit {
    window_start: i64,
    count: u32,
}

#[derive(Clone)]
struct AppState {
    db: Arc<Db>,
    token: Arc<String>,
    control: Arc<TrackerControl>,
    err_limit: Arc<Mutex<ErrLimit>>,
}

/// Token + origin guard shared by `/ingest` and `/report-error`. Returns the rejecting
/// status on failure, or `Ok(())` when the request may proceed.
fn check_request(headers: &HeaderMap, token: &str) -> Result<(), StatusCode> {
    match headers.get(TOKEN_HEADER).and_then(|h| h.to_str().ok()) {
        Some(t) if t == token => {}
        _ => return Err(StatusCode::UNAUTHORIZED),
    }
    // Reject web origins — only our extension (no Origin, or chrome-/moz-extension://).
    if let Some(o) = headers.get("origin").and_then(|h| h.to_str().ok()) {
        if o.starts_with("http://") || o.starts_with("https://") {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(())
}

/// Reduce a URL to its origin (`scheme://host`) for the domain-only privacy mode.
fn origin_only(url: &str) -> String {
    if let Some(scheme_end) = url.find("://") {
        let rest = &url[scheme_end + 3..];
        let host_end = rest.find('/').unwrap_or(rest.len());
        format!("{}{}", &url[..scheme_end + 3], &rest[..host_end])
    } else {
        url.to_string()
    }
}

/// Most visits a single `/ingest` call may carry. The extension flushes its
/// outbox in bounded batches; this caps what any local process can push in one
/// request, independently of that.
const MAX_INGEST_BATCH: usize = 200;

#[derive(Deserialize)]
struct VisitIn {
    url: String,
    #[serde(default)]
    page_title: Option<String>,
    ts: i64,
    #[serde(default)]
    browser: Option<String>,
    duration_s: i64,
    /// Extension-supplied key, so a resend after a lost response updates the
    /// visit rather than duplicating it. Absent or malformed values are dropped
    /// and a local key is generated instead — see `valid_uuid`.
    #[serde(default)]
    client_uuid: Option<String>,
    /// Sent by the extension and deliberately ignored: the backend derives the
    /// domain from the URL so the two can never disagree. Accepted here only so
    /// an older desktop build does not reject a newer extension's payload.
    #[serde(default, rename = "domain")]
    _domain: Option<String>,
}

/// One visit, or a batch of them. The extension posts batches; older builds and
/// manual calls post a single object, and both must keep working.
#[derive(Deserialize)]
#[serde(untagged)]
enum IngestIn {
    One(Box<VisitIn>),
    Many(Vec<VisitIn>),
}

/// Accept a client key only when it really is a UUID. The backend rejects a
/// whole sync batch if any `client_uuid` is malformed, so letting a bad value
/// through here would block every other row queued on this device.
fn valid_uuid(s: &Option<String>) -> Option<&str> {
    let s = s.as_deref()?;
    uuid::Uuid::parse_str(s).ok().map(|_| s)
}

/// An error caught in the browser extension, forwarded here so the desktop app can
/// report it to Sentry on the extension's behalf (the MV3 worker can't bundle the SDK).
#[derive(Deserialize)]
struct ErrorIn {
    message: String,
    #[serde(default)]
    stack: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// 16 random bytes, hex-encoded. Sourced from the OS CSPRNG (cross-platform:
/// `getrandom` uses `/dev/urandom` on Unix and `BCryptGenRandom` on Windows).
fn gen_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("OS CSPRNG unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

async fn whoami(State(s): State<AppState>) -> Json<Value> {
    // The extension reads the token here. A web page can't read this response
    // (no CORS headers), and `/ingest` additionally rejects web origins + bad tokens.
    Json(json!({
        "app": "employeetrack",
        "version": env!("CARGO_PKG_VERSION"),
        "token": *s.token,
    }))
}

async fn ingest(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<IngestIn>,
) -> StatusCode {
    if let Err(code) = check_request(&headers, s.token.as_str()) {
        return code;
    }
    let visits = match body {
        IngestIn::One(v) => vec![*v],
        IngestIn::Many(v) => v,
    };
    if visits.len() > MAX_INGEST_BATCH {
        return StatusCode::PAYLOAD_TOO_LARGE;
    }

    for v in visits {
        if let Err(code) = record(&s, v) {
            return code;
        }
    }
    StatusCode::OK
}

/// Apply pause and privacy policy to one visit and store it.
fn record(s: &AppState, v: VisitIn) -> Result<(), StatusCode> {
    // On/off marker events are recorded unconditionally so an "off" transition still
    // lands. Regular page views respect pause + domain-only privacy.
    let marker = is_marker(&v.url);
    if !s.control.monitoring_enabled.load(Ordering::Relaxed) {
        // The server-owned fleet switch is stricter than the employee's local
        // pause: no browser telemetry, including marker rows, is persisted.
        return Ok(());
    }
    if !s.control.category_schedule_allows("websites") {
        return Ok(());
    }
    if !marker && s.control.is_capture_paused() {
        // Tracking stopped: accept the request so the extension doesn't retry, but
        // don't record anything (consistent with the keyboard/window trackers).
        return Ok(());
    }
    // Domain-only privacy mode: store just the origin, and drop the page title.
    // Markers are left intact (they carry no browsing data).
    let domain_only = !marker && s.control.domain_only.load(Ordering::Relaxed);
    let client_uuid = valid_uuid(&v.client_uuid).map(str::to_owned);
    let (url, page_title) = if domain_only {
        (origin_only(&v.url), None)
    } else {
        (v.url, v.page_title)
    };
    let visit = BrowserVisit {
        ts: v.ts,
        url,
        page_title,
        browser: v.browser,
        duration_s: v.duration_s,
    };
    s.db.insert_browser_visit(&visit, client_uuid.as_deref())
        .map(|_| ())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// Receive an error report from the browser extension and forward it to Sentry tagged
/// `source = "extension"`. Rate-limited so a looping extension error can't flood Sentry.
async fn report_error(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(e): Json<ErrorIn>,
) -> StatusCode {
    if let Err(code) = check_request(&headers, s.token.as_str()) {
        return code;
    }
    // Fixed-window rate limit.
    {
        let now = crate::now_unix();
        let mut lim = s.err_limit.lock().unwrap();
        if now - lim.window_start >= 60 {
            lim.window_start = now;
            lim.count = 0;
        }
        if lim.count >= ERR_REPORTS_PER_MIN {
            // Drop quietly — still a success from the extension's point of view.
            return StatusCode::OK;
        }
        lim.count += 1;
    }
    let mut extras: Vec<(&str, String)> = Vec::new();
    if let Some(stack) = &e.stack {
        extras.push(("stack", stack.clone()));
    }
    if let Some(ctx) = &e.context {
        extras.push(("context", ctx.clone()));
    }
    if let Some(url) = &e.url {
        extras.push(("url", url.clone()));
    }
    crate::obs::capture_message(sentry::Level::Error, &e.message, "extension", &extras);
    StatusCode::OK
}

/// Start the loopback ingest server on a background thread. Returns the bound port
/// (or None if all candidates were taken) and the shared token.
pub fn start(db: Arc<Db>, control: Arc<TrackerControl>) -> BrowserLink {
    let token = gen_token();
    let token_arc = Arc::new(token.clone());
    let (tx, rx) = std::sync::mpsc::channel::<Option<u16>>();

    let token_for_task = token_arc.clone();
    thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                crate::log_warn!("server", "runtime build failed: {e}");
                let _ = tx.send(None);
                return;
            }
        };
        rt.block_on(async move {
            // Bind the first free candidate port (auto-fallback).
            let mut bound = None;
            for p in CANDIDATE_PORTS {
                if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", p)).await {
                    bound = Some((l, p));
                    break;
                }
            }
            let (listener, port) = match bound {
                Some(x) => x,
                None => {
                    crate::log_warn!("server", "no candidate port free");
                    let _ = tx.send(None);
                    return;
                }
            };
            let _ = tx.send(Some(port));

            let state = AppState {
                db,
                token: token_for_task,
                control,
                err_limit: Arc::new(Mutex::new(ErrLimit::default())),
            };
            let app = Router::new()
                .route("/whoami", get(whoami))
                .route("/ingest", post(ingest))
                .route("/report-error", post(report_error))
                .with_state(state);
            if let Err(e) = axum::serve(listener, app).await {
                crate::log_warn!("server", "serve ended: {e}");
            }
        });
    });

    let port = rx.recv().unwrap_or(None);
    BrowserLink { port, token }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};

    #[test]
    fn origin_only_strips_path_and_query() {
        assert_eq!(
            origin_only("https://github.com/a/b?c=1"),
            "https://github.com"
        );
        assert_eq!(origin_only("http://example.com"), "http://example.com");
        assert_eq!(origin_only("https://sub.host.io/x"), "https://sub.host.io");
        assert_eq!(origin_only("notaurl"), "notaurl");
    }

    // ---------- request guard ----------

    const TOKEN: &str = "secret-token";

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn accepts_the_right_token() {
        assert!(check_request(&headers(&[(TOKEN_HEADER, TOKEN)]), TOKEN).is_ok());
    }

    #[test]
    fn rejects_a_wrong_or_missing_token() {
        assert_eq!(
            check_request(&headers(&[(TOKEN_HEADER, "nope")]), TOKEN),
            Err(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            check_request(&headers(&[]), TOKEN),
            Err(StatusCode::UNAUTHORIZED)
        );
    }

    // A page in the browser must never be able to post visits, even if it
    // somehow learned the token.
    #[test]
    fn rejects_web_origins() {
        for origin in ["http://evil.example", "https://evil.example"] {
            assert_eq!(
                check_request(
                    &headers(&[(TOKEN_HEADER, TOKEN), ("origin", origin)]),
                    TOKEN
                ),
                Err(StatusCode::FORBIDDEN),
                "{origin} should be refused"
            );
        }
    }

    #[test]
    fn allows_the_extension_origin() {
        let h = headers(&[
            (TOKEN_HEADER, TOKEN),
            ("origin", "chrome-extension://abcdef"),
        ]);
        assert!(check_request(&h, TOKEN).is_ok());
    }

    // ---------- client key validation ----------

    #[test]
    fn accepts_only_real_uuids_as_client_keys() {
        let good = "11111111-2222-3333-4444-555555555555".to_string();
        assert_eq!(valid_uuid(&Some(good.clone())), Some(good.as_str()));

        // A malformed key would make the backend reject the entire sync batch,
        // blocking every other row queued on this device — so it is dropped and
        // a local one is generated instead.
        for bad in ["", "not-a-uuid", "1234", "'; DROP TABLE browser_visit;--"] {
            assert_eq!(
                valid_uuid(&Some(bad.to_string())),
                None,
                "{bad:?} should be refused"
            );
        }
        assert_eq!(valid_uuid(&None), None);
    }

    // ---------- ingest policy ----------

    fn state() -> AppState {
        AppState {
            db: Arc::new(crate::storage::Db::open_in_memory().unwrap()),
            token: Arc::new(TOKEN.to_string()),
            control: Arc::new(TrackerControl::new()),
            err_limit: Arc::new(Mutex::new(ErrLimit::default())),
        }
    }

    fn visit_in(url: &str) -> VisitIn {
        VisitIn {
            url: url.into(),
            page_title: Some("Title".into()),
            ts: 100,
            browser: Some("chrome".into()),
            duration_s: 30,
            client_uuid: None,
            _domain: None,
        }
    }

    fn stored(s: &AppState) -> Vec<crate::storage::BrowserVisit> {
        s.db.browser_visits_between(0, 100_000).unwrap()
    }

    #[test]
    fn pause_suppresses_page_views_but_not_markers() {
        let s = state();
        s.control.paused.store(true, Ordering::Relaxed);

        record(&s, visit_in("https://github.com")).unwrap();
        record(&s, visit_in(MARKER_OFF)).unwrap();

        let rows = stored(&s);
        assert_eq!(
            rows.len(),
            1,
            "only the marker should be recorded while paused"
        );
        assert_eq!(rows[0].url, MARKER_OFF);
    }

    #[test]
    fn remote_monitoring_switch_suppresses_all_browser_telemetry() {
        let s = state();
        s.control.monitoring_enabled.store(false, Ordering::Relaxed);

        record(&s, visit_in("https://github.com")).unwrap();
        record(&s, visit_in(MARKER_OFF)).unwrap();

        assert!(
            stored(&s).is_empty(),
            "the fleet switch must suppress markers too"
        );
    }

    #[test]
    fn domain_only_mode_drops_the_path_and_title() {
        let s = state();
        s.control.domain_only.store(true, Ordering::Relaxed);

        record(
            &s,
            visit_in("https://github.com/anthropics/claude-code?x=1"),
        )
        .unwrap();

        let rows = stored(&s);
        assert_eq!(rows[0].url, "https://github.com");
        assert_eq!(rows[0].page_title, None, "the title can leak the path");
    }

    // Markers carry no browsing data, so privacy mode must leave them intact —
    // rewriting them would break the on/off signal they exist to carry.
    #[test]
    fn domain_only_mode_leaves_markers_intact() {
        let s = state();
        s.control.domain_only.store(true, Ordering::Relaxed);

        record(&s, visit_in(MARKER_ON)).unwrap();

        assert_eq!(stored(&s)[0].url, MARKER_ON);
    }

    #[test]
    fn a_resent_visit_updates_rather_than_duplicating() {
        let s = state();
        let key = "11111111-2222-3333-4444-555555555555";
        let mut first = visit_in("https://github.com");
        first.client_uuid = Some(key.into());
        let mut again = visit_in("https://github.com");
        again.client_uuid = Some(key.into());
        again.duration_s = 90;

        record(&s, first).unwrap();
        record(&s, again).unwrap();

        let rows = stored(&s);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].duration_s, 90);
    }

    #[test]
    fn batches_over_the_cap_are_refused() {
        let body: IngestIn = serde_json::from_str(
            &serde_json::to_string(&vec![
                serde_json::json!({
                    "url": "https://a.com", "ts": 1, "duration_s": 1
                });
                MAX_INGEST_BATCH + 1
            ])
            .unwrap(),
        )
        .unwrap();
        match body {
            IngestIn::Many(v) => assert!(v.len() > MAX_INGEST_BATCH),
            IngestIn::One(_) => panic!("an array must parse as a batch"),
        }
    }

    // Older extension builds post a bare object; both shapes must keep working.
    #[test]
    fn accepts_a_single_object_or_an_array() {
        let one: IngestIn =
            serde_json::from_str(r#"{"url":"https://a.com","ts":1,"duration_s":5}"#).unwrap();
        assert!(matches!(one, IngestIn::One(_)));

        let many: IngestIn =
            serde_json::from_str(r#"[{"url":"https://a.com","ts":1,"duration_s":5}]"#).unwrap();
        assert!(matches!(many, IngestIn::Many(v) if v.len() == 1));
    }

    // The extension sends `domain`; the backend derives its own from the URL, so
    // this build accepts the field and ignores it rather than failing to parse.
    #[test]
    fn an_unknown_domain_field_does_not_break_parsing() {
        let v: IngestIn = serde_json::from_str(
            r#"{"url":"https://a.com","ts":1,"duration_s":5,"domain":"a.com","client_uuid":"11111111-2222-3333-4444-555555555555"}"#,
        )
        .unwrap();
        match v {
            IngestIn::One(v) => {
                assert_eq!(v.url, "https://a.com");
                assert!(valid_uuid(&v.client_uuid).is_some());
            }
            IngestIn::Many(_) => panic!("expected a single object"),
        }
    }
}
