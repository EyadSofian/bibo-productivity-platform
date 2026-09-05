// Package server wires the router, middleware, and routes together.
package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ctracking/backend/internal/auth"
	"ctracking/backend/internal/config"
	"ctracking/backend/internal/filestore"
	"ctracking/backend/internal/handlers"
	"ctracking/backend/internal/live"
	"ctracking/backend/internal/media"
	"ctracking/backend/internal/middleware"
	"ctracking/backend/internal/obs"
	"ctracking/backend/internal/retention"
	"ctracking/backend/internal/store"

	sentrygin "github.com/getsentry/sentry-go/gin"
	"github.com/gin-gonic/gin"
)

// New builds the Gin engine with all routes registered. The store, file store, and
// retention service are shared with the caller (which also runs the retention sweeper).
func New(cfg *config.Config, st *store.Store, files *filestore.Store, ret *retention.Service) *gin.Engine {
	// Route gin's own output (access logs, route table, debug warnings) into the same
	// captured stream as obs/log so every line lands in the log file too.
	gin.DefaultWriter = obs.Writer()
	gin.DefaultErrorWriter = obs.Writer()

	r := gin.New()

	// Decide whose X-Forwarded-For we believe, BEFORE anything calls ClientIP().
	// gin's default is to trust every proxy, which lets any client forge the header
	// and mint itself a fresh rate-limit bucket (verified: rotating X-Forwarded-For
	// defeated the login limiter entirely). Trusting nobody is the safe default;
	// a real deployment behind an edge sets TRUSTED_PROXIES or TRUSTED_PLATFORM so
	// legitimate callers are still told apart.
	if cfg.TrustedPlatform != "" {
		r.TrustedPlatform = cfg.TrustedPlatform
	}
	if err := r.SetTrustedProxies(cfg.TrustedProxies); err != nil {
		// A malformed CIDR must not silently fall back to trusting everyone.
		obs.Warn("invalid TRUSTED_PROXIES; trusting no proxy", "error", err)
		_ = r.SetTrustedProxies(nil)
	}

	// RequestID goes first so every later middleware, log line and error body
	// carries the same id.
	r.Use(middleware.RequestID(), gin.Logger(), gin.Recovery(), middleware.CORS(cfg.AllowedOrigin))

	// Report panics to Sentry (then re-panic so gin.Recovery still returns 500).
	// No-op when SENTRY_DSN is unset (the hub has no client).
	if cfg.SentryDSN != "" {
		r.Use(sentrygin.New(sentrygin.Options{Repanic: true}))
	}

	r.GET("/healthz", handlers.NewHealthHandler(st, cfg.LegacyStillCaptureEnabled).Health)

	tok := auth.NewManager(cfg.JWTSecret)
	authH := handlers.NewAuthHandler(st, tok)
	ownerH := handlers.NewOwnerHandler(st, cfg.LegacyStillCaptureEnabled)
	syncH := handlers.NewSyncHandler(st)
	shotH := handlers.NewScreenshotHandler(st, files, cfg.LegacyStillCaptureEnabled)
	reportsH := handlers.NewReportsHandler(st, files)
	retentionH := handlers.NewRetentionHandler(st, ret)
	// Live frames are ephemeral and stay out of Postgres; see internal/live.
	// The command bus is how an agent hears about work without waiting for its
	// next heartbeat -- an accelerator over the polling paths, never a
	// replacement for them.
	liveHub := live.NewHub()
	liveCommands := live.NewCommandBus()

	deviceH := handlers.NewDeviceHandler(st, liveCommands, cfg.LegacyStillCaptureEnabled)
	// No SFU is wired up yet (slice V05): the unconfigured provider fails every
	// operation with a typed error the handlers turn into
	// MEDIA_PROVIDER_UNCONFIGURED, rather than silently doing nothing.
	mediaProvider := mediaProviderFor(cfg)
	mediaH := handlers.NewMediaHandler(st, mediaProvider,
		time.Duration(cfg.MediaTokenTTLSeconds)*time.Second)
	presenceH := handlers.NewPresenceHandler(st)
	remoteAssistH := handlers.NewRemoteAssistHandler(st, liveHub, liveCommands)
	liveViewH := handlers.NewLiveViewHandler(st, liveHub, liveCommands)
	monitoringProfileH := handlers.NewMonitoringProfileHandler(st)
	organizationH := handlers.NewOrganizationHandler(st)
	downloadsH := handlers.NewDownloadsHandler(st, cfg.StaticDir)
	keepaliveH := handlers.NewKeepaliveHandler(cfg.KeepaliveToken)

	// Counted installer downloads (production, when static content is served). Takes
	// precedence over the static NoRoute fallback below.
	if cfg.StaticDir != "" {
		r.GET("/download/:file", downloadsH.Serve)
	}

	v1 := r.Group("/v1")

	// Public picker (no auth).
	v1.GET("/public/businesses", authH.PublicBusinesses)
	// Public download totals (aggregate counts only).
	v1.GET("/public/stats/downloads", downloadsH.Stats)
	// Curated sensitive-app list for screenshot privacy mode / skip-list
	// suggestions (public: the desktop needs it in personal mode too).
	v1.GET("/public/screenshot-privacy-apps", handlers.PrivacyApps)

	// CPU keep-alive (token-gated, NOT rate-limited): keeps the Oracle Always Free
	// box above the idle-reclamation CPU threshold. Only mounted when a token is set.
	if keepaliveH.Enabled() {
		v1.POST("/keepalive", keepaliveH.Burn)
	}

	// Auth endpoints, rate-limited to throttle credential guessing.
	a := v1.Group("/auth", middleware.LoginRateLimit())
	a.POST("/register", authH.Register)
	a.POST("/login", authH.Login)
	a.POST("/refresh", authH.Refresh)

	// Protected routes. Owner/sync/report routes register under this group in
	// later tasks.
	authed := v1.Group("", tok.Required())
	authed.GET("/me", authH.Me)

	// Owner: business + employee management.
	authed.POST("/businesses", ownerH.CreateBusiness)
	authed.GET("/businesses/mine", ownerH.ListMine)
	authed.GET("/businesses/:id/employees", ownerH.ListEmployees)
	authed.PATCH("/businesses/:id/settings", ownerH.UpdateSettings)
	authed.POST("/businesses/:id/screenshots/cleanup", retentionH.Cleanup)
	authed.POST("/employees", ownerH.CreateEmployee)

	// Device fleet inventory & per-machine monitoring control (F40).
	authed.GET("/businesses/:id/devices", deviceH.List)
	authed.POST("/devices/:device_id/monitoring", deviceH.SetMonitoring)
	authed.POST("/devices/:device_id/live-capture", deviceH.RequestLiveCapture)
	authed.POST("/devices/:device_id/remote-assist", remoteAssistH.Request)
	authed.GET("/devices/:device_id/remote-assist/pending", remoteAssistH.Pending)
	authed.GET("/remote-assist/:session_id", remoteAssistH.Session)
	authed.POST("/remote-assist/:session_id/decision", remoteAssistH.Decide)
	authed.POST("/remote-assist/:session_id/end", remoteAssistH.End)
	authed.POST("/remote-assist/:session_id/actions", remoteAssistH.Action)
	authed.GET("/remote-assist/:session_id/actions", remoteAssistH.Actions)
	// The frame upload is registered with the ingest group below (rate-limited).
	authed.GET("/remote-assist/:session_id/frame", remoteAssistH.Frame)
	// Server-push replacement for the dashboard's frame poll.
	authed.GET("/remote-assist/:session_id/frames/stream", remoteAssistH.FrameStream)
	// Video media control plane (docs/adr/0002-video-first-media-plane.md).
	// Metadata, authorization and short-lived tokens only -- no media bytes.
	authed.POST("/devices/:device_id/media/live", mediaH.StartLive)
	authed.GET("/media/sessions/:session_id", mediaH.Session)
	authed.POST("/media/sessions/:session_id/viewer-token", mediaH.ViewerToken)
	authed.POST("/media/sessions/:session_id/stop", mediaH.Stop)
	// Agent-authenticated: the store predicate requires the session's device to
	// belong to the calling agent's own user, so this cannot mint a token for
	// another device even with a valid agent credential.
	authed.POST("/media/sessions/:session_id/publisher-token", mediaH.PublisherToken)

	// Live view: the owner's frame stream, and the agent's command stream.
	// Holding the first open is what keeps the agent capturing.
	authed.GET("/devices/:device_id/live/stream", liveViewH.Stream)
	authed.GET("/agent/commands/stream", liveViewH.AgentCommands)
	authed.GET("/agent/live/status", liveViewH.AgentStatus)
	authed.POST("/devices/:device_id/archive", deviceH.Archive)
	authed.POST("/devices/:device_id/restore", deviceH.Restore)
	authed.GET("/businesses/:id/monitoring-profiles", monitoringProfileH.List)
	authed.POST("/monitoring-profiles", monitoringProfileH.Create)
	authed.PUT("/monitoring-profiles/:profile_id", monitoringProfileH.Update)
	authed.DELETE("/monitoring-profiles/:profile_id", monitoringProfileH.Delete)
	authed.GET("/monitoring-profiles/resolved", monitoringProfileH.Resolved)

	// Lightweight departments and job roles (F7).
	authed.GET("/businesses/:id/organization", organizationH.List)
	authed.POST("/departments", organizationH.CreateDepartment)
	authed.PUT("/departments/:item_id", organizationH.UpdateDepartment)
	authed.DELETE("/departments/:item_id", organizationH.DeleteDepartment)
	authed.POST("/job-roles", organizationH.CreateJobRole)
	authed.PUT("/job-roles/:item_id", organizationH.UpdateJobRole)
	authed.DELETE("/job-roles/:item_id", organizationH.DeleteJobRole)
	authed.PUT("/businesses/:id/employees/:employee_id/organization", organizationH.AssignEmployee)

	// Capture policy for the desktop (employee's org settings).
	authed.GET("/policy", ownerH.Policy)

	// Sync ingest (desktop → backend, one-directional). Rate-limited: these are the
	// only routes a device can push unbounded data through, so a looping client or
	// a stolen agent token is capped here rather than at the database.
	ingest := v1.Group("", tok.Required(), middleware.IngestRateLimit())
	ingest.POST("/sync/batch", syncH.Batch)
	ingest.POST("/sync/screenshots", shotH.Upload)
	ingest.POST("/presence/heartbeat", presenceH.Heartbeat)
	ingest.POST("/remote-assist/:session_id/frame", remoteAssistH.UploadFrame)
	ingest.POST("/agent/live/frame", liveViewH.UploadFrame)
	// A publisher reporting its own progress. Rate-limited with the other
	// agent-push routes: a reconnect storm reports state on every attempt.
	ingest.POST("/agent/media/sessions/:session_id/state", mediaH.AgentState)

	// Owner read path (reporting).
	authed.GET("/reports/employees", reportsH.Roster)
	authed.GET("/reports/employees/:id/activity", reportsH.Activity)
	authed.GET("/reports/employees/:id/keystrokes", reportsH.Keystrokes)
	authed.GET("/reports/employees/:id/browser", reportsH.Browser)
	authed.GET("/reports/employees/:id/states", reportsH.States)
	authed.GET("/reports/employees/:id/screenshots", reportsH.Screenshots)
	authed.GET("/reports/employees/:id/presence", presenceH.Employee)
	authed.GET("/screenshots/:client_uuid", reportsH.ScreenshotImage)

	// Serve static content (same origin as the API) when configured:
	//   /         → marketing landing page (dir/index.html)
	//   /admin/*  → web-admin SPA       (dir/admin/index.html)
	if cfg.StaticDir != "" {
		r.NoRoute(staticSite(cfg.StaticDir))
	}

	return r
}

// staticSite serves files from dir. The marketing page lives at the root and the
// web-admin SPA under /admin: any unmatched /admin/* path falls back to the SPA's
// index.html for client-side routing, everything else to the marketing index.
// Unmatched API paths still return JSON 404s.
func staticSite(dir string) gin.HandlerFunc {
	marketingIndex := filepath.Join(dir, "index.html")
	adminIndex := filepath.Join(dir, "admin", "index.html")
	// serve sends a file, forcing HTML to revalidate every load so a deploy takes
	// effect immediately (browsers otherwise heuristically cache HTML that carries
	// no Cache-Control and keep serving the stale page even on refresh). Cache-busted
	// assets (styles.css?v=, hashed JS/CSS) and latest.json keep their default behaviour.
	serve := func(c *gin.Context, file string) {
		if strings.HasSuffix(file, ".html") {
			c.Header("Cache-Control", "no-cache")
		}
		c.File(file)
	}
	return func(c *gin.Context) {
		p := c.Request.URL.Path
		if p == "/healthz" || p == "/v1" || strings.HasPrefix(p, "/v1/") {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		file := filepath.Join(dir, filepath.Clean("/"+p))
		if fi, err := os.Stat(file); err == nil {
			if !fi.IsDir() {
				serve(c, file)
				return
			}
			// Directory request (e.g. a locale page like /zh/): serve its index.html
			// if present, so localized pages aren't swallowed by the root fallback.
			if idx := filepath.Join(file, "index.html"); idx != marketingIndex {
				if fi2, err2 := os.Stat(idx); err2 == nil && !fi2.IsDir() {
					serve(c, idx)
					return
				}
			}
		}
		if p == "/admin" || strings.HasPrefix(p, "/admin/") {
			serve(c, adminIndex)
			return
		}
		serve(c, marketingIndex)
	}
}

// mediaProviderFor selects the SFU implementation.
//
// An unrecognised MEDIA_PROVIDER falls back to the unconfigured provider and
// says so, rather than booting with no media plane and no explanation. There is
// no real implementation to select yet; slice V05 adds one.
func mediaProviderFor(cfg *config.Config) media.MediaProvider {
	switch cfg.MediaProvider {
	case "", "unconfigured":
		return media.NewUnconfigured()
	default:
		obs.Warn("unknown MEDIA_PROVIDER; live video is disabled",
			"provider", cfg.MediaProvider)
		return media.NewUnconfigured()
	}
}
