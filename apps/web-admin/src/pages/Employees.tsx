import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  assignEmployeeOrganization,
  createBusiness,
  createEmployee,
  getBusinessJoinCode,
  listBusinessEmployees,
  listOrganization,
  reportEmployees,
  rotateBusinessJoinCode,
} from "../api/endpoints";
import { ApiError, type Employee } from "../api/types";
import { usePageHeader } from "../app/AppShell";
import { useBusinesses } from "../app/useBusinesses";
import { localDayWindow } from "../lib/day";
import { fmtDuration, fmtRelative } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { Icon } from "../ui/Icon";
import { Avatar, Card, Dialog, Empty, ErrorNote, LoadingRows, PresenceBadge } from "../ui/kit";

export default function Employees() {
  const { t } = useTranslation("app");
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { selectedId, selected, loading: bizLoading, reload: reloadBusinesses } = useBusinesses();
  const [query, setQuery] = useState("");
  const [dept, setDept] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);

  const employees = useAsync(
    () => (selectedId ? listBusinessEmployees(selectedId) : Promise.resolve({ employees: [] })),
    [selectedId],
    30_000,
  );
  const roster = useAsync(
    () => (selectedId ? reportEmployees(selectedId, localDayWindow()) : Promise.resolve({ employees: [] })),
    [selectedId],
    30_000,
  );
  const org = useAsync(
    () => (selectedId ? listOrganization(selectedId) : Promise.resolve({ departments: [], job_roles: [] })),
    [selectedId],
  );
  const invite = useAsync(
    () => (selectedId ? getBusinessJoinCode(selectedId) : Promise.resolve({ join_code: "" })),
    [selectedId],
  );
  const [codeCopied, setCodeCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const live = useMemo(() => new Map((roster.data?.employees ?? []).map((e) => [e.id, e])), [roster.data]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (employees.data?.employees ?? [])
      .filter((e) => !dept || e.department_id === dept)
      .filter(
        (e) =>
          !q ||
          e.display_name.toLowerCase().includes(q) ||
          (e.email || "").toLowerCase().includes(q) ||
          (e.username || "").toLowerCase().includes(q),
      )
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [employees.data, query, dept]);

  usePageHeader(
    t("employees.title"),
    selected ? t("employees.subtitle", { count: employees.data?.employees.length ?? 0, company: selected.name }) : undefined,
  );

  if (!bizLoading && !selectedId) {
    return <CreateCompany onCreated={reloadBusinesses} />;
  }

  const welcome = params.get("welcome") === "1";

  return (
    <div className="page">
      {welcome ? (
        <div className="alert alert-brand">
          <Icon name="sparkle" />
          <span style={{ flex: 1 }}>{t("employees.welcome")}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label={t("actions.close", { ns: "common" })}
            onClick={() => {
              params.delete("welcome");
              setParams(params, { replace: true });
            }}
          >
            <Icon name="x" />
          </button>
        </div>
      ) : null}

      <Card>
        <div className="toolbar">
          <div className="grow">
            <h2>{t("employees.selfJoinTitle")}</h2>
            <p className="muted">{t("employees.selfJoinBody")}</p>
          </div>
          {invite.data?.join_code ? (
            <div className="toolbar">
              <button type="button" className="btn btn-primary" onClick={() => {
                void navigator.clipboard.writeText(invite.data!.join_code).then(() => setCodeCopied(true));
              }}>
                <Icon name={codeCopied ? "check" : "layers"} />
                {codeCopied ? t("employees.codeCopied") : t("employees.copyJoinCode")}
              </button>
              <button type="button" className="btn btn-ghost" disabled={rotating} onClick={async () => {
                if (!selectedId || !window.confirm(t("employees.rotateConfirm"))) return;
                setRotating(true);
                setRotateError(null);
                try {
                  await rotateBusinessJoinCode(selectedId);
                  await invite.reload();
                  setCodeCopied(false);
                } catch (err) {
                  setRotateError(err instanceof ApiError ? err.message : t("errors.network", { ns: "common" }));
                } finally {
                  setRotating(false);
                }
              }}>{t("employees.rotateCode")}</button>
            </div>
          ) : null}
        </div>
        <ErrorNote error={invite.error} onRetry={invite.reload} />
        {rotateError ? <div className="alert alert-danger" role="alert">{rotateError}</div> : null}
        {invite.data?.join_code ? <code className="ltr" style={{ display: "block", marginTop: 12, overflowWrap: "anywhere" }}>{invite.data.join_code}</code> : null}
      </Card>

      <Card>
        <div className="toolbar" style={{ marginBlockEnd: 18 }}>
          <label className="input-with-icon grow">
            <Icon name="search" />
            <input
              className="input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("employees.search")}
              aria-label={t("employees.search")}
            />
          </label>
          {(org.data?.departments.length ?? 0) > 0 ? (
            <select className="select" style={{ width: "auto" }} value={dept} onChange={(e) => setDept(e.target.value)} aria-label={t("employees.department")}>
              <option value="">{t("employees.allDepartments")}</option>
              {org.data!.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            {t("employees.add")}
          </button>
        </div>

        <ErrorNote error={employees.error} onRetry={employees.reload} />

        {employees.loading && !employees.data ? (
          <LoadingRows rows={6} />
        ) : list.length === 0 ? (
          <Empty icon="users" title={query || dept ? t("employees.noMatch") : t("employees.none")}>
            {query || dept ? null : t("employees.noneHint")}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("table.employee")}</th>
                  <th className="hide-sm">{t("employees.department")}</th>
                  <th>{t("table.status")}</th>
                  <th className="end">{t("table.worked")}</th>
                  <th className="end hide-sm">{t("table.lastSeen")}</th>
                  <th className="end">
                    <span className="sr-only">{t("table.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((e) => {
                  const r = live.get(e.id);
                  return (
                    <tr key={e.id} className="is-link" onClick={() => navigate(`/employees/${e.id}`)}>
                      <td>
                        <Link to={`/employees/${e.id}`} className="person" onClick={(ev) => ev.stopPropagation()}>
                          <Avatar name={e.display_name} status={r?.presence_state} />
                          <span className="person-text">
                            <span className="person-name">{e.display_name}</span>
                            <span className="person-sub ltr">{e.email || e.username}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="hide-sm">
                        {e.department_name || e.job_role_name ? (
                          <span className="person-text">
                            <span>{e.department_name || "—"}</span>
                            <span className="person-sub">{e.job_role_name}</span>
                          </span>
                        ) : (
                          <span className="subtle">{t("employees.unassigned")}</span>
                        )}
                      </td>
                      <td>
                        <PresenceBadge state={r?.presence_state} />
                      </td>
                      <td className="end num strong">{fmtDuration(r?.active_today_s ?? 0)}</td>
                      <td className="end muted hide-sm">{fmtRelative(r?.presence_seen_at ?? r?.last_seen ?? null)}</td>
                      <td className="end">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm btn-icon"
                          aria-label={t("employees.edit", { name: e.display_name })}
                          title={t("employees.editTeam")}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setEditing(e);
                          }}
                        >
                          <Icon name="edit" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <AddEmployee
        open={adding}
        businessId={selectedId}
        onClose={() => setAdding(false)}
        onCreated={() => {
          employees.reload();
          roster.reload();
        }}
      />
      <EditTeam
        employee={editing}
        businessId={selectedId}
        departments={org.data?.departments ?? []}
        roles={org.data?.job_roles ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          employees.reload();
        }}
      />
    </div>
  );
}

function CreateCompany({ onCreated }: { onCreated: () => Promise<void> }) {
  const { t } = useTranslation("app");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  usePageHeader(t("employees.title"));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createBusiness(name.trim());
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("errors.generic", { ns: "common" }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <Card>
        <Empty icon="building" title={t("employees.createCompanyTitle")}>
          {t("employees.createCompanyBody")}
        </Empty>
        <form onSubmit={submit} className="form-grid" style={{ maxWidth: 420, marginInline: "auto" }}>
          {error ? <div className="alert alert-danger">{error}</div> : null}
          <label className="field">
            <span className="field-label">{t("employees.companyName")}</span>
            <input className="input" required dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {t("employees.createCompany")}
          </button>
        </form>
      </Card>
    </div>
  );
}

function AddEmployee({
  open,
  businessId,
  onClose,
  onCreated,
}: {
  open: boolean;
  businessId: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation("app");
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ login: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setName("");
    setLogin("");
    setPassword("");
    setError(null);
    setCreated(null);
    setCopied(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setError(t("employees.passwordShort"));
      return;
    }
    setBusy(true);
    setError(null);
    const id = login.trim();
    try {
      await createEmployee({
        display_name: name.trim(),
        email: id.includes("@") ? id : undefined,
        username: id.includes("@") ? undefined : id.toLowerCase(),
        password,
        business_id: businessId ?? undefined,
      });
      setCreated({ login: id.includes("@") ? id : id.toLowerCase(), password });
      onCreated();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 409
            ? t("employees.loginTaken")
            : err.message
          : t("errors.network", { ns: "common" }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} title={created ? t("employees.createdTitle") : t("employees.addTitle")}>
      {created ? (
        <div className="form-grid">
          <p className="muted">{t("employees.createdBody")}</p>
          <div className="credentials">
            <div>
              <span className="field-hint">{t("employees.login")}</span>
              <code className="ltr">{created.login}</code>
            </div>
            <div>
              <span className="field-hint">{t("employees.password")}</span>
              <code className="ltr">{created.password}</code>
            </div>
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(`${created.login}\n${created.password}`).then(() => setCopied(true));
              }}
            >
              <Icon name={copied ? "check" : "layers"} />
              {copied ? t("employees.copied") : t("employees.copy")}
            </button>
            <button type="button" className="btn btn-primary" onClick={close}>
              {t("actions.done", { ns: "common" })}
            </button>
          </div>
        </div>
      ) : (
        <form className="form-grid" onSubmit={submit}>
          {error ? (
            <div className="alert alert-danger" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </div>
          ) : null}
          <label className="field">
            <span className="field-label">{t("employees.name")}</span>
            <input className="input" required dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">{t("employees.login")}</span>
            <input className="input" required dir="auto" autoComplete="off" value={login} onChange={(e) => setLogin(e.target.value)} placeholder={t("employees.loginPlaceholder")} />
          </label>
          <label className="field">
            <span className="field-label">{t("employees.password")}</span>
            <input className="input" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <span className="field-hint">{t("employees.passwordHint")}</span>
          </label>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={close}>
              {t("actions.cancel", { ns: "common" })}
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? t("actions.saving", { ns: "common" }) : t("employees.add")}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function EditTeam({
  employee,
  businessId,
  departments,
  roles,
  onClose,
  onSaved,
}: {
  employee: Employee | null;
  businessId: string | null;
  departments: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("app");
  const [dept, setDept] = useState<string>("");
  const [role, setRole] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [seenId, setSeenId] = useState<string | null>(null);
  if (employee && employee.id !== seenId) {
    setSeenId(employee.id);
    setDept(employee.department_id ?? "");
    setRole(employee.job_role_id ?? "");
  }

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!employee || !businessId) return;
    setBusy(true);
    setError(null);
    try {
      await assignEmployeeOrganization(businessId, employee.id, dept || null, role || null);
      setSeenId(null);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={employee !== null} onClose={() => { setSeenId(null); onClose(); }} title={t("employees.editTeamOf", { name: employee?.display_name ?? "" })}>
      <form className="form-grid" onSubmit={save}>
        <ErrorNote error={error} />
        {departments.length === 0 && roles.length === 0 ? (
          <div className="alert">
            <Icon name="info" />
            <span>
              {t("employees.noOrg")} <Link to="/settings?tab=organization">{t("employees.noOrgLink")}</Link>
            </span>
          </div>
        ) : null}
        <label className="field">
          <span className="field-label">{t("employees.department")}</span>
          <select className="select" value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">{t("employees.unassigned")}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t("employees.role")}</span>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">{t("employees.unassigned")}</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={() => { setSeenId(null); onClose(); }}>
            {t("actions.cancel", { ns: "common" })}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t("actions.saving", { ns: "common" }) : t("actions.save", { ns: "common" })}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
