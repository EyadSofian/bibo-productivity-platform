import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  assignEmployeeOrganization,
  deleteOrganizationItem,
  listBusinessEmployees,
  listOrganization,
  saveDepartment,
  saveJobRole,
} from "../api/endpoints";
import { ApiError, type Department, type Employee, type JobRole } from "../api/types";
import { Empty, Notice, Spinner } from "../components/ui";
import { useBusinesses } from "../useBusinesses";

type ItemKind = "department" | "job_role";
type ItemDraft = { kind: ItemKind; id: string | null; name: string; description: string };

const emptyDraft = (kind: ItemKind): ItemDraft => ({ kind, id: null, name: "", description: "" });

export function Organization() {
  const { t } = useTranslation("dashboard");
  const { selectedId, loading: bizLoading } = useBusinesses();
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [roles, setRoles] = useState<JobRole[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingEmployee, setPendingEmployee] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedId) return;
    setError(null);
    try {
      const [organization, employeeRes] = await Promise.all([
        listOrganization(selectedId),
        listBusinessEmployees(selectedId),
      ]);
      setDepartments(organization.departments);
      setRoles(organization.job_roles);
      setEmployees(employeeRes.employees);
    } catch (err) {
      setDepartments([]);
      setRoles([]);
      setEmployees([]);
      setError(err instanceof ApiError ? err.message : t("organization.errorLoad"));
    }
  }, [selectedId, t]);

  useEffect(() => {
    setDepartments(null);
    setDraft(null);
    void load();
  }, [load]);

  if (bizLoading) return <Spinner label={t("organization.loading")} />;
  if (!selectedId) return <Empty>{t("organization.noBusiness")}</Empty>;
  if (departments === null) return <Spinner label={t("organization.loading")} />;

  const edit = (kind: ItemKind, item: Department | JobRole) => {
    setDraft({ kind, id: item.id, name: item.name, description: item.description });
  };

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    setBusy(true);
    setError(null);
    const input = { business_id: selectedId, name: draft.name.trim(), description: draft.description.trim() };
    try {
      if (draft.kind === "department") await saveDepartment(draft.id, input);
      else await saveJobRole(draft.id, input);
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("organization.errorSave"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (kind: ItemKind, item: Department | JobRole) => {
    if (!window.confirm(t("organization.confirmDelete", { name: item.name }))) return;
    setBusy(true);
    setError(null);
    try {
      await deleteOrganizationItem(kind, item.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("organization.errorDelete"));
    } finally {
      setBusy(false);
    }
  };

  const assign = async (employee: Employee, departmentId: string | null, jobRoleId: string | null) => {
    setPendingEmployee((current) => ({ ...current, [employee.id]: true }));
    setError(null);
    try {
      const res = await assignEmployeeOrganization(selectedId, employee.id, departmentId, jobRoleId);
      setEmployees((current) => current.map((item) => item.id === employee.id ? res.employee : item));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("organization.errorAssign"));
    } finally {
      setPendingEmployee((current) => {
        const next = { ...current };
        delete next[employee.id];
        return next;
      });
    }
  };

  const itemCard = (kind: ItemKind, title: string, items: Array<Department | JobRole>) => (
    <section className="bibo-card bibo-card--default org-card">
      <div className="org-card__head">
        <div>
          <h2>{title}</h2>
          <p>{t(`organization.${kind === "department" ? "departmentsHelp" : "rolesHelp"}`)}</p>
        </div>
        <button className="bibo-btn bibo-btn--secondary bibo-btn--sm" onClick={() => setDraft(emptyDraft(kind))}>
          {t(`organization.${kind === "department" ? "newDepartment" : "newRole"}`)}
        </button>
      </div>
      {items.length === 0 ? <Empty>{t(`organization.${kind === "department" ? "emptyDepartments" : "emptyRoles"}`)}</Empty> : (
        <div className="org-list">
          {items.map((item) => (
            <div key={item.id} className="org-list__item">
              <div className="org-list__copy">
                <strong>{item.name}</strong>
                <span>{item.description || t("organization.noDescription")}</span>
              </div>
              <div className="org-list__actions">
                <button className="bibo-btn bibo-btn--ghost bibo-btn--sm" onClick={() => edit(kind, item)}>{t("organization.edit")}</button>
                <button className="bibo-btn bibo-btn--ghost bibo-btn--sm" disabled={busy} onClick={() => void remove(kind, item)}>{t("organization.delete")}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="ad-page">
      <div className="ad-pagehead">
        <div className="ad-pagehead__main">
          <h1 className="ad-h1">{t("organization.title")}</h1>
          <p className="ad-sub">{t("organization.subtitle")}</p>
        </div>
      </div>

      {error && <Notice kind="danger">{error}</Notice>}

      <div className="org-grid">
        {itemCard("department", t("organization.departments"), departments)}
        {itemCard("job_role", t("organization.roles"), roles)}
      </div>

      <section className="bibo-card bibo-card--default org-assignments">
        <div className="org-card__head">
          <div>
            <h2>{t("organization.assignments")}</h2>
            <p>{t("organization.assignmentsHelp")}</p>
          </div>
        </div>
        {employees.length === 0 ? <Empty>{t("organization.emptyEmployees")}</Empty> : (
          <div className="ad-tablecard org-tablewrap">
            <table className="ad-table org-table">
              <thead><tr><th>{t("organization.employee")}</th><th>{t("organization.department")}</th><th>{t("organization.role")}</th></tr></thead>
              <tbody>
                {employees.map((employee) => {
                  const pending = !!pendingEmployee[employee.id];
                  return (
                    <tr key={employee.id}>
                      <td><strong>{employee.display_name}</strong><div className="ad-muted">{employee.email || employee.username}</div></td>
                      <td>
                        <select aria-label={t("organization.departmentFor", { name: employee.display_name })} disabled={pending} value={employee.department_id ?? ""} onChange={(event) => void assign(employee, event.target.value || null, employee.job_role_id)}>
                          <option value="">{t("organization.unassigned")}</option>
                          {departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                      </td>
                      <td>
                        <select aria-label={t("organization.roleFor", { name: employee.display_name })} disabled={pending} value={employee.job_role_id ?? ""} onChange={(event) => void assign(employee, employee.department_id, event.target.value || null)}>
                          <option value="">{t("organization.unassigned")}</option>
                          {roles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {draft && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDraft(null)}>
          <section className="bibo-dlg org-dialog" role="dialog" aria-modal="true" aria-labelledby="organization-editor-title">
            <div className="bibo-dlg__head">
              <h2 id="organization-editor-title" className="bibo-dlg__title">{t(`organization.${draft.id ? "editTitle" : "createTitle"}`, { type: t(`organization.${draft.kind === "department" ? "department" : "role"}`) })}</h2>
              <button className="bibo-dlg__close" aria-label={t("organization.close")} onClick={() => setDraft(null)}>×</button>
            </div>
            <div className="bibo-dlg__body mp-form">
              <label className="bibo-field"><span>{t("organization.name")}</span><input autoFocus maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
              <label className="bibo-field"><span>{t("organization.description")}</span><textarea rows={3} maxLength={1000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
            </div>
            <div className="bibo-dlg__foot">
              <button className="bibo-btn bibo-btn--ghost" onClick={() => setDraft(null)}>{t("organization.cancel")}</button>
              <button className="bibo-btn bibo-btn--primary" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{busy ? t("organization.saving") : t("organization.save")}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
