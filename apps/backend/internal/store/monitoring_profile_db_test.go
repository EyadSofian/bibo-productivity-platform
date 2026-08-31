package store

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

func boolDetail(key string, enabled bool) MonitoringDetail {
	value, _ := json.Marshal(enabled)
	return MonitoringDetail{
		TrackingKey: key, TrackingVal: value, DaysOfWeek: []int16{1, 2, 3, 4, 5, 6, 7},
		StartMinute: 0, EndMinute: 1440, Timezone: "UTC",
	}
}

func TestMonitoringProfileResolutionOrderAndInheritance(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "profile-owner@example.com", "")
	biz, err := s.CreateBusiness(ctx, owner.ID, "Profiles Inc", "team")
	if err != nil {
		t.Fatal(err)
	}
	employee := mustUser(t, ctx, s, "profile-employee@example.com", "")
	if _, err := s.pool.Exec(ctx, `INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`, employee.ID, biz.ID); err != nil {
		t.Fatal(err)
	}
	department, err := s.CreateDepartment(ctx, owner.ID, biz.ID, "Engineering", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AssignEmployeeOrganization(ctx, owner.ID, biz.ID, employee.ID, &department.ID, nil); err != nil {
		t.Fatal(err)
	}
	deviceID := uuid.NewString()
	if _, err := s.SyncBatch(ctx, employee.ID, biz.ID, deviceID, nil, nil, nil, nil, nil, nil, nil); err != nil {
		t.Fatal(err)
	}

	businessProfile, err := s.CreateMonitoringProfile(ctx, owner.ID, MonitoringProfileInput{
		BusinessID: biz.ID, Name: "Company baseline",
		Details:     []MonitoringDetail{boolDetail("screen", false), boolDetail("applications", false)},
		Assignments: []MonitoringAssignment{{ScopeType: "business", ScopeID: biz.ID}},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.CreateMonitoringProfile(ctx, owner.ID, MonitoringProfileInput{
		BusinessID: biz.ID, Name: "Department override",
		Details:     []MonitoringDetail{boolDetail("keystrokes", false)},
		Assignments: []MonitoringAssignment{{ScopeType: "department", ScopeID: department.ID}},
	})
	if err != nil {
		t.Fatal(err)
	}
	deviceProfile, err := s.CreateMonitoringProfile(ctx, owner.ID, MonitoringProfileInput{
		BusinessID: biz.ID, Name: "Company child", ParentID: &businessProfile.ID,
		Details:     []MonitoringDetail{boolDetail("screen", true), boolDetail("websites", false)},
		Assignments: []MonitoringAssignment{{ScopeType: "device", ScopeID: deviceID}},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.CreateMonitoringProfile(ctx, owner.ID, MonitoringProfileInput{
		BusinessID: biz.ID, Name: "Employee override", ParentID: &deviceProfile.ID,
		Details:     []MonitoringDetail{boolDetail("screen", false)},
		Assignments: []MonitoringAssignment{{ScopeType: "employee", ScopeID: employee.ID}},
	})
	if err != nil {
		t.Fatal(err)
	}

	resolved, err := s.ResolveMonitoringProfile(ctx, employee.ID, deviceID)
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]bool{}
	sources := map[string]string{}
	for _, detail := range resolved.Details {
		var enabled bool
		if err := json.Unmarshal(detail.TrackingVal, &enabled); err != nil {
			t.Fatal(err)
		}
		values[detail.TrackingKey] = enabled
		sources[detail.TrackingKey] = detail.SourceProfileName
	}
	if values["screen"] || values["applications"] || values["websites"] {
		t.Fatalf("resolved values = %#v; employee must win and inherited false values must survive", values)
	}
	if sources["screen"] != "Employee override" || sources["applications"] != "Company baseline" ||
		sources["websites"] != "Company child" {
		t.Fatalf("sources = %#v", sources)
	}
	if values["keystrokes"] || sources["keystrokes"] != "Department override" {
		t.Fatalf("department policy did not beat the company default: values=%#v sources=%#v", values, sources)
	}
}

func TestMonitoringProfileRejectsCrossTenantAssignment(t *testing.T) {
	f := newSyncFixture(t)
	other := mustUser(t, f.ctx, f.store, "profile-outsider@example.com", "")
	_, err := f.store.CreateMonitoringProfile(f.ctx, f.userID, MonitoringProfileInput{
		BusinessID: f.bizID, Name: "Bad assignment",
		Assignments: []MonitoringAssignment{{ScopeType: "employee", ScopeID: other.ID}},
	})
	if err != ErrForbidden {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

func TestScheduleActiveAtBoundariesAndOvernight(t *testing.T) {
	monday2230 := time.Date(2026, 8, 24, 22, 30, 0, 0, time.UTC)
	tuesday0130 := time.Date(2026, 8, 25, 1, 30, 0, 0, time.UTC)
	tuesday0230 := time.Date(2026, 8, 25, 2, 30, 0, 0, time.UTC)
	for _, tc := range []struct {
		name string
		now  time.Time
		want bool
	}{
		{"start day", monday2230, true},
		{"after midnight belongs to Monday", tuesday0130, true},
		{"end is exclusive", tuesday0230, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ScheduleActiveAt([]int16{1}, 22*60, 2*60, "UTC", tc.now)
			if err != nil || got != tc.want {
				t.Fatalf("active=%v err=%v, want %v", got, err, tc.want)
			}
		})
	}
}

func TestScheduleActiveAtDSTSpringForward(t *testing.T) {
	// America/New_York skips from 01:59 to 03:00 on 2026-03-08. A Sunday
	// 01:00–03:00 window is active before the jump and inactive after it.
	before := time.Date(2026, 3, 8, 6, 30, 0, 0, time.UTC)
	after := time.Date(2026, 3, 8, 7, 30, 0, 0, time.UTC)
	got, err := ScheduleActiveAt([]int16{7}, 60, 180, "America/New_York", before)
	if err != nil || !got {
		t.Fatalf("before jump active=%v err=%v", got, err)
	}
	got, err = ScheduleActiveAt([]int16{7}, 60, 180, "America/New_York", after)
	if err != nil || got {
		t.Fatalf("after jump active=%v err=%v", got, err)
	}
}
