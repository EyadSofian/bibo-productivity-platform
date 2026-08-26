package store

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// MonitoringProfile is a named collection of independently scheduled capture
// keys. ParentID supplies defaults; assignments bind the profile to a scope.
type MonitoringProfile struct {
	ID          string                 `json:"id"`
	BusinessID  string                 `json:"business_id"`
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	ParentID    *string                `json:"parent_id"`
	Private     bool                   `json:"private"`
	Details     []MonitoringDetail     `json:"details"`
	Assignments []MonitoringAssignment `json:"assignments"`
	CreatedAt   time.Time              `json:"created_at"`
	UpdatedAt   time.Time              `json:"updated_at"`
}

type MonitoringDetail struct {
	TrackingKey       string          `json:"tracking_key"`
	TrackingVal       json.RawMessage `json:"tracking_val"`
	DaysOfWeek        []int16         `json:"days_of_week"`
	StartMinute       int             `json:"start_minute"`
	EndMinute         int             `json:"end_minute"`
	Timezone          string          `json:"timezone"`
	SourceProfileID   string          `json:"source_profile_id,omitempty"`
	SourceProfileName string          `json:"source_profile_name,omitempty"`
}

type MonitoringAssignment struct {
	ScopeType string `json:"scope_type"`
	ScopeID   string `json:"scope_id"`
}

type MonitoringProfileInput struct {
	BusinessID  string
	Name        string
	Description string
	ParentID    *string
	Private     bool
	Details     []MonitoringDetail
	Assignments []MonitoringAssignment
}

type ResolvedMonitoringProfile struct {
	DeviceID    string             `json:"device_id"`
	BusinessID  string             `json:"business_id"`
	UserID      string             `json:"user_id"`
	GeneratedAt time.Time          `json:"generated_at"`
	Details     []MonitoringDetail `json:"details"`
}

func (s *Store) CreateMonitoringProfile(ctx context.Context, ownerID string, in MonitoringProfileInput) (MonitoringProfile, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MonitoringProfile{}, err
	}
	defer tx.Rollback(ctx)
	if err := validateMonitoringProfileRefs(ctx, tx, ownerID, "", in); err != nil {
		return MonitoringProfile{}, err
	}

	var p MonitoringProfile
	err = tx.QueryRow(ctx, `
		INSERT INTO monitoring_profiles (business_id, name, description, parent_id, private)
		VALUES ($1,$2,$3,$4,$5)
		RETURNING id, business_id, name, description, parent_id, private, created_at, updated_at`,
		in.BusinessID, in.Name, in.Description, in.ParentID, in.Private,
	).Scan(&p.ID, &p.BusinessID, &p.Name, &p.Description, &p.ParentID, &p.Private, &p.CreatedAt, &p.UpdatedAt)
	if isUniqueViolation(err) {
		return MonitoringProfile{}, ErrConflict
	}
	if err != nil {
		return MonitoringProfile{}, err
	}
	if err := replaceMonitoringProfileChildren(ctx, tx, p.ID, in); err != nil {
		if isUniqueViolation(err) {
			return MonitoringProfile{}, ErrConflict
		}
		return MonitoringProfile{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MonitoringProfile{}, err
	}
	p.Details, p.Assignments = in.Details, in.Assignments
	return p, nil
}

func (s *Store) UpdateMonitoringProfile(ctx context.Context, ownerID, profileID string, in MonitoringProfileInput) (MonitoringProfile, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MonitoringProfile{}, err
	}
	defer tx.Rollback(ctx)
	if err := validateMonitoringProfileRefs(ctx, tx, ownerID, profileID, in); err != nil {
		return MonitoringProfile{}, err
	}

	var p MonitoringProfile
	err = tx.QueryRow(ctx, `
		UPDATE monitoring_profiles p
		   SET name=$3, description=$4, parent_id=$5, private=$6, updated_at=now()
		  FROM businesses b
		 WHERE p.id=$1 AND p.business_id=$2 AND b.id=p.business_id AND b.owner_user_id=$7
		RETURNING p.id, p.business_id, p.name, p.description, p.parent_id, p.private, p.created_at, p.updated_at`,
		profileID, in.BusinessID, in.Name, in.Description, in.ParentID, in.Private, ownerID,
	).Scan(&p.ID, &p.BusinessID, &p.Name, &p.Description, &p.ParentID, &p.Private, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return MonitoringProfile{}, ErrNotFound
	}
	if isUniqueViolation(err) {
		return MonitoringProfile{}, ErrConflict
	}
	if err != nil {
		return MonitoringProfile{}, err
	}
	if err := replaceMonitoringProfileChildren(ctx, tx, profileID, in); err != nil {
		if isUniqueViolation(err) {
			return MonitoringProfile{}, ErrConflict
		}
		return MonitoringProfile{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MonitoringProfile{}, err
	}
	p.Details, p.Assignments = in.Details, in.Assignments
	return p, nil
}

func validateMonitoringProfileRefs(ctx context.Context, tx pgx.Tx, ownerID, profileID string, in MonitoringProfileInput) error {
	var owns bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM businesses WHERE id=$1 AND owner_user_id=$2)`, in.BusinessID, ownerID).Scan(&owns); err != nil {
		return err
	}
	if !owns {
		return ErrNotFound
	}
	if in.ParentID != nil {
		var parentBusiness string
		if err := tx.QueryRow(ctx, `SELECT business_id FROM monitoring_profiles WHERE id=$1`, *in.ParentID).Scan(&parentBusiness); errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		if parentBusiness != in.BusinessID || *in.ParentID == profileID {
			return ErrConflict
		}
		if profileID != "" {
			var cycles bool
			if err := tx.QueryRow(ctx, `
				WITH RECURSIVE parents AS (
				  SELECT id, parent_id FROM monitoring_profiles WHERE id=$1
				  UNION ALL
				  SELECT p.id, p.parent_id FROM monitoring_profiles p JOIN parents x ON p.id=x.parent_id
				)
				SELECT EXISTS(SELECT 1 FROM parents WHERE id=$2)`, *in.ParentID, profileID).Scan(&cycles); err != nil {
				return err
			}
			if cycles {
				return ErrConflict
			}
		}
	}
	for _, a := range in.Assignments {
		var valid bool
		switch a.ScopeType {
		case "business":
			valid = a.ScopeID == in.BusinessID
		case "employee":
			if err := tx.QueryRow(ctx, `SELECT EXISTS(
				SELECT 1 FROM memberships WHERE user_id=$1 AND business_id=$2)`, a.ScopeID, in.BusinessID).Scan(&valid); err != nil {
				return err
			}
		case "department":
			if err := tx.QueryRow(ctx, `SELECT EXISTS(
				SELECT 1 FROM departments WHERE id=$1 AND business_id=$2)`, a.ScopeID, in.BusinessID).Scan(&valid); err != nil {
				return err
			}
		case "device":
			if err := tx.QueryRow(ctx, `SELECT EXISTS(
				SELECT 1 FROM devices WHERE id=$1 AND business_id=$2)`, a.ScopeID, in.BusinessID).Scan(&valid); err != nil {
				return err
			}
		default:
			// Directory-group assignments activate when their owning tables land in
			// F46; rejecting them now avoids dangling IDs.
			valid = false
		}
		if !valid {
			return ErrForbidden
		}
	}
	return nil
}

func replaceMonitoringProfileChildren(ctx context.Context, tx pgx.Tx, profileID string, in MonitoringProfileInput) error {
	if _, err := tx.Exec(ctx, `DELETE FROM monitoring_profile_details WHERE profile_id=$1`, profileID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM monitoring_profile_assignments WHERE profile_id=$1`, profileID); err != nil {
		return err
	}
	for _, d := range in.Details {
		if _, err := tx.Exec(ctx, `
			INSERT INTO monitoring_profile_details
			(profile_id, tracking_key, tracking_val, days_of_week, start_minute, end_minute, timezone)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`, profileID, d.TrackingKey, d.TrackingVal,
			d.DaysOfWeek, d.StartMinute, d.EndMinute, d.Timezone); err != nil {
			return err
		}
	}
	for _, a := range in.Assignments {
		if _, err := tx.Exec(ctx, `
			INSERT INTO monitoring_profile_assignments (profile_id, scope_type, scope_id)
			VALUES ($1,$2,$3)`, profileID, a.ScopeType, a.ScopeID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ListMonitoringProfiles(ctx context.Context, ownerID, businessID string) ([]MonitoringProfile, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.business_id, p.name, p.description, p.parent_id, p.private, p.created_at, p.updated_at
		  FROM monitoring_profiles p JOIN businesses b ON b.id=p.business_id
		 WHERE p.business_id=$1 AND b.owner_user_id=$2 ORDER BY p.name`, businessID, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	profiles := []MonitoringProfile{}
	for rows.Next() {
		var p MonitoringProfile
		if err := rows.Scan(&p.ID, &p.BusinessID, &p.Name, &p.Description, &p.ParentID,
			&p.Private, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		profiles = append(profiles, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Release the result-set connection before loading child rows. This matters
	// when deployments intentionally use a small pgx pool.
	rows.Close()
	for i := range profiles {
		if err := s.loadMonitoringChildren(ctx, &profiles[i]); err != nil {
			return nil, err
		}
	}
	return profiles, nil
}

func (s *Store) loadMonitoringChildren(ctx context.Context, p *MonitoringProfile) error {
	details, err := s.pool.Query(ctx, `
		SELECT tracking_key, tracking_val, days_of_week, start_minute, end_minute, timezone
		  FROM monitoring_profile_details WHERE profile_id=$1 ORDER BY tracking_key`, p.ID)
	if err != nil {
		return err
	}
	for details.Next() {
		var d MonitoringDetail
		if err := details.Scan(&d.TrackingKey, &d.TrackingVal, &d.DaysOfWeek,
			&d.StartMinute, &d.EndMinute, &d.Timezone); err != nil {
			details.Close()
			return err
		}
		p.Details = append(p.Details, d)
	}
	if err := details.Err(); err != nil {
		details.Close()
		return err
	}
	details.Close()
	assignments, err := s.pool.Query(ctx, `
		SELECT scope_type, scope_id FROM monitoring_profile_assignments
		 WHERE profile_id=$1 ORDER BY scope_type, scope_id`, p.ID)
	if err != nil {
		return err
	}
	defer assignments.Close()
	for assignments.Next() {
		var a MonitoringAssignment
		if err := assignments.Scan(&a.ScopeType, &a.ScopeID); err != nil {
			return err
		}
		p.Assignments = append(p.Assignments, a)
	}
	return assignments.Err()
}

func (s *Store) DeleteMonitoringProfile(ctx context.Context, ownerID, profileID string) error {
	ct, err := s.pool.Exec(ctx, `
		DELETE FROM monitoring_profiles p USING businesses b
		 WHERE p.id=$1 AND b.id=p.business_id AND b.owner_user_id=$2`, profileID, ownerID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ResolveMonitoringProfile merges company → department → device → employee assignments;
// within each profile, parent values are applied root-to-leaf. The employee
// scope is intentionally most specific, matching the roadmap's resolution rule.
func (s *Store) ResolveMonitoringProfile(ctx context.Context, requesterID, deviceID string) (ResolvedMonitoringProfile, error) {
	var out ResolvedMonitoringProfile
	var ownerID string
	var departmentID *string
	err := s.pool.QueryRow(ctx, `
		SELECT d.id, d.business_id, d.user_id, b.owner_user_id, m.department_id
		  FROM devices d JOIN businesses b ON b.id=d.business_id
		  LEFT JOIN memberships m ON m.user_id=d.user_id AND m.business_id=d.business_id
		 WHERE d.id=$1`, deviceID).Scan(&out.DeviceID, &out.BusinessID, &out.UserID, &ownerID, &departmentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if requesterID != out.UserID && requesterID != ownerID {
		return out, ErrNotFound
	}
	out.GeneratedAt = time.Now().UTC()

	profiles, err := s.listMonitoringProfilesInternal(ctx, out.BusinessID)
	if err != nil {
		return out, err
	}
	byID := make(map[string]MonitoringProfile, len(profiles))
	for _, p := range profiles {
		byID[p.ID] = p
	}

	type candidate struct {
		id       string
		priority int
	}
	rows, err := s.pool.Query(ctx, `
		SELECT a.profile_id,
		       CASE a.scope_type WHEN 'business' THEN 10 WHEN 'department' THEN 15 WHEN 'device' THEN 20 WHEN 'employee' THEN 30 ELSE 0 END
		  FROM monitoring_profile_assignments a JOIN monitoring_profiles p ON p.id=a.profile_id
		 WHERE p.business_id=$1 AND (
		       (a.scope_type='business' AND a.scope_id=$1) OR
		       (a.scope_type='device' AND a.scope_id=$2) OR
		       (a.scope_type='employee' AND a.scope_id=$3) OR
		       (a.scope_type='department' AND a.scope_id=$4))
		 ORDER BY 2, p.updated_at, p.id`, out.BusinessID, out.DeviceID, out.UserID, departmentID)
	if err != nil {
		return out, err
	}
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.id, &c.priority); err != nil {
			rows.Close()
			return out, err
		}
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()

	resolved := defaultMonitoringDetails()
	for _, c := range candidates {
		chain, err := monitoringProfileChain(byID, c.id)
		if err != nil {
			return out, err
		}
		for _, p := range chain {
			for _, d := range p.Details {
				d.SourceProfileID, d.SourceProfileName = p.ID, p.Name
				resolved[d.TrackingKey] = d
			}
		}
	}
	keys := make([]string, 0, len(resolved))
	for key := range resolved {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		out.Details = append(out.Details, resolved[key])
	}
	return out, nil
}

func (s *Store) listMonitoringProfilesInternal(ctx context.Context, businessID string) ([]MonitoringProfile, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, business_id, name, description, parent_id, private, created_at, updated_at
		  FROM monitoring_profiles WHERE business_id=$1`, businessID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var profiles []MonitoringProfile
	for rows.Next() {
		var p MonitoringProfile
		if err := rows.Scan(&p.ID, &p.BusinessID, &p.Name, &p.Description, &p.ParentID,
			&p.Private, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		profiles = append(profiles, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	for i := range profiles {
		details, err := s.pool.Query(ctx, `
			SELECT tracking_key, tracking_val, days_of_week, start_minute, end_minute, timezone
			  FROM monitoring_profile_details WHERE profile_id=$1`, profiles[i].ID)
		if err != nil {
			return nil, err
		}
		for details.Next() {
			var d MonitoringDetail
			if err := details.Scan(&d.TrackingKey, &d.TrackingVal, &d.DaysOfWeek,
				&d.StartMinute, &d.EndMinute, &d.Timezone); err != nil {
				details.Close()
				return nil, err
			}
			profiles[i].Details = append(profiles[i].Details, d)
		}
		if err := details.Err(); err != nil {
			details.Close()
			return nil, err
		}
		details.Close()
	}
	return profiles, nil
}

func monitoringProfileChain(byID map[string]MonitoringProfile, id string) ([]MonitoringProfile, error) {
	seen := map[string]bool{}
	var reversed []MonitoringProfile
	for id != "" {
		if seen[id] {
			return nil, ErrConflict
		}
		seen[id] = true
		p, ok := byID[id]
		if !ok {
			return nil, ErrNotFound
		}
		reversed = append(reversed, p)
		if p.ParentID == nil {
			break
		}
		id = *p.ParentID
	}
	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	return reversed, nil
}

func defaultMonitoringDetails() map[string]MonitoringDetail {
	trueJSON := json.RawMessage("true")
	out := map[string]MonitoringDetail{}
	for _, key := range []string{"applications", "keystrokes", "screen", "websites"} {
		out[key] = MonitoringDetail{
			TrackingKey: key, TrackingVal: trueJSON, DaysOfWeek: []int16{1, 2, 3, 4, 5, 6, 7},
			StartMinute: 0, EndMinute: 1440, Timezone: "UTC",
		}
	}
	return out
}

// ScheduleActiveAt evaluates an IANA-timezone schedule. Overnight windows use
// the day on which the window starts, so Mon 22:00–02:00 includes Tue 01:00.
func ScheduleActiveAt(days []int16, startMinute, endMinute int, timezone string, now time.Time) (bool, error) {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return false, err
	}
	local := now.In(loc)
	minute := local.Hour()*60 + local.Minute()
	isoDay := func(t time.Time) int16 {
		if t.Weekday() == time.Sunday {
			return 7
		}
		return int16(t.Weekday())
	}
	hasDay := func(day int16) bool {
		for _, candidate := range days {
			if candidate == day {
				return true
			}
		}
		return false
	}
	if startMinute == 0 && endMinute == 1440 {
		return hasDay(isoDay(local)), nil
	}
	if startMinute < endMinute {
		return hasDay(isoDay(local)) && minute >= startMinute && minute < endMinute, nil
	}
	if minute >= startMinute {
		return hasDay(isoDay(local)), nil
	}
	if minute < endMinute {
		return hasDay(isoDay(local.AddDate(0, 0, -1))), nil
	}
	return false, nil
}
