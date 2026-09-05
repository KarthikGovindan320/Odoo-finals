-- Bound an unclosed attendance punch to a plausible shift length.
--
-- 007 treated a missing check-out as running to 'infinity'. That is right for a
-- live session but wrong for history: one forgotten check-out would block every
-- future punch for that employee until an administrator fixed it, turning a
-- clerical slip into a lockout. It also makes the honest case -- a record from
-- three months ago that was simply never closed -- impossible to represent.
--
-- An open punch now counts as lasting at most 12 hours, longer than any schedule
-- we run. That still prevents what the constraint exists for -- two overlapping
-- punches on one day, which would double-count worked hours -- while letting a
-- forgotten check-out sit in history as the exception it is, visible through
-- status = 'missing_checkout' and surfaced as a payroll warning.
--
-- The bound is held in a trigger-maintained column rather than computed inside
-- the constraint, because timestamptz + interval is only STABLE, not IMMUTABLE,
-- and an index expression must be immutable. Same pattern as
-- working_schedules.hours_per_week: derived data, kept honest by a trigger.
--
-- Forward-only: 007 stays exactly as it was applied, and this supersedes it.

ALTER TABLE attendance_records DROP CONSTRAINT attendance_no_overlap;

ALTER TABLE attendance_records ADD COLUMN presence_end timestamptz;

CREATE FUNCTION set_attendance_presence_end() RETURNS trigger AS $$
BEGIN
  NEW.presence_end := COALESCE(NEW.check_out, NEW.check_in + interval '12 hours');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION set_attendance_presence_end() IS
  'Keeps presence_end equal to check_out, or to a 12-hour cap while the punch is still open.';

CREATE TRIGGER attendance_maintain_presence_end
  BEFORE INSERT OR UPDATE OF check_in, check_out ON attendance_records
  FOR EACH ROW EXECUTE FUNCTION set_attendance_presence_end();

UPDATE attendance_records
   SET presence_end = COALESCE(check_out, check_in + interval '12 hours');

ALTER TABLE attendance_records
  ALTER COLUMN presence_end SET NOT NULL,
  ADD CONSTRAINT attendance_presence_end_after_check_in CHECK (presence_end > check_in),
  ADD CONSTRAINT attendance_no_overlap EXCLUDE USING gist (
    employee_id WITH =,
    tstzrange(check_in, presence_end) WITH &&
  );

COMMENT ON CONSTRAINT attendance_no_overlap ON attendance_records IS
  'An employee cannot be present twice at once. An unclosed punch is bounded by the longest plausible shift rather than by infinity.';
