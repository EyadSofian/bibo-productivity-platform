import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportEmployee, TeamReport } from "../api/types";
import { BUSINESS, renderPage } from "../test/render";

vi.mock("../api/endpoints", () => ({
  listMyBusinesses: vi.fn(),
  reportEmployees: vi.fn(),
  reportTeam: vi.fn(),
}));
vi.mock("../api/media", () => ({ getRecordingSummary: vi.fn() }));

import * as api from "../api/endpoints";
import * as media from "../api/media";
import Overview, { hourWindow, sortByPresence } from "./Overview";

function person(id: string, name: string, state: ReportEmployee["presence_state"], active: number, extra: Partial<ReportEmployee> = {}): ReportEmployee {
  return {
    id,
    email: `${id}@engosoft.com`,
    display_name: name,
    role: "employee",
    last_seen: null,
    device_id: state === "offline" ? null : `dev-${id}`,
    presence_state: state,
    current_app: state === "offline" ? null : "Google Chrome",
    current_window_title: null,
    presence_since: null,
    presence_seen_at: null,
    session_started_at: null,
    active_today_s: active,
    active_yesterday_s: 0,
    screenshots_today: 0,
    screenshots_yesterday: 0,
    focus_pct_today: 50,
    keystrokes_today: 1200,
    clicks_today: 300,
    ...extra,
  };
}

const TEAM: TeamReport = {
  from: 0,
  to: 3600,
  apps: [
    { name: "Visual Studio Code", duration_s: 7200, employees: 2 },
    { name: "Slack", duration_s: 1800, employees: 3 },
  ],
  domains: [{ name: "github.com", duration_s: 2400, employees: 2 }],
  input: { keystrokes: 15000, clicks: 3200, scrolls: 900, mouse_px: 960000 },
  hours: [{ hour: 9, duration_s: 5400 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listMyBusinesses).mockResolvedValue({ businesses: [BUSINESS] });
  vi.mocked(api.reportEmployees).mockResolvedValue({
    employees: [
      person("a", "Omar Adel", "offline", 3600),
      person("b", "Sara Nabil", "active", 4 * 3600),
      person("c", "Mona Ali", "idle", 2 * 3600),
    ],
  });
  vi.mocked(api.reportTeam).mockResolvedValue(TEAM);
  vi.mocked(media.getRecordingSummary).mockResolvedValue({
    window_days: 30,
    summary: { ready: 4, recording: 1, processing: 0, failed: 0, stale: 0, recent: [] },
  });
});

describe("Overview", () => {
  it("sums the team's working time into the headline", async () => {
    await renderPage(<Overview />);
    // 1h + 4h + 2h
    expect(await screen.findByText("The team worked 7 hours today")).toBeTruthy();
  });

  it("asks the roster for the viewer's local day, not the UTC one", async () => {
    await renderPage(<Overview />);
    await screen.findByText("The team worked 7 hours today");
    const [, window] = vi.mocked(api.reportEmployees).mock.calls[0];
    expect(window).toBeDefined();
    const start = new Date(window!.from * 1000);
    expect([start.getHours(), start.getMinutes()]).toEqual([0, 0]);
  });

  it("lists the team's top apps and sites from the team report", async () => {
    await renderPage(<Overview />);
    expect(await screen.findByText("Visual Studio Code")).toBeTruthy();
    expect(screen.getByText("github.com")).toBeTruthy();
    expect(screen.getByText("15K")).toBeTruthy();
  });

  it("puts people at work first in the team table", async () => {
    await renderPage(<Overview />);
    // The hour chart carries its own screen-reader table; this is the team one.
    const table = (await screen.findByRole("columnheader", { name: "Employee" })).closest("table")!;
    const names = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0].textContent);
    expect(names[0]).toContain("Sara Nabil");
    expect(names[1]).toContain("Mona Ali");
    expect(names[2]).toContain("Omar Adel");
  });
});

describe("overview helpers", () => {
  it("orders by presence, then by time worked", () => {
    const list = sortByPresence([
      person("1", "Z", "offline", 9000),
      person("2", "Y", "active", 10),
      person("3", "X", "active", 500),
    ]);
    expect(list.map((p) => p.id)).toEqual(["3", "2", "1"]);
  });

  it("keeps the working day on the hour axis and stretches to activity", () => {
    expect(hourWindow([], 10)).toEqual([8, 18]);
    expect(hourWindow([{ hour: 6 }, { hour: 21 }], 10)).toEqual([6, 21]);
    expect(hourWindow([], 22)).toEqual([8, 22]);
  });
});
