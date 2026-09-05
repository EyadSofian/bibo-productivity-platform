import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportEvents } from "./transport";

const sdk = vi.hoisted(() => ({ rooms: [] as any[], rejectConnect: false }));
vi.mock("livekit-client", () => ({
  Track: { Kind: { Video: "video" }, Source: { ScreenShare: "screen_share" } },
  RoomEvent: Object.fromEntries(["TrackSubscribed", "TrackUnsubscribed", "Reconnecting", "Reconnected", "Disconnected"].map(k => [k, k])),
  Room: class {
    handlers = new Map<string, (...args: any[]) => void>();
    disconnect = vi.fn();
    constructor(public options: unknown) { sdk.rooms.push(this); }
    on(event: string, handler: (...args: any[]) => void) { this.handlers.set(event, handler); }
    removeAllListeners() { this.handlers.clear(); }
    async connect() { if (sdk.rejectConnect) throw new Error("secret credential and URL"); }
    emit(event: string, ...args: any[]) { this.handlers.get(event)?.(...args); }
  },
}));
import { livekitTransport } from "./livekitTransport";

beforeEach(() => {
  sdk.rooms.length = 0;
  sdk.rejectConnect = false;
  vi.stubGlobal("MediaStream", class { constructor(public tracks: unknown[]) {} });
});
function events(): TransportEvents {
  return { onStream: vi.fn(), onState: vi.fn(), onError: vi.fn(), onStreamLost: vi.fn() };
}

describe("LiveKit viewer transport", () => {
  it("keeps raw video subscriptions active and accepts only screen video", async () => {
    const sink = events();
    const stop = await livekitTransport.connect({ url: "wss://media.test", token: "test", room: "r" }, sink);
    const room = sdk.rooms[0];
    expect(room.options.adaptiveStream).toBe(false);
    room.emit("TrackSubscribed", { kind: "audio", source: "screen_share" });
    room.emit("TrackSubscribed", { kind: "video", source: "camera" });
    expect(sink.onStream).not.toHaveBeenCalled();
    const screen = { kind: "video", source: "screen_share", mediaStreamTrack: {} };
    room.emit("TrackSubscribed", screen);
    expect(sink.onStream).toHaveBeenCalledOnce();
    expect(sink.onState).toHaveBeenLastCalledWith("live");
    room.emit("TrackUnsubscribed", screen);
    expect(sink.onStreamLost).toHaveBeenCalledOnce();
    stop(); stop();
    expect(room.disconnect).toHaveBeenCalledOnce();
    room.emit("TrackSubscribed", screen);
    expect(sink.onStream).toHaveBeenCalledOnce();
  });

  it("disconnects failed connections without exposing SDK credentials", async () => {
    sdk.rejectConnect = true;
    await expect(livekitTransport.connect({ url: "wss://media.test", token: "test", room: "r" }, events()))
      .rejects.toThrow("Could not connect to the video service.");
    expect(sdk.rooms[0].disconnect).toHaveBeenCalledOnce();
    expect(sdk.rooms[0].handlers.size).toBe(0);
  });
});
