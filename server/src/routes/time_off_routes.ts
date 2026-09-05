/**
 * Time off: types, allocations, requests, and the approval that moves balance.
 *
 * Approval is the only operation here that changes a balance, and it does so by
 * writing consumption rows inside the same transaction as the state change. If
 * the balance is short, nothing is written and the request stays pending -- there
 * is no window in which a request is approved but unfunded.
 *
 * That holds under concurrency because the allocations are locked before the
 * balance is read (consumption.ts) and a database trigger refuses an overdraw
 * whatever path reaches it (migration 014). Without both, two approvals could
 * each read the same remaining balance and each spend it.
 *
 * Refusing or cancelling a previously approved request deletes its consumption
 * rows. Because balance is derived rather than stored, that is the whole reversal.
 */
import { z } from 'zod';

import { AppError, notFound, workflowViolation } from '../errors/app_error.ts';
import { query, queryOne, withTransaction } from '../db/pool.ts';
import type { QueryParameter } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';
import { requireOwnEmployee, scopedEmployeeId } from '../middleware/authorize.ts';
import { parseOrThrow, validateBody } from '../middleware/validate.ts';
import { assertExportable, sendSheet } from '../export/respond.ts';
import {
  decisionInput,
  timeOffAllocationInput,
  timeOffRequestInput,
} from '../../../shared/schemas/hr.ts';
import { exportFormat, identifier, paginationQuery } from '../../../shared/schemas/common.ts';
import { consumeForRequest, releaseForRequest } from '../services/time_off/consumption.ts';
import { deriveLeaveDuration } from '../services/time_off/duration.ts';

const timeOff = createGuardedRouter();

/* ---------------------------------------------------------------- types --- */

timeOff.get('/types', 'timeoff_type:read', async (_request, response) => {
  const rows = await query(
    `SELECT t.id, t.code, t.name, t.unit, t.requires_allocation, t.requires_approval,
            t.is_paid, t.payroll_rule_code, t.color_token, t.max_days_per_request,
            (SELECT count(*)::int FROM time_off_requests r WHERE r.time_off_type_id = t.id) AS request_count
       FROM time_off_types t
      WHERE t.is_active
      ORDER BY t.name`,
  );
  response.json({ rows });
});

const typeInput = z.object({
  code: z.string().trim().min(1, 'A code is required.').max(20),
  name: z.string().trim().min(1, 'A name is required.').max(80),
  unit: z.enum(['day', 'hour']).default('day'),
  requires_allocation: z.boolean().default(true),
  requires_approval: z.boolean().default(true),
  is_paid: z.boolean().default(true),
  color_token: z.string().trim().max(20).default('plum'),
});

timeOff.post('/types', 'timeoff_type:write', validateBody(typeInput), async (request, response) => {
  const input = request.body as typeof typeInput._output;
  const row = await withTransaction(
    (client) =>
      client.queryOne<{ id: number }>(
        `INSERT INTO time_off_types
           (code, name, unit, requires_allocation, requires_approval, is_paid, payroll_rule_code, color_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          input.code, input.name, input.unit, input.requires_allocation,
          input.requires_approval, input.is_paid, input.is_paid ? null : 'LWP', input.color_token,
        ],
      ),
    request.auth?.userId,
  );
  response.status(201).json(row);
});

/* ---------------------------------------------------------- allocations --- */

timeOff.get('/allocations', 'timeoff:read', async (request, response) => {
  const filters = parseOrThrow(
    paginationQuery.safeExtend({ employee_id: identifier.optional() }),
    request.query,
  );

  const restrictTo = scopedEmployeeId(request) ?? filters.employee_id;
  const params: QueryParameter[] = [];
  let where = 'true';
  if (restrictTo != null) {
    params.push(restrictTo);
    where = `a.employee_id = $${params.length}`;
  }

  // The total is returned like every other list endpoint. Without it the client
  // was left inventing the page count from the length of the page it had, so a
  // screen showing 25 of 500 allocations reported "25 records".
  const totalRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM time_off_allocations a WHERE ${where}`,
    params,
  );

  const rows = await query(
    `SELECT a.id, a.employee_id,
            e.first_name || ' ' || e.last_name AS employee_name,
            t.name AS type_name, t.code AS type_code, t.unit,
            a.allocated_amount, a.valid_from::text, a.valid_to::text, a.state, a.notes,
            COALESCE(b.consumed_amount, 0)                     AS consumed_amount,
            COALESCE(b.remaining_amount, a.allocated_amount)   AS remaining_amount
       FROM time_off_allocations a
       JOIN employees e      ON e.id = a.employee_id
       JOIN time_off_types t ON t.id = a.time_off_type_id
       LEFT JOIN v_time_off_balances b ON b.allocation_id = a.id
      WHERE ${where}
      ORDER BY a.valid_to DESC, a.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.page_size, (filters.page - 1) * filters.page_size],
  );

  const total = totalRow?.total ?? 0;
  response.json({
    rows, page: filters.page, page_size: filters.page_size, total,
    total_pages: Math.max(Math.ceil(total / filters.page_size), 1),
  });
});

timeOff.post('/allocations', 'timeoff:approve', validateBody(timeOffAllocationInput), async (request, response) => {
  const input = request.body as typeof timeOffAllocationInput._output;
  const row = await withTransaction(
    (client) =>
      client.queryOne<{ id: number }>(
        `INSERT INTO time_off_allocations
           (employee_id, time_off_type_id, allocated_amount, valid_from, valid_to, state, notes)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6) RETURNING id`,
        [
          input.employee_id, input.time_off_type_id, input.allocated_amount,
          input.valid_from, input.valid_to, input.notes ?? '',
        ],
      ),
    request.auth?.userId,
  );
  response.status(201).json(row);
});

timeOff.post('/allocations/:id/approve', 'timeoff:approve', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);

  await withTransaction(async (client) => {
    const allocation = await client.queryOne<{ state: string }>(
      'SELECT state FROM time_off_allocations WHERE id = $1',
      [id],
    );
    if (allocation === null) {
      throw notFound('Allocation', id);
    }
    if (allocation.state === 'approved') {
      throw workflowViolation('This allocation is already approved.');
    }

    await client.query(
      `UPDATE time_off_allocations
          SET state = 'approved', approved_by_user_id = $2, approved_at = now()
        WHERE id = $1`,
      [id, request.auth?.userId ?? null],
    );
  }, request.auth?.userId);

  response.json({ id, state: 'approved' });
});

/* ------------------------------------------------------------- balances --- */

timeOff.get('/balances', 'timeoff:read', async (request, response) => {
  const filters = parseOrThrow(z.object({ employee_id: identifier.optional() }), request.query);
  const employeeId = scopedEmployeeId(request) ?? filters.employee_id;

  if (employeeId == null) {
    throw new AppError('validation_failed', 'Choose an employee to see leave balances for.');
  }
  requireOwnEmployee(request, employeeId);

  const rows = await query(
    `SELECT type_code, type_name, unit,
            SUM(allocated_amount) AS allocated,
            SUM(consumed_amount)  AS taken,
            SUM(remaining_amount) AS remaining,
            min(valid_from)::text AS valid_from,
            max(valid_to)::text   AS valid_to
       FROM v_time_off_balances
      WHERE employee_id = $1 AND NOT is_expired
      GROUP BY type_code, type_name, unit
      ORDER BY type_name`,
    [employeeId],
  );

  response.json({ employee_id: employeeId, rows });
});

/* ------------------------------------------------------------- requests --- */

timeOff.get('/requests', 'timeoff:read', async (request, response) => {
  const filters = parseOrThrow(
    paginationQuery.safeExtend({
      employee_id: identifier.optional(),
      state: z.enum(['draft', 'to_approve', 'approved', 'refused', 'cancelled']).optional(),
    }),
    request.query,
  );

  const conditions: string[] = ['true'];
  const params: QueryParameter[] = [];

  const restrictTo = scopedEmployeeId(request) ?? filters.employee_id;
  if (restrictTo != null) {
    params.push(restrictTo);
    conditions.push(`r.employee_id = $${params.length}`);
  }
  if (filters.state) {
    params.push(filters.state);
    conditions.push(`r.state = $${params.length}`);
  }

  const where = conditions.join(' AND ');
  const totalRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM time_off_requests r WHERE ${where}`,
    params,
  );

  const rows = await query(
    `SELECT r.id, r.employee_id,
            e.first_name || ' ' || e.last_name AS employee_name,
            e.employee_number,
            t.name AS type_name, t.code AS type_code, t.unit, t.is_paid, t.color_token,
            r.date_from::text, r.date_to::text, r.requested_amount, r.state, r.reason,
            r.decision_note, r.decided_at,
            u.email AS decided_by,
            COALESCE((SELECT SUM(c.amount) FROM time_off_consumptions c
                       WHERE c.time_off_request_id = r.id), 0) AS consumed_amount
       FROM time_off_requests r
       JOIN employees e      ON e.id = r.employee_id
       JOIN time_off_types t ON t.id = r.time_off_type_id
       LEFT JOIN users u     ON u.id = r.decided_by_user_id
      WHERE ${where}
      ORDER BY r.date_from DESC, r.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.page_size, (filters.page - 1) * filters.page_size],
  );

  response.json({
    rows, page: filters.page, page_size: filters.page_size, total: totalRow?.total ?? 0,
    total_pages: Math.max(Math.ceil((totalRow?.total ?? 0) / filters.page_size), 1),
  });
});

timeOff.get('/requests/export', 'timeoff:read', async (request, response) => {
  const filters = parseOrThrow(
    z.object({
      employee_id: identifier.optional(),
      state: z.enum(['draft', 'to_approve', 'approved', 'refused', 'cancelled']).optional(),
      format: exportFormat,
    }),
    request.query,
  );

  const conditions: string[] = ['true'];
  const params: QueryParameter[] = [];
  const restrictTo = scopedEmployeeId(request) ?? filters.employee_id;
  if (restrictTo != null) {
    params.push(restrictTo);
    conditions.push(`r.employee_id = $${params.length}`);
  }
  if (filters.state) {
    params.push(filters.state);
    conditions.push(`r.state = $${params.length}`);
  }
  const where = conditions.join(' AND ');

  const totalRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM time_off_requests r WHERE ${where}`,
    params,
  );
  assertExportable(totalRow?.total ?? 0);

  const rows = await query<Record<string, string | number | null>>(
    `SELECT e.employee_number,
            e.first_name || ' ' || e.last_name AS employee_name,
            d.name AS department_name,
            t.name AS type_name, t.unit, t.is_paid,
            r.date_from::text, r.date_to::text,
            r.requested_amount::float8 AS requested_amount,
            COALESCE((SELECT SUM(c.amount) FROM time_off_consumptions c
                       WHERE c.time_off_request_id = r.id), 0)::float8 AS consumed_amount,
            r.state, r.reason, r.decision_note, r.decided_at::text,
            u.email AS decided_by
       FROM time_off_requests r
       JOIN employees e      ON e.id = r.employee_id
       JOIN time_off_types t ON t.id = r.time_off_type_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN users u     ON u.id = r.decided_by_user_id
      WHERE ${where}
      ORDER BY r.date_from DESC, r.id DESC`,
    params,
  );

  sendSheet(response, {
    name: 'Time off requests',
    rows,
    columns: [
      { header: 'Employee number', value: (row) => row.employee_number },
      { header: 'Employee', value: (row) => row.employee_name },
      { header: 'Department', value: (row) => row.department_name },
      { header: 'Type', value: (row) => row.type_name },
      { header: 'Paid', value: (row) => (row.is_paid ? 'Yes' : 'No') },
      { header: 'From', type: 'date', value: (row) => row.date_from },
      { header: 'To', type: 'date', value: (row) => row.date_to },
      { header: 'Requested', type: 'number', value: (row) => row.requested_amount },
      { header: 'Consumed', type: 'number', value: (row) => row.consumed_amount },
      { header: 'Unit', value: (row) => row.unit },
      { header: 'State', value: (row) => row.state },
      { header: 'Reason', value: (row) => row.reason },
      { header: 'Decision note', value: (row) => row.decision_note },
      { header: 'Decided by', value: (row) => row.decided_by },
    ],
  }, filters.format);
});

timeOff.post('/requests', 'timeoff:write', validateBody(timeOffRequestInput), async (request, response) => {
  const input = request.body as typeof timeOffRequestInput._output;
  requireOwnEmployee(request, input.employee_id);

  const created = await withTransaction(async (client) => {
    // Derived, never accepted from the caller. See services/time_off/duration.ts
    // for why the two used to be able to disagree.
    const duration = await deriveLeaveDuration(client, {
      employeeId: input.employee_id,
      dateFrom: input.date_from,
      dateTo: input.date_to,
    });

    const row = await client.queryOne<{ id: number }>(
      `INSERT INTO time_off_requests
         (employee_id, time_off_type_id, date_from, date_to, requested_amount, state, reason)
       VALUES ($1, $2, $3, $4, $5, 'to_approve', $6) RETURNING id`,
      [
        input.employee_id, input.time_off_type_id, input.date_from,
        input.date_to, duration.amount, input.reason ?? '',
      ],
    );

    return { id: row?.id ?? null, ...duration };
  }, request.auth?.userId);

  response.status(201).json({
    id: created.id,
    requested_amount: created.amount,
    calendar_days: created.calendarDays,
  });
});

type RequestRow = {
  id: number;
  employee_id: number;
  time_off_type_id: number;
  type_name: string;
  requires_allocation: boolean;
  date_from: string;
  date_to: string;
  requested_amount: number;
  state: string;
};

async function loadRequestForDecision(
  client: Parameters<Parameters<typeof withTransaction>[0]>[0],
  id: number,
): Promise<RequestRow> {
  const row = await client.queryOne<RequestRow>(
    `SELECT r.id, r.employee_id, r.time_off_type_id, t.name AS type_name,
            t.requires_allocation, r.date_from::text, r.date_to::text,
            r.requested_amount, r.state
       FROM time_off_requests r
       JOIN time_off_types t ON t.id = r.time_off_type_id
      WHERE r.id = $1`,
    [id],
  );
  if (row === null) {
    throw notFound('Time off request', id);
  }
  return row;
}

timeOff.post('/requests/:id/approve', 'timeoff:approve', validateBody(decisionInput), async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);

  const consumed = await withTransaction(async (client) => {
    const leave = await loadRequestForDecision(client, id);

    if (leave.state === 'approved') {
      throw workflowViolation('This request has already been approved.');
    }
    if (leave.state === 'cancelled') {
      throw workflowViolation('This request was cancelled and can no longer be approved.');
    }

    await client.query(
      `UPDATE time_off_requests
          SET state = 'approved', decided_by_user_id = $2, decided_at = now(), decision_note = $3
        WHERE id = $1`,
      [id, request.auth?.userId ?? null, (request.body as { decision_note?: string }).decision_note ?? ''],
    );

    // Types that need no allocation (unpaid leave) are approved without drawing
    // balance -- there is none to draw. They still reach payroll, through the
    // loss-of-pay rule.
    if (!leave.requires_allocation) {
      return [];
    }

    return consumeForRequest(client, {
      requestId: id,
      employeeId: leave.employee_id,
      timeOffTypeId: leave.time_off_type_id,
      typeName: leave.type_name,
      dateFrom: leave.date_from,
      dateTo: leave.date_to,
      amount: leave.requested_amount,
    });
  }, request.auth?.userId);

  response.json({ id, state: 'approved', consumed_from: consumed });
});

timeOff.post('/requests/:id/refuse', 'timeoff:approve', validateBody(decisionInput), async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);

  await withTransaction(async (client) => {
    const leave = await loadRequestForDecision(client, id);
    if (leave.state === 'refused') {
      throw workflowViolation('This request has already been refused.');
    }

    // Refusing something previously approved gives the balance back. Because
    // balance is derived from consumption rows, deleting them is the entire
    // reversal -- there is no counter to decrement and get wrong.
    await releaseForRequest(client, id);

    await client.query(
      `UPDATE time_off_requests
          SET state = 'refused', decided_by_user_id = $2, decided_at = now(), decision_note = $3
        WHERE id = $1`,
      [id, request.auth?.userId ?? null, (request.body as { decision_note?: string }).decision_note ?? ''],
    );
  }, request.auth?.userId);

  response.json({ id, state: 'refused' });
});

export const timeOffRouter = timeOff.router;
