import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { login } from "../api/endpoints";
import { ApiError } from "../api/types";
import { useAuth } from "./AuthContext";
import { AuthLayout } from "./AuthLayout";
import { Icon } from "../ui/Icon";

export function SignIn() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const location = useLocation();
  const { setSession } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await login(identifier.trim(), password);
      setSession(res.user);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== "/login" ? from : "/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 401 ? t("errors.invalid") : err.status === 429 ? t("errors.tooMany") : err.message);
      } else {
        setError(t("errors.network"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div style={{ display: "grid", gap: 6 }}>
        <h1>{t("signIn.title")}</h1>
        <p className="muted">{t("signIn.subtitle")}</p>
      </div>
      {error ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      ) : null}
      <form className="form-grid" onSubmit={submit}>
        <label className="field">
          <span className="field-label">{t("signIn.identifier")}</span>
          <span className="input-with-icon">
            <Icon name="at" />
            <input
              className="input"
              autoComplete="username"
              required
              dir="auto"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder={t("signIn.identifierPlaceholder")}
            />
          </span>
        </label>
        <label className="field">
          <span className="field-label">{t("signIn.password")}</span>
          <span className="input-with-icon">
            <Icon name="lock" />
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </span>
        </label>
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /> : null}
          {busy ? t("signIn.submitting") : t("signIn.submit")}
        </button>
      </form>
      <p className="muted" style={{ textAlign: "center" }}>
        {t("signIn.noAccount")} <Link to="/signup">{t("signIn.createAccount")}</Link>
      </p>
    </AuthLayout>
  );
}
