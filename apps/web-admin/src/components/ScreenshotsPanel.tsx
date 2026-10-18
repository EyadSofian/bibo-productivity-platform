import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { reportScreenshots } from "../api/endpoints";
import { fetchImageObjectUrl } from "../api/client";
import type { ScreenshotMeta } from "../api/types";
import { fmtClock } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { Dialog, Empty, ErrorNote, LoadingRows } from "../ui/kit";
import { Icon } from "../ui/Icon";

const PAGE_SIZE = 24;

/** Stored stills are a temporary, low-bandwidth history while video egress is paused. */
export function ScreenshotsPanel({ employeeId, from, to, today }: {
  employeeId: string; from: number; to: number; today: boolean;
}) {
  const { t } = useTranslation("app");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ScreenshotMeta | null>(null);
  const shots = useAsync(
    () => reportScreenshots(employeeId, from, to, PAGE_SIZE, page * PAGE_SIZE),
    [employeeId, from, to, page],
    today ? 60_000 : undefined,
  );
  const items = shots.data?.screenshots ?? [];

  return (
    <div className="shots-panel">
      <div className="shots-heading">
        <p className="muted">{t("screenshots.hint")}</p>
        <button type="button" className="btn btn-sm" onClick={shots.reload}>
          <Icon name="restore" /> {t("screenshots.refresh")}
        </button>
      </div>
      <ErrorNote error={shots.error} onRetry={shots.reload} />
      {shots.loading && !shots.data ? <LoadingRows rows={3} /> : items.length === 0 && page === 0 ? (
        <Empty icon="monitor" title={t("screenshots.none")}>{t("screenshots.noneHint")}</Empty>
      ) : (
        <>
          <div className="shots-grid">
            {items.map((shot) => (
              <button className="shot-card" type="button" key={shot.client_uuid} onClick={() => setSelected(shot)}>
                <ShotImage id={shot.client_uuid} alt={t("screenshots.at", { time: fmtClock(shot.ts) })} />
                <span className="shot-caption">{fmtClock(shot.ts)}</span>
              </button>
            ))}
          </div>
          <div className="shots-pager">
            <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>{t("screenshots.previous")}</button>
            <span className="muted">{t("screenshots.page", { count: page + 1 })}</span>
            <button type="button" className="btn btn-sm" disabled={items.length < PAGE_SIZE} onClick={() => setPage((n) => n + 1)}>{t("screenshots.next")}</button>
          </div>
        </>
      )}
      <Dialog open={selected !== null} onClose={() => setSelected(null)} title={selected ? t("screenshots.at", { time: fmtClock(selected.ts) }) : ""} wide>
        {selected ? <ShotImage id={selected.client_uuid} alt={t("screenshots.at", { time: fmtClock(selected.ts) })} full /> : null}
      </Dialog>
    </div>
  );
}

function ShotImage({ id, alt, full = false }: { id: string; alt: string; full?: boolean }) {
  const { t } = useTranslation("app");
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    fetchImageObjectUrl(id).then((value) => {
      if (disposed) URL.revokeObjectURL(value);
      else { objectUrl = value; setUrl(value); }
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);
  if (failed) return <span className="shot-placeholder">{t("screenshots.unavailable")}</span>;
  if (!url) return <span className="shot-placeholder"><span className="spinner" /></span>;
  return <img className={full ? "shot-image shot-image-full" : "shot-image"} src={url} alt={alt} />;
}
