/**
 * The payrun lifecycle: who is eligible, creating the batch, and the guarded
 * transitions that finalise it.
 *
 * draft -> computed -> validated -> paid, and no way back. Validation is the gate:
 * it refuses while any blocker warning stands, and once it succeeds the database
 * triggers take over and the batch becomes history.
 */
import { AppError, workflowViolation } from '../../errors/app_error.ts';
import type { TransactionClient } from '../../db/pool.ts';
import { insertedId } from '../../db/pool.ts';
import { countBlockers, refreshContextWarnings } from './warnings.ts';

export type EligibleEmployee = {
  employee_id: number;
  employee_number: string;
  employee_name: string;
  department_name: string | null;
  employment_type_name: string | null;
  contract_reference: string | null;
  wage: number | null;
  is_eligible: boolean;
  ineligible_reason: string | null;
};

/**
 * Step 2 of the wizard. A pure read: it creates nothing, because the spec is
 * explicit that Continue must not bring a payrun into existence.
 *
 * Ineligible employees are returned too, with the reason, rather than silently
 * omitted. "Where is Priya?" is a question the screen should answer by itself.
 */
export async function findEligibleEmployees(
  client: TransactionClient,
  scope: {
    periodStart: string;
    periodEnd: string;
    departmentId?: number | null;
    employmentTypeId?: number | null;
  },
): Promise<EligibleEmployee[]> {
  const rows = await client.query<EligibleEmployee & { finalized_payslip: string | null }>(
    `SELECT e.id AS employee_id,
            e.employee_number,
            e.first_name || ' ' || e.last_name AS employee_name,
            d.name AS department_name,
            t.name AS employment_type_name,
            c.reference AS contract_reference,
            c.wage,
            ps.number  AS finalized_payslip,
            true       AS is_eligible,
            NULL::text AS ineligible_reason
       FROM employees e
       LEFT JOIN departments d      ON d.id = e.department_id
       LEFT JOIN employment_types t ON t.id = e.employment_type_id
       LEFT JOIN LATERAL (
            SELECT reference, wage
              FROM contracts
             WHERE employee_id = e.id
               AND state IN ('running', 'expired')
               AND validity && daterange($1::date, $2::date, '[]')
             ORDER BY start_date DESC
             LIMIT 1
       ) c ON true
       LEFT JOIN LATERAL (
            SELECT number
              FROM payslips
             WHERE employee_id = e.id
               AND period_start = $1::date AND period_end = $2::date
               AND state IN ('validated', 'paid')
             LIMIT 1
       ) ps ON true
      WHERE e.is_active
        AND e.status <> 'terminated'
        AND ($3::int IS NULL OR e.department_id = $3::int)
        AND ($4::int IS NULL OR e.employment_type_id = $4::int)
      ORDER BY e.employee_number`,
    [scope.periodStart, scope.periodEnd, scope.departmentId ?? null, scope.employmentTypeId ?? null],
  );

  return rows.map((row) => {
    if (row.contract_reference === null) {
      return {
        ...row,
        is_eligible: false,
        ineligible_reason: 'No contract covers this period.',
      };
    }
    if (row.finalized_payslip !== null) {
      return {
        ...row,
        is_eligible: false,
        ineligible_reason: `Already paid on payslip ${row.finalized_payslip}.`,
      };
    }
    return { ...row, is_eligible: true, ineligible_reason: null };
  });
}

/**
 * Loads a payrun and holds its row for the rest of the transaction.
 *
 * Every transition here reads the state, decides, then writes -- and at READ
 * COMMITTED without a lock, two callers can both read 'computed' and both
 * proceed. Two validates would each move the payslips they saw; two computes
 * would interleave a DELETE of payslip_lines with the other's INSERTs. Taking
 * the payrun row is enough to serialise all of them, because every transition
 * goes through this function.
 */
async function lockPayrun(
  client: TransactionClient,
  payrunId: number,
): Promise<{ name: string; state: string }> {
  const payrun = await client.queryOne<{ name: string; state: string }>(
    'SELECT name, state FROM payruns WHERE id = $1 FOR UPDATE',
    [payrunId],
  );
  if (payrun === null) {
    throw new AppError('not_found', `Payrun ${payrunId} does not exist.`);
  }
  return payrun;
}

export { lockPayrun };

export async function createPayrun(
  client: TransactionClient,
  input: {
    name: string;
    salaryStructureId: number;
    periodStart: string;
    periodEnd: string;
    departmentId?: number | null;
    employmentTypeId?: number | null;
    employeeIds: number[];
    createdByUserId: number | null;
  },
): Promise<number> {
  const eligible = await findEligibleEmployees(client, {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    departmentId: input.departmentId,
    employmentTypeId: input.employmentTypeId,
  });

  const eligibleIds = new Set(
    eligible.filter((row) => row.is_eligible).map((row) => row.employee_id),
  );

  // Re-check the selection server-side. The wizard already filtered, but the
  // list the browser saw could be minutes old, and a payslip created for someone
  // already paid is the expensive kind of mistake.
  const rejected = input.employeeIds.filter((id) => !eligibleIds.has(id));
  if (rejected.length > 0) {
    const reasons = eligible
      .filter((row) => rejected.includes(row.employee_id))
      .map((row) => `${row.employee_name}: ${row.ineligible_reason ?? 'not eligible'}`);

    throw new AppError(
      'workflow_violation',
      `${rejected.length} selected employee(s) cannot be included in this payrun.`,
      { rejected: reasons },
    );
  }

  const payrun = await client.queryOne<{ id: number }>(
    `INSERT INTO payruns
       (name, salary_structure_id, period_start, period_end, state,
        scope_department_id, scope_employment_type_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)
     RETURNING id`,
    [
      input.name, input.salaryStructureId, input.periodStart, input.periodEnd,
      input.departmentId ?? null, input.employmentTypeId ?? null, input.createdByUserId,
    ],
  );
  const payrunId = insertedId(payrun, 'a payrun');

  const label = input.periodStart.slice(0, 7).replace('-', '/');
  const numbers = input.employeeIds.map(
    (_, index) =>
      `PS/${label}/${String(payrunId).padStart(3, '0')}${String(index + 1).padStart(3, '0')}`,
  );

  await client.query(
    `INSERT INTO payslips
       (number, payrun_id, employee_id, salary_structure_id, period_start, period_end)
     SELECT n, $2, e, $3, $4::date, $5::date
       FROM unnest($1::text[], $6::bigint[]) AS t(n, e)`,
    [
      numbers, payrunId, input.salaryStructureId,
      input.periodStart, input.periodEnd, input.employeeIds,
    ] as never,
  );

  return payrunId;
}

export async function validatePayrun(
  client: TransactionClient,
  payrunId: number,
): Promise<{ validated: number }> {
  const payrun = await lockPayrun(client, payrunId);

  if (payrun.state === 'draft') {
    throw workflowViolation('Compute this payrun before validating it — there is nothing to check yet.');
  }
  if (payrun.state === 'cancelled') {
    throw workflowViolation(`Payrun ${payrun.name} was cancelled and cannot be validated.`);
  }
  if (payrun.state === 'validated' || payrun.state === 'paid') {
    throw workflowViolation(`Payrun ${payrun.name} is already ${payrun.state}.`);
  }

  // Blockers are re-derived against live data rather than read back from the
  // rows compute happened to leave behind. Between computing and validating,
  // someone can add the missing contract that was blocking -- or, more
  // dangerously, finalize a payslip elsewhere that now makes this one a
  // duplicate. Gating on stored warnings answers the question as it stood at
  // compute time, which is not the question validation is asking.
  await refreshContextWarnings(client, payrunId);

  const blockers = await countBlockers(client, payrunId);
  if (blockers > 0) {
    throw workflowViolation(
      `This payrun has ${blockers} blocking issue(s) that must be resolved before it can be validated. ` +
        'Open the Warnings panel to see what needs fixing.',
    );
  }

  const computed = await client.query<{ id: number }>(
    `UPDATE payslips SET state = 'validated' WHERE payrun_id = $1 AND state = 'computed' RETURNING id`,
    [payrunId],
  );

  if (computed.length === 0) {
    throw workflowViolation('No payslip in this payrun computed successfully, so there is nothing to validate.');
  }

  await client.query(
    `UPDATE payruns SET state = 'validated', validated_at = now() WHERE id = $1`,
    [payrunId],
  );

  return { validated: computed.length };
}

export async function markPayrunPaid(
  client: TransactionClient,
  payrunId: number,
): Promise<{ paid: number }> {
  const payrun = await lockPayrun(client, payrunId);

  if (payrun.state !== 'validated') {
    throw workflowViolation(
      payrun.state === 'paid'
        ? `Payrun ${payrun.name} is already marked paid.`
        : `Only a validated payrun can be marked paid. ${payrun.name} is ${payrun.state}.`,
    );
  }

  const paid = await client.query<{ id: number }>(
    `UPDATE payslips SET state = 'paid' WHERE payrun_id = $1 AND state = 'validated' RETURNING id`,
    [payrunId],
  );

  if (paid.length === 0) {
    throw workflowViolation(
      `Payrun ${payrun.name} has no validated payslips to mark paid.`,
    );
  }

  await client.query(`UPDATE payruns SET state = 'paid', paid_at = now() WHERE id = $1`, [payrunId]);
  return { paid: paid.length };
}
