/**
 * Computing a payrun: resolve, gather, execute, persist, warn.
 *
 * One payslip at a time, all inside the caller's transaction, so a payrun either
 * computes wholly or not at all. Per-payslip failures that are the user's problem
 * -- no contract, a broken formula -- are captured as blocker warnings rather than
 * thrown, because the point of Compute is to show the payroll officer everything
 * that is wrong at once, not to stop at the first bad row.
 *
 * Anything that stops a payslip computing is a blocker, never a warning: a
 * warning would let the payrun validate around it and the employee would simply
 * not be paid, with a yellow badge as the only trace. See warnings.ts.
 *
 * Lookups that repeat across employees -- schedules, rule sets -- are read once
 * per run and held in a cache that lives for exactly this transaction.
 */
import { AppError } from '../../errors/app_error.ts';
import type { TransactionClient } from '../../db/pool.ts';
import { computePayslip } from './rule_engine.ts';
import { lockPayrun } from './payrun_service.ts';
import type { SalaryRuleDefinition } from './rule_engine.ts';
import { resolveContractForPeriod } from './contract_resolver.ts';
import { buildWorkedSummary, createPayrollCache, toPayslipContext } from './context_builder.ts';
import type { PayrollCache } from './context_builder.ts';
import {
  collectContextWarnings,
  replaceWarnings,
  warning,
  WARNING_SEVERITY,
  type DraftWarning,
} from './warnings.ts';

export type PayrunRow = {
  id: number;
  name: string;
  salary_structure_id: number;
  period_start: string;
  period_end: string;
  state: string;
};

type PayslipRow = {
  id: number;
  employee_id: number;
  employee_name: string;
  hire_date: string;
  working_schedule_id: number | null;
};

export async function loadStructureRules(
  client: TransactionClient,
  salaryStructureId: number,
): Promise<SalaryRuleDefinition[]> {
  return client.query<SalaryRuleDefinition>(
    `SELECT r.id      AS salary_rule_id,
            r.code,
            r.name,
            c.code    AS category_code,
            c.sign    AS category_sign,
            sr.sequence,
            r.computation_type,
            r.amount_fixed,
            r.percentage,
            r.percentage_base_code,
            r.formula_expression,
            r.condition_type,
            r.condition_expression,
            r.appears_on_payslip
       FROM salary_structure_rules sr
       JOIN salary_rules r           ON r.id = sr.salary_rule_id
       JOIN salary_rule_categories c ON c.id = r.category_id
      WHERE sr.salary_structure_id = $1
        AND r.is_active
      ORDER BY sr.sequence ASC`,
    [salaryStructureId],
  );
}

export type ComputeSummary = {
  payslipsComputed: number;
  payslipsFailed: number;
  blockers: number;
  warnings: number;
};

export async function computePayrun(
  client: TransactionClient,
  payrun: PayrunRow,
): Promise<ComputeSummary> {
  // Hold the payrun row for the rest of the transaction, so two concurrent
  // computes cannot interleave one's DELETE of payslip_lines with the other's
  // INSERTs. The state check below is only meaningful once the row is held.
  const locked = await lockPayrun(client, payrun.id);

  if (locked.state === 'validated' || locked.state === 'paid') {
    throw new AppError(
      'workflow_violation',
      `Payrun ${payrun.name} is ${locked.state} and is historical. Recomputing it would rewrite ` +
        'payslips that have already been finalized.',
    );
  }

  if (locked.state === 'cancelled') {
    throw new AppError(
      'workflow_violation',
      `Payrun ${payrun.name} was cancelled. Recomputing it would bring it back into the ` +
        'active workflow; create a new payrun instead.',
    );
  }

  const cache = createPayrollCache();
  // Structures repeat across employees too, and the contract's structure wins
  // over the payrun's -- so without this the "intern on the intern structure"
  // case re-read the same rule set once per intern.
  const ruleSets = new Map<number, SalaryRuleDefinition[]>();
  const rulesFor = async (structureId: number): Promise<SalaryRuleDefinition[]> => {
    const cached = ruleSets.get(structureId);
    if (cached !== undefined) {
      return cached;
    }
    const loaded = await loadStructureRules(client, structureId);
    ruleSets.set(structureId, loaded);
    return loaded;
  };

  const rules = await rulesFor(payrun.salary_structure_id);

  const payslips = await client.query<PayslipRow>(
    `SELECT p.id, p.employee_id,
            e.first_name || ' ' || e.last_name AS employee_name,
            e.hire_date::text                  AS hire_date,
            e.working_schedule_id
       FROM payslips p
       JOIN employees e ON e.id = p.employee_id
      WHERE p.payrun_id = $1
      ORDER BY e.employee_number`,
    [payrun.id],
  );

  const allWarnings: DraftWarning[] = [];
  let computed = 0;
  let failed = 0;

  for (const payslip of payslips) {
    const outcome = await computeOnePayslip(client, payrun, payslip, rules, cache, rulesFor);
    allWarnings.push(...outcome.warnings);

    if (outcome.succeeded) {
      computed += 1;
    } else {
      failed += 1;
    }
  }

  await replaceWarnings(client, payrun.id, allWarnings);

  await client.query(
    `UPDATE payruns SET state = 'computed', computed_at = now() WHERE id = $1`,
    [payrun.id],
  );

  return {
    payslipsComputed: computed,
    payslipsFailed: failed,
    blockers: allWarnings.filter((item) => WARNING_SEVERITY[item.code] === 'blocker').length,
    warnings: allWarnings.length,
  };
}

async function computeOnePayslip(
  client: TransactionClient,
  payrun: PayrunRow,
  payslip: PayslipRow,
  rules: SalaryRuleDefinition[],
  cache: PayrollCache,
  rulesFor: (structureId: number) => Promise<SalaryRuleDefinition[]>,
): Promise<{ succeeded: boolean; warnings: DraftWarning[] }> {
  const warnings: DraftWarning[] = await collectContextWarnings(client, {
    payslipId: payslip.id,
    employeeId: payslip.employee_id,
    employeeName: payslip.employee_name,
    periodStart: payrun.period_start,
    periodEnd: payrun.period_end,
  });

  const resolution = await resolveContractForPeriod(
    client,
    payslip.employee_id,
    payrun.period_start,
    payrun.period_end,
  );

  if (resolution.outcome === 'none') {
    warnings.push(
      warning(
        'NO_CONTRACT',
        `${payslip.employee_name} has no contract covering ${payrun.period_start} to ${payrun.period_end}, ` +
          'so there is no wage to compute from. Add a contract for this period or remove them from the run.',
        payslip.id,
      ),
    );
    await clearComputation(client, payslip.id);
    return { succeeded: false, warnings };
  }

  if (resolution.outcome === 'ambiguous') {
    warnings.push(
      warning(
        'MULTIPLE_CONTRACTS',
        `${payslip.employee_name} has ${resolution.contracts.length} contracts in force at the same time ` +
          'in this period. Payroll cannot choose between them; end one before computing.',
        payslip.id,
      ),
    );
    await clearComputation(client, payslip.id);
    return { succeeded: false, warnings };
  }

  const { contract, coversWholePeriod, supersededContracts } = resolution;

  // A contract change inside the period is normal -- a promotion, a renewal. We
  // price on the contract in force at period end and say so, rather than silently
  // picking one of two plausible wages.
  if (supersededContracts.length > 0) {
    const superseded = supersededContracts
      .map((candidate) => candidate.reference)
      .join(', ');

    // Say the consequence, not just the fact. This payslip prices only the days
    // the surviving contract covers, so the days under the earlier one are not
    // on it -- and a message that stops at "was not used" reads like a note when
    // it is actually money missing.
    warnings.push(
      warning(
        'CONTRACT_CHANGED',
        `${payslip.employee_name} changed contract during this period. This payslip pays only the ` +
          `days covered by ${contract.reference} (in force on ${payrun.period_end}). The earlier ` +
          `days under ${superseded} are NOT included and must be paid on a separate payrun for ` +
          'that part of the period.',
        payslip.id,
      ),
    );
  }

  if (contract.salary_structure_id === null) {
    warnings.push(
      warning(
        'NO_STRUCTURE',
        `Contract ${contract.reference} for ${payslip.employee_name} has no salary structure, ` +
          'so no rules apply. Set one on the contract.',
        payslip.id,
      ),
    );
    await clearComputation(client, payslip.id);
    return { succeeded: false, warnings };
  }

  const worked = await buildWorkedSummary(client, {
    employeeId: payslip.employee_id,
    contract,
    fallbackScheduleId: payslip.working_schedule_id,
    periodStart: payrun.period_start,
    periodEnd: payrun.period_end,
  }, cache);

  if (worked.scheduled_days === 0) {
    warnings.push(
      warning(
        'NO_SCHEDULE',
        `${payslip.employee_name} has no working days in this period -- either no working schedule is ` +
          'assigned, or the contract covers none of it. Assign a schedule on the contract or the employee.',
        payslip.id,
      ),
    );
    await clearComputation(client, payslip.id);
    return { succeeded: false, warnings };
  }

  if (!coversWholePeriod) {
    warnings.push(
      warning(
        'PARTIAL_CONTRACT',
        `Contract ${contract.reference} covers only part of this period ` +
          `(${contract.start_date} to ${contract.end_date ?? 'open-ended'}). ` +
          `Pay has been prorated to ${Math.round(worked.proration_factor * 100)}% accordingly.`,
        payslip.id,
      ),
    );
  }

  // Pay is not driven by attendance: paid_days is scheduled days minus unpaid
  // leave, so a day nobody turned up for and nobody filed leave for is still
  // paid. That is a defensible policy, but silently paying it while the payslip
  // prints "0 / 22 worked days" leaves a payroll officer unable to tell policy
  // from bug. The gap is named here so the decision is a visible one.
  const unexplainedAbsences =
    worked.scheduled_days - worked.attended_days - worked.paid_leave_days - worked.unpaid_leave_days;

  if (unexplainedAbsences > 0) {
    warnings.push(
      warning(
        'UNEXPLAINED_ABSENCE',
        `${payslip.employee_name} has ${unexplainedAbsences} scheduled day(s) with no attendance ` +
          'and no approved leave. They are being paid for those days — record attendance or a ' +
          'leave request if that is wrong.',
        payslip.id,
      ),
    );
  }

  if (worked.unpaid_leave_days > 0) {
    warnings.push(
      warning(
        'PRORATED',
        `${payslip.employee_name} took ${worked.unpaid_leave_days} day(s) of unpaid leave, ` +
          'which reduces basic pay and adds a loss-of-pay deduction.',
        payslip.id,
      ),
    );
  }

  const context = toPayslipContext(
    payslip.employee_id,
    payslip.hire_date,
    contract,
    worked,
    payrun.period_start,
    payrun.period_end,
  );

  // The structure on the contract wins over the payrun's default, because the
  // contract is what actually prices this employee -- an intern in a regular
  // payrun is still paid on the intern structure.
  const applicableRules =
    contract.salary_structure_id === payrun.salary_structure_id
      ? rules
      : await rulesFor(contract.salary_structure_id);

  let result;
  try {
    result = computePayslip(applicableRules, context);
  } catch (error) {
    // A broken formula is a configuration problem for the payroll officer to fix,
    // not a server fault. Anything else is a real failure and propagates.
    if (!(error instanceof AppError) || error.code !== 'rule_configuration_invalid') {
      throw error;
    }
    warnings.push(
      warning('RULE_ERROR', `${payslip.employee_name}: ${error.message}`, payslip.id),
    );
    await clearComputation(client, payslip.id);
    return { succeeded: false, warnings };
  }

  if (result.net_amount < 0) {
    warnings.push(
      warning(
        'NEGATIVE_NET',
        `${payslip.employee_name}'s deductions exceed their gross pay, giving a net of ` +
          `${result.net_amount.toFixed(2)}. Review the deduction rules before paying.`,
        payslip.id,
      ),
    );
  }

  await clearComputation(client, payslip.id);

  // One statement rather than one per line. A 12-rule structure over 500
  // employees is 6,000 round trips the other way, each firing the payslip_lines
  // immutability trigger, inside a single long transaction.
  if (result.lines.length > 0) {
    await client.query(
      `INSERT INTO payslip_lines
         (payslip_id, salary_rule_id, rule_code, rule_name, category_code, category_sign,
          sequence, computation_type, source_expression, quantity, rate, amount)
       SELECT $1, *
         FROM unnest(
           $2::smallint[], $3::text[], $4::text[], $5::text[], $6::smallint[],
           $7::integer[], $8::text[], $9::text[],
           $10::numeric[], $11::numeric[], $12::numeric[]
         )`,
      [
        payslip.id,
        result.lines.map((line) => line.salary_rule_id),
        result.lines.map((line) => line.rule_code),
        result.lines.map((line) => line.rule_name),
        result.lines.map((line) => line.category_code),
        result.lines.map((line) => line.category_sign),
        result.lines.map((line) => line.sequence),
        result.lines.map((line) => line.computation_type),
        result.lines.map((line) => line.source_expression),
        result.lines.map((line) => line.quantity),
        result.lines.map((line) => line.rate),
        result.lines.map((line) => line.amount),
      ] as never,
    );
  }

  await client.query(
    `UPDATE payslips
        SET contract_id = $2, salary_structure_id = $3,
            scheduled_days = $4, worked_days = $5, worked_hours = $6,
            paid_leave_days = $7, unpaid_leave_days = $8, overtime_hours = $9,
            proration_factor = $10, gross_amount = $11, net_amount = $12,
            state = 'computed', computed_at = now()
      WHERE id = $1`,
    [
      payslip.id, contract.contract_id, contract.salary_structure_id,
      worked.scheduled_days, worked.attended_days + worked.paid_leave_days, worked.worked_hours,
      worked.paid_leave_days, worked.unpaid_leave_days, worked.overtime_hours,
      worked.proration_factor, result.gross_amount, result.net_amount,
    ],
  );

  return { succeeded: true, warnings };
}

/** Resets a payslip to draft so a recompute never leaves half a previous result. */
async function clearComputation(client: TransactionClient, payslipId: number): Promise<void> {
  await client.query('DELETE FROM payslip_lines WHERE payslip_id = $1', [payslipId]);
  await client.query(
    `UPDATE payslips
        SET state = 'draft', gross_amount = 0, net_amount = 0, computed_at = NULL
      WHERE id = $1`,
    [payslipId],
  );
}
