-- Two changes that belong together: a way to invalidate an attendance record
-- outright, and a rule about who may do it to whom.
--
-- Correcting a record and invalidating one are different acts. A correction
-- says "this happened, at a different time"; an invalidation says "this did not
-- happen" -- a duplicate punch, a reader misfire, a record entered against the
-- wrong person. Until now the only way to express the second was to edit the
-- times into something meaningless, which leaves a record that still counts.

-- ---------------------------------------------------------------------------
-- 1. Invalidation.
--
-- Kept as a row, not a DELETE. Payroll already computed against it, the audit
-- log points at it, and "this record was voided by Priya on the 3rd because it
-- was a duplicate" is the answer to the question somebody will ask. A deleted
-- row answers nothing.

ALTER TABLE attendance_records
  ADD COLUMN voided_at         timestamptz,
  ADD COLUMN voided_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN void_reason       text;

-- Mirrors attendance_edit_is_attributed: an invalidation that does not say who
-- and why is not an invalidation, it is missing data.
ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_void_is_attributed
  CHECK (
    voided_at IS NULL
    OR (voided_by_user_id IS NOT NULL AND void_reason IS NOT NULL
        AND length(trim(void_reason)) > 0)
  );

CREATE INDEX attendance_live_idx ON attendance_records (employee_id, check_in DESC)
  WHERE voided_at IS NULL;

COMMENT ON COLUMN attendance_records.voided_at IS
  'Set when the record is declared not to have happened. Voided rows are kept, excluded from payroll and from every count, and shown struck through on screen.';

-- ---------------------------------------------------------------------------
-- 2. A voided record must stop reserving its slot.
--
-- The overlap constraint exists so one person cannot be in two places at once.
-- A record that did not happen is not a place they were, and leaving it in the
-- constraint makes the common repair impossible: void the reader's bad 09:00
-- punch, enter the real one, and the exclusion refuses the replacement because
-- of the row you just said was wrong.

ALTER TABLE attendance_records DROP CONSTRAINT attendance_no_overlap;

ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    tstzrange(check_in, presence_end) WITH &&
  ) WHERE (voided_at IS NULL);

COMMENT ON CONSTRAINT attendance_no_overlap ON attendance_records IS
  'One person cannot be present twice over. Applies to live records only: a voided record did not happen, so it reserves nothing and a replacement may take its place.';

-- ---------------------------------------------------------------------------
-- 3. Everything derived from attendance stops counting voided rows.
--
-- The view is the one that matters most, because a reader who did not know
-- about voiding would find the numbers here and trust them.

CREATE OR REPLACE VIEW v_attendance_daily AS
SELECT
  a.employee_id,
  (a.check_in AT TIME ZONE 'Asia/Kolkata')::date AS work_date,
  count(*)                                        AS punch_count,
  SUM(COALESCE(a.worked_hours, 0))                AS worked_hours,
  bool_or(a.status = 'late')                      AS was_late,
  bool_or(a.status = 'missing_checkout')          AS has_missing_checkout,
  bool_or(a.is_manually_edited)                   AS was_manually_edited
FROM attendance_records a
WHERE a.voided_at IS NULL
GROUP BY a.employee_id, (a.check_in AT TIME ZONE 'Asia/Kolkata')::date;

-- ---------------------------------------------------------------------------
-- 4. Seniority becomes an authorisation input.
--
-- rank was documented as ordering and hints only, with a note that
-- authorisation reads role_permissions and never this. That is no longer true,
-- and the comment is corrected rather than left to mislead the next reader.
--
-- The permission still decides *whether* someone may correct attendance at all.
-- Rank decides *whose*: an HR Manager holds attendance:correct over the whole
-- company, and may not use it on another HR Manager, on anyone above them, or
-- on themselves. Strictly greater, so equal ranks cannot touch each other --
-- which also means nobody corrects their own timesheet, and that is the point
-- rather than a side effect.

COMMENT ON COLUMN roles.rank IS
  'Seniority. role_permissions decides what a role may do; this decides who they may do it to -- an actor may act on an employee whose role ranks strictly below theirs. An employee with no user account ranks below everyone.';
