-- Payroll execution: payruns batch payslips, payslips own their computed lines.
--
-- The defining property here is immutability. A validated payslip is a financial
-- record; if someone edits the HRA rule in October, September must not move. Two
-- mechanisms together guarantee that:
--
--   1. payslip_lines snapshot the rule's code, name, category, sequence and the
--      expression that was actually evaluated. Reading a historical payslip never
--      joins to live configuration.
--   2. Triggers refuse to change lines, or the money and period on the header,
--      once the payslip is validated or paid.
--
-- Application code could enforce this. The database enforcing it means a mistake
-- in application code cannot rewrite history.

CREATE TABLE payruns (
  id                       bigserial PRIMARY KEY,
  name                     text NOT NULL UNIQUE,
  salary_structure_id      smallint NOT NULL REFERENCES salary_structures(id) ON DELETE RESTRICT,
  period_start             date NOT NULL,
  period_end               date NOT NULL,
  period                   daterange GENERATED ALWAYS AS (daterange(period_start, period_end, '[]')) STORED,
  state                    text NOT NULL DEFAULT 'draft',
  scope_department_id      smallint REFERENCES departments(id) ON DELETE RESTRICT,
  scope_employment_type_id smallint REFERENCES employment_types(id) ON DELETE RESTRICT,
  created_by_user_id       bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  computed_at              timestamptz,
  validated_at             timestamptz,
  paid_at                  timestamptz,

  CONSTRAINT payrun_period_ordered CHECK (period_end >= period_start),
  CONSTRAINT payrun_state_known CHECK (
    state IN ('draft', 'computed', 'validated', 'paid', 'cancelled')
  ),
  CONSTRAINT payrun_validated_has_timestamp CHECK (
    state NOT IN ('validated', 'paid') OR validated_at IS NOT NULL
  ),
  CONSTRAINT payrun_paid_has_timestamp CHECK (state <> 'paid' OR paid_at IS NOT NULL)
);

CREATE INDEX payruns_state_idx  ON payruns (state);
CREATE INDEX payruns_period_idx ON payruns USING gist (period);

CREATE TABLE payslips (
  id                  bigserial PRIMARY KEY,
  number              text NOT NULL UNIQUE,
  payrun_id           bigint NOT NULL REFERENCES payruns(id) ON DELETE CASCADE,
  employee_id         bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  contract_id         bigint REFERENCES contracts(id) ON DELETE RESTRICT,
  salary_structure_id smallint NOT NULL REFERENCES salary_structures(id) ON DELETE RESTRICT,
  period_start        date NOT NULL,
  period_end          date NOT NULL,

  scheduled_days      numeric(6,2) NOT NULL DEFAULT 0,
  worked_days         numeric(6,2) NOT NULL DEFAULT 0,
  worked_hours        numeric(8,2) NOT NULL DEFAULT 0,
  paid_leave_days     numeric(6,2) NOT NULL DEFAULT 0,
  unpaid_leave_days   numeric(6,2) NOT NULL DEFAULT 0,
  overtime_hours      numeric(8,2) NOT NULL DEFAULT 0,
  proration_factor    numeric(6,4) NOT NULL DEFAULT 1,

  gross_amount        numeric(14,2) NOT NULL DEFAULT 0,
  net_amount          numeric(14,2) NOT NULL DEFAULT 0,
  currency_code       text NOT NULL DEFAULT 'INR',
  state               text NOT NULL DEFAULT 'draft',
  computed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payslip_period_ordered CHECK (period_end >= period_start),
  CONSTRAINT payslip_state_known CHECK (
    state IN ('draft', 'computed', 'validated', 'paid', 'cancelled')
  ),
  CONSTRAINT payslip_days_not_negative CHECK (
    scheduled_days >= 0 AND worked_days >= 0 AND paid_leave_days >= 0
    AND unpaid_leave_days >= 0 AND overtime_hours >= 0
  ),
  CONSTRAINT payslip_proration_is_a_fraction CHECK (
    proration_factor > 0 AND proration_factor <= 1
  ),
  -- One payslip per employee per run. Duplicates within a batch are simply
  -- impossible rather than merely warned about.
  CONSTRAINT payslip_one_per_employee_per_run UNIQUE (payrun_id, employee_id)
);

CREATE INDEX payslips_employee_idx ON payslips (employee_id, period_start DESC);
CREATE INDEX payslips_payrun_idx   ON payslips (payrun_id);
CREATE INDEX payslips_state_idx    ON payslips (state);

-- Duplicates ACROSS runs are a warning while everything is draft, per the spec's
-- "highlight warnings ... prior to finalization". At the moment of finalisation
-- they become impossible: warnings are for humans, constraints are for money.
CREATE UNIQUE INDEX payslip_no_duplicate_finalized
  ON payslips (employee_id, period_start, period_end)
  WHERE state IN ('validated', 'paid');

CREATE TABLE payslip_lines (
  id               bigserial PRIMARY KEY,
  payslip_id       bigint NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  salary_rule_id   smallint REFERENCES salary_rules(id) ON DELETE RESTRICT,

  -- Snapshot columns. History reads these, never the live rule.
  rule_code        text NOT NULL,
  rule_name        text NOT NULL,
  category_code    text NOT NULL,
  category_sign    smallint NOT NULL,
  sequence         integer NOT NULL,
  computation_type text NOT NULL,
  source_expression text NOT NULL DEFAULT '',

  quantity         numeric(10,2) NOT NULL DEFAULT 1,
  rate             numeric(10,2) NOT NULL DEFAULT 100,
  amount           numeric(14,2) NOT NULL,

  CONSTRAINT line_category_sign_is_unit CHECK (category_sign IN (-1, 1)),
  CONSTRAINT line_unique_rule_per_payslip UNIQUE (payslip_id, rule_code)
);

CREATE INDEX payslip_lines_payslip_idx  ON payslip_lines (payslip_id, sequence);
CREATE INDEX payslip_lines_category_idx ON payslip_lines (category_code);

COMMENT ON COLUMN payslip_lines.source_expression IS
  'The expression or literal actually evaluated, kept so a historical payslip can explain itself.';

CREATE TABLE payslip_warnings (
  id         bigserial PRIMARY KEY,
  payrun_id  bigint NOT NULL REFERENCES payruns(id) ON DELETE CASCADE,
  payslip_id bigint REFERENCES payslips(id) ON DELETE CASCADE,
  severity   text NOT NULL,
  code       text NOT NULL,
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warning_severity_known CHECK (severity IN ('blocker', 'warning', 'info'))
);

CREATE INDEX payslip_warnings_payrun_idx   ON payslip_warnings (payrun_id, severity);
CREATE INDEX payslip_warnings_blockers_idx ON payslip_warnings (payrun_id)
  WHERE severity = 'blocker';

COMMENT ON TABLE payslip_warnings IS
  'Stored, not logged. The payrun screen groups these, validation refuses on blockers, and the dashboard alerts panel is a query over this one table.';

CREATE TABLE email_deliveries (
  id            bigserial PRIMARY KEY,
  payslip_id    bigint NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  to_email      citext NOT NULL,
  subject       text NOT NULL,
  status        text NOT NULL DEFAULT 'queued',
  error_message text,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_status_known CHECK (status IN ('queued', 'sent', 'failed')),
  CONSTRAINT delivery_failure_has_reason CHECK (status <> 'failed' OR error_message IS NOT NULL)
);

CREATE INDEX email_deliveries_payslip_idx ON email_deliveries (payslip_id);

-- Immutability, part 1: the computed breakdown of a finalized payslip.
CREATE FUNCTION reject_finalized_payslip_line_change() RETURNS trigger AS $$
DECLARE
  target_id    bigint := COALESCE(NEW.payslip_id, OLD.payslip_id);
  target_state text;
BEGIN
  SELECT state INTO target_state FROM payslips WHERE id = target_id;

  IF target_state IN ('validated', 'paid') THEN
    RAISE EXCEPTION
      'Payslip % is % and is immutable history; its salary lines cannot be changed.',
      target_id, target_state
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payslip_lines_immutable_when_final
  BEFORE INSERT OR UPDATE OR DELETE ON payslip_lines
  FOR EACH ROW EXECUTE FUNCTION reject_finalized_payslip_line_change();

-- Immutability, part 2: the header. Once finalized the only permitted change is
-- the validated -> paid transition, which moves no money and only records that
-- payment happened.
CREATE FUNCTION reject_finalized_payslip_header_change() RETURNS trigger AS $$
BEGIN
  IF OLD.state NOT IN ('validated', 'paid') THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'validated' AND NEW.state = 'paid'
     AND NEW.gross_amount   = OLD.gross_amount
     AND NEW.net_amount     = OLD.net_amount
     AND NEW.period_start   = OLD.period_start
     AND NEW.period_end     = OLD.period_end
     AND NEW.contract_id IS NOT DISTINCT FROM OLD.contract_id
     AND NEW.worked_days    = OLD.worked_days THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Payslip % is % and is immutable history; only the validated to paid transition is permitted.',
    OLD.id, OLD.state
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payslips_immutable_when_final
  BEFORE UPDATE ON payslips
  FOR EACH ROW EXECUTE FUNCTION reject_finalized_payslip_header_change();
