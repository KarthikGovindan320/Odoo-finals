-- Working schedules define the weekly pattern an employee is expected to work.
--
-- Two derivations happen in the database rather than in application code:
--   * worked_minutes per line is a STORED generated column, so a line can never
--     disagree with its own start/end/break.
--   * hours_per_week on the parent is maintained by a trigger over the lines.
--     The spec is explicit that weekly hours must be calculated, never typed in.
--
-- hours_per_week is a deliberate denormalisation: the schedule list view has to
-- show it per row, and an aggregate subquery per row is the wrong shape for a
-- list that will be filtered and paginated. The trigger is what keeps it honest.

CREATE TABLE working_schedules (
  id             smallserial PRIMARY KEY,
  name           text NOT NULL UNIQUE,
  schedule_type  text NOT NULL DEFAULT 'full_time',
  timezone       text NOT NULL DEFAULT 'Asia/Kolkata',
  hours_per_week numeric(5,2) NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_type_known CHECK (schedule_type IN ('full_time', 'part_time', 'flexible')),
  CONSTRAINT schedule_hours_not_negative CHECK (hours_per_week >= 0)
);

CREATE TABLE working_schedule_lines (
  id                  serial PRIMARY KEY,
  working_schedule_id smallint NOT NULL REFERENCES working_schedules(id) ON DELETE CASCADE,
  day_of_week         smallint NOT NULL,
  start_time          time NOT NULL,
  end_time            time NOT NULL,
  break_minutes       integer NOT NULL DEFAULT 0,
  worked_minutes      integer GENERATED ALWAYS AS (
    (EXTRACT(EPOCH FROM (end_time - start_time)) / 60)::integer - break_minutes
  ) STORED,
  CONSTRAINT line_day_in_week CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT line_times_ordered CHECK (end_time > start_time),
  CONSTRAINT line_break_not_negative CHECK (break_minutes >= 0),
  CONSTRAINT line_break_shorter_than_span CHECK (
    break_minutes < EXTRACT(EPOCH FROM (end_time - start_time)) / 60
  )
);

CREATE INDEX working_schedule_lines_schedule_idx
  ON working_schedule_lines (working_schedule_id, day_of_week);

CREATE FUNCTION refresh_schedule_weekly_hours() RETURNS trigger AS $$
DECLARE
  target_schedule_id smallint := COALESCE(NEW.working_schedule_id, OLD.working_schedule_id);
BEGIN
  UPDATE working_schedules ws
  SET hours_per_week = COALESCE((
        SELECT ROUND(SUM(l.worked_minutes) / 60.0, 2)
        FROM working_schedule_lines l
        WHERE l.working_schedule_id = target_schedule_id
      ), 0)
  WHERE ws.id = target_schedule_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_schedule_weekly_hours() IS
  'Keeps working_schedules.hours_per_week equal to the sum of its lines. AFTER trigger so it sees the committed row set.';

CREATE TRIGGER working_schedule_lines_refresh_hours
  AFTER INSERT OR UPDATE OR DELETE ON working_schedule_lines
  FOR EACH ROW EXECUTE FUNCTION refresh_schedule_weekly_hours();
