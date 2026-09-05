-- Three integrity rules that application code was being trusted to keep, moved
-- into the database where they cannot be bypassed by a route that forgets them.
--
-- Forward-only: earlier migrations stay exactly as they were applied.

-- ---------------------------------------------------------------------------
-- 1. A leave allocation cannot be overdrawn.
--
-- Balance is derived (allocated - SUM(consumed)), which made it correct to read
-- but unenforced to write: nothing stopped two approvals, each reading the same
-- remaining balance, from both inserting consumption rows. The view would then
-- report a negative balance that no single write was responsible for.
--
-- A CHECK cannot express this because it spans rows, so it is a trigger. The
-- SELECT ... FOR UPDATE is the load-bearing part: it serialises concurrent
-- approvals on the allocation row, so the second transaction blocks until the
-- first commits and then re-counts against a snapshot that includes it. That
-- makes the trigger a lock as well as an assertion.

CREATE FUNCTION reject_allocation_overdraw() RETURNS trigger AS $$
DECLARE
  target    bigint := COALESCE(NEW.time_off_allocation_id, OLD.time_off_allocation_id);
  allocated numeric(8,2);
  consumed  numeric(8,2);
BEGIN
  SELECT a.allocated_amount INTO allocated
    FROM time_off_allocations a
   WHERE a.id = target
     FOR UPDATE;

  SELECT COALESCE(SUM(c.amount), 0) INTO consumed
    FROM time_off_consumptions c
   WHERE c.time_off_allocation_id = target;

  IF consumed > allocated THEN
    RAISE EXCEPTION
      'Allocation % would be overdrawn: % consumed against % allocated.',
      target, consumed, allocated
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'allocation_not_overdrawn';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reject_allocation_overdraw() IS
  'Refuses a consumption that would take an allocation past its allocated amount. Locks the allocation row, so concurrent approvals serialise rather than racing.';

CREATE TRIGGER consumptions_cannot_overdraw
  AFTER INSERT OR UPDATE ON time_off_consumptions
  FOR EACH ROW EXECUTE FUNCTION reject_allocation_overdraw();

-- ---------------------------------------------------------------------------
-- 2. Finalized payslips cannot cover overlapping periods for one employee.
--
-- 010 enforced this with a unique index on (employee_id, period_start,
-- period_end) -- exact equality. A run for 1-30 September therefore did not
-- collide with an already-paid payslip for 1-15 September, and the employee was
-- paid twice for the overlapping fortnight.
--
-- Every other temporal rule in this schema is a range overlap (contracts,
-- attendance, leave). This is the one where the consequence is money, so it
-- should have been the first.

DROP INDEX payslip_no_duplicate_finalized;

ALTER TABLE payslips
  ADD CONSTRAINT payslip_no_overlapping_finalized EXCLUDE USING gist (
    employee_id                                  WITH =,
    daterange(period_start, period_end, '[]')    WITH &&
  ) WHERE (state IN ('validated', 'paid'));

COMMENT ON CONSTRAINT payslip_no_overlapping_finalized ON payslips IS
  'One finalized payslip per employee per stretch of time. Overlap, not equality: paying 1-30 September on top of a paid 1-15 September is the same mistake as paying the identical period twice.';

-- ---------------------------------------------------------------------------
-- 3. The audit trail stops copying personal data.
--
-- write_audit_log() stored to_jsonb(NEW) -- the whole row -- on every insert.
-- For employees that meant bank account number, IFSC, home address, date of
-- birth and personal email, duplicated into an append-only table on every write,
-- with no retention policy and no route that reads it back.
--
-- The audit trail's job is to record who changed what and when. It does not need
-- to hold a second copy of the most sensitive columns in the system to do that:
-- the fact that a column changed is still recorded, and the current value is one
-- join away for anyone authorised to see it.

-- Masks the value but keeps the key.
--
-- Dropping the key outright would lose the audit trail's actual job: an update
-- that touched only sensitive columns would record {} on both sides, saying that
-- something changed but not what. Replacing the value instead leaves
-- "bank_account_number was changed by user 7 at 14:02" intact while storing no
-- copy of the number.
--
-- STRICT so a NULL payload (old_values on an insert) stays NULL rather than
-- becoming an empty object.
CREATE OR REPLACE FUNCTION redact_audited_row(payload jsonb) RETURNS jsonb AS $$
  SELECT COALESCE(
    jsonb_object_agg(
      entry.key,
      CASE
        WHEN entry.key IN (
          'password_hash', 'password_salt',
          'bank_account_number', 'bank_ifsc',
          'date_of_birth', 'address', 'personal_email'
        ) THEN to_jsonb('[redacted]'::text)
        ELSE entry.value
      END
    ),
    '{}'::jsonb
  )
  FROM jsonb_each(payload) AS entry;
$$ LANGUAGE sql IMMUTABLE STRICT;

COMMENT ON FUNCTION redact_audited_row(jsonb) IS
  'Masks secrets and personal data in a row image before it reaches audit_log. The column name is kept so the trail still says what changed; the value is not duplicated.';

CREATE OR REPLACE FUNCTION write_audit_log() RETURNS trigger AS $$
DECLARE
  changed_columns jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (table_name, record_id, action, actor_user_id, new_values)
    VALUES (TG_TABLE_NAME, NEW.id, 'insert', current_actor_user_id(),
            redact_audited_row(to_jsonb(NEW)));
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Record only what actually changed. An audit row saying "these 30 columns
    -- are identical" is noise that hides the one column that moved.
    SELECT jsonb_object_agg(key, value) INTO changed_columns
    FROM jsonb_each(to_jsonb(NEW))
    WHERE to_jsonb(OLD) -> key IS DISTINCT FROM value;

    IF changed_columns IS NULL THEN
      RETURN NEW;
    END IF;

    INSERT INTO audit_log (table_name, record_id, action, actor_user_id, old_values, new_values)
    VALUES (
      TG_TABLE_NAME, NEW.id, 'update', current_actor_user_id(),
      redact_audited_row(
        (SELECT jsonb_object_agg(key, to_jsonb(OLD) -> key) FROM jsonb_each(changed_columns))
      ),
      redact_audited_row(changed_columns)
    );
    RETURN NEW;
  END IF;

  INSERT INTO audit_log (table_name, record_id, action, actor_user_id, old_values)
  VALUES (TG_TABLE_NAME, OLD.id, 'delete', current_actor_user_id(),
          redact_audited_row(to_jsonb(OLD)));
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Personal data already captured before this migration ran.
UPDATE audit_log
   SET old_values = redact_audited_row(old_values),
       new_values = redact_audited_row(new_values)
 WHERE table_name = 'employees'
   AND (old_values ?| ARRAY['bank_account_number', 'bank_ifsc', 'date_of_birth', 'address', 'personal_email']
     OR new_values ?| ARRAY['bank_account_number', 'bank_ifsc', 'date_of_birth', 'address', 'personal_email']);
