import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserVisit } from "../../api/types";
import { fmtDuration } from "../../format";
import { Empty } from "../ui";
import { rollupByDomain, rollupByPage } from "./rollup";

const EXTENSION_URL = "https://chromewebstore.google.com/detail/bibo-tracker/meoifmgllkafmaeckbdambfnoolnilme";

// Hour:minute only (local) for the Time column.
const hhmm = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// Stable colour per domain (rank-free, hashed) — display only.
const DOMAIN_COLORS = [
  "var(--data-rose)",
  "var(--data-amber)",
  "var(--data-teal)",
  "var(--data-mint)",
  "var(--data-sky)",
  "var(--data-lavender)",
];
function colorForDomain(d: string): string {
  let h = 0;
  for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) >>> 0;
  return DOMAIN_COLORS[h % DOMAIN_COLORS.length];
}

export function BrowserPanel({ visits }: { visits: BrowserVisit[] }) {
  const { t } = useTranslation("reports");
  const [expanded, setExpanded] = useState<string | null>(null);

  // One row per site, not per visit. The extension checkpoints an open tab every
  // 60 seconds, so an hour on one page arrives as ~60 rows — listing them raw
  // buries the answer instead of showing it.
  const rows = rollupByDomain(visits);
  if (rows.length === 0) {
    return (
      <div className="ad-browser-empty">
        <Empty>{t("browser.empty")}</Empty>
        <p>{t("browser.extensionRequired")}</p>
        <a
          className="bibo-btn bibo-btn--primary bibo-btn--sm"
          href={EXTENSION_URL}
          target="_blank"
          rel="noreferrer"
        >
          {t("browser.installExtension")}
        </a>
      </div>
    );
  }

  return (
    <div className="bibo-card bibo-card--default ad-tablecard">
      <div className="ad-panelhead" style={{ padding: "24px 20px 4px" }}>
        <div>
          <div className="ad-paneltitle">{t("browser.title")}</div>
          <div className="ad-browser-hint">{t("browser.expandHint")}</div>
        </div>
      </div>
      <table className="ad-table">
        <thead>
          <tr>
            <th>{t("browser.table.domain")}</th>
            <th>{t("browser.table.time")}</th>
            <th className="r">{t("browser.table.visits")}</th>
            <th className="r">{t("browser.table.duration")}</th>
            <th>{t("browser.table.browser")}</th>
            <th aria-label={t("browser.details")} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const open = expanded === r.domain;
            const pages = open ? rollupByPage(visits, r.domain) : [];
            return (
              <Fragment key={r.domain}>
                <tr
                  className={open ? "ad-browser-domain ad-browser-domain--open" : "ad-browser-domain"}
                >
                  <td>
                    <div className="ad-name">
                      <span
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 6,
                          background: colorForDomain(r.domain),
                          color: "#fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 10,
                          fontWeight: 800,
                          flex: "none",
                        }}
                      >
                        {r.domain.charAt(0).toUpperCase()}
                      </span>
                      <span className="ad-name__txt" title={r.title || r.domain}>
                        {r.domain}
                      </span>
                    </div>
                  </td>
                  <td className="ad-relt">{hhmm(r.firstTs)}</td>
                  <td className="r ad-dur">{r.visits}</td>
                  <td className="r ad-dur">{fmtDuration(r.totalS)}</td>
                  <td className="ad-muted" style={{ fontWeight: 600 }}>
                    {r.browsers.join(", ")}
                  </td>
                  <td className="r">
                    <button
                      type="button"
                      className="ad-browser-toggle"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : r.domain)}
                    >
                      {open ? t("browser.hideDetails") : t("browser.details")}
                      <span aria-hidden>{open ? "↑" : "↓"}</span>
                    </button>
                  </td>
                </tr>
                {open ? (
                  <tr className="ad-browser-detailrow">
                    <td colSpan={6}>
                      <div className="ad-browser-drilldown">
                        <div className="ad-browser-drilldown__head">
                          <strong>{t("browser.pagesOn", { domain: r.domain })}</strong>
                          <span>{t("browser.fullUrlNotice")}</span>
                        </div>
                        <div className="ad-browser-pages">
                          {pages.map((page) => (
                            <article className="ad-browser-page" key={page.url}>
                              <div className="ad-browser-page__main">
                                <strong>{page.title || t("browser.untitled")}</strong>
                                <code dir="ltr" title={page.url}>
                                  {page.url}
                                </code>
                              </div>
                              <div className="ad-browser-page__metric">
                                <span>{t("browser.table.time")}</span>
                                <strong>{hhmm(page.firstTs)}</strong>
                              </div>
                              <div className="ad-browser-page__metric">
                                <span>{t("browser.table.duration")}</span>
                                <strong>{fmtDuration(page.totalS)}</strong>
                              </div>
                            </article>
                          ))}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
