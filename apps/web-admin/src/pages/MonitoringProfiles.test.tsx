import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { MonitoringProfile } from "../api/types";
import { MonitoringProfiles } from "./MonitoringProfiles";

const endpointMocks = vi.hoisted(() => ({
  listMonitoringProfiles: vi.fn(),
  listBusinessEmployees: vi.fn(),
  listDevices: vi.fn(),
  listOrganization: vi.fn(),
  createMonitoringProfile: vi.fn(),
  updateMonitoringProfile: vi.fn(),
  deleteMonitoringProfile: vi.fn(),
}));

vi.mock("../api/endpoints", () => endpointMocks);
vi.mock("../useBusinesses", () => ({
  useBusinesses: () => ({ selectedId: "business-1", loading: false }),
}));

const profile: MonitoringProfile = {
  id: "profile-1",
  business_id: "business-1",
  name: "Standard workday",
  description: "Weekday policy",
  parent_id: null,
  private: false,
  details: [{
    tracking_key: "applications",
    tracking_val: true,
    days_of_week: [1, 2, 3, 4, 5],
    start_minute: 540,
    end_minute: 1020,
    timezone: "Africa/Cairo",
  }],
  assignments: [{ scope_type: "business", scope_id: "business-1" }],
  created_at: "2026-08-26T00:00:00Z",
  updated_at: "2026-08-26T00:00:00Z",
};

beforeEach(async () => {
  Object.values(endpointMocks).forEach((mock) => mock.mockReset());
  endpointMocks.listMonitoringProfiles.mockResolvedValue({ profiles: [profile] });
  endpointMocks.listBusinessEmployees.mockResolvedValue({ employees: [] });
  endpointMocks.listDevices.mockResolvedValue({ devices: [] });
  endpointMocks.listOrganization.mockResolvedValue({ departments: [], job_roles: [] });
  await i18n.changeLanguage("en");
});

describe("MonitoringProfiles", () => {
  it("renders the assigned capture channels", async () => {
    render(<MonitoringProfiles />);
    expect(await screen.findByText("Standard workday")).toBeDefined();
    expect(screen.getByText("Applications")).toBeDefined();
    expect(screen.getByText("1 channel overrides")).toBeDefined();
  });

  it("creates a company profile with independent channel schedules", async () => {
    endpointMocks.createMonitoringProfile.mockResolvedValue({ profile });
    render(<MonitoringProfiles />);
    await screen.findByText("Standard workday");

    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Focused work" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(endpointMocks.createMonitoringProfile).toHaveBeenCalledTimes(1));
    const input = endpointMocks.createMonitoringProfile.mock.calls[0][0];
    expect(input.business_id).toBe("business-1");
    expect(input.assignments).toEqual([{ scope_type: "business", scope_id: "business-1" }]);
    expect(input.details).toHaveLength(4);
    expect(input.details[0]).toMatchObject({
      days_of_week: [1, 2, 3, 4, 5],
      start_minute: 540,
      end_minute: 1020,
    });
  });

  it("can assign a monitoring profile to a department", async () => {
    endpointMocks.listOrganization.mockResolvedValue({
      departments: [{
        id: "department-1", business_id: "business-1", name: "Engineering", description: "",
        created_at: "2026-08-26T00:00:00Z", updated_at: "2026-08-26T00:00:00Z",
      }],
      job_roles: [],
    });
    endpointMocks.createMonitoringProfile.mockResolvedValue({ profile });
    render(<MonitoringProfiles />);
    await screen.findByText("Standard workday");

    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Engineering policy" } });
    fireEvent.change(screen.getByLabelText("Assignment"), { target: { value: "department:department-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(endpointMocks.createMonitoringProfile).toHaveBeenCalledTimes(1));
    expect(endpointMocks.createMonitoringProfile.mock.calls[0][0].assignments).toEqual([
      { scope_type: "department", scope_id: "department-1" },
    ]);
  });
});
