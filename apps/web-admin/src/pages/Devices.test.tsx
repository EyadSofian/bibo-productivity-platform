import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Device } from "../api/types";
import { BUSINESS, renderPage } from "../test/render";

vi.mock("../api/endpoints", () => ({
  listMyBusinesses: vi.fn(),
  listDevices: vi.fn(),
  setDeviceMonitoring: vi.fn(),
  setDeviceArchived: vi.fn(),
}));

import * as api from "../api/endpoints";
import Devices, { isConnected } from "./Devices";

const device = (over: Partial<Device>): Device => ({
  id: "d1",
  business_id: BUSINESS.id,
  user_id: "u1",
  label: "ENGO-LAPTOP-01",
  os: "Windows 11 Pro",
  agent_version: "1.7.0",
  monitoring_enabled: true,
  last_seen_at: new Date().toISOString(),
  disabled_at: null,
  deleted_at: null,
  user_display_name: "Sara Nabil",
  user_login: "sara",
  recording_state: null,
  recording_started_at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listMyBusinesses).mockResolvedValue({ businesses: [BUSINESS] });
  vi.mocked(api.listDevices).mockResolvedValue({
    devices: [device({}), device({ id: "d2", label: "OLD-PC", deleted_at: new Date().toISOString() })],
  });
});

describe("Devices", () => {
  it("lists active devices and keeps archived ones behind a toggle", async () => {
    await renderPage(<Devices />);
    expect(await screen.findByText("ENGO-LAPTOP-01")).toBeTruthy();
    expect(screen.queryByText("OLD-PC")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Archived \(1\)/ }));
    expect(screen.getByText("OLD-PC")).toBeTruthy();
  });

  it("turns monitoring off for one device and shows the server's answer", async () => {
    vi.mocked(api.setDeviceMonitoring).mockResolvedValue({ device: device({ monitoring_enabled: false }) });
    await renderPage(<Devices />);
    const toggle = await screen.findByRole("switch", { name: /Monitoring for ENGO-LAPTOP-01/ });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(api.setDeviceMonitoring).toHaveBeenCalledWith("d1", false));
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false));
  });

  it("treats a device as connected only if it checked in within two minutes", () => {
    const now = Date.parse("2026-10-18T10:00:00Z");
    expect(isConnected(device({ last_seen_at: "2026-10-18T09:59:00Z" }), now)).toBe(true);
    expect(isConnected(device({ last_seen_at: "2026-10-18T09:57:00Z" }), now)).toBe(false);
    expect(isConnected(device({ last_seen_at: null }), now)).toBe(false);
  });
});
