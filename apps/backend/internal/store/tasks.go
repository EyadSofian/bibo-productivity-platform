package store

import (
	"context"
	"errors"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

type Task struct {
	ID               string     `json:"id"`
	BusinessID       string     `json:"business_id"`
	AssigneeUserID   string     `json:"assignee_user_id"`
	AssigneeName     string     `json:"assignee_name"`
	CreatedBy        string     `json:"created_by"`
	Title            string     `json:"title"`
	Description      string     `json:"description"`
	WorkType         string     `json:"work_type"`
	Status           string     `json:"status"`
	Priority         string     `json:"priority"`
	EstimatedMinutes *int       `json:"estimated_minutes"`
	DueAt            *time.Time `json:"due_at"`
	StartedAt        *time.Time `json:"started_at"`
	CompletedAt      *time.Time `json:"completed_at"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
	TrackedSeconds   int64      `json:"tracked_seconds"`
	ActiveSessionID  string     `json:"active_session_id,omitempty"`
}

type NewTask struct {
	BusinessID       string
	AssigneeUserID   string
	Title            string
	Description      string
	WorkType         string
	Priority         string
	EstimatedMinutes *int
	DueAt            *time.Time
}

type TaskWorkSession struct {
	ID             string     `json:"id"`
	TaskID         string     `json:"task_id"`
	BusinessID     string     `json:"business_id"`
	EmployeeUserID string     `json:"employee_user_id"`
	DeviceID       string     `json:"device_id,omitempty"`
	StartedAt      time.Time  `json:"started_at"`
	EndedAt        *time.Time `json:"ended_at,omitempty"`
	EndReason      string     `json:"end_reason,omitempty"`
}

const taskColumns = `
	t.id, t.business_id, t.assignee_user_id, u.display_name, t.created_by,
	t.title, t.description, t.work_type, t.status, t.priority, t.estimated_minutes, t.due_at,
	t.started_at, t.completed_at, t.created_at, t.updated_at,
	COALESCE(ws.tracked_seconds, 0), COALESCE(ws.active_session_id, '')`

const taskJoins = `
	JOIN users u ON u.id=t.assignee_user_id
	LEFT JOIN LATERAL (
		SELECT COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(w.ended_at, now()) - w.started_at))), 0)::bigint AS tracked_seconds,
		       max(w.id::text) FILTER (WHERE w.ended_at IS NULL) AS active_session_id
		  FROM task_work_sessions w WHERE w.task_id=t.id
	) ws ON true`

func scanTask(row pgx.Row) (Task, error) {
	var item Task
	err := row.Scan(&item.ID, &item.BusinessID, &item.AssigneeUserID, &item.AssigneeName,
		&item.CreatedBy, &item.Title, &item.Description, &item.WorkType, &item.Status, &item.Priority,
		&item.EstimatedMinutes, &item.DueAt, &item.StartedAt, &item.CompletedAt,
		&item.CreatedAt, &item.UpdatedAt, &item.TrackedSeconds, &item.ActiveSessionID)
	return item, err
}

func (s *Store) CreateTask(ctx context.Context, ownerID string, in NewTask) (Task, error) {
	if in.WorkType == "" {
		in.WorkType = "general"
	}
	if in.Priority == "" {
		in.Priority = "normal"
	}
	var taskID string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO tasks (business_id, assignee_user_id, created_by, title, description, work_type, priority, estimated_minutes, due_at)
		SELECT b.id, m.user_id, $1, $4, $5, $6, $7, $8, $9
		  FROM businesses b
		  JOIN memberships m ON m.business_id=b.id AND m.user_id=$3 AND m.role='employee'
		 WHERE b.id=$2 AND b.owner_user_id=$1
		RETURNING id`, ownerID, in.BusinessID, in.AssigneeUserID, in.Title, in.Description,
		in.WorkType, in.Priority, in.EstimatedMinutes, in.DueAt).Scan(&taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Task{}, ErrNotFound
	}
	if err != nil {
		return Task{}, err
	}
	_, _ = s.pool.Exec(ctx, `INSERT INTO task_events (task_id,business_id,actor_id,event_type) VALUES ($1,$2,$3,'created')`, taskID, in.BusinessID, ownerID)
	return s.taskForOwner(ctx, ownerID, taskID)
}

func (s *Store) ListTasksForOwner(ctx context.Context, ownerID, businessID string) ([]Task, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+taskColumns+` FROM tasks t `+taskJoins+`
		JOIN businesses b ON b.id=t.business_id AND b.owner_user_id=$1
		WHERE t.business_id=$2 ORDER BY
		CASE t.status WHEN 'in_progress' THEN 0 WHEN 'paused' THEN 1 WHEN 'assigned' THEN 2 ELSE 3 END,
		t.updated_at DESC`, ownerID, businessID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		item, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) ListTasksForEmployee(ctx context.Context, employeeID string) ([]Task, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+taskColumns+` FROM tasks t `+taskJoins+`
		JOIN memberships m ON m.business_id=t.business_id AND m.user_id=$1 AND m.role='employee'
		WHERE t.assignee_user_id=$1 AND t.status <> 'cancelled'
		ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'paused' THEN 1 WHEN 'assigned' THEN 2 ELSE 3 END, t.updated_at DESC`, employeeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		item, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) taskForOwner(ctx context.Context, ownerID, taskID string) (Task, error) {
	item, err := scanTask(s.pool.QueryRow(ctx, `SELECT `+taskColumns+` FROM tasks t `+taskJoins+`
		JOIN businesses b ON b.id=t.business_id AND b.owner_user_id=$1 WHERE t.id=$2`, ownerID, taskID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Task{}, ErrNotFound
	}
	return item, err
}

func (s *Store) StartTask(ctx context.Context, employeeID, taskID, deviceID string) (Task, TaskWorkSession, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Task{}, TaskWorkSession{}, err
	}
	defer tx.Rollback(ctx)
	var businessID, status string
	err = tx.QueryRow(ctx, `SELECT t.business_id, t.status FROM tasks t
		JOIN memberships m ON m.business_id=t.business_id AND m.user_id=$1 AND m.role='employee'
		WHERE t.id=$2 AND t.assignee_user_id=$1 FOR UPDATE`, employeeID, taskID).Scan(&businessID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return Task{}, TaskWorkSession{}, ErrNotFound
	}
	if err != nil {
		return Task{}, TaskWorkSession{}, err
	}
	if status == "completed" || status == "cancelled" {
		return Task{}, TaskWorkSession{}, ErrConflict
	}
	var ws TaskWorkSession
	var nullableDevice any
	if deviceID != "" {
		var valid bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM devices WHERE id=$1 AND user_id=$2 AND business_id=$3 AND deleted_at IS NULL)`, deviceID, employeeID, businessID).Scan(&valid); err != nil {
			return Task{}, TaskWorkSession{}, err
		}
		if !valid {
			return Task{}, TaskWorkSession{}, ErrForbidden
		}
		nullableDevice = deviceID
	}
	err = tx.QueryRow(ctx, `INSERT INTO task_work_sessions (task_id,business_id,employee_user_id,device_id)
		VALUES ($1,$2,$3,$4) RETURNING id,task_id,business_id,employee_user_id,COALESCE(device_id::text,''),started_at,ended_at,COALESCE(end_reason,'')`,
		taskID, businessID, employeeID, nullableDevice).Scan(&ws.ID, &ws.TaskID, &ws.BusinessID, &ws.EmployeeUserID, &ws.DeviceID, &ws.StartedAt, &ws.EndedAt, &ws.EndReason)
	if isUniqueViolation(err) {
		return Task{}, TaskWorkSession{}, ErrConflict
	}
	if err != nil {
		return Task{}, TaskWorkSession{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE tasks SET status='in_progress', started_at=COALESCE(started_at,now()), completed_at=NULL, updated_at=now() WHERE id=$1`, taskID); err != nil {
		return Task{}, TaskWorkSession{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_events (task_id,business_id,actor_id,event_type,metadata) VALUES ($1,$2,$3,'started',jsonb_build_object('work_session_id',$4::text))`, taskID, businessID, employeeID, ws.ID); err != nil {
		return Task{}, TaskWorkSession{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Task{}, TaskWorkSession{}, err
	}
	task, err := s.taskForEmployee(ctx, employeeID, taskID)
	return task, ws, err
}

func (s *Store) EndTaskWork(ctx context.Context, employeeID, taskID, action string) (Task, error) {
	status, reason, eventType := "paused", "paused", "paused"
	if action == "complete" {
		status, reason, eventType = "completed", "completed", "completed"
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback(ctx)
	var businessID string
	err = tx.QueryRow(ctx, `SELECT t.business_id FROM tasks t
		JOIN memberships m ON m.business_id=t.business_id AND m.user_id=$1 AND m.role='employee'
		WHERE t.id=$2 AND t.assignee_user_id=$1 AND t.status='in_progress' FOR UPDATE`, employeeID, taskID).Scan(&businessID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Task{}, ErrConflict
	}
	if err != nil {
		return Task{}, err
	}
	ct, err := tx.Exec(ctx, `UPDATE task_work_sessions SET ended_at=now(),end_reason=$3 WHERE task_id=$1 AND employee_user_id=$2 AND ended_at IS NULL`, taskID, employeeID, reason)
	if err != nil {
		return Task{}, err
	}
	if ct.RowsAffected() != 1 {
		return Task{}, ErrConflict
	}
	completedSQL := "NULL"
	if status == "completed" {
		completedSQL = "now()"
	}
	if _, err := tx.Exec(ctx, `UPDATE tasks SET status=$2, completed_at=`+completedSQL+`, updated_at=now() WHERE id=$1`, taskID, status); err != nil {
		return Task{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_events (task_id,business_id,actor_id,event_type) VALUES ($1,$2,$3,$4)`, taskID, businessID, employeeID, eventType); err != nil {
		return Task{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Task{}, err
	}
	return s.taskForEmployee(ctx, employeeID, taskID)
}

func (s *Store) CancelTaskForOwner(ctx context.Context, ownerID, taskID string) (Task, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback(ctx)
	var businessID, status string
	err = tx.QueryRow(ctx, `SELECT t.business_id, t.status FROM tasks t
		JOIN businesses b ON b.id=t.business_id AND b.owner_user_id=$1
		WHERE t.id=$2 FOR UPDATE`, ownerID, taskID).Scan(&businessID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return Task{}, ErrNotFound
	}
	if err != nil {
		return Task{}, err
	}
	if status == "completed" || status == "cancelled" {
		return Task{}, ErrConflict
	}
	if _, err := tx.Exec(ctx, `UPDATE task_work_sessions SET ended_at=now(),end_reason='cancelled'
		WHERE task_id=$1 AND ended_at IS NULL`, taskID); err != nil {
		return Task{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE tasks SET status='cancelled',completed_at=NULL,updated_at=now() WHERE id=$1`, taskID); err != nil {
		return Task{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_events (task_id,business_id,actor_id,event_type)
		VALUES ($1,$2,$3,'cancelled')`, taskID, businessID, ownerID); err != nil {
		return Task{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Task{}, err
	}
	return s.taskForOwner(ctx, ownerID, taskID)
}

func (s *Store) taskForEmployee(ctx context.Context, employeeID, taskID string) (Task, error) {
	item, err := scanTask(s.pool.QueryRow(ctx, `SELECT `+taskColumns+` FROM tasks t `+taskJoins+`
		JOIN memberships m ON m.business_id=t.business_id AND m.user_id=$1 AND m.role='employee'
		WHERE t.id=$2 AND t.assignee_user_id=$1`, employeeID, taskID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Task{}, ErrNotFound
	}
	return item, err
}

type TaskTimelineEvent struct {
	Kind          string `json:"kind"`
	Timestamp     int64  `json:"ts"`
	DurationS     int64  `json:"duration_s"`
	AppName       string `json:"app_name,omitempty"`
	Title         string `json:"title,omitempty"`
	URL           string `json:"url,omitempty"`
	RecordingID   string `json:"recording_id,omitempty"`
	VideoOffsetMS *int64 `json:"video_offset_ms,omitempty"`
}

type TaskAppTotal struct {
	AppName string `json:"app_name"`
	Seconds int64  `json:"seconds"`
}

type TaskTimeline struct {
	Task         Task                `json:"task"`
	Sessions     []TaskWorkSession   `json:"work_sessions"`
	Events       []TaskTimelineEvent `json:"events"`
	Applications []TaskAppTotal      `json:"applications"`
}

// TaskTimelineForMember returns only evidence inside measured work sessions.
// Owners can review every task; an employee can read only their own assignment.
func (s *Store) TaskTimelineForMember(ctx context.Context, userID, taskID string) (TaskTimeline, error) {
	var role string
	err := s.pool.QueryRow(ctx, `SELECT m.role FROM tasks t
		JOIN memberships m ON m.business_id=t.business_id AND m.user_id=$1
		WHERE t.id=$2 AND (m.role='owner' OR t.assignee_user_id=$1)`, userID, taskID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return TaskTimeline{}, ErrNotFound
	}
	if err != nil {
		return TaskTimeline{}, err
	}
	var task Task
	if role == "owner" {
		task, err = s.taskForOwner(ctx, userID, taskID)
	} else {
		task, err = s.taskForEmployee(ctx, userID, taskID)
	}
	if err != nil {
		return TaskTimeline{}, err
	}
	out := TaskTimeline{Task: task, Sessions: []TaskWorkSession{}, Events: []TaskTimelineEvent{}, Applications: []TaskAppTotal{}}

	rows, err := s.pool.Query(ctx, `SELECT id,task_id,business_id,employee_user_id,COALESCE(device_id::text,''),started_at,ended_at,COALESCE(end_reason,'')
		FROM task_work_sessions WHERE task_id=$1 ORDER BY started_at`, taskID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var ws TaskWorkSession
		if err := rows.Scan(&ws.ID, &ws.TaskID, &ws.BusinessID, &ws.EmployeeUserID, &ws.DeviceID, &ws.StartedAt, &ws.EndedAt, &ws.EndReason); err != nil {
			rows.Close()
			return out, err
		}
		out.Sessions = append(out.Sessions, ws)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()

	rows, err = s.pool.Query(ctx, `
		SELECT 'app', a.ts, a.duration_s, a.app_name, COALESCE(a.window_title,''), '',
		       COALESCE(video.recording_id,''), video.offset_ms
		FROM task_work_sessions w
		JOIN activity_samples a ON a.user_id=w.employee_user_id AND a.business_id=w.business_id
		 AND to_timestamp(a.ts) >= w.started_at AND to_timestamp(a.ts) < COALESCE(w.ended_at,now())
		LEFT JOIN LATERAL (
			SELECT ra.id::text AS recording_id,
			       GREATEST(0,(EXTRACT(EPOCH FROM (to_timestamp(a.ts)-ra.started_at))*1000)::bigint) AS offset_ms
			FROM recording_assets ra JOIN media_sessions ms ON ms.id=ra.media_session_id
			WHERE ms.employee_id=w.employee_user_id AND ms.business_id=w.business_id
			  AND to_timestamp(a.ts) >= ra.started_at
			  AND to_timestamp(a.ts) < COALESCE(ra.ended_at,ra.started_at + interval '5 minutes')
			  AND ra.status='ready' ORDER BY ra.started_at DESC LIMIT 1
		) video ON true
		WHERE w.task_id=$1
		UNION ALL
		SELECT 'browser', b.ts, b.duration_s, COALESCE(b.browser,''), COALESCE(b.page_title,''), b.url,
		       COALESCE(video.recording_id,''), video.offset_ms
		FROM task_work_sessions w
		JOIN browser_visits b ON b.user_id=w.employee_user_id AND b.business_id=w.business_id
		 AND to_timestamp(b.ts) >= w.started_at AND to_timestamp(b.ts) < COALESCE(w.ended_at,now())
		LEFT JOIN LATERAL (
			SELECT ra.id::text AS recording_id,
			       GREATEST(0,(EXTRACT(EPOCH FROM (to_timestamp(b.ts)-ra.started_at))*1000)::bigint) AS offset_ms
			FROM recording_assets ra JOIN media_sessions ms ON ms.id=ra.media_session_id
			WHERE ms.employee_id=w.employee_user_id AND ms.business_id=w.business_id
			  AND to_timestamp(b.ts) >= ra.started_at
			  AND to_timestamp(b.ts) < COALESCE(ra.ended_at,ra.started_at + interval '5 minutes')
			  AND ra.status='ready' ORDER BY ra.started_at DESC LIMIT 1
		) video ON true
		WHERE w.task_id=$1 ORDER BY 2`, taskID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var event TaskTimelineEvent
		if err := rows.Scan(&event.Kind, &event.Timestamp, &event.DurationS, &event.AppName, &event.Title, &event.URL, &event.RecordingID, &event.VideoOffsetMS); err != nil {
			return out, err
		}
		out.Events = append(out.Events, event)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	appRows, err := s.pool.Query(ctx, `SELECT a.app_name, COALESCE(sum(a.duration_s),0)::bigint
		FROM task_work_sessions w JOIN activity_samples a ON a.user_id=w.employee_user_id AND a.business_id=w.business_id
		 AND to_timestamp(a.ts) >= w.started_at AND to_timestamp(a.ts) < COALESCE(w.ended_at,now())
		WHERE w.task_id=$1 GROUP BY a.app_name ORDER BY sum(a.duration_s) DESC`, taskID)
	if err != nil {
		return out, err
	}
	defer appRows.Close()
	for appRows.Next() {
		var total TaskAppTotal
		if err := appRows.Scan(&total.AppName, &total.Seconds); err != nil {
			return out, err
		}
		out.Applications = append(out.Applications, total)
	}
	return out, appRows.Err()
}

type TaskInsight struct {
	Code     string         `json:"code"`
	Tone     string         `json:"tone"`
	Title    string         `json:"title"`
	Detail   string         `json:"detail"`
	Evidence map[string]any `json:"evidence"`
}

type TaskAnalysis struct {
	TaskID              string        `json:"task_id"`
	GeneratedAt         time.Time     `json:"generated_at"`
	TrackedSeconds      int64         `json:"tracked_seconds"`
	ObservedActiveS     int64         `json:"observed_active_seconds"`
	EvidenceCoveragePct int           `json:"evidence_coverage_pct"`
	DistinctApps        int           `json:"distinct_apps"`
	BaselineScope       string        `json:"baseline_scope"`
	BaselineSamples     int           `json:"baseline_samples"`
	BaselineMedianS     *int64        `json:"baseline_median_seconds"`
	VariancePct         *int          `json:"variance_pct"`
	Insights            []TaskInsight `json:"insights"`
}

// TaskAnalysisForMember builds an explainable assessment package. It never
// infers intent or personality from app names and never compares unrelated job
// roles or work types. Fewer than three comparable completed tasks is reported
// as insufficient evidence rather than converted into a score.
func (s *Store) TaskAnalysisForMember(ctx context.Context, userID, taskID string) (TaskAnalysis, error) {
	timeline, err := s.TaskTimelineForMember(ctx, userID, taskID)
	if err != nil {
		return TaskAnalysis{}, err
	}
	analysis := TaskAnalysis{
		TaskID: taskID, GeneratedAt: time.Now().UTC(), TrackedSeconds: timeline.Task.TrackedSeconds,
		DistinctApps: len(timeline.Applications), BaselineScope: "same_employee_and_work_type", Insights: []TaskInsight{},
	}
	for _, app := range timeline.Applications {
		analysis.ObservedActiveS += app.Seconds
	}
	if analysis.TrackedSeconds > 0 {
		analysis.EvidenceCoveragePct = int(math.Round(math.Min(1, float64(analysis.ObservedActiveS)/float64(analysis.TrackedSeconds)) * 100))
	}

	baseline, err := s.taskBaseline(ctx, timeline.Task, true)
	if err != nil {
		return TaskAnalysis{}, err
	}
	if len(baseline) < 3 {
		analysis.BaselineScope = "same_role_and_work_type"
		baseline, err = s.taskBaseline(ctx, timeline.Task, false)
		if err != nil {
			return TaskAnalysis{}, err
		}
	}
	analysis.BaselineSamples = len(baseline)
	if len(baseline) >= 3 {
		median := medianSeconds(baseline)
		analysis.BaselineMedianS = &median
		if median > 0 {
			variance := int(math.Round((float64(analysis.TrackedSeconds-median) / float64(median)) * 100))
			analysis.VariancePct = &variance
			tone, title := "neutral", "Time is within the comparable range"
			if variance > 50 {
				tone, title = "watch", "This task took longer than the comparable median"
			} else if variance < -25 {
				tone, title = "positive", "This task finished faster than the comparable median"
			}
			analysis.Insights = append(analysis.Insights, TaskInsight{
				Code: "duration_vs_baseline", Tone: tone, Title: title,
				Detail:   "Compare the task evidence and complexity before drawing a performance conclusion.",
				Evidence: map[string]any{"tracked_seconds": analysis.TrackedSeconds, "median_seconds": median, "sample_count": len(baseline), "scope": analysis.BaselineScope},
			})
		}
	} else {
		analysis.Insights = append(analysis.Insights, TaskInsight{
			Code: "insufficient_baseline", Tone: "neutral", Title: "Not enough comparable work for a fair baseline",
			Detail:   "At least three completed tasks of the same work type and role are required before comparing speed.",
			Evidence: map[string]any{"sample_count": len(baseline), "required": 3, "scope": analysis.BaselineScope},
		})
	}
	if analysis.TrackedSeconds < 300 || analysis.EvidenceCoveragePct < 25 {
		analysis.Insights = append(analysis.Insights, TaskInsight{
			Code: "limited_evidence", Tone: "neutral", Title: "Evidence is too limited for a quality judgment",
			Detail:   "Use the timeline and ask for work context; do not treat missing activity as poor performance.",
			Evidence: map[string]any{"tracked_seconds": analysis.TrackedSeconds, "coverage_pct": analysis.EvidenceCoveragePct},
		})
	}
	if timeline.Task.EstimatedMinutes != nil && *timeline.Task.EstimatedMinutes > 0 {
		estimateS := int64(*timeline.Task.EstimatedMinutes) * 60
		deviation := 0
		if estimateS > 0 {
			deviation = int(math.Round(float64(analysis.TrackedSeconds-estimateS) / float64(estimateS) * 100))
		}
		analysis.Insights = append(analysis.Insights, TaskInsight{
			Code: "estimate_accuracy", Tone: "neutral", Title: "Estimate compared with measured work",
			Detail:   "Estimate variance helps improve planning; it is not an employee quality score.",
			Evidence: map[string]any{"estimated_seconds": estimateS, "tracked_seconds": analysis.TrackedSeconds, "variance_pct": deviation},
		})
	}
	return analysis, nil
}

func (s *Store) taskBaseline(ctx context.Context, task Task, sameEmployee bool) ([]int64, error) {
	filter := "t.assignee_user_id=$3"
	if !sameEmployee {
		filter = `EXISTS (
			SELECT 1 FROM memberships current_member
			JOIN memberships peer_member ON peer_member.business_id=current_member.business_id
			 AND peer_member.user_id=t.assignee_user_id
			 AND peer_member.job_role_id IS NOT DISTINCT FROM current_member.job_role_id
			WHERE current_member.business_id=t.business_id AND current_member.user_id=$3
		)`
	}
	rows, err := s.pool.Query(ctx, `SELECT COALESCE(sum(EXTRACT(EPOCH FROM (w.ended_at-w.started_at))),0)::bigint
		FROM tasks t JOIN task_work_sessions w ON w.task_id=t.id AND w.ended_at IS NOT NULL
		WHERE t.business_id=$1 AND t.work_type=$2 AND t.status='completed' AND t.id<>$4 AND `+filter+`
		GROUP BY t.id ORDER BY t.completed_at DESC LIMIT 30`, task.BusinessID, task.WorkType, task.AssigneeUserID, task.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []int64{}
	for rows.Next() {
		var value int64
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func medianSeconds(values []int64) int64 {
	copyValues := append([]int64(nil), values...)
	sort.Slice(copyValues, func(i, j int) bool { return copyValues[i] < copyValues[j] })
	middle := len(copyValues) / 2
	if len(copyValues)%2 == 1 {
		return copyValues[middle]
	}
	return (copyValues[middle-1] + copyValues[middle]) / 2
}
