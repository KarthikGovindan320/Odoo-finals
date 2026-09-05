/**
 * SQL for employee records. No business rules here -- this layer knows how to
 * read and write rows, and nothing about what they mean.
 *
 * Every list query takes a scopedEmployeeId. When it is non-null the caller only
 * has 'own' access, and the restriction is applied in the WHERE clause rather
 * than by filtering afterwards, so an Employee cannot page past their own record.
 */
import { query, queryOne } from '../db/pool.ts';
import type { QueryParameter, TransactionClient } from '../db/pool.ts';
import type { EmployeeInput } from '../../../shared/schemas/hr.ts';

export type EmployeeListRow = {
  id: number;
  employee_number: string;
  first_name: string;
  last_name: string;
  work_email: string;
  work_phone: string | null;
  status: string;
  hire_date: string;
  department_name: string | null;
  job_title: string | null;
  employment_type_name: string | null;
  manager_name: string | null;
  schedule_name: string | null;
  current_wage: number | null;
};

export type EmployeeListFilters = {
  search?: string | undefined;
  departmentId?: number | undefined;
  employmentTypeId?: number | undefined;
  status?: string | undefined;
  page: number;
  pageSize: number;
  scopedEmployeeId: number | null;
};

const SORTABLE_COLUMNS: Record<string, string> = {
  name: 'e.first_name',
  employee_number: 'e.employee_number',
  hire_date: 'e.hire_date',
  department: 'd.name',
};

export async function listEmployees(
  filters: EmployeeListFilters,
  sort: string | undefined,
): Promise<{ rows: EmployeeListRow[]; total: number }> {
  const conditions: string[] = ['e.is_active'];
  const params: QueryParameter[] = [];

  if (filters.scopedEmployeeId !== null) {
    params.push(filters.scopedEmployeeId);
    conditions.push(`e.id = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(
      `(e.first_name ILIKE $${params.length} OR e.last_name ILIKE $${params.length}
        OR e.employee_number ILIKE $${params.length} OR e.work_email ILIKE $${params.length})`,
    );
  }
  if (filters.departmentId !== undefined) {
    params.push(filters.departmentId);
    conditions.push(`e.department_id = $${params.length}`);
  }
  if (filters.employmentTypeId !== undefined) {
    params.push(filters.employmentTypeId);
    conditions.push(`e.employment_type_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`e.status = $${params.length}`);
  }

  const where = conditions.join(' AND ');

  // Sort column is looked up in a whitelist, never interpolated from user input.
  const [sortKey, sortDirection] = (sort ?? 'employee_number:asc').split(':');
  const orderColumn = SORTABLE_COLUMNS[sortKey ?? ''] ?? 'e.employee_number';
  const orderDirection = sortDirection === 'desc' ? 'DESC' : 'ASC';

  const totalRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
      WHERE ${where}`,
    params,
  );

  const offset = (filters.page - 1) * filters.pageSize;
  const rows = await query<EmployeeListRow>(
    `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.work_email, e.work_phone,
            e.status, e.hire_date::text AS hire_date,
            d.name  AS department_name,
            j.title AS job_title,
            t.name  AS employment_type_name,
            m.first_name || ' ' || m.last_name AS manager_name,
            w.name  AS schedule_name,
            cc.wage AS current_wage
       FROM employees e
       LEFT JOIN departments d      ON d.id = e.department_id
       LEFT JOIN job_positions j    ON j.id = e.job_position_id
       LEFT JOIN employment_types t ON t.id = e.employment_type_id
       LEFT JOIN employees m        ON m.id = e.manager_id
       LEFT JOIN working_schedules w ON w.id = e.working_schedule_id
       LEFT JOIN v_employee_current_contract cc ON cc.employee_id = e.id
      WHERE ${where}
      ORDER BY ${orderColumn} ${orderDirection}, e.id ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, offset],
  );

  return { rows, total: totalRow?.total ?? 0 };
}

export type EmployeeDetail = EmployeeListRow & {
  personal_email: string | null;
  department_id: number | null;
  job_position_id: number | null;
  employment_type_id: number | null;
  manager_id: number | null;
  working_schedule_id: number | null;
  termination_date: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  address: string | null;
  /** Smart-button counts, fetched with the record so the form is one round trip. */
  contract_count: number;
  attendance_count: number;
  time_off_count: number;
  allocation_count: number;
  payslip_count: number;
};

export async function findEmployee(id: number): Promise<EmployeeDetail | null> {
  return queryOne<EmployeeDetail>(
    `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.work_email, e.personal_email,
            e.work_phone, e.status, e.hire_date::text AS hire_date,
            e.termination_date::text AS termination_date,
            e.department_id, e.job_position_id, e.employment_type_id, e.manager_id,
            e.working_schedule_id, e.bank_name, e.bank_account_number, e.bank_ifsc, e.address,
            d.name  AS department_name,
            j.title AS job_title,
            t.name  AS employment_type_name,
            m.first_name || ' ' || m.last_name AS manager_name,
            w.name  AS schedule_name,
            cc.wage AS current_wage,
            (SELECT count(*)::int FROM contracts            WHERE employee_id = e.id) AS contract_count,
            (SELECT count(*)::int FROM attendance_records   WHERE employee_id = e.id) AS attendance_count,
            (SELECT count(*)::int FROM time_off_requests    WHERE employee_id = e.id) AS time_off_count,
            (SELECT count(*)::int FROM time_off_allocations WHERE employee_id = e.id) AS allocation_count,
            (SELECT count(*)::int FROM payslips             WHERE employee_id = e.id) AS payslip_count
       FROM employees e
       LEFT JOIN departments d      ON d.id = e.department_id
       LEFT JOIN job_positions j    ON j.id = e.job_position_id
       LEFT JOIN employment_types t ON t.id = e.employment_type_id
       LEFT JOIN employees m        ON m.id = e.manager_id
       LEFT JOIN working_schedules w ON w.id = e.working_schedule_id
       LEFT JOIN v_employee_current_contract cc ON cc.employee_id = e.id
      WHERE e.id = $1 AND e.is_active`,
    [id],
  );
}

const WRITABLE_COLUMNS = [
  'employee_number', 'first_name', 'last_name', 'work_email', 'personal_email', 'work_phone',
  'department_id', 'job_position_id', 'employment_type_id', 'manager_id', 'working_schedule_id',
  'hire_date', 'status', 'termination_date', 'bank_name', 'bank_account_number', 'bank_ifsc',
  'address',
] as const;

function toParams(input: EmployeeInput): QueryParameter[] {
  return WRITABLE_COLUMNS.map((column) => {
    const value = (input as Record<string, unknown>)[column];
    return value === undefined || value === '' ? null : (value as QueryParameter);
  });
}

export async function insertEmployee(
  client: TransactionClient,
  input: EmployeeInput,
): Promise<number> {
  const placeholders = WRITABLE_COLUMNS.map((_, index) => `$${index + 1}`).join(', ');
  const row = await client.queryOne<{ id: number }>(
    `INSERT INTO employees (${WRITABLE_COLUMNS.join(', ')})
     VALUES (${placeholders}) RETURNING id`,
    toParams(input),
  );
  return (row as { id: number }).id;
}

export async function updateEmployee(
  client: TransactionClient,
  id: number,
  input: EmployeeInput,
): Promise<void> {
  const assignments = WRITABLE_COLUMNS.map((column, index) => `${column} = $${index + 1}`).join(', ');
  await client.query(
    `UPDATE employees SET ${assignments}, updated_at = now() WHERE id = $${WRITABLE_COLUMNS.length + 1}`,
    [...toParams(input), id],
  );
}

/** Archives rather than deletes: payroll history must never point at a missing row. */
export async function archiveEmployee(client: TransactionClient, id: number): Promise<void> {
  await client.query('UPDATE employees SET is_active = false, updated_at = now() WHERE id = $1', [id]);
}
