import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyntheticTransport } from "./syntheticTransport";
import { releaseStream } from "./transport";
import type { TransportEvents, TransportState } from "./transport";

// jsdom implements neither canvas 2D rendering nor captureStream. The stubs
// below stand in for exactly those two, so what is under test is the
// transport's own lifecycle: which states it reports, in what order, and
// whether teardown actually stops the tracks.
function stubCanvas() {
  const track = { stop: vi.fn(), kind: "video" as const };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const ctx = {
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    set fillStyle(_v: unknown) {},
    set font(_v: unknown) {},
  };
  const captureStream = vi.fn(() => stream);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") {
      return Object.create(HTMLElement.prototype) as HTMLElement;
    }
    return { width: 0, height: 0, getContext: () => ctx, captureStream } as unknown as HTMLElement;
  }) as typeof document.createElement);
  return { track, stream, captureStream, fillRect: ctx.fillRect };
}

function recorder(): TransportEvents & { states: TransportState[]; streams: MediaStream[]; errors: Error[] } {
  const states: TransportState[] = [];
  const streams: MediaStream[] = [];
  const errors: Error[] = [];
  return {
    states,
    streams,
    errors,
    onStream: (s) => streams.push(s),
    onState: (s) => states.push(s),
    onError: (e) => errors.push(e),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SyntheticTransport", () => {
  // This is the agent substitute. If it does not hand over a real MediaStream,
  // it proves nothing about the player it is standing in for.
  it("produces a MediaStream from a canvas capture", async () => {
    const canvas = stubCanvas();
    const events = recorder();

    const stop = await new SyntheticTransport({ width: 640, height: 360, fps: 15 }).connect(
      { token: "t", room: "r" },
      events,
    );

    expect(canvas.captureStream).toHaveBeenCalledWith(15);
    expect(events.streams).toHaveLength(1);
    expect(events.streams[0]).toBe(canvas.stream);
    expect(events.states).toEqual(["connecting", "live"]);
    // Something was actually drawn: a stream of blank frames would let a frozen
    // player pass as a working one.
    const drawsAfterFirstFrame = canvas.fillRect.mock.calls.length;
    expect(drawsAfterFirstFrame).toBeGreaterThan(0);

    // And it keeps drawing. A source that paints once and stops is exactly the
    // frozen-video failure this stand-in exists to rule out.
    vi.advanceTimersByTime(1000);
    expect(canvas.fillRect.mock.calls.length).toBeGreaterThan(drawsAfterFirstFrame);

    stop();

    // Teardown stops the clock: a timer still painting after the transport is
    // gone is a leak that outlives the page it belongs to.
    const drawsAfterStop = canvas.fillRect.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(canvas.fillRect.mock.calls.length).toBe(drawsAfterStop);
  });

  it("stops its tracks on teardown", async () => {
    const canvas = stubCanvas();
    const events = recorder();

    const stop = await new SyntheticTransport().connect({ token: "t", room: "r" }, events);
    expect(canvas.track.stop).not.toHaveBeenCalled();

    stop();

    expect(canvas.track.stop).toHaveBeenCalled();
    expect(events.states[events.states.length - 1]).toBe("closed");
  });

  // Standing in for a device that never starts publishing, so the player's
  // waiting state and its timeout can be exercised without an agent.
  it("can simulate a publisher that never arrives", async () => {
    stubCanvas();
    const events = recorder();

    const stop = await new SyntheticTransport({ neverPublishes: true }).connect(
      { token: "t", room: "r" },
      events,
    );

    expect(events.states).toEqual(["connecting", "waiting_for_publisher"]);
    expect(events.streams).toHaveLength(0);
    stop();
  });

  it("can simulate a connection that fails", async () => {
    stubCanvas();
    const events = recorder();

    await new SyntheticTransport({ failWith: "ICE failed" }).connect({ token: "t", room: "r" }, events);

    expect(events.states).toEqual(["connecting", "failed"]);
    expect(events.errors[0]?.message).toBe("ICE failed");
    expect(events.streams).toHaveLength(0);
  });
});

describe("releaseStream", () => {
  it("stops every track", () => {
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    releaseStream({ getTracks: () => tracks } as unknown as MediaStream);
    for (const track of tracks) expect(track.stop).toHaveBeenCalled();
  });

  it("survives a track that is already stopped", () => {
    const tracks = [
      {
        stop: () => {
          throw new Error("already stopped");
        },
      },
      { stop: vi.fn() },
    ];
    // Teardown must not fail because cleanup already happened; the second track
    // still has to be stopped.
    expect(() => releaseStream({ getTracks: () => tracks } as unknown as MediaStream)).not.toThrow();
    expect(tracks[1].stop).toHaveBeenCalled();
  });

  it("ignores a missing stream", () => {
    expect(() => releaseStream(null)).not.toThrow();
    expect(() => releaseStream(undefined)).not.toThrow();
  });
});
