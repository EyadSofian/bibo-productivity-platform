// ─────────────────────────────────────────────────────────────────────
// Dev-only DEMO data. Lets the dashboard/detail pages show realistic stats
// with no backend or database. Deterministic (seeded) so numbers are stable
// across reloads — no flicker.
//
//   Enable:  open …/admin/?demo=1   (or run  localStorage.demo="1"  in console)
//   Disable: open …/admin/?demo=0   (or run  delete localStorage.demo)
//
// Gated behind import.meta.env.DEV, so it is inert in any production build.
// This file adds NO business logic — endpoints.ts just short-circuits to it
// when the flag is on, and behaves exactly as before when it is off.
// ─────────────────────────────────────────────────────────────────────
import type {
  ActivityResponse,
  BrowserVisit,
  Business,
  Department,
  Device,
  Employee,
  JobRole,
  KeystrokeBucket,
  MonitoringProfile,
  MonitoringProfileInput,
  Organization,
  OrganizationItemInput,
  OsStateInterval,
  OsStateReport,
  ReportEmployee,
  ScreenshotMeta,
  ScreenshotsResponse,
} from "./types";

export function isDemo(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const q = new URLSearchParams(window.location.search).get("demo");
    if (q === "1") localStorage.setItem("demo", "1");
    if (q === "0") localStorage.removeItem("demo");
    return localStorage.getItem("demo") === "1";
  } catch {
    return false;
  }
}

const HOUR = 3600;
const nowS = () => Math.floor(Date.now() / 1000);
const dayStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};

/** Stable pseudo-random generator in [0,1) from a string seed. */
function seeded(s: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    return ((h >>> 0) % 100000) / 100000;
  };
}

export const DEMO_BUSINESS_ID = "demo-northstar";

export const demoBusinesses: Business[] = [
  {
    id: DEMO_BUSINESS_ID,
    name: "Northstar Digital",
    kind: "team",
    owner_user_id: "demo-owner",
    screenshot_retention_days: 30,
    screenshot_interval_s: 300,
    idle_threshold_s: 300,
    allow_employee_override: false,
    screenshot_mode: "privacy",
    screenshot_skip_apps: [],
  },
];

let demoProfileState: MonitoringProfile[] | null = null;

function ensureDemoProfiles(): MonitoringProfile[] {
  if (!demoProfileState) {
    const stamp = new Date().toISOString();
    demoProfileState = [{
      id: "demo-profile-standard",
      business_id: DEMO_BUSINESS_ID,
      name: "Standard workday",
      description: "Core activity during the Northstar workweek.",
      parent_id: null,
      private: false,
      details: ["applications", "keystrokes", "screen", "websites"].map((tracking_key) => ({
        tracking_key,
        tracking_val: true,
        days_of_week: [1, 2, 3, 4, 5],
        start_minute: 9 * 60,
        end_minute: 17 * 60,
        timezone: "Africa/Cairo",
      })),
      assignments: [{ scope_type: "business", scope_id: DEMO_BUSINESS_ID }],
      created_at: stamp,
      updated_at: stamp,
    }];
  }
  return demoProfileState;
}

const cloneProfile = (profile: MonitoringProfile): MonitoringProfile => ({
  ...profile,
  details: profile.details.map((detail) => ({ ...detail, days_of_week: [...detail.days_of_week] })),
  assignments: profile.assignments.map((assignment) => ({ ...assignment })),
});

export function demoMonitoringProfiles(): MonitoringProfile[] {
  return ensureDemoProfiles().map(cloneProfile);
}

export function demoCreateMonitoringProfile(input: MonitoringProfileInput): MonitoringProfile {
  const stamp = new Date().toISOString();
  const profile: MonitoringProfile = {
    ...input,
    id: `demo-profile-${Date.now()}`,
    created_at: stamp,
    updated_at: stamp,
  };
  ensureDemoProfiles().push(profile);
  return cloneProfile(profile);
}

export function demoUpdateMonitoringProfile(id: string, input: MonitoringProfileInput): MonitoringProfile {
  const profiles = ensureDemoProfiles();
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index < 0) throw new Error("demo: unknown monitoring profile");
  profiles[index] = { ...profiles[index], ...input, updated_at: new Date().toISOString() };
  return cloneProfile(profiles[index]);
}

export function demoDeleteMonitoringProfile(id: string): void {
  demoProfileState = ensureDemoProfiles()
    .filter((profile) => profile.id !== id)
    .map((profile) => profile.parent_id === id ? { ...profile, parent_id: null } : profile);
}

// ageMin = minutes since last seen (drives active/idle/offline dot).
const MEMBERS: { id: string; name: string; login: string; role: "owner" | "employee"; ageMin: number }[] = [
  { id: "demo-owner", name: "Amina Farouk", login: "amina@northstar.co", role: "owner", ageMin: 1 },
  { id: "demo-daniel", name: "Daniel Kim", login: "daniel.kim@northstar.co", role: "employee", ageMin: 3 },
  { id: "demo-fatima", name: "Fatima Hassan", login: "fatima.hassan@northstar.co", role: "employee", ageMin: 18 },
  { id: "demo-mateo", name: "Mateo Ruiz", login: "mateo.ruiz@northstar.co", role: "employee", ageMin: 120 },
  { id: "demo-priya", name: "Priya Shah", login: "priya.shah@northstar.co", role: "employee", ageMin: 4320 },
];

let demoDepartments: Department[] = [
  { id: "demo-dept-engineering", business_id: DEMO_BUSINESS_ID, name: "Engineering", description: "Product and platform delivery", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: "demo-dept-operations", business_id: DEMO_BUSINESS_ID, name: "Operations", description: "Customer and business operations", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
];
let demoJobRoles: JobRole[] = [
  { id: "demo-role-developer", business_id: DEMO_BUSINESS_ID, name: "Developer", description: "Software engineering", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: "demo-role-designer", business_id: DEMO_BUSINESS_ID, name: "Designer", description: "Product design", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
];
const demoOrganizationAssignments = new Map<string, { department_id: string | null; job_role_id: string | null }>([
  ["demo-daniel", { department_id: "demo-dept-engineering", job_role_id: "demo-role-developer" }],
  ["demo-fatima", { department_id: "demo-dept-engineering", job_role_id: "demo-role-designer" }],
  ["demo-mateo", { department_id: "demo-dept-operations", job_role_id: null }],
]);

const cloneDepartment = <T extends Department>(item: T): T => ({ ...item });

export function demoOrganization(): Organization {
  return { departments: demoDepartments.map(cloneDepartment), job_roles: demoJobRoles.map(cloneDepartment) };
}

export function demoSaveOrganizationItem(kind: "department" | "job_role", id: string | null, input: OrganizationItemInput): Department | JobRole {
  const list = kind === "department" ? demoDepartments : demoJobRoles;
  const stamp = new Date().toISOString();
  if (id) {
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("demo: organization item not found");
    list[index] = { ...list[index], ...input, updated_at: stamp };
    return cloneDepartment(list[index]);
  }
  const item = { ...input, id: `demo-${kind}-${Date.now()}`, created_at: stamp, updated_at: stamp };
  list.push(item);
  return cloneDepartment(item);
}

export function demoDeleteOrganizationItem(kind: "department" | "job_role", id: string): void {
  if (kind === "department") demoDepartments = demoDepartments.filter((item) => item.id !== id);
  else demoJobRoles = demoJobRoles.filter((item) => item.id !== id);
  for (const [employeeId, assignment] of demoOrganizationAssignments) {
    if (kind === "department" && assignment.department_id === id) demoOrganizationAssignments.set(employeeId, { ...assignment, department_id: null });
    if (kind === "job_role" && assignment.job_role_id === id) demoOrganizationAssignments.set(employeeId, { ...assignment, job_role_id: null });
  }
}

export function demoAssignEmployeeOrganization(employeeId: string, department_id: string | null, job_role_id: string | null): Employee {
  demoOrganizationAssignments.set(employeeId, { department_id, job_role_id });
  const employee = demoEmployees().find((item) => item.id === employeeId);
  if (!employee) throw new Error("demo: employee not found");
  return employee;
}

export function demoRoster(): ReportEmployee[] {
  const liveApps = ["Visual Studio Code", "Google Chrome", "Figma", "Microsoft Excel", "Slack"];
  return MEMBERS.map((m, index) => {
    const r = seeded(m.id);
    const active = Math.round((2.5 + r() * 6) * HOUR); // 2.5–8.5h
    const isEmail = m.login.includes("@");
    return {
      id: m.id,
      display_name: m.name,
      email: isEmail ? m.login : "",
      username: isEmail ? undefined : m.login,
      role: m.role,
      last_seen: nowS() - m.ageMin * 60,
      device_id: m.ageMin < 30 ? `demo-device-${m.id}` : null,
      presence_state: m.ageMin < 5 ? "active" : m.ageMin < 30 ? "idle" : "offline",
      current_app: m.ageMin < 30 ? liveApps[index % liveApps.length] : null,
      current_window_title: m.ageMin < 30 ? `${liveApps[index % liveApps.length]} — current work` : null,
      presence_since: m.ageMin < 30 ? nowS() - (8 + index * 3) * 60 : null,
      presence_seen_at: m.ageMin < 30 ? nowS() - Math.min(15, m.ageMin * 60) : null,
      session_started_at: m.ageMin < 30 ? nowS() - (45 + index * 24) * 60 : null,
      active_today_s: active,
      active_yesterday_s: Math.round(active * (0.7 + r() * 0.6)),
      screenshots_today: 8 + Math.round(r() * 20),
      screenshots_yesterday: 8 + Math.round(r() * 20),
      focus_pct_today: 55 + Math.round(r() * 33),
    };
  });
}

export function demoEmployees(): Employee[] {
  return MEMBERS.map((m) => ({
    id: m.id,
    display_name: m.name,
    email: m.login.includes("@") ? m.login : "",
    username: m.login.includes("@") ? undefined : m.login,
    department_id: demoOrganizationAssignments.get(m.id)?.department_id ?? null,
    department_name: demoDepartments.find((item) => item.id === demoOrganizationAssignments.get(m.id)?.department_id)?.name ?? "",
    job_role_id: demoOrganizationAssignments.get(m.id)?.job_role_id ?? null,
    job_role_name: demoJobRoles.find((item) => item.id === demoOrganizationAssignments.get(m.id)?.job_role_id)?.name ?? "",
  }));
}

const APPS = ["VS Code", "Figma", "Chrome", "Slack", "Notion", "Terminal", "Zoom", "Spotify"];

export function demoActivity(employeeId: string): ActivityResponse {
  const r = seeded(employeeId + ":activity");
  const count = 5 + Math.floor(r() * 2); // 5–6 apps
  const offset = Math.floor(r() * APPS.length);
  const chosen = Array.from({ length: count }, (_, i) => APPS[(offset + i) % APPS.length]);

  const base = 3200 + Math.floor(r() * 3200);
  const breakdown = chosen.map((app, i) => ({
    app_name: app,
    duration_s: Math.max(600, Math.round(base * Math.pow(0.68, i))),
  }));

  // Samples across a working day (08:00 → ~18:00) with idle gaps between them.
  const samples: ActivityResponse["samples"] = [];
  const end = dayStart() + 18 * HOUR;
  let t = dayStart() + 8 * HOUR + Math.floor(r() * HOUR * 0.5);
  while (t < end) {
    const app = chosen[Math.floor(r() * chosen.length)];
    const dur = Math.round((15 + r() * 70) * 60); // 15–85 min
    samples.push({ ts: t, app_name: app, window_title: `${app} — window`, duration_s: dur });
    t += dur + Math.round(r() * 25 * 60); // gap 0–25 min
  }
  return { samples, breakdown };
}

export function demoKeystrokes(employeeId: string): { buckets: KeystrokeBucket[] } {
  const r = seeded(employeeId + ":keys");
  const buckets: KeystrokeBucket[] = [];
  // 30-minute buckets, 08:00 → 17:30
  for (let m = 8 * 60; m <= 17 * 60 + 30; m += 30) {
    buckets.push({ ts_bucket: dayStart() + m * 60, count: 200 + Math.round(r() * 1200) });
  }
  return { buckets };
}

const SITES: [string, string][] = [
  ["github.com", "GitHub — pull requests"],
  ["figma.com", "Figma — Design file"],
  ["stackoverflow.com", "Stack Overflow"],
  ["linear.app", "Linear — Issues"],
  ["developer.mozilla.org", "MDN Web Docs"],
  ["notion.so", "Notion — Notes"],
  ["youtube.com", "YouTube"],
  ["news.ycombinator.com", "Hacker News"],
];

export function demoBrowser(employeeId: string): { visits: BrowserVisit[] } {
  const r = seeded(employeeId + ":web");
  const browsers = ["Chrome", "Arc"];
  // one visit per distinct domain
  const visits: BrowserVisit[] = SITES.map(([host, title]) => ({
    ts: dayStart() + (8 + Math.floor(r() * 9)) * HOUR + Math.floor(r() * HOUR),
    url: `https://${host}`,
    domain: host,
    page_title: title,
    browser: browsers[Math.floor(r() * browsers.length)],
    duration_s: Math.round((8 + r() * 60) * 60),
  }));
  return { visits };
}

const SHOT_APPS = [
  "VS Code", "VS Code", "Chrome", "Figma", "Figma", "VS Code", "VS Code", "Terminal",
  "Chrome", "VS Code", "VS Code", "Notion", "Slack", "Figma", "VS Code", "Chrome",
  "VS Code", "Figma", "VS Code", "Terminal", "Notion", "Figma",
];
export function demoScreenshots(employeeId: string): ScreenshotsResponse {
  const r = seeded(employeeId + ":shots");
  const n = 22;
  const start = dayStart() + 8 * HOUR + 12 * 60;
  // app carried alongside the meta so the gallery can badge each card
  const screenshots: (ScreenshotMeta & { app: string })[] = Array.from({ length: n }, (_, i) => ({
    client_uuid: `demo-${employeeId}-${i}`,
    ts: start + i * (10 * 60 + 7),
    byte_size: 120000 + Math.round(r() * 400000),
    width: 2560,
    height: 1440,
    display_id: 0,
    app: SHOT_APPS[i % SHOT_APPS.length],
  }));
  return { screenshots, limit: 60, offset: 0 };
}

// ── devices (F40) ────────────────────────────────────────────────────
// Demo state is module-level and mutable so the monitoring toggle actually
// flips in demo mode. It resets on reload, which is what a demo wants.
const DEMO_OS = ["macOS 15.3", "Windows 11 Pro", "macOS 14.7", "Windows 10 Pro", "macOS 15.3"];
const demoDeviceState = new Map<string, boolean>();

export function demoDevices(): Device[] {
  return MEMBERS.map((m, i) => {
    const r = seeded(m.id + ":device");
    const id = `demo-device-${m.id}`;
    const enabled = demoDeviceState.get(id) ?? true;
    return {
      id,
      business_id: DEMO_BUSINESS_ID,
      user_id: m.id,
      label: `${m.name.split(" ")[0]}'s ${i % 2 === 0 ? "MacBook Pro" : "Desktop"}`,
      os: DEMO_OS[i % DEMO_OS.length],
      agent_version: r() > 0.5 ? "0.4.1" : "0.4.0",
      monitoring_enabled: enabled,
      last_seen_at: new Date((nowS() - m.ageMin * 60) * 1000).toISOString(),
      disabled_at: enabled ? null : new Date(nowS() * 1000).toISOString(),
      deleted_at: demoDeviceArchivedState.get(id) ? new Date(nowS() * 1000).toISOString() : null,
      user_display_name: m.name,
      user_login: m.login,
    };
  });
}

const demoDeviceArchivedState = new Map<string, boolean>();

export function demoSetDeviceMonitoring(deviceId: string, enabled: boolean): Device {
  demoDeviceState.set(deviceId, enabled);
  const found = demoDevices().find((d) => d.id === deviceId);
  if (!found) throw new Error("demo: unknown device");
  return found;
}

export function demoSetDeviceArchived(deviceId: string, archived: boolean): Device {
  demoDeviceArchivedState.set(deviceId, archived);
  if (archived) demoDeviceState.set(deviceId, false);
  const found = demoDevices().find((d) => d.id === deviceId);
  if (!found) throw new Error("demo: unknown device");
  return found;
}

/**
 * A demo state timeline. Built so the four totals partition the window exactly,
 * the same invariant the real backend guarantees — a demo that broke it would
 * make the breakdown look buggy.
 */
export function demoStates(): OsStateReport {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 8 * 3600;
  const plan: Array<[OsStateInterval["state"], number]> = [
    ["active", 5400],
    ["idle", 900],
    ["active", 7200],
    ["suspended", 3600],
    ["active", 5400],
    ["idle", 1200],
    ["active", 4500],
  ];
  const intervals: OsStateInterval[] = [];
  let ts = from;
  for (const [state, duration_s] of plan) {
    intervals.push({ state, ts, duration_s });
    ts += duration_s;
  }
  const sum = (state: OsStateInterval["state"]) =>
    intervals.filter((i) => i.state === state).reduce((n, i) => n + i.duration_s, 0);
  const covered_s = ts - from;
  const elapsed_s = now - from;
  const active = intervals.filter((i) => i.state === "active");
  return {
    totals: {
      active_s: sum("active"),
      idle_s: sum("idle"),
      suspended_s: sum("suspended"),
      offline_s: Math.max(0, elapsed_s - covered_s),
      covered_s,
      elapsed_s,
    },
    first_activity: active.length ? active[0].ts : null,
    last_activity: active.length
      ? active[active.length - 1].ts + active[active.length - 1].duration_s
      : null,
    intervals,
  };
}
