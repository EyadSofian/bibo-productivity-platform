import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { Device } from "../api/types";
import { Devices, isLive, relativeTime } from "./Devices";

const endpointMocks = vi.hoisted(() => ({
  listDevices: vi.fn(),
  setDeviceMonitoring: vi.fn(),
  setDeviceArchived: vi.fn(),
}));

vi.mock("../api/endpoints", () => endpointMocks);
vi.mock("../useBusinesses", () => ({
  useBusinesses: () => ({ selectedId: "business-1", loading: false }),
}));

const employeeDevice: Device = {
  id: "device-1",
  business_id: "business-1",
  user_id: "employee-1",
  label: "Amina's MacBook Pro",
  os: "macOS 15.3",
  agent_version: "1.5.1",
  monitoring_enabled: true,
  last_seen_at: new Date().toISOString(),
  disabled_at: null,
  deleted_at: null,
  user_display_name: "Amina Farouk",
  user_login: "amina@northstar.co",
};

beforeEach(async () => {
  endpointMocks.listDevices.mockReset();
  endpointMocks.setDeviceMonitoring.mockReset();
  endpointMocks.setDeviceArchived.mockReset();
  await i18n.changeLanguage("en");
});

// Fixed "now" so these never depend on wall-clock time.
const NOW = Date.parse("2026-08-26T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe("isLive", () => {
  it("counts a heartbeat inside the window as live", () => {
    expect(isLive(ago(30_000), NOW)).toBe(true);
    expect(isLive(ago(4 * MIN), NOW)).toBe(true);
  });

  it("counts a heartbeat past the window as not live", () => {
    expect(isLive(ago(6 * MIN), NOW)).toBe(false);
    expect(isLive(ago(48 * 60 * MIN), NOW)).toBe(false);
  });

  it("treats a device that never synced as not live", () => {
    expect(isLive(null, NOW)).toBe(false);
  });

  it("does not throw on an unparseable timestamp", () => {
    // The column is text-typed on the way out; a malformed value must render as
    // offline rather than crashing the whole fleet table.
    expect(isLive("not-a-date", NOW)).toBe(false);
    expect(isLive("", NOW)).toBe(false);
  });

  it("does not report a clock-skewed future heartbeat as stale", () => {
    // An agent whose clock runs fast reports a future last_seen. It is alive.
    expect(isLive(new Date(NOW + 2 * MIN).toISOString(), NOW)).toBe(true);
  });
});

describe("relativeTime", () => {
  it("localizes the unit rather than concatenating English", () => {
    const en = relativeTime(ago(5 * MIN), "en", "Never", NOW);
    const ar = relativeTime(ago(5 * MIN), "ar", "أبدًا", NOW);
    expect(en).toMatch(/5/);
    expect(ar).not.toEqual(en);
    // Arabic must not leak an English unit into the string.
    expect(ar).not.toMatch(/minute/i);
  });

  it("scales the unit with the distance", () => {
    expect(relativeTime(ago(30_000), "en", "Never", NOW)).toMatch(/second/i);
    expect(relativeTime(ago(5 * MIN), "en", "Never", NOW)).toMatch(/minute/i);
    expect(relativeTime(ago(5 * 60 * MIN), "en", "Never", NOW)).toMatch(/hour/i);
    expect(relativeTime(ago(3 * 24 * 60 * MIN), "en", "Never", NOW)).toMatch(/day/i);
  });

  it("returns the caller's placeholder for a device that never synced", () => {
    expect(relativeTime(null, "en", "Never", NOW)).toBe("Never");
    expect(relativeTime("nonsense", "en", "Never", NOW)).toBe("Never");
  });
});

describe("Devices screen", () => {
  it("keeps the employee identity after a monitoring toggle", async () => {
    endpointMocks.listDevices.mockResolvedValue({ devices: [employeeDevice] });
    // The real backend UPDATE response intentionally cannot include the joined
    // user columns. This is the exact shape that used to blank the employee.
    endpointMocks.setDeviceMonitoring.mockResolvedValue({
      device: {
        ...employeeDevice,
        monitoring_enabled: false,
        disabled_at: new Date().toISOString(),
        user_display_name: "",
        user_login: "",
      },
    });

    render(<Devices />);
    expect(await screen.findByText("Amina Farouk")).toBeDefined();

    const toggle = screen.getByRole("switch", { name: /Amina's MacBook Pro/i });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("Amina Farouk")).toBeDefined();
    expect(screen.getByText("amina@northstar.co")).toBeDefined();
    expect(endpointMocks.setDeviceMonitoring).toHaveBeenCalledWith("device-1", false);
  });

  it("rolls the optimistic switch back when the request fails", async () => {
    endpointMocks.listDevices.mockResolvedValue({ devices: [employeeDevice] });
    endpointMocks.setDeviceMonitoring.mockRejectedValue(new Error("offline"));

    render(<Devices />);
    const toggle = await screen.findByRole("switch", { name: /Amina's MacBook Pro/i });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("Could not change monitoring for that device.")).toBeDefined();
  });

  it("archives and restores a device without losing its employee", async () => {
    endpointMocks.listDevices.mockResolvedValue({ devices: [employeeDevice] });
    endpointMocks.setDeviceArchived
      .mockResolvedValueOnce({
        device: {
          ...employeeDevice,
          monitoring_enabled: false,
          deleted_at: new Date().toISOString(),
          user_display_name: "",
          user_login: "",
        },
      })
      .mockResolvedValueOnce({
        device: {
          ...employeeDevice,
          monitoring_enabled: false,
          deleted_at: null,
          user_display_name: "",
          user_login: "",
        },
      });

    render(<Devices />);
    expect(await screen.findByText("Amina Farouk")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(screen.queryByText("Amina Farouk")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Archived \(1\)/ }));
    expect(await screen.findByText("Amina Farouk")).toBeDefined();
    expect(screen.getByText("amina@northstar.co")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.queryByText("Amina Farouk")).toBeNull());
    expect(endpointMocks.setDeviceArchived).toHaveBeenNthCalledWith(1, "device-1", true);
    expect(endpointMocks.setDeviceArchived).toHaveBeenNthCalledWith(2, "device-1", false);
  });
});
