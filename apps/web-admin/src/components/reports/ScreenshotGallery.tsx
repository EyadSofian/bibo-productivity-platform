import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { fetchImageObjectUrl } from "../../api/client";
import type { ScreenshotMeta } from "../../api/types";
import { fmtBytes, fmtTime } from "../../format";
import { Empty, Spinner } from "../ui";

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

const IconX = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);
const IconChevronLeft = (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 18-6-6 6-6" />
  </svg>
);
const IconChevronRight = (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="m9 18 6-6-6-6" />
  </svg>
);

// Fullscreen lightbox with prev/next/close. Rendered through a portal onto
// <body> so `position: fixed` centers in the VIEWPORT — inside the panel
// subtree an ancestor's transform/filter would re-anchor it to the card.
// The full-size image is fetched fresh per shot (its own auth blob).
function Lightbox({
  shots,
  index,
  onIndex,
  onClose,
}: {
  shots: ScreenshotMeta[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("reports");
  const meta = shots[index];
  const [url, setUrl] = useState<string | null>(null);
  const ref = useRef<string | null>(null);
  const hasPrev = index > 0;
  const hasNext = index < shots.length - 1;

  useEffect(() => {
    let alive = true;
    setUrl(null);
    fetchImageObjectUrl(meta.client_uuid)
      .then((u) => {
        if (ref.current) URL.revokeObjectURL(ref.current);
        ref.current = u;
        if (alive) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (ref.current) {
        URL.revokeObjectURL(ref.current);
        ref.current = null;
      }
    };
  }, [meta.client_uuid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && hasPrev) onIndex(index - 1);
      else if (e.key === "ArrowRight" && hasNext) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, hasPrev, hasNext, onIndex, onClose]);

  return createPortal(
    <div className="ad-lightbox" onClick={onClose}>
      <button type="button" className="ad-lightbox__btn ad-lightbox__close" aria-label={t("screenshots.close")} onClick={onClose}>
        {IconX}
      </button>
      {hasPrev && (
        <button
          type="button"
          className="ad-lightbox__btn ad-lightbox__nav ad-lightbox__nav--prev"
          aria-label={t("screenshots.prev")}
          onClick={(e) => {
            e.stopPropagation();
            onIndex(index - 1);
          }}
        >
          {IconChevronLeft}
        </button>
      )}
      {hasNext && (
        <button
          type="button"
          className="ad-lightbox__btn ad-lightbox__nav ad-lightbox__nav--next"
          aria-label={t("screenshots.next")}
          onClick={(e) => {
            e.stopPropagation();
            onIndex(index + 1);
          }}
        >
          {IconChevronRight}
        </button>
      )}
      <figure className="ad-lightbox__body" onClick={(e) => e.stopPropagation()}>
        {url ? (
          <img
            className="ad-lightbox__img"
            src={url}
            alt={t("screenshots.alt", { time: fmtTime(meta.ts) })}
          />
        ) : (
          <Spinner label={t("screenshots.loading")} />
        )}
        <figcaption className="ad-lightbox__caption num">
          {index + 1} / {shots.length} · {fmtTime(meta.ts)} · {meta.width}×{meta.height} ·{" "}
          {t("screenshots.display", { id: meta.display_id })} · {fmtBytes(meta.byte_size)}
        </figcaption>
      </figure>
    </div>,
    document.body,
  );
}

export function ScreenshotGallery({ shots }: { shots: ScreenshotMeta[] }) {
  const { t } = useTranslation("reports");
  const [active, setActive] = useState<number | null>(null);

  if (shots.length === 0) return <Empty>{t("screenshots.empty")}</Empty>;

  return (
    <>
      <div className="ad-panelhead">
        <div className="ad-paneltitle">{t("screenshots.title")}</div>
      </div>
      <div className="ad-gallery">
        {shots.map((s, i) => (
          <Shot key={s.client_uuid} meta={s as ShotMeta} onOpen={() => setActive(i)} />
        ))}
      </div>
      {active != null && (
        <Lightbox shots={shots} index={active} onIndex={setActive} onClose={() => setActive(null)} />
      )}
    </>
  );
}
