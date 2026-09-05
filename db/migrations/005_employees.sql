-- The employee record: the hub the whole platform navigates from.
--
-- Note what is deliberately NOT here: wage, salary structure and working hours.
-- Those belong to the contract that applies to a given period, because they
-- change over time and payroll must read the value that was true then. Putting
-- a wage column on the employee is the single most common way to get this
-- problem wrong.

CREATE TABLE employees (
  id                  bigserial PRIMARY KEY,
  employee_number     text NOT NULL UNIQUE,
  user_id             bigint UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  first_name          text NOT NULL,
  last_name           text NOT NULL,
  work_email          citext NOT NULL UNIQUE,
  personal_email      citext,
  work_phone          text,
  department_id       smallint REFERENCES departments(id) ON DELETE RESTRICT,
  job_position_id     smallint REFERENCES job_positions(id) ON DELETE RESTRICT,
  employment_type_id  smallint REFERENCES employment_types(id) ON DELETE RESTRICT,
  manager_id          bigint REFERENCES employees(id) ON DELETE SET NULL,
  working_schedule_id smallint REFERENCES working_schedules(id) ON DELETE RESTRICT,
  hire_date           date NOT NULL,
  termination_date    date,
  status              text NOT NULL DEFAULT 'active',
  date_of_birth       date,
  address             text,
  bank_name           text,
  bank_account_number text,
  bank_ifsc           text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT employee_names_present CHECK (
    length(trim(first_name)) > 0 AND length(trim(last_name)) > 0
  ),
  CONSTRAINT employee_work_email_shaped CHECK (
    work_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  CONSTRAINT employee_personal_email_shaped CHECK (
    personal_email IS NULL OR personal_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  CONSTRAINT employee_status_known CHECK (status IN ('active', 'on_leave', 'terminated')),
  CONSTRAINT employee_not_own_manager CHECK (manager_id IS DISTINCT FROM id),
  CONSTRAINT employee_termination_after_hire CHECK (
    termination_date IS NULL OR termination_date >= hire_date
  ),
  -- A terminated employee must say when, and only a terminated employee may.
  CONSTRAINT employee_termination_matches_status CHECK (
    (status = 'terminated') = (termination_date IS NOT NULL)
  )
);

CREATE INDEX employees_department_idx    ON employees (department_id);
CREATE INDEX employees_manager_idx       ON employees (manager_id);
CREATE INDEX employees_type_idx          ON employees (employment_type_id);
CREATE INDEX employees_active_idx        ON employees (status) WHERE is_active;
CREATE INDEX employees_name_search_idx   ON employees USING gin (
  to_tsvector('simple', first_name || ' ' || last_name || ' ' || employee_number)
);

COMMENT ON COLUMN employees.user_id IS
  'Nullable: HR creates the employee record first, and a login is granted later by linking a users row.';

-- Closes the circular reference declared in 003.
ALTER TABLE departments
  ADD CONSTRAINT departments_manager_fk
  FOREIGN KEY (manager_employee_id) REFERENCES employees(id) ON DELETE SET NULL;
