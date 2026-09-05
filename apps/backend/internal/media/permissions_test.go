package media

import "testing"

// An employee is the subject of monitoring, not an operator of it. If this ever
// starts granting something, it happened by accident.
func TestEmployeeHasNoMediaPermissions(t *testing.T) {
	perms := PermissionsForRole("employee")
	if len(perms) != 0 {
		t.Fatalf("employee granted %v, want none", perms.List())
	}
	for _, p := range AllPermissions {
		if perms.Has(p) {
			t.Errorf("employee has %s", p)
		}
	}
}

// An unknown role must fail closed. Adding a role to the database without
// updating the map should deny, never grant.
func TestUnknownRoleGrantsNothing(t *testing.T) {
	for _, role := range []string{"", "admin", "supervisor", "OWNER", "auditor"} {
		if perms := PermissionsForRole(role); len(perms) != 0 {
			t.Errorf("role %q granted %v, want none", role, perms.List())
		}
	}
}

func TestOwnerHasEveryPermission(t *testing.T) {
	perms := PermissionsForRole("owner")
	for _, p := range AllPermissions {
		if !perms.Has(p) {
			t.Errorf("owner is missing %s", p)
		}
	}
	if len(perms) != len(AllPermissions) {
		t.Errorf("owner has %d permissions, want %d", len(perms), len(AllPermissions))
	}
}

// The returned set is a copy. Two callers resolving the same role must not be
// able to widen each other's permissions.
func TestPermissionSetsAreNotShared(t *testing.T) {
	first := PermissionsForRole("employee")
	first[PermRecordingsDelete] = struct{}{}

	second := PermissionsForRole("employee")
	if second.Has(PermRecordingsDelete) {
		t.Fatal("mutating one resolved set changed another: the role map is shared")
	}
}

// Viewing and destroying are different authorities, so they must be different
// permissions rather than one implying the other.
func TestDeleteIsNotImpliedByView(t *testing.T) {
	if PermRecordingsView == PermRecordingsDelete {
		t.Fatal("view and delete collapsed into one permission")
	}
	perms := newSet(PermRecordingsView)
	if perms.Has(PermRecordingsDelete) {
		t.Error("granting view also granted delete")
	}
}

func TestListIsSortedAndStable(t *testing.T) {
	perms := newSet(PermRemoteControlStart, PermLiveViewWatch, PermMediaAuditView)
	got := perms.List()
	for i := 1; i < len(got); i++ {
		if got[i-1] >= got[i] {
			t.Fatalf("List() not sorted: %v", got)
		}
	}
}
