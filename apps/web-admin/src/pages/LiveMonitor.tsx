import { lazy, Suspense, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { reportEmployees } from "../api/endpoints";
import type { ReportEmployee } from "../api/types";
import { usePageHeader } from "../app/AppShell";
import { useBusinesses } from "../app/useBusinesses";
import { localDayWindow } from "../lib/day";
import { fmtDuration, fmtRelative } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { Icon } from "../ui/Icon";
import { Avatar, Card, Empty, ErrorNote, LoadingRows, PresenceBadge, Segmented } from "../ui/kit";
import { sortByPresence } from "./Overview";

// The player and its WebRTC client load only when someone is actually watched.
const DeviceLiveVideo = lazy(() => import("../components/LivePlayer/DeviceLiveVideo"));

type Filter = "online" | "all";

/**
 * Live monitor: who is at their device right now, and their screen on demand.
 * One stream at a time — switching people unmounts the previous player, which
 * releases its viewer lease so the device stops publishing when nobody watches.
 */
export default function LiveMonitor() {
  const { t } = useTranslation("app");
  const { selectedId } = useBusinesses();
  const [filter, setFilter] = useState<Filter>("online");
  const [watching, setWatching] = useState<ReportEmployee | null>(null);

  usePageHeader(t("live.title"), t("live.subtitle"));

  const roster = useAsync(
    () => (selectedId ? reportEmployees(selectedId, localDayWindow()) : Promise.resolve({ employees: [] })),
    [selectedId],
    15_000,
  );

  const people = useMemo(() => sortByPresence(roster.data?.employees ?? []), [roster.data]);
  const online = people.filter((p) => p.presence_state !== "offline");
  const shown = filter === "online" ? online : people;
  // Keep the stage's presence in step with the latest poll.
  const stage = watching ? people.find((p) => p.id === watching.id) ?? watching : null;

  return (
    <div className="page">
      {stage && stage.device_id ? (
        <section className="glass card live-stage" aria-label={t("live.stage")}>
          <div className="card-head">
            <div className="person">
              <Avatar name={stage.display_name} status={stage.presence_state} size="lg" />
              <span className="person-text">
                <span className="person-name" style={{ fontSize: "var(--fs-lg)" }}>{stage.display_name}</span>
                <span className="person-sub ltr-auto">{stage.current_app ?? t("overview.noApp")}</span>
              </span>
            </div>
            <div className="card-actions">
              <Link to={`/employees/${stage.id}`} className="btn btn-sm">
                {t("live.openDay")}
              </Link>
              <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => setWatching(null)} aria-label={t("live.close")}>
                <Icon name="x" />
              </button>
            </div>
          </div>
          <Suspense fallback={<span className="spinner" />}>
            <DeviceLiveVideo key={stage.device_id} deviceId={stage.device_id} online={stage.presence_state !== "offline"} autoStart />
          </Suspense>
        </section>
      ) : null}

      <Card
        title={t("live.peopleTitle")}
        sub={t("live.peopleSub", { online: online.length, total: people.length })}
        actions={
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            label={t("live.filter")}
            options={[
              { value: "online", label: t("live.onlineOnly") },
              { value: "all", label: t("live.everyone") },
            ]}
          />
        }
      >
        <ErrorNote error={roster.error} onRetry={roster.reload} />
        {roster.loading && !roster.data ? (
          <LoadingRows rows={4} />
        ) : shown.length === 0 ? (
          <Empty icon="wifiOff" title={t("live.nobody")}>
            {t("live.nobodyHint")}
          </Empty>
        ) : (
          <div className="live-grid">
            {shown.map((p) => {
              const canWatch = p.presence_state !== "offline" && Boolean(p.device_id);
              const isOn = stage?.id === p.id;
              return (
                <article key={p.id} className={`live-card${isOn ? " is-on" : ""}${canWatch ? "" : " is-off"}`}>
                  <div className="live-card-top">
                    <Avatar name={p.display_name} status={p.presence_state} />
                    <span className="person-text">
                      <Link to={`/employees/${p.id}`} className="person-name">
                        {p.display_name}
                      </Link>
                      <span className="person-sub">
                        {canWatch ? t("live.workedToday", { time: fmtDuration(p.active_today_s) }) : fmtRelative(p.last_seen)}
                      </span>
                    </span>
                  </div>
                  <PresenceBadge state={p.presence_state} />
                  <div className="live-card-app">
                    <Icon name="app" />
                    <span className="truncate ltr-auto">
                      {p.current_window_title || p.current_app || t("live.noWindow")}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={`btn btn-sm btn-block${isOn ? "" : " btn-primary"}`}
                    disabled={!canWatch}
                    onClick={() => {
                      setWatching(isOn ? null : p);
                      if (!isOn) window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                  >
                    <Icon name={isOn ? "stop" : "live"} />
                    {isOn ? t("live.stopWatching") : canWatch ? t("live.watch") : t("live.offline")}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
