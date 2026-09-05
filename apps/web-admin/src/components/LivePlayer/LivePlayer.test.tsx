import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { ApiError } from "../../api/types";
import { LivePlayer } from "./LivePlayer";
import type { MediaTransport, TransportEvents } from "../../media/transport";

const mediaMocks = vi.hoisted(() => ({
  startLiveSession: vi.fn(),
  mintViewerToken: vi.fn(),
  stopMediaSession: vi.fn(),
  getMediaSession: vi.fn(),
  mediaErrorOf: vi.fn(),
}));

// mediaErrorOf is the real implementation: the point of several tests below is
// that the typed envelope is decoded correctly, and mocking it would test the
// mock instead.
vi.mock("../../api/media", async () => {
  const actual = await vi.importActual<typeof import("../../api/media")>("../../api/media");
  return { ...actual, ...mediaMocks, mediaErrorOf: actual.mediaErrorOf };
});

const session = {
  id: "session-1",
  business_id: "business-1",
  device_id: "device-1",
  kind: "live" as const,
  state: "waiting_for_agent" as const,
  provider: "fake",
  started_at: "2026-09-01T12:00:00Z",
};

/** A transport whose stream and state changes the test drives by hand. */
class ControlledTransport implements MediaTransport {
  readonly name = "controlled";
  events: TransportEvents | null = null;
  stopped = false;
  connectCalls = 0;

  async connect(_o: unknown, events: TransportEvents) {
    this.connectCalls += 1;
    this.events = events;
    events.onState("connecting");
    return () => {
      this.stopped = true;
    };
  }
}

/** A MediaStream stand-in: jsdom has no real one, and the player only needs
 *  something with stoppable tracks that it can assign to srcObject. */
function fakeStream() {
  const track = { stop: vi.fn(), kind: "video" };
  return { getTracks: () => [track], _track: track } as unknown as MediaStream & {
    _track: { stop: ReturnType<typeof vi.fn> };
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  mediaMocks.startLiveSession.mockResolvedValue({ session });
  mediaMocks.mintViewerToken.mockResolvedValue({
    token: "viewer-token-value",
    expires_at: "2026-09-01T12:02:00Z",
    room: "room-uuid",
    can_publish: false,
    can_subscribe: true,
  });
  mediaMocks.getMediaSession.mockResolvedValue({ session });
  mediaMocks.stopMediaSession.mockResolvedValue({ session: { ...session, state: "ended" } });
  // jsdom's HTMLMediaElement has no play(); the player calls it after binding.
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});

describe("LivePlayer", () => {
  // The whole point of the migration: a <video> carrying a MediaStream. An <img>
  // here is the regression this project exists to prevent.
  it("renders a video element and never an image", async () => {
    const transport = new ControlledTransport();
    const { container } = render(
      <LivePlayer deviceId="device-1" transport={transport} autoStart />,
    );

    const video = await screen.findByTestId("live-video");
    expect(video.tagName).toBe("VIDEO");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("binds the MediaStream to the video element and plays it", async () => {
    const transport = new ControlledTransport();
    render(<LivePlayer deviceId="device-1" transport={transport} autoStart />);

    await waitFor(() => expect(transport.events).not.toBeNull());
    const stream = fakeStream();
    transport.events!.onStream(stream);
    transport.events!.onState("live");

    const video = (await screen.findByTestId("live-video")) as HTMLVideoElement;
    await waitFor(() => expect(video.srcObject).toBe(stream));
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(await screen.findByText("Live")).toBeTruthy();
  });

  // A stream left running after the player is gone is a privacy failure, not a
  // resource leak: the device keeps capturing for a viewer who has left.
  it("stops every track and tears down the transport on unmount", async () => {
    const transport = new ControlledTransport();
    const { unmount } = render(
      <LivePlayer deviceId="device-1" transport={transport} autoStart />,
    );

    await waitFor(() => expect(transport.events).not.toBeNull());
    const stream = fakeStream();
    transport.events!.onStream(stream);

    unmount();

    expect(transport.stopped).toBe(true);
    expect(stream._track.stop).toHaveBeenCalled();
  });

  // Each state has to say something different. "Unavailable" for everything is
  // what makes a viewer call a human instead of reading the screen.
  it("shows a distinct message for each phase", async () => {
    const transport = new ControlledTransport();
    render(<LivePlayer deviceId="device-1" transport={transport} autoStart />);

    // The transport reports "connecting" as soon as it is handed the token.
    expect(await screen.findByText("Connecting to the video stream…")).toBeTruthy();

    await waitFor(() => expect(transport.events).not.toBeNull());

    transport.events!.onState("waiting_for_publisher");
    expect(await screen.findByText("Waiting for the device to start sending…")).toBeTruthy();

    transport.events!.onStream(fakeStream());
    transport.events!.onState("live");
    expect(await screen.findByText("Live")).toBeTruthy();

    transport.events!.onState("reconnecting");
    expect(await screen.findByText("Connection lost — reconnecting…")).toBeTruthy();

    transport.events!.onState("closed");
    expect(await screen.findByText("The session has ended.")).toBeTruthy();
  });

  // The typed envelope carries a code the UI can translate and a request id a
  // user can quote. Falling back to a generic message would waste both.
  it("renders the API error code, its translated message and the request id", async () => {
    mediaMocks.startLiveSession.mockRejectedValue(
      new ApiError(409, "conflict", {
        error: {
          code: "MEDIA_AGENT_OFFLINE",
          message: "The device is offline.",
          request_id: "req-abc123",
          retryable: true,
        },
      }),
    );

    render(<LivePlayer deviceId="device-1" transport={new ControlledTransport()} autoStart />);

    expect(
      await screen.findByText("The device is offline. It will be available when it reconnects."),
    ).toBeTruthy();
    expect(await screen.findByText("MEDIA_AGENT_OFFLINE")).toBeTruthy();
    expect(screen.getByText(/req-abc123/)).toBeTruthy();
  });

  // A deployment with no SFU must say so, not show an empty player.
  it("explains an unconfigured provider instead of spinning", async () => {
    mediaMocks.startLiveSession.mockRejectedValue(
      new ApiError(503, "unavailable", {
        error: {
          code: "MEDIA_PROVIDER_UNCONFIGURED",
          message: "not available",
          request_id: "req-1",
          retryable: false,
        },
      }),
    );

    render(<LivePlayer deviceId="device-1" transport={new ControlledTransport()} autoStart />);

    expect(
      await screen.findByText("Live video is not enabled on this deployment yet."),
    ).toBeTruthy();
    // Not retryable, so the action offers a fresh start rather than a retry.
    expect(await screen.findByRole("button", { name: "Start live view" })).toBeTruthy();
  });

  // A publisher failure is more specific than anything the viewer could infer.
  it("surfaces a session failure code from the control plane", async () => {
    mediaMocks.startLiveSession.mockResolvedValue({
      session: { ...session, state: "failed", failure_code: "CAPTURE_FAILED" },
    });

    render(<LivePlayer deviceId="device-1" transport={new ControlledTransport()} autoStart />);

    expect(await screen.findByText("The device could not capture its screen.")).toBeTruthy();
    expect(await screen.findByText("CAPTURE_FAILED")).toBeTruthy();
  });

  // A spinner with no deadline is a UI that never admits failure.
  it("times out a publisher that never arrives", async () => {
    vi.useFakeTimers();
    try {
      const transport = new ControlledTransport();
      render(<LivePlayer deviceId="device-1" transport={transport} autoStart />);

      // Let the two awaited API calls settle under fake timers.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(16_000);
      });

      expect(screen.getByText("The device did not start sending in time.")).toBeTruthy();
      expect(screen.getByText("TIMEOUT")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches the viewer when stopped", async () => {
    const transport = new ControlledTransport();
    render(<LivePlayer deviceId="device-1" transport={transport} autoStart />);

    await waitFor(() => expect(transport.events).not.toBeNull());
    const stream = fakeStream();
    transport.events!.onStream(stream);
    transport.events!.onState("live");

    const stopButton = await screen.findByRole("button", { name: "Stop" });
    stopButton.click();

    await waitFor(() => expect(mediaMocks.stopMediaSession).toHaveBeenCalledWith("session-1"));
    expect(stream._track.stop).toHaveBeenCalled();
    expect(transport.stopped).toBe(true);
  });

  it("renders in Arabic without falling back to English", async () => {
    await i18n.changeLanguage("ar");
    const transport = new ControlledTransport();
    render(<LivePlayer deviceId="device-1" transport={transport} autoStart />);

    expect(await screen.findByText("جارٍ الاتصال ببث الفيديو…")).toBeTruthy();

    await waitFor(() => expect(transport.events).not.toBeNull());
    transport.events!.onStream(fakeStream());
    transport.events!.onState("live");
    expect(await screen.findByText("مباشر")).toBeTruthy();

    await i18n.changeLanguage("en");
  });
});

it("ends the backend session when its player is unmounted", async () => {
 const transport = new ControlledTransport();
 const view = render(<LivePlayer deviceId="device-1" transport={transport} autoStart />);
 await waitFor(() => expect(transport.connectCalls).toBe(1));
 view.unmount();
 await waitFor(() => expect(mediaMocks.stopMediaSession).toHaveBeenCalledWith("session-1"));
});
it("ends a start response that arrives after the player has left", async () => {
 let resolve!: (value: { session: typeof session }) => void;
 mediaMocks.startLiveSession.mockReturnValueOnce(new Promise(r => { resolve = r; }));
 const transport = new ControlledTransport();
 const view = render(<LivePlayer deviceId="device-1" transport={transport} autoStart />);
 view.unmount();
 await act(async () => { resolve({ session }); });
 expect(mediaMocks.stopMediaSession).toHaveBeenCalledWith("session-1");
 expect(transport.connectCalls).toBe(0);
});

it("surfaces a publisher failure that happens after starting", async () => {
  vi.useFakeTimers();
  try {
    mediaMocks.getMediaSession.mockResolvedValue({ session: { ...session, state: "failed", failure_code: "CAPTURE_FAILED" } });
    render(<LivePlayer deviceId="device-1" transport={new ControlledTransport()} autoStart />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(screen.getByText("The device could not capture its screen.")).toBeTruthy();
    expect(mediaMocks.stopMediaSession).toHaveBeenCalledWith("session-1");
  } finally { vi.useRealTimers(); }
});

it("can switch devices while the old start request is pending", async () => {
  let resolve!: (value: { session: typeof session }) => void;
  mediaMocks.startLiveSession.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  const transport = new ControlledTransport();
  const view = render(<LivePlayer deviceId="device-1" transport={transport} autoStart />);
  view.rerender(<LivePlayer deviceId="device-2" transport={transport} autoStart />);
  await waitFor(() => expect(mediaMocks.startLiveSession).toHaveBeenCalledWith("device-2"));
  await act(async () => { resolve({ session: { ...session, id: "old-session" } }); });
  expect(mediaMocks.stopMediaSession).toHaveBeenCalledWith("old-session");
  expect(transport.connectCalls).toBe(1);
});
