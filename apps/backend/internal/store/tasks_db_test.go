package store

import (
	"errors"
	"testing"
)

func TestMedianSeconds(t *testing.T) {
	if got := medianSeconds([]int64{90, 10, 30}); got != 30 {
		t.Fatalf("odd median=%d", got)
	}
	if got := medianSeconds([]int64{40, 10, 20, 30}); got != 25 {
		t.Fatalf("even median=%d", got)
	}
}

func TestTaskWorkLifecycleAndSingleActiveTask(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "tasks-owner@example.com", "")
	biz, err := s.CreateBusiness(ctx, owner.ID, "Task Company", "team")
	if err != nil {
		t.Fatal(err)
	}
	employee := mustUser(t, ctx, s, "tasks-employee@example.com", "")
	if _, err := s.pool.Exec(ctx, `INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`, employee.ID, biz.ID); err != nil {
		t.Fatal(err)
	}

	first, err := s.CreateTask(ctx, owner.ID, NewTask{
		BusinessID: biz.ID, AssigneeUserID: employee.ID, Title: "Implement task tracking", Priority: "high",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateTask(ctx, owner.ID, NewTask{
		BusinessID: biz.ID, AssigneeUserID: employee.ID, Title: "Review the timeline", Priority: "normal",
	})
	if err != nil {
		t.Fatal(err)
	}

	started, work, err := s.StartTask(ctx, employee.ID, first.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if started.Status != "in_progress" || started.ActiveSessionID != work.ID || started.StartedAt == nil {
		t.Fatalf("started task = %#v, work = %#v", started, work)
	}
	if _, _, err := s.StartTask(ctx, employee.ID, second.ID, ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("parallel start err=%v, want ErrConflict", err)
	}

	paused, err := s.EndTaskWork(ctx, employee.ID, first.ID, "pause")
	if err != nil {
		t.Fatal(err)
	}
	if paused.Status != "paused" || paused.ActiveSessionID != "" {
		t.Fatalf("paused task = %#v", paused)
	}
	if _, _, err := s.StartTask(ctx, employee.ID, first.ID, ""); err != nil {
		t.Fatal(err)
	}
	completed, err := s.EndTaskWork(ctx, employee.ID, first.ID, "complete")
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != "completed" || completed.CompletedAt == nil {
		t.Fatalf("completed task = %#v", completed)
	}
	if _, _, err := s.StartTask(ctx, employee.ID, first.ID, ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("completed task restart err=%v, want ErrConflict", err)
	}
	if _, _, err := s.StartTask(ctx, employee.ID, second.ID, ""); err != nil {
		t.Fatal(err)
	}
	cancelled, err := s.CancelTaskForOwner(ctx, owner.ID, second.ID)
	if err != nil || cancelled.Status != "cancelled" || cancelled.ActiveSessionID != "" {
		t.Fatalf("cancelled active task=%#v err=%v", cancelled, err)
	}

	items, err := s.ListTasksForOwner(ctx, owner.ID, biz.ID)
	if err != nil || len(items) != 2 {
		t.Fatalf("owner tasks=%#v err=%v", items, err)
	}
	mine, err := s.ListTasksForEmployee(ctx, employee.ID)
	if err != nil || len(mine) != 1 {
		t.Fatalf("employee tasks=%#v err=%v", mine, err)
	}
}

func TestTaskTenantAndAssigneeIsolation(t *testing.T) {
	s, ctx := newStore(t)
	ownerA := mustUser(t, ctx, s, "task-a-owner@example.com", "")
	bizA, _ := s.CreateBusiness(ctx, ownerA.ID, "A", "team")
	employeeA := mustUser(t, ctx, s, "task-a-employee@example.com", "")
	_, _ = s.pool.Exec(ctx, `INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`, employeeA.ID, bizA.ID)
	ownerB := mustUser(t, ctx, s, "task-b-owner@example.com", "")
	bizB, _ := s.CreateBusiness(ctx, ownerB.ID, "B", "team")
	employeeB := mustUser(t, ctx, s, "task-b-employee@example.com", "")
	_, _ = s.pool.Exec(ctx, `INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`, employeeB.ID, bizB.ID)

	if _, err := s.CreateTask(ctx, ownerA.ID, NewTask{BusinessID: bizA.ID, AssigneeUserID: employeeB.ID, Title: "Cross tenant", Priority: "normal"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant assignment err=%v, want ErrNotFound", err)
	}
	task, err := s.CreateTask(ctx, ownerA.ID, NewTask{BusinessID: bizA.ID, AssigneeUserID: employeeA.ID, Title: "Private task", Priority: "normal"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.StartTask(ctx, employeeB.ID, task.ID, ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign employee start err=%v, want ErrNotFound", err)
	}
	if _, err := s.CancelTaskForOwner(ctx, ownerB.ID, task.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign owner cancel err=%v, want ErrNotFound", err)
	}
	cancelled, err := s.CancelTaskForOwner(ctx, ownerA.ID, task.ID)
	if err != nil || cancelled.Status != "cancelled" {
		t.Fatalf("cancelled task=%#v err=%v", cancelled, err)
	}
	if _, _, err := s.StartTask(ctx, employeeA.ID, task.ID, ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("cancelled task start err=%v, want ErrConflict", err)
	}
	foreign, err := s.ListTasksForOwner(ctx, ownerB.ID, bizA.ID)
	if err != nil || len(foreign) != 0 {
		t.Fatalf("foreign owner tasks=%#v err=%v", foreign, err)
	}
}
