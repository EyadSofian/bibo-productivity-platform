import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { cancelTask, createTask, getTaskAnalysis, getTaskTimeline, listBusinessEmployees, listTasks } from "../api/endpoints";
import { ApiError, type Employee, type TaskAnalysis, type TaskPriority, type TaskTimeline, type WorkTask } from "../api/types";
import { Empty, Notice, Spinner } from "../components/ui";
import { activeLocale } from "../i18n";
import { useBusinesses } from "../useBusinesses";

type Draft = {
  title: string;
  description: string;
  workType: string;
  assignee: string;
  priority: TaskPriority;
  estimate: string;
  due: string;
};

const blank: Draft = { title: "", description: "", workType: "general", assignee: "", priority: "normal", estimate: "", due: "" };

function duration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function Tasks() {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const { selectedId, loading: businessLoading } = useBusinesses();
  const [tasks, setTasks] = useState<WorkTask[] | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<WorkTask | null>(null);
  const [timeline, setTimeline] = useState<TaskTimeline | null>(null);
  const [analysis, setAnalysis] = useState<TaskAnalysis | null>(null);

  const load = useCallback(async () => {
    if (!selectedId) return;
    try {
      const [taskRes, employeeRes] = await Promise.all([listTasks(selectedId), listBusinessEmployees(selectedId)]);
      setTasks(taskRes.tasks);
      setEmployees(employeeRes.employees);
      setError("");
    } catch (err) {
      setTasks([]);
      setError(err instanceof ApiError ? err.message : t("tasks.errorLoad"));
    }
  }, [selectedId, t]);

  useEffect(() => {
    setTasks(null);
    void load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const counts = useMemo(() => ({
    active: tasks?.filter((task) => task.status === "in_progress").length ?? 0,
    open: tasks?.filter((task) => !["completed", "cancelled"].includes(task.status)).length ?? 0,
    completed: tasks?.filter((task) => task.status === "completed").length ?? 0,
  }), [tasks]);

  async function save() {
    if (!selectedId || !draft || !draft.title.trim() || !draft.assignee) return;
    setSaving(true);
    setError("");
    try {
      await createTask({
        business_id: selectedId,
        assignee_user_id: draft.assignee,
        title: draft.title.trim(),
        description: draft.description.trim(),
        work_type: draft.workType.trim() || "general",
        priority: draft.priority,
        estimated_minutes: draft.estimate ? Number(draft.estimate) : null,
        due_at: draft.due ? new Date(draft.due).toISOString() : null,
      });
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("tasks.errorCreate"));
    } finally {
      setSaving(false);
    }
  }

  async function inspect(task: WorkTask) {
    setSelected(task);
    setTimeline(null);
    setAnalysis(null);
    try {
      const [timelineResult, analysisResult] = await Promise.all([getTaskTimeline(task.id), getTaskAnalysis(task.id)]);
      setTimeline(timelineResult);
      setAnalysis(analysisResult);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("tasks.errorLoad"));
    }
  }

  async function cancelSelected() {
    if (!selected) return;
    setCancelling(true);
    try {
      await cancelTask(selected.id);
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("tasks.errorCreate"));
    } finally {
      setCancelling(false);
    }
  }

  if (businessLoading) return <Spinner label={t("tasks.loading")} />;
  if (!selectedId) return <Empty>{t("tasks.noBusiness")}</Empty>;
  if (tasks === null) return <Spinner label={t("tasks.loading")} />;

  return (
    <div className="ad-page task-admin">
      <div className="ad-pagehead">
        <div className="ad-pagehead__main">
          <span className="task-admin__eyebrow">{t("tasks.eyebrow")}</span>
          <h1 className="ad-h1">{t("tasks.title")}</h1>
          <p className="ad-sub">{t("tasks.subtitle")}</p>
        </div>
        <button className="bibo-btn bibo-btn--primary" disabled={!employees.length} onClick={() => setDraft({ ...blank, assignee: employees[0]?.id ?? "" })}>{t("tasks.new")}</button>
      </div>

      {error && <Notice kind="danger">{error}</Notice>}
      <div className="task-admin__stats">
        <div><span>{t("tasks.active")}</span><strong>{counts.active}</strong></div>
        <div><span>{t("tasks.open")}</span><strong>{counts.open}</strong></div>
        <div><span>{t("tasks.completed")}</span><strong>{counts.completed}</strong></div>
      </div>

      {tasks.length === 0 ? <Empty>{employees.length ? t("tasks.empty") : t("tasks.noEmployees")}</Empty> : (
        <div className="task-board">
          {tasks.map((task) => (
            <article key={task.id} className={`task-admin-card task-admin-card--${task.status}`} onClick={() => void inspect(task)}>
              <div className="task-admin-card__top">
                <span className={`task-admin-card__priority task-admin-card__priority--${task.priority}`}>{t(`tasks.priority.${task.priority}`)}</span>
                <span className="task-admin-card__status"><i />{t(`tasks.status.${task.status}`)}</span>
              </div>
              <h2>{task.title}</h2>
              <p>{task.description || t("tasks.noDescription")}</p>
              <div className="task-admin-card__employee"><span>{task.assignee_name.slice(0, 2).toUpperCase()}</span><strong>{task.assignee_name}</strong></div>
              <div className="task-admin-card__metrics">
                <div><span>{t("tasks.tracked")}</span><strong>{duration(task.tracked_seconds)}</strong></div>
                <div><span>{t("tasks.estimate")}</span><strong>{task.estimated_minutes ? duration(task.estimated_minutes * 60) : "—"}</strong></div>
                <div><span>{t("tasks.due")}</span><strong>{task.due_at ? new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(new Date(task.due_at)) : "—"}</strong></div>
              </div>
            </article>
          ))}
        </div>
      )}

      {draft && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDraft(null)}>
          <section className="bibo-dlg task-dialog" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title">
            <div className="bibo-dlg__head"><h2 id="task-dialog-title" className="bibo-dlg__title">{t("tasks.createTitle")}</h2><button className="bibo-dlg__close" onClick={() => setDraft(null)}>×</button></div>
            <div className="bibo-dlg__body task-form">
              <label className="bibo-field"><span>{t("tasks.name")}</span><input autoFocus maxLength={180} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
              <label className="bibo-field"><span>{t("tasks.description")}</span><textarea rows={3} maxLength={5000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
              <label className="bibo-field"><span>{t("tasks.workType")}</span><input maxLength={80} value={draft.workType} onChange={(event) => setDraft({ ...draft, workType: event.target.value })} placeholder={t("tasks.workTypeHint")} /></label>
              <div className="task-form__row">
                <label className="bibo-field"><span>{t("tasks.assignee")}</span><select value={draft.assignee} onChange={(event) => setDraft({ ...draft, assignee: event.target.value })}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.display_name}</option>)}</select></label>
                <label className="bibo-field"><span>{t("tasks.priorityLabel")}</span><select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as TaskPriority })}>{(["low", "normal", "high", "urgent"] as const).map((priority) => <option key={priority} value={priority}>{t(`tasks.priority.${priority}`)}</option>)}</select></label>
              </div>
              <div className="task-form__row">
                <label className="bibo-field"><span>{t("tasks.estimateMinutes")}</span><input type="number" min="1" value={draft.estimate} onChange={(event) => setDraft({ ...draft, estimate: event.target.value })} /></label>
                <label className="bibo-field"><span>{t("tasks.dueAt")}</span><input type="datetime-local" value={draft.due} onChange={(event) => setDraft({ ...draft, due: event.target.value })} /></label>
              </div>
            </div>
            <div className="bibo-dlg__foot"><button className="bibo-btn bibo-btn--ghost" onClick={() => setDraft(null)}>{t("tasks.cancel")}</button><button className="bibo-btn bibo-btn--primary" disabled={saving || !draft.title.trim() || !draft.assignee} onClick={() => void save()}>{saving ? t("tasks.saving") : t("tasks.create")}</button></div>
          </section>
        </div>
      )}

      {selected && (
        <div className="modal-backdrop task-review-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelected(null)}>
          <section className="bibo-dlg task-review" role="dialog" aria-modal="true">
            <div className="bibo-dlg__head"><div><span className="task-admin__eyebrow">{selected.assignee_name}</span><h2 className="bibo-dlg__title">{selected.title}</h2></div><button className="bibo-dlg__close" onClick={() => setSelected(null)}>×</button></div>
            <div className="bibo-dlg__body task-review__body">
              {!timeline || !analysis ? <Spinner label={t("tasks.loadingEvidence")} /> : (
                <>
                  <div className="task-review__scorecard">
                    <div><span>{t("tasks.tracked")}</span><strong>{duration(analysis.tracked_seconds)}</strong></div>
                    <div><span>{t("tasks.coverage")}</span><strong>{analysis.evidence_coverage_pct}%</strong></div>
                    <div><span>{t("tasks.baseline")}</span><strong>{analysis.baseline_samples}</strong></div>
                  </div>
                  <div className="task-review__insights">
                    {analysis.insights.map((insight) => <div key={insight.code} className={`task-insight task-insight--${insight.tone}`}><i /><div><strong>{insight.title}</strong><p>{insight.detail}</p></div></div>)}
                  </div>
                  <div className="task-review__timeline">
                    <h3>{t("tasks.evidenceTimeline")}</h3>
                    {timeline.events.length === 0 ? <Empty>{t("tasks.noEvidence")}</Empty> : timeline.events.slice(-100).reverse().map((event, index) => (
                      <button key={`${event.kind}-${event.ts}-${index}`} className="task-event" disabled={!event.recording_id} onClick={() => navigate(`/employees/${selected.assignee_user_id}?business=${selected.business_id}&tab=playback&at=${event.ts}`)}>
                        <span className={`task-event__kind task-event__kind--${event.kind}`}>{event.kind === "browser" ? "WEB" : "APP"}</span>
                        <span><strong>{event.title || event.app_name}</strong><small>{event.app_name} · {new Date(event.ts * 1000).toLocaleTimeString()}</small></span>
                        <em>{event.recording_id ? t("tasks.openVideo") : t("tasks.videoPending")}</em>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {!["completed", "cancelled"].includes(selected.status) && (
              <div className="bibo-dlg__foot">
                <button className="bibo-btn bibo-btn--danger" disabled={cancelling} onClick={() => void cancelSelected()}>
                  {cancelling ? t("tasks.saving") : t("tasks.cancel")}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
