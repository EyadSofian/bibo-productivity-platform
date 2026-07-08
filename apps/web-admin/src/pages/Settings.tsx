import { useEffect, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { cleanupScreenshots, updateBusinessSettings } from "../api/endpoints";
import { ApiError, type BusinessSettingsPatch } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Empty, Modal, Notice, Spinner } from "../components/ui";
import { useBusinesses } from "../useBusinesses";
import { memberTerms } from "../terms";

// display-only icon (lucide trash-2), same svg pattern as other pages
const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const IconTrash = svg(<><path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const CLEANUP_PRESETS = [7, 14, 30, 90];

// Interval/idle presets in seconds, with the minute count for label interpolation.
const INTERVAL_PRESETS = [
  { minutes: 1, value: 60 },
  { minutes: 5, value: 300 },
  { minutes: 10, value: 600 },
  { minutes: 15, value: 900 },
];
const IDLE_PRESETS = [
  { minutes: 1, value: 60 },
  { minutes: 3, value: 180 },
  { minutes: 5, value: 300 },
];

// null = "Never" (keep forever).
const PRESETS: { days: number | null; value: number | null }[] = [
  { days: 7, value: 7 },
  { days: 14, value: 14 },
  { days: 30, value: 30 },
  { days: 90, value: 90 },
  { days: null, value: null },
];

export function Settings() {
  const { t } = useTranslation("settings");
  const { user } = useAuth();
  const { businesses, selected, selectedId, loading, reload } = useBusinesses();
  const terms = memberTerms(selected?.kind);

  const [retention, setRetention] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "success" | "danger"; text: string } | null>(null);

  // Manual "clean up now".
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cleanupDays, setCleanupDays] = useState(30);
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    if (selected) setRetention(selected.screenshot_retention_days);
  }, [selected]);

  async function runCleanup() {
    if (!selectedId) return;
    setCleaning(true);
    setMsg(null);
    try {
      const res = await cleanupScreenshots(selectedId, cleanupDays);
      setMsg({
        kind: "success",
        text: t("cleanup.removed", {
          count: res.deleted_count,
          size: formatBytes(res.bytes_freed),
        }),
      });
    } catch (err) {
      setMsg({
        kind: "danger",
        text: err instanceof ApiError ? err.message : t("cleanup.failed"),
      });
    } finally {
      setCleaning(false);
      setConfirmOpen(false);
    }
  }

  async function savePatch(patch: BusinessSettingsPatch, successText: string) {
    if (!selectedId) return;
    setSaving(true);
    setMsg(null);
    try {
      await updateBusinessSettings(selectedId, patch);
      await reload();
      setMsg({ kind: "success", text: successText });
    } catch (err) {
      setMsg({
        kind: "danger",
        text: err instanceof ApiError ? err.message : t("saveError"),
      });
    } finally {
      setSaving(false);
    }
  }

  function saveRetention(value: number | null) {
    setRetention(value);
    savePatch({ screenshot_retention_days: value }, t("retention.saved"));
  }

  return (
    <div className="ad-wrap" style={{ paddingBottom: 32 }}>
      <div className="ad-pagehead">
        <div className="ad-pagehead__main">
          <h1 className="ad-h1">{t("title")}</h1>
          {selected && (
            <p className="ad-sub">
              <Trans
                t={t}
                i18nKey="scope"
                values={{ name: selected.name, members: terms.many }}
                components={[<strong />]}
              />
            </p>
          )}
        </div>
      </div>

      {loading && <Spinner label={t("loading")} />}

      {!loading && businesses.length === 0 && <Empty>{t("noBusinesses")}</Empty>}

      {selected && (
        <>
          <div className="ad-set-sec">{t("sections.capture")}</div>
          <div className="set-group">
            <div className="set-row">
              <div>
                <div className="set-title">{t("capturePolicy.title")}</div>
                <div className="set-desc">{t("capturePolicy.desc", { members: terms.many })}</div>
              </div>
              <div
                className="segmented"
                role="group"
                aria-label={t("capturePolicy.ariaLabel", { member: terms.lowerOne })}
              >
                <button
                  className={!selected.allow_employee_override ? "active" : ""}
                  disabled={saving}
                  onClick={() => savePatch({ allow_employee_override: false }, t("capturePolicy.savedLocked", { members: terms.many }))}
                >
                  {t("capturePolicy.locked")}
                </button>
                <button
                  className={selected.allow_employee_override ? "active" : ""}
                  disabled={saving}
                  onClick={() => savePatch({ allow_employee_override: true }, t("capturePolicy.savedAllowed", { members: terms.many }))}
                >
                  {t("capturePolicy.allowOverride")}
                </button>
              </div>
            </div>

            <div className="set-row">
              <div>
                <div className="set-title">{t("screenshotInterval.title")}</div>
              </div>
              <div className="segmented" role="group" aria-label={t("screenshotInterval.ariaLabel")}>
                {INTERVAL_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    className={selected.screenshot_interval_s === p.value ? "active" : ""}
                    disabled={saving}
                    onClick={() => savePatch({ screenshot_interval_s: p.value }, t("screenshotInterval.saved"))}
                  >
                    {t("presets.min", { count: p.minutes })}
                  </button>
                ))}
              </div>
            </div>

            <div className="set-row">
              <div>
                <div className="set-title">{t("idleThreshold.title")}</div>
              </div>
              <div className="segmented" role="group" aria-label={t("idleThreshold.ariaLabel")}>
                {IDLE_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    className={selected.idle_threshold_s === p.value ? "active" : ""}
                    disabled={saving}
                    onClick={() => savePatch({ idle_threshold_s: p.value }, t("idleThreshold.saved"))}
                  >
                    {t("presets.min", { count: p.minutes })}
                  </button>
                ))}
              </div>
            </div>
            <div className="set-row">
              <div>
                <div className="set-title">{t("retention.title")}</div>
              </div>
              <div className="segmented" role="group" aria-label={t("retention.ariaLabel")}>
                {PRESETS.map((p) => (
                  <button
                    key={p.days ?? "never"}
                    className={retention === p.value ? "active" : ""}
                    disabled={saving}
                    onClick={() => saveRetention(p.value)}
                  >
                    {p.days === null ? t("presets.never") : t("presets.days", { count: p.days })}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="ad-set-sec">{t("sections.storage")}</div>
          <div className="set-group">
            <div className="set-row">
              <div>
                <div className="set-title">{t("cleanup.title")}</div>
                <div className="set-desc">{t("cleanup.desc", { name: selected.name })}</div>
              </div>
              <button className="bibo-btn bibo-btn--secondary bibo-btn--sm" disabled={cleaning} onClick={() => setConfirmOpen(true)}>
                <span style={{ display: "inline-flex", lineHeight: 0 }}>{IconTrash}</span>
                <span>{t("cleanup.button")}</span>
              </button>
            </div>
          </div>

          {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        </>
      )}

      {confirmOpen && selected && (
        <Modal title={t("cleanup.modalTitle")} onClose={() => setConfirmOpen(false)}>
          <p className="muted" style={{ marginTop: 0 }}>
            <Trans
              t={t}
              i18nKey="cleanup.olderThanIntro"
              values={{ name: selected.name }}
              components={[<strong />]}
            />
          </p>
          <div className="segmented" role="group" aria-label={t("cleanup.olderThanAriaLabel")} style={{ marginBottom: 16 }}>
            {CLEANUP_PRESETS.map((d) => (
              <button
                key={d}
                className={cleanupDays === d ? "active" : ""}
                onClick={() => setCleanupDays(d)}
              >
                {t("presets.days", { count: d })}
              </button>
            ))}
          </div>
          <p className="muted">{t("cleanup.warning", { days: cleanupDays })}</p>
          <div className="toolbar" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="bibo-btn bibo-btn--secondary" disabled={cleaning} onClick={() => setConfirmOpen(false)}>
              {t("cleanup.cancel")}
            </button>
            <button className="bibo-btn bibo-btn--primary" disabled={cleaning} onClick={runCleanup}>
              {cleaning ? t("cleanup.deleting") : t("cleanup.delete", { days: cleanupDays })}
            </button>
          </div>
        </Modal>
      )}

      <div className="ad-set-sec">{t("sections.account")}</div>
      <div className="set-group">
        <div className="set-row">
          <div className="set-title">{t("account.email")}</div>
          <div className="ad-readonly">{user?.email || user?.username}</div>
        </div>
        <div className="set-row">
          <div className="set-title">{t("account.displayName")}</div>
          <div className="ad-readonly">{user?.display_name || user?.username}</div>
        </div>
      </div>
    </div>
  );
}
