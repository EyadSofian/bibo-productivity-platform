import { tokenStore } from "./tokenStore";
import { ApiError, type Tokens } from "./types";
import { Sentry } from "../sentry";
import { log } from "../log";
import { SSEDecoder } from "./sse";

// Empty default base => same-origin relative URLs, which the Vite dev proxy
// (and the backend serving the built SPA in prod) forwards to /v1/*. Set
// VITE_API_BASE to point at a backend on another origin.
const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

// Listeners notified when the session becomes invalid (refresh failed) so the
// React layer can redirect to /login.
type Listener = () => void;
const onLogout = new Set<Listener>();
export function subscribeLogout(fn: Listener): () => void {
  onLogout.add(fn);
  return () => onLogout.delete(fn);
}
function emitLogout() {
  tokenStore.clear();
  onLogout.forEach((fn) => fn());
}

interface RequestOpts {
  method?: string;
  body?: unknown;
  auth?: boolean; // default true
  query?: Record<string, string | number | undefined>;
  // internal: prevents infinite refresh loops
  _retried?: boolean;
}

function buildUrl(path: string, query?: RequestOpts["query"]): string {
  let url = BASE + path;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

// Single-flight refresh: concurrent 401s share one refresh request.
let refreshInFlight: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  const refresh_token = tokenStore.getRefresh();
  if (!refresh_token) return false;
  try {
    const res = await fetch(buildUrl("/v1/auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token }),
    });
    if (!res.ok) return false;
    const tokens = (await res.json()) as Tokens;
    tokenStore.updateTokens(tokens);
    return true;
  } catch {
    return false;
  }
}

function refreshOnce(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  return await res.text();
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      if (typeof b[key] === "string") return b[key] as string;
    }
  }
  if (typeof body === "string" && body.trim()) return body;
  return fallback;
}

export async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = "GET", body, auth = true, query } = opts;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const tok = tokenStore.getAccess();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
  }

  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network-level failure (offline, DNS, CORS) — never reaches the status checks below.
    log.error("api network error", err, { method, path, ms: Math.round(performance.now() - started) });
    throw err;
  }
  const ms = Math.round(performance.now() - started);
  if (res.ok) {
    log.info("api", { method, path, status: res.status, ms });
  } else {
    log.warn("api", { method, path, status: res.status, ms });
  }

  // Auto-refresh on 401, then retry the original request exactly once.
  if (res.status === 401 && auth && !opts._retried) {
    const ok = await refreshOnce();
    if (ok) {
      return request<T>(path, { ...opts, _retried: true });
    }
    emitLogout();
    throw new ApiError(401, "Session expired. Please sign in again.", null);
  }

  if (!res.ok) {
    const errBody = await parseBody(res);
    const apiErr = new ApiError(res.status, errorMessage(errBody, `Request failed (${res.status})`), errBody);
    // Report server-side failures only; 4xx are expected/handled by the UI.
    if (res.status >= 500) {
      Sentry.captureException(apiErr, { tags: { method, path } });
    }
    throw apiErr;
  }

  if (res.status === 204) return undefined as T;
  return (await parseBody(res)) as T;
}

// Auth-gated image fetch: pulls bytes with the Bearer header and returns an
// object URL the caller can use as an <img src> (and must revoke later).
export async function fetchImageObjectUrl(clientUuid: string): Promise<string> {
  const tok = tokenStore.getAccess();
  const res = await fetch(buildUrl(`/v1/screenshots/${clientUuid}`), {
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
  });
  if (res.status === 401) {
    const ok = await refreshOnce();
    if (ok) return fetchImageObjectUrl(clientUuid);
    emitLogout();
    throw new ApiError(401, "Session expired.", null);
  }
  if (!res.ok) throw new ApiError(res.status, `Image failed (${res.status})`, null);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}


// --- live frame streaming ---

/** One live screen frame pushed over SSE. `image` is base64-encoded WebP. */
export type LiveFrameEvent = {
  image: string;
  width: number;
  height: number;
  received_at: string;
};

export type LiveFrameHandlers = {
  onFrame: (frame: LiveFrameEvent) => void;
  /** The session ended server-side; the stream will not reconnect. */
  onEnd: () => void;
  /** A transport failure. The subscription retries on its own afterwards. */
  onError: (error: unknown) => void;
  /** The agent is not reachable on its push channel; frames may be delayed. */
  onAgentUnreachable?: () => void;
};

// Reconnect backoff. A live session lasts minutes, so retries stay short and
// capped rather than growing unbounded.
const STREAM_RETRY_MIN_MS = 500;
const STREAM_RETRY_MAX_MS = 5_000;

/**
 * Subscribes to a remote-assistance session's live frames.
 *
 * Frames are pushed as they arrive instead of being discovered by polling,
 * which is what removes the 0-3s per-frame discovery delay (FULL_SYSTEM_AUDIT
 * P0-1). Returns an unsubscribe function that aborts the request; call it on
 * unmount or when the session changes.
 */
export function subscribeRemoteAssistFrames(
  sessionId: string,
  handlers: LiveFrameHandlers,
): () => void {
  return subscribeFrameStream(`/v1/remote-assist/${sessionId}/frames/stream`, handlers);
}

/**
 * Subscribes to a device's live screen.
 *
 * Holding this stream open is also what keeps the agent capturing: the backend
 * renews the agent's capture authorization for as long as a viewer is attached,
 * and the agent stops on its own once the renewals stop. Closing the stream is
 * therefore the way to stop capture -- there is no separate stop call to miss.
 */
export function subscribeDeviceLiveFrames(
  deviceId: string,
  handlers: LiveFrameHandlers,
): () => void {
  return subscribeFrameStream(`/v1/devices/${deviceId}/live/stream`, handlers);
}

function subscribeFrameStream(path: string, handlers: LiveFrameHandlers): () => void {
  const controller = new AbortController();
  let stopped = false;
  let retryMs = STREAM_RETRY_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    stopped = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    controller.abort();
  };

  const scheduleRetry = () => {
    if (stopped) return;
    retryTimer = setTimeout(() => {
      if (!stopped) void connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, STREAM_RETRY_MAX_MS);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const tok = tokenStore.getAccess();
    let res: Response;
    try {
      res = await fetch(buildUrl(path), {
        headers: {
          Accept: "text/event-stream",
          ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        },
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (stopped) return;
      handlers.onError(error);
      scheduleRetry();
      return;
    }

    if (res.status === 401) {
      const ok = await refreshOnce();
      if (stopped) return;
      if (!ok) {
        emitLogout();
        handlers.onError(new ApiError(401, "Session expired.", null));
        return;
      }
      void connect();
      return;
    }
    // 409 means the session is no longer active: a retry can never succeed.
    if (res.status === 409) {
      handlers.onEnd();
      return;
    }
    if (!res.ok || !res.body) {
      handlers.onError(new ApiError(res.status, `Live stream failed (${res.status})`, null));
      scheduleRetry();
      return;
    }

    // Connected: a later drop is treated as transient again.
    retryMs = STREAM_RETRY_MIN_MS;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const sse = new SSEDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of sse.push(decoder.decode(value, { stream: true }))) {
          if (event.event === "frame") {
            try {
              handlers.onFrame(JSON.parse(event.data) as LiveFrameEvent);
            } catch (error) {
              handlers.onError(error);
            }
          } else if (event.event === "end") {
            stop();
            handlers.onEnd();
            return;
          } else if (event.event === "agent_unreachable") {
            // The device is registered and online but is not holding a command
            // stream, so frames will arrive slowly (or not at all) until it
            // reconnects. Surface it rather than showing an unexplained blank.
            handlers.onAgentUnreachable?.();
          }
          // "ping" is a keepalive and needs no handling.
        }
      }
    } catch (error) {
      if (stopped) return;
      handlers.onError(error);
    } finally {
      reader.cancel().catch(() => {});
    }
    // The server closed the stream without an end event (deploy, proxy
    // timeout): reconnect rather than freezing on the last frame.
    scheduleRetry();
  };

  void connect();
  return stop;
}
