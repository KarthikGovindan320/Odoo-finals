/** SQL for contracts. */
import { query, queryOne } from '../db/pool.ts';
import type { QueryParameter, TransactionClient } from '../db/pool.ts';
import type { ContractInput } from '../../../shared/schemas/hr.ts';

export type ContractRow = {
  id: number;
  reference: string;
  employee_id: number;
  employee_name: string;
  employee_number: string;
  start_date: string;
  end_date: string | null;
  wage: number;
  wage_type: string;
  state: string;
  department_name: string | null;
  job_title: string | null;
  schedule_name: string | null;
  structure_name: string | null;
  salary_structure_id: number | null;
  working_schedule_id: number | null;
  department_id: number | null;
  job_position_id: number | null;
  employment_type_id: number | null;
  notes: string;
  /** True when this contract covers today -- what the list view highlights. */
  is_current: boolean;
};

const SELECT_CONTRACT = `
  SELECT c.id, c.reference, c.employee_id,
         e.first_name || ' ' || e.last_name AS employee_name,
         e.employee_number,
         c.start_date::text, c.end_date::text, c.wage, c.wage_type, c.state,
         c.salary_structure_id, c.working_schedule_id, c.department_id,
         c.job_position_id, c.employment_type_id, c.notes,
         d.name  AS department_name,
         j.title AS job_title,
         w.name  AS schedule_name,
         s.name  AS structure_name,
         (c.state = 'running' AND c.validity @> CURRENT_DATE) AS is_current
    FROM contracts c
    JOIN employees e              ON e.id = c.employee_id
    LEFT JOIN departments d       ON d.id = c.department_id
    LEFT JOIN job_positions j     ON j.id = c.job_position_id
    LEFT JOIN working_schedules w ON w.id = c.working_schedule_id
    LEFT JOIN salary_structures s ON s.id = c.salary_structure_id`;

export async function listContracts(filters: {
  employeeId?: number | undefined;
  state?: string | undefined;
  search?: string | undefined;
  page: number;
  pageSize: number;
  scopedEmployeeId: number | null;
}): Promise<{ rows: ContractRow[]; total: number }> {
  const conditions: string[] = ['true'];
  const params: QueryParameter[] = [];

  const restrictTo = filters.scopedEmployeeId ?? filters.employeeId;
  if (restrictTo !== undefined && restrictTo !== null) {
    params.push(restrictTo);
    conditions.push(`c.employee_id = $${params.length}`);
  }
  if (filters.state) {
    params.push(filters.state);
    conditions.push(`c.state = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(
      `(c.reference ILIKE $${params.length} OR e.first_name ILIKE $${params.length}
        OR e.last_name ILIKE $${params.length} OR e.employee_number ILIKE $${params.length})`,
    );
  }

  const where = conditions.join(' AND ');
  const totalRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM contracts c JOIN employees e ON e.id = c.employee_id WHERE ${where}`,
    params,
  );

  const rows = await query<ContractRow>(
    `${SELECT_CONTRACT} WHERE ${where}
      ORDER BY c.start_date DESC, c.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
  );

  return { rows, total: totalRow?.total ?? 0 };
}

export async function findContract(id: number): Promise<ContractRow | null> {
  return queryOne<ContractRow>(`${SELECT_CONTRACT} WHERE c.id = $1`, [id]);
}

const WRITABLE = [
  'reference', 'employee_id', 'start_date', 'end_date', 'department_id', 'job_position_id',
  'employment_type_id', 'working_schedule_id', 'wage', 'wage_type', 'salary_structure_id',
  'state', 'notes',
] as const;

function toParams(input: ContractInput): QueryParameter[] {
  return WRITABLE.map((column) => {
    const value = (input as Record<string, unknown>)[column];
    return value === undefined || value === '' ? null : (value as QueryParameter);
  });
}

export async function insertContract(
  client: TransactionClient,
  input: ContractInput,
): Promise<number> {
  const row = await client.queryOne<{ id: number }>(
    `INSERT INTO contracts (${WRITABLE.join(', ')})
     VALUES (${WRITABLE.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING id`,
    toParams(input),
  );
  return (row as { id: number }).id;
}

export async function updateContract(
  client: TransactionClient,
  id: number,
  input: ContractInput,
): Promise<void> {
  await client.query(
    `UPDATE contracts SET ${WRITABLE.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now()
      WHERE id = $${WRITABLE.length + 1}`,
    [...toParams(input), id],
  );
}
