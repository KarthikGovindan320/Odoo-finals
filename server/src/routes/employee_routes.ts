/**
 * Employee master data. Routes parse and shape; the repository does the SQL.
 */
import { z } from 'zod';

import { notFound } from '../errors/app_error.ts';
import { queryOne, withTransaction } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';
import { requireOwnEmployee, scopedEmployeeId } from '../middleware/authorize.ts';
import { parseOrThrow, validateBody } from '../middleware/validate.ts';
import { employeeInput, employeePatchInput } from '../../../shared/schemas/hr.ts';
import { identifier, paginationQuery } from '../../../shared/schemas/common.ts';
import { TENANT_TIMEZONE } from '../../../shared/tenant.ts';
import {
  applyStatusSideEffects,
  archiveEmployee,
  findEmployee,
  insertEmployee,
  listEmployees,
  updateEmployee,
} from '../repositories/employee_repository.ts';

const listQuery = paginationQuery.safeExtend({
  department_id: identifier.optional(),
  employment_type_id: identifier.optional(),
  status: z.enum(['active', 'on_leave', 'terminated']).optional(),
});

const employees = createGuardedRouter();

employees.get('/', 'employee:read', async (request, response) => {
  const filters = parseOrThrow(listQuery, request.query);

  const { rows, total } = await listEmployees(
    {
      search: filters.q,
      departmentId: filters.department_id,
      employmentTypeId: filters.employment_type_id,
      status: filters.status,
      page: filters.page,
      pageSize: filters.page_size,
      scopedEmployeeId: scopedEmployeeId(request),
    },
    filters.sort,
  );

  response.json({
    rows,
    page: filters.page,
    page_size: filters.page_size,
    total,
    total_pages: Math.max(Math.ceil(total / filters.page_size), 1),
  });
});

employees.get('/:id', 'employee:read', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  requireOwnEmployee(request, id);

  const employee = await findEmployee(id);
  if (employee === null) {
    throw notFound('Employee', id);
  }

  response.json(employee);
});

employees.post('/', 'employee:write', validateBody(employeeInput), async (request, response) => {
  const input = request.body as typeof employeeInput._output;

  const id = await withTransaction(
    (client) => insertEmployee(client, input),
    request.auth?.userId,
  );

  response.status(201).json(await findEmployee(id));
});

/**
 * Reduces a stored employee back to the shape the input schema describes, so a
 * partial update can be merged over it. Nulls become '' because that is how the
 * schema spells "no value" for an optional text field, and the repository maps
 * it back to NULL on the way in.
 */
function toEmployeeInput(existing: NonNullable<Awaited<ReturnType<typeof findEmployee>>>) {
  return {
    employee_number: existing.employee_number,
    first_name: existing.first_name,
    last_name: existing.last_name,
    work_email: existing.work_email,
    personal_email: existing.personal_email ?? '',
    work_phone: existing.work_phone ?? '',
    department_id: existing.department_id,
    job_position_id: existing.job_position_id,
    employment_type_id: existing.employment_type_id,
    manager_id: existing.manager_id,
    working_schedule_id: existing.working_schedule_id,
    hire_date: existing.hire_date,
    status: existing.status,
    termination_date: existing.termination_date,
    bank_name: existing.bank_name ?? '',
    bank_account_number: existing.bank_account_number ?? '',
    bank_ifsc: existing.bank_ifsc ?? '',
    address: existing.address ?? '',
  };
}

/**
 * PATCH updates only what it is given.
 *
 * The body is parsed as a partial, merged over the stored record, and the merged
 * result validated with the full schema. That keeps both properties: an omitted
 * field is left alone rather than reset to its create-time default (which would
 * silently un-terminate an employee whose payload happened not to mention
 * status), and whole-record rules are still enforced against what the row will
 * actually become.
 */
employees.patch('/:id', 'employee:write', validateBody(employeePatchInput), async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const existing = await findEmployee(id);
  if (existing === null) {
    throw notFound('Employee', id);
  }

  const patch = request.body as Partial<typeof employeeInput._output>;
  const merged = parseOrThrow(employeeInput, { ...toEmployeeInput(existing), ...patch });

  await withTransaction(async (client) => {
    await updateEmployee(client, id, merged);
    await applyStatusSideEffects(client, id, merged.status);
  }, request.auth?.userId);

  response.json(await findEmployee(id));
});

/**
 * How this employee's scheduled days were actually spent, recently.
 *
 * The four outcomes are the same ones payroll uses, deliberately: a scheduled
 * day is one the working schedule says they work, and it was either attended,
 * covered by paid leave, covered by unpaid leave, or none of those -- which is
 * the UNEXPLAINED_ABSENCE case the payrun warns about. Sharing the definitions
 * means this panel and the payslip cannot tell different stories about the same
 * days.
 *
 * Its own endpoint rather than more columns on the record: it is a different
 * question with a different shape, it takes a period, and the profile should not
 * wait on it.
 */
employees.get('/:id/attendance-summary', 'employee:read', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  requireOwnEmployee(request, id);

  const { days } = parseOrThrow(
    z.object({ days: z.coerce.number().int().min(7).max(366).default(90) }),
    request.query,
  );

  const summary = await queryOne<{
    scheduled_days: number;
    present_days: number;
    paid_leave_days: number;
    unpaid_leave_days: number;
    from_date: string;
    to_date: string;
  }>(
    `WITH bounds AS (
       SELECT (now() AT TIME ZONE $2)::date                       AS to_date,
              (now() AT TIME ZONE $2)::date - ($3::int - 1)       AS from_date
     ),
     calendar AS (
       SELECT generate_series(b.from_date, b.to_date, interval '1 day')::date AS day
         FROM bounds b
     ),
     -- Days the schedule says this employee works. A day with no matching
     -- schedule line is a rest day and is not counted in any bucket.
     scheduled AS (
       SELECT DISTINCT c.day
         FROM calendar c
         JOIN employees e ON e.id = $1
         JOIN working_schedule_lines l
           ON l.working_schedule_id = e.working_schedule_id
          AND l.day_of_week = EXTRACT(DOW FROM c.day)
     ),
     -- Leave wins over attendance: a day covered by approved leave is a leave
     -- day even if a punch also exists for it, which is what stops the buckets
     -- summing to more than the scheduled days.
     on_leave AS (
       SELECT s.day, bool_or(t.is_paid) AS is_paid
         FROM scheduled s
         JOIN time_off_requests r
           ON r.employee_id = $1
          AND r.state = 'approved'
          AND s.day BETWEEN r.date_from AND r.date_to
         JOIN time_off_types t ON t.id = r.time_off_type_id
        GROUP BY s.day
     ),
     attended AS (
       SELECT DISTINCT (a.check_in AT TIME ZONE $2)::date AS day
         FROM attendance_records a
        WHERE a.employee_id = $1
     )
     SELECT (SELECT count(*)::int FROM scheduled)                          AS scheduled_days,
            (SELECT count(*)::int FROM on_leave WHERE is_paid)             AS paid_leave_days,
            (SELECT count(*)::int FROM on_leave WHERE NOT is_paid)         AS unpaid_leave_days,
            (SELECT count(*)::int
               FROM scheduled s
              WHERE EXISTS (SELECT 1 FROM attended a WHERE a.day = s.day)
                AND NOT EXISTS (SELECT 1 FROM on_leave l WHERE l.day = s.day)) AS present_days,
            (SELECT from_date::text FROM bounds)                           AS from_date,
            (SELECT to_date::text FROM bounds)                             AS to_date`,
    [id, TENANT_TIMEZONE, days],
  );

  if (summary === null) {
    throw notFound('Employee', id);
  }

  // Whatever is left over is a scheduled day with neither a punch nor approved
  // leave against it.
  const absent = Math.max(
    summary.scheduled_days - summary.present_days
      - summary.paid_leave_days - summary.unpaid_leave_days,
    0,
  );

  response.json({ ...summary, absent_days: absent, window_days: days });
});

employees.remove('/:id', 'employee:delete', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const existing = await findEmployee(id);
  if (existing === null) {
    throw notFound('Employee', id);
  }

  await withTransaction((client) => archiveEmployee(client, id), request.auth?.userId);
  response.status(204).end();
});

export const employeeRouter = employees.router;
