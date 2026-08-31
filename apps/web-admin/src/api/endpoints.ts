import { request } from "./client";
import { tokenStore } from "./tokenStore";
import {
  demoActivity,
  demoAssignEmployeeOrganization,
  demoBrowser,
  demoBusinesses,
  demoDevices,
  demoDeleteOrganizationItem,
  demoCreateMonitoringProfile,
  demoDeleteMonitoringProfile,
  demoEmployees,
  demoKeystrokes,
  demoRoster,
  demoScreenshots,
  demoMonitoringProfiles,
  demoOrganization,
  demoSaveOrganizationItem,
  demoSetDeviceMonitoring,
  demoSetDeviceArchived,
  demoUpdateMonitoringProfile,
  isDemo,
} from "./demo";
import type {
  AccountType,
  ActivityResponse,
  AuthResponse,
  BrowserVisit,
  Business,
  BusinessSettingsPatch,
  CreateEmployeeResponse,
  Device,
  Department,
  EmployeePresence,
  Employee,
  JobRole,
  KeystrokeBucket,
  PrivacyAppCategory,
  PublicBusiness,
  ReportEmployee,
  ScreenshotsResponse,
  Tokens,
  User,
  MonitoringProfile,
  MonitoringProfileInput,
  Organization,
  OrganizationItemInput,
} from "./types";

// ---------- public ----------
export function listPublicBusinesses() {
  return request<{ businesses: PublicBusiness[] }>("/v1/public/businesses", {
    auth: false,
  });
}

// ---------- auth ----------
export async function login(identifier: string, password: string, business_id?: string) {
  const res = await request<AuthResponse>("/v1/auth/login", {
    method: "POST",
    auth: false,
    body: { identifier, password, business_id },
  });
  tokenStore.setSession(res.tokens, res.user);
  return res;
}

export async function register(
  identifier: string,
  password: string,
  display_name: string,
  account_type: AccountType = "manager",
) {
  // One field accepts an email or a username; route it to the right body key.
  const isEmail = identifier.includes("@");
  const res = await request<AuthResponse>("/v1/auth/register", {
    method: "POST",
    auth: false,
    body: {
      email: isEmail ? identifier : undefined,
      username: isEmail ? undefined : identifier.toLowerCase(),
      password,
      display_name,
      account_type,
    },
  });
  tokenStore.setSession(res.tokens, res.user);
  return res;
}

export function refresh(refresh_token: string) {
  return request<Tokens>("/v1/auth/refresh", {
    method: "POST",
    auth: false,
    body: { refresh_token },
  });
}

export function getMe() {
  return request<User>("/v1/me");
}

// ---------- businesses ----------
export function createBusiness(name: string) {
  return request<Business>("/v1/businesses", { method: "POST", body: { name } });
}

export function listMyBusinesses() {
  if (isDemo()) return Promise.resolve({ businesses: demoBusinesses });
  return request<{ businesses: Business[] }>("/v1/businesses/mine");
}

export function updateBusinessSettings(id: string, patch: BusinessSettingsPatch) {
  return request<{ status: string }>(`/v1/businesses/${id}/settings`, {
    method: "PATCH",
    body: patch,
  });
}

export function getPrivacyApps() {
  return request<{ categories: PrivacyAppCategory[] }>("/v1/public/screenshot-privacy-apps");
}

export function cleanupScreenshots(id: string, olderThanDays: number) {
  return request<{ deleted_count: number; bytes_freed: number }>(
    `/v1/businesses/${id}/screenshots/cleanup`,
    { method: "POST", query: { older_than_days: olderThanDays } },
  );
}

// ---------- employees ----------
export function createEmployee(input: {
  email?: string;
  username?: string;
  password: string;
  display_name: string;
  business_id?: string;
}) {
  return request<CreateEmployeeResponse>("/v1/employees", {
    method: "POST",
    body: input,
  });
}

export function listBusinessEmployees(businessId: string) {
  if (isDemo()) return Promise.resolve({ employees: demoEmployees() });
  return request<{ employees: Employee[] }>(`/v1/businesses/${businessId}/employees`);
}

// ---------- organization (F7) ----------
export function listOrganization(businessId: string) {
  if (isDemo()) return Promise.resolve(demoOrganization());
  return request<Organization>(`/v1/businesses/${businessId}/organization`);
}

export function saveDepartment(id: string | null, input: OrganizationItemInput) {
  if (isDemo()) return Promise.resolve({ department: demoSaveOrganizationItem("department", id, input) as Department });
  return request<{ department: Department }>(id ? `/v1/departments/${id}` : "/v1/departments", {
    method: id ? "PUT" : "POST",
    body: input,
  });
}

export function saveJobRole(id: string | null, input: OrganizationItemInput) {
  if (isDemo()) return Promise.resolve({ job_role: demoSaveOrganizationItem("job_role", id, input) as JobRole });
  return request<{ job_role: JobRole }>(id ? `/v1/job-roles/${id}` : "/v1/job-roles", {
    method: id ? "PUT" : "POST",
    body: input,
  });
}

export function deleteOrganizationItem(kind: "department" | "job_role", id: string) {
  if (isDemo()) {
    demoDeleteOrganizationItem(kind, id);
    return Promise.resolve(undefined);
  }
  return request<void>(`/v1/${kind === "department" ? "departments" : "job-roles"}/${id}`, { method: "DELETE" });
}

export function assignEmployeeOrganization(businessId: string, employeeId: string, department_id: string | null, job_role_id: string | null) {
  if (isDemo()) return Promise.resolve({ employee: demoAssignEmployeeOrganization(employeeId, department_id, job_role_id) });
  return request<{ employee: Employee }>(`/v1/businesses/${businessId}/employees/${employeeId}/organization`, {
    method: "PUT",
    body: { department_id, job_role_id },
  });
}

// ---------- reports ----------
export function reportEmployees(businessId: string) {
  if (isDemo()) return Promise.resolve({ employees: demoRoster() });
  return request<{ employees: ReportEmployee[] }>("/v1/reports/employees", {
    query: { business_id: businessId },
  });
}

export function reportActivity(employeeId: string, from: number, to: number) {
  if (isDemo()) return Promise.resolve(demoActivity(employeeId));
  return request<ActivityResponse>(`/v1/reports/employees/${employeeId}/activity`, {
    query: { from, to },
  });
}

export function reportPresence(employeeId: string) {
  if (isDemo()) {
    const now = Math.floor(Date.now() / 1000);
    return Promise.resolve({
      presence: {
        device_id: "demo-device",
        state: "active" as const,
        app: "Google Chrome",
        window_title: "BiBoTracking — Dashboard",
        since: now - 12 * 60,
        seen_at: now,
        session_started_at: now - 2 * 60 * 60,
        resources: {
          cpu_pct: 34.6,
          memory_used_bytes: 9_230_000_000,
          memory_total_bytes: 17_180_000_000,
          disk_used_bytes: 238_000_000_000,
          disk_total_bytes: 512_000_000_000,
          network_rx_bps: 1_820_000,
          network_tx_bps: 284_000,
          seen_at: now,
        },
      },
    });
  }
  return request<{ presence: EmployeePresence }>(`/v1/reports/employees/${employeeId}/presence`);
}

export function reportKeystrokes(employeeId: string, from: number, to: number) {
  if (isDemo()) return Promise.resolve(demoKeystrokes(employeeId));
  return request<{ buckets: KeystrokeBucket[] }>(
    `/v1/reports/employees/${employeeId}/keystrokes`,
    { query: { from, to } },
  );
}

export function reportBrowser(employeeId: string, from: number, to: number) {
  if (isDemo()) return Promise.resolve(demoBrowser(employeeId));
  return request<{ visits: BrowserVisit[] }>(`/v1/reports/employees/${employeeId}/browser`, {
    query: { from, to },
  });
}

export function reportScreenshots(
  employeeId: string,
  from: number,
  to: number,
  limit = 60,
  offset = 0,
) {
  if (isDemo()) return Promise.resolve(demoScreenshots(employeeId));
  return request<ScreenshotsResponse>(`/v1/reports/employees/${employeeId}/screenshots`, {
    query: { from, to, limit, offset },
  });
}

// ---------- devices (F40) ----------
// Fleet inventory for one business. The backend scopes by ownership in SQL, so a
// business the caller does not own yields an empty list rather than an error.
export function listDevices(businessId: string) {
  if (isDemo()) return Promise.resolve({ devices: demoDevices() });
  return request<{ devices: Device[] }>(`/v1/businesses/${businessId}/devices`, {
    query: { include_deleted: "true" },
  });
}

export function setDeviceArchived(deviceId: string, archived: boolean) {
  if (isDemo()) return Promise.resolve({ device: demoSetDeviceArchived(deviceId, archived) });
  return request<{ device: Device }>(
    `/v1/devices/${deviceId}/${archived ? "archive" : "restore"}`,
    { method: "POST" },
  );
}

// ---------- monitoring profiles (F41) ----------
export function listMonitoringProfiles(businessId: string) {
  if (isDemo()) return Promise.resolve({ profiles: demoMonitoringProfiles() });
  return request<{ profiles: MonitoringProfile[] }>(`/v1/businesses/${businessId}/monitoring-profiles`);
}

export function createMonitoringProfile(input: MonitoringProfileInput) {
  if (isDemo()) return Promise.resolve({ profile: demoCreateMonitoringProfile(input) });
  return request<{ profile: MonitoringProfile }>("/v1/monitoring-profiles", {
    method: "POST",
    body: input,
  });
}

export function updateMonitoringProfile(id: string, input: MonitoringProfileInput) {
  if (isDemo()) return Promise.resolve({ profile: demoUpdateMonitoringProfile(id, input) });
  return request<{ profile: MonitoringProfile }>(`/v1/monitoring-profiles/${id}`, {
    method: "PUT",
    body: input,
  });
}

export function deleteMonitoringProfile(id: string) {
  if (isDemo()) {
    demoDeleteMonitoringProfile(id);
    return Promise.resolve(undefined);
  }
  return request<void>(`/v1/monitoring-profiles/${id}`, { method: "DELETE" });
}

// Turning monitoring off stops the backend ingesting that machine's data; it
// keeps registering heartbeats, so it stays visible as alive. Nothing is deleted.
export function setDeviceMonitoring(deviceId: string, enabled: boolean) {
  if (isDemo()) return Promise.resolve({ device: demoSetDeviceMonitoring(deviceId, enabled) });
  return request<{ device: Device }>(`/v1/devices/${deviceId}/monitoring`, {
    method: "POST",
    body: { enabled },
  });
}

export function requestLiveCapture(deviceId: string) {
  if (isDemo()) {
    return Promise.resolve({ device_id: deviceId, requested_at: Math.floor(Date.now() / 1000) });
  }
  return request<{ device_id: string; requested_at: number }>(
    `/v1/devices/${deviceId}/live-capture`,
    { method: "POST" },
  );
}
