import { describe, expect, it } from "vitest";
import type { MonitoringProfile } from "../api/types";
import { draftFromProfile, inputFromDraft } from "./Settings";

const profile: MonitoringProfile = {
  id: "p1",
  business_id: "biz-1",
  name: "Office hours",
  description: "Set by HR",
  parent_id: "p0",
  private: true,
  details: [
    { tracking_key: "applications", tracking_val: true, days_of_week: [7, 1, 2, 3, 4], start_minute: 540, end_minute: 1020, timezone: "Africa/Cairo" },
    { tracking_key: "recording", tracking_val: false, days_of_week: [1], start_minute: 0, end_minute: 1440, timezone: "Africa/Cairo" },
  ],
  assignments: [{ scope_type: "department", scope_id: "d1" }],
  created_at: "",
  updated_at: "",
};

describe("monitoring schedule form", () => {
  it("round-trips a saved schedule without losing fields the form does not show", () => {
    const input = inputFromDraft(draftFromProfile(profile), "biz-1");
    expect(input.parent_id).toBe("p0");
    expect(input.private).toBe(true);
    expect(input.description).toBe("Set by HR");
    expect(input.assignments).toEqual([{ scope_type: "department", scope_id: "d1" }]);
    const apps = input.details.find((d) => d.tracking_key === "applications")!;
    expect(apps).toMatchObject({ tracking_val: true, days_of_week: [1, 2, 3, 4, 7], start_minute: 540, end_minute: 1020, timezone: "Africa/Cairo" });
  });

  it("stores a midnight end as the end of the day, not as minute zero", () => {
    const input = inputFromDraft(draftFromProfile(profile), "biz-1");
    expect(input.details.find((d) => d.tracking_key === "recording")!.end_minute).toBe(1440);
  });

  it("writes every channel so the device never guesses a missing one", () => {
    const keys = inputFromDraft(draftFromProfile(profile), "biz-1").details.map((d) => d.tracking_key).sort();
    expect(keys).toEqual(["applications", "keystrokes", "recording", "screen", "websites"]);
  });
});
