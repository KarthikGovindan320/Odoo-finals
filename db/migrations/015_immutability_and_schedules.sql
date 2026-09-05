-- Two corrections to earlier migrations, plus a constraint 004 should have had.
--
-- Forward-only: 010 and 004 stay exactly as they were applied.

-- ---------------------------------------------------------------------------
-- 1. Payslip immutability now covers the whole row.
--
-- 010's trigger permitted the validated -> paid transition when gross, net,
-- period, contract and worked_days were unchanged. It said nothing about
-- scheduled_days, worked_hours, paid_leave_days, unpaid_leave_days,
-- overtime_hours, proration_factor, currency_code, number, employee_id or
-- salary_structure_id -- all of which could therefore still be rewritten on a
-- finalized payslip through that gap.
--
-- Rather than extend the list (and leave the next column added to the table
-- unguarded by default), compare the rows wholesale and name the few fields the
-- transition is actually allowed to move.

CREATE OR REPLACE FUNCTION reject_finalized_payslip_header_change() RETURNS trigger AS $$
DECLARE
  permitted_old jsonb;
  permitted_new jsonb;
BEGIN
  IF OLD.state NOT IN ('validated', 'paid') THEN
    RETURN NEW;
  END IF;

  -- Everything except the fields the validated -> paid step is allowed to
  -- change. Anything new added to this table is covered without being listed.
  permitted_old := to_jsonb(OLD) - 'state';
  permitted_new := to_jsonb(NEW) - 'state';

  IF OLD.state = 'validated' AND NEW.state = 'paid' AND permitted_old = permitted_new THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Payslip % is % and is immutable history; only the validated to paid transition is permitted.',
    OLD.id, OLD.state
    USING ERRCODE = 'restrict_violation',
          CONSTRAINT = 'payslip_immutable_when_final';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reject_finalized_payslip_header_change() IS
  'A finalized payslip may only move validated -> paid, and nothing else about it may move with it. Compares the whole row rather than a hand-picked subset.';

-- ---------------------------------------------------------------------------
-- 2. Weekly hours are recomputed once per statement, not once per row.
--
-- 004 attached refresh_schedule_weekly_hours as FOR EACH ROW. Because the
-- schedule editor replaces lines wholesale, saving a five-day schedule fired ten
-- separate aggregate-and-update passes over the same parent row -- each one
-- taking a row lock and writing a value the next one overwrote.
--
-- A statement-level trigger needs the affected schedule ids, which come from
-- transition tables.

CREATE OR REPLACE FUNCTION refresh_schedule_weekly_hours_statement() RETURNS trigger AS $$
BEGIN
  UPDATE working_schedules ws
     SET hours_per_week = COALESCE((
           SELECT ROUND(SUM(l.worked_minutes) / 60.0, 2)
             FROM working_schedule_lines l
            WHERE l.working_schedule_id = ws.id
         ), 0)
   WHERE ws.id IN (SELECT working_schedule_id FROM touched);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_schedule_weekly_hours_statement() IS
  'Statement-level equivalent of refresh_schedule_weekly_hours. Recomputes each affected schedule once however many lines the statement touched.';

DROP TRIGGER working_schedule_lines_refresh_hours ON working_schedule_lines;

CREATE TRIGGER working_schedule_lines_refresh_hours_ins
  AFTER INSERT ON working_schedule_lines
  REFERENCING NEW TABLE AS touched
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_schedule_weekly_hours_statement();

CREATE TRIGGER working_schedule_lines_refresh_hours_upd
  AFTER UPDATE ON working_schedule_lines
  REFERENCING NEW TABLE AS touched
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_schedule_weekly_hours_statement();

CREATE TRIGGER working_schedule_lines_refresh_hours_del
  AFTER DELETE ON working_schedule_lines
  REFERENCING OLD TABLE AS touched
  FOR EACH STATEMENT EXECUTE FUNCTION refresh_schedule_weekly_hours_statement();

-- ---------------------------------------------------------------------------
-- 3. A schedule cannot have two lines overlapping on the same day.
--
-- 004 allowed any number of lines per weekday with no constraint between them,
-- so Monday 09:00-18:00 and Monday 10:00-19:00 could coexist and be counted
-- twice in hours_per_week.
--
-- Overlap rather than uniqueness: a genuine split shift (09:00-13:00 and
-- 14:00-18:00) is two lines on one day and must stay legal. Only the impossible
-- case -- being in two places at once -- is forbidden.

-- Postgres ships range types over dates and timestamps but not over `time`,
-- and a shift is a time of day rather than an instant. Declaring the type is a
-- one-liner and gives the GiST support the exclusion constraint needs.
CREATE TYPE timerange AS RANGE (subtype = time);

COMMENT ON TYPE timerange IS
  'A span within a day. Used by the working schedule overlap constraint; Postgres has no built-in range over `time`.';

ALTER TABLE working_schedule_lines
  ADD CONSTRAINT schedule_line_no_overlap EXCLUDE USING gist (
    working_schedule_id             WITH =,
    day_of_week                     WITH =,
    timerange(start_time, end_time) WITH &&
  );

COMMENT ON CONSTRAINT schedule_line_no_overlap ON working_schedule_lines IS
  'Two shifts on one day may not overlap. Split shifts (a morning and an afternoon line) remain legal; a duplicated or overlapping line does not.';
