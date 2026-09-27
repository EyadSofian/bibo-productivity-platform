import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityResponse, BrowserVisit } from "../../api/types";
import { fmtDuration } from "../../format";
import { Empty } from "../ui";
import { rollupAllPages } from "./rollup";

const EXTENSION_URL = "https://chromewebstore.google.com/detail/bibo-tracker/meoifmgllkafmaeckbdambfnoolnilme";

function webHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function ActivityExplorer({
  activity,
  visits,
  onPlay,
}: {
  activity: ActivityResponse;
  visits: BrowserVisit[];
  onPlay: (ts: number, app: string | null, url?: string) => void;
}) {
  const { t, i18n } = useTranslation("reports");
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase(i18n.language);
  const apps = useMemo(() => [...activity.breakdown].sort((a, b) => b.duration_s - a.duration_s), [activity.breakdown]);
  const pages = useMemo(() => rollupAllPages(visits), [visits]);
  const filteredApps = apps.filter((app) => app.app_name.toLocaleLowerCase(i18n.language).includes(normalized));
  const filteredPages = pages.filter((page) =>
    `${page.title ?? ""} ${page.domain} ${page.url}`.toLocaleLowerCase(i18n.language).includes(normalized),
  );
  const firstAppMoment = (app: string) => activity.samples
    .filter((sample) => sample.app_name === app && sample.duration_s > 0)
    .reduce<number | null>((first, sample) => first === null ? sample.ts : Math.min(first, sample.ts), null);
  const time = (ts: number) => new Date(ts * 1000).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="ad-explorer">
      <div className="ad-explorer__head">
        <div>
          <h2>{t("explorer.title")}</h2>
          <p>{t("explorer.description")}</p>
        </div>
        <label className="ad-explorer__search">
          <input type="search" aria-label={t("explorer.search")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("explorer.search")} />
        </label>
      </div>

      <section className="ad-explorer__section" aria-labelledby="employee-apps-title">
        <header><h3 id="employee-apps-title">{t("explorer.apps")}</h3><span>{apps.length}</span></header>
        {filteredApps.length ? filteredApps.map((app) => {
          const moment = firstAppMoment(app.app_name);
          return (
            <div className="ad-explorer__row" key={app.app_name}>
              <span className="ad-explorer__glyph" aria-hidden="true">▣</span>
              <div className="ad-explorer__name"><strong title={app.app_name}>{app.app_name}</strong><small>{t("explorer.appTime")}</small></div>
              <strong className="ad-explorer__duration">{fmtDuration(app.duration_s)}</strong>
              <button type="button" disabled={moment === null} onClick={() => moment !== null && onPlay(moment, app.app_name)}>{t("explorer.watch")}</button>
            </div>
          );
        }) : <Empty>{query ? t("explorer.noMatches") : t("activity.empty")}</Empty>}
      </section>

      <section className="ad-explorer__section" aria-labelledby="employee-pages-title">
        <header><h3 id="employee-pages-title">{t("explorer.pages")}</h3><span>{pages.length}</span></header>
        {filteredPages.length ? filteredPages.map((page) => (
          <div className="ad-explorer__row ad-explorer__row--page" key={page.url}>
            <span className="ad-explorer__glyph ad-explorer__glyph--page" aria-hidden="true">↗</span>
            <div className="ad-explorer__name">
              <strong title={page.title ?? page.domain}>{page.title || page.domain}</strong>
              <span className="ad-explorer__url" dir="ltr" title={page.url}>{page.url}</span>
              <small>{page.domain} · {time(page.firstTs)} · {page.browsers.join(", ")}</small>
            </div>
            <strong className="ad-explorer__duration">{fmtDuration(page.totalS)}</strong>
            <div className="ad-explorer__actions">
              <button type="button" onClick={() => onPlay(page.firstTs, null, page.url)}>{t("explorer.watch")}</button>
              {webHref(page.url) ? <a href={webHref(page.url)!} target="_blank" rel="noopener noreferrer" aria-label={t("explorer.open", { page: page.title || page.domain })}>↗</a> : null}
            </div>
          </div>
        )) : (
          <div className="ad-explorer__empty">
            <Empty>{query ? t("explorer.noMatches") : t("browser.empty")}</Empty>
            {!query && <><p>{t("browser.extensionRequired")}</p><a href={EXTENSION_URL} target="_blank" rel="noopener noreferrer">{t("browser.installExtension")}</a></>}
          </div>
        )}
      </section>
    </div>
  );
}
