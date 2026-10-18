import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { createBusiness, listPublicBusinesses, register, registerEmployee } from "../api/endpoints";
import { ApiError, type PublicBusiness } from "../api/types";
import { useAuth } from "./AuthContext";
import { AuthLayout } from "./AuthLayout";
import { Icon } from "../ui/Icon";

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
  const [mode, setMode] = useState<"employee" | "manager">("employee");
  const [businesses, setBusinesses] = useState<PublicBusiness[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    void listPublicBusinesses().then((res) => setBusinesses(res.businesses)).catch(() => setError(t("errors.network")));
  }, [t]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError(t("errors.passwordShort"));
      return;
    }
    setBusy(true);
    try {
      if (mode === "employee") {
        await registerEmployee({
          business_id: businessId,
          join_code: joinCode.trim(),
          email: identifier.trim(),
          password,
          display_name: name.trim(),
        });
        setJoined(true);
        return;
      }
      const res = await register(identifier.trim(), password, name.trim(), "manager");
      setSession(res.user);
      if (company.trim()) await createBusiness(company.trim());
      navigate("/employees?welcome=1", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setError(err.status === 409 ? t("errors.taken") : err.status === 403 ? t("errors.joinCode") : err.message);
      else setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      {joined ? (
        <div className="form-grid">
          <h1>{t("signUp.joinedTitle")}</h1>
          <p className="muted">{t("signUp.joinedBody")}</p>
        </div>
      ) : <>
      <div className="toolbar" role="group" aria-label={t("signUp.accountType")}>
        <button type="button" className={`btn ${mode === "employee" ? "btn-primary" : "btn-ghost"}`} onClick={() => { setMode("employee"); setError(null); }}>{t("signUp.employee")}</button>
        <button type="button" className={`btn ${mode === "manager" ? "btn-primary" : "btn-ghost"}`} onClick={() => { setMode("manager"); setError(null); }}>{t("signUp.manager")}</button>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <h1>{t(mode === "employee" ? "signUp.employeeTitle" : "signUp.title")}</h1>
        <p className="muted">{t(mode === "employee" ? "signUp.employeeSubtitle" : "signUp.subtitle")}</p>
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
        {mode === "manager" ? <label className="field">
          <span className="field-label">{t("signUp.company")}</span>
          <input className="input" required dir="auto" autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} />
        </label> : <>
          <label className="field">
            <span className="field-label">{t("signUp.selectCompany")}</span>
            <select className="select" required value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
              <option value="">{t("signUp.selectCompanyPlaceholder")}</option>
              {businesses.map((b) => <option key={b.business_id} value={b.business_id}>{b.name} — {b.owner_name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t("signUp.joinCode")}</span>
            <input className="input ltr" required autoComplete="off" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} />
            <span className="field-hint">{t("signUp.joinCodeHint")}</span>
          </label>
        </>}
        <label className="field">
          <span className="field-label">{mode === "employee" ? t("signUp.email") : t("signIn.identifier")}</span>
          <input className="input" type={mode === "employee" ? "email" : "text"} required dir="auto" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder={t("signIn.identifierPlaceholder")} />
        </label>
        <label className="field">
          <span className="field-label">{t("signIn.password")}</span>
          <input className="input" type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <span className="field-hint">{t("signUp.passwordHint")}</span>
        </label>
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? t("signUp.submitting") : t(mode === "employee" ? "signUp.joinSubmit" : "signUp.submit")}
        </button>
      </form>
      <p className="muted" style={{ textAlign: "center" }}>
        {t("signUp.haveAccount")} <Link to="/login">{t("signUp.signIn")}</Link>
      </p>
      </>}
    </AuthLayout>
  );
}
