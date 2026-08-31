import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tokens, User } from "./types";

const seed: Tokens = { access_token: "access-1", refresh_token: "refresh-1", expires_in: 900 };
const user: User = {
  id: "u1",
  email: "owner@example.com",
  display_name: "Owner",
  account_type: "manager",
};

const SESSION = "11111111-1111-1111-1111-111111111111";

/** Builds an SSE response whose body streams the given chunks in order. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function frameChunk(image: string, width = 640, height = 480): string {
  return `event: frame\ndata: ${JSON.stringify({
    image,
    width,
    height,
    received_at: "2026-08-31T10:00:00Z",
  })}\n\n`;
}

async function loadClient() {
  vi.resetModules();
  const tokenStore = (await import("./tokenStore")).tokenStore;
  const client = await import("./client");
  return { ...client, tokenStore };
}

/** Waits until check() passes or the attempt budget runs out. */
async function until(check: () => boolean, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition never became true");
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("subscribeRemoteAssistFrames", () => {
  it("delivers pushed frames to the handler", async () => {
    const { subscribeRemoteAssistFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([frameChunk("AAAA"), frameChunk("BBBB")]),
    );

    const frames: string[] = [];
    const stop = subscribeRemoteAssistFrames(SESSION, {
      onFrame: (f) => frames.push(f.image),
      onEnd: () => {},
      onError: () => {},
    });

    await until(() => frames.length === 2);
    stop();
    expect(frames).toEqual(["AAAA", "BBBB"]);
  });

  it("sends the bearer token in a header, never in the URL", async () => {
    const { subscribeRemoteAssistFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sseResponse([frameChunk("AAAA")]));

    const frames: string[] = [];
    const stop = subscribeRemoteAssistFrames(SESSION, {
      onFrame: (f) => frames.push(f.image),
      onEnd: () => {},
      onError: () => {},
    });
    await until(() => frames.length === 1);
    stop();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).not.toContain("access-1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-1");
    expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
  });

  it("reports the session ending and does not reconnect", async () => {
    const { subscribeRemoteAssistFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sseResponse(['event: end\ndata: {"reason":"session_closed"}\n\n']));

    let ended = 0;
    const stop = subscribeRemoteAssistFrames(SESSION, {
      onFrame: () => {},
      onEnd: () => {
        ended++;
      },
      onError: () => {},
    });

    await until(() => ended === 1);
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(ended).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("treats 409 as a closed session rather than retrying", async () => {
    const { subscribeRemoteAssistFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 409 }));

    let ended = 0;
    const stop = subscribeRemoteAssistFrames(SESSION, {
      onFrame: () => {},
      onEnd: () => {
        ended++;
      },
      onError: () => {},
    });

    await until(() => ended === 1);
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refreshes once on 401 and retries the stream", async () => {
    const { subscribeRemoteAssistFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);

    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/auth/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 900, user }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      call++;
      if (call === 1) return new Response("{}", { status: 401 });
      return sseResponse([frameChunk("AFTER-REFRESH")]);
    });

    const frames: string[] = [];
    const stop = subscribeRemoteAssistFrames(SESSION, {
      onFrame: (f) => frames.push(f.image),
      onEnd: () => {},
      onError: () => {},
    });

    await until(() => frames.length === 1);
    stop();
    expect(frames).toEqual(["AFTER-REFRESH"]);
  });

  it("reconnects after the stream drops without an end event", async () => {
    const { subscribeRemoteAssistFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);

    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call++;
      // First connection ends mid-session (proxy timeout / deploy).
      if (call === 1) return sseResponse([frameChunk("FIRST")]);
      return sseResponse([frameChunk("SECOND")]);
    });

    const frames: string[] = [];
    const stop = subscribeRemoteAssistFrames(SESSION, {
      onFrame: (f) => frames.push(f.image),
      onEnd: () => {},
      onError: () => {},
    });

    await until(() => frames.includes("SECOND"), 400);
    stop();
    expect(frames[0]).toBe("FIRST");
  });

  it("stops fetching once unsubscribed", async () => {
    const { subscribeRemoteAssistFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sseResponse([frameChunk("AAAA")]));

    const frames: string[] = [];
    const stop = subscribeRemoteAssistFrames(SESSION, {
      onFrame: (f) => frames.push(f.image),
      onEnd: () => {},
      onError: () => {},
    });
    await until(() => frames.length === 1);
    stop();

    const callsAtStop = fetchSpy.mock.calls.length;
    // Well past the 500ms minimum retry backoff.
    await new Promise((r) => setTimeout(r, 700));
    expect(fetchSpy.mock.calls.length).toBe(callsAtStop);
  });

  it("surfaces a transport failure and keeps retrying", async () => {
    const { subscribeRemoteAssistFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);

    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call++;
      if (call === 1) throw new TypeError("network down");
      return sseResponse([frameChunk("RECOVERED")]);
    });

    const errors: unknown[] = [];
    const frames: string[] = [];
    const stop = subscribeRemoteAssistFrames(SESSION, {
      onFrame: (f) => frames.push(f.image),
      onEnd: () => {},
      onError: (e) => errors.push(e),
    });

    await until(() => frames.length === 1, 400);
    stop();
    expect(errors.length).toBeGreaterThan(0);
    expect(frames).toEqual(["RECOVERED"]);
  });

  it("reports a malformed frame without tearing down the stream", async () => {
    const { subscribeRemoteAssistFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse(["event: frame\ndata: {not json\n\n", frameChunk("GOOD")]),
    );

    const errors: unknown[] = [];
    const frames: string[] = [];
    const stop = subscribeRemoteAssistFrames(SESSION, {
      onFrame: (f) => frames.push(f.image),
      onEnd: () => {},
      onError: (e) => errors.push(e),
    });

    await until(() => frames.length === 1);
    stop();
    expect(errors.length).toBe(1);
    expect(frames).toEqual(["GOOD"]);
  });
});

describe("subscribeDeviceLiveFrames", () => {
  const DEVICE = "22222222-2222-2222-2222-222222222222";

  it("streams a device's live frames", async () => {
    const { subscribeDeviceLiveFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sseResponse([frameChunk("LIVE1"), frameChunk("LIVE2")]));

    const frames: string[] = [];
    const stop = subscribeDeviceLiveFrames(DEVICE, {
      onFrame: (f) => frames.push(f.image),
      onEnd: () => {},
      onError: () => {},
    });

    await until(() => frames.length === 2);
    stop();
    expect(frames).toEqual(["LIVE1", "LIVE2"]);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(`/v1/devices/${DEVICE}/live/stream`);
  });

  it("reports an agent that is not on its push channel", async () => {
    const { subscribeDeviceLiveFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        'event: agent_unreachable\ndata: {"reason":"no_command_stream"}\n\n',
        frameChunk("LATE"),
      ]),
    );

    let unreachable = 0;
    const frames: string[] = [];
    const stop = subscribeDeviceLiveFrames(DEVICE, {
      onFrame: (f) => frames.push(f.image),
      onEnd: () => {},
      onError: () => {},
      onAgentUnreachable: () => {
        unreachable++;
      },
    });

    await until(() => frames.length === 1);
    stop();
    // The warning must not tear the stream down: a slow agent still delivers.
    expect(unreachable).toBe(1);
    expect(frames).toEqual(["LATE"]);
  });

  it("treats a device that cannot be viewed as a closed stream", async () => {
    const { subscribeDeviceLiveFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 409 }));

    let ended = 0;
    const stop = subscribeDeviceLiveFrames(DEVICE, {
      onFrame: () => {},
      onEnd: () => {
        ended++;
      },
      onError: () => {},
    });

    await until(() => ended === 1);
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // Closing the stream is what stops the agent capturing, so unsubscribing must
  // actually abort the request rather than leave it open.
  it("stops the stream when the viewer unsubscribes", async () => {
    const { subscribeDeviceLiveFrames, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);
    let aborted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      (init as RequestInit)?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return sseResponse([frameChunk("ONE")]);
    });

    const frames: string[] = [];
    const stop = subscribeDeviceLiveFrames(DEVICE, {
      onFrame: (f) => frames.push(f.image),
      onEnd: () => {},
      onError: () => {},
    });
    await until(() => frames.length === 1);
    stop();
    expect(aborted).toBe(true);
  });
});
