/**
 * The payroll dashboard.
 *
 * Every number on this screen is an aggregate over rows the rest of the platform
 * wrote. There is no fixture, no seeded chart array, and no cached total: change
 * a payrun and reload, and the figures move. That is the spec's explicit demand,
 * and it is only cheap because the schema was built for it -- the filters map onto
 * indexed columns and the two heaviest panels are views.
 */
import { query, queryOne } from '../db/pool.ts';
import type { QueryParameter } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';
import { parseOrThrow } from '../middleware/validate.ts';
import { identifier, isoDate } from '../../../shared/schemas/common.ts';
import { z } from 'zod';

const filterQuery = z.object({
  period_start: isoDate.optional(),
  period_end: isoDate.optional(),
  department_id: identifier.optional(),
  employment_type_id: identifier.optional(),
});

const dashboard = createGuardedRouter();

dashboard.get('/', 'dashboard:read', async (request, response) => {
  const filters = parseOrThrow(filterQuery, request.query);

  // Default to the last twelve months so the dashboard is useful with no
  // configuration -- an empty first screen is the failure mode this avoids.
  const periodStart = filters.period_start ?? new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const periodEnd = filters.period_end ?? new Date().toISOString().slice(0, 10);

  const scope: QueryParameter[] = [
    periodStart,
    periodEnd,
    filters.department_id ?? null,
    filters.employment_type_id ?? null,
  ];

  // Shared by every payroll panel: finalized payslips inside the filtered scope.
  const payslipScope = `
    FROM payslips ps
    JOIN employees e ON e.id = ps.employee_id
   WHERE ps.state IN ('validated', 'paid')
     AND ps.period_start >= $1::date AND ps.period_end <= $2::date
     AND ($3::int IS NULL OR e.department_id = $3::int)
     AND ($4::int IS NULL OR e.employment_type_id = $4::int)`;

  const [kpis, headcount, byDepartment, monthlyTrend, alerts, attendance, timeOff, topWarnings] =
    await Promise.all([
      queryOne(
        `SELECT COALESCE(SUM(ps.net_amount), 0)      AS total_net,
                COALESCE(SUM(ps.gross_amount), 0)    AS total_gross,
                count(*)::int                        AS payslip_count,
                COALESCE(ROUND(AVG(ps.net_amount), 2), 0) AS average_net,
                count(DISTINCT ps.employee_id)::int  AS employees_paid
           ${payslipScope}`,
        scope,
      ),

      // Headcount is not period-scoped, so it takes only the two filters it uses.
      // Passing parameters a statement never references leaves Postgres unable to
      // infer their type, which fails with 42P18 rather than being ignored.
      queryOne(
        `SELECT count(*)::int AS headcount,
                count(*) FILTER (WHERE e.status = 'active')::int AS active_headcount
           FROM employees e
          WHERE e.is_active
            AND ($1::int IS NULL OR e.department_id = $1::int)
            AND ($2::int IS NULL OR e.employment_type_id = $2::int)`,
        [filters.department_id ?? null, filters.employment_type_id ?? null],
      ),

      query(
        `SELECT d.name AS department_name,
                count(DISTINCT ps.employee_id)::int AS employee_count,
                COALESCE(SUM(ps.net_amount), 0)     AS total_net
           FROM payslips ps
           JOIN employees e   ON e.id = ps.employee_id
           JOIN departments d ON d.id = e.department_id
          WHERE ps.state IN ('validated', 'paid')
            AND ps.period_start >= $1::date AND ps.period_end <= $2::date
            AND ($3::int IS NULL OR e.department_id = $3::int)
            AND ($4::int IS NULL OR e.employment_type_id = $4::int)
          GROUP BY d.name
          ORDER BY total_net DESC`,
        scope,
      ),

      query(
        `SELECT to_char(ps.period_start, 'YYYY-MM')  AS month,
                count(*)::int                        AS payslip_count,
                COALESCE(SUM(ps.net_amount), 0)      AS total_net,
                COALESCE(SUM(ps.gross_amount), 0)    AS total_gross
           ${payslipScope}
          GROUP BY 1 ORDER BY 1`,
        scope,
      ),

      query(
        `SELECT p.id AS payrun_id, p.name, p.state,
                p.period_start::text, p.period_end::text,
                count(w.*) FILTER (WHERE w.severity = 'blocker')::int AS blockers,
                count(w.*) FILTER (WHERE w.severity = 'warning')::int AS warnings
           FROM payruns p
           LEFT JOIN payslip_warnings w ON w.payrun_id = p.id
          WHERE p.period_start >= $1::date AND p.period_end <= $2::date
          GROUP BY p.id, p.name, p.state, p.period_start, p.period_end
          ORDER BY p.period_start DESC`,
        [periodStart, periodEnd],
      ),

      queryOne(
        `SELECT count(*)::int                                            AS records,
                count(*) FILTER (WHERE a.status = 'present')::int        AS present,
                count(*) FILTER (WHERE a.status = 'late')::int           AS late,
                count(*) FILTER (WHERE a.status = 'overtime')::int       AS overtime,
                count(*) FILTER (WHERE a.status = 'early_leave')::int    AS early_leave,
                count(*) FILTER (WHERE a.check_out IS NULL)::int         AS missing_checkout,
                count(*) FILTER (WHERE a.is_manually_edited)::int        AS manual_edits,
                COALESCE(ROUND(SUM(a.worked_hours), 1), 0)               AS total_hours
           FROM attendance_records a
           JOIN employees e ON e.id = a.employee_id
          WHERE (a.check_in AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
            AND ($3::int IS NULL OR e.department_id = $3::int)
            AND ($4::int IS NULL OR e.employment_type_id = $4::int)`,
        scope,
      ),

      queryOne(
        `SELECT count(*) FILTER (WHERE r.state = 'approved')::int   AS approved_requests,
                count(*) FILTER (WHERE r.state = 'to_approve')::int AS pending_requests,
                COALESCE(SUM(r.requested_amount) FILTER (WHERE r.state = 'approved'), 0) AS approved_days,
                COALESCE(SUM(r.requested_amount) FILTER (
                  WHERE r.state = 'approved' AND NOT t.is_paid), 0)  AS unpaid_days
           FROM time_off_requests r
           JOIN time_off_types t ON t.id = r.time_off_type_id
           JOIN employees e      ON e.id = r.employee_id
          WHERE r.date_from >= $1::date AND r.date_to <= $2::date
            AND ($3::int IS NULL OR e.department_id = $3::int)
            AND ($4::int IS NULL OR e.employment_type_id = $4::int)`,
        scope,
      ),

      query(
        `SELECT w.severity, w.code, w.message, p.name AS payrun_name
           FROM payslip_warnings w
           JOIN payruns p ON p.id = w.payrun_id
          WHERE p.period_start >= $1::date AND p.period_end <= $2::date
          ORDER BY CASE w.severity WHEN 'blocker' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, w.id DESC
          LIMIT 12`,
        [periodStart, periodEnd],
      ),
    ]);

  // Attendance health: the share of records that are clean. A single number the
  // KPI row can show, defined here once rather than in the browser.
  const attendanceStats = attendance as {
    records: number;
    present: number;
    late: number;
    missing_checkout: number;
  } | null;

  const attendanceHealth =
    attendanceStats === null || attendanceStats.records === 0
      ? null
      : Math.round(
          ((attendanceStats.records - attendanceStats.late - attendanceStats.missing_checkout) /
            attendanceStats.records) *
            1000,
        ) / 10;

  response.json({
    filters: {
      period_start: periodStart,
      period_end: periodEnd,
      department_id: filters.department_id ?? null,
      employment_type_id: filters.employment_type_id ?? null,
    },
    kpis: { ...(kpis as object), ...(headcount as object), attendance_health: attendanceHealth },
    salary_cost_by_department: byDepartment,
    monthly_net_trend: monthlyTrend,
    payrun_alerts: alerts,
    attendance_overview: attendance,
    time_off_overview: timeOff,
    warnings: topWarnings,
  });
});

export const dashboardRouter = dashboard.router;
