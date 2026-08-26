package store

import (
	"errors"
	"testing"
)

func TestOrganizationCRUDAssignmentAndDeleteFallback(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "organization-owner@example.com", "")
	biz, err := s.CreateBusiness(ctx, owner.ID, "Organization Inc", "team")
	if err != nil {
		t.Fatal(err)
	}
	employee := mustUser(t, ctx, s, "organization-employee@example.com", "")
	if _, err := s.pool.Exec(ctx, `INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`, employee.ID, biz.ID); err != nil {
		t.Fatal(err)
	}
	department, err := s.CreateDepartment(ctx, owner.ID, biz.ID, "Engineering", "Builds the product")
	if err != nil {
		t.Fatal(err)
	}
	role, err := s.CreateJobRole(ctx, owner.ID, biz.ID, "Developer", "Software delivery")
	if err != nil {
		t.Fatal(err)
	}
	assigned, err := s.AssignEmployeeOrganization(ctx, owner.ID, biz.ID, employee.ID, &department.ID, &role.ID)
	if err != nil {
		t.Fatal(err)
	}
	if assigned.DepartmentName != "Engineering" || assigned.JobRoleName != "Developer" {
		t.Fatalf("assigned organization = %#v", assigned)
	}
	profile, err := s.CreateMonitoringProfile(ctx, owner.ID, MonitoringProfileInput{
		BusinessID: biz.ID, Name: "Engineering monitoring",
		Assignments: []MonitoringAssignment{{ScopeType: "department", ScopeID: department.ID}},
	})
	if err != nil {
		t.Fatal(err)
	}

	organization, err := s.ListOrganization(ctx, owner.ID, biz.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(organization.Departments) != 1 || len(organization.JobRoles) != 1 {
		t.Fatalf("organization = %#v", organization)
	}

	updated, err := s.UpdateDepartment(ctx, owner.ID, department.ID, "Product Engineering", "")
	if err != nil || updated.Name != "Product Engineering" {
		t.Fatalf("updated department = %#v, err=%v", updated, err)
	}
	if err := s.DeleteDepartment(ctx, owner.ID, department.ID); err != nil {
		t.Fatal(err)
	}
	employees, err := s.ListEmployees(ctx, biz.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(employees) != 1 || employees[0].DepartmentID != nil || employees[0].JobRoleID == nil {
		t.Fatalf("delete must clear only the department assignment: %#v", employees)
	}
	var assignmentCount int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM monitoring_profile_assignments WHERE profile_id=$1`, profile.ID).Scan(&assignmentCount); err != nil {
		t.Fatal(err)
	}
	if assignmentCount != 0 {
		t.Fatalf("deleted department left %d monitoring assignments", assignmentCount)
	}
}

func TestOrganizationTenantIsolationAndUniqueNames(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "organization-a@example.com", "")
	biz, err := s.CreateBusiness(ctx, owner.ID, "A", "team")
	if err != nil {
		t.Fatal(err)
	}
	department, err := s.CreateDepartment(ctx, owner.ID, biz.ID, "Sales", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateDepartment(ctx, owner.ID, biz.ID, "sales", "duplicate casing"); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate err=%v, want ErrConflict", err)
	}

	otherOwner := mustUser(t, ctx, s, "organization-b@example.com", "")
	otherBiz, err := s.CreateBusiness(ctx, otherOwner.ID, "B", "team")
	if err != nil {
		t.Fatal(err)
	}
	otherEmployee := mustUser(t, ctx, s, "organization-b-employee@example.com", "")
	if _, err := s.pool.Exec(ctx, `INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`, otherEmployee.ID, otherBiz.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ListOrganization(ctx, otherOwner.ID, biz.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign list err=%v, want ErrNotFound", err)
	}
	if _, err := s.AssignEmployeeOrganization(ctx, otherOwner.ID, otherBiz.ID, otherEmployee.ID, &department.ID, nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-tenant assignment err=%v, want ErrForbidden", err)
	}
	if _, err := s.UpdateDepartment(ctx, otherOwner.ID, department.ID, "Stolen", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign update err=%v, want ErrNotFound", err)
	}
}
