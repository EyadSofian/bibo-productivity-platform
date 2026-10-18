import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BrandLockup, EngosoftMark } from "../ui/Brand";
import { Icon } from "../ui/Icon";
import { LanguageToggle } from "../app/AppShell";

/** Brand panel beside a frosted form card. The panel says what the product
 *  shows a manager; the card does one job. */
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation("auth");
  return (
    <div className="auth">
      <section className="auth-art" aria-hidden>
        <EngosoftMark className="hero-mark" dot="currentColor" />
        <BrandLockup product="Workforce" inverse />
        <div>
          <h2>{t("art.title")}</h2>
          <p>{t("art.body")}</p>
          <ul className="auth-points">
            <li>
              <Icon name="app" />
              {t("art.point1")}
            </li>
            <li>
              <Icon name="link" />
              {t("art.point2")}
            </li>
            <li>
              <Icon name="keyboard" />
              {t("art.point3")}
            </li>
          </ul>
        </div>
        <p style={{ fontSize: 13, opacity: 0.75 }}>Empowering Educational Success</p>
      </section>
      <section className="auth-panel">
        <div className="glass auth-card">
          <div className="auth-top">
            <BrandLockup product="Workforce" />
            <LanguageToggle className="btn btn-icon btn-sm" />
          </div>
          {children}
        </div>
      </section>
    </div>
  );
}
