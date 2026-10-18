import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUSINESS, renderPage } from "../test/render";

vi.mock("../api/endpoints", () => ({
  listMyBusinesses: vi.fn(),
  reportEmployees: vi.fn(),
  reportPresence: vi.fn(),
  reportActivity: vi.fn(),
  reportBrowser: vi.fn(),
  reportKeystrokes: vi.fn(),
  reportStates: vi.fn(),
}));
vi.mock("../api/media", () => ({ listEmployeeRecordings: vi.fn(), mintPlaybackToken: vi.fn() }));

import * as api from "../api/endpoints";
import * as media from "../api/media";
import EmployeeDay from "./EmployeeDay";

const today = new Date();
today.setHours(0, 0, 0, 0);
const T = Math.floor(today.getTime() / 1000) + 9 * 3600; // 09:00 local

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listMyBusinesses).mockResolvedValue({ businesses: [BUSINESS] });
  vi.mocked(api.reportEmployees).mockResolvedValue({
    employees: [
      {
        id: "e1", email: "sara@engosoft.com", display_name: "Sara Nabil", role: "employee", last_seen: null,
        device_id: "d1", presence_state: "active", current_app: "Microsoft Excel", current_window_title: "Q3.xlsx",
        presence_since: null, presence_seen_at: null, session_started_at: null, active_today_s: 0,
        active_yesterday_s: 0, screenshots_today: 0, screenshots_yesterday: 0, focus_pct_today: null,
      },
    ],
  });
  vi.mocked(api.reportPresence).mockResolvedValue({
    presence: { device_id: "d1", state: "active", app: "Microsoft Excel", window_title: "Q3.xlsx", since: T, seen_at: T, session_started_at: T, resources: null },
  });
  vi.mocked(api.reportActivity).mockResolvedValue({
    samples: [
      { ts: T, app_name: "Microsoft Excel", window_title: "Q3.xlsx", duration_s: 3600 },
      { ts: T + 3600, app_name: "Google Chrome", window_title: "Inbox", duration_s: 1800 },
    ],
    breakdown: [
      { app_name: "Microsoft Excel", duration_s: 3600 },
      { app_name: "Google Chrome", duration_s: 1800 },
    ],
  });
  vi.mocked(api.reportBrowser).mockResolvedValue({
    visits: [
      { ts: T + 3600, url: "https://mail.google.com/mail/u/0", domain: "mail.google.com", page_title: "Inbox", browser: "chrome", duration_s: 900 },
      { ts: T + 4500, url: "javascript:alert(1)", domain: "evil.test", page_title: "Not a link", browser: "chrome", duration_s: 60 },
    ],
  });
  vi.mocked(api.reportKeystrokes).mockResolvedValue({
    buckets: [
      { ts_bucket: T, count: 1200, clicks: 340, scrolls: 50, mouse_px: 96 * 39.37 * 100 },
      { ts_bucket: T + 60, count: 300, clicks: 60, scrolls: 10, mouse_px: 0 },
    ],
  });
  vi.mocked(api.reportStates).mockResolvedValue({
    totals: { active_s: 5400, idle_s: 600, suspended_s: 0, offline_s: 0, covered_s: 6000, elapsed_s: 6000 },
    first_activity: T,
    last_activity: T + 6000,
    intervals: [{ state: "active", ts: T, duration_s: 5400 }, { state: "idle", ts: T + 5400, duration_s: 600 }],
  });
  vi.mocked(media.listEmployeeRecordings).mockResolvedValue({ recordings: [] });
});

const open = () => renderPage(<EmployeeDay />, { path: "/employees/e1", route: "/employees/:id" });

describe("EmployeeDay", () => {
  it("shows worked time from the device timeline and the input totals", async () => {
    await open();
    // Worked and idle appear in their tiles and again in the day's legend.
    expect((await screen.findAllByText("1h 30m")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("10m").length).toBeGreaterThan(0);
    expect(screen.getByText("1.5K")).toBeTruthy(); // keystrokes
    expect(screen.getByText("400")).toBeTruthy(); // clicks
  });

  it("lists every app used, and opens an app to show its windows", async () => {
    await open();
    const excel = await screen.findByRole("button", { name: /Microsoft Excel/ });
    fireEvent.click(excel);
    expect(screen.getByText("Q3.xlsx")).toBeTruthy();
  });

  it("lists sites and their links, linking only real web addresses", async () => {
    await open();
    fireEvent.click(await screen.findByRole("tab", { name: "Websites" }));
    fireEvent.click(await screen.findByRole("button", { name: /mail\.google\.com/ }));
    const link = screen.getByRole("link", { name: "Inbox" });
    expect(link.getAttribute("href")).toBe("https://mail.google.com/mail/u/0");
    fireEvent.click(screen.getByRole("button", { name: /evil\.test/ }));
    expect(screen.queryByRole("link", { name: "Not a link" })).toBeNull();
    expect(screen.getByText("Not a link")).toBeTruthy();
  });

  it("says when the device's app is too old to count the mouse", async () => {
    vi.mocked(api.reportKeystrokes).mockResolvedValue({ buckets: [{ ts_bucket: T, count: 50 }] });
    await open();
    expect(await screen.findByText("not reported by this app version")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Keyboard & mouse" }));
    expect(screen.getByText(/predates mouse counting/)).toBeTruthy();
  });

  it("renders in Arabic, right to left", async () => {
    await renderPage(<EmployeeDay />, { path: "/employees/e1", route: "/employees/:id", lang: "ar" });
    expect(await screen.findByText("مدة العمل")).toBeTruthy();
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
  });
});
