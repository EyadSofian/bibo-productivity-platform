import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthContext";
import { BrandLockup } from "../ui/Brand";
import { Icon, type IconName } from "../ui/Icon";
import { Avatar } from "../ui/kit";
import { useBusinesses } from "./useBusinesses";
import { useTheme } from "./theme";
import { LOCALES } from "../i18n";

/* ---------- page header context ---------- */

type PageHeader = { title: string; subtitle?: ReactNode; actions?: ReactNode };
const HeaderCtx = createContext<(h: PageHeader) => void>(() => {});

/** Pages call this to fill the topbar. Re-runs when any part changes. */
export function usePageHeader(title: string, subtitle?: ReactNode, actions?: ReactNode) {
  const set = useContext(HeaderCtx);
  useEffect(() => {
    set({ title, subtitle, actions });
  }, [set, title, subtitle, actions]);
  useEffect(() => {
    document.title = `${title} · Engosoft Workforce`;
  }, [title]);
}

const NAV: Array<{ to: string; key: string; icon: IconName; end?: boolean }> = [
  { to: "/", key: "overview", icon: "overview", end: true },
  { to: "/employees", key: "employees", icon: "users" },
  { to: "/live", key: "live", icon: "live" },
  { to: "/tasks", key: "tasks", icon: "tasks" },
];

const NAV_ADMIN: Array<{ to: string; key: string; icon: IconName }> = [
  { to: "/devices", key: "devices", icon: "monitor" },
  { to: "/settings", key: "settings", icon: "settings" },
];

export function LanguageToggle({ className = "btn btn-ghost btn-icon" }: { className?: string }) {
  const { i18n, t } = useTranslation();
  const current = i18n.resolvedLanguage === "en" ? "en" : "ar";
  const next = LOCALES.find((l) => l.code !== current)!;
  return (
    <button
      type="button"
      className={className}
      onClick={() => void i18n.changeLanguage(next.code)}
      aria-label={t("shell.switchLanguage", { language: next.label })}
      title={next.label}
    >
      <span style={{ fontWeight: 750, fontSize: 13 }} lang={next.code}>
        {next.short}
      </span>
    </button>
  );
}

function ThemeToggle() {
  const { resolved, setMode } = useTheme();
  const { t } = useTranslation();
  const dark = resolved === "dark";
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon"
      onClick={() => setMode(dark ? "light" : "dark")}
      aria-label={dark ? t("shell.lightMode") : t("shell.darkMode")}
      title={dark ? t("shell.lightMode") : t("shell.darkMode")}
    >
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { businesses, selectedId, setSelectedId, selected } = useBusinesses();
  const [header, setHeader] = useState<PageHeader>({ title: "" });
  const [navOpen, setNavOpen] = useState(false);

  // Close the drawer on navigation (mobile).
  useEffect(() => setNavOpen(false), [location.pathname]);

  const signOut = () => {
    logout();
    navigate("/login", { replace: true });
  };

  const name = user?.display_name || user?.email || user?.username || "";
  const setHeaderStable = useMemo(() => setHeader, []);

  return (
    <HeaderCtx.Provider value={setHeaderStable}>
      <div className={`shell${navOpen ? " nav-open" : ""}`}>
        <aside className="sidebar" aria-label={t("shell.navigation")}>
          <div className="glass sidebar-inner">
            <div className="sidebar-brand">
              <BrandLockup product="Workforce" />
            </div>

            <nav className="nav" aria-label={t("shell.main")}>
              {NAV.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end}>
                  <Icon name={item.icon} />
                  {t(`nav.${item.key}`)}
                </NavLink>
              ))}
            </nav>

            <p className="sidebar-section">{t("shell.administration")}</p>
            <nav className="nav" aria-label={t("shell.administration")}>
              {NAV_ADMIN.map((item) => (
                <NavLink key={item.to} to={item.to}>
                  <Icon name={item.icon} />
                  {t(`nav.${item.key}`)}
                </NavLink>
              ))}
            </nav>

            <div className="sidebar-foot">
              {businesses.length > 1 ? (
                <label className="org-switch">
                  <span className="field-hint">{t("shell.company")}</span>
                  <select
                    className="select"
                    value={selectedId ?? ""}
                    onChange={(e) => setSelectedId(e.target.value)}
                  >
                    {businesses.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : selected ? (
                <div className="person" style={{ paddingInline: 8 }}>
                  <span className="kpi-icon">
                    <Icon name="building" />
                  </span>
                  <span className="person-text">
                    <span className="field-hint">{t("shell.company")}</span>
                    <span className="person-name">{selected.name}</span>
                  </span>
                </div>
              ) : null}

              <div className="me">
                <Avatar name={name || "?"} size="sm" />
                <span className="person-text">
                  <span className="person-name">{name}</span>
                  <span className="person-sub">{t("shell.manager")}</span>
                </span>
                <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={signOut} aria-label={t("shell.signOut")} title={t("shell.signOut")}>
                  <Icon name="logout" className="flip-rtl" />
                </button>
              </div>
            </div>
          </div>
        </aside>

        {navOpen ? <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden /> : null}

        <div className="main">
          <header className="glass topbar">
            <button
              type="button"
              className="btn btn-ghost btn-icon menu-btn"
              onClick={() => setNavOpen(true)}
              aria-label={t("shell.openMenu")}
            >
              <Icon name="menu" />
            </button>
            <div className="topbar-title">
              <h1>{header.title}</h1>
              {header.subtitle ? <p>{header.subtitle}</p> : null}
            </div>
            <div className="topbar-actions">
              {header.actions}
              <LanguageToggle />
              <ThemeToggle />
            </div>
          </header>
          <main id="content">
            <Outlet />
          </main>
        </div>
      </div>
    </HeaderCtx.Provider>
  );
}
