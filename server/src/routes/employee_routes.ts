/**
 * Employee master data. Routes parse and shape; the repository does the SQL.
 */
import { z } from 'zod';

import { notFound } from '../errors/app_error.ts';
import { withTransaction } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';
import { requireOwnEmployee, scopedEmployeeId } from '../middleware/authorize.ts';
import { parseOrThrow, validateBody } from '../middleware/validate.ts';
import { employeeInput, employeePatchInput } from '../../../shared/schemas/hr.ts';
import { identifier, paginationQuery } from '../../../shared/schemas/common.ts';
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
