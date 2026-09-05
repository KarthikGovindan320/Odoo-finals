/**
 * Contracts.
 *
 * The interesting behaviour is not in this file -- it is the exclusion constraint
 * in migration 006, which is what actually stops two contracts being in force at
 * once. These routes let that constraint speak: a violation comes back through
 * the error handler as a sentence naming the overlap, rather than as a 500.
 */
import { z } from 'zod';

import { notFound } from '../errors/app_error.ts';
import { withTransaction } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';
import { requireOwnEmployee, scopedEmployeeId } from '../middleware/authorize.ts';
import { parseOrThrow, validateBody } from '../middleware/validate.ts';
import { contractInput, contractPatchInput } from '../../../shared/schemas/hr.ts';
import { identifier, paginationQuery } from '../../../shared/schemas/common.ts';
import {
  findContract,
  insertContract,
  listContracts,
  updateContract,
} from '../repositories/contract_repository.ts';

const listQuery = paginationQuery.safeExtend({
  employee_id: identifier.optional(),
  state: z.enum(['draft', 'running', 'expired', 'cancelled']).optional(),
});

const contracts = createGuardedRouter();

contracts.get('/', 'contract:read', async (request, response) => {
  const filters = parseOrThrow(listQuery, request.query);
  const { rows, total } = await listContracts({
    employeeId: filters.employee_id,
    state: filters.state,
    search: filters.q,
    page: filters.page,
    pageSize: filters.page_size,
    scopedEmployeeId: scopedEmployeeId(request),
  });

  response.json({
    rows, page: filters.page, page_size: filters.page_size, total,
    total_pages: Math.max(Math.ceil(total / filters.page_size), 1),
  });
});

contracts.get('/:id', 'contract:read', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const contract = await findContract(id);
  if (contract === null) {
    throw notFound('Contract', id);
  }
  requireOwnEmployee(request, contract.employee_id);
  response.json(contract);
});

contracts.post('/', 'contract:write', validateBody(contractInput), async (request, response) => {
  const id = await withTransaction(
    (client) => insertContract(client, request.body as typeof contractInput._output),
    request.auth?.userId,
  );
  response.status(201).json(await findContract(id));
});

/** The stored contract in the shape the input schema describes. See employee_routes.ts. */
function toContractInput(existing: NonNullable<Awaited<ReturnType<typeof findContract>>>) {
  return {
    reference: existing.reference,
    employee_id: existing.employee_id,
    start_date: existing.start_date,
    end_date: existing.end_date,
    department_id: existing.department_id,
    job_position_id: existing.job_position_id,
    employment_type_id: existing.employment_type_id,
    working_schedule_id: existing.working_schedule_id,
    wage: existing.wage,
    wage_type: existing.wage_type,
    salary_structure_id: existing.salary_structure_id,
    state: existing.state,
    notes: existing.notes,
  };
}

/**
 * Partial update, merged over the stored row.
 *
 * The stakes here are the mirror of the employee case: `state` defaults to
 * 'draft' on create, and a full-body PATCH that omitted it would move a running
 * contract back to draft -- where the contract resolver, which reads only
 * 'running' and 'expired', stops seeing it and the employee's next payslip fails
 * with NO_CONTRACT.
 */
contracts.patch('/:id', 'contract:write', validateBody(contractPatchInput), async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const existing = await findContract(id);
  if (existing === null) {
    throw notFound('Contract', id);
  }

  const patch = request.body as Partial<typeof contractInput._output>;
  const merged = parseOrThrow(contractInput, { ...toContractInput(existing), ...patch });

  await withTransaction(
    (client) => updateContract(client, id, merged),
    request.auth?.userId,
  );
  response.json(await findContract(id));
});

export const contractRouter = contracts.router;
