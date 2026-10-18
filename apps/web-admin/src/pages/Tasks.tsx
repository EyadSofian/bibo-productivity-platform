import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { cancelTask, createTask, getTaskAnalysis, getTaskTimeline, listBusinessEmployees, listTasks } from "../api/endpoints";
import { ApiError, type TaskPriority, type TaskStatus, type WorkTask } from "../api/types";
import { usePageHeader } from "../app/AppShell";
import { useBusinesses } from "../app/useBusinesses";
import { fmtDateTime, fmtDuration } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { Icon } from "../ui/Icon";
import { Avatar, Card, Dialog, Empty, ErrorNote, LoadingRows, Segmented, UsageList } from "../ui/kit";

type Filter = "open" | "done" | "all";

const STATUS_TONE: Record<TaskStatus, string> = {
  assigned: "",
  in_progress: "badge-brand",
  paused: "badge-warn",
  completed: "badge-ok",
  cancelled: "",
};

const PRIORITY_TONE: Record<TaskPriority, string> = {
  low: "",
  normal: "",
  high: "badge-warn",
  urgent: "badge-danger",
};

export default function Tasks() {
  const { t } = useTranslation("app");
  const { selectedId } = useBusinesses();
  const [filter, setFilter] = useState<Filter>("open");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<WorkTask | null>(null);

  const tasks = useAsync(
    () => (selectedId ? listTasks(selectedId) : Promise.resolve({ tasks: [] as WorkTask[] })),
    [selectedId],
    30_000,
  );
  const employees = useAsync(
    () => (selectedId ? listBusinessEmployees(selectedId) : Promise.resolve({ employees: [] })),
    [selectedId],
  );

  const all = tasks.data?.tasks ?? [];
  const list = useMemo(
    () =>
      all
        .filter((task) =>
          filter === "all" ? true : filter === "done" ? task.status === "completed" || task.status === "cancelled" : task.status !== "completed" && task.status !== "cancelled",
        )
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    [all, filter],
  );
  const running = all.filter((task) => task.status === "in_progress").length;

  usePageHeader(t("tasks.title"), t("tasks.subtitle", { count: all.length, running }));

  return (
    <div className="page">
      <Card
        title={t("tasks.listTitle")}
        actions={
          <>
            <Segmented<Filter>
              value={filter}
              onChange={setFilter}
              label={t("tasks.filter")}
              options={[
                { value: "open", label: t("tasks.open") },
                { value: "done", label: t("tasks.done") },
                { value: "all", label: t("tasks.all") },
              ]}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              <span className="hide-sm">{t("tasks.new")}</span>
            </button>
          </>
        }
      >
        <ErrorNote error={tasks.error} onRetry={tasks.reload} />
        {tasks.loading && !tasks.data ? (
          <LoadingRows rows={5} />
        ) : list.length === 0 ? (
          <Empty icon="tasks" title={t("tasks.none")}>
            {t("tasks.noneHint")}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("tasks.task")}</th>
                  <th>{t("tasks.assignee")}</th>
                  <th>{t("table.status")}</th>
                  <th className="end">{t("tasks.tracked")}</th>
                  <th className="end hide-sm">{t("tasks.due")}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((task) => (
                  <tr key={task.id} className="is-link" onClick={() => setSelected(task)}>
                    <td>
                      <span className="person-text">
                        <span className="person-name">{task.title}</span>
                        <span className="chip-row" style={{ marginBlockStart: 4 }}>
                          {task.priority !== "normal" ? <span className={`badge ${PRIORITY_TONE[task.priority]}`}>{t(`tasks.priority.${task.priority}`)}</span> : null}
                          {task.work_type ? <span className="badge">{task.work_type}</span> : null}
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="person">
                        <Avatar name={task.assignee_name || "?"} size="sm" />
                        <span className="person-name">{task.assignee_name}</span>
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_TONE[task.status]}`}>
                        {task.status === "in_progress" ? <span className="dot dot-active" /> : null}
                        {t(`tasks.status.${task.status}`)}
                      </span>
                    </td>
                    <td className="end num strong">
                      {fmtDuration(task.tracked_seconds)}
                      {task.estimated_minutes ? <span className="muted"> / {fmtDuration(task.estimated_minutes * 60)}</span> : null}
                    </td>
                    <td className="end muted hide-sm">{task.due_at ? fmtDateTime(Date.parse(task.due_at) / 1000) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <NewTask
        open={creating}
        businessId={selectedId}
        employees={employees.data?.employees ?? []}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          tasks.reload();
        }}
      />
      <TaskDetail
        task={selected}
        onClose={() => setSelected(null)}
        onChanged={() => {
          setSelected(null);
          tasks.reload();
        }}
      />
    </div>
  );
}

function NewTask({
  open,
  businessId,
  employees,
  onClose,
  onCreated,
}: {
  open: boolean;
  businessId: string | null;
  employees: Array<{ id: string; display_name: string }>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation("app");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [estimate, setEstimate] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!businessId) return;
    setBusy(true);
    setError(null);
    try {
      await createTask({
        business_id: businessId,
        assignee_user_id: assignee,
        title: title.trim(),
        description: description.trim(),
        priority,
        estimated_minutes: estimate ? Math.max(1, Math.round(Number(estimate) * 60)) : null,
        due_at: due ? new Date(due).toISOString() : null,
      });
      setTitle("");
      setDescription("");
      setEstimate("");
      setDue("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("errors.network", { ns: "common" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("tasks.newTitle")}>
      <form className="form-grid" onSubmit={submit}>
        {error ? <div className="alert alert-danger">{error}</div> : null}
        <label className="field">
          <span className="field-label">{t("tasks.titleField")}</span>
          <input className="input" required dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t("tasks.assignee")}</span>
          <select className="select" required value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="" disabled>
              {t("tasks.pickAssignee")}
            </option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t("tasks.description")}</span>
          <textarea className="textarea" dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="form-row">
          <label className="field">
            <span className="field-label">{t("tasks.priorityLabel")}</span>
            <select className="select" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              {(["low", "normal", "high", "urgent"] as const).map((p) => (
                <option key={p} value={p}>
                  {t(`tasks.priority.${p}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t("tasks.estimate")}</span>
            <input className="input" type="number" min="0.25" step="0.25" inputMode="decimal" value={estimate} onChange={(e) => setEstimate(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span className="field-label">{t("tasks.due")}</span>
          <input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("actions.cancel", { ns: "common" })}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !assignee}>
            {busy ? t("actions.saving", { ns: "common" }) : t("tasks.create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function TaskDetail({ task, onClose, onChanged }: { task: WorkTask | null; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation("app");
  const [cancelling, setCancelling] = useState(false);
  const detail = useAsync(
    async () => {
      if (!task) return null;
      const [timeline, analysis] = await Promise.all([
        getTaskTimeline(task.id).catch(() => null),
        getTaskAnalysis(task.id).catch(() => null),
      ]);
      return { timeline, analysis };
    },
    [task?.id],
  );
  if (!task) return <Dialog open={false} onClose={onClose} title="">{null}</Dialog>;
  const apps = detail.data?.timeline?.applications ?? [];
  const analysis = detail.data?.analysis;
  const closed = task.status === "completed" || task.status === "cancelled";

  return (
    <Dialog open onClose={onClose} title={task.title} wide>
      <div className="form-grid">
        <div className="chip-row">
          <span className={`badge ${STATUS_TONE[task.status]}`}>{t(`tasks.status.${task.status}`)}</span>
          <span className={`badge ${PRIORITY_TONE[task.priority]}`}>{t(`tasks.priority.${task.priority}`)}</span>
          <span className="badge">
            <Icon name="user" />
            {task.assignee_name}
          </span>
          <span className="badge">
            <Icon name="clock" />
            {fmtDuration(task.tracked_seconds)}
          </span>
        </div>
        {task.description ? <p style={{ whiteSpace: "pre-wrap" }}>{task.description}</p> : null}

        {detail.loading ? (
          <LoadingRows rows={3} />
        ) : (
          <>
            {analysis && analysis.insights.length > 0 ? (
              <div className="insights">
                {analysis.insights.map((i) => (
                  <div key={i.code} className={`alert ${i.tone === "positive" ? "alert-ok" : i.tone === "watch" ? "alert-warn" : ""}`}>
                    <Icon name={i.tone === "watch" ? "alert" : i.tone === "positive" ? "check" : "info"} />
                    <span>
                      <strong>{i.title}</strong>
                      <br />
                      {i.detail}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <div>
              <h3 className="card-title" style={{ marginBlockEnd: 10 }}>{t("tasks.appsUsed")}</h3>
              <UsageList
                items={apps.map((a) => ({ key: a.app_name, name: a.app_name, seconds: a.seconds }))}
                total={apps.reduce((s, a) => s + a.seconds, 0)}
                format={fmtDuration}
                emptyTitle={t("tasks.noEvidence")}
              />
            </div>
          </>
        )}

        {!closed ? (
          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn-danger"
              disabled={cancelling}
              onClick={async () => {
                setCancelling(true);
                try {
                  await cancelTask(task.id);
                  onChanged();
                } finally {
                  setCancelling(false);
                }
              }}
            >
              <Icon name="x" />
              {t("tasks.cancel")}
            </button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
