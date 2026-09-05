-- Time off is a two-sided ledger: allocations grant balance, approved requests
-- consume it.
--
-- The consumption link is a table rather than a counter on the allocation. The
-- spec asks for balances "accurately consumed and transparently linked", and a
-- link table delivers exactly that:
--   * a request spanning two allocations produces two rows, visibly
--   * remaining balance is allocated - SUM(consumed), always derived, so it can
--     never drift out of step with reality
--   * refusing a previously approved request deletes its consumption rows and
--     the balance restores itself, with no compensating update to get wrong

CREATE TABLE time_off_types (
  id                  smallserial PRIMARY KEY,
  code                text NOT NULL UNIQUE,
  name                text NOT NULL,
  unit                text NOT NULL DEFAULT 'day',
  requires_allocation boolean NOT NULL DEFAULT true,
  requires_approval   boolean NOT NULL DEFAULT true,
  is_paid             boolean NOT NULL DEFAULT true,
  payroll_rule_code   text,
  color_token         text NOT NULL DEFAULT 'plum',
  max_days_per_request numeric(6,2),
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timeoff_type_unit_known CHECK (unit IN ('day', 'hour')),
  CONSTRAINT timeoff_type_max_positive CHECK (max_days_per_request IS NULL OR max_days_per_request > 0)
);

COMMENT ON COLUMN time_off_types.payroll_rule_code IS
  'Optional link into the rules engine. An unpaid type feeds the loss-of-pay deduction rule.';

CREATE TABLE time_off_allocations (
  id                  bigserial PRIMARY KEY,
  employee_id         bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  time_off_type_id    smallint NOT NULL REFERENCES time_off_types(id) ON DELETE RESTRICT,
  allocated_amount    numeric(8,2) NOT NULL,
  valid_from          date NOT NULL,
  valid_to            date NOT NULL,
  validity            daterange GENERATED ALWAYS AS (daterange(valid_from, valid_to, '[]')) STORED,
  state               text NOT NULL DEFAULT 'draft',
  notes               text NOT NULL DEFAULT '',
  approved_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  approved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT allocation_amount_positive CHECK (allocated_amount > 0),
  CONSTRAINT allocation_dates_ordered CHECK (valid_to >= valid_from),
  CONSTRAINT allocation_state_known CHECK (state IN ('draft', 'to_approve', 'approved', 'refused')),
  CONSTRAINT allocation_approval_is_attributed CHECK (
    state <> 'approved' OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE INDEX allocations_employee_type_idx ON time_off_allocations (employee_id, time_off_type_id);
CREATE INDEX allocations_available_idx     ON time_off_allocations (employee_id, valid_to)
  WHERE state = 'approved';

CREATE TABLE time_off_requests (
  id                  bigserial PRIMARY KEY,
  employee_id         bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  time_off_type_id    smallint NOT NULL REFERENCES time_off_types(id) ON DELETE RESTRICT,
  date_from           date NOT NULL,
  date_to             date NOT NULL,
  leave_period        daterange GENERATED ALWAYS AS (daterange(date_from, date_to, '[]')) STORED,
  requested_amount    numeric(8,2) NOT NULL,
  state               text NOT NULL DEFAULT 'draft',
  reason              text NOT NULL DEFAULT '',
  decided_by_user_id  bigint REFERENCES users(id) ON DELETE SET NULL,
  decided_at          timestamptz,
  decision_note       text NOT NULL DEFAULT '',
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT request_amount_positive CHECK (requested_amount > 0),
  CONSTRAINT request_dates_ordered CHECK (date_to >= date_from),
  CONSTRAINT request_state_known CHECK (
    state IN ('draft', 'to_approve', 'approved', 'refused', 'cancelled')
  ),
  CONSTRAINT request_decision_is_attributed CHECK (
    state NOT IN ('approved', 'refused') OR (decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  ),

  -- An employee cannot be on two approved leaves at once. Same temporal
  -- integrity idea as contracts and attendance, applied to leave.
  CONSTRAINT request_no_overlap EXCLUDE USING gist (
    employee_id  WITH =,
    leave_period WITH &&
  ) WHERE (state = 'approved')
);

CREATE INDEX requests_employee_idx ON time_off_requests (employee_id, date_from DESC);
CREATE INDEX requests_pending_idx  ON time_off_requests (state) WHERE state = 'to_approve';
CREATE INDEX requests_period_idx   ON time_off_requests USING gist (leave_period);

CREATE TABLE time_off_consumptions (
  id                     bigserial PRIMARY KEY,
  time_off_request_id    bigint NOT NULL REFERENCES time_off_requests(id) ON DELETE CASCADE,
  time_off_allocation_id bigint NOT NULL REFERENCES time_off_allocations(id) ON DELETE RESTRICT,
  amount                 numeric(8,2) NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consumption_amount_positive CHECK (amount > 0),
  CONSTRAINT consumption_unique_pairing UNIQUE (time_off_request_id, time_off_allocation_id)
);

CREATE INDEX consumptions_allocation_idx ON time_off_consumptions (time_off_allocation_id);

COMMENT ON TABLE time_off_consumptions IS
  'One row per (request, allocation) pair drawn from. Balance is derived from these, never stored.';
