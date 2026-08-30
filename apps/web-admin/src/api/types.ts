// Shapes mirror the backend contract in docs/11-backend-and-sync.md.

export interface PublicBusiness {
  business_id: string;
  name: string;
  owner_name: string;
}

/** Persona of a self-signup owner. Personal users have no account at all. */
export type AccountType = "manager" | "parent";

export interface User {
  id: string;
  email: string;
  username?: string;
  display_name: string;
  account_type: AccountType;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface AuthResponse {
  user: User;
  tokens: Tokens;
}

/** Legacy storage accepts both values; the management UI always treats members as employees. */
export type BusinessKind = "team" | "family";

/**
 * How employee screens are captured. "privacy" (the default) captures only the
 * frontmost window; "normal" captures every display in full. The backend may
 * still return pre-rename values ("full_screen"/"active_window") — normalize
 * before comparing.
 */
export type ScreenshotMode = "privacy" | "normal";

/** One category of the backend's curated sensitive-app list. */
export interface PrivacyAppCategory {
  key: string;
  apps: string[];
}

export interface Business {
  id: string;
  name: string;
  kind: BusinessKind;
  owner_user_id: string;
  screenshot_retention_days: number | null;
  screenshot_interval_s: number;
  idle_threshold_s: number;
  allow_employee_override: boolean;
  screenshot_mode: string; // normalize to ScreenshotMode before comparing
  screenshot_skip_apps: string[];
}

export interface BusinessSettingsPatch {
  screenshot_retention_days?: number | null;
  screenshot_interval_s?: number;
  idle_threshold_s?: number;
  allow_employee_override?: boolean;
  screenshot_mode?: ScreenshotMode;
  screenshot_skip_apps?: string[];
}

export interface Employee {
  id: string;
  email: string;
  username?: string;
  display_name: string;
  department_id: string | null;
  department_name: string;
  job_role_id: string | null;
  job_role_name: string;
}

export interface Department {
  id: string;
  business_id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface JobRole extends Department {}

export interface Organization {
  departments: Department[];
  job_roles: JobRole[];
}

export interface OrganizationItemInput {
  business_id: string;
  name: string;
  description: string;
}

export interface CreateEmployeeResponse {
  employee: Employee;
  business: Business;
}

export interface ReportEmployee {
  id: string;
  email: string;
  username?: string;
  display_name: string;
  role?: "owner" | "employee";
  last_seen: number | null;
  active_today_s: number;
  active_yesterday_s: number;
  screenshots_today: number;
  screenshots_yesterday: number;
  /** 0–100 share of active time with keyboard input; null when no activity today. */
  focus_pct_today: number | null;
}

export interface ActivitySample {
  ts: number;
  app_name: string;
  window_title: string;
  duration_s: number;
}

export interface AppBreakdown {
  app_name: string;
  duration_s: number;
}

export interface ActivityResponse {
  samples: ActivitySample[];
  breakdown: AppBreakdown[];
}

export type PresenceState = "online" | "active" | "idle" | "offline";

export interface EmployeePresence {
  device_id: string | null;
  state: PresenceState;
  app: string | null;
  window_title: string | null;
  since: number | null;
  seen_at: number | null;
}

export interface KeystrokeBucket {
  ts_bucket: number;
  count: number;
}

export interface BrowserVisit {
  ts: number;
  url: string;
  /** Derived by the backend from `url`. Null for the on/off marker rows. */
  domain: string | null;
  page_title: string;
  browser: string;
  duration_s: number;
}

export interface ScreenshotMeta {
  client_uuid: string;
  ts: number;
  byte_size: number;
  width: number;
  height: number;
  display_id: number;
}

export interface ScreenshotsResponse {
  screenshots: ScreenshotMeta[];
  limit: number;
  offset: number;
}

// Thrown by the client for non-2xx responses so UIs can show inline errors.
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** One installed agent, as shown in the fleet inventory (F40). Registered as a
 *  side effect of sync; `monitoring_enabled` is managed by the owner. */
export type Device = {
  id: string;
  business_id: string | null;
  user_id: string;
  label: string | null;
  os: string | null;
  agent_version: string | null;
  monitoring_enabled: boolean;
  last_seen_at: string | null;
  disabled_at: string | null;
  deleted_at: string | null;
  user_display_name: string;
  user_login: string;
};

export type MonitoringScopeType = "business" | "department" | "employee" | "device";

export interface MonitoringDetail {
  tracking_key: string;
  tracking_val: unknown;
  days_of_week: number[];
  start_minute: number;
  end_minute: number;
  timezone: string;
  source_profile_id?: string;
  source_profile_name?: string;
}

export interface MonitoringAssignment {
  scope_type: MonitoringScopeType;
  scope_id: string;
}

export interface MonitoringProfile {
  id: string;
  business_id: string;
  name: string;
  description: string;
  parent_id: string | null;
  private: boolean;
  details: MonitoringDetail[];
  assignments: MonitoringAssignment[];
  created_at: string;
  updated_at: string;
}

export type MonitoringProfileInput = Omit<MonitoringProfile, "id" | "created_at" | "updated_at">;
