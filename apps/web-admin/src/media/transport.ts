/**
 * The browser-side seam to the media plane, mirroring the backend's
 * MediaProvider.
 *
 * The player depends on this, never on a vendor SDK. That is what lets the whole
 * rendering path -- states, retries, teardown, the <video> binding itself -- be
 * exercised in tests and in a browser with no SFU and no Windows agent, and it
 * is what makes swapping the SFU a change to one adapter.
 *
 * A transport produces a MediaStream. It never produces images: rendering a
 * sequence of pictures and calling it a stream is the thing this project
 * retired (docs/adr/0002-video-first-media-plane.md).
 */

/** Where a connection attempt has got to. Distinct states because a viewer
 *  staring at a black rectangle needs to know which of these is happening. */
export type TransportState =
  | "idle"
  | "connecting"
  | "waiting_for_publisher"
  | "live"
  | "reconnecting"
  | "closed"
  | "failed";

export type TransportEvents = {
  /** A track arrived. The player binds this to <video>. */
  onStream: (stream: MediaStream) => void;
  /** The publisher's track went away but the connection is alive. */
  onStreamLost?: () => void;
  onState: (state: TransportState) => void;
  /** Terminal: the transport will not recover on its own. */
  onError: (error: Error) => void;
};

export type ConnectOptions = {
  /** Short-lived subscribe-only credential from the control plane. */
  token: string;
  room: string;
  /** Where the SFU lives. Absent for transports that need no server. */
  url?: string;
};

export interface MediaTransport {
  /** Human-readable name, for the diagnostics panel. */
  readonly name: string;
  /** Subscribes. Returns a teardown function that must release every track:
   *  a camera or screen capture left running is a privacy failure, not a leak. */
  connect(options: ConnectOptions, events: TransportEvents): Promise<() => void>;
}

/** Stops every track on a stream. Browsers do not release a capture when the
 *  last reference is dropped, so this has to be explicit. */
export function releaseStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track already stopped by the producer throws in some browsers.
      // Teardown must not fail because cleanup was already done.
    }
  }
}
