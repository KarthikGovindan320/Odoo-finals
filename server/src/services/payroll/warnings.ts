/**
 * The payroll warning taxonomy.
 *
 * Warnings are stored rows, not log lines. That means the payrun screen can group
 * them, validation can refuse on blockers, the dashboard's alerts panel is a
 * query over one table, and a warning that was true in June is still readable in
 * September.
 *
 * The severity split is deliberate. A blocker is a condition under which the
 * computed number would be wrong or unrepresentable. Everything else warns: a
 * late arrival makes a number debatable, not wrong, and blocking on debatable
 * data makes the system unusable in exactly the messy month it is most needed.
 */
import type { TransactionClient } from '../../db/pool.ts';
import { TENANT_TIMEZONE } from '../../../../shared/tenant.ts';

export type WarningSeverity = 'blocker' | 'warning' | 'info';

export type WarningCode =
  | 'NO_CONTRACT'
  | 'MULTIPLE_CONTRACTS'
  | 'NO_STRUCTURE'
  | 'RULE_ERROR'
  | 'NEGATIVE_NET'
  | 'DUPLICATE_PAYSLIP'
  | 'MISSING_BANK'
  | 'NO_SCHEDULE'
  | 'OPEN_ATTENDANCE'
  | 'PENDING_LEAVE'
  | 'CONTRACT_CHANGED'
  | 'PARTIAL_CONTRACT'
  | 'UNEXPLAINED_ABSENCE'
  | 'PRORATED';

/**
 * Severity has one rule: if the condition stops a payslip being computed, it is a
 * blocker. Anything else is a warning.
 *
 * NO_SCHEDULE was previously a 'warning' while computeOnePayslip treated it as a
 * hard stop -- so a payrun containing an employee with no working days validated
 * cleanly, that payslip stayed in draft, the mailer skipped it, and the person
 * was simply not paid, with a yellow badge as the only trace. Severity and
 * control flow have to agree, and this is the direction they have to agree in.
 */
export const WARNING_SEVERITY: Record<WarningCode, WarningSeverity> = {
  NO_CONTRACT: 'blocker',
  MULTIPLE_CONTRACTS: 'blocker',
  NO_STRUCTURE: 'blocker',
  RULE_ERROR: 'blocker',
  NEGATIVE_NET: 'blocker',
  DUPLICATE_PAYSLIP: 'blocker',
  NO_SCHEDULE: 'blocker',
  MISSING_BANK: 'warning',
  OPEN_ATTENDANCE: 'warning',
  PENDING_LEAVE: 'warning',
  CONTRACT_CHANGED: 'warning',
  PARTIAL_CONTRACT: 'warning',
  UNEXPLAINED_ABSENCE: 'warning',
  PRORATED: 'info',
};

/**
 * The warnings collectContextWarnings produces. Listed once so refreshing them
 * replaces exactly the set it regenerates and leaves computation warnings alone.
 */
export const CONTEXT_WARNING_CODES = [
  'MISSING_BANK',
  'OPEN_ATTENDANCE',
  'PENDING_LEAVE',
  'DUPLICATE_PAYSLIP',
] as const satisfies readonly WarningCode[];

export type DraftWarning = {
  code: WarningCode;
  message: string;
  payslipId: number | null;
};

export function warning(code: WarningCode, message: string, payslipId: number | null): DraftWarning {
  return { code, message, payslipId };
}

/** Inserts a batch of warnings in one statement. */
async function insertWarnings(
  client: TransactionClient,
  payrunId: number,
  warnings: readonly DraftWarning[],
): Promise<void> {
  if (warnings.length === 0) {
    return;
  }

  await client.query(
    `INSERT INTO payslip_warnings (payrun_id, payslip_id, severity, code, message)
     SELECT $1, *
       FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[])`,
    [
      payrunId,
      warnings.map((item) => item.payslipId),
      warnings.map((item) => WARNING_SEVERITY[item.code]),
      warnings.map((item) => item.code),
      warnings.map((item) => item.message),
    ] as never,
  );
}

export async function replaceWarnings(
  client: TransactionClient,
  payrunId: number,
  warnings: readonly DraftWarning[],
): Promise<void> {
  await client.query('DELETE FROM payslip_warnings WHERE payrun_id = $1', [payrunId]);
  await insertWarnings(client, payrunId, warnings);
}

/**
 * Re-derives the data-quality warnings for a payrun against current data,
 * replacing the stored ones of those kinds.
 *
 * Only the context warnings are refreshed -- the ones that depend on rows
 * elsewhere in the system rather than on the computation. Warnings produced by
 * the computation itself (NO_CONTRACT, RULE_ERROR, NEGATIVE_NET and so on)
 * describe the figures actually stored on the payslip and are still true; the
 * only way to change them is to compute again.
 */
export async function refreshContextWarnings(
  client: TransactionClient,
  payrunId: number,
): Promise<void> {
  const payrun = await client.queryOne<{ period_start: string; period_end: string }>(
    'SELECT period_start::text, period_end::text FROM payruns WHERE id = $1',
    [payrunId],
  );
  if (payrun === null) {
    return;
  }

  const payslips = await client.query<{ id: number; employee_id: number; employee_name: string }>(
    `SELECT p.id, p.employee_id,
            e.first_name || ' ' || e.last_name AS employee_name
       FROM payslips p
       JOIN employees e ON e.id = p.employee_id
      WHERE p.payrun_id = $1`,
    [payrunId],
  );

  const refreshed: DraftWarning[] = [];
  for (const payslip of payslips) {
    refreshed.push(
      ...(await collectContextWarnings(client, {
        payslipId: payslip.id,
        employeeId: payslip.employee_id,
        employeeName: payslip.employee_name,
        periodStart: payrun.period_start,
        periodEnd: payrun.period_end,
      })),
    );
  }

  const contextCodes = CONTEXT_WARNING_CODES.map((code) => `'${code}'`).join(', ');
  await client.query(
    `DELETE FROM payslip_warnings
      WHERE payrun_id = $1 AND code IN (${contextCodes})`,
    [payrunId],
  );

  await insertWarnings(client, payrunId, refreshed);
}

export async function countBlockers(
  client: TransactionClient,
  payrunId: number,
): Promise<number> {
  const row = await client.queryOne<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM payslip_warnings
      WHERE payrun_id = $1 AND severity = 'blocker'`,
    [payrunId],
  );
  return row?.total ?? 0;
}

/**
 * Checks that do not depend on the computation itself: data quality on the
 * employee, and conditions elsewhere in the system that make this payslip
 * suspect. Run for every payslip regardless of whether computation succeeded.
 */
export async function collectContextWarnings(
  client: TransactionClient,
  input: {
    payslipId: number;
    employeeId: number;
    employeeName: string;
    periodStart: string;
    periodEnd: string;
  },
): Promise<DraftWarning[]> {
  const found: DraftWarning[] = [];

  const employee = await client.queryOne<{
    bank_account_number: string | null;
    bank_ifsc: string | null;
    working_schedule_id: number | null;
  }>(
    'SELECT bank_account_number, bank_ifsc, working_schedule_id FROM employees WHERE id = $1',
    [input.employeeId],
  );

  if (employee !== null && (employee.bank_account_number === null || employee.bank_ifsc === null)) {
    found.push(
      warning(
        'MISSING_BANK',
        `${input.employeeName} has no bank account on file, so this payslip cannot be paid by transfer. ` +
          'Add the account number and IFSC on the employee record.',
        input.payslipId,
      ),
    );
  }

  const openAttendance = await client.queryOne<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM attendance_records
      WHERE employee_id = $1
        AND voided_at IS NULL
        AND check_out IS NULL
        AND (check_in AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`,
    [input.employeeId, input.periodStart, input.periodEnd, TENANT_TIMEZONE],
  );

  if ((openAttendance?.total ?? 0) > 0) {
    found.push(
      warning(
        'OPEN_ATTENDANCE',
        `${input.employeeName} has ${openAttendance?.total} attendance record(s) in this period with no ` +
          'check-out, so worked hours may be understated. Correct them before paying.',
        input.payslipId,
      ),
    );
  }

  const pendingLeave = await client.queryOne<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM time_off_requests
      WHERE employee_id = $1
        AND state = 'to_approve'
        AND leave_period && daterange($2::date, $3::date, '[]')`,
    [input.employeeId, input.periodStart, input.periodEnd],
  );

  if ((pendingLeave?.total ?? 0) > 0) {
    found.push(
      warning(
        'PENDING_LEAVE',
        `${input.employeeName} has ${pendingLeave?.total} time off request(s) still awaiting approval in ` +
          'this period. Approving them after payment will not change this payslip.',
        input.payslipId,
      ),
    );
  }

  const duplicate = await client.queryOne<{ number: string }>(
    `SELECT number
       FROM payslips
      WHERE employee_id = $1
        AND period_start = $2::date
        AND period_end = $3::date
        AND state IN ('validated', 'paid')
        AND id <> $4
      LIMIT 1`,
    [input.employeeId, input.periodStart, input.periodEnd, input.payslipId],
  );

  if (duplicate !== null) {
    found.push(
      warning(
        'DUPLICATE_PAYSLIP',
        `${input.employeeName} already has a finalized payslip (${duplicate.number}) for this exact period. ` +
          'Paying this one as well would pay them twice.',
        input.payslipId,
      ),
    );
  }

  return found;
}
