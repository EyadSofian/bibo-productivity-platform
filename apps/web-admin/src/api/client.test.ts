import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tokens, User } from "./types";

const seed: Tokens = { access_token: "old-access", refresh_token: "refresh-1", expires_in: 900 };
const user: User = {
  id: "u1",
  email: "owner@example.com",
  display_name: "Owner",
  account_type: "manager",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A promise whose resolution this test controls, to hold a refresh open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// client.ts keeps the in-flight refresh in module scope, so each test needs a
// fresh module graph — including a fresh tokenStore for it to read.
async function loadClient() {
  vi.resetModules();
  const tokenStore = (await import("./tokenStore")).tokenStore;
  const client = await import("./client");
  return { ...client, tokenStore };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("request auth refresh", () => {
  it("shares one refresh between concurrent 401s", async () => {
    const { request, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);

    const refreshGate = deferred<void>();
    const calls: string[] = [];
    let refreshed = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.endsWith("/v1/auth/refresh")) {
          await refreshGate.promise;
          refreshed = true;
          return json(200, { access_token: "new-access", refresh_token: "refresh-2", expires_in: 900 });
        }
        return refreshed ? json(200, { ok: true }) : json(401, { error: "expired" });
      }),
    );

    const both = Promise.all([request("/v1/a"), request("/v1/b")]);
    // Let both requests take their 401 and queue behind the same refresh.
    await vi.waitFor(() => expect(calls.filter((u) => u.endsWith("/v1/auth/refresh"))).toHaveLength(1));
    refreshGate.resolve();
    await both;

    const refreshCalls = calls.filter((u) => u.endsWith("/v1/auth/refresh"));
    expect(refreshCalls).toHaveLength(1);
    expect(tokenStore.getAccess()).toBe("new-access");
  });

  it("retries the original request with the new token", async () => {
    const { request, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);

    const sentAuth: (string | null)[] = [];
    let refreshed = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/refresh")) {
          refreshed = true;
          return json(200, { access_token: "new-access", refresh_token: "refresh-2", expires_in: 900 });
        }
        sentAuth.push(((init?.headers ?? {}) as Record<string, string>)["Authorization"] ?? null);
        return refreshed ? json(200, { ok: true }) : json(401, { error: "expired" });
      }),
    );

    await expect(request("/v1/employees")).resolves.toEqual({ ok: true });
    expect(sentAuth).toEqual(["Bearer old-access", "Bearer new-access"]);
  });

  it("logs out and stops after a failed refresh", async () => {
    const { request, subscribeLogout, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);

    const attempts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        attempts.push(url);
        if (url.endsWith("/v1/auth/refresh")) return json(401, { error: "invalid refresh" });
        return json(401, { error: "expired" });
      }),
    );

    const loggedOut = vi.fn();
    subscribeLogout(loggedOut);

    await expect(request("/v1/employees")).rejects.toMatchObject({ status: 401 });

    expect(loggedOut).toHaveBeenCalledOnce();
    expect(tokenStore.isAuthed()).toBe(false);
    // One original attempt plus one refresh — never a retry loop.
    expect(attempts).toHaveLength(2);
  });

  it("does not attempt a refresh without a stored refresh token", async () => {
    const { request, tokenStore } = await loadClient();
    tokenStore.clear();

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return json(401, { error: "expired" });
      }),
    );

    await expect(request("/v1/employees")).rejects.toMatchObject({ status: 401 });
    expect(calls.some((u) => u.endsWith("/v1/auth/refresh"))).toBe(false);
  });

  it("allows a new refresh after the previous one settles", async () => {
    const { request, tokenStore } = await loadClient();
    tokenStore.setSession(seed, user);

    let refreshCount = 0;
    let unauthorized = true;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/refresh")) {
          refreshCount++;
          return json(200, {
            access_token: `access-${refreshCount}`,
            refresh_token: `refresh-${refreshCount}`,
            expires_in: 900,
          });
        }
        if (unauthorized) {
          unauthorized = false;
          return json(401, { error: "expired" });
        }
        unauthorized = true;
        return json(200, { ok: true });
      }),
    );

    await request("/v1/a");
    await request("/v1/b");

    // Sequential 401s must each get their own refresh; the single-flight latch
    // has to clear once the first one settles.
    expect(refreshCount).toBe(2);
  });
});
