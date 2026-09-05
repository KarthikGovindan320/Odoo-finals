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

export type WarningSeverity = 'blocker' | 'warning' | 'info';

export type WarningCode =
  | 'NO_CONTRACT'
  | 'MULTIPLE_CONTRACTS'
  | 'NO_STRUCTURE'
  | 'NEGATIVE_NET'
  | 'DUPLICATE_PAYSLIP'
  | 'MISSING_BANK'
  | 'NO_SCHEDULE'
  | 'OPEN_ATTENDANCE'
  | 'PENDING_LEAVE'
  | 'PARTIAL_CONTRACT'
  | 'PRORATED';

export const WARNING_SEVERITY: Record<WarningCode, WarningSeverity> = {
  NO_CONTRACT: 'blocker',
  MULTIPLE_CONTRACTS: 'blocker',
  NO_STRUCTURE: 'blocker',
  NEGATIVE_NET: 'blocker',
  DUPLICATE_PAYSLIP: 'blocker',
  MISSING_BANK: 'warning',
  NO_SCHEDULE: 'warning',
  OPEN_ATTENDANCE: 'warning',
  PENDING_LEAVE: 'warning',
  PARTIAL_CONTRACT: 'warning',
  PRORATED: 'info',
};

export type DraftWarning = {
  code: WarningCode;
  message: string;
  payslipId: number | null;
};

export function warning(code: WarningCode, message: string, payslipId: number | null): DraftWarning {
  return { code, message, payslipId };
}

export async function replaceWarnings(
  client: TransactionClient,
  payrunId: number,
  warnings: readonly DraftWarning[],
): Promise<void> {
  await client.query('DELETE FROM payslip_warnings WHERE payrun_id = $1', [payrunId]);

  for (const item of warnings) {
    await client.query(
      `INSERT INTO payslip_warnings (payrun_id, payslip_id, severity, code, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [payrunId, item.payslipId, WARNING_SEVERITY[item.code], item.code, item.message],
    );
  }
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
        AND check_out IS NULL
        AND (check_in AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date`,
    [input.employeeId, input.periodStart, input.periodEnd],
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
