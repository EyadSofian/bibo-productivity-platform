import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createMonitoringProfile,
  deleteMonitoringProfile,
  listBusinessEmployees,
  listDevices,
  listMonitoringProfiles,
  listOrganization,
  updateMonitoringProfile,
} from "../api/endpoints";
import { ApiError, type Department, type Device, type Employee, type MonitoringProfile, type MonitoringProfileInput, type MonitoringScopeType } from "../api/types";
import { Empty, Notice, Spinner } from "../components/ui";
import { useBusinesses } from "../useBusinesses";
import { localTimeZone, normalizeTimeZone } from "../timeZone";

const CATEGORIES = ["applications", "websites", "screen", "keystrokes"] as const;
type Category = (typeof CATEGORIES)[number];
type RuleDraft = {
  override: boolean;
  enabled: boolean;
  days: number[];
  start: string;
  end: string;
  timezone: string;
};
type Draft = {
  id: string | null;
  name: string;
  description: string;
  parentId: string;
  private: boolean;
  scope: string;
  rules: Record<Category, RuleDraft>;
};

// Keep the policy editor quick and usable: rendering every IANA zone four
// times creates well over a thousand <option>s. Existing/custom zones are
// prepended by the select below, so no saved value is ever lost.
const TIMEZONES = [
  "UTC",
  "Africa/Cairo",
  "Africa/Casablanca",
  "Africa/Johannesburg",
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Amman",
  "Asia/Beirut",
  "Asia/Jerusalem",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
];
const WEEK = [1, 2, 3, 4, 5, 6, 7];

const defaultRule = (): RuleDraft => ({
  override: true,
  enabled: true,
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00",
  timezone: localTimeZone(),
});

function blankDraft(businessId: string): Draft {
  return {
    id: null,
    name: "",
    description: "",
    parentId: "",
    private: false,
    scope: `business:${businessId}`,
    rules: Object.fromEntries(CATEGORIES.map((key) => [key, defaultRule()])) as Draft["rules"],
  };
}

const minuteToTime = (minute: number) =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const timeToMinute = (value: string) => {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
};

function editDraft(profile: MonitoringProfile): Draft {
  const rules = Object.fromEntries(
    CATEGORIES.map((key) => {
      const detail = profile.details.find((item) => item.tracking_key === key);
      return [key, detail ? {
        override: true,
        enabled: detail.tracking_val === true,
        days: [...detail.days_of_week],
        start: minuteToTime(detail.start_minute),
        end: minuteToTime(detail.end_minute),
        timezone: detail.timezone,
      } : { ...defaultRule(), override: false }];
    }),
  ) as Draft["rules"];
  const assignment = profile.assignments[0];
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    parentId: profile.parent_id ?? "",
    private: profile.private,
    scope: assignment ? `${assignment.scope_type}:${assignment.scope_id}` : "",
    rules,
  };
}

function inputFromDraft(draft: Draft, businessId: string): MonitoringProfileInput {
  const [scopeType, scopeId] = draft.scope.split(":", 2);
  return {
    business_id: businessId,
    name: draft.name.trim(),
    description: draft.description.trim(),
    parent_id: draft.parentId || null,
    private: draft.private,
    details: CATEGORIES.filter((key) => draft.rules[key].override).map((key) => ({
      tracking_key: key,
      tracking_val: draft.rules[key].enabled,
      days_of_week: draft.rules[key].days,
      start_minute: timeToMinute(draft.rules[key].start),
      end_minute: timeToMinute(draft.rules[key].end) || 1440,
      timezone: normalizeTimeZone(draft.rules[key].timezone),
    })),
    assignments: scopeType && scopeId ? [{ scope_type: scopeType as MonitoringScopeType, scope_id: scopeId }] : [],
  };
}

export function MonitoringProfiles() {
  const { t } = useTranslation("dashboard");
  const { selectedId, loading: bizLoading } = useBusinesses();
  const [profiles, setProfiles] = useState<MonitoringProfile[] | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedId) return;
    setError(null);
    try {
      const [profileRes, employeeRes, deviceRes, organizationRes] = await Promise.all([
        listMonitoringProfiles(selectedId),
        listBusinessEmployees(selectedId),
        listDevices(selectedId),
        listOrganization(selectedId),
      ]);
      setProfiles(profileRes.profiles);
      setEmployees(employeeRes.employees);
      setDevices(deviceRes.devices.filter((device) => !device.deleted_at));
      setDepartments(organizationRes.departments);
    } catch (err) {
      setProfiles([]);
      setError(err instanceof ApiError ? err.message : t("profiles.errorLoad"));
    }
  }, [selectedId, t]);

  useEffect(() => {
    setProfiles(null);
    setDraft(null);
    void load();
  }, [load]);

  const profileNames = useMemo(() => new Map(profiles?.map((p) => [p.id, p.name]) ?? []), [profiles]);
  if (bizLoading) return <Spinner label={t("profiles.loading")} />;
  if (!selectedId) return <Empty>{t("profiles.noBusiness")}</Empty>;
  if (profiles === null) return <Spinner label={t("profiles.loading")} />;

  const updateRule = (category: Category, patch: Partial<RuleDraft>) => {
    setDraft((current) => current ? {
      ...current,
      rules: { ...current.rules, [category]: { ...current.rules[category], ...patch } },
    } : current);
  };

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const input = inputFromDraft(draft, selectedId);
      if (draft.id) await updateMonitoringProfile(draft.id, input);
      else await createMonitoringProfile(input);
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("profiles.errorSave"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profile: MonitoringProfile) => {
    if (!window.confirm(t("profiles.confirmDelete", { name: profile.name }))) return;
    setBusy(true);
    setError(null);
    try {
      await deleteMonitoringProfile(profile.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("profiles.errorDelete"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ad-page">
      <div className="ad-pagehead">
        <div className="ad-pagehead__main">
          <h1 className="ad-h1">{t("profiles.title")}</h1>
          <p className="ad-sub">{t("profiles.subtitle")}</p>
        </div>
        <div className="ad-pagehead__actions">
          <button className="bibo-btn bibo-btn--primary" onClick={() => setDraft(blankDraft(selectedId))}>
            {t("profiles.new")}
          </button>
        </div>
      </div>

      {error && <Notice kind="danger">{error}</Notice>}

      {profiles.length === 0 ? <Empty>{t("profiles.empty")}</Empty> : (
        <div className="mp-grid">
          {profiles.map((profile) => (
            <article key={profile.id} className="bibo-card bibo-card--default mp-card">
              <div className="mp-card__head">
                <div>
                  <h2>{profile.name}</h2>
                  <p>{profile.description || t("profiles.noDescription")}</p>
                </div>
                {profile.private && <span className="bibo-chip">{t("profiles.private")}</span>}
              </div>
              <div className="mp-meta">
                <span>{t("profiles.overrides", { count: profile.details.length })}</span>
                <span>{t("profiles.assignments", { count: profile.assignments.length })}</span>
                {profile.parent_id && <span>{t("profiles.inherits", { name: profileNames.get(profile.parent_id) ?? "—" })}</span>}
              </div>
              <div className="mp-tags">
                {profile.details.map((detail) => (
                  <span key={detail.tracking_key} className={`mp-tag${detail.tracking_val === true ? " on" : ""}`}>
                    {t(`profiles.categories.${detail.tracking_key}`)}
                  </span>
                ))}
              </div>
              <div className="mp-card__actions">
                <button className="bibo-btn bibo-btn--secondary bibo-btn--sm" onClick={() => setDraft(editDraft(profile))}>
                  {t("profiles.edit")}
                </button>
                <button className="bibo-btn bibo-btn--ghost bibo-btn--sm" disabled={busy} onClick={() => void remove(profile)}>
                  {t("profiles.delete")}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {draft && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDraft(null)}>
          <section className="bibo-dlg mp-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title">
            <div className="bibo-dlg__head">
              <h2 id="profile-editor-title" className="bibo-dlg__title">{draft.id ? t("profiles.editTitle") : t("profiles.createTitle")}</h2>
              <button className="bibo-dlg__close" aria-label={t("profiles.close")} onClick={() => setDraft(null)}>×</button>
            </div>
            <div className="bibo-dlg__body mp-form">
              <label className="bibo-field">
                <span>{t("profiles.name")}</span>
                <input value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="bibo-field">
                <span>{t("profiles.description")}</span>
                <textarea value={draft.description} maxLength={1000} rows={2} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </label>
              <div className="mp-form__row">
                <label className="bibo-field">
                  <span>{t("profiles.parent")}</span>
                  <select value={draft.parentId} onChange={(e) => setDraft({ ...draft, parentId: e.target.value })}>
                    <option value="">{t("profiles.noParent")}</option>
                    {profiles.filter((profile) => profile.id !== draft.id).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                  </select>
                </label>
                <label className="bibo-field">
                  <span>{t("profiles.scope")}</span>
                  <select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
                    <option value="">{t("profiles.unassigned")}</option>
                    <option value={`business:${selectedId}`}>{t("profiles.companyWide")}</option>
                    <optgroup label={t("profiles.departments")}>
                      {departments.map((department) => <option key={department.id} value={`department:${department.id}`}>{department.name}</option>)}
                    </optgroup>
                    <optgroup label={t("profiles.employees")}>
                      {employees.map((employee) => <option key={employee.id} value={`employee:${employee.id}`}>{employee.display_name}</option>)}
                    </optgroup>
                    <optgroup label={t("profiles.devices")}>
                      {devices.map((device) => <option key={device.id} value={`device:${device.id}`}>{device.label || device.user_display_name}</option>)}
                    </optgroup>
                  </select>
                </label>
              </div>
              <label className="mp-checkline">
                <input type="checkbox" checked={draft.private} onChange={(e) => setDraft({ ...draft, private: e.target.checked })} />
                <span>{t("profiles.privateHelp")}</span>
              </label>

              <h3 className="mp-sectiontitle">{t("profiles.captureRules")}</h3>
              <div className="mp-rules">
                {CATEGORIES.map((category) => {
                  const rule = draft.rules[category];
                  return (
                    <section key={category} className={`mp-rule${rule.override ? " active" : ""}`}>
                      <div className="mp-rule__head">
                        <strong>{t(`profiles.categories.${category}`)}</strong>
                        <label className="mp-checkline">
                          <input type="checkbox" checked={rule.override} onChange={(e) => updateRule(category, { override: e.target.checked })} />
                          <span>{rule.override ? t("profiles.override") : t("profiles.inherited")}</span>
                        </label>
                      </div>
                      <fieldset disabled={!rule.override}>
                        <label className="mp-checkline">
                          <input type="checkbox" checked={rule.enabled} onChange={(e) => updateRule(category, { enabled: e.target.checked })} />
                          <span>{rule.enabled ? t("profiles.captureOn") : t("profiles.captureOff")}</span>
                        </label>
                        <div className="mp-days" aria-label={t("profiles.days")}>
                          {WEEK.map((day) => (
                            <button key={day} type="button" aria-pressed={rule.days.includes(day)} className={rule.days.includes(day) ? "on" : ""} onClick={() => updateRule(category, { days: rule.days.includes(day) ? rule.days.filter((value) => value !== day) : [...rule.days, day].sort() })}>
                              {t(`profiles.day.${day}`)}
                            </button>
                          ))}
                        </div>
                        <div className="mp-form__row mp-form__row--three">
                          <label className="bibo-field"><span>{t("profiles.start")}</span><input type="time" value={rule.start} onChange={(e) => updateRule(category, { start: e.target.value })} /></label>
                          <label className="bibo-field"><span>{t("profiles.end")}</span><input type="time" value={rule.end} onChange={(e) => updateRule(category, { end: e.target.value })} /></label>
                          <label className="bibo-field"><span>{t("profiles.timezone")}</span><select value={rule.timezone} onChange={(e) => updateRule(category, { timezone: e.target.value })}>{(TIMEZONES.includes(rule.timezone) ? TIMEZONES : [rule.timezone, ...TIMEZONES]).map((zone) => <option key={zone}>{zone}</option>)}</select></label>
                        </div>
                      </fieldset>
                    </section>
                  );
                })}
              </div>
            </div>
            <div className="bibo-dlg__foot">
              <button className="bibo-btn bibo-btn--ghost" onClick={() => setDraft(null)}>{t("profiles.cancel")}</button>
              <button className="bibo-btn bibo-btn--primary" disabled={busy || !draft.name.trim() || CATEGORIES.some((key) => draft.rules[key].override && draft.rules[key].days.length === 0)} onClick={() => void save()}>
                {busy ? t("profiles.saving") : t("profiles.save")}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
