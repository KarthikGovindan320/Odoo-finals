/**
 * Turns a computed payslip line back into the arithmetic that produced it.
 *
 * The question this answers is the one payroll actually gets asked -- "why is my
 * salary this number?" -- and the usual answer is a paragraph somebody wrote by
 * hand next to the code. That paragraph is a second implementation of the rule.
 * It is not tested, it is not run, and the day the rule changes it becomes a
 * confident lie.
 *
 * So nothing here describes what a rule does. It re-runs the rule through the
 * same evaluator the payrun used, recording what every node of the expression
 * produced (see EvaluationRecord), and renders that record. If the explanation
 * is wrong, the payslip is wrong, because they are the same computation.
 *
 * Two things follow from that, and both are the point:
 *
 *   - The context is rebuilt from the payslip's own stored columns, not from
 *     today's attendance. A payslip is a historical document; explaining it with
 *     data that has moved since would explain a payslip nobody was paid.
 *
 *   - Every line is recomputed and compared against the amount on file. When
 *     they differ, the explanation says so instead of quietly showing the new
 *     number under the old total. That turns this screen into an integrity
 *     check: it can tell you a validated payslip no longer reproduces.
 */
import type { TransactionClient } from '../../db/pool.ts';
import { AppError, notFound } from '../../errors/app_error.ts';
import { roundMoney } from '../../lib/money.ts';
import { normaliseWage } from './contract_wage.ts';
import { loadStructureRules } from './payslip_service.ts';
import { bindPayslipContext } from './rule_engine.ts';
import type { PayslipContext, SalaryRuleDefinition } from './rule_engine.ts';
import { evaluateWithTrace } from './expression/evaluator.ts';
import type { EvaluationRecord, ExpressionValue } from './expression/evaluator.ts';
import type { Node } from './expression/parser.ts';
import { CONTEXT_VARIABLE_NAMES } from './context_variables.ts';
import type { ContextVariableName } from './context_variables.ts';

/**
 * What each context variable means, in the words a person would use.
 *
 * Typed against ContextVariableName rather than as a loose record, so adding a
 * variable to the language without describing it here fails the build. A missing
 * description would otherwise surface as a raw dotted name on a payslip.
 */
export const VARIABLE_LABELS: Record<ContextVariableName, string> = {
  'employee.seniority_years': 'Completed years of service',
  'contract.wage': 'Wage as written on the contract',
  'contract.hourly_wage': 'Wage per hour',
  'contract.monthly_wage': 'Wage per month',
  'contract.schedule_hours_per_week': 'Scheduled hours per week',
  'period.calendar_days': 'Calendar days in this period',
  'worked.scheduled_days': 'Days the schedule expected',
  'worked.attended_days': 'Days attended',
  'worked.paid_days': 'Days paid (scheduled minus unpaid leave)',
  'worked.paid_leave_days': 'Paid leave days',
  'worked.unpaid_leave_days': 'Unpaid leave days',
  'worked.worked_hours': 'Hours worked',
  'worked.overtime_hours': 'Overtime hours',
  'worked.proration_factor': 'Proration for a part-period contract',
};

const OPERATOR_LABELS: Record<string, string> = {
  '+': 'plus', '-': 'minus', '*': 'times', '/': 'divided by', '%': 'remainder of',
  '<': 'is less than', '<=': 'is at most', '>': 'is more than', '>=': 'is at least',
  '==': 'equals', '!=': 'differs from', and: 'and', or: 'or',
};

export type ExplainStep = {
  /** The sub-expression exactly as the rule writes it. */
  expression: string;
  /** What this step does, in words. */
  label: string;
  /** What it produced. Null when this branch was never evaluated. */
  value: number | boolean | null;
  kind: 'literal' | 'variable' | 'operation' | 'function' | 'choice' | 'unused';
  children: ExplainStep[];
};

export type ExplainedLine = {
  rule_code: string;
  rule_name: string;
  category_code: string;
  category_sign: number;
  sequence: number;
  computation_type: string;
  /** The amount on file. */
  amount: number;
  /** What re-running the rule produces now. Null when it cannot be re-run. */
  recomputed: number | null;
  /** False when the two disagree -- the loud case. */
  reproduces: boolean;
  /** One sentence naming the shape of the calculation. */
  headline: string;
  /** The evaluation tree, for a formula. Null for fixed and percentage rules. */
  steps: ExplainStep | null;
};

export type PayslipExplanation = {
  payslip_id: number;
  /** The variable values the rules were evaluated against. */
  context: { name: string; label: string; value: number }[];
  lines: ExplainedLine[];
  /** True when every line reproduces. */
  reproduces: boolean;
  /** Set when the payslip cannot be explained at all, with the reason. */
  unavailable: string | null;
};

export { render as renderExpression };

/** Renders an AST back to source text, parenthesising only where precedence needs it. */
const PRECEDENCE: Record<string, number> = {
  or: 1, and: 2,
  '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5,
};

function render(node: Node, parentPrecedence = 0): string {
  switch (node.type) {
    case 'number':
      return String(node.value);
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'variable':
      return node.name;
    case 'unary':
      return node.operator === '-' ? `-${render(node.operand, 6)}` : `not ${render(node.operand, 6)}`;
    case 'binary': {
      const precedence = PRECEDENCE[node.operator] ?? 0;
      const text = `${render(node.left, precedence)} ${node.operator} ${render(node.right, precedence + 1)}`;
      return precedence < parentPrecedence ? `(${text})` : text;
    }
    case 'conditional':
      return `${render(node.condition, 1)} ? ${render(node.whenTrue, 0)} : ${render(node.whenFalse, 0)}`;
    case 'call':
      return `${node.name}(${node.args.map((argument) => render(argument, 0)).join(', ')})`;
  }
}

function labelFor(node: Node): string {
  switch (node.type) {
    case 'number':
      return 'A fixed number in the rule';
    case 'boolean':
      return 'A fixed true or false';
    case 'variable':
      return VARIABLE_LABELS[node.name as ContextVariableName]
        ?? (node.name.startsWith('rules.')
          ? `The ${node.name.slice('rules.'.length)} line, computed earlier`
          : `The ${node.name.slice('categories.'.length)} total, computed earlier`);
    case 'unary':
      return node.operator === '-' ? 'Negated' : 'Not';
    case 'binary':
      return OPERATOR_LABELS[node.operator] ?? node.operator;
    case 'conditional':
      return 'Whichever branch the condition selects';
    case 'call':
      return node.name === 'if' ? 'Whichever branch the condition selects' : `${node.name}()`;
  }
}

function kindFor(node: Node): ExplainStep['kind'] {
  switch (node.type) {
    case 'number':
    case 'boolean':
      return 'literal';
    case 'variable':
      return 'variable';
    case 'unary':
    case 'binary':
      return 'operation';
    case 'conditional':
      return 'choice';
    case 'call':
      return node.name === 'if' ? 'choice' : 'function';
  }
}

function childrenOf(node: Node): Node[] {
  switch (node.type) {
    case 'number':
    case 'boolean':
    case 'variable':
      return [];
    case 'unary':
      return [node.operand];
    case 'binary':
      return [node.left, node.right];
    case 'conditional':
      return [node.condition, node.whenTrue, node.whenFalse];
    case 'call':
      return node.args;
  }
}

function toStep(node: Node, record: EvaluationRecord): ExplainStep {
  const recorded: ExpressionValue | undefined = record.get(node);
  const evaluated = recorded !== undefined;

  return {
    expression: render(node),
    // A node the evaluator never reached is a branch that did not apply. Saying
    // that is more useful than printing the value it would have had, which is a
    // number that was never part of anyone's pay.
    label: evaluated ? labelFor(node) : 'Not used — this branch was not taken',
    value: evaluated ? recorded : null,
    kind: evaluated ? kindFor(node) : 'unused',
    children: childrenOf(node).map((child) => toStep(child, record)),
  };
}

/** Evaluates an expression and renders the whole tree with each node's value. */
export function explainExpression(
  source: string,
  bindings: ReadonlyMap<string, number>,
  label: string,
): { step: ExplainStep; value: number } {
  const { value, ast, record } = evaluateWithTrace(source, bindings, label);
  if (typeof value !== 'number') {
    throw new AppError(
      'rule_configuration_invalid',
      `${label} produced a true/false value where an amount was expected.`,
    );
  }
  return { step: toStep(ast, record), value };
}

export type StoredPayslip = {
  id: number;
  salary_structure_id: number;
  period_start: string;
  period_end: string;
  scheduled_days: number;
  worked_days: number;
  worked_hours: number;
  paid_leave_days: number;
  unpaid_leave_days: number;
  overtime_hours: number;
  proration_factor: number;
  hire_date: string;
  wage: number | null;
  wage_type: 'monthly' | 'hourly' | null;
  hours_per_week: number | null;
};

export type StoredLine = {
  rule_code: string;
  rule_name: string;
  category_code: string;
  category_sign: number;
  sequence: number;
  computation_type: string;
  amount: number;
};

/**
 * Rebuilds the context the rules saw, from the payslip's own columns.
 *
 * Two of the context's values are not columns because they are derivable from
 * ones that are: the payrun stores attended and paid leave added together as
 * worked_days, and paid days are scheduled days less unpaid leave. Both are
 * inverted here rather than stored twice.
 *
 * That inversion is an assumption, and assumptions in payroll should be checked
 * rather than trusted -- which is what recomputing every line against its stored
 * amount does. Get this wrong and the screen says the payslip does not
 * reproduce, loudly, instead of showing plausible arithmetic for a wrong number.
 */
export function contextFor(payslip: StoredPayslip): PayslipContext {
  const hoursPerWeek = payslip.hours_per_week ?? 0;
  const wage = normaliseWage(payslip.wage ?? 0, payslip.wage_type ?? 'monthly', hoursPerWeek);

  const [fromYear, fromMonth, fromDay] = payslip.hire_date.split('-').map(Number) as number[];
  const [toYear, toMonth, toDay] = payslip.period_end.split('-').map(Number) as number[];
  let seniority = (toYear as number) - (fromYear as number);
  if ((toMonth as number) < (fromMonth as number)
    || ((toMonth as number) === (fromMonth as number) && (toDay as number) < (fromDay as number))) {
    seniority -= 1;
  }

  const calendarDays =
    Math.round((Date.parse(`${payslip.period_end}T00:00:00Z`)
      - Date.parse(`${payslip.period_start}T00:00:00Z`)) / 86_400_000) + 1;

  return {
    employee: { id: 0, seniority_years: Math.max(seniority, 0) },
    contract: { ...wage, schedule_hours_per_week: hoursPerWeek },
    period: { calendar_days: calendarDays },
    worked: {
      scheduled_days: payslip.scheduled_days,
      attended_days: payslip.worked_days - payslip.paid_leave_days,
      paid_days: payslip.scheduled_days - payslip.unpaid_leave_days,
      paid_leave_days: payslip.paid_leave_days,
      unpaid_leave_days: payslip.unpaid_leave_days,
      worked_hours: payslip.worked_hours,
      overtime_hours: payslip.overtime_hours,
      proration_factor: payslip.proration_factor,
    },
  };
}

/**
 * The same context in the flat form a rule reads.
 *
 * Built by the engine's own binder rather than by a second list of names here.
 * A hand-written copy would drift one variable at a time, and the symptom would
 * be an explanation that silently omits whatever was added last.
 */
export function bindingsFor(payslip: StoredPayslip): Map<string, number> {
  return bindPayslipContext(contextFor(payslip));
}

/** Recomputes one line and describes how it was arrived at. */
function explainLine(
  line: StoredLine,
  rule: SalaryRuleDefinition | undefined,
  bindings: Map<string, number>,
  categoryTotals: Map<string, number>,
  ruleResults: Map<string, number>,
): ExplainedLine {
  const base: Omit<ExplainedLine, 'recomputed' | 'reproduces' | 'headline' | 'steps'> = {
    rule_code: line.rule_code,
    rule_name: line.rule_name,
    category_code: line.category_code,
    category_sign: line.category_sign,
    sequence: line.sequence,
    computation_type: line.computation_type,
    amount: line.amount,
  };

  // The rule was deleted, or the structure was edited after this payslip was
  // computed. The line is still real -- somebody was paid it -- so show it and
  // say why it cannot be taken apart.
  if (rule === undefined) {
    return {
      ...base,
      recomputed: null,
      reproduces: true,
      headline: 'This rule is no longer part of the salary structure, so it cannot be re-run.',
      steps: null,
    };
  }

  const settle = (recomputed: number, headline: string, steps: ExplainStep | null): ExplainedLine => ({
    ...base,
    recomputed,
    // A hundredth of a rupee of slack: the stored value is numeric(14,2) and the
    // recomputation is a float, so an exact comparison would report drift that
    // is only the round trip through the column type.
    reproduces: Math.abs(recomputed - line.amount) < 0.005,
    headline,
    steps,
  });

  try {
    switch (rule.computation_type) {
      case 'fixed':
        return settle(
          roundMoney(rule.amount_fixed ?? 0),
          'A fixed amount set on the rule itself.',
          null,
        );

      case 'percentage': {
        const baseCode = rule.percentage_base_code ?? '';
        const baseValue = ruleResults.get(baseCode) ?? categoryTotals.get(baseCode);
        if (baseValue === undefined) {
          return {
            ...base,
            recomputed: null,
            reproduces: true,
            headline: `A percentage of ${baseCode}, which is not on this payslip.`,
            steps: null,
          };
        }
        return settle(
          roundMoney((baseValue * (rule.percentage ?? 0)) / 100),
          `${rule.percentage}% of ${baseCode}.`,
          null,
        );
      }

      case 'formula': {
        const source = rule.formula_expression ?? '';
        const { step, value } = explainExpression(source, bindings, `Rule ${rule.code}`);
        return settle(roundMoney(value), source, step);
      }
    }
  } catch (error) {
    return {
      ...base,
      recomputed: null,
      reproduces: true,
      headline: error instanceof AppError
        ? `This rule can no longer be re-run: ${error.message}`
        : 'This rule can no longer be re-run.',
      steps: null,
    };
  }
}

/**
 * Explains every line of a stored payslip.
 *
 * Later rules are fed the amounts *on file*, not the amounts just recomputed. If
 * one line has drifted, that keeps the drift on that line instead of cascading
 * it through every rule that reads it and reporting a dozen failures for one
 * cause.
 */
export async function explainPayslip(
  client: TransactionClient,
  payslipId: number,
): Promise<PayslipExplanation> {
  const [payslip] = await client.query<StoredPayslip>(
    `SELECT ps.id, ps.salary_structure_id, ps.period_start, ps.period_end,
            ps.scheduled_days::float8   AS scheduled_days,
            ps.worked_days::float8      AS worked_days,
            ps.worked_hours::float8     AS worked_hours,
            ps.paid_leave_days::float8  AS paid_leave_days,
            ps.unpaid_leave_days::float8 AS unpaid_leave_days,
            ps.overtime_hours::float8   AS overtime_hours,
            ps.proration_factor::float8 AS proration_factor,
            e.hire_date,
            c.wage::float8 AS wage, c.wage_type,
            w.hours_per_week::float8 AS hours_per_week
       FROM payslips ps
       JOIN employees e          ON e.id = ps.employee_id
       LEFT JOIN contracts c     ON c.id = ps.contract_id
       LEFT JOIN working_schedules w ON w.id = e.working_schedule_id
      WHERE ps.id = $1`,
    [payslipId],
  );

  if (payslip === undefined) {
    throw notFound('Payslip', payslipId);
  }

  const lines = await client.query<StoredLine>(
    `SELECT rule_code, rule_name, category_code, category_sign, sequence, computation_type,
            amount::float8 AS amount
       FROM payslip_lines WHERE payslip_id = $1 ORDER BY sequence ASC`,
    [payslipId],
  );

  const rules = await loadStructureRules(client, payslip.salary_structure_id);
  const byCode = new Map(rules.map((rule) => [rule.code, rule]));

  const bindings = bindingsFor(payslip);
  const ruleResults = new Map<string, number>();
  const categoryTotals = new Map<string, number>();
  const explained: ExplainedLine[] = [];

  for (const line of lines) {
    explained.push(
      explainLine(line, byCode.get(line.rule_code), bindings, categoryTotals, ruleResults),
    );

    ruleResults.set(line.rule_code, line.amount);
    categoryTotals.set(
      line.category_code,
      (categoryTotals.get(line.category_code) ?? 0) + line.amount,
    );
    bindings.set(`rules.${line.rule_code}`, line.amount);
    for (const [categoryCode, total] of categoryTotals) {
      bindings.set(`categories.${categoryCode}`, total);
    }
  }

  return {
    payslip_id: payslipId,
    context: CONTEXT_VARIABLE_NAMES.map((name) => ({
      name,
      label: VARIABLE_LABELS[name],
      value: bindings.get(name) ?? 0,
    })),
    lines: explained,
    reproduces: explained.every((line) => line.reproduces),
    unavailable: payslip.wage === null
      ? 'This payslip has no contract on file, so the wage it was computed from is unknown.'
      : null,
  };
}
