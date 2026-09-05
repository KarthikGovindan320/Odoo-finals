-- Identity and access control.
--
-- Permissions are data, not code: a role's reach is a set of rows, and every
-- server route names the permission it requires. The `scope` column on the join
-- is what separates "may read attendance" from "may read ALL attendance" -- the
-- Employee role holds the same permission codes as HR, with scope 'own', and the
-- repository layer turns that into a WHERE clause.

CREATE TABLE roles (
  id          smallserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  rank        smallint NOT NULL,
  CONSTRAINT role_rank_positive CHECK (rank > 0)
);

COMMENT ON COLUMN roles.rank IS
  'Display ordering and seniority hints only. Authorisation decisions read role_permissions, never this.';

CREATE TABLE permissions (
  id          smallserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  resource    text NOT NULL,
  action      text NOT NULL,
  description text NOT NULL DEFAULT '',
  CONSTRAINT permission_code_matches_parts CHECK (code = resource || ':' || action)
);

CREATE TABLE role_permissions (
  role_id       smallint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id smallint NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  scope         text NOT NULL DEFAULT 'all',
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT role_permission_scope_known CHECK (scope IN ('own', 'all'))
);

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  role_id       smallint NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_email_shaped CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

CREATE INDEX users_role_idx ON users (role_id);

-- Opaque session tokens rather than JWTs: revocable on logout, no signing key to
-- leak, and the raw token is never stored -- only its SHA-256 hash.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  ip_address   inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  CONSTRAINT session_expires_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_live_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- Reference data. The application depends on these codes existing, so they are
-- part of the schema rather than of the demo seed.
INSERT INTO roles (code, name, rank, description) VALUES
  ('employee',           'Employee',           1, 'Own records only: profile, attendance, leave balances and requests'),
  ('hr_manager',         'HR Manager',         2, 'Full HR master data and leave approval. No payroll access at all'),
  ('hr_payroll_user',    'HR Payroll User',    3, 'HR Manager plus create/read/update on payruns and payslips; payroll config read-only'),
  ('hr_payroll_manager', 'HR Payroll Manager', 4, 'HR Payroll User plus full control of payroll records and salary configuration'),
  ('admin',              'Admin',              5, 'Every module, plus user management and role assignment');

INSERT INTO permissions (code, resource, action, description) VALUES
  ('employee:read',        'employee',        'read',     'View employee records'),
  ('employee:write',       'employee',        'write',    'Create and update employee records'),
  ('employee:delete',      'employee',        'delete',   'Archive employee records'),
  ('contract:read',        'contract',        'read',     'View contracts'),
  ('contract:write',       'contract',        'write',    'Create and update contracts'),
  ('schedule:read',        'schedule',        'read',     'View working schedules'),
  ('schedule:write',       'schedule',        'write',    'Create and update working schedules'),
  ('attendance:read',      'attendance',      'read',     'View attendance records'),
  ('attendance:write',     'attendance',      'write',    'Create attendance records'),
  ('attendance:correct',   'attendance',      'correct',  'Manually correct an attendance record after the fact'),
  ('timeoff:read',         'timeoff',         'read',     'View time off requests and allocations'),
  ('timeoff:write',        'timeoff',         'write',    'Create time off requests'),
  ('timeoff:approve',      'timeoff',         'approve',  'Approve or refuse time off requests and allocations'),
  ('timeoff_type:read',    'timeoff_type',    'read',     'View time off types'),
  ('timeoff_type:write',   'timeoff_type',    'write',    'Configure time off types'),
  ('salary_config:read',   'salary_config',   'read',     'View salary structures and rules'),
  ('salary_config:write',  'salary_config',   'write',    'Create and update salary structures and rules'),
  ('payrun:read',          'payrun',          'read',     'View payruns and payslips'),
  ('payrun:write',         'payrun',          'write',    'Create and compute payruns'),
  ('payrun:validate',      'payrun',          'validate', 'Validate, mark paid and distribute payruns'),
  ('payrun:delete',        'payrun',          'delete',   'Cancel or delete payruns'),
  ('dashboard:read',       'dashboard',       'read',     'View the payroll dashboard'),
  ('audit:read',           'audit',           'read',     'Read the audit trail'),
  ('user:manage',          'user',            'manage',   'Manage users, roles and permissions');

-- Employee: own records only. Same permission codes as HR staff, scoped to self.
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'own'
FROM roles r
JOIN permissions p ON p.code IN (
  'employee:read', 'contract:read', 'attendance:read', 'attendance:write',
  'timeoff:read', 'timeoff:write', 'timeoff_type:read', 'payrun:read'
)
WHERE r.code = 'employee';

-- HR Manager: all HR master data, no payroll whatsoever.
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'all'
FROM roles r
JOIN permissions p ON p.code IN (
  'employee:read', 'employee:write', 'employee:delete',
  'contract:read', 'contract:write',
  'schedule:read', 'schedule:write',
  'attendance:read', 'attendance:write', 'attendance:correct',
  'timeoff:read', 'timeoff:write', 'timeoff:approve',
  'timeoff_type:read', 'timeoff_type:write',
  'audit:read'
)
WHERE r.code = 'hr_manager';

-- HR Payroll User: HR Manager, plus payroll records, plus read-only config.
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'all'
FROM roles r
JOIN permissions p ON p.code IN (
  'employee:read', 'employee:write', 'employee:delete',
  'contract:read', 'contract:write',
  'schedule:read', 'schedule:write',
  'attendance:read', 'attendance:write', 'attendance:correct',
  'timeoff:read', 'timeoff:write', 'timeoff:approve',
  'timeoff_type:read', 'timeoff_type:write',
  'salary_config:read',
  'payrun:read', 'payrun:write',
  'dashboard:read', 'audit:read'
)
WHERE r.code = 'hr_payroll_user';

-- HR Payroll Manager: everything HR and payroll, including salary configuration.
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'all'
FROM roles r
JOIN permissions p ON p.code <> 'user:manage'
WHERE r.code = 'hr_payroll_manager';

-- Admin: everything.
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'all'
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'admin';
