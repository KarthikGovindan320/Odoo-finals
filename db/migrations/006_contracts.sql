-- Contracts carry the terms payroll actually prices: wage, structure, schedule.
--
-- The spec requires that payroll use only the contract applicable to the period
-- and that concurrent active contracts be avoided. That is a temporal integrity
-- rule, so it is declared here rather than left to a validator someone can
-- forget to call:
--
--   EXCLUDE USING gist (employee_id WITH =, validity WITH &&)
--
-- The WHERE predicate is the nuance that makes it usable. Exclusivity applies to
-- contracts that are real ('running' or 'expired'); drafts and cancelled rows may
-- overlap freely, so HR can prepare a replacement contract while the outgoing one
-- is still in force. A constraint that forbade that would be strict but wrong.

CREATE TABLE contracts (
  id                  bigserial PRIMARY KEY,
  reference           text NOT NULL UNIQUE,
  employee_id         bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  start_date          date NOT NULL,
  end_date            date,
  validity            daterange GENERATED ALWAYS AS (daterange(start_date, end_date, '[]')) STORED,
  department_id       smallint REFERENCES departments(id) ON DELETE RESTRICT,
  job_position_id     smallint REFERENCES job_positions(id) ON DELETE RESTRICT,
  employment_type_id  smallint REFERENCES employment_types(id) ON DELETE RESTRICT,
  working_schedule_id smallint REFERENCES working_schedules(id) ON DELETE RESTRICT,
  wage                numeric(12,2) NOT NULL,
  wage_type           text NOT NULL DEFAULT 'monthly',
  salary_structure_id smallint,  -- FK added in 009; salary structures do not exist yet
  state               text NOT NULL DEFAULT 'draft',
  notes               text NOT NULL DEFAULT '',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contract_dates_ordered CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT contract_wage_positive CHECK (wage > 0),
  CONSTRAINT contract_wage_type_known CHECK (wage_type IN ('monthly', 'hourly')),
  CONSTRAINT contract_state_known CHECK (state IN ('draft', 'running', 'expired', 'cancelled')),

  CONSTRAINT contract_no_overlap EXCLUDE USING gist (
    employee_id WITH =,
    validity    WITH &&
  ) WHERE (state IN ('running', 'expired'))
);

-- The exclusion constraint's GiST index already serves (employee_id, validity)
-- lookups, which is exactly the contract-for-period query. These cover the
-- list-view filters instead.
CREATE INDEX contracts_state_idx     ON contracts (state);
CREATE INDEX contracts_structure_idx ON contracts (salary_structure_id);

COMMENT ON COLUMN contracts.validity IS
  'Inclusive on both ends. A NULL end_date yields an unbounded range, i.e. an open-ended contract.';
