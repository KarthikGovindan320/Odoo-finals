-- Employee numbers become a format the database issues, rather than free text
-- somebody types.
--
-- The column was `text NOT NULL UNIQUE` and nothing more, so the form accepted
-- whatever was entered: 'EMP0007', 'emp 7', '7', 'Priya's number'. Uniqueness
-- was the only rule, which catches a collision and nothing else -- and a
-- collision is the one mistake a user is least likely to make.
--
-- The shape is EMP-<year of joining>-<sequence within that year>, so the number
-- carries a fact about the person rather than being an opaque counter, and two
-- employees hired in different years cannot contend for the same value.
--
-- Issued server-side, never accepted from the client. A format a user can type
-- is a format a user can mistype, and validating the input would still leave
-- them guessing which number is free.

-- ---------------------------------------------------------------------------
-- 1. Renumber what is already there.
--
-- Ordered by id within each joining year, so the existing sequence -- which is
-- the order people were created -- survives the change.

WITH renumbered AS (
  SELECT id,
         'EMP-'
           || EXTRACT(YEAR FROM hire_date)::int::text
           || '-'
           || lpad(
                row_number() OVER (
                  PARTITION BY EXTRACT(YEAR FROM hire_date) ORDER BY id
                )::text,
                4, '0'
              ) AS issued
    FROM employees
)
UPDATE employees e
   SET employee_number = r.issued
  FROM renumbered r
 WHERE r.id = e.id;

-- ---------------------------------------------------------------------------
-- 2. The counter the next number comes from.
--
-- One row per joining year. A sequence per year rather than one global sequence,
-- because the year is part of the number and a shared counter would leave gaps
-- in every year but the busiest.

CREATE TABLE employee_number_counters (
  year   smallint PRIMARY KEY,
  issued integer  NOT NULL DEFAULT 0,
  CONSTRAINT employee_number_issued_not_negative CHECK (issued >= 0)
);

COMMENT ON TABLE employee_number_counters IS
  'High-water mark per joining year. Numbers are never reused: an archived employee keeps theirs, and payroll history keeps pointing at it.';

-- Start each year above whatever the backfill just handed out.
INSERT INTO employee_number_counters (year, issued)
SELECT EXTRACT(YEAR FROM hire_date)::smallint, count(*)::integer
  FROM employees
 GROUP BY 1;

-- ---------------------------------------------------------------------------
-- 3. Issuing one.
--
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING is a single atomic statement:
-- it takes the row lock, increments, and hands back the new value, so two
-- concurrent hires in the same year queue rather than race. Doing this as
-- SELECT max()+1 would give both the same number and let the unique constraint
-- decide which one failed.

CREATE FUNCTION next_employee_number(hired date) RETURNS text AS $$
DECLARE
  joining_year smallint := EXTRACT(YEAR FROM hired)::smallint;
  sequence_value integer;
BEGIN
  INSERT INTO employee_number_counters (year, issued)
       VALUES (joining_year, 1)
  ON CONFLICT (year)
  DO UPDATE SET issued = employee_number_counters.issued + 1
    RETURNING issued INTO sequence_value;

  IF sequence_value > 9999 THEN
    RAISE EXCEPTION
      'More than 9999 employees joined in %; the employee number format cannot hold another.',
      joining_year
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN 'EMP-' || joining_year::text || '-' || lpad(sequence_value::text, 4, '0');
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION next_employee_number(date) IS
  'Issues the next employee number for the joining year. Atomic: concurrent hires queue on the counter row rather than racing for the same value.';

-- ---------------------------------------------------------------------------
-- 4. Nothing else may be stored.
--
-- Added last, so the backfill above has already made every existing row
-- conform. This is what stops a future route, script or hand-written UPDATE
-- putting free text back into the column.

ALTER TABLE employees
  ADD CONSTRAINT employee_number_shaped
  CHECK (employee_number ~ '^EMP-[0-9]{4}-[0-9]{4}$');

COMMENT ON CONSTRAINT employee_number_shaped ON employees IS
  'EMP-<joining year>-<sequence>. Issued by next_employee_number(); never accepted from a client.';
