import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tokens, User } from "./types";

const TOKENS_KEY = "ctracking.admin.tokens";
const USER_KEY = "ctracking.admin.user";

const tokens: Tokens = { access_token: "access-1", refresh_token: "refresh-1", expires_in: 900 };
const user: User = {
  id: "u1",
  email: "owner@example.com",
  display_name: "Owner",
  account_type: "manager",
};

// The module reads localStorage once at import time, so every test needs a fresh
// module instance to exercise the load path rather than leftover state.
async function freshStore() {
  vi.resetModules();
  return (await import("./tokenStore")).tokenStore;
}

beforeEach(() => {
  localStorage.clear();
});

describe("tokenStore", () => {
  it("starts empty when storage is empty", async () => {
    const store = await freshStore();

    expect(store.isAuthed()).toBe(false);
    expect(store.getAccess()).toBeNull();
    expect(store.getRefresh()).toBeNull();
    expect(store.getUser()).toBeNull();
  });

  it("persists a session across a reload", async () => {
    (await freshStore()).setSession(tokens, user);
    const reloaded = await freshStore();

    expect(reloaded.isAuthed()).toBe(true);
    expect(reloaded.getAccess()).toBe("access-1");
    expect(reloaded.getRefresh()).toBe("refresh-1");
    expect(reloaded.getUser()).toEqual(user);
  });

  it("keeps the user when only the tokens are refreshed", async () => {
    const store = await freshStore();
    store.setSession(tokens, user);

    store.updateTokens({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 900 });

    expect(store.getAccess()).toBe("access-2");
    expect(store.getUser()).toEqual(user);
    expect((await freshStore()).getAccess()).toBe("access-2");
  });

  it("clears memory and storage on logout", async () => {
    const store = await freshStore();
    store.setSession(tokens, user);

    store.clear();

    expect(store.isAuthed()).toBe(false);
    expect(store.getUser()).toBeNull();
    expect(localStorage.getItem(TOKENS_KEY)).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect((await freshStore()).isAuthed()).toBe(false);
  });

  // Corrupted storage must not leave a half-loaded session behind, or the SPA
  // renders as signed-in and then fails every request.
  it("starts clean when stored JSON is corrupt", async () => {
    localStorage.setItem(TOKENS_KEY, "{not json");
    localStorage.setItem(USER_KEY, JSON.stringify(user));

    const store = await freshStore();

    expect(store.isAuthed()).toBe(false);
    expect(store.getAccess()).toBeNull();
    expect(store.getUser()).toBeNull();
  });
});
