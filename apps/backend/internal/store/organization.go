package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Department and JobRole deliberately contain no HR data. They are lightweight
// policy scopes used by monitoring, schedules and productivity classification.
type Department struct {
	ID          string    `json:"id"`
	BusinessID  string    `json:"business_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type JobRole struct {
	ID          string    `json:"id"`
	BusinessID  string    `json:"business_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type Organization struct {
	Departments []Department `json:"departments"`
	JobRoles    []JobRole    `json:"job_roles"`
}

func (s *Store) ListOrganization(ctx context.Context, ownerID, businessID string) (Organization, error) {
	if ok, err := s.ownerOwnsBusiness(ctx, ownerID, businessID); err != nil {
		return Organization{}, err
	} else if !ok {
		return Organization{}, ErrNotFound
	}
	out := Organization{Departments: []Department{}, JobRoles: []JobRole{}}
	rows, err := s.pool.Query(ctx, `
		SELECT id, business_id, name, description, created_at, updated_at
		  FROM departments WHERE business_id=$1 ORDER BY lower(name), id`, businessID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item Department
		if err := rows.Scan(&item.ID, &item.BusinessID, &item.Name, &item.Description, &item.CreatedAt, &item.UpdatedAt); err != nil {
			rows.Close()
			return out, err
		}
		out.Departments = append(out.Departments, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()

	rows, err = s.pool.Query(ctx, `
		SELECT id, business_id, name, description, created_at, updated_at
		  FROM job_roles WHERE business_id=$1 ORDER BY lower(name), id`, businessID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item JobRole
		if err := rows.Scan(&item.ID, &item.BusinessID, &item.Name, &item.Description, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return out, err
		}
		out.JobRoles = append(out.JobRoles, item)
	}
	return out, rows.Err()
}

func (s *Store) CreateDepartment(ctx context.Context, ownerID, businessID, name, description string) (Department, error) {
	var item Department
	err := s.pool.QueryRow(ctx, `
		INSERT INTO departments (business_id, name, description)
		SELECT b.id, $3, $4 FROM businesses b WHERE b.id=$1 AND b.owner_user_id=$2
		RETURNING id, business_id, name, description, created_at, updated_at`,
		businessID, ownerID, name, description,
	).Scan(&item.ID, &item.BusinessID, &item.Name, &item.Description, &item.CreatedAt, &item.UpdatedAt)
	return item, organizationMutationError(err)
}

func (s *Store) UpdateDepartment(ctx context.Context, ownerID, id, name, description string) (Department, error) {
	var item Department
	err := s.pool.QueryRow(ctx, `
		UPDATE departments d SET name=$3, description=$4, updated_at=now()
		  FROM businesses b
		 WHERE d.id=$1 AND b.id=d.business_id AND b.owner_user_id=$2
		RETURNING d.id, d.business_id, d.name, d.description, d.created_at, d.updated_at`,
		id, ownerID, name, description,
	).Scan(&item.ID, &item.BusinessID, &item.Name, &item.Description, &item.CreatedAt, &item.UpdatedAt)
	return item, organizationMutationError(err)
}

func (s *Store) DeleteDepartment(ctx context.Context, ownerID, id string) error {
	return s.deleteOrganizationItem(ctx, ownerID, id, "department")
}

func (s *Store) CreateJobRole(ctx context.Context, ownerID, businessID, name, description string) (JobRole, error) {
	var item JobRole
	err := s.pool.QueryRow(ctx, `
		INSERT INTO job_roles (business_id, name, description)
		SELECT b.id, $3, $4 FROM businesses b WHERE b.id=$1 AND b.owner_user_id=$2
		RETURNING id, business_id, name, description, created_at, updated_at`,
		businessID, ownerID, name, description,
	).Scan(&item.ID, &item.BusinessID, &item.Name, &item.Description, &item.CreatedAt, &item.UpdatedAt)
	return item, organizationMutationError(err)
}

func (s *Store) UpdateJobRole(ctx context.Context, ownerID, id, name, description string) (JobRole, error) {
	var item JobRole
	err := s.pool.QueryRow(ctx, `
		UPDATE job_roles r SET name=$3, description=$4, updated_at=now()
		  FROM businesses b
		 WHERE r.id=$1 AND b.id=r.business_id AND b.owner_user_id=$2
		RETURNING r.id, r.business_id, r.name, r.description, r.created_at, r.updated_at`,
		id, ownerID, name, description,
	).Scan(&item.ID, &item.BusinessID, &item.Name, &item.Description, &item.CreatedAt, &item.UpdatedAt)
	return item, organizationMutationError(err)
}

func (s *Store) DeleteJobRole(ctx context.Context, ownerID, id string) error {
	return s.deleteOrganizationItem(ctx, ownerID, id, "job_role")
}

func organizationMutationError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if isUniqueViolation(err) {
		return ErrConflict
	}
	return err
}

func (s *Store) deleteOrganizationItem(ctx context.Context, ownerID, id, kind string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	table, column := "departments", "department_id"
	if kind == "job_role" {
		table, column = "job_roles", "job_role_id"
	}
	// table/column are internal constants, never request-controlled.
	var businessID string
	if err := tx.QueryRow(ctx, `SELECT x.business_id FROM `+table+` x JOIN businesses b ON b.id=x.business_id WHERE x.id=$1 AND b.owner_user_id=$2`, id, ownerID).Scan(&businessID); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE memberships SET `+column+`=NULL WHERE business_id=$1 AND `+column+`=$2`, businessID, id); err != nil {
		return err
	}
	if kind == "department" {
		// Polymorphic monitoring assignments cannot carry a database foreign key;
		// remove the department binding explicitly so profiles remain valid but
		// unassigned and fall back safely.
		if _, err := tx.Exec(ctx, `DELETE FROM monitoring_profile_assignments a
			USING monitoring_profiles p
			WHERE a.profile_id=p.id AND p.business_id=$1 AND a.scope_type='department' AND a.scope_id=$2`, businessID, id); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE id=$1 AND business_id=$2`, id, businessID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AssignEmployeeOrganization atomically updates both optional scopes. Composite
// foreign keys provide a second line of defense against cross-business IDs.
func (s *Store) AssignEmployeeOrganization(ctx context.Context, ownerID, businessID, employeeID string, departmentID, jobRoleID *string) (Employee, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Employee{}, err
	}
	defer tx.Rollback(ctx)
	var owns bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM businesses WHERE id=$1 AND owner_user_id=$2)`, businessID, ownerID).Scan(&owns); err != nil {
		return Employee{}, err
	}
	if !owns {
		return Employee{}, ErrNotFound
	}
	if departmentID != nil {
		var valid bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM departments WHERE id=$1 AND business_id=$2)`, *departmentID, businessID).Scan(&valid); err != nil {
			return Employee{}, err
		}
		if !valid {
			return Employee{}, ErrForbidden
		}
	}
	if jobRoleID != nil {
		var valid bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM job_roles WHERE id=$1 AND business_id=$2)`, *jobRoleID, businessID).Scan(&valid); err != nil {
			return Employee{}, err
		}
		if !valid {
			return Employee{}, ErrForbidden
		}
	}
	ct, err := tx.Exec(ctx, `
		UPDATE memberships SET department_id=$3, job_role_id=$4
		 WHERE business_id=$1 AND user_id=$2 AND role='employee'`,
		businessID, employeeID, departmentID, jobRoleID)
	if err != nil {
		return Employee{}, err
	}
	if ct.RowsAffected() == 0 {
		return Employee{}, ErrNotFound
	}
	var employee Employee
	err = tx.QueryRow(ctx, employeeWithOrganizationSQL+` WHERE m.business_id=$1 AND m.user_id=$2 AND m.role='employee'`, businessID, employeeID).
		Scan(employeeOrganizationDest(&employee)...)
	if err != nil {
		return Employee{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Employee{}, err
	}
	return employee, nil
}

func (s *Store) ownerOwnsBusiness(ctx context.Context, ownerID, businessID string) (bool, error) {
	var owns bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM businesses WHERE id=$1 AND owner_user_id=$2)`, businessID, ownerID).Scan(&owns)
	return owns, err
}
