package media

import "sort"

// Permission is one capability on the media plane.
//
// These are separate on purpose. "Can watch a live screen" and "can delete a
// recording" and "can take control of a keyboard" are different powers with
// different blast radii, and collapsing them into one "manager" bit is how an
// audit trail ends up unable to answer who was allowed to do what.
type Permission string

const (
	// PermLiveViewStart creates a live session, which is what makes a device
	// start publishing. Distinct from watching one that already exists.
	PermLiveViewStart Permission = "live_view.start"
	// PermLiveViewWatch subscribes to a live session.
	PermLiveViewWatch Permission = "live_view.watch"
	// PermRecordingsView plays back recorded video.
	PermRecordingsView Permission = "recordings.view"
	// PermRecordingsDelete destroys recorded video. Deliberately not implied by
	// viewing: reviewing evidence and destroying it are not the same authority.
	PermRecordingsDelete Permission = "recordings.delete"
	// PermRemoteControlStart takes control of the keyboard and mouse.
	PermRemoteControlStart Permission = "remote_control.start"
	// PermMediaSettingsManage edits monitoring profiles' video policy.
	PermMediaSettingsManage Permission = "media_settings.manage"
	// PermMediaAuditView reads the media audit trail.
	PermMediaAuditView Permission = "media_audit.view"
)

// AllPermissions is every media permission, in a stable order.
var AllPermissions = []Permission{
	PermLiveViewStart, PermLiveViewWatch, PermRecordingsView, PermRecordingsDelete,
	PermRemoteControlStart, PermMediaSettingsManage, PermMediaAuditView,
}

// PermissionSet is a resolved set of permissions for one user in one business.
type PermissionSet map[Permission]struct{}

// Has reports whether the set grants p.
func (s PermissionSet) Has(p Permission) bool {
	_, ok := s[p]
	return ok
}

// List returns the granted permissions sorted, for API responses and audit
// metadata. Sorted so the output is stable and diffable.
func (s PermissionSet) List() []Permission {
	out := make([]Permission, 0, len(s))
	for p := range s {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func newSet(perms ...Permission) PermissionSet {
	s := make(PermissionSet, len(perms))
	for _, p := range perms {
		s[p] = struct{}{}
	}
	return s
}

// rolePermissions maps the membership roles that exist today onto the permission
// model.
//
// The role model is still two values -- `memberships.role` is
// CHECK (role IN ('owner','employee')) -- so this mapping is where the granularity
// lives for now. That is a real limitation, recorded rather than hidden: an
// organization cannot yet grant "watch live but never take control". What this
// buys today is that every call site already asks for the specific permission it
// needs, so introducing custom roles later changes this one function instead of
// every handler.
//
// An employee gets nothing. They are the subject of monitoring, not an operator
// of it, and self-viewing is not a feature this grants by accident.
var rolePermissions = map[string]PermissionSet{
	"owner":    newSet(AllPermissions...),
	"employee": newSet(),
}

// PermissionsForRole resolves a membership role to its permissions. An unknown
// role gets nothing: a role this code has never heard of must not be treated as
// privileged, and failing closed here means adding a role without updating this
// map denies access rather than granting it.
func PermissionsForRole(role string) PermissionSet {
	if perms, ok := rolePermissions[role]; ok {
		// Copy: callers must not be able to widen another caller's permissions
		// by mutating a shared map.
		out := make(PermissionSet, len(perms))
		for p := range perms {
			out[p] = struct{}{}
		}
		return out
	}
	return PermissionSet{}
}
