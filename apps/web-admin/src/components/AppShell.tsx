import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthContext";
import { useTheme, type ThemeMode } from "../theme/ThemeProvider";
import { useBusinesses } from "../useBusinesses";
import { memberTerms } from "../terms";
import { DetailHeaderContext } from "../detailHeader";
import { LanguageSwitcher } from "./LanguageSwitcher";

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

const TasksIcon = () => (
  <RailIcon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m8 10 2 2 4-4" />
    <path d="M8 16h8" />
  </RailIcon>
);

const DevicesIcon = () => (
  <RailIcon>
    <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />
  </RailIcon>
);

const MonitoringIcon = () => (
  <RailIcon>
    <path d="M4 19V5m0 7h4m4 7V5m0 4h4m4 10V5m0 10h-4" />
    <circle cx="8" cy="12" r="2" />
    <circle cx="16" cy="9" r="2" />
    <circle cx="16" cy="15" r="2" />
  </RailIcon>
);

const OrganizationIcon = () => (
  <RailIcon>
    <circle cx="12" cy="5" r="2" />
    <circle cx="5" cy="19" r="2" />
    <circle cx="19" cy="19" r="2" />
    <path d="M12 7v5M5 17v-3h14v3" />
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

const SunIcon = () => (
  <RailIcon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </RailIcon>
);

const MoonIcon = () => (
  <RailIcon>
    <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
  </RailIcon>
);

const AutoIcon = () => (
  <RailIcon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v18" />
    <path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" />
  </RailIcon>
);

/** Company switcher: the current business, with every other one a click away. */
function BizPicker() {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const { businesses, selected, selectedId, setSelectedId } = useBusinesses();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  if (!selected) return null;

  return (
    <div className="es-pick" ref={ref}>
      <button type="button" className="es-pick__btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{selected.name}</span>
        <ChevronsUpDownIcon />
      </button>
      {open && (
        <div className="es-menu" role="menu">
          {businesses.map((b) => (
            <button
              key={b.id}
              type="button"
              role="menuitemradio"
              aria-checked={b.id === selectedId}
              className="es-menu__opt"
              onClick={() => {
                setSelectedId(b.id);
                setOpen(false);
              }}
            >
              <span>{b.name}</span>
              {b.id === selectedId && <CheckIcon />}
            </button>
          ))}
          <div className="es-menu__sep" />
          <button
            type="button"
            role="menuitem"
            className="es-menu__opt"
            onClick={() => {
              setOpen(false);
              navigate("/employees?new=1");
            }}
          >
            <PlusIcon />
            <span>{t("dashboard.newTeam")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Light, dark or follow the system; one button that cycles, labelled with the next choice. */
function ThemeButton() {
  const { t } = useTranslation();
  const { mode, setMode } = useTheme();
  const order: ThemeMode[] = ["light", "dark", "system"];
  const next = order[(order.indexOf(mode) + 1) % order.length];
  const label = (m: ThemeMode) => (m === "light" ? t("theme.light") : m === "dark" ? t("theme.dark") : t("theme.auto"));
  return (
    <button type="button" className="es-iconbtn" onClick={() => setMode(next)} title={`${label(mode)} → ${label(next)}`} aria-label={`${label(mode)} → ${label(next)}`}>
      {mode === "light" ? <SunIcon /> : mode === "dark" ? <MoonIcon /> : <AutoIcon />}
    </button>
  );
}

/** Account menu with the signed-in identity and sign out. */
function AccountMenu() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const displayName = user?.display_name ?? user?.email ?? "";
  const email = user?.email ?? user?.username ?? "";

  return (
    <div className="es-pick" ref={ref}>
      <button type="button" className="es-iconbtn" aria-label={displayName} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ padding: 0, borderRadius: "50%" }}>
        <span className="es-avatar">{initials(displayName)}</span>
      </button>
      {open && (
        <div className="es-menu" role="menu">
          <div className="es-menu__who">
            <strong title={displayName}>{displayName}</strong>
            <small>{email}</small>
          </div>
          <div className="es-menu__sep" />
          <button className="es-menu__opt es-menu__opt--danger" role="menuitem" onClick={logout}>
            <LogOutIcon />
            <span>{t("actions.signOut")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { selected } = useBusinesses();
  const terms = memberTerms(selected?.kind);
  const location = useLocation();
  const contentRef = useRef<HTMLDivElement>(null);

  // Grouped the way an admin thinks: watching people, then setting the rules.
  const WATCH = [
    { to: "/", label: t("nav.dashboard"), end: true, icon: <DashboardIcon /> },
    { to: "/employees", label: terms.many, end: false, icon: <MembersIcon /> },
    { to: "/tasks", label: t("nav.tasks"), end: false, icon: <TasksIcon /> },
  ];
  const MANAGE = [
    { to: "/devices", label: t("nav.devices"), end: false, icon: <DevicesIcon /> },
    { to: "/monitoring", label: t("nav.monitoring"), end: false, icon: <MonitoringIcon /> },
    { to: "/organization", label: t("nav.organization"), end: false, icon: <OrganizationIcon /> },
    { to: "/settings", label: t("nav.settings"), end: false, icon: <SettingsIcon /> },
  ];
  const NAV = [...WATCH, ...MANAGE];

  const activeNav = NAV.find((n) =>
    n.end ? location.pathname === n.to : location.pathname.startsWith(n.to),
  );
  const baseTitle = activeNav?.label ?? t("nav.dashboard");

  // On a member detail page (/employees/:id) the header shows the member's name.
  const isDetail = location.pathname.startsWith("/employees/");
  const [detailTitle, setDetailTitle] = useState<string | null>(null);
  const detailHeader = useMemo(() => ({ setTitle: setDetailTitle }), []);
  const title = isDetail ? detailTitle ?? baseTitle : baseTitle;

  const displayName = user?.display_name ?? user?.email ?? "";

  // The workspace is its own scroll container; reset it between routes so a
  // return from a long report does not open the next page halfway down.
  useEffect(() => {
    if (!contentRef.current) return;
    contentRef.current.scrollTop = 0;
    contentRef.current.scrollLeft = 0;
  }, [location.pathname, location.search]);

  const link = (n: (typeof NAV)[number]) => (
    <NavLink key={n.to} to={n.to} end={n.end} aria-label={n.label} className={({ isActive }) => `es-link${isActive ? " on" : ""}`}>
      {n.icon}
      <span>{n.label}</span>
    </NavLink>
  );

  return (
    <div className="es">
      <aside className="es-side">
        <NavLink to="/" className="es-brand" aria-label="Engosoft Workforce">
          <strong>Engosoft</strong>
          <small>WORKFORCE</small>
        </NavLink>
        <nav className="es-nav" aria-label={t("nav.dashboard")}>
          {WATCH.map(link)}
          <div className="es-nav__label" aria-hidden>{t("nav.manage")}</div>
          {MANAGE.map(link)}
        </nav>
        <div className="es-me">
          <span className="es-avatar" aria-hidden>{initials(displayName)}</span>
          <span>
            <strong title={displayName}>{displayName}</strong>
            <small>{selected?.name ?? "Engosoft"}</small>
          </span>
        </div>
      </aside>

      <main className="es-main">
        <header className="es-top">
          <div className="es-top__title">{title}</div>
          <div className="es-top__right">
            {!isDetail && <BizPicker />}
            <span className="es-top__lang"><LanguageSwitcher /></span>
            <ThemeButton />
            <AccountMenu />
          </div>
        </header>

        <div ref={contentRef} className="es-content">
          <DetailHeaderContext.Provider value={detailHeader}>
            <Outlet />
          </DetailHeaderContext.Provider>
        </div>
      </main>
    </div>
  );
}
