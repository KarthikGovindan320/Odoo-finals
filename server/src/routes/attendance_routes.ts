/**
 * Attendance.
 *
 * Two permissions, not one. attendance:write lets an employee record their own
 * presence; attendance:correct lets authorised staff change a record after the
 * fact, and the database refuses a correction that does not say who made it and
 * why. Backdating is deliberately reserved for correctors: for self-service it
 * is the difference between a convenience and a fraud vector.
 */
import { z } from 'zod';

import { AppError, forbidden, notFound } from '../errors/app_error.ts';
import { query, queryOne, withTransaction } from '../db/pool.ts';
import type { QueryParameter } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';
import { requireOwnEmployee, scopedEmployeeId } from '../middleware/authorize.ts';
import { parseOrThrow, validateBody } from '../middleware/validate.ts';
import { attendanceInput } from '../../../shared/schemas/hr.ts';
import { identifier, isoDate, paginationQuery } from '../../../shared/schemas/common.ts';

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

const attendance = createGuardedRouter();

attendance.get('/', 'attendance:read', async (request, response) => {
  const filters = parseOrThrow(listQuery, request.query);
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
    params.push(filters.from);
    conditions.push(`(a.check_in AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}::date`);
  }
  if (filters.to) {
    params.push(filters.to);
    conditions.push(`(a.check_in AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}::date`);
  }

  const where = conditions.join(' AND ');
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

attendance.post('/', 'attendance:write', validateBody(attendanceInput), async (request, response) => {
  const input = request.body as typeof attendanceInput._output;
  requireOwnEmployee(request, input.employee_id);

  // Self-service records today only. Anything historical is a correction, and
  // corrections are a separate permission with an audit trail attached.
  if (request.accessScope === 'own') {
    const today = new Date().toISOString().slice(0, 10);
    if (!input.check_in.startsWith(today)) {
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
    return (row as { id: number }).id;
  }, request.auth?.userId);

  response.status(201).json(await queryOne('SELECT * FROM attendance_records WHERE id = $1', [id]));
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
    await client.query(
      `UPDATE attendance_records
          SET check_in = $2, check_out = $3,
              status = CASE WHEN $3::timestamptz IS NULL THEN 'missing_checkout' ELSE status END,
              is_manually_edited = true, edited_by_user_id = $4, edited_at = now(), edit_reason = $5
        WHERE id = $1`,
      [id, input.check_in, input.check_out ?? null, request.auth?.userId ?? null, input.edit_reason ?? null],
    );
  }, request.auth?.userId);

  response.json(await queryOne('SELECT * FROM attendance_records WHERE id = $1', [id]));
});

export const attendanceRouter = attendance.router;
