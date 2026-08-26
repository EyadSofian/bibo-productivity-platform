import { useTranslation } from "react-i18next";
import type { BrowserVisit } from "../../api/types";
import { fmtDuration } from "../../format";
import { Empty } from "../ui";
import { rollupByDomain } from "./rollup";

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

  // One row per site, not per visit. The extension checkpoints an open tab every
  // 60 seconds, so an hour on one page arrives as ~60 rows — listing them raw
  // buries the answer instead of showing it.
  const rows = rollupByDomain(visits);
  if (rows.length === 0) return <Empty>{t("browser.empty")}</Empty>;

  return (
    <div className="bibo-card bibo-card--default ad-tablecard">
      <div className="ad-panelhead" style={{ padding: "24px 20px 4px" }}>
        <div className="ad-paneltitle">{t("browser.title")}</div>
      </div>
      <table className="ad-table">
        <thead>
          <tr>
            <th>{t("browser.table.domain")}</th>
            <th>{t("browser.table.time")}</th>
            <th className="r">{t("browser.table.visits")}</th>
            <th className="r">{t("browser.table.duration")}</th>
            <th>{t("browser.table.browser")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.domain}>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
