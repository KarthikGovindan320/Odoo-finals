-- Attendance is evidence of actual presence, and it is expected to be imperfect:
-- late arrivals, forgotten check-outs, absences, corrections by authorised staff.
--
-- Two things are enforced by the database rather than trusted to the caller:
--   * worked_hours is generated, so it can never disagree with check_in/check_out.
--   * an employee cannot be in two places at once. COALESCE(check_out,'infinity')
--     means an open check-in blocks every later punch until it is closed, which
--     is the real-world rule and makes a forgotten check-out self-announcing.

CREATE TABLE attendance_records (
  id                 bigserial PRIMARY KEY,
  employee_id        bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  check_in           timestamptz NOT NULL,
  check_out          timestamptz,
  worked_hours       numeric(6,2) GENERATED ALWAYS AS (
    CASE WHEN check_out IS NULL THEN NULL
         ELSE ROUND((EXTRACT(EPOCH FROM (check_out - check_in)) / 3600.0)::numeric, 2)
    END
  ) STORED,
  status             text NOT NULL DEFAULT 'present',
  is_manually_edited boolean NOT NULL DEFAULT false,
  edited_by_user_id  bigint REFERENCES users(id) ON DELETE SET NULL,
  edited_at          timestamptz,
  edit_reason        text,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attendance_out_after_in CHECK (check_out IS NULL OR check_out > check_in),
  CONSTRAINT attendance_status_known CHECK (
    status IN ('present', 'late', 'early_leave', 'overtime', 'missing_checkout', 'absent')
  ),
  -- A manual correction must say who and why. Without this the audit trail has
  -- a hole exactly where it matters most.
  CONSTRAINT attendance_edit_is_attributed CHECK (
    NOT is_manually_edited
    OR (edited_by_user_id IS NOT NULL AND edited_at IS NOT NULL
        AND edit_reason IS NOT NULL AND length(trim(edit_reason)) > 0)
  ),

  CONSTRAINT attendance_no_overlap EXCLUDE USING gist (
    employee_id WITH =,
    tstzrange(check_in, COALESCE(check_out, 'infinity'::timestamptz)) WITH &&
  )
);

CREATE INDEX attendance_employee_day_idx ON attendance_records (employee_id, check_in DESC);
CREATE INDEX attendance_period_idx       ON attendance_records (check_in);
CREATE INDEX attendance_exception_idx    ON attendance_records (status)
  WHERE status <> 'present';
