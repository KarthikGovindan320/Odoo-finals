-- Salary configuration: the program that payroll executes.
--
-- Rules are ordered, and the order is a dependency declaration: rule n may read
-- the results of rules 1..n-1 and nothing later. Gross cannot be computed before
-- Allowances exist, and the sequence is what says so.
--
-- The sequence lives on salary_structure_rules, not on salary_rules, so the same
-- rule can sit at a different position in a different structure. That is strictly
-- more expressive than a sequence on the rule and costs one join.

CREATE TABLE salary_rule_categories (
  id       smallserial PRIMARY KEY,
  code     text NOT NULL UNIQUE,
  name     text NOT NULL,
  sequence smallint NOT NULL,
  sign     smallint NOT NULL DEFAULT 1,
  CONSTRAINT category_sign_is_unit CHECK (sign IN (-1, 1))
);

COMMENT ON COLUMN salary_rule_categories.sign IS
  'Whether the category adds to or subtracts from pay. Deductions are stored as positive amounts with sign -1.';

CREATE TABLE salary_structures (
  id            smallserial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  currency_code text NOT NULL DEFAULT 'INR',
  description   text NOT NULL DEFAULT '',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT structure_currency_shaped CHECK (currency_code ~ '^[A-Z]{3}$')
);

CREATE TABLE salary_rules (
  id                   smallserial PRIMARY KEY,
  code                 text NOT NULL UNIQUE,
  name                 text NOT NULL,
  category_id          smallint NOT NULL REFERENCES salary_rule_categories(id) ON DELETE RESTRICT,
  computation_type     text NOT NULL,
  amount_fixed         numeric(12,2),
  percentage           numeric(6,3),
  percentage_base_code text,
  formula_expression   text,
  condition_type       text NOT NULL DEFAULT 'always',
  condition_expression text,
  appears_on_payslip   boolean NOT NULL DEFAULT true,
  is_active            boolean NOT NULL DEFAULT true,
  note                 text NOT NULL DEFAULT '',
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rule_code_is_identifier CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT rule_computation_type_known CHECK (
    computation_type IN ('fixed', 'percentage', 'formula')
  ),
  CONSTRAINT rule_condition_type_known CHECK (condition_type IN ('always', 'formula')),

  -- Each computation type must carry the inputs it actually needs, and no others
  -- may be half-filled. This is the difference between a rule that cannot compute
  -- and a rule that computes something nobody intended.
  CONSTRAINT rule_fixed_has_amount CHECK (
    computation_type <> 'fixed' OR amount_fixed IS NOT NULL
  ),
  CONSTRAINT rule_percentage_has_rate_and_base CHECK (
    computation_type <> 'percentage'
    OR (percentage IS NOT NULL AND percentage_base_code IS NOT NULL)
  ),
  CONSTRAINT rule_formula_has_expression CHECK (
    computation_type <> 'formula'
    OR (formula_expression IS NOT NULL AND length(trim(formula_expression)) > 0)
  ),
  CONSTRAINT rule_condition_has_expression CHECK (
    condition_type <> 'formula'
    OR (condition_expression IS NOT NULL AND length(trim(condition_expression)) > 0)
  )
);

CREATE INDEX salary_rules_category_idx ON salary_rules (category_id);

CREATE TABLE salary_structure_rules (
  id                  serial PRIMARY KEY,
  salary_structure_id smallint NOT NULL REFERENCES salary_structures(id) ON DELETE CASCADE,
  salary_rule_id      smallint NOT NULL REFERENCES salary_rules(id) ON DELETE RESTRICT,
  sequence            integer NOT NULL,
  CONSTRAINT structure_rule_sequence_positive CHECK (sequence > 0),
  CONSTRAINT structure_rule_unique UNIQUE (salary_structure_id, salary_rule_id),
  CONSTRAINT structure_sequence_unique UNIQUE (salary_structure_id, sequence)
);

CREATE INDEX structure_rules_execution_idx
  ON salary_structure_rules (salary_structure_id, sequence);

-- Deferred from 006: contracts reference the structure that prices them.
ALTER TABLE contracts
  ADD CONSTRAINT contracts_salary_structure_fk
  FOREIGN KEY (salary_structure_id) REFERENCES salary_structures(id) ON DELETE RESTRICT;

-- Categories are structural: the engine and the payslip layout both reference
-- these codes by name, so they belong to the schema rather than to demo data.
INSERT INTO salary_rule_categories (code, name, sequence, sign) VALUES
  ('BASIC', 'Basic',       10,  1),
  ('ALW',   'Allowances',  20,  1),
  ('GROSS', 'Gross',       30,  1),
  ('DED',   'Deductions',  40, -1),
  ('NET',   'Net',         50,  1);
