/**
 * The salary rule engine.
 *
 * Rules execute in sequence, and the sequence is a dependency declaration: rule n
 * may read the results of rules 1..n-1 and nothing later. That is why the context
 * only ever grows, and why a rule referencing a later rule fails with a message
 * about ordering rather than producing a quietly wrong number.
 *
 * The engine is pure. It receives rule definitions and a context, and returns
 * lines and totals. It opens no database connection and knows nothing about
 * payruns, which is what makes it testable on its own and reusable for a
 * "preview this rule" screen later.
 *
 * Rounding happens per line, immediately, and the rounded value is what later
 * rules read. See lib/money.ts for why.
 */
import { AppError } from '../../errors/app_error.ts';
import { roundMoney } from '../../lib/money.ts';
import {
  evaluateConditionExpression,
  evaluateNumericExpression,
} from './expression/evaluator.ts';

export type ComputationType = 'fixed' | 'percentage' | 'formula';
export type ConditionType = 'always' | 'formula';

export type SalaryRuleDefinition = {
  salary_rule_id: number;
  code: string;
  name: string;
  category_code: string;
  category_sign: number;
  sequence: number;
  computation_type: ComputationType;
  amount_fixed: number | null;
  percentage: number | null;
  percentage_base_code: string | null;
  formula_expression: string | null;
  condition_type: ConditionType;
  condition_expression: string | null;
  appears_on_payslip: boolean;
};

/** Everything a rule is allowed to know about the employee being paid. */
export type PayslipContext = {
  employee: {
    id: number;
    seniority_years: number;
  };
  contract: {
    wage: number;
    schedule_hours_per_week: number;
  };
  period: {
    calendar_days: number;
  };
  worked: {
    scheduled_days: number;
    attended_days: number;
    paid_days: number;
    paid_leave_days: number;
    unpaid_leave_days: number;
    worked_hours: number;
    overtime_hours: number;
    proration_factor: number;
  };
};

export type ComputedLine = {
  salary_rule_id: number;
  rule_code: string;
  rule_name: string;
  category_code: string;
  category_sign: number;
  sequence: number;
  computation_type: ComputationType;
  source_expression: string;
  quantity: number;
  rate: number;
  amount: number;
};

export type ComputationResult = {
  lines: ComputedLine[];
  category_totals: Record<string, number>;
  gross_amount: number;
  net_amount: number;
  skipped_rule_codes: string[];
};

const GROSS_CATEGORY = 'GROSS';
const NET_CATEGORY = 'NET';

/**
 * Flattens the context into the dotted names a rule may reference.
 *
 * A Map rather than the nested object itself: the evaluator then has no object to
 * traverse, so there is nothing to escape from. Adding a variable to the language
 * means adding a line here, which is a deliberately visible act.
 */
function bindContext(context: PayslipContext): Map<string, number> {
  return new Map<string, number>([
    ['employee.seniority_years', context.employee.seniority_years],
    ['contract.wage', context.contract.wage],
    ['contract.schedule_hours_per_week', context.contract.schedule_hours_per_week],
    ['period.calendar_days', context.period.calendar_days],
    ['worked.scheduled_days', context.worked.scheduled_days],
    ['worked.attended_days', context.worked.attended_days],
    ['worked.paid_days', context.worked.paid_days],
    ['worked.paid_leave_days', context.worked.paid_leave_days],
    ['worked.unpaid_leave_days', context.worked.unpaid_leave_days],
    ['worked.worked_hours', context.worked.worked_hours],
    ['worked.overtime_hours', context.worked.overtime_hours],
    ['worked.proration_factor', context.worked.proration_factor],
  ]);
}

function resolvePercentageBase(
  baseCode: string,
  ruleResults: Map<string, number>,
  categoryTotals: Map<string, number>,
  label: string,
): number {
  const fromRule = ruleResults.get(baseCode);
  if (fromRule !== undefined) {
    return fromRule;
  }

  const fromCategory = categoryTotals.get(baseCode);
  if (fromCategory !== undefined) {
    return fromCategory;
  }

  throw new AppError(
    'rule_configuration_invalid',
    `${label} is a percentage of '${baseCode}', but no rule or category with that code has been ` +
      'computed yet. A rule can only take a percentage of something earlier in the sequence.',
    { base_code: baseCode },
  );
}

function describeRule(rule: SalaryRuleDefinition): string {
  return `Rule ${rule.code} (${rule.name})`;
}

/**
 * Computes one payslip's lines from an ordered rule set and a context.
 *
 * `rules` must already be sorted into execution order by the caller; the engine
 * asserts it rather than re-sorting, because silently reordering a caller's rules
 * would hide a configuration mistake instead of reporting it.
 */
export function computePayslip(
  rules: readonly SalaryRuleDefinition[],
  context: PayslipContext,
): ComputationResult {
  if (rules.length === 0) {
    throw new AppError(
      'rule_configuration_invalid',
      'This salary structure contains no rules, so there is nothing to compute. ' +
        'Add at least a basic salary rule and a net salary rule.',
    );
  }

  for (let index = 1; index < rules.length; index += 1) {
    const previous = rules[index - 1] as SalaryRuleDefinition;
    const current = rules[index] as SalaryRuleDefinition;
    if (current.sequence <= previous.sequence) {
      throw new AppError(
        'rule_configuration_invalid',
        `Salary rules were not supplied in execution order: ${current.code} has sequence ` +
          `${current.sequence}, which does not follow ${previous.code} at ${previous.sequence}.`,
      );
    }
  }

  const bindings = bindContext(context);
  const ruleResults = new Map<string, number>();
  const categoryTotals = new Map<string, number>();
  const lines: ComputedLine[] = [];
  const skippedRuleCodes: string[] = [];

  for (const rule of rules) {
    const label = describeRule(rule);

    // A rule whose condition is false contributes nothing at all -- no line, no
    // zero, no entry in the context. A zero line would be indistinguishable from
    // a rule that genuinely computed zero.
    if (rule.condition_type === 'formula') {
      const conditionSource = rule.condition_expression ?? '';
      if (!evaluateConditionExpression(conditionSource, bindings, label)) {
        skippedRuleCodes.push(rule.code);
        continue;
      }
    }

    const { amount, sourceExpression, quantity, rate } = computeRuleAmount(
      rule,
      label,
      bindings,
      ruleResults,
      categoryTotals,
    );

    lines.push({
      salary_rule_id: rule.salary_rule_id,
      rule_code: rule.code,
      rule_name: rule.name,
      category_code: rule.category_code,
      category_sign: rule.category_sign,
      sequence: rule.sequence,
      computation_type: rule.computation_type,
      source_expression: sourceExpression,
      quantity,
      rate,
      amount,
    });

    ruleResults.set(rule.code, amount);
    categoryTotals.set(rule.category_code, (categoryTotals.get(rule.category_code) ?? 0) + amount);

    // Results become visible to later rules under both namespaces, which is what
    // lets GROSS read categories.ALW without knowing which allowances exist.
    bindings.set(`rules.${rule.code}`, amount);
    for (const [categoryCode, total] of categoryTotals) {
      bindings.set(`categories.${categoryCode}`, total);
    }
  }

  const netAmount = categoryTotals.get(NET_CATEGORY);
  if (netAmount === undefined) {
    throw new AppError(
      'rule_configuration_invalid',
      'This salary structure produces no net salary. Add a rule in the Net category, ' +
        'normally computed as categories.GROSS - categories.DED.',
    );
  }

  return {
    lines,
    category_totals: Object.fromEntries(categoryTotals),
    gross_amount: categoryTotals.get(GROSS_CATEGORY) ?? 0,
    net_amount: netAmount,
    skipped_rule_codes: skippedRuleCodes,
  };
}

type RuleAmount = {
  amount: number;
  sourceExpression: string;
  quantity: number;
  rate: number;
};

function computeRuleAmount(
  rule: SalaryRuleDefinition,
  label: string,
  bindings: Map<string, number>,
  ruleResults: Map<string, number>,
  categoryTotals: Map<string, number>,
): RuleAmount {
  switch (rule.computation_type) {
    case 'fixed': {
      if (rule.amount_fixed === null) {
        throw new AppError(
          'rule_configuration_invalid',
          `${label} is a fixed amount but no amount is set.`,
        );
      }
      return {
        amount: roundMoney(rule.amount_fixed),
        sourceExpression: String(rule.amount_fixed),
        quantity: 1,
        rate: 100,
      };
    }

    case 'percentage': {
      if (rule.percentage === null || rule.percentage_base_code === null) {
        throw new AppError(
          'rule_configuration_invalid',
          `${label} is a percentage but its rate or its base is not set.`,
        );
      }
      const base = resolvePercentageBase(
        rule.percentage_base_code,
        ruleResults,
        categoryTotals,
        label,
      );
      return {
        amount: roundMoney((base * rule.percentage) / 100),
        sourceExpression: `${rule.percentage}% of ${rule.percentage_base_code}`,
        quantity: base,
        rate: rule.percentage,
      };
    }

    case 'formula': {
      const expression = rule.formula_expression ?? '';
      return {
        amount: roundMoney(evaluateNumericExpression(expression, bindings, label)),
        sourceExpression: expression,
        quantity: 1,
        rate: 100,
      };
    }
  }
}
