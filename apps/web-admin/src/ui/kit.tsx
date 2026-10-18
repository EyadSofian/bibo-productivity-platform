import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PresenceState } from "../api/types";
import { fmtDay, initials } from "../lib/format";
import { addDays, isoDate, isSameDay, parseIsoDate } from "../lib/day";
import { Icon, type IconName } from "./Icon";

/* ---------- avatar ---------- */

const AVATAR_HUES = [222, 25, 262, 172, 330, 199, 142, 48];

function hueFor(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}

export function Avatar({
  name,
  size = "md",
  status,
}: {
  name: string;
  size?: "sm" | "md" | "lg" | "xl";
  status?: PresenceState | null;
}) {
  return (
    <span
      className={`avatar${size === "md" ? "" : ` avatar-${size}`}`}
      style={{ "--h": hueFor(name) } as CSSProperties}
      aria-hidden
    >
      {initials(name)}
      {status ? <span className={`dot ${dotClass(status)}`} /> : null}
    </span>
  );
}

export function dotClass(state: PresenceState | null | undefined): string {
  switch (state) {
    case "active":
      return "dot-active";
    case "idle":
      return "dot-idle";
    case "online":
      return "dot-online";
    default:
      return "";
  }
}

/* ---------- presence ---------- */

export function PresenceBadge({ state }: { state: PresenceState | null | undefined }) {
  const { t } = useTranslation();
  const s = state ?? "offline";
  const tone = s === "active" ? "badge-ok" : s === "idle" ? "badge-warn" : s === "online" ? "badge-brand" : "";
  return (
    <span className={`badge ${tone}`}>
      <span className={`dot ${dotClass(s)}`} aria-hidden />
      {t(`presence.${s}`)}
    </span>
  );
}

/* ---------- card & KPI ---------- */

export function Card({
  title,
  sub,
  actions,
  children,
  className = "",
  id,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = useId();
  return (
    <section className={`glass card ${className}`} aria-labelledby={title ? headingId : undefined} id={id}>
      {title || actions ? (
        <header className="card-head">
          <div>
            {title ? (
              <h2 className="card-title" id={headingId}>
                {title}
              </h2>
            ) : null}
            {sub ? <p className="card-sub">{sub}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Kpi({
  icon,
  label,
  value,
  unit,
  foot,
  accent = false,
  loading = false,
}: {
  icon: IconName;
  label: string;
  value: ReactNode;
  unit?: string;
  foot?: ReactNode;
  accent?: boolean;
  loading?: boolean;
}) {
  return (
    <div className="glass kpi">
      <div className="kpi-head">
        <span>{label}</span>
        <span className={`kpi-icon${accent ? " is-accent" : ""}`}>
          <Icon name={icon} />
        </span>
      </div>
      {loading ? (
        <span className="skeleton" style={{ height: 34, width: "60%" }} />
      ) : (
        <div className="kpi-value">
          {value}
          {unit ? <small>{unit}</small> : null}
        </div>
      )}
      {foot ? <div className="kpi-foot">{foot}</div> : null}
    </div>
  );
}

/* ---------- states ---------- */

export function Empty({ icon = "sparkle", title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} />
      </span>
      <p className="empty-title">{title}</p>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  if (!error) return null;
  const status = typeof error === "object" && error && "status" in error ? (error as { status: number }).status : 0;
  const message =
    status === 403 ? t("errors.forbidden") : status === 0 ? t("errors.network") : t("errors.generic");
  return (
    <div className="alert alert-danger" role="alert">
      <Icon name="alert" />
      <span style={{ flex: 1 }}>{message}</span>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          {t("actions.retry")}
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ height = 16, width = "100%", radius }: { height?: number; width?: number | string; radius?: number }) {
  return <span className="skeleton" style={{ height, width, borderRadius: radius }} />;
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ display: "grid", gap: 12 }} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Skeleton height={34} width={34} radius={17} />
          <div style={{ flex: 1, display: "grid", gap: 6 }}>
            <Skeleton height={12} width={`${60 - i * 6}%`} />
            <Skeleton height={8} width={`${40 + i * 5}%`} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- dialog ---------- */

/**
 * A native modal <dialog>: focus trapping, Esc and the top layer come from the
 * browser. `closedby="any"` adds light dismiss where supported; the explicit
 * close button keeps it reachable everywhere else.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useTranslation();
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      style={wide ? { width: "min(720px, calc(100vw - 32px))" } : undefined}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={onClose}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      {open ? (
        <div className="dialog-body">
          <div className="dialog-head">
            <h2 className="dialog-title" id={titleId}>
              {title}
            </h2>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label={t("actions.close")}>
              <Icon name="x" />
            </button>
          </div>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}

/* ---------- controls ---------- */

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
      <span>{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  label,
}: {
  value: T;
  tabs: Array<{ value: T; label: string; icon?: IconName }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
        >
          {tab.icon ? <Icon name={tab.icon} /> : null}
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- day navigator ---------- */

export function DayNav({ value, onChange }: { value: Date; onChange: (d: Date) => void }) {
  const { t } = useTranslation();
  const today = new Date();
  const isToday = isSameDay(value, today);
  return (
    <div className="day-nav" role="group" aria-label={t("day.label")}>
      <button type="button" className="btn btn-icon" onClick={() => onChange(addDays(value, -1))} aria-label={t("day.previous")}>
        <Icon name="chevronLeft" className="flip-rtl" />
      </button>
      <span className="day-label">
        <Icon name="calendar" />
        <span>{isToday ? t("day.today") : fmtDay(value)}</span>
        <input
          type="date"
          aria-label={t("day.pick")}
          value={isoDate(value)}
          max={isoDate(today)}
          onChange={(e) => e.target.value && onChange(parseIsoDate(e.target.value))}
        />
      </span>
      <button
        type="button"
        className="btn btn-icon"
        onClick={() => onChange(addDays(value, 1))}
        disabled={isToday}
        aria-label={t("day.next")}
      >
        <Icon name="chevronRight" className="flip-rtl" />
      </button>
    </div>
  );
}

/* ---------- usage list (apps & sites) ---------- */

export type UsageItem = {
  key: string;
  name: string;
  seconds: number;
  /** Small caption after the name: "3 people", "chrome". */
  meta?: string;
  glyph?: IconName;
  /** Rows revealed when the item is expanded. */
  detail?: Array<{ key: string; primary: string; secondary?: string; value: string; href?: string | null }>;
};

export function UsageList({
  items,
  total,
  format,
  limit = 8,
  barColor,
  emptyTitle,
}: {
  items: UsageItem[];
  total: number;
  format: (seconds: number) => string;
  limit?: number;
  barColor?: string;
  emptyTitle: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  if (items.length === 0) return <Empty icon="app" title={emptyTitle} />;
  const max = Math.max(...items.map((i) => i.seconds), 1);
  const shown = all ? items : items.slice(0, limit);
  return (
    <>
      <ul className="usage-list">
        {shown.map((item) => {
          const share = total > 0 ? Math.round((item.seconds / total) * 100) : 0;
          const expandable = Boolean(item.detail && item.detail.length);
          const isOpen = open === item.key;
          const row = (
            <>
              <span className="usage-glyph" style={{ "--h": hueFor(item.name) } as CSSProperties}>
                {item.glyph ? <Icon name={item.glyph} /> : initials(item.name).slice(0, 1)}
              </span>
              <span className="usage-main">
                <span className="usage-name">
                  <span className="ltr-auto">{item.name}</span>
                  {item.meta ? <small>{item.meta}</small> : null}
                </span>
                <span className="usage-bar" aria-hidden>
                  <span style={{ width: `${(item.seconds / max) * 100}%`, ...(barColor ? { "--bar": barColor } : {}) } as CSSProperties} />
                </span>
              </span>
              <span className="usage-value">
                {format(item.seconds)}
                <small>{share}%</small>
              </span>
            </>
          );
          return (
            <li key={item.key}>
              {expandable ? (
                <button type="button" className="usage-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : item.key)}>
                  {row}
                </button>
              ) : (
                <div className="usage-row">{row}</div>
              )}
              {expandable && isOpen ? (
                <ul className="usage-detail">
                  {item.detail!.map((d) => (
                    <li key={d.key}>
                      <span className="truncate">
                        {d.href ? (
                          <a href={d.href} target="_blank" rel="noreferrer noopener">
                            {d.primary}
                          </a>
                        ) : (
                          d.primary
                        )}
                        {d.secondary ? <span className="url truncate">{d.secondary}</span> : null}
                      </span>
                      <span className="num muted">{d.value}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {items.length > limit ? (
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginBlockStart: 8 }} onClick={() => setAll(!all)}>
          {all ? t("actions.showLess") : t("actions.showAll", { count: items.length })}
        </button>
      ) : null}
    </>
  );
}
