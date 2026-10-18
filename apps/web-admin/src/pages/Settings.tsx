import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  createMonitoringProfile,
  deleteMonitoringProfile,
  deleteOrganizationItem,
  listBusinessEmployees,
  listDevices,
  listMonitoringProfiles,
  listOrganization,
  saveDepartment,
  saveJobRole,
  updateBusinessSettings,
  updateMonitoringProfile,
} from "../api/endpoints";
import type { Department, MonitoringProfile, MonitoringProfileInput, MonitoringScopeType } from "../api/types";
import { usePageHeader } from "../app/AppShell";
import { useBusinesses } from "../app/useBusinesses";
import { useTheme, type ThemeMode } from "../app/theme";
import { localTimeZone, normalizeTimeZone } from "../lib/timeZone";
import { useAsync } from "../lib/useAsync";
import { Icon, type IconName } from "../ui/Icon";
import { Card, Dialog, Empty, ErrorNote, LoadingRows, Segmented, Tabs, Toggle } from "../ui/kit";
import { LOCALES } from "../i18n";

type Tab = "general" | "schedules" | "organization";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

export default function Settings() {
  const { t } = useTranslation("app");
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "general";
  usePageHeader(t("settings.title"), t("settings.subtitle"));
  return (
    <div className="page">
      <section className="glass card">
        <Tabs<Tab>
          value={tab}
          onChange={(v) => setParams({ tab: v }, { replace: true })}
          label={t("settings.title")}
          tabs={[
            { value: "general", label: t("settings.general"), icon: "settings" },
            { value: "schedules", label: t("settings.schedules"), icon: "calendar" },
            { value: "organization", label: t("settings.organization"), icon: "building" },
          ]}
        />
        {tab === "general" ? <General /> : tab === "schedules" ? <Schedules /> : <Organization />}
      </section>
    </div>
  );
}

/* ---------- general ---------- */

const IDLE_MINUTES = [1, 2, 3, 5, 10, 15];

function General() {
  const { t, i18n } = useTranslation("app");
  const { selected, reload } = useBusinesses();
  const { mode, setMode } = useTheme();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const patch = async (p: Parameters<typeof updateBusinessSettings>[1]) => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateBusinessSettings(selected.id, p);
      await reload();
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const tracked: Array<[IconName, string]> = [
    ["app", t("settings.tracks.apps")],
    ["link", t("settings.tracks.sites")],
    ["clock", t("settings.tracks.time")],
    ["keyboard", t("settings.tracks.keys")],
    ["mouse", t("settings.tracks.mouse")],
    ["live", t("settings.tracks.video")],
  ];

  return (
    <div className="settings-grid">
      <div className="settings-section">
        <h3 className="card-title">{t("settings.trackingTitle")}</h3>
        <p className="card-sub">{t("settings.trackingSub")}</p>
        <ErrorNote error={error} />
        {saved ? (
          <div className="alert alert-ok">
            <Icon name="check" />
            <span>{t("settings.saved")}</span>
          </div>
        ) : null}
        <label className="field">
          <span className="field-label">{t("settings.idle")}</span>
          <select
            className="select"
            disabled={!selected || saving}
            value={selected ? Math.round(selected.idle_threshold_s / 60) : 5}
            onChange={(e) => void patch({ idle_threshold_s: Number(e.target.value) * 60 })}
          >
            {IDLE_MINUTES.map((m) => (
              <option key={m} value={m}>
                {t("settings.minutes", { count: m })}
              </option>
            ))}
          </select>
          <span className="field-hint">{t("settings.idleHint")}</span>
        </label>
        <Toggle
          checked={selected?.allow_employee_override ?? false}
          disabled={!selected || saving}
          onChange={(v) => void patch({ allow_employee_override: v })}
          label={
            <span className="person-text">
              <span className="strong">{t("settings.override")}</span>
              <span className="field-hint">{t("settings.overrideHint")}</span>
            </span>
          }
        />
      </div>

      <div className="settings-section">
        <h3 className="card-title">{t("settings.agentTitle")}</h3>
        <p className="card-sub">{t("settings.agentSub")}</p>
        <div className="download-row">
          <a className="btn" href={`${API_BASE}/download/BiBoTracking-Windows-x64-Setup.exe`}>
            <Icon name="download" />
            {t("settings.downloadWindows")}
          </a>
          <a className="btn" href={`${API_BASE}/download/EmployeeTracker-macOS.dmg`}>
            <Icon name="download" />
            {t("settings.downloadMac")}
          </a>
        </div>
        <ul className="tracks">
          {tracked.map(([icon, label]) => (
            <li key={label}>
              <span className="kpi-icon">
                <Icon name={icon} />
              </span>
              {label}
            </li>
          ))}
        </ul>
        <div className="alert">
          <Icon name="shield" />
          <span>{t("settings.never")}</span>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="card-title">{t("settings.appearance")}</h3>
        <div className="field">
          <span className="field-label">{t("settings.language")}</span>
          <Segmented
            value={i18n.resolvedLanguage === "en" ? "en" : "ar"}
            onChange={(v) => void i18n.changeLanguage(v)}
            label={t("settings.language")}
            options={LOCALES.map((l) => ({ value: l.code, label: l.label }))}
          />
        </div>
        <div className="field">
          <span className="field-label">{t("settings.theme")}</span>
          <Segmented<ThemeMode>
            value={mode}
            onChange={setMode}
            label={t("settings.theme")}
            options={[
              { value: "light", label: t("settings.light") },
              { value: "dark", label: t("settings.dark") },
              { value: "system", label: t("settings.system") },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/* ---------- monitoring schedules ---------- */

const CHANNELS = ["applications", "websites", "keystrokes", "screen", "recording"] as const;
type Channel = (typeof CHANNELS)[number];
const CHANNEL_ICON: Record<Channel, IconName> = {
  applications: "app",
  websites: "link",
  keystrokes: "keyboard",
  screen: "live",
  recording: "play",
};

type Rule = { enabled: boolean; days: number[]; start: string; end: string };
type Draft = {
  id: string | null;
  name: string;
  scope: string;
  timezone: string;
  rules: Record<Channel, Rule>;
  // Kept so editing never drops fields this form does not show.
  parentId: string | null;
  isPrivate: boolean;
  description: string;
};

const WEEK = [6, 7, 1, 2, 3, 4, 5]; // ISO days, starting Saturday as in Egypt and the Gulf
const minuteToTime = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const timeToMinute = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
};

const defaultRule = (enabled = true): Rule => ({ enabled, days: [7, 1, 2, 3, 4], start: "09:00", end: "17:00" });

function blankDraft(businessId: string): Draft {
  return {
    id: null,
    name: "",
    scope: `business:${businessId}`,
    timezone: localTimeZone(),
    rules: Object.fromEntries(CHANNELS.map((c) => [c, defaultRule(c !== "recording")])) as Draft["rules"],
    parentId: null,
    isPrivate: false,
    description: "",
  };
}

export function draftFromProfile(p: MonitoringProfile): Draft {
  const rules = Object.fromEntries(
    CHANNELS.map((c) => {
      const d = p.details.find((x) => x.tracking_key === c);
      return [
        c,
        d
          ? { enabled: d.tracking_val === true, days: [...d.days_of_week], start: minuteToTime(d.start_minute), end: minuteToTime(d.end_minute) }
          : defaultRule(c !== "recording"),
      ];
    }),
  ) as Draft["rules"];
  const a = p.assignments[0];
  return {
    id: p.id,
    name: p.name,
    scope: a ? `${a.scope_type}:${a.scope_id}` : "",
    timezone: p.details[0]?.timezone ?? localTimeZone(),
    rules,
    parentId: p.parent_id,
    isPrivate: p.private,
    description: p.description,
  };
}

export function inputFromDraft(draft: Draft, businessId: string): MonitoringProfileInput {
  const [scopeType, scopeId] = draft.scope.split(":", 2);
  const tz = normalizeTimeZone(draft.timezone);
  return {
    business_id: businessId,
    name: draft.name.trim(),
    description: draft.description,
    parent_id: draft.parentId,
    private: draft.isPrivate,
    details: CHANNELS.map((c) => ({
      tracking_key: c,
      tracking_val: draft.rules[c].enabled,
      days_of_week: [...draft.rules[c].days].sort((a, b) => a - b),
      start_minute: timeToMinute(draft.rules[c].start),
      end_minute: timeToMinute(draft.rules[c].end) || 1440,
      timezone: tz,
    })),
    assignments: scopeType && scopeId ? [{ scope_type: scopeType as MonitoringScopeType, scope_id: scopeId }] : [],
  };
}

function Schedules() {
  const { t } = useTranslation("app");
  const { selectedId } = useBusinesses();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const data = useAsync(async () => {
    if (!selectedId) return null;
    const [profiles, org, employees, devices] = await Promise.all([
      listMonitoringProfiles(selectedId),
      listOrganization(selectedId),
      listBusinessEmployees(selectedId),
      listDevices(selectedId),
    ]);
    return { profiles: profiles.profiles, departments: org.departments, employees: employees.employees, devices: devices.devices.filter((d) => !d.deleted_at) };
  }, [selectedId]);

  const scopeLabel = (scope: MonitoringProfile["assignments"][number] | undefined) => {
    if (!scope) return t("schedules.unassigned");
    const d = data.data;
    switch (scope.scope_type) {
      case "business":
        return t("schedules.wholeCompany");
      case "department":
        return d?.departments.find((x) => x.id === scope.scope_id)?.name ?? t("schedules.department");
      case "employee":
        return d?.employees.find((x) => x.id === scope.scope_id)?.display_name ?? t("schedules.employee");
      case "device":
        return d?.devices.find((x) => x.id === scope.scope_id)?.label ?? t("schedules.device");
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft || !selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const input = inputFromDraft(draft, selectedId);
      if (draft.id) await updateMonitoringProfile(draft.id, input);
      else await createMonitoringProfile(input);
      setDraft(null);
      data.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(t("schedules.confirmDelete"))) return;
    try {
      await deleteMonitoringProfile(id);
      data.reload();
    } catch (err) {
      setError(err);
    }
  };

  const setRule = (c: Channel, patch: Partial<Rule>) =>
    setDraft((d) => (d ? { ...d, rules: { ...d.rules, [c]: { ...d.rules[c], ...patch } } } : d));

  return (
    <div className="form-grid">
      <div className="toolbar">
        <p className="muted grow">{t("schedules.intro")}</p>
        <button type="button" className="btn btn-primary btn-sm" disabled={!selectedId} onClick={() => selectedId && setDraft(blankDraft(selectedId))}>
          <Icon name="plus" />
          {t("schedules.new")}
        </button>
      </div>
      <ErrorNote error={data.error ?? (draft ? null : error)} onRetry={data.error ? data.reload : undefined} />
      {data.loading && !data.data ? (
        <LoadingRows rows={3} />
      ) : (data.data?.profiles.length ?? 0) === 0 ? (
        <Empty icon="calendar" title={t("schedules.none")}>
          {t("schedules.noneHint")}
        </Empty>
      ) : (
        <ul className="profile-list">
          {data.data!.profiles.map((p) => (
            <li key={p.id} className="profile-item">
              <span className="kpi-icon">
                <Icon name="calendar" />
              </span>
              <span className="person-text" style={{ flex: 1 }}>
                <span className="person-name">{p.name}</span>
                <span className="person-sub">{scopeLabel(p.assignments[0])}</span>
              </span>
              <span className="chip-row hide-sm">
                {p.details.map((d) => (
                  <span key={d.tracking_key} className={`badge ${d.tracking_val === true ? "badge-brand" : ""}`} title={t(`schedules.channel.${d.tracking_key}`, { defaultValue: d.tracking_key })}>
                    <Icon name={CHANNEL_ICON[d.tracking_key as Channel] ?? "info"} />
                    {d.tracking_val === true ? (
                      // A digits-only range reverses inside RTL text without an isolate.
                      <bdi dir="ltr">{`${minuteToTime(d.start_minute)}–${minuteToTime(d.end_minute)}`}</bdi>
                    ) : (
                      t("schedules.off")
                    )}
                  </span>
                ))}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setDraft(draftFromProfile(p))}>
                <Icon name="edit" />
                <span className="hide-sm">{t("schedules.edit")}</span>
              </button>
              <button type="button" className="btn btn-ghost btn-sm btn-icon btn-danger" onClick={() => void remove(p.id)} aria-label={t("schedules.delete")}>
                <Icon name="trash" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={draft !== null} onClose={() => setDraft(null)} title={draft?.id ? t("schedules.editTitle") : t("schedules.newTitle")} wide>
        {draft ? (
          <form className="form-grid" onSubmit={save}>
            <ErrorNote error={error} />
            <div className="form-row">
              <label className="field">
                <span className="field-label">{t("schedules.name")}</span>
                <input className="input" required dir="auto" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">{t("schedules.appliesTo")}</span>
                <select className="select" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
                  <option value={`business:${selectedId}`}>{t("schedules.wholeCompany")}</option>
                  {(data.data?.departments ?? []).length ? (
                    <optgroup label={t("schedules.departments")}>
                      {data.data!.departments.map((d: Department) => (
                        <option key={d.id} value={`department:${d.id}`}>{d.name}</option>
                      ))}
                    </optgroup>
                  ) : null}
                  <optgroup label={t("schedules.employees")}>
                    {(data.data?.employees ?? []).map((e) => (
                      <option key={e.id} value={`employee:${e.id}`}>{e.display_name}</option>
                    ))}
                  </optgroup>
                  {(data.data?.devices ?? []).length ? (
                    <optgroup label={t("schedules.devices")}>
                      {data.data!.devices.map((d) => (
                        <option key={d.id} value={`device:${d.id}`}>{d.label || d.user_display_name}</option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </label>
            </div>
            <label className="field">
              <span className="field-label">{t("schedules.timezone")}</span>
              <input className="input ltr" value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} list="tz-list" />
              <datalist id="tz-list">
                {["Africa/Cairo", "Asia/Riyadh", "Asia/Dubai", "Asia/Amman", "Asia/Kuwait", "Asia/Qatar", "Europe/London", "UTC"].map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </label>
            <div className="rules">
              {CHANNELS.map((c) => {
                const r = draft.rules[c];
                return (
                  <div key={c} className={`rule${r.enabled ? "" : " is-off"}`}>
                    <div className="rule-head">
                      <Toggle
                        checked={r.enabled}
                        onChange={(v) => setRule(c, { enabled: v })}
                        label={
                          <span className="rule-name">
                            <Icon name={CHANNEL_ICON[c]} />
                            {t(`schedules.channel.${c}`)}
                          </span>
                        }
                      />
                    </div>
                    {r.enabled ? (
                      <div className="rule-body">
                        <div className="days" role="group" aria-label={t("schedules.days")}>
                          {WEEK.map((day) => {
                            const on = r.days.includes(day);
                            return (
                              <button
                                key={day}
                                type="button"
                                aria-pressed={on}
                                onClick={() => setRule(c, { days: on ? r.days.filter((x) => x !== day) : [...r.days, day] })}
                              >
                                {t(`schedules.day.${day}`)}
                              </button>
                            );
                          })}
                        </div>
                        <div className="rule-times" dir="ltr">
                          <input className="input" type="time" aria-label={t("schedules.from")} value={r.start} onChange={(e) => setRule(c, { start: e.target.value })} />
                          <span className="muted">→</span>
                          <input className="input" type="time" aria-label={t("schedules.to")} value={r.end} onChange={(e) => setRule(c, { end: e.target.value })} />
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setDraft(null)}>
                {t("actions.cancel", { ns: "common" })}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? t("actions.saving", { ns: "common" }) : t("actions.save", { ns: "common" })}
              </button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </div>
  );
}

/* ---------- departments & roles ---------- */

function Organization() {
  const { t } = useTranslation("app");
  const { selectedId } = useBusinesses();
  const org = useAsync(
    () => (selectedId ? listOrganization(selectedId) : Promise.resolve({ departments: [], job_roles: [] })),
    [selectedId],
  );
  const [editing, setEditing] = useState<{ kind: "department" | "job_role"; id: string | null; name: string; description: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing || !selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const input = { business_id: selectedId, name: editing.name.trim(), description: editing.description.trim() };
      if (editing.kind === "department") await saveDepartment(editing.id, input);
      else await saveJobRole(editing.id, input);
      setEditing(null);
      org.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (kind: "department" | "job_role", id: string) => {
    if (!window.confirm(t("org.confirmDelete"))) return;
    try {
      await deleteOrganizationItem(kind, id);
      org.reload();
    } catch (err) {
      setError(err);
    }
  };

  const column = (kind: "department" | "job_role", items: Department[]) => (
    <Card
      title={kind === "department" ? t("org.departments") : t("org.roles")}
      sub={t("org.count", { count: items.length })}
      actions={
        <button type="button" className="btn btn-sm" onClick={() => setEditing({ kind, id: null, name: "", description: "" })}>
          <Icon name="plus" />
          {t("org.add")}
        </button>
      }
    >
      {items.length === 0 ? (
        <Empty icon={kind === "department" ? "building" : "user"} title={kind === "department" ? t("org.noDepartments") : t("org.noRoles")} />
      ) : (
        <ul className="profile-list">
          {items.map((item) => (
            <li key={item.id} className="profile-item">
              <span className="person-text" style={{ flex: 1 }}>
                <span className="person-name">{item.name}</span>
                {item.description ? <span className="person-sub">{item.description}</span> : null}
              </span>
              <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={t("org.edit")} onClick={() => setEditing({ kind, id: item.id, name: item.name, description: item.description })}>
                <Icon name="edit" />
              </button>
              <button type="button" className="btn btn-ghost btn-sm btn-icon btn-danger" aria-label={t("org.delete")} onClick={() => void remove(kind, item.id)}>
                <Icon name="trash" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  return (
    <div className="form-grid">
      <p className="muted">{t("org.intro")}</p>
      <ErrorNote error={org.error ?? (editing ? null : error)} onRetry={org.error ? org.reload : undefined} />
      {org.loading && !org.data ? (
        <LoadingRows rows={3} />
      ) : (
        <div className="grid grid-2">
          {column("department", org.data?.departments ?? [])}
          {column("job_role", org.data?.job_roles ?? [])}
        </div>
      )}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.kind === "department" ? (editing.id ? t("org.editDepartment") : t("org.newDepartment")) : editing?.id ? t("org.editRole") : t("org.newRole")}
      >
        {editing ? (
          <form className="form-grid" onSubmit={save}>
            <ErrorNote error={error} />
            <label className="field">
              <span className="field-label">{t("org.name")}</span>
              <input className="input" required dir="auto" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">{t("org.description")}</span>
              <textarea className="textarea" dir="auto" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                {t("actions.cancel", { ns: "common" })}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? t("actions.saving", { ns: "common" }) : t("actions.save", { ns: "common" })}
              </button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </div>
  );
}
