import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { createBusiness, createEmployee, register } from "../api/endpoints";
import { ApiError, type AccountType } from "../api/types";
import { useAuth } from "./AuthContext";
import { Notice } from "../components/ui";
import { memberTerms } from "../terms";
import { AuthLayout } from "./AuthLayout";

const DOWNLOAD_URL = import.meta.env.VITE_DOWNLOAD_URL || "/";

/** Ic — inline lucide-style icon wrapper (persona cards + wizard footer). */
function Ic({ children }: { children: ReactNode }) {
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

type PwLevel = "weak" | "medium" | "strong";

/** Password strength → one of three levels (weak/medium/strong) with meter
 *  fill width (%) + color token. Scores on length + character variety. */
function pwStrength(pw: string): { level: PwLevel | null; pct: number; color: string } {
  if (!pw) return { level: null, pct: 0, color: "#f43f5e" };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length < 8 || score <= 1) return { level: "weak", pct: 33, color: "#f43f5e" };
  if (score <= 3) return { level: "medium", pct: 66, color: "#f59e0c" };
  return { level: "strong", pct: 100, color: "#30b981" };
}

type Step = "persona" | "personal" | "account" | "setup" | "members" | "done";

// Persona → business kind. The org's own noun (team/family) is localized via memberTerms().org.
const kindOf = (p: AccountType) => (p === "parent" ? "family" : "team");

// `login` is the identifier the member signs in with — an email or a username.
type AddedMember = { display_name: string; login: string; password: string };

// Simple default temp password, pre-filled for quick setup. The owner can hit
// "↻ New" to swap it for a strong random one (genTempPassword).
const DEFAULT_TEMP_PASSWORD = "12345678";

// orgSlug turns "Yojee Corp" into "yojeecorp" for generated usernames.
function orgSlug(orgName: string): string {
  return orgName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "team";
}

// suggestUsername builds e.g. "yojeecorp_emp1" / "namfamily_kid2".
function suggestUsername(orgName: string, abbrev: string, n: number): string {
  return `${orgSlug(orgName)}_${abbrev}${n}`;
}

// Readable temp password (no ambiguous chars) the owner hands to the new member.
function genTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function SignupWizard() {
  const { t } = useTranslation("signup");
  const nav = useNavigate();
  const { setSession } = useAuth();

  const [step, setStep] = useState<Step>("persona");
  const [persona, setPersona] = useState<AccountType>("manager");

  const [displayName, setDisplayName] = useState("");
  const [login, setLogin] = useState(""); // owner's email or username
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [bizId, setBizId] = useState<string | null>(null);
  const [members, setMembers] = useState<AddedMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const terms = memberTerms(kindOf(persona));
  const noun = terms.org; // localized org noun (e.g. "gia đình" / "nhóm")

  async function createAccount(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await register(login.trim(), password, displayName.trim(), persona);
      setSession(res.user);
      setStep("setup");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("errors.server"));
    } finally {
      setBusy(false);
    }
  }

  async function finishSetup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const biz = await createBusiness(orgName.trim());
      setBizId(biz.id);
      setStep("members");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("errors.server"));
    } finally {
      setBusy(false);
    }
  }

  // ---- Step "persona" (W2): single centered wizard card ----
  if (step === "persona") {
    return (
      <AuthLayout bare hideLockup>
        <div className="ad-wizard">
          <div className="ad-wiz-rail">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className={`ad-wiz-pip${i === 0 ? " on" : ""}`} />
            ))}
          </div>
          <div className="ad-wiz-step">{t("stepProgress", { current: 1, total: 5, ns: "ui" })}</div>

          <h2 className="ad-wiz-title">{t("persona.heading")}</h2>
          <p className="ad-wiz-sub">{t("persona.sub")}</p>

          <div className="ad-persona-cards">
            <button type="button" className="ad-persona" onClick={() => setStep("personal")}>
              <span className="ad-persona__ic">
                <Ic>
                  <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </Ic>
              </span>
              <span className="ad-persona__body">
                <span className="ad-persona__t">{t("persona.justMeTitle")}</span>
                <span className="ad-persona__d">{t("persona.justMeDesc")}</span>
              </span>
              <span className="ad-persona__go">
                <Ic>
                  <path d="M12 15V3" />
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m7 10 5 5 5-5" />
                </Ic>
              </span>
            </button>

            <button
              type="button"
              className="ad-persona"
              onClick={() => {
                setPersona("manager");
                setStep("account");
              }}
            >
              <span className="ad-persona__ic">
                <Ic>
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <path d="M16 3.128a4 4 0 0 1 0 7.744" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <circle cx="9" cy="7" r="4" />
                </Ic>
              </span>
              <span className="ad-persona__body">
                <span className="ad-persona__t">{t("persona.teamTitle")}</span>
                <span className="ad-persona__d">{t("persona.teamDesc")}</span>
              </span>
              <span className="ad-persona__go">
                <Ic>
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </Ic>
              </span>
            </button>

            <button
              type="button"
              className="ad-persona"
              onClick={() => {
                setPersona("parent");
                setStep("account");
              }}
            >
              <span className="ad-persona__ic">
                <Ic>
                  <path d="M19.414 14.414C21 12.828 22 11.5 22 9.5a5.5 5.5 0 0 0-9.591-3.676.6.6 0 0 1-.818.001A5.5 5.5 0 0 0 2 9.5c0 2.3 1.5 4 3 5.5l5.535 5.362a2 2 0 0 0 2.879.052 2.12 2.12 0 0 0-.004-3 2.124 2.124 0 1 0 3-3 2.124 2.124 0 0 0 3.004 0 2 2 0 0 0 0-2.828l-1.881-1.882a2.41 2.41 0 0 0-3.409 0l-1.71 1.71a2 2 0 0 1-2.828 0 2 2 0 0 1 0-2.828l2.823-2.762" />
                </Ic>
              </span>
              <span className="ad-persona__body">
                <span className="ad-persona__t">{t("persona.familyTitle")}</span>
                <span className="ad-persona__d">{t("persona.familyDesc")}</span>
              </span>
              <span className="ad-persona__go">
                <Ic>
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </Ic>
              </span>
            </button>
          </div>

          <div className="ad-notice ad-notice--info">
            <Ic>
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </Ic>
            <span>{t("persona.caption")}</span>
          </div>

          <div className="ad-wiz-foot">
            <button type="button" className="bibo-btn bibo-btn--ghost" onClick={() => nav("/login")}>
              <Ic>
                <path d="m12 19-7-7 7-7" />
                <path d="M19 12H5" />
              </Ic>
              <span>{t("persona.back")}</span>
            </button>
          </div>
        </div>
      </AuthLayout>
    );
  }

  // ---- Personal branch (W3): no account, no rail ----
  if (step === "personal") {
    return (
      <AuthLayout>
        <button className="link-row back-top" onClick={() => setStep("persona")}>
          {t("personal.back")}
        </button>
        <h1>
          <span aria-hidden>🧍 </span>{t("personal.heading")}
        </h1>
        <div className="auth-sub">
          {t("personal.sub")}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <a className="btn btn-primary" href={DOWNLOAD_URL}>{t("personal.downloadMac")}</a>
          <a className="btn" href={DOWNLOAD_URL}>{t("personal.downloadWindows")}</a>
        </div>
        <div className="caption" style={{ marginTop: 16 }}>
          {t("personal.caption")}
        </div>
      </AuthLayout>
    );
  }

  // ---- Step "account" (single wizard card) ----
  if (step === "account") {
    const pw = pwStrength(password);
    return (
      <AuthLayout bare hideLockup>
        <form className="ad-wizard" onSubmit={createAccount}>
          <div className="ad-wiz-rail">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className={`ad-wiz-pip${i < 1 ? " done" : i === 1 ? " on" : ""}`} />
            ))}
          </div>
          <div className="ad-wiz-step">{t("stepProgress", { current: 2, total: 5, ns: "ui" })}</div>

          <h2 className="ad-wiz-title">{t("account.title")}</h2>
          <p className="ad-wiz-sub">{t("account.sub")}</p>

          {error && (
            <div style={{ marginBottom: 16 }}>
              <Notice kind="danger">{error}</Notice>
            </div>
          )}

          <div className="ad-form">
            <label className="bibo-field">
              <span className="bibo-field__lbl">{t("account.name")}</span>
              <span className="bibo-input">
                <span className="bibo-input__icon">
                  <Ic>
                    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </Ic>
                </span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                  autoComplete="name"
                  placeholder="Mai Tran"
                />
              </span>
            </label>

            <div>
              <label className="bibo-field">
                <span className="bibo-field__lbl">{t("account.identifier")}</span>
                <span className="bibo-input">
                  <span className="bibo-input__icon">
                    <Ic>
                      <circle cx="12" cy="12" r="4" />
                      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
                    </Ic>
                  </span>
                  <input
                    type="text"
                    value={login}
                    onChange={(e) => setLogin(e.target.value)}
                    required
                    autoComplete="username"
                    placeholder={t("account.identifierPlaceholder")}
                  />
                </span>
              </label>
              {login.trim() && (
                <div className="ad-field-ok">
                  <Ic>
                    <path d="M21.801 10A10 10 0 1 1 17 3.335" />
                    <path d="m9 11 3 3L22 4" />
                  </Ic>
                  <span>{t("account.available")}</span>
                </div>
              )}
            </div>

            <div>
              <label className="bibo-field">
                <span className="bibo-field__lbl">{t("account.password")}</span>
                <span className="bibo-input">
                  <span className="bibo-input__icon">
                    <Ic>
                      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </Ic>
                  </span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    placeholder={t("account.passwordPlaceholder")}
                  />
                </span>
              </label>
              <div className="ad-pw-meter">
                <div className="ad-pw-meter__fill" style={{ width: `${pw.pct}%`, backgroundColor: pw.color }} />
              </div>
              <div className="ad-pw-row">
                <span className="ad-muted">{t("account.passwordPlaceholder")}</span>
                {pw.level && (
                  <span className="ad-pw-label" style={{ color: pw.color }}>
                    {t(`account.strength.${pw.level}`)}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="ad-wiz-foot">
            <button type="button" className="bibo-btn bibo-btn--ghost" onClick={() => setStep("persona")}>
              <Ic>
                <path d="m12 19-7-7 7-7" />
                <path d="M19 12H5" />
              </Ic>
              <span>{t("persona.back")}</span>
            </button>
            <button type="submit" className="bibo-btn bibo-btn--primary" disabled={busy}>
              <span>{busy ? t("account.creating") : t("account.continue")}</span>
              <Ic>
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </Ic>
            </button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  // ---- Step "setup" (single wizard card) ----
  if (step === "setup") {
    return (
      <AuthLayout bare hideLockup>
        <form className="ad-wizard" onSubmit={finishSetup}>
          <div className="ad-wiz-rail">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className={`ad-wiz-pip${i < 2 ? " done" : i === 2 ? " on" : ""}`} />
            ))}
          </div>
          <div className="ad-wiz-step">{t("stepProgress", { current: 3, total: 5, ns: "ui" })}</div>

          <h2 className="ad-wiz-title">{t("setup.title", { noun })}</h2>
          <p className="ad-wiz-sub">{t("setup.sub", { members: terms.lowerMany })}</p>

          {error && (
            <div style={{ marginBottom: 16 }}>
              <Notice kind="danger">{error}</Notice>
            </div>
          )}

          <div className="ad-form">
            <label className="bibo-field">
              <span className="bibo-field__lbl">{t("setup.nameLabel", { noun })}</span>
              <span className="bibo-input">
                <span className="bibo-input__icon">
                  <Ic>
                    <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
                    <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </Ic>
                </span>
                <input
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  required
                  autoFocus
                  placeholder={persona === "parent" ? t("setup.placeholderFamily") : t("setup.placeholderTeam")}
                />
              </span>
            </label>
          </div>

          <div className="ad-wiz-foot">
            <button type="button" className="bibo-btn bibo-btn--ghost" onClick={() => setStep("account")}>
              <Ic>
                <path d="m12 19-7-7 7-7" />
                <path d="M19 12H5" />
              </Ic>
              <span>{t("persona.back")}</span>
            </button>
            <button type="submit" className="bibo-btn bibo-btn--primary" disabled={busy}>
              <span>{busy ? t("setup.saving") : t("setup.continue")}</span>
              <Ic>
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </Ic>
            </button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  // ---- Step "members" (single wizard card) ----
  if (step === "members") {
    return (
      <AuthLayout bare hideLockup>
        <AddMembers
          businessId={bizId}
          orgName={orgName}
          terms={terms}
          members={members}
          onAdded={(m) => setMembers((cur) => [...cur, m])}
          onRemoveVisual={(i) => setMembers((cur) => cur.filter((_, idx) => idx !== i))}
          onBack={() => setStep("setup")}
          onFinish={() => setStep("done")}
        />
      </AuthLayout>
    );
  }

  // ---- Step "done" (single wizard card) ----
  const doneItems = [
    { label: t("done.accountCreated"), done: true },
    { label: t("done.orgReady", { noun: noun[0].toUpperCase() + noun.slice(1) }), done: true },
    {
      label:
        members.length > 0
          ? t("done.membersAdded", {
              count: members.length,
              members: members.length === 1 ? terms.lowerOne : terms.lowerMany,
            })
          : t("done.membersLater", { members: terms.lowerMany }),
      done: members.length > 0,
    },
  ];

  return (
    <AuthLayout bare hideLockup>
      <div className="ad-wizard">
        <div className="ad-wiz-rail">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={`ad-wiz-pip${i < 4 ? " done" : " on"}`} />
          ))}
        </div>
        <div className="ad-wiz-step">{t("stepProgress", { current: 5, total: 5, ns: "ui" })}</div>

        <div className="ad-burst">
          <Ic>
            <path d="M5.8 11.3 2 22l10.7-3.79" />
            <path d="M4 3h.01" />
            <path d="M22 8h.01" />
            <path d="M15 2h.01" />
            <path d="M22 20h.01" />
            <path d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10" />
            <path d="m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17" />
            <path d="m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7" />
            <path d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z" />
          </Ic>
        </div>
        <h2 className="ad-wiz-title">{t("done.title")}</h2>
        <p className="ad-wiz-sub">{t("rail.doneDesc")}</p>

        <div className="ad-success-list">
          {doneItems.map((it) => (
            <div className="ad-success-item" key={it.label}>
              <span className={`ad-success-item__ck${it.done ? "" : " ad-success-item__ck--todo"}`}>
                {it.done ? (
                  <Ic>
                    <path d="M20 6 9 17l-5-5" />
                  </Ic>
                ) : (
                  <Ic>
                    <circle cx="12" cy="12" r="9" />
                  </Ic>
                )}
              </span>
              <span>{it.label}</span>
            </div>
          ))}
        </div>

        <div className="ad-wiz-foot">
          <span className="sp" />
          <button type="button" className="bibo-btn bibo-btn--primary" onClick={() => nav("/", { replace: true })}>
            <span>{t("done.goToDashboard")}</span>
            <Ic>
              <path d="M5 12h14" />
              <path d="m12 5 7 7-7 7" />
            </Ic>
          </button>
          <span className="sp" />
        </div>
      </div>
    </AuthLayout>
  );
}

// AddMembers — inline add-employees/add-kids step. Each "Add" creates a real
// account via createEmployee against the just-created business.
function AddMembers({
  businessId,
  orgName,
  terms,
  members,
  onAdded,
  onRemoveVisual,
  onBack,
  onFinish,
}: {
  businessId: string | null;
  orgName: string;
  terms: ReturnType<typeof memberTerms>;
  members: AddedMember[];
  onAdded: (m: AddedMember) => void;
  onRemoveVisual: (index: number) => void;
  onBack: () => void;
  onFinish: () => void;
}) {
  const { t } = useTranslation("signup");
  const [name, setName] = useState("");
  const [login, setLogin] = useState(() => suggestUsername(orgName, terms.idAbbrev, members.length + 1));
  const [password, setPassword] = useState(DEFAULT_TEMP_PASSWORD);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const suggested = suggestUsername(orgName, terms.idAbbrev, members.length + 1);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const value = login.trim();
    const isEmail = value.includes("@");
    try {
      await createEmployee({
        email: isEmail ? value : undefined,
        username: isEmail ? undefined : value.toLowerCase(),
        password,
        display_name: name.trim(),
        business_id: businessId ?? undefined,
      });
      onAdded({ display_name: name.trim(), login: isEmail ? value : value.toLowerCase(), password });
      // Reset for the next person: fresh suggested username + default password.
      setName("");
      setLogin(suggestUsername(orgName, terms.idAbbrev, members.length + 2));
      setPassword(DEFAULT_TEMP_PASSWORD);
      nameRef.current?.focus();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 409 ? t("errors.taken") : err.message);
      } else {
        setError(t("errors.addMember", { member: terms.lowerOne }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyLogin(m: AddedMember, i: number) {
    const text = t("clipboard.text", { login: m.login, password: m.password });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(i);
      window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  return (
    <form className="ad-wizard" onSubmit={add}>
      <div className="ad-wiz-rail">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={`ad-wiz-pip${i < 3 ? " done" : i === 3 ? " on" : ""}`} />
        ))}
      </div>
      <div className="ad-wiz-step">{t("stepProgress", { current: 4, total: 5, ns: "ui" })}</div>

      <h2 className="ad-wiz-title">{t("members.title", { members: terms.lowerMany })}</h2>
      <p className="ad-wiz-sub">{t("members.sub")}</p>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <Notice kind="danger">{error}</Notice>
        </div>
      )}

      <div className="ad-addmember">
        <label className="bibo-field">
          <span className="bibo-field__lbl">{t("members.name")}</span>
          <span className="bibo-input">
            <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} required placeholder={t("members.namePlaceholder")} autoFocus />
          </span>
        </label>

        <label className="bibo-field">
          <span className="bibo-field__lbl">{t("members.loginLabel")}</span>
          <span className="bibo-input">
            <input value={login} onChange={(e) => setLogin(e.target.value)} required placeholder={suggested} autoComplete="off" />
          </span>
        </label>

        <div className="ad-addmember__full">
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <label className="bibo-field">
                <span className="bibo-field__lbl">{t("members.tempPassword")}</span>
                <span className="bibo-input">
                  <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
                </span>
              </label>
            </div>
            <button type="button" className="bibo-btn bibo-btn--secondary" title={t("members.generateTitle")} onClick={() => setPassword(genTempPassword())}>
              <Ic>
                <rect width="12" height="12" x="2" y="10" rx="2" ry="2" />
                <path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6" />
                <path d="M6 18h.01" />
                <path d="M10 14h.01" />
                <path d="M15 6h.01" />
                <path d="M18 9h.01" />
              </Ic>
              <span>{t("members.newPassword")}</span>
            </button>
            <button type="submit" className="bibo-btn bibo-btn--primary" disabled={busy}>
              <Ic>
                <path d="M5 12h14" />
                <path d="M12 5v14" />
              </Ic>
              <span>{busy ? t("members.adding") : t("members.addCta", { cta: terms.addCta })}</span>
            </button>
          </div>
          <div className="ad-muted" style={{ fontSize: "11.5px", marginTop: 6 }}>
            {t("members.suggestion")} : <b>{suggested}</b>
          </div>
        </div>
      </div>

      {members.length > 0 && (
        <div className="ad-memberlist">
          {members.map((m, i) => (
            <div className="ad-memberitem" key={`${m.login}-${i}`}>
              <span className="ad-memberitem__ok">
                <Ic>
                  <path d="M20 6 9 17l-5-5" />
                </Ic>
              </span>
              <div className="ad-memberitem__id">
                <div className="ad-memberitem__name">{m.display_name}</div>
                <div className="ad-memberitem__login">
                  {m.login} · <span className="ad-memberitem__pw">••••••••</span>
                </div>
              </div>
              <button
                type="button"
                className="ad-iconbtn-sm"
                title={copied === i ? t("members.copied") : t("members.copyLogin")}
                onClick={() => copyLogin(m, i)}
              >
                {copied === i ? (
                  <Ic>
                    <path d="M20 6 9 17l-5-5" />
                  </Ic>
                ) : (
                  <Ic>
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                  </Ic>
                )}
              </button>
              <button
                type="button"
                className="ad-iconbtn-sm"
                title={t("members.remove")}
                onClick={() => onRemoveVisual(i)}
              >
                <Ic>
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M3 6h18" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </Ic>
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="ad-wiz-foot">
        <button type="button" className="bibo-btn bibo-btn--ghost" onClick={onBack}>
          <Ic>
            <path d="m12 19-7-7 7-7" />
            <path d="M19 12H5" />
          </Ic>
          <span>{t("persona.back")}</span>
        </button>
        <span className="sp" />
        <button type="button" className="bibo-btn bibo-btn--ghost" onClick={onFinish}>
          <span>{t("members.skip")}</span>
        </button>
        <button type="button" className="bibo-btn bibo-btn--primary" onClick={onFinish}>
          <Ic>
            <path d="M20 6 9 17l-5-5" />
          </Ic>
          <span>{t("members.finish")}</span>
        </button>
      </div>
    </form>
  );
}
