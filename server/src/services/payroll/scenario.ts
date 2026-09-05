/**
 * What a decision would cost, priced by the engine that will have to honour it.
 *
 * "What if we raised everyone 7%?" is normally answered in a spreadsheet, by
 * multiplying a payroll total by 1.07. That answer is wrong in every case where
 * the rules are not linear in the wage, which is most of them: a provident fund
 * contribution capped at 1,800 does not rise with a raise once it is capped, an
 * allowance conditional on seniority does not appear because someone got more
 * money, and a rule with a floor absorbs the first part of a cut entirely.
 *
 * So nothing is multiplied here. Each employee's context is edited, the whole
 * rule sequence is re-run against it, and the results are added up. The engine
 * is pure and opens no connection, so this costs a few hundred microseconds per
 * employee and writes nothing: the point of a simulation is that it can be run
 * on a validated payrun without touching it.
 *
 * The baseline is deliberately the *recomputed* payrun rather than the amounts
 * on file. If a salary rule has been edited since the payrun was produced, the
 * difference between file and engine is that edit, not the scenario, and folding
 * it into the projection would bill the user for somebody else's change. Where
 * the two disagree it is reported rather than hidden.
 */
import type { TransactionClient } from '../../db/pool.ts';
import { notFound } from '../../errors/app_error.ts';
import { roundMoney } from '../../lib/money.ts';
import { computePayslip } from './rule_engine.ts';
import type { PayslipContext, SalaryRuleDefinition } from './rule_engine.ts';
import { loadStructureRules } from './payslip_service.ts';
import { contextFor } from './explain.ts';
import type { StoredPayslip } from './explain.ts';
import { copyContext, reconcileContext } from './context_edits.ts';
import type { WageType } from './contract_wage.ts';

export type Scenario = {
  /** Applied before the flat amount, so 10% of a 50,000 wage is 5,000, not 5,500. */
  wage_change_percent: number;
  wage_change_amount: number;
  overtime_hours_delta: number;
  unpaid_leave_days_delta: number;
  paid_leave_days_delta: number;
  seniority_years_delta: number;
};

export const EMPTY_SCENARIO: Scenario = {
  wage_change_percent: 0,
  wage_change_amount: 0,
  overtime_hours_delta: 0,
  unpaid_leave_days_delta: 0,
  paid_leave_days_delta: 0,
  seniority_years_delta: 0,
};

export type SimulatedEmployee = {
  employee_id: number;
  employee_name: string;
  employee_number: string;
  department_name: string | null;
  baseline_net: number;
  projected_net: number;
  net_delta: number;
  baseline_gross: number;
  projected_gross: number;
};

export type SimulationTotals = {
  employees: number;
  gross: number;
  net: number;
};

export type PayrunSimulation = {
  payrun: { id: number; name: string; period_start: string; period_end: string; state: string };
  scenario: Scenario;
  baseline: SimulationTotals;
  projected: SimulationTotals;
  net_delta: number;
  gross_delta: number;
  /** Twelve times the net change, when the period is a month. Null otherwise. */
  annualised_net_delta: number | null;
  by_department: {
    department_name: string | null;
    employees: number;
    baseline_net: number;
    projected_net: number;
    net_delta: number;
  }[];
  /** The employees the scenario moves most, in both directions. */
  movers: SimulatedEmployee[];
  /** Employees whose pay the scenario does not change at all, and how many. */
  unmoved: number;
  /** Payslips that could not be re-run, with the reason. */
  skipped: { employee_name: string; reason: string }[];
  /** Set when an input had to be held at a bound, e.g. leave beyond the period. */
  clamped: number;
  /**
   * Payslips whose stored amount disagrees with re-running them unchanged --
   * the rules were edited after this payrun was produced. The projection is
   * against today's rules, and this says how far that is from what was paid.
   */
  baseline_drift: { payslips: number; net: number };
};

/** Applies a scenario to one employee's context, keeping the result coherent. */
export function applyScenario(
  context: PayslipContext,
  scenario: Scenario,
  wageType: WageType,
): { context: PayslipContext; clamped: boolean } {
  const next = copyContext(context);
  let clamped = false;

  next.contract.wage = Math.max(
    0,
    next.contract.wage * (1 + scenario.wage_change_percent / 100) + scenario.wage_change_amount,
  );

  next.worked.overtime_hours = Math.max(0, next.worked.overtime_hours + scenario.overtime_hours_delta);
  next.employee.seniority_years = Math.max(
    0,
    next.employee.seniority_years + scenario.seniority_years_delta,
  );

  // Leave cannot exceed the days the schedule expected, and the two kinds share
  // that budget. Left unbounded, "everyone takes five more unpaid days" turns a
  // three-day month negative and the projection becomes a number about nothing.
  const requestedUnpaid = next.worked.unpaid_leave_days + scenario.unpaid_leave_days_delta;
  const requestedPaid = next.worked.paid_leave_days + scenario.paid_leave_days_delta;
  const unpaid = Math.min(Math.max(0, requestedUnpaid), next.worked.scheduled_days);
  const paid = Math.min(Math.max(0, requestedPaid), next.worked.scheduled_days - unpaid);

  if (unpaid !== requestedUnpaid || paid !== requestedPaid) clamped = true;

  next.worked.unpaid_leave_days = unpaid;
  next.worked.paid_leave_days = paid;
  next.worked.attended_days = Math.max(0, next.worked.scheduled_days - unpaid - paid);

  return { context: reconcileContext(next, wageType), clamped };
}

type SimulationRow = StoredPayslip & {
  employee_id: number;
  employee_name: string;
  employee_number: string;
  department_name: string | null;
  stored_net: number;
  stored_gross: number;
};

const MOVERS_SHOWN = 12;

export async function simulatePayrun(
  client: TransactionClient,
  payrunId: number,
  scenario: Scenario,
): Promise<PayrunSimulation> {
  const [payrun] = await client.query<{
    id: number; name: string; period_start: string; period_end: string; state: string;
  }>(
    'SELECT id, name, period_start::text, period_end::text, state FROM payruns WHERE id = $1',
    [payrunId],
  );
  if (payrun === undefined) {
    throw notFound('Payrun', payrunId);
  }

  const rows = await client.query<SimulationRow>(
    `SELECT ps.id, ps.salary_structure_id, ps.period_start, ps.period_end,
            ps.scheduled_days::float8    AS scheduled_days,
            ps.worked_days::float8       AS worked_days,
            ps.worked_hours::float8      AS worked_hours,
            ps.paid_leave_days::float8   AS paid_leave_days,
            ps.unpaid_leave_days::float8 AS unpaid_leave_days,
            ps.overtime_hours::float8    AS overtime_hours,
            ps.proration_factor::float8  AS proration_factor,
            ps.net_amount::float8        AS stored_net,
            ps.gross_amount::float8      AS stored_gross,
            ps.employee_id,
            e.first_name || ' ' || e.last_name AS employee_name,
            e.employee_number, e.hire_date,
            d.name AS department_name,
            c.wage::float8 AS wage, c.wage_type,
            w.hours_per_week::float8 AS hours_per_week
       FROM payslips ps
       JOIN employees e              ON e.id = ps.employee_id
       LEFT JOIN departments d       ON d.id = e.department_id
       LEFT JOIN contracts c         ON c.id = ps.contract_id
       LEFT JOIN working_schedules w ON w.id = e.working_schedule_id
      WHERE ps.payrun_id = $1
      ORDER BY e.employee_number`,
    [payrunId],
  );

  // One load per structure, not per employee: a 350-person payrun on two
  // structures is two queries, and the rule set is the same object each time.
  const ruleSets = new Map<number, SalaryRuleDefinition[]>();
  for (const row of rows) {
    if (!ruleSets.has(row.salary_structure_id)) {
      ruleSets.set(row.salary_structure_id, await loadStructureRules(client, row.salary_structure_id));
    }
  }

  const employees: SimulatedEmployee[] = [];
  const skipped: PayrunSimulation['skipped'] = [];
  let clamped = 0;
  let driftPayslips = 0;
  let driftNet = 0;

  for (const row of rows) {
    const rules = ruleSets.get(row.salary_structure_id) ?? [];
    const wageType: WageType = row.wage_type ?? 'monthly';

    if (row.wage === null) {
      skipped.push({
        employee_name: row.employee_name,
        reason: 'No contract on this payslip, so there is no wage to project from.',
      });
      continue;
    }

    const context = contextFor(row);
    const { context: projectedContext, clamped: wasClamped } = applyScenario(context, scenario, wageType);
    if (wasClamped) clamped += 1;

    try {
      const baseline = computePayslip(rules, context);
      const projected = computePayslip(rules, projectedContext);

      if (Math.abs(baseline.net_amount - row.stored_net) >= 0.005) {
        driftPayslips += 1;
        driftNet += baseline.net_amount - row.stored_net;
      }

      employees.push({
        employee_id: row.employee_id,
        employee_name: row.employee_name,
        employee_number: row.employee_number,
        department_name: row.department_name,
        baseline_net: roundMoney(baseline.net_amount),
        projected_net: roundMoney(projected.net_amount),
        net_delta: roundMoney(projected.net_amount - baseline.net_amount),
        baseline_gross: roundMoney(baseline.gross_amount),
        projected_gross: roundMoney(projected.gross_amount),
      });
    } catch (error) {
      skipped.push({
        employee_name: row.employee_name,
        reason: error instanceof Error ? error.message : 'This payslip could not be re-run.',
      });
    }
  }

  const sum = (pick: (one: SimulatedEmployee) => number): number =>
    roundMoney(employees.reduce((total, one) => total + pick(one), 0));

  const baseline: SimulationTotals = {
    employees: employees.length,
    gross: sum((one) => one.baseline_gross),
    net: sum((one) => one.baseline_net),
  };
  const projected: SimulationTotals = {
    employees: employees.length,
    gross: sum((one) => one.projected_gross),
    net: sum((one) => one.projected_net),
  };

  const byDepartment = new Map<string, PayrunSimulation['by_department'][number]>();
  for (const one of employees) {
    const key = one.department_name ?? '';
    const entry = byDepartment.get(key) ?? {
      department_name: one.department_name,
      employees: 0, baseline_net: 0, projected_net: 0, net_delta: 0,
    };
    entry.employees += 1;
    entry.baseline_net = roundMoney(entry.baseline_net + one.baseline_net);
    entry.projected_net = roundMoney(entry.projected_net + one.projected_net);
    entry.net_delta = roundMoney(entry.net_delta + one.net_delta);
    byDepartment.set(key, entry);
  }

  const periodDays = Math.round(
    (Date.parse(`${payrun.period_end}T00:00:00Z`) - Date.parse(`${payrun.period_start}T00:00:00Z`))
      / 86_400_000,
  ) + 1;
  const netDelta = roundMoney(projected.net - baseline.net);

  return {
    payrun,
    scenario,
    baseline,
    projected,
    net_delta: netDelta,
    gross_delta: roundMoney(projected.gross - baseline.gross),
    // Only where twelve of this period is a year. A fortnightly or one-off run
    // multiplied by twelve is a number that looks authoritative and is not.
    annualised_net_delta: periodDays >= 28 && periodDays <= 31 ? roundMoney(netDelta * 12) : null,
    by_department: [...byDepartment.values()].sort((left, right) =>
      Math.abs(right.net_delta) - Math.abs(left.net_delta)),
    movers: [...employees]
      .filter((one) => one.net_delta !== 0)
      .sort((left, right) => Math.abs(right.net_delta) - Math.abs(left.net_delta))
      .slice(0, MOVERS_SHOWN),
    unmoved: employees.filter((one) => one.net_delta === 0).length,
    skipped,
    clamped,
    baseline_drift: { payslips: driftPayslips, net: roundMoney(driftNet) },
  };
}
