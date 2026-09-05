-- Audit trail: who changed what, when.
--
-- Postgres has no idea which application user is behind a statement, so the
-- server sets a transaction-local variable (SET LOCAL app.actor_user_id) as part
-- of the same transaction as the write. current_setting(..., true) returns NULL
-- rather than erroring when it was never set, which is what we want for
-- migrations and seeds.
--
-- One generic trigger function serves every audited table. Adding a table to the
-- audit trail is one CREATE TRIGGER, not another copy of this logic.

CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  table_name     text NOT NULL,
  record_id      bigint NOT NULL,
  action         text NOT NULL,
  actor_user_id  bigint REFERENCES users(id) ON DELETE SET NULL,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  old_values     jsonb,
  new_values     jsonb,
  CONSTRAINT audit_action_known CHECK (action IN ('insert', 'update', 'delete'))
);

CREATE INDEX audit_log_record_idx ON audit_log (table_name, record_id, changed_at DESC);
CREATE INDEX audit_log_actor_idx  ON audit_log (actor_user_id, changed_at DESC);

CREATE FUNCTION current_actor_user_id() RETURNS bigint AS $$
DECLARE
  raw_value text := current_setting('app.actor_user_id', true);
BEGIN
  IF raw_value IS NULL OR raw_value = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw_value::bigint;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION write_audit_log() RETURNS trigger AS $$
DECLARE
  changed_columns jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (table_name, record_id, action, actor_user_id, new_values)
    VALUES (TG_TABLE_NAME, NEW.id, 'insert', current_actor_user_id(), to_jsonb(NEW));
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
      (SELECT jsonb_object_agg(key, to_jsonb(OLD) -> key) FROM jsonb_each(changed_columns)),
      changed_columns
    );
    RETURN NEW;
  END IF;

  INSERT INTO audit_log (table_name, record_id, action, actor_user_id, old_values)
  VALUES (TG_TABLE_NAME, OLD.id, 'delete', current_actor_user_id(), to_jsonb(OLD));
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER employees_audit           AFTER INSERT OR UPDATE OR DELETE ON employees            FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER contracts_audit           AFTER INSERT OR UPDATE OR DELETE ON contracts            FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER attendance_audit          AFTER INSERT OR UPDATE OR DELETE ON attendance_records   FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER timeoff_requests_audit    AFTER INSERT OR UPDATE OR DELETE ON time_off_requests    FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER timeoff_allocations_audit AFTER INSERT OR UPDATE OR DELETE ON time_off_allocations FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER salary_rules_audit        AFTER INSERT OR UPDATE OR DELETE ON salary_rules         FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER payruns_audit             AFTER INSERT OR UPDATE OR DELETE ON payruns              FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER payslips_audit            AFTER INSERT OR UPDATE OR DELETE ON payslips             FOR EACH ROW EXECUTE FUNCTION write_audit_log();
