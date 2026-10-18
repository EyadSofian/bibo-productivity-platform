import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { createBusiness, register } from "../api/endpoints";
import { ApiError } from "../api/types";
import { useAuth } from "./AuthContext";
import { AuthLayout } from "./AuthLayout";
import { Icon } from "../ui/Icon";

/** One form: the manager's account and the company it owns. Employees are
 *  added afterwards from the Employees page, where the login details are
 *  shown once to hand over. */
export function SignUp() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError(t("errors.passwordShort"));
      return;
    }
    setBusy(true);
    try {
      const res = await register(identifier.trim(), password, name.trim(), "manager");
      setSession(res.user);
      if (company.trim()) await createBusiness(company.trim());
      navigate("/employees?welcome=1", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setError(err.status === 409 ? t("errors.taken") : err.message);
      else setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div style={{ display: "grid", gap: 6 }}>
        <h1>{t("signUp.title")}</h1>
        <p className="muted">{t("signUp.subtitle")}</p>
      </div>
      {error ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      ) : null}
      <form className="form-grid" onSubmit={submit}>
        <label className="field">
          <span className="field-label">{t("signUp.name")}</span>
          <input className="input" required dir="auto" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t("signUp.company")}</span>
          <input className="input" required dir="auto" autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t("signIn.identifier")}</span>
          <input className="input" required dir="auto" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder={t("signIn.identifierPlaceholder")} />
        </label>
        <label className="field">
          <span className="field-label">{t("signIn.password")}</span>
          <input className="input" type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <span className="field-hint">{t("signUp.passwordHint")}</span>
        </label>
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? t("signUp.submitting") : t("signUp.submit")}
        </button>
      </form>
      <p className="muted" style={{ textAlign: "center" }}>
        {t("signUp.haveAccount")} <Link to="/login">{t("signUp.signIn")}</Link>
      </p>
    </AuthLayout>
  );
}
