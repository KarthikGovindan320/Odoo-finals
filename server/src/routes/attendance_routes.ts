/**
 * Attendance.
 *
 * Two permissions, not one. attendance:write lets an employee record their own
 * presence -- check in, and close their own punch; attendance:correct lets
 * authorised staff change a record after the fact, and the database refuses a
 * correction that does not say who made it and why. Backdating is deliberately
 * reserved for correctors: for self-service it is the difference between a
 * convenience and a fraud vector.
 *
 * "Today" is decided by the database in the tenant timezone, against the parsed
 * instant rather than the text the client sent -- both halves matter, and see
 * the note on the POST handler for what each of them was getting wrong.
 */
import { z } from 'zod';
import type { Request } from 'express';

import { AppError, forbidden, notFound, workflowViolation } from '../errors/app_error.ts';
import { query, queryOne, withTransaction, insertedId } from '../db/pool.ts';
import type { QueryParameter } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';
import { requireOwnEmployee, scopedEmployeeId } from '../middleware/authorize.ts';
import { parseOrThrow, validateBody } from '../middleware/validate.ts';
import { assertExportable, sendSheet } from '../export/respond.ts';
import { attendanceInput } from '../../../shared/schemas/hr.ts';
import {
  exportFormat, identifier, isoDate, paginationQuery,
} from '../../../shared/schemas/common.ts';
import { TENANT_TIMEZONE } from '../../../shared/tenant.ts';

type AttendanceRow = {
  id: number;
  employee_id: number;
  employee_name: string;
  check_in: string;
  check_out: string | null;
  worked_hours: number | null;
  status: string;
  is_manually_edited: boolean;
  edit_reason: string | null;
  edited_by: string | null;
};

const listQuery = paginationQuery.safeExtend({
  employee_id: identifier.optional(),
  status: z.string().max(30).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/** See employee_routes.ts: the list's filters, without its pagination. */
const exportQuery = listQuery.omit({ page: true, page_size: true }).extend({
  format: exportFormat,
});

const attendance = createGuardedRouter();

/**
 * The WHERE the list and the export share.
 *
 * Extracted rather than copied. An export that filters even slightly differently
 * from the screen it was launched from is a file that disagrees with what the
 * person saw, and they will not find out from the file.
 */
function attendanceFilter(
  request: Request,
  filters: { employee_id?: number; status?: string; from?: string; to?: string },
): { where: string; params: QueryParameter[] } {
  const conditions: string[] = ['true'];
  const params: QueryParameter[] = [];

  const restrictTo = scopedEmployeeId(request) ?? filters.employee_id;
  if (restrictTo != null) {
    params.push(restrictTo);
    conditions.push(`a.employee_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`a.status = $${params.length}`);
  }
  if (filters.from) {
    params.push(TENANT_TIMEZONE, filters.from);
    conditions.push(
      `(a.check_in AT TIME ZONE $${params.length - 1})::date >= $${params.length}::date`,
    );
  }
  if (filters.to) {
    params.push(TENANT_TIMEZONE, filters.to);
    conditions.push(
      `(a.check_in AT TIME ZONE $${params.length - 1})::date <= $${params.length}::date`,
    );
  }

  return { where: conditions.join(' AND '), params };
}

attendance.get('/', 'attendance:read', async (request, response) => {
  const filters = parseOrThrow(listQuery, request.query);
  const { where, params } = attendanceFilter(request, filters);
  const totalRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM attendance_records a WHERE ${where}`,
    params,
  );

  const rows = await query<AttendanceRow>(
    `SELECT a.id, a.employee_id,
            e.first_name || ' ' || e.last_name AS employee_name,
            a.check_in, a.check_out, a.worked_hours, a.status,
            a.is_manually_edited, a.edit_reason,
            u.email AS edited_by
       FROM attendance_records a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN users u ON u.id = a.edited_by_user_id
      WHERE ${where}
      ORDER BY a.check_in DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.page_size, (filters.page - 1) * filters.page_size],
  );

  response.json({
    rows, page: filters.page, page_size: filters.page_size, total: totalRow?.total ?? 0,
    total_pages: Math.max(Math.ceil((totalRow?.total ?? 0) / filters.page_size), 1),
  });
});

attendance.get('/export', 'attendance:read', async (request, response) => {
  const filters = parseOrThrow(exportQuery, request.query);
  const { where, params } = attendanceFilter(request, filters);

  const totalRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM attendance_records a WHERE ${where}`,
    params,
  );
  assertExportable(totalRow?.total ?? 0);

  const rows = await query<AttendanceRow & { employee_number: string; department_name: string | null }>(
    `SELECT a.id, a.employee_id,
            e.employee_number,
            e.first_name || ' ' || e.last_name AS employee_name,
            d.name AS department_name,
            a.check_in, a.check_out, a.worked_hours, a.status,
            a.is_manually_edited, a.edit_reason,
            u.email AS edited_by
       FROM attendance_records a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN users u ON u.id = a.edited_by_user_id
      WHERE ${where}
      ORDER BY a.check_in DESC`,
    params,
  );

  /*
   * Timestamps are written in the tenant's timezone, split into a date and a
   * time. A UTC instant in a spreadsheet is read as a local one by whoever opens
   * it, so a 09:00 check-in becomes 03:30 the moment it leaves this system --
   * and the column is a report about when people arrived.
   */
  const local = (value: string | null, part: 'date' | 'time'): string => {
    if (value === null) return '';
    const shown = new Date(value).toLocaleString('en-GB', {
      timeZone: TENANT_TIMEZONE,
      ...(part === 'date'
        ? { year: 'numeric', month: '2-digit', day: '2-digit' }
        : { hour: '2-digit', minute: '2-digit', hour12: false }),
    });
    return part === 'date' ? shown.split('/').reverse().join('-') : shown;
  };

  sendSheet(response, {
    name: 'Attendance',
    rows,
    columns: [
      { header: 'Employee number', value: (row) => row.employee_number },
      { header: 'Employee', value: (row) => row.employee_name },
      { header: 'Department', value: (row) => row.department_name },
      { header: 'Date', type: 'date', value: (row) => local(row.check_in, 'date') },
      { header: 'Check in', value: (row) => local(row.check_in, 'time') },
      { header: 'Check out', value: (row) => local(row.check_out, 'time') },
      { header: 'Worked hours', type: 'number', value: (row) => row.worked_hours },
      { header: 'Status', value: (row) => row.status },
      { header: 'Manually edited', value: (row) => (row.is_manually_edited ? 'Yes' : 'No') },
      { header: 'Edit reason', value: (row) => row.edit_reason },
      { header: 'Edited by', value: (row) => row.edited_by },
    ],
  }, filters.format);
});

attendance.post('/', 'attendance:write', validateBody(attendanceInput), async (request, response) => {
  const input = request.body as typeof attendanceInput._output;
  requireOwnEmployee(request, input.employee_id);

  // Self-service records today only. Anything historical is a correction, and
  // corrections are a separate permission with an audit trail attached.
  //
  // "Today" is asked of the database in the tenant timezone, and asked about the
  // parsed instant rather than the string the client sent. Both halves matter:
  // comparing against new Date().toISOString() used UTC, so between midnight and
  // 05:30 IST an employee's genuine check-in was refused as not-today; and
  // comparing string prefixes let a caller pick their own offset to shift which
  // calendar day the timestamp appeared to fall on.
  if (request.accessScope === 'own') {
    const sameDay = await queryOne<{ is_today: boolean }>(
      `SELECT ($1::timestamptz AT TIME ZONE $2)::date
              = (now() AT TIME ZONE $2)::date AS is_today`,
      [input.check_in, TENANT_TIMEZONE],
    );

    if (sameDay?.is_today !== true) {
      throw forbidden(
        'You can only record attendance for today. Ask HR to correct an earlier day.',
      );
    }
  }

  const id = await withTransaction(async (client) => {
    const row = await client.queryOne<{ id: number }>(
      `INSERT INTO attendance_records (employee_id, check_in, check_out, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        input.employee_id,
        input.check_in,
        input.check_out ?? null,
        input.check_out ? 'present' : 'missing_checkout',
      ],
    );
    return insertedId(row, 'an attendance record');
  }, request.auth?.userId);

  response.status(201).json(await queryOne('SELECT * FROM attendance_records WHERE id = $1', [id]));
});

/**
 * Closing your own open punch.
 *
 * Separate from PATCH on purpose. Editing an attendance record is a correction:
 * it needs attendance:correct, it demands a written reason, and it stamps the
 * row as manually edited. Checking out at the end of your own shift is none of
 * those things -- it is the second half of an ordinary punch, and routing it
 * through the correction endpoint would either hand every employee the
 * corrector permission or mark every normal day as edited.
 *
 * The check-out time is the server's clock, not the caller's, so nobody extends
 * their own day by sending a later timestamp.
 */
attendance.post('/:id/check-out', 'attendance:write', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);

  const record = await queryOne<{ employee_id: number; check_out: string | null; is_today: boolean }>(
    `SELECT employee_id, check_out,
            (check_in AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date AS is_today
       FROM attendance_records WHERE id = $1`,
    [id, TENANT_TIMEZONE],
  );

  if (record === null) {
    throw notFound('Attendance record', id);
  }
  requireOwnEmployee(request, record.employee_id);

  if (record.check_out !== null) {
    throw workflowViolation('That attendance record already has a check-out.');
  }

  // Closing yesterday's forgotten punch with today's clock would invent hours.
  // That is a correction, and corrections are somebody else's permission.
  if (request.accessScope === 'own' && !record.is_today) {
    throw forbidden(
      'That check-in was not today, so it can only be closed by HR as a correction. ' +
        'Ask them to set the time you actually left.',
    );
  }

  const updated = await withTransaction(
    (client) =>
      client.queryOne(
        `UPDATE attendance_records
            SET check_out = now(), status = 'present'
          WHERE id = $1 AND check_out IS NULL
      RETURNING id, employee_id, check_in, check_out, worked_hours, status`,
        [id],
      ),
    request.auth?.userId,
  );

  if (updated === null) {
    throw workflowViolation('That attendance record was closed by someone else a moment ago.');
  }

  response.json(updated);
});

attendance.patch('/:id', 'attendance:correct', validateBody(attendanceInput), async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const input = request.body as typeof attendanceInput._output;

  if (!input.edit_reason || input.edit_reason.trim() === '') {
    throw new AppError(
      'validation_failed',
      'A correction must say why it was made — the reason is part of the audit trail.',
      { fields: [{ field: 'edit_reason', message: 'Give a reason for this correction.' }] },
    );
  }

  const existing = await queryOne<{ id: number }>(
    'SELECT id FROM attendance_records WHERE id = $1',
    [id],
  );
  if (existing === null) {
    throw notFound('Attendance record', id);
  }

  await withTransaction(async (client) => {
    // Supplying the missing check-out is the whole point of most corrections, so
    // the status has to move with it. Leaving it alone meant a record stayed
    // 'missing_checkout' after being completed -- still in the exceptions filter,
    // still raising OPEN_ATTENDANCE on every payrun.
    await client.query(
      `UPDATE attendance_records
          SET check_in = $2, check_out = $3,
              status = CASE
                         WHEN $3::timestamptz IS NULL THEN 'missing_checkout'
                         WHEN status = 'missing_checkout' THEN 'present'
                         ELSE status
                       END,
              is_manually_edited = true, edited_by_user_id = $4, edited_at = now(), edit_reason = $5
        WHERE id = $1`,
      [id, input.check_in, input.check_out ?? null, request.auth?.userId ?? null, input.edit_reason ?? null],
    );
  }, request.auth?.userId);

  response.json(await queryOne('SELECT * FROM attendance_records WHERE id = $1', [id]));
});

export const attendanceRouter = attendance.router;
