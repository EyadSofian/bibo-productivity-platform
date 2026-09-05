import { request } from "./client";
import { isDemo } from "./demo";
import { ApiError } from "./types";

/**
 * Video media control plane (docs/adr/0002-video-first-media-plane.md).
 *
 * These endpoints carry metadata and short-lived tokens. No media byte passes
 * through them: the video goes agent → SFU → this browser, and the token is the
 * only thing the API hands over.
 */

/** Session lifecycle, mirroring the backend state machine. */
export type MediaSessionState =
  | "requested"
  | "authorizing"
  | "waiting_for_agent"
  | "negotiating"
  | "live"
  | "reconnecting"
  | "ending"
  | "ended"
  | "failed";

/** Why a session ended badly. Every one of these has its own message: a viewer
 *  told "unavailable" learns nothing and asks a human instead. */
export type MediaFailureCode =
  | "DENIED_BY_POLICY"
  | "AGENT_OFFLINE"
  | "TOKEN_EXPIRED"
  | "ICE_FAILED"
  | "CAPTURE_FAILED"
  | "ENCODER_FAILED"
  | "ROOM_FAILED"
  | "TIMEOUT";

export type MediaSession = {
  id: string;
  business_id: string;
  employee_id?: string;
  device_id: string;
  kind: "live" | "recording" | "remote_control";
  state: MediaSessionState;
  provider: string;
  started_at: string;
  ended_at?: string;
  failure_code?: MediaFailureCode | "";
};

export type MediaToken = {
  url?: string;
  token: string;
  expires_at: string;
  room: string;
  can_publish: boolean;
  can_subscribe: boolean;
};

/** The typed error envelope the media endpoints return. */
export type MediaErrorCode =
  | "MEDIA_FORBIDDEN"
  | "MEDIA_SESSION_NOT_FOUND"
  | "MEDIA_DEVICE_NOT_FOUND"
  | "MEDIA_AGENT_OFFLINE"
  | "MEDIA_MONITORING_DISABLED"
  | "MEDIA_SESSION_ENDED"
  | "MEDIA_INVALID_STATE"
  | "MEDIA_PROVIDER_UNCONFIGURED"
  | "MEDIA_PROVIDER_ERROR"
  | "MEDIA_INVALID_REQUEST"
  | "MEDIA_INTERNAL_ERROR";

export type MediaErrorDetail = {
  code: MediaErrorCode | string;
  message: string;
  request_id: string;
  /** Whether trying again could plausibly work. Without this a client either
   *  retries a permission denial forever or gives up on a transient fault. */
  retryable: boolean;
};

/**
 * Extracts the typed detail from a failed request, or null when the response
 * was not a media error (an older endpoint, a proxy error page, a network
 * failure). Callers must handle null rather than assuming the envelope.
 */
export function mediaErrorOf(error: unknown): MediaErrorDetail | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (!body || typeof body !== "object") return null;
  const detail = (body as Record<string, unknown>).error;
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.code !== "string" || typeof d.message !== "string") return null;
  return {
    code: d.code,
    message: d.message,
    request_id: typeof d.request_id === "string" ? d.request_id : "",
    retryable: d.retryable === true,
  };
}

/** Opens or joins the live session for a device. */
export function startLiveSession(deviceId: string) {
  if (isDemo()) {
    return Promise.reject(new ApiError(503, "Video is unavailable in demo mode.", {
      error: { code: "MEDIA_PROVIDER_UNCONFIGURED", message: "Video is unavailable in demo mode.", retryable: false },
    }));
  }
  return request<{ session: MediaSession }>(`/v1/devices/${deviceId}/media/live`, {
    method: "POST",
  });
}

export function getMediaSession(sessionId: string) {
  return request<{ session: MediaSession }>(`/v1/media/sessions/${sessionId}`);
}

export function heartbeatMediaSession(sessionId: string) {
  return request<{ session: MediaSession }>(`/v1/media/sessions/${sessionId}/heartbeat`, { method: "POST" });
}

/** Mints a subscribe-only token. Short-lived by design, so it is fetched when
 *  the player connects and never stored. */
export function mintViewerToken(sessionId: string) {
  return request<MediaToken>(`/v1/media/sessions/${sessionId}/viewer-token`, {
    method: "POST",
  });
}

/** Detaches this viewer. The session only ends when the last one leaves, so
 *  this is safe to call on unmount. */
export function stopMediaSession(sessionId: string) {
  return request<{ session: MediaSession }>(`/v1/media/sessions/${sessionId}/stop`, {
    method: "POST",
  });
}
