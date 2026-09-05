import type { ConnectOptions, MediaTransport, TransportEvents } from "./transport";

/**
 * A publisher substitute for environments with no SFU and no Windows agent.
 *
 * It paints a moving scene onto a canvas and hands over
 * `canvas.captureStream()` -- a real MediaStream carrying a real, encoded,
 * moving video track. The player cannot tell it apart from an SFU subscription,
 * which is the point: the rendering path, the state machine, the teardown and
 * the failure handling are all exercised for real.
 *
 * What it does NOT prove: signalling, ICE, TURN, bandwidth adaptation, or
 * anything about the Windows capture pipeline. Those need the real agent and a
 * real SFU. This closes the gap for everything above the network.
 *
 * The scene moves deliberately. A static test image would let a frozen <video>
 * pass as a working one -- exactly the failure mode this project spent V01
 * measuring.
 */
export class SyntheticTransport implements MediaTransport {
  readonly name = "synthetic";

  constructor(
    private readonly opts: {
      width?: number;
      height?: number;
      fps?: number;
      /** Simulates a publisher that never arrives, so the waiting state and its
       *  timeout can be exercised. */
      neverPublishes?: boolean;
      /** Simulates a connection that fails outright. */
      failWith?: string;
      /** Delay before the track appears, in ms. */
      connectDelayMs?: number;
    } = {},
  ) {}

  async connect(_options: ConnectOptions, events: TransportEvents): Promise<() => void> {
    events.onState("connecting");

    if (this.opts.failWith) {
      events.onState("failed");
      events.onError(new Error(this.opts.failWith));
      return () => {};
    }

    const width = this.opts.width ?? 1280;
    const height = this.opts.height ?? 720;
    const fps = this.opts.fps ?? 15;

    let stopped = false;
    let ticker: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stream: MediaStream | null = null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    const draw = (frame: number) => {
      if (!ctx) return;
      // A gradient that shifts plus a sweeping bar: cheap to draw, and visibly
      // wrong the moment the video freezes.
      const shift = (frame * 2) % 360;
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, `hsl(${shift}, 45%, 22%)`);
      gradient.addColorStop(1, `hsl(${(shift + 90) % 360}, 45%, 12%)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      const barX = (frame * 6) % (width + 160) - 160;
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.fillRect(barX, 0, 160, height);

      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = `${Math.round(height / 18)}px system-ui, sans-serif`;
      ctx.fillText(`synthetic publisher · frame ${frame}`, 24, height - 28);
    };

    const start = () => {
      if (stopped) return;
      let frame = 0;
      draw(frame++);

      // setInterval, not requestAnimationFrame. rAF stops completely while the
      // tab is hidden, which would make this stand-in stop publishing the
      // moment nobody is looking at the harness -- verified in a real browser,
      // where a hidden tab decoded exactly one frame. rAF also ignores the
      // requested rate and runs at the display's, so `fps` would be a lie.
      // Timers are throttled in a hidden tab but never stopped.
      ticker = setInterval(() => {
        if (stopped) return;
        draw(frame++);
      }, Math.max(1, Math.round(1000 / fps)));

      // captureStream is what makes this a real MediaStream rather than a
      // simulation of one.
      stream = canvas.captureStream(fps);
      events.onState("live");
      events.onStream(stream);
    };

    if (this.opts.neverPublishes) {
      events.onState("waiting_for_publisher");
    } else if (this.opts.connectDelayMs) {
      events.onState("waiting_for_publisher");
      timer = setTimeout(start, this.opts.connectDelayMs);
    } else {
      start();
    }

    return () => {
      stopped = true;
      if (ticker !== undefined) clearInterval(ticker);
      if (timer !== undefined) clearTimeout(timer);
      if (stream) {
        for (const track of stream.getTracks()) {
          try {
            track.stop();
          } catch {
            // already stopped
          }
        }
      }
      events.onState("closed");
    };
  }
}
