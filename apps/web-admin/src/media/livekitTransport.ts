import { Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";
import type { MediaTransport } from "./transport";

// The player binds a raw MediaStream. Adaptive streaming must stay disabled
// unless the SDK itself attaches the video element and observes its visibility.
export const livekitTransport: MediaTransport = {
  name: "LiveKit",
  async connect(options, events) {
    if (!options.url) throw new Error("LiveKit URL was not supplied by the server.");
    const room = new Room({ adaptiveStream: false, dynacast: true });
    let closed = false;
    let track: RemoteTrack | null = null;
    const disconnect = () => {
      if (closed) return;
      closed = true;
      room.removeAllListeners();
      void room.disconnect();
    };
    room.on(RoomEvent.TrackSubscribed, (incoming) => {
      if (closed || incoming.kind !== Track.Kind.Video || incoming.source !== Track.Source.ScreenShare) return;
      track = incoming;
      events.onStream(new MediaStream([incoming.mediaStreamTrack]));
      events.onState("live");
    });
    room.on(RoomEvent.TrackUnsubscribed, (incoming) => {
      if (incoming !== track || closed) return;
      track = null;
      events.onStreamLost?.();
      events.onState("waiting_for_publisher");
    });
    room.on(RoomEvent.Reconnecting, () => events.onState("reconnecting"));
    room.on(RoomEvent.Reconnected, () => events.onState(track ? "live" : "waiting_for_publisher"));
    room.on(RoomEvent.Disconnected, () => {
      if (closed) return;
      events.onStreamLost?.();
      events.onState("closed");
      disconnect();
    });
    events.onState("connecting");
    try {
      await room.connect(options.url, options.token);
      if (!closed && !track) events.onState("waiting_for_publisher");
      return disconnect;
    } catch {
      disconnect();
      throw new Error("Could not connect to the video service.");
    }
  },
};
