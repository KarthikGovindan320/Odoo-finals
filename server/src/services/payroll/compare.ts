/**
 * Why this payslip differs from the last one.
 *
 * This is the question payroll is actually asked. Not "what is my salary made
 * of" -- people know that -- but "why is it less than last month?", and the
 * honest answer is usually a number of days nobody told them about. Answering it
 * by hand means reading two payslips side by side and doing arithmetic, which is
 * how disputes start.
 *
 * The attribution here is exact rather than plausible, and it is exact because
 * the rules are runnable. For each line, with f as the rule as it stands today:
 *
 *     total delta   =  f(now) - previous amount
 *     from inputs   =  f(now) - f(then)      -- days, hours, wage, earlier lines
 *     from the rule =  f(then) - previous amount
 *
 * Those two sum to the total by construction, so a line whose formula was edited
 * between the periods is separated from one whose inputs moved, instead of both
 * being reported as "salary changed".
 *
 * Within the input half, each variable's share is measured by re-running the
 * rule with that one variable put back to its previous value. For anything but a
 * sum this does not add up perfectly -- two inputs that multiply have a joint
 * effect belonging to neither -- and the remainder is reported as interaction
 * rather than quietly folded into the largest driver. A number that does not add
 * up, labelled, is worth more than one that adds up because it was made to.
 */
import type { TransactionClient } from '../../db/pool.ts';
import { notFound } from '../../errors/app_error.ts';
import { roundMoney } from '../../lib/money.ts';
import { normaliseWage } from './contract_wage.ts';
import { loadStructureRules } from './payslip_service.ts';
import { computePayslip } from './rule_engine.ts';
import type { PayslipContext, SalaryRuleDefinition } from './rule_engine.ts';
import { evaluateNumericExpression } from './expression/evaluator.ts';
import { parse } from './expression/parser.ts';
import type { Node } from './expression/parser.ts';
import { bindingsFor, contextFor, VARIABLE_LABELS } from './explain.ts';
import type { StoredLine, StoredPayslip } from './explain.ts';
import type { ContextVariableName } from './context_variables.ts';

export type DeltaDriver = {
  name: string;
  label: string;
  previous: number;
  current: number;
  /** This driver's share of the line's change, in currency. */
  amount: number;
};

export type ComparedLine = {
  rule_code: string;
  rule_name: string;
  category_code: string;
  category_sign: number;
  previous_amount: number | null;
  current_amount: number | null;
  delta: number;
  /** The part explained by what went into the rule. */
  from_inputs: number;
  /** The part explained by the rule itself having been edited since. */
  from_rule_change: number;
  drivers: DeltaDriver[];
  /** What no single driver accounts for, because two of them moved together. */
  interaction: number;
  /** Set when the line cannot be decomposed, saying why. */
  note: string | null;
};

export type PayslipComparison = {
  current: PeriodSummary;
  previous: PeriodSummary | null;
  net_delta: number;
  gross_delta: number;
  lines: ComparedLine[];
  /** The context values that moved, whatever line they ended up affecting. */
  changed_inputs: DeltaDriver[];
  /** Net change today's rules attribute to the inputs having moved. */
  net_from_inputs: number;
  /**
   * How much of the difference exists only because the rules were edited after
   * these payslips were produced. Zero when an edit hit both periods equally,
   * which is the common case and the right answer: it changed both, so it
   * changed nothing between them.
   */
  net_from_rule_change: number;
  /** The part of net_from_inputs no single input accounts for on its own. */
  net_interaction: number;
  /**
   * Whether the per-input figures can be read on their own.
   *
   * 'entangled' means the inputs moved so far together that reverting one in
   * isolation describes a period that never existed -- a first month with two
   * scheduled days against a full one. The figures are still arithmetically
   * true; they are just not answers to the question anyone is asking, so the
   * screen shows what moved without pricing each part.
   */
  attribution: 'separable' | 'entangled';
  unavailable: string | null;
};

type PeriodSummary = {
  id: number;
  number: string;
  period_start: string;
  period_end: string;
  gross_amount: number;
  net_amount: number;
  state: string;
};

const PAYSLIP_COLUMNS = `ps.id, ps.salary_structure_id, ps.period_start, ps.period_end,
        ps.scheduled_days::float8    AS scheduled_days,
        ps.worked_days::float8       AS worked_days,
        ps.worked_hours::float8      AS worked_hours,
        ps.paid_leave_days::float8   AS paid_leave_days,
        ps.unpaid_leave_days::float8 AS unpaid_leave_days,
        ps.overtime_hours::float8    AS overtime_hours,
        ps.proration_factor::float8  AS proration_factor,
        e.hire_date, c.wage::float8 AS wage, c.wage_type,
        w.hours_per_week::float8 AS hours_per_week`;

const PAYSLIP_JOINS = `FROM payslips ps
       JOIN employees e              ON e.id = ps.employee_id
       LEFT JOIN contracts c         ON c.id = ps.contract_id
       LEFT JOIN working_schedules w ON w.id = e.working_schedule_id`;

/** Every variable an expression reads, so a driver search looks no further. */
function variablesIn(node: Node, into: Set<string> = new Set()): Set<string> {
  switch (node.type) {
    case 'variable': into.add(node.name); break;
    case 'unary': variablesIn(node.operand, into); break;
    case 'binary': variablesIn(node.left, into); variablesIn(node.right, into); break;
    case 'conditional':
      variablesIn(node.condition, into);
      variablesIn(node.whenTrue, into);
      variablesIn(node.whenFalse, into);
      break;
    case 'call': for (const argument of node.args) variablesIn(argument, into); break;
    default: break;
  }
  return into;
}

function labelFor(name: string): string {
  return VARIABLE_LABELS[name as ContextVariableName]
    ?? (name.startsWith('rules.')
      ? `The ${name.slice('rules.'.length)} line`
      : `The ${name.slice('categories.'.length)} total`);
}

/**
 * Seeds the results of earlier lines into a binding map, exactly as the engine
 * does mid-computation. Without this a rule reading rules.BASIC has nothing to
 * read and the line cannot be re-run at all.
 */
function withLineResults(bindings: Map<string, number>, lines: StoredLine[]): Map<string, number> {
  const categoryTotals = new Map<string, number>();
  for (const line of lines) {
    bindings.set(`rules.${line.rule_code}`, line.amount);
    categoryTotals.set(
      line.category_code,
      (categoryTotals.get(line.category_code) ?? 0) + line.amount,
    );
  }
  for (const [code, total] of categoryTotals) {
    bindings.set(`categories.${code}`, total);
  }
  return bindings;
}

/** Runs a rule as it stands today against a given set of inputs. */
function runRule(
  rule: SalaryRuleDefinition,
  bindings: ReadonlyMap<string, number>,
): number | null {
  try {
    switch (rule.computation_type) {
      case 'fixed':
        return roundMoney(rule.amount_fixed ?? 0);
      case 'percentage': {
        const base = bindings.get(`rules.${rule.percentage_base_code}`)
          ?? bindings.get(`categories.${rule.percentage_base_code}`);
        return base === undefined ? null : roundMoney((base * (rule.percentage ?? 0)) / 100);
      }
      case 'formula':
        return roundMoney(
          evaluateNumericExpression(rule.formula_expression ?? '', bindings, `Rule ${rule.code}`),
        );
    }
  } catch {
    // A rule that no longer runs against these inputs -- a divisor that is now
    // zero, a base that is no longer computed. The line still gets a delta; it
    // just gets no decomposition.
    return null;
  }
}

/** The names a rule reads, whatever form it takes. */
function inputsOf(rule: SalaryRuleDefinition): string[] {
  switch (rule.computation_type) {
    case 'fixed':
      return [];
    case 'percentage':
      return [`rules.${rule.percentage_base_code}`, `categories.${rule.percentage_base_code}`];
    case 'formula':
      try {
        const names = variablesIn(parse(rule.formula_expression ?? ''));
        // A condition can flip a line in or out of existence, so what it reads
        // is part of why the amount changed.
        if (rule.condition_type === 'formula' && rule.condition_expression !== null) {
          for (const name of variablesIn(parse(rule.condition_expression))) names.add(name);
        }
        return [...names];
      } catch {
        return [];
      }
  }
}

function compareLine(
  ruleCode: string,
  rule: SalaryRuleDefinition | undefined,
  currentLine: StoredLine | undefined,
  previousLine: StoredLine | undefined,
  currentBindings: Map<string, number>,
  previousBindings: Map<string, number>,
): ComparedLine {
  const currentAmount = currentLine?.amount ?? null;
  const previousAmount = previousLine?.amount ?? null;
  const signed = (value: number | null): number => value ?? 0;
  const delta = roundMoney(signed(currentAmount) - signed(previousAmount));

  const shell: ComparedLine = {
    rule_code: ruleCode,
    rule_name: currentLine?.rule_name ?? previousLine?.rule_name ?? ruleCode,
    category_code: currentLine?.category_code ?? previousLine?.category_code ?? '',
    category_sign: currentLine?.category_sign ?? previousLine?.category_sign ?? 1,
    previous_amount: previousAmount,
    current_amount: currentAmount,
    delta,
    from_inputs: delta,
    from_rule_change: 0,
    drivers: [],
    interaction: 0,
    note: null,
  };

  if (delta === 0) return shell;

  if (currentAmount === null) {
    return { ...shell, note: 'This line is not on the current payslip. Its rule no longer applies.' };
  }
  if (previousAmount === null) {
    return { ...shell, note: 'This line is new. It was not on the previous payslip.' };
  }
  if (rule === undefined) {
    return { ...shell, note: 'This rule is no longer in the salary structure, so it cannot be re-run.' };
  }

  // What the rule as it stands today would have produced last period. The gap
  // between that and what was actually paid is the rule having been edited.
  const thenUnderTodaysRule = runRule(rule, previousBindings);
  if (thenUnderTodaysRule === null) {
    return { ...shell, note: 'This rule cannot be re-run against the previous period, so the change cannot be attributed.' };
  }

  const fromInputs = roundMoney(signed(currentAmount) - thenUnderTodaysRule);
  const fromRuleChange = roundMoney(thenUnderTodaysRule - previousAmount);

  // One at a time: put a single input back and see what the line becomes.
  const drivers: DeltaDriver[] = [];
  for (const name of inputsOf(rule)) {
    const currentValue = currentBindings.get(name);
    const previousValue = previousBindings.get(name);
    if (currentValue === undefined || previousValue === undefined) continue;
    if (currentValue === previousValue) continue;

    const reverted = new Map(currentBindings).set(name, previousValue);
    const withoutIt = runRule(rule, reverted);
    if (withoutIt === null) continue;

    const share = roundMoney(signed(currentAmount) - withoutIt);
    if (share === 0) continue;

    drivers.push({
      name,
      label: labelFor(name),
      previous: previousValue,
      current: currentValue,
      amount: share,
    });
  }

  drivers.sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount));
  const attributed = drivers.reduce((sum, driver) => sum + driver.amount, 0);

  return {
    ...shell,
    from_inputs: fromInputs,
    from_rule_change: fromRuleChange,
    drivers,
    interaction: roundMoney(fromInputs - attributed),
    note: fromRuleChange !== 0
      ? 'The rule behind this line has been edited since the previous payslip was produced.'
      : null,
  };
}

/**
 * Inputs that are not inputs: each is fixed by others and cannot move alone.
 *
 * Paid days are scheduled days less unpaid leave; the monthly and hourly wages
 * are the contract wage normalised against the schedule. Treating them as
 * independent produced the worst number this screen has shown -- reverting the
 * scheduled day count on its own while paid days stayed put described a month
 * with 21 paid days out of 2 scheduled, and attributed 671,000 rupees to a
 * schedule change worth nothing of the sort.
 */
export const DERIVED_INPUTS = new Set<string>([
  'worked.paid_days',
  'contract.monthly_wage',
  'contract.hourly_wage',
]);

/**
 * One input put back to its previous value, with everything defined in terms of
 * it put back too.
 *
 * Returns null for a name that is derived or unknown, so a caller cannot ask for
 * an incoherent context by accident.
 */
export function revertInput(
  context: PayslipContext,
  name: string,
  value: number,
  wageType: 'monthly' | 'hourly',
): PayslipContext | null {
  if (DERIVED_INPUTS.has(name)) return null;

  const next: PayslipContext = {
    employee: { ...context.employee },
    contract: { ...context.contract },
    period: { ...context.period },
    worked: { ...context.worked },
  };

  switch (name) {
    case 'employee.seniority_years': next.employee.seniority_years = value; break;
    case 'contract.wage': next.contract.wage = value; break;
    case 'contract.schedule_hours_per_week': next.contract.schedule_hours_per_week = value; break;
    case 'period.calendar_days': next.period.calendar_days = value; break;
    case 'worked.scheduled_days': next.worked.scheduled_days = value; break;
    case 'worked.attended_days': next.worked.attended_days = value; break;
    case 'worked.paid_leave_days': next.worked.paid_leave_days = value; break;
    case 'worked.unpaid_leave_days': next.worked.unpaid_leave_days = value; break;
    case 'worked.worked_hours': next.worked.worked_hours = value; break;
    case 'worked.overtime_hours': next.worked.overtime_hours = value; break;
    case 'worked.proration_factor': next.worked.proration_factor = value; break;
    default: return null;
  }

  // Re-derive. Cheap enough to do unconditionally, and doing it unconditionally
  // means a new derived value cannot be forgotten for one branch of the switch.
  next.worked.paid_days = next.worked.scheduled_days - next.worked.unpaid_leave_days;
  const wage = normaliseWage(next.contract.wage, wageType, next.contract.schedule_hours_per_week);
  next.contract.monthly_wage = wage.monthly_wage;
  next.contract.hourly_wage = wage.hourly_wage;

  return next;
}

/**
 * What each changed input did to take-home pay, measured on the whole payslip.
 *
 * Summing a variable's effect across the lines that read it directly is the
 * obvious approach and it is wrong. Two unpaid days do not merely shrink basic
 * pay: they shrink the allowances that are a percentage of it, shrink gross,
 * and bring a loss-of-pay line into existence that was not there before. Adding
 * up the direct hits reported that as zero effect from unpaid leave, which is
 * the single most misleading number this screen could show.
 *
 * So the measurement is made where the answer lives. Put one input back to last
 * period's value, re-run the entire rule sequence, and take the difference in
 * net. That captures the cascade because the cascade is what the engine does.
 *
 * The decomposition reported alongside it:
 *
 *   from_inputs      what today's rules make of this period's inputs against
 *                    what they would have made of last period's
 *   from_rule_change how much of the difference exists only because the rules
 *                    were edited after these payslips were produced
 *   interaction      what no single input accounts for, because two moved at
 *                    once. Reported, never absorbed into the largest driver.
 *
 * The rule term counts the edit's effect on *both* payslips, not just the
 * earlier one. That matters and it is not a detail: a flat rise in professional
 * tax makes each payslip reproduce differently, but it makes both of them
 * differ by the same amount, so it explains nothing about the gap between them
 * and the term correctly comes out at zero. Counting only its effect on the
 * previous period reported 300 rupees of rule change on a difference it had no
 * part in, and left the decomposition 300 short of the number it claimed to
 * explain. Whether a payslip still reproduces is a separate question, and the
 * explanation screen is where it is asked.
 */
function attributeNet(
  rules: SalaryRuleDefinition[],
  current: StoredPayslip & PeriodSummary,
  previous: StoredPayslip & PeriodSummary,
  currentBindings: ReadonlyMap<string, number>,
  previousBindings: ReadonlyMap<string, number>,
): Pick<PayslipComparison,
  'changed_inputs' | 'net_from_inputs' | 'net_from_rule_change' | 'net_interaction' | 'attribution'
> {
  const currentContext = contextFor(current);
  const previousContext = contextFor(previous);

  const netOf = (context: PayslipContext): number | null => {
    try {
      return computePayslip(rules, context).net_amount;
    } catch {
      // The structure can no longer produce a payslip for these inputs. The
      // line-level comparison above still stands; only the roll-up is lost.
      return null;
    }
  };

  const netNow = netOf(currentContext);
  const netThen = netOf(previousContext);
  if (netNow === null || netThen === null) {
    return {
      changed_inputs: [], net_from_inputs: 0, net_from_rule_change: 0,
      net_interaction: 0, attribution: 'separable',
    };
  }

  const changed: DeltaDriver[] = [];
  for (const name of Object.keys(VARIABLE_LABELS)) {
    const currentValue = currentBindings.get(name);
    const previousValue = previousBindings.get(name);
    if (currentValue === undefined || previousValue === undefined) continue;
    if (currentValue === previousValue) continue;

    const reverted = revertInput(
      currentContext, name, previousValue, current.wage_type ?? 'monthly',
    );
    if (reverted === null) continue;
    const counterfactual = netOf(reverted);
    if (counterfactual === null) continue;

    changed.push({
      name,
      label: labelFor(name),
      previous: previousValue,
      current: currentValue,
      amount: roundMoney(netNow - counterfactual),
    });
  }
  changed.sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount));

  const fromInputs = roundMoney(netNow - netThen);
  const attributed = changed.reduce((sum, driver) => sum + driver.amount, 0);

  const interaction = roundMoney(fromInputs - attributed);

  return {
    changed_inputs: changed,
    net_from_inputs: fromInputs,
    net_from_rule_change: roundMoney(
      (netThen - previous.net_amount) + (current.net_amount - netNow),
    ),
    net_interaction: interaction,
    // A quarter, not a tuned number: below it the joint effect is a rounding
    // detail beside the individual ones, above it the individual ones are
    // mostly cancelling each other out and mean nothing on their own. Measured
    // across the seeded history, ordinary months sit under 5% and the only
    // case above the line is a partial first month against a full one.
    attribution: Math.abs(interaction) > 0.25 * Math.abs(fromInputs || 1)
      ? 'entangled'
      : 'separable',
  };
}

export async function comparePayslip(
  client: TransactionClient,
  payslipId: number,
): Promise<PayslipComparison> {
  const [current] = await client.query<StoredPayslip & PeriodSummary & { employee_id: number }>(
    `SELECT ${PAYSLIP_COLUMNS}, ps.number, ps.state, ps.employee_id,
            ps.gross_amount::float8 AS gross_amount, ps.net_amount::float8 AS net_amount
       ${PAYSLIP_JOINS}
      WHERE ps.id = $1`,
    [payslipId],
  );
  if (current === undefined) {
    throw notFound('Payslip', payslipId);
  }

  const summarise = (row: PeriodSummary): PeriodSummary => ({
    id: row.id, number: row.number, period_start: row.period_start, period_end: row.period_end,
    gross_amount: row.gross_amount, net_amount: row.net_amount, state: row.state,
  });

  // The period before this one for the same person. Ordered by period rather
  // than by id, because payruns are not always created in period order -- a
  // correction run for March can be created after April's.
  const [previous] = await client.query<StoredPayslip & PeriodSummary>(
    `SELECT ${PAYSLIP_COLUMNS}, ps.number, ps.state,
            ps.gross_amount::float8 AS gross_amount, ps.net_amount::float8 AS net_amount
       ${PAYSLIP_JOINS}
      WHERE ps.employee_id = $1
        AND ps.period_start < $2
        AND ps.state <> 'draft'
      ORDER BY ps.period_start DESC
      LIMIT 1`,
    [current.employee_id, current.period_start],
  );

  if (previous === undefined) {
    return {
      current: summarise(current),
      previous: null,
      net_delta: 0,
      gross_delta: 0,
      lines: [],
      changed_inputs: [],
      net_from_inputs: 0,
      net_from_rule_change: 0,
      net_interaction: 0,
      attribution: 'separable',
      unavailable: 'This is the first payslip on file for this employee, so there is nothing to compare it with.',
    };
  }

  const linesOf = async (id: number): Promise<StoredLine[]> => client.query<StoredLine>(
    `SELECT rule_code, rule_name, category_code, category_sign, sequence, computation_type,
            amount::float8 AS amount
       FROM payslip_lines WHERE payslip_id = $1 ORDER BY sequence ASC`,
    [id],
  );

  const [currentLines, previousLines] = await Promise.all([linesOf(current.id), linesOf(previous.id)]);
  const rules = await loadStructureRules(client, current.salary_structure_id);
  const byCode = new Map(rules.map((rule) => [rule.code, rule]));

  const currentBindings = withLineResults(bindingsFor(current), currentLines);
  const previousBindings = withLineResults(bindingsFor(previous), previousLines);

  const currentByCode = new Map(currentLines.map((line) => [line.rule_code, line]));
  const previousByCode = new Map(previousLines.map((line) => [line.rule_code, line]));

  // Current order first, then anything that has since disappeared, so the list
  // reads like this month's payslip with the losses appended rather than an
  // arbitrary union.
  const codes = [
    ...currentLines.map((line) => line.rule_code),
    ...previousLines.map((line) => line.rule_code).filter((code) => !currentByCode.has(code)),
  ];

  const lines = codes.map((code) => compareLine(
    code,
    byCode.get(code),
    currentByCode.get(code),
    previousByCode.get(code),
    currentBindings,
    previousBindings,
  ));

  return {
    current: summarise(current),
    previous: summarise(previous),
    net_delta: roundMoney(current.net_amount - previous.net_amount),
    gross_delta: roundMoney(current.gross_amount - previous.gross_amount),
    lines,
    ...attributeNet(rules, current, previous, currentBindings, previousBindings),
    unavailable: null,
  };
}
