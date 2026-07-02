import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LOCALES } from "../i18n";

/**
 * LanguageSwitcher — a flag dropdown for the active locale (matches the marketing
 * site). The trigger shows the current flag + native name; the menu lists every
 * locale with its flag. The choice is persisted to localStorage by i18next's
 * detector (key: "locale"). Opens on click; closes on outside click / Escape.
 *
 * `align`/`drop` control where the menu opens so it never clips its container
 * (e.g. the dashboard sidebar opens it upward/left; the auth surface downward/right).
 */
export function LanguageSwitcher({
  className,
  align = "right",
  drop = "down",
}: {
  className?: string;
  align?: "left" | "right";
  drop?: "up" | "down";
}) {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const code = LOCALES.find((l) => l.code === i18n.resolvedLanguage)?.code ?? "en";

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(c: string) {
    i18n.changeLanguage(c);
    setOpen(false);
  }

  return (
    <div className={`lang-switcher ${className ?? ""}`} ref={ref}>
      <button
        type="button"
        className="lang-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("language")}
        title={t("language")}
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          className="lang-globe"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
          <path d="M2 12h20" />
        </svg>
        <span className="lang-label">{code.toUpperCase()}</span>
        <svg
          className="lang-caret"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className={`lang-menu ${drop} ${align}`} role="listbox">
          {LOCALES.map((l) => (
            <button
              type="button"
              key={l.code}
              role="option"
              aria-selected={l.code === code}
              className={`lang-opt${l.code === code ? " active" : ""}`}
              onClick={() => pick(l.code)}
            >
              <span className="lang-flag" aria-hidden>
                {l.flag}
              </span>
              {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
