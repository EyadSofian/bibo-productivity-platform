import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { heartbeatMediaSession, mediaErrorOf, mintViewerToken, startLiveSession, stopMediaSession } from "../../api/media";
import type { MediaFailureCode, MediaSession } from "../../api/media";
import type { MediaTransport, TransportState } from "../../media/transport";
import { releaseStream } from "../../media/transport";

/**
 * The live screen player.
 *
 * A MediaStream bound to a <video> element. Not an <img>, not a canvas blitting
 * loop, not a sequence of images dressed up as a stream -- those are what this
 * product retired, and the CI guard fails the build if one reappears here
 * (docs/adr/0002-video-first-media-plane.md).
 */

/** How long a connection may sit in a non-live state before the viewer is told
 *  something is wrong. A spinner with no timeout is a UI that never admits
 *  failure, so every waiting state has a deadline. */
const CONNECT_TIMEOUT_MS = 15_000;

/** Everything the player can be showing. Each has its own message: a viewer
 *  told only "unavailable" learns nothing and asks a human instead. */
export type PlayerPhase =
  | "idle"
  | "starting"
  | "waiting_for_agent"
  | "connecting"
  | "live"
  | "reconnecting"
  | "ended"
  | "error";

export type PlayerError = {
  /** Machine-readable, from the API envelope or a transport failure. */
  code: string;
  message: string;
  requestId?: string;
  retryable: boolean;
};

export type LivePlayerProps = {
  deviceId: string;
  /** How to reach the media plane. Injected so the player can be driven by a
   *  real SFU, or by the synthetic publisher when there is no SFU to reach. */
  transport: MediaTransport;
  /** Where the SFU lives; unused by transports that need no server. */
  serverUrl?: string;
  /** Called whenever the session changes, so a parent can show session details
   *  without re-fetching. */
  onSession?: (session: MediaSession | null) => void;
  autoStart?: boolean;
};

export function LivePlayer({ deviceId, transport, serverUrl, onSession, autoStart = false }: LivePlayerProps) {
  const { t } = useTranslation("live");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Guards every async continuation: a response that lands after the viewer
  // stopped must not restart what they just stopped.
  const runRef = useRef(0);
  const sessionRef = useRef<MediaSession | null>(null);
  const startingRef = useRef<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [phase, setPhase] = useState<PlayerPhase>("idle");
  const [error, setError] = useState<PlayerError | null>(null);

  const clearTimer = () => {
    if (timeoutRef.current !== undefined) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
  };

  const detachStream = useCallback(() => {
    if (videoRef.current) videoRef.current.srcObject = null;
    releaseStream(streamRef.current);
    streamRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    runRef.current += 1;
    startingRef.current = null;
    clearTimeout(pollRef.current);
    pollRef.current = undefined;
    clearTimer();
    const previous = sessionRef.current;
    sessionRef.current = null;
    if (previous) void stopMediaSession(previous.id).catch(() => {});
    teardownRef.current?.();
    teardownRef.current = null;
    detachStream();
  }, [detachStream]);

  const fail = useCallback((err: PlayerError) => {
    setError(err);
    setPhase("error");
    teardown();
  }, [teardown]);

  // A failure code from the publisher is more specific than anything the viewer
  // could infer, so it becomes the message rather than a generic error.
  const failFromSession = useCallback(
    (s: MediaSession) => {
      const code = (s.failure_code || "TIMEOUT") as MediaFailureCode;
      fail({
        code,
        message: t(`failure.${code}`, { defaultValue: t("failure.unknown") }),
        retryable: code === "AGENT_OFFLINE" || code === "ICE_FAILED" || code === "TIMEOUT",
      });
    },
    [fail, t],
  );

  const armTimeout = useCallback(
    (run: number) => {
      clearTimer();
      timeoutRef.current = setTimeout(() => {
        if (runRef.current !== run) return;
        // Never leave a spinner running forever: after the deadline the viewer
        // gets a code they can report and a button they can press.
        fail({
          code: "TIMEOUT",
          message: t("failure.TIMEOUT"),
          retryable: true,
        });
        teardownRef.current?.();
        teardownRef.current = null;
      }, CONNECT_TIMEOUT_MS);
    },
    [fail, t],
  );

  const onTransportState = useCallback(
    (run: number, state: TransportState) => {
      if (runRef.current !== run) return;
      switch (state) {
        case "connecting":
          setPhase("connecting");
          break;
        case "waiting_for_publisher":
          setPhase("waiting_for_agent");
          break;
        case "live":
          clearTimer();
          setPhase("live");
          setError(null);
          break;
        case "reconnecting":
          setPhase("reconnecting");
          armTimeout(run);
          break;
        case "closed":
          teardown();
          setPhase((current) => (current === "error" ? current : "ended"));
          break;
        case "failed":
          break;
        case "idle":
          break;
      }
    },
    [armTimeout, teardown],
  );

  const start = useCallback(async () => {
    if (startingRef.current === runRef.current) return;
    const previous = sessionRef.current;
    sessionRef.current = null;
    teardown();
    const run = runRef.current;
    startingRef.current = run;
    try {
      if (previous) await stopMediaSession(previous.id).catch(() => {});
      if (runRef.current !== run) return;

      setError(null);
      setPhase("starting");
      armTimeout(run);

      let started: MediaSession;
      try {
        started = (await startLiveSession(deviceId)).session;
      } catch (err) {
        if (runRef.current !== run) return;
        clearTimer();
        const detail = mediaErrorOf(err);
        fail(
          detail
            ? {
                code: detail.code,
                message: t(`error.${detail.code}`, { defaultValue: detail.message }),
                requestId: detail.request_id,
                retryable: detail.retryable,
              }
            : { code: "UNKNOWN", message: t("error.unknown"), retryable: true },
        );
        return;
      }
      if (runRef.current !== run) {
        await stopMediaSession(started.id).catch(() => {});
        return;
      }
      sessionRef.current = started;

      onSession?.(started);
      if (started.state === "failed") {
        clearTimer();
        failFromSession(started);
        return;
      }
      setPhase("waiting_for_agent");

      // Poll serially so publisher failures and policy stops reach the viewer.
      const poll = async () => {
        try {
          const { session: latest } = await heartbeatMediaSession(started.id);
          if (runRef.current !== run) return;
          onSession?.(latest);
          if (latest.state === "failed") { failFromSession(latest); return; }
          if (latest.state === "ended" || latest.state === "ending") {
            teardown();
            setPhase("ended");
            return;
          }
        } catch (err) {
          if (runRef.current !== run) return;
          const detail = mediaErrorOf(err);
          if (detail && !detail.retryable) {
            fail({ code: detail.code, message: t(`error.${detail.code}`, { defaultValue: detail.message }), requestId: detail.request_id, retryable: true });
            return;
          }
          // A transient outage may recover before the server's viewer lease expires.
        }
        if (runRef.current === run) pollRef.current = setTimeout(poll, 1500);
      };
      let token: Awaited<ReturnType<typeof mintViewerToken>>;
      try {
        token = await mintViewerToken(started.id);
      } catch (err) {
        if (runRef.current !== run) return;
        clearTimer();
        const detail = mediaErrorOf(err);
        fail(
          detail
            ? {
                code: detail.code,
                message: t(`error.${detail.code}`, { defaultValue: detail.message }),
                requestId: detail.request_id,
                retryable: detail.retryable,
              }
            : { code: "UNKNOWN", message: t("error.unknown"), retryable: true },
        );
        return;
      }
      if (runRef.current !== run) return;
      pollRef.current = setTimeout(poll, 1500);

      try {
        const stop = await transport.connect(
          { token: token.token, room: token.room, url: token.url ?? serverUrl },
          {
            onStream: (stream) => {
              if (runRef.current !== run) {
                releaseStream(stream);
                return;
              }
              streamRef.current = stream;
              if (videoRef.current) {
                videoRef.current.srcObject = stream;
                // Autoplay can still be refused (a policy the page cannot see);
                // muted playback is normally allowed, and a rejection must not
                // throw into an unhandled promise.
                void videoRef.current.play().catch(() => {});
              }
            },
            onStreamLost: () => {
              if (runRef.current !== run) return;
              detachStream();
              setPhase("reconnecting");
              armTimeout(run);
            },
            onState: (state) => onTransportState(run, state),
            onError: (err) => {
              if (runRef.current !== run) return;
              clearTimer();
              fail({ code: "TRANSPORT_FAILED", message: err.message || t("error.transport"), retryable: true });
            },
          },
        );
        if (runRef.current !== run) {
          stop();
          return;
        }
        teardownRef.current = stop;
      } catch (err) {
        if (runRef.current !== run) return;
        clearTimer();
        fail({
          code: "TRANSPORT_FAILED",
          message: err instanceof Error ? err.message : t("error.transport"),
          retryable: true,
        });
      }
    } finally {
      if (startingRef.current === run) startingRef.current = null;
    }
  }, [armTimeout, deviceId, detachStream, fail, failFromSession, onSession, onTransportState, serverUrl, t, teardown, transport]);

  const stop = useCallback(async () => {
    const current = sessionRef.current;
    sessionRef.current = null;
    teardown();
    setPhase("idle");
    setError(null);
    if (current) {
      // Detaching this viewer. The session survives while others watch, so this
      // is safe to call whenever the player goes away.
      try {
        const result = await stopMediaSession(current.id);
        onSession?.(result.session);
      } catch {
        // A stop that fails changes nothing the viewer can act on: the local
        // teardown has already happened and the session expires on its own.
      }
    }
  }, [onSession, teardown]);

  useEffect(() => {
    if (autoStart) void start();
    // Unmounting must release the tracks. A stream left running after the
    // player is gone is a privacy failure, not a leak.
    return () => teardown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const waiting = phase === "starting" || phase === "waiting_for_agent" || phase === "connecting" || phase === "reconnecting";

  return (
    <section className="live-player" data-phase={phase}>
      <div className="live-player__stage">
        {/* Muted and playsInline so autoplay is permitted; this is a monitoring
            feed, and audio is not part of it in this slice. */}
        <video
          ref={videoRef}
          className="live-player__video"
          autoPlay
          playsInline
          muted
          data-testid="live-video"
          aria-label={t("videoLabel")}
        />

        {phase !== "live" && (
          <div className="live-player__overlay" role="status" aria-live="polite">
            {waiting && <span className="live-player__spinner" aria-hidden />}
            <p className="live-player__status">{t(`phase.${phase}`)}</p>
            {error && (
              <>
                <p className="live-player__error">{error.message}</p>
                <p className="live-player__code">
                  <code>{error.code}</code>
                  {error.requestId ? <span className="live-player__request-id"> · {error.requestId}</span> : null}
                </p>
              </>
            )}
          </div>
        )}

        {phase === "live" && <span className="live-player__badge">{t("phase.live")}</span>}
      </div>

      <div className="live-player__actions">
        {phase === "live" || waiting ? (
          <button type="button" className="bibo-btn bibo-btn--ghost" onClick={() => void stop()}>
            {t("action.stop")}
          </button>
        ) : (
          <button type="button" className="bibo-btn bibo-btn--primary" onClick={() => void start()}>
            {phase === "error" && error?.retryable ? t("action.retry") : t("action.start")}
          </button>
        )}
      </div>
    </section>
  );
}
