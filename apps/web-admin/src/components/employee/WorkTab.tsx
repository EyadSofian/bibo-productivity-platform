import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RecordingAsset } from "../../api/media";
import type { ActivityResponse, BrowserVisit } from "../../api/types";
import { fmtDuration } from "../../format";
import { firstRecordedMoment, safeHref, workItems, type WorkItem } from "./dayModel";

type Filter = "all" | "app" | "site";

const hm = (ts: number, lang: string) =>
  new Date(ts * 1000).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });

/**
 * Tab 1 -- what the employee worked in. One list of apps and websites; a click
 * plays that item's first recorded stretch on the screen above and opens its
 * stretches, so "what did they do in Claude?" is one click away.
 */
export function WorkTab({
  activity,
  visits,
  recordings,
  selectedKey,
  onPlay,
}: {
  activity: ActivityResponse;
  visits: BrowserVisit[];
  recordings: RecordingAsset[];
  selectedKey: string | null;
  onPlay: (ts: number, item: WorkItem) => void;
}) {
  const { t, i18n } = useTranslation("reports");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(selectedKey);

  const items = useMemo(() => workItems(activity, visits), [activity, visits]);
  const needle = query.trim().toLocaleLowerCase(i18n.language);
  const shown = items.filter(
    (item) =>
      (filter === "all" || item.kind === filter) &&
      (!needle ||
        item.name.toLocaleLowerCase(i18n.language).includes(needle) ||
        item.pages.some((p) => `${p.title} ${p.url}`.toLocaleLowerCase(i18n.language).includes(needle))),
  );
  const max = Math.max(1, ...items.map((i) => i.totalS));
  const counts = { all: items.length, app: items.filter((i) => i.kind === "app").length, site: items.filter((i) => i.kind === "site").length };

  if (items.length === 0) {
    return <div className="ev-empty">{t("employee.work.empty")}</div>;
  }

  const choose = (item: WorkItem) => {
    setOpen((current) => (current === item.key ? null : item.key));
    const moment = item.segments.map((s) => firstRecordedMoment(s, recordings)).find((m) => m !== null);
    onPlay(moment ?? item.segments[0]?.ts ?? 0, item);
  };

  return (
    <div className="ev-work">
      <div className="ev-toolbar">
        <div className="ev-seg" role="group" aria-label={t("employee.work.filter")}>
          {(["all", "app", "site"] as const).map((key) => (
            <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {t(`employee.work.filter_${key}`)} <small>{counts[key]}</small>
            </button>
          ))}
        </div>
        <input
          className="ev-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("employee.work.search")}
          aria-label={t("employee.work.search")}
        />
      </div>
      <p className="ev-hint">{t("employee.work.hint")}</p>

      <ul className="ev-items">
        {shown.map((item) => {
          const expanded = open === item.key;
          const recordedCount = item.segments.filter((s) => firstRecordedMoment(s, recordings) !== null).length;
          return (
            <li key={item.key} className={`ev-item${expanded ? " is-open" : ""}${selectedKey === item.key ? " is-playing" : ""}`}>
              <button type="button" className="ev-item__main" onClick={() => choose(item)} aria-expanded={expanded}>
                <span className={`ev-item__icon ev-item__icon--${item.kind}`} aria-hidden>{item.kind === "app" ? "▢" : "◎"}</span>
                <span className="ev-item__text">
                  <strong title={item.name}>{item.name}</strong>
                  <small>
                    {t(item.kind === "app" ? "employee.work.app" : "employee.work.site")}
                    {" · "}
                    {t("employee.work.times", { count: item.segments.length })}
                    {recordedCount === 0 ? ` · ${t("employee.work.noVideoShort")}` : ""}
                  </small>
                </span>
                <span className="ev-item__bar" aria-hidden><i style={{ width: `${(item.totalS / max) * 100}%` }} /></span>
                <span className="ev-item__time"><bdi dir="ltr">{fmtDuration(item.totalS)}</bdi></span>
                <span className="ev-item__play" aria-hidden data-label={t("employee.work.watch")}>▶</span>
              </button>

              {expanded ? (
                <div className="ev-item__detail">
                  <div className="ev-chips" role="group" aria-label={t("employee.work.stretches", { name: item.name })}>
                    {item.segments.map((segment) => {
                      const moment = firstRecordedMoment(segment, recordings);
                      return (
                        <button
                          type="button"
                          key={segment.ts}
                          className="ev-chip"
                          disabled={moment === null}
                          title={moment === null ? t("employee.work.noVideo") : t("employee.work.watchAt", { time: hm(segment.ts, i18n.language) })}
                          onClick={() => moment !== null && onPlay(moment, item)}
                        >
                          <bdi>{hm(segment.ts, i18n.language)}</bdi>
                          <small><bdi dir="ltr">{fmtDuration(segment.dur)}</bdi></small>
                        </button>
                      );
                    })}
                  </div>
                  {item.pages.length > 0 ? (
                    <ul className="ev-pages">
                      {item.pages.slice(0, 8).map((page) => {
                        const href = safeHref(page.url);
                        return (
                          <li key={page.url}>
                            <span className="ev-pages__title" title={page.title || page.url}>{page.title || page.url}</span>
                            <span className="ev-pages__url" dir="ltr" title={page.url}>{page.url}</span>
                            <span className="ev-pages__time"><bdi dir="ltr">{fmtDuration(page.totalS)}</bdi></span>
                            {href ? (
                              <a href={href} target="_blank" rel="noopener noreferrer" className="ev-link">
                                {t("employee.work.openLink")} ↗
                              </a>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {shown.length === 0 ? <div className="ev-empty">{t("employee.work.noMatches")}</div> : null}
    </div>
  );
}
