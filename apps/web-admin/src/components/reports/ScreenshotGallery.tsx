import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchImageObjectUrl } from "../../api/client";
import type { ScreenshotMeta } from "../../api/types";
import { fmtBytes, fmtTime } from "../../format";
import { Empty, Modal, Spinner } from "../ui";

// A screenshot may carry the active app (demo/enriched data) for the badge.
type ShotMeta = ScreenshotMeta & { app?: string };

// Per-app placeholder gradient shown until the real thumbnail loads (or if the
// image is unavailable). Colours mirror the offline design.
const APP_GRADIENTS: Record<string, [string, string]> = {
  "VS Code": ["#6c5ce7", "#3a2f87"],
  Chrome: ["#38bdf8", "#1f6f9c"],
  Figma: ["#34d399", "#0f7a5a"],
  Terminal: ["#2dd4bf", "#136b60"],
  Notion: ["#f472b6", "#9c3a6e"],
  Slack: ["#fbbf24", "#9c7414"],
  Zoom: ["#56ccf2", "#2f6f9c"],
  Spotify: ["#34d399", "#0f7a5a"],
};
const gradientFor = (app?: string) => {
  const [a, b] = (app && APP_GRADIENTS[app]) || APP_GRADIENTS["VS Code"];
  return `linear-gradient(135deg, ${a}, ${b})`;
};

const hhmmss = (ts: number) => {
  const d = new Date(ts * 1000);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
};

// One gallery card: real thumbnail when it loads, gradient placeholder before.
function Shot({ meta, onOpen }: { meta: ShotMeta; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    fetchImageObjectUrl(meta.client_uuid)
      .then((u) => {
        made = u;
        if (alive) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [meta.client_uuid]);

  return (
    <div className={`ad-shot${url ? " ad-shot--clickable" : ""}`} onClick={url ? onOpen : undefined}>
      <div
        className="ad-shot__img"
        style={url ? { backgroundImage: `url("${url}")` } : { background: gradientFor(meta.app) }}
      />
      <div className="ad-shot__veil" />
      {meta.app && <span className="ad-shot__app">{meta.app}</span>}
      <span className="ad-shot__t">{hhmmss(meta.ts)}</span>
    </div>
  );
}

// Full-size image in the lightbox is fetched fresh (its own auth blob).
function Lightbox({ meta, onClose }: { meta: ScreenshotMeta; onClose: () => void }) {
  const { t } = useTranslation("reports");
  const [url, setUrl] = useState<string | null>(null);
  const ref = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchImageObjectUrl(meta.client_uuid)
      .then((u) => {
        ref.current = u;
        if (alive) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (ref.current) URL.revokeObjectURL(ref.current);
    };
  }, [meta.client_uuid]);

  return (
    <Modal onClose={onClose} wide>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
        {url ? (
          <img
            className="lightbox-img"
            src={url}
            alt={t("screenshots.alt", { time: fmtTime(meta.ts) })}
          />
        ) : (
          <Spinner label={t("screenshots.loading")} />
        )}
        <div className="caption num">
          {fmtTime(meta.ts)} · {meta.width}×{meta.height} ·{" "}
          {t("screenshots.display", { id: meta.display_id })} · {fmtBytes(meta.byte_size)}
        </div>
      </div>
    </Modal>
  );
}

export function ScreenshotGallery({ shots }: { shots: ScreenshotMeta[] }) {
  const { t } = useTranslation("reports");
  const [active, setActive] = useState<ScreenshotMeta | null>(null);

  if (shots.length === 0) return <Empty>{t("screenshots.empty")}</Empty>;

  return (
    <>
      <div className="ad-panelhead">
        <div className="ad-paneltitle">{t("screenshots.title")}</div>
      </div>
      <div className="ad-gallery">
        {shots.map((s) => (
          <Shot key={s.client_uuid} meta={s as ShotMeta} onOpen={() => setActive(s)} />
        ))}
      </div>
      {active && <Lightbox meta={active} onClose={() => setActive(null)} />}
    </>
  );
}
