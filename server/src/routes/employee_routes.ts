/**
 * Employee master data. Routes parse and shape; the repository does the SQL.
 */
import { z } from 'zod';

import { notFound } from '../errors/app_error.ts';
import { withTransaction } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';
import { requireOwnEmployee, scopedEmployeeId } from '../middleware/authorize.ts';
import { parseOrThrow, validateBody } from '../middleware/validate.ts';
import { employeeInput } from '../../../shared/schemas/hr.ts';
import { identifier, paginationQuery } from '../../../shared/schemas/common.ts';
import {
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

employees.patch('/:id', 'employee:write', validateBody(employeeInput), async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const existing = await findEmployee(id);
  if (existing === null) {
    throw notFound('Employee', id);
  }

  await withTransaction(
    (client) => updateEmployee(client, id, request.body as typeof employeeInput._output),
    request.auth?.userId,
  );

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
