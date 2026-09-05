import { expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client", () => client);
vi.mock("./demo", () => ({ isDemo: () => true }));
import { startLiveSession } from "./media";
it("does not send real capture requests while inspecting demo devices", async () => {
  await expect(startLiveSession("demo-device")).rejects.toMatchObject({ status: 503 });
  expect(client.request).not.toHaveBeenCalled();
});
