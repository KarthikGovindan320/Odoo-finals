/**
 * The audit trail, made readable.
 *
 * The rows have been written since the schema existed -- one generic trigger on
 * eight tables, with the actor threaded through every transaction -- and there
 * has never been anywhere to read them. Fifty thousand rows of who changed what
 * are worth nothing until somebody can answer "who moved this person's bank
 * details" without opening psql.
 *
 * Two shapes of the same question: a stream of everything, filtered; and the
 * history of one record, which is what the button on a record's own screen asks
 * for.
 */
import { z } from 'zod';

import { query, queryOne } from '../db/pool.ts';
import type { QueryParameter } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';
import { parseOrThrow } from '../middleware/validate.ts';
import {
  exportFormat, identifier, isoDate, paginationQuery,
} from '../../../shared/schemas/common.ts';
import { assertExportable, sendSheet } from '../export/respond.ts';
import { TENANT_TIMEZONE } from '../../../shared/tenant.ts';

/**
 * The tables the triggers cover.
 *
 * Listed rather than accepted as free text: the filter goes into a query, and a
 * closed set is one fewer thing to think about than an escaped string.
 */
const AUDITED_TABLES = [
  'employees', 'contracts', 'attendance_records', 'time_off_requests',
  'time_off_allocations', 'salary_rules', 'payruns', 'payslips',
] as const;

const listQuery = paginationQuery.safeExtend({
  table_name: z.enum(AUDITED_TABLES).optional(),
  record_id: identifier.optional(),
  actor_user_id: identifier.optional(),
  action: z.enum(['insert', 'update', 'delete']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/**
 * Nothing is masked here, and that is deliberate.
 *
 * redact_audited_row() replaces bank details, personal email, address, date of
 * birth and the password columns with the literal '[redacted]' before the row
 * reaches audit_log at all -- so the sensitive value is not in the table to
 * leak, which is a stronger guarantee than hiding it on the way out.
 *
 * A first version of this masked bank_account_number again on display, which
 * was not merely redundant: it truncated '[redacted]' to '····ted]' and turned
 * a clear statement into a confusing one. Masking twice is not twice as safe.
 */
function present(_field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export type AuditChange = { field: string; from: string | null; to: string | null };

/**
 * What moved, one line per field.
 *
 * The trigger already stores only the columns that changed on an update, so
 * this is the keys of one object rather than a comparison of two whole rows. An
 * insert has no "from" and a delete has no "to", which is exactly how they read.
 */
function changesOf(
  action: string,
  oldValues: Record<string, unknown> | null,
  newValues: Record<string, unknown> | null,
): AuditChange[] {
  const fields = new Set([...Object.keys(oldValues ?? {}), ...Object.keys(newValues ?? {})]);

  return [...fields]
    // Noise on every row, and derivable from the audit row itself.
    .filter((field) => field !== 'updated_at' && field !== 'created_at')
    .sort()
    .map((field) => ({
      field,
      from: action === 'insert' ? null : present(field, oldValues?.[field]),
      to: action === 'delete' ? null : present(field, newValues?.[field]),
    }));
}

/**
 * A human name for the record the row is about.
 *
 * One LEFT JOIN per audited table, each matched on the table name as well as
 * the id, so only the relevant one contributes. Without it every row reads
 * "attendance_records #38214", which is a row number rather than an answer.
 */
const SUBJECT_JOINS = `
  LEFT JOIN employees emp ON a.table_name = 'employees' AND emp.id = a.record_id
  LEFT JOIN contracts con ON a.table_name = 'contracts' AND con.id = a.record_id
  LEFT JOIN attendance_records att ON a.table_name = 'attendance_records' AND att.id = a.record_id
  LEFT JOIN employees att_emp ON att_emp.id = att.employee_id
  LEFT JOIN employees con_emp ON con_emp.id = con.employee_id
  LEFT JOIN time_off_requests tor ON a.table_name = 'time_off_requests' AND tor.id = a.record_id
  LEFT JOIN employees tor_emp ON tor_emp.id = tor.employee_id
  LEFT JOIN time_off_allocations toa ON a.table_name = 'time_off_allocations' AND toa.id = a.record_id
  LEFT JOIN employees toa_emp ON toa_emp.id = toa.employee_id
  LEFT JOIN salary_rules sr ON a.table_name = 'salary_rules' AND sr.id = a.record_id
  LEFT JOIN payruns pr ON a.table_name = 'payruns' AND pr.id = a.record_id
  LEFT JOIN payslips ps ON a.table_name = 'payslips' AND ps.id = a.record_id
  LEFT JOIN employees ps_emp ON ps_emp.id = ps.employee_id`;

const SUBJECT_LABEL = `COALESCE(
    emp.first_name || ' ' || emp.last_name,
    con.reference,
    att_emp.first_name || ' ' || att_emp.last_name,
    tor_emp.first_name || ' ' || tor_emp.last_name,
    toa_emp.first_name || ' ' || toa_emp.last_name,
    sr.code || ' — ' || sr.name,
    pr.name,
    ps.number,
    a.table_name || ' #' || a.record_id
  )`;

/** The employee a row is about, where there is one, so a screen can link to it. */
const SUBJECT_EMPLOYEE = `COALESCE(emp.id, att.employee_id, con.employee_id,
    tor.employee_id, toa.employee_id, ps.employee_id)`;

type AuditRow = {
  id: number;
  table_name: string;
  record_id: number;
  action: string;
  changed_at: string;
  actor_email: string | null;
  actor_name: string | null;
  actor_role: string | null;
  subject: string;
  subject_employee_id: number | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
};

const audit = createGuardedRouter();

/** The WHERE the list and the export share, so the file matches the screen. */
function buildFilter(filters: {
  table_name?: string; record_id?: number; actor_user_id?: number;
  action?: string; from?: string; to?: string;
}): { where: string; params: QueryParameter[] } {
  const conditions: string[] = ['true'];
  const params: QueryParameter[] = [];

  const restrict = (clause: string, value: QueryParameter): void => {
    params.push(value);
    conditions.push(clause.replace('$?', `$${params.length}`));
  };

  if (filters.table_name) restrict('a.table_name = $?', filters.table_name);
  if (filters.record_id !== undefined) restrict('a.record_id = $?', filters.record_id);
  if (filters.actor_user_id !== undefined) restrict('a.actor_user_id = $?', filters.actor_user_id);
  if (filters.action) restrict('a.action = $?', filters.action);
  if (filters.from) {
    params.push(TENANT_TIMEZONE, filters.from);
    conditions.push(`(a.changed_at AT TIME ZONE $${params.length - 1})::date >= $${params.length}::date`);
  }
  if (filters.to) {
    params.push(TENANT_TIMEZONE, filters.to);
    conditions.push(`(a.changed_at AT TIME ZONE $${params.length - 1})::date <= $${params.length}::date`);
  }

  return { where: conditions.join(' AND '), params };
}

audit.get('/', 'audit:read', async (request, response) => {
  const filters = parseOrThrow(listQuery, request.query);
  const { where, params } = buildFilter(filters);

  /*
   * The count is over audit_log alone. Adding the subject joins to it turns a
   * covered index scan over fifty thousand rows into thirteen joins that
   * produce a number nobody looks at.
   */
  const totalRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM audit_log a WHERE ${where}`,
    params,
  );

  const rows = await query<AuditRow>(
    `SELECT a.id, a.table_name, a.record_id, a.action, a.changed_at,
            u.email AS actor_email,
            actor_emp.first_name || ' ' || actor_emp.last_name AS actor_name,
            r.name AS actor_role,
            ${SUBJECT_LABEL} AS subject,
            ${SUBJECT_EMPLOYEE} AS subject_employee_id,
            a.old_values, a.new_values
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_user_id
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN employees actor_emp ON actor_emp.user_id = u.id
       ${SUBJECT_JOINS}
      WHERE ${where}
      ORDER BY a.changed_at DESC, a.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.page_size, (filters.page - 1) * filters.page_size],
  );

  response.json({
    rows: rows.map(({ old_values: oldValues, new_values: newValues, ...row }) => ({
      ...row,
      changes: changesOf(row.action, oldValues, newValues),
    })),
    page: filters.page,
    page_size: filters.page_size,
    total: totalRow?.total ?? 0,
    total_pages: Math.max(Math.ceil((totalRow?.total ?? 0) / filters.page_size), 1),
  });
});

audit.get('/export', 'audit:read', async (request, response) => {
  const filters = parseOrThrow(
    listQuery.omit({ page: true, page_size: true }).extend({ format: exportFormat }),
    request.query,
  );

  const { where, params } = buildFilter(filters);

  const totalRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM audit_log a WHERE ${where}`,
    params,
  );
  assertExportable(totalRow?.total ?? 0);

  const rows = await query<AuditRow>(
    `SELECT a.id, a.table_name, a.record_id, a.action, a.changed_at,
            u.email AS actor_email,
            actor_emp.first_name || ' ' || actor_emp.last_name AS actor_name,
            r.name AS actor_role,
            ${SUBJECT_LABEL} AS subject,
            ${SUBJECT_EMPLOYEE} AS subject_employee_id,
            a.old_values, a.new_values
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_user_id
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN employees actor_emp ON actor_emp.user_id = u.id
       ${SUBJECT_JOINS}
      WHERE ${where}
      ORDER BY a.changed_at DESC, a.id DESC`,
    params,
  );

  /*
   * One row per changed field, not one per audit entry.
   *
   * An entry with four changes squeezed into a single cell is not something a
   * spreadsheet can filter, sort or pivot, which is the only reason to take the
   * trail into one. Flattening repeats the entry's identity down the rows, and
   * that repetition is what makes "every change to bank_account_number this
   * quarter" a two-click question.
   */
  const flat = rows.flatMap((row) => {
    const changes = changesOf(row.action, row.old_values, row.new_values);
    const base = {
      id: row.id, changed_at: row.changed_at, action: row.action,
      table_name: row.table_name, record_id: row.record_id, subject: row.subject,
      actor: row.actor_email, actor_name: row.actor_name, actor_role: row.actor_role,
    };
    return changes.length === 0
      ? [{ ...base, field: '', from: null as string | null, to: null as string | null }]
      : changes.map((change) => ({ ...base, ...change }));
  });

  sendSheet(response, {
    name: 'Audit trail',
    rows: flat,
    columns: [
      { header: 'When', value: (row) => row.changed_at },
      { header: 'Action', value: (row) => row.action },
      { header: 'Record type', value: (row) => row.table_name },
      { header: 'Record id', type: 'number', value: (row) => row.record_id },
      { header: 'Subject', value: (row) => row.subject },
      { header: 'Field', value: (row) => row.field },
      { header: 'From', value: (row) => row.from },
      { header: 'To', value: (row) => row.to },
      { header: 'Changed by', value: (row) => row.actor },
      { header: 'Name', value: (row) => row.actor_name },
      { header: 'Role', value: (row) => row.actor_role },
    ],
  }, filters.format);
});

/** Who may be filtered on, for the actor dropdown. */
audit.get('/actors', 'audit:read', async (_request, response) => {
  const rows = await query(
    `SELECT u.id, u.email, r.name AS role_name,
            count(*)::int AS changes
       FROM audit_log a
       JOIN users u ON u.id = a.actor_user_id
       LEFT JOIN roles r ON r.id = u.role_id
      GROUP BY u.id, u.email, r.name
      ORDER BY count(*) DESC`,
  );
  response.json({ rows });
});

export const auditRouter = audit.router;
