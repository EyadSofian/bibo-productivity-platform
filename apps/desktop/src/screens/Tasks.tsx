import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { call as invoke } from "../api";

type EmployeeTask = {
  id: string;
  title: string;
  description: string;
  work_type: string;
  status: "assigned" | "in_progress" | "paused" | "completed";
  priority: "low" | "normal" | "high" | "urgent";
  estimated_minutes: number | null;
  due_at: string | null;
  tracked_seconds: number;
};

function duration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function Tasks() {
  const { t } = useTranslation("screens");
  const [tasks, setTasks] = useState<EmployeeTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setTasks(await invoke<EmployeeTask[]>("tasks_mine"));
      setError("");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const active = useMemo(() => tasks.find((task) => task.status === "in_progress"), [tasks]);

  async function act(task: EmployeeTask, action: "start" | "pause" | "complete") {
    setBusy(task.id);
    setError("");
    try {
      const updated = await invoke<EmployeeTask>("task_action", { taskId: task.id, action });
      setTasks((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="muted">{t("tasks.loading")}</div>;

  return (
    <div className="task-page">
      <section className="task-hero">
        <div>
          <span className="task-eyebrow">{t("tasks.eyebrow")}</span>
          <h2>{active ? active.title : t("tasks.noActiveTitle")}</h2>
          <p>{active ? t("tasks.activeHelp") : t("tasks.noActiveHelp")}</p>
        </div>
        {active && (
          <div className="task-clock">
            <strong>{duration(active.tracked_seconds)}</strong>
            <span>{t("tasks.tracked")}</span>
          </div>
        )}
      </section>

      {error && <div className="notice notice-danger">{error}</div>}
      {tasks.length === 0 ? (
        <div className="card task-empty">{t("tasks.empty")}</div>
      ) : (
        <div className="task-list">
          {tasks.map((task) => {
            const isActive = task.status === "in_progress";
            const isDone = task.status === "completed";
            return (
              <article key={task.id} className={`card task-card${isActive ? " task-card--active" : ""}`}>
                <div className="task-card__main">
                  <div className="task-card__meta">
                    <span className={`task-priority task-priority--${task.priority}`}>{t(`tasks.priority.${task.priority}`)}</span>
                    <span>{t(`tasks.status.${task.status}`)}</span>
                    <span>{task.work_type}</span>
                  </div>
                  <h3>{task.title}</h3>
                  {task.description && <p>{task.description}</p>}
                  <div className="task-card__facts">
                    <span>{t("tasks.actual")}: <strong>{duration(task.tracked_seconds)}</strong></span>
                    {task.estimated_minutes && <span>{t("tasks.estimate")}: <strong>{duration(task.estimated_minutes * 60)}</strong></span>}
                    {task.due_at && <span>{t("tasks.due")}: <strong>{new Date(task.due_at).toLocaleString()}</strong></span>}
                  </div>
                </div>
                <div className="task-card__actions">
                  {isActive ? (
                    <>
                      <button className="btn btn-ghost" disabled={busy === task.id} onClick={() => void act(task, "pause")}>{t("tasks.pause")}</button>
                      <button className="btn btn-primary" disabled={busy === task.id} onClick={() => void act(task, "complete")}>{t("tasks.complete")}</button>
                    </>
                  ) : !isDone ? (
                    <button className="btn btn-primary" disabled={busy === task.id || !!active} onClick={() => void act(task, "start")}>{t(task.status === "paused" ? "tasks.resume" : "tasks.start")}</button>
                  ) : <span className="task-done">✓ {t("tasks.done")}</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
