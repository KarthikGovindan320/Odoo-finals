-- Read models for balances and the dashboard.
--
-- These exist so that "leave balance" and "salary cost by department" have
-- exactly one definition each. A view that both the API and the dashboard read
-- cannot drift the way two hand-written aggregate queries would.
--
-- Plain views rather than materialized ones: at our data volume the indexes carry
-- them, and a materialized view would need a refresh policy that could serve
-- stale numbers on a dashboard the spec requires to be live.

-- Leave balance, derived. allocated - consumed, never a stored counter.
CREATE VIEW v_time_off_balances AS
SELECT
  a.id                AS allocation_id,
  a.employee_id,
  a.time_off_type_id,
  t.code              AS type_code,
  t.name              AS type_name,
  t.unit,
  a.valid_from,
  a.valid_to,
  a.allocated_amount,
  COALESCE(consumed.total, 0)                        AS consumed_amount,
  a.allocated_amount - COALESCE(consumed.total, 0)   AS remaining_amount,
  a.valid_to < CURRENT_DATE                          AS is_expired
FROM time_off_allocations a
JOIN time_off_types t ON t.id = a.time_off_type_id
LEFT JOIN LATERAL (
  SELECT SUM(c.amount) AS total
  FROM time_off_consumptions c
  WHERE c.time_off_allocation_id = a.id
) consumed ON true
WHERE a.state = 'approved';

-- The contract in force today, one row per employee. Period-specific resolution
-- for payroll is a different question and lives in the contract resolver service.
CREATE VIEW v_employee_current_contract AS
SELECT DISTINCT ON (c.employee_id)
  c.employee_id,
  c.id            AS contract_id,
  c.reference,
  c.wage,
  c.wage_type,
  c.salary_structure_id,
  c.working_schedule_id,
  c.start_date,
  c.end_date
FROM contracts c
WHERE c.state = 'running'
  AND c.validity @> CURRENT_DATE
ORDER BY c.employee_id, c.start_date DESC;

-- Dashboard: salary cost and headcount per department, from finalized payroll.
CREATE VIEW v_payroll_cost_by_department AS
SELECT
  d.id                              AS department_id,
  d.name                            AS department_name,
  p.period_start,
  p.period_end,
  count(DISTINCT ps.employee_id)    AS employee_count,
  SUM(ps.gross_amount)              AS total_gross,
  SUM(ps.net_amount)                AS total_net,
  ROUND(AVG(ps.net_amount), 2)      AS average_net
FROM payslips ps
JOIN payruns p   ON p.id = ps.payrun_id
JOIN employees e ON e.id = ps.employee_id
JOIN departments d ON d.id = e.department_id
WHERE ps.state IN ('validated', 'paid')
GROUP BY d.id, d.name, p.period_start, p.period_end;

-- Dashboard: net salary trend, one row per calendar month of payroll history.
CREATE VIEW v_monthly_net_trend AS
SELECT
  date_trunc('month', ps.period_start)::date AS month_start,
  count(*)                                   AS payslip_count,
  SUM(ps.gross_amount)                       AS total_gross,
  SUM(ps.net_amount)                         AS total_net,
  ROUND(AVG(ps.net_amount), 2)               AS average_net
FROM payslips ps
WHERE ps.state IN ('validated', 'paid')
GROUP BY date_trunc('month', ps.period_start);

-- Dashboard: attendance quality. One row per employee per day worked.
CREATE VIEW v_attendance_daily AS
SELECT
  a.employee_id,
  (a.check_in AT TIME ZONE 'Asia/Kolkata')::date AS work_date,
  count(*)                                        AS punch_count,
  SUM(COALESCE(a.worked_hours, 0))                AS worked_hours,
  bool_or(a.status = 'late')                      AS was_late,
  bool_or(a.status = 'missing_checkout')          AS has_missing_checkout,
  bool_or(a.is_manually_edited)                   AS was_manually_edited
FROM attendance_records a
GROUP BY a.employee_id, (a.check_in AT TIME ZONE 'Asia/Kolkata')::date;
