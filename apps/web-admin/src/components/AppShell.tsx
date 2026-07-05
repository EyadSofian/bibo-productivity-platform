import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthContext";
import { useTheme, type ThemeMode } from "../theme/ThemeProvider";
import { useBusinesses } from "../useBusinesses";
import { memberTerms } from "../terms";
import { LanguageSwitcher } from "./LanguageSwitcher";

/** Brand mark — violet gradient tile with the pulse glyph (matches the auth logo). */
function RailLogo() {
  return (
    <span className="ad-rail__logo" aria-label="BiBoTracking">
      <svg viewBox="0 0 48 48" role="img" aria-label="BiBoTracking">
        <defs>
          <linearGradient id="biboRailGrad" x1="6" y1="4" x2="42" y2="46" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#a99df8" />
            <stop offset="1" stopColor="#6c5ce7" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="48" height="48" rx="17" fill="url(#biboRailGrad)" />
        <path
          d="M12 24h6l3 8 6-16 3 8h6"
          fill="none"
          stroke="#fff"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** Shared lucide-style icon frame (24×24, stroke = currentColor). */
function RailIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const DashboardIcon = () => (
  <RailIcon>
    <rect width="7" height="9" x="3" y="3" rx="1" />
    <rect width="7" height="5" x="14" y="3" rx="1" />
    <rect width="7" height="9" x="14" y="12" rx="1" />
    <rect width="7" height="5" x="3" y="16" rx="1" />
  </RailIcon>
);

const MembersIcon = () => (
  <RailIcon>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <path d="M16 3.128a4 4 0 0 1 0 7.744" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <circle cx="9" cy="7" r="4" />
  </RailIcon>
);

const SettingsIcon = () => (
  <RailIcon>
    <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
    <circle cx="12" cy="12" r="3" />
  </RailIcon>
);

const ChevronsUpDownIcon = () => (
  <RailIcon>
    <path d="m7 15 5 5 5-5" />
    <path d="m7 9 5-5 5 5" />
  </RailIcon>
);

const CheckIcon = () => (
  <RailIcon>
    <path d="M20 6 9 17l-5-5" />
  </RailIcon>
);

const PlusIcon = () => (
  <RailIcon>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </RailIcon>
);

const LogOutIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
  </svg>
);

/** Two-letter monogram from a name (falls back to the first two chars). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Closes `open` on outside-click / Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

/** Topbar business switcher — a pill showing the current business name. Clicking opens
 *  a menu listing every business (✓ on the active one) plus a "new business" action.
 *  Backed by the shared business context. */
function BizPicker() {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const { businesses, selected, selectedId, setSelectedId } = useBusinesses();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  if (!selected) return null;

  return (
    <div className="ad-bizpick" ref={ref}>
      <button
        type="button"
        className="ad-bizpick__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ad-bizpick__ic">{initials(selected.name)}</span>
        <span className="ad-bizpick__name">{selected.name}</span>
        <ChevronsUpDownIcon />
      </button>
      {open && (
        <div className="ad-menu ad-menu--left" role="menu">
          {businesses.map((b) => (
            <button
              key={b.id}
              type="button"
              role="menuitemradio"
              aria-checked={b.id === selectedId}
              className={`ad-menu__opt${b.id === selectedId ? " on" : ""}`}
              onClick={() => {
                setSelectedId(b.id);
                setOpen(false);
              }}
            >
              <span className="ad-bizpick__ic">{initials(b.name)}</span>
              <span className="ad-menu__label">{b.name}</span>
              {b.id === selectedId && <CheckIcon />}
            </button>
          ))}
          <div className="ad-menu__sep" />
          <button
            type="button"
            role="menuitem"
            className="ad-menu__opt ad-menu__action"
            onClick={() => {
              setOpen(false);
              navigate("/employees?new=1");
            }}
          >
            <span className="ad-menu__plus">
              <PlusIcon />
            </span>
            <span className="ad-menu__label">{t("dashboard.newTeam")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Topbar account button — avatar that opens a small menu with sign out. */
function AccountMenu() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const displayName = user?.display_name ?? user?.email ?? "";
  const email = user?.email ?? user?.username ?? "";

  return (
    <div className="ad-acct" ref={ref}>
      <button
        type="button"
        className="ad-acct-btn"
        aria-label={displayName}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="bibo-avatar bibo-avatar--sm">
          <span className="bibo-avatar__img">{initials(displayName)}</span>
          <span className="bibo-avatar__dot bibo-avatar__dot--active" />
        </span>
      </button>
      {open && (
        <div className="ad-menu ad-menu--right" role="menu" style={{ minWidth: 200 }}>
          <div style={{ padding: "8px 10px 10px" }}>
            <div style={{ fontSize: "13.5px", fontWeight: 800 }} title={displayName}>
              {displayName}
            </div>
            <div style={{ fontSize: "12px", color: "#9aa1b4", marginTop: 3 }}>{email}</div>
          </div>
          <div className="ad-menu__sep" />
          <button
            className="ad-menu__opt"
            role="menuitem"
            onClick={logout}
            style={{ color: "#f43f5e", fontSize: "15px" }}
          >
            <span style={{ display: "inline-flex", lineHeight: 0 }}>
              <LogOutIcon />
            </span>
            {t("actions.signOut")}
          </button>
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { mode, setMode } = useTheme();
  const { selected } = useBusinesses();
  const terms = memberTerms(selected?.kind);
  const location = useLocation();

  const NAV = [
    { to: "/", label: t("nav.dashboard"), end: true, icon: <DashboardIcon /> },
    { to: "/employees", label: terms.many, end: false, icon: <MembersIcon /> },
    { to: "/settings", label: t("nav.settings"), end: false, icon: <SettingsIcon /> },
  ];

  const activeNav = NAV.find((n) =>
    n.end ? location.pathname === n.to : location.pathname.startsWith(n.to),
  );
  const title = activeNav?.label ?? t("nav.dashboard");

  const displayName = user?.display_name ?? user?.email ?? "";

  return (
    <div className="app">
      <aside className="ad-rail">
        <RailLogo />

        <nav className="ad-rail__nav">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              aria-label={n.label}
              className={({ isActive }) => `ad-railbtn${isActive ? " on" : ""}`}
            >
              {n.icon}
              <span className="ad-railbtn__tip">{n.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="ad-rail__foot">
          <span className="bibo-avatar" aria-label={displayName}>
            <span className="bibo-avatar__img">{initials(displayName)}</span>
            <span className="bibo-avatar__dot bibo-avatar__dot--active" />
          </span>
        </div>
      </aside>

      <main className="main">
        <header className="ad-topbar">
          <div className="ad-topbar__title">{title}</div>
          <div className="ad-topbar__right">
            <BizPicker />
            <LanguageSwitcher />
            <div className="bibo-seg bibo-seg--sm" role="tablist" aria-label={t("language")}>
              {(["light", "dark", "system"] as ThemeMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={m === mode}
                  className={`bibo-seg__opt${m === mode ? " bibo-seg__opt--on" : ""}`}
                  onClick={() => setMode(m)}
                >
                  {m === "light" ? t("theme.light") : m === "dark" ? t("theme.dark") : t("theme.auto")}
                </button>
              ))}
            </div>
            <AccountMenu />
          </div>
        </header>

        <div className={`content${location.pathname === "/" ? " content--flat" : ""}`}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
