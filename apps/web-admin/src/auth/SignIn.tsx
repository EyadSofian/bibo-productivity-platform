import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { login } from "../api/endpoints";
import { ApiError } from "../api/types";
import { useAuth } from "./AuthContext";
import { Notice } from "../components/ui";
import { AuthLayout } from "./AuthLayout";
import { EngosoftBrand } from "../components/EngosoftBrand";

const DOWNLOAD_URL = import.meta.env.VITE_DOWNLOAD_URL || "/";

/** Brand mark shown inside the sign-in card. */
function LogoMark() {
  return <EngosoftBrand className="ad-login__logo" />;
}

function AtSignIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function SignIn() {
  const nav = useNavigate();
  const { t } = useTranslation("auth");
  const { setSession } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await login(identifier.trim(), password);
      setSession(res.user);
      nav("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout bare hideLockup>
      <div className="ad-loginbox">
        <LogoMark />
        <h1 className="ad-login__title">{t("signIn.title")}</h1>
        <p className="ad-login__sub">{t("signIn.subtitle")}</p>

        {error && (
          <div style={{ marginBottom: 16 }}>
            <Notice kind="danger">{error}</Notice>
          </div>
        )}

        <form className="ad-form" onSubmit={submit}>
          <label className="bibo-field">
            <span className="bibo-field__lbl">{t("signIn.identifier")}</span>
            <span className="bibo-input">
              <span className="bibo-input__icon">
                <AtSignIcon />
              </span>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                autoComplete="username"
                placeholder="mai@acmestudio.co"
              />
            </span>
          </label>

          <label className="bibo-field">
            <span className="bibo-field__lbl">{t("signIn.password")}</span>
            <span className="bibo-input">
              <span className="bibo-input__icon">
                <LockIcon />
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••"
              />
            </span>
          </label>

          <button className="bibo-btn bibo-btn--primary bibo-btn--block" type="submit" disabled={busy}>
            <span>{busy ? t("signIn.submitting") : t("signIn.submit")}</span>
          </button>
        </form>

        <div className="ad-login__links">
          <span className="ad-muted">
            {t("signIn.newHere")}{" "}
            <Link className="ad-link" to="/signup">
              {t("signIn.createAccount")}
            </Link>
          </span>
          <a className="ad-link" href={DOWNLOAD_URL}>
            {t("signIn.download")}
          </a>
        </div>
      </div>
    </AuthLayout>
  );
}
