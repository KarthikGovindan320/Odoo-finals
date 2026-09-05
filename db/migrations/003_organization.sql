-- Organisational reference data: departments, job positions, employment types.
-- These are lookup tables rather than free text columns so that the dashboard can
-- group by them and so that renaming a department does not orphan history.

CREATE TABLE departments (
  id         smallserial PRIMARY KEY,
  code       text NOT NULL UNIQUE,
  name       text NOT NULL UNIQUE,
  parent_id  smallint REFERENCES departments(id) ON DELETE RESTRICT,
  -- FK added in 005 once employees exists; the reference is genuinely circular.
  manager_employee_id bigint,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT department_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);

CREATE TABLE job_positions (
  id            smallserial PRIMARY KEY,
  title         text NOT NULL,
  department_id smallint REFERENCES departments(id) ON DELETE RESTRICT,
  description   text NOT NULL DEFAULT '',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_position_unique_in_department UNIQUE (title, department_id)
);

CREATE INDEX job_positions_department_idx ON job_positions (department_id);

CREATE TABLE employment_types (
  id        smallserial PRIMARY KEY,
  code      text NOT NULL UNIQUE,
  name      text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

INSERT INTO employment_types (code, name) VALUES
  ('full_time', 'Full Time'),
  ('part_time', 'Part Time'),
  ('contract',  'Contract'),
  ('intern',    'Intern');
