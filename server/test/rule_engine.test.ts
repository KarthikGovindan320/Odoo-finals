/**
 * Tests for the salary rule engine.
 *
 * The structure exercised here is the one the seed data installs, so these tests
 * and the demo compute the same numbers by the same route.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computePayslip } from '../src/services/payroll/rule_engine.ts';
import { normaliseWage } from '../src/services/payroll/contract_wage.ts';
import type {
  PayslipContext,
  SalaryRuleDefinition,
} from '../src/services/payroll/rule_engine.ts';
import { AppError } from '../src/errors/app_error.ts';

function rule(overrides: Partial<SalaryRuleDefinition> & Pick<SalaryRuleDefinition, 'code' | 'sequence' | 'category_code'>): SalaryRuleDefinition {
  return {
    salary_rule_id: overrides.sequence,
    name: overrides.code,
    category_sign: overrides.category_code === 'DED' ? -1 : 1,
    computation_type: 'fixed',
    amount_fixed: null,
    percentage: null,
    percentage_base_code: null,
    formula_expression: null,
    condition_type: 'always',
    condition_expression: null,
    appears_on_payslip: true,
    ...overrides,
  };
}

/** The seeded "Regular Salary" structure. */
const REGULAR_SALARY: SalaryRuleDefinition[] = [
  rule({
    code: 'BASIC', sequence: 10, category_code: 'BASIC', computation_type: 'formula',
    formula_expression: 'contract.wage * (worked.paid_days / worked.scheduled_days)',
  }),
  rule({
    code: 'HRA', sequence: 20, category_code: 'ALW', computation_type: 'percentage',
    percentage: 40, percentage_base_code: 'BASIC',
  }),
  rule({ code: 'CONV', sequence: 30, category_code: 'ALW', computation_type: 'fixed', amount_fixed: 1600 }),
  rule({
    code: 'OT', sequence: 40, category_code: 'ALW', computation_type: 'formula',
    formula_expression:
      'worked.overtime_hours * (contract.wage / (contract.schedule_hours_per_week * 4.33))',
    condition_type: 'formula', condition_expression: 'worked.overtime_hours > 0',
  }),
  rule({
    code: 'GROSS', sequence: 50, category_code: 'GROSS', computation_type: 'formula',
    formula_expression: 'categories.BASIC + categories.ALW',
  }),
  rule({
    code: 'PF', sequence: 60, category_code: 'DED', computation_type: 'formula',
    formula_expression: 'min(rules.BASIC * 0.12, 1800)',
  }),
  rule({ code: 'PT', sequence: 70, category_code: 'DED', computation_type: 'fixed', amount_fixed: 200 }),
  rule({
    code: 'LWP', sequence: 80, category_code: 'DED', computation_type: 'formula',
    formula_expression: '(contract.wage / worked.scheduled_days) * worked.unpaid_leave_days',
    condition_type: 'formula', condition_expression: 'worked.unpaid_leave_days > 0',
  }),
  rule({
    code: 'NET', sequence: 90, category_code: 'NET', computation_type: 'formula',
    formula_expression: 'categories.GROSS - categories.DED',
  }),
];

function contextFor(overrides: Partial<PayslipContext['worked']> = {}): PayslipContext {
  return {
    employee: { id: 1, seniority_years: 3 },
    contract: { ...normaliseWage(60000, 'monthly', 40), schedule_hours_per_week: 40 },
    period: { calendar_days: 30 },
    worked: {
      scheduled_days: 22,
      attended_days: 22,
      paid_days: 22,
      paid_leave_days: 0,
      unpaid_leave_days: 0,
      worked_hours: 176,
      overtime_hours: 0,
      proration_factor: 1,
      ...overrides,
    },
  };
}

const amountOf = (result: ReturnType<typeof computePayslip>, code: string): number => {
  const line = result.lines.find((candidate) => candidate.rule_code === code);
  assert.ok(line, `expected a line for ${code}`);
  return line.amount;
};

describe('a full month with no exceptions', () => {
  const result = computePayslip(REGULAR_SALARY, contextFor());

  it('computes basic from the contract wage', () => {
    assert.equal(amountOf(result, 'BASIC'), 60000);
  });

  it('computes HRA as a percentage of an earlier rule', () => {
    assert.equal(amountOf(result, 'HRA'), 24000);
  });

  it('caps provident fund at the statutory ceiling', () => {
    assert.equal(amountOf(result, 'PF'), 1800);
  });

  it('builds gross from category totals, not from named rules', () => {
    assert.equal(result.gross_amount, 60000 + 24000 + 1600);
  });

  it('arrives at net as gross minus deductions', () => {
    assert.equal(result.net_amount, 85600 - 2000);
  });

  it('omits rules whose condition is false rather than writing a zero line', () => {
    assert.deepEqual(result.skipped_rule_codes, ['OT', 'LWP']);
    assert.equal(result.lines.some((line) => line.rule_code === 'OT'), false);
  });

  it('the printed lines sum exactly to the printed net', () => {
    const signedTotal = result.lines
      .filter((line) => line.category_code === 'BASIC' || line.category_code === 'ALW' || line.category_code === 'DED')
      .reduce((total, line) => total + line.category_sign * line.amount, 0);
    assert.equal(signedTotal, result.net_amount);
  });
});

describe('unpaid leave reaches payroll', () => {
  // The second demo flow: allocation -> request -> approved -> reflected in pay.
  const result = computePayslip(
    REGULAR_SALARY,
    contextFor({ paid_days: 20, unpaid_leave_days: 2, attended_days: 20 }),
  );

  it('prorates basic by paid days over scheduled days', () => {
    assert.equal(amountOf(result, 'BASIC'), 54545.45);
  });

  it('adds a loss-of-pay deduction for the unpaid days', () => {
    assert.equal(amountOf(result, 'LWP'), 5454.55);
  });

  it('pays less than a clean month', () => {
    const clean = computePayslip(REGULAR_SALARY, contextFor());
    assert.ok(result.net_amount < clean.net_amount);
  });
});

describe('overtime', () => {
  const result = computePayslip(REGULAR_SALARY, contextFor({ overtime_hours: 6 }));

  it('includes the overtime line once its condition holds', () => {
    assert.equal(amountOf(result, 'OT'), 2078.52);
    assert.equal(result.skipped_rule_codes.includes('OT'), false);
  });

  it('feeds overtime into gross through its category', () => {
    assert.equal(result.gross_amount, 60000 + 24000 + 1600 + 2078.52);
  });
});

describe('rounding', () => {
  it('rounds every line to two decimals as it computes', () => {
    const result = computePayslip(REGULAR_SALARY, contextFor({ paid_days: 20 }));
    for (const line of result.lines) {
      assert.equal(
        line.amount,
        Number(line.amount.toFixed(2)),
        `${line.rule_code} carries more than two decimals`,
      );
    }
  });

  it('carries the rounded value forward, so totals foot exactly', () => {
    const result = computePayslip(REGULAR_SALARY, contextFor({ paid_days: 20, unpaid_leave_days: 2 }));
    const gross = amountOf(result, 'BASIC') + amountOf(result, 'HRA') + amountOf(result, 'CONV');
    assert.equal(result.gross_amount, gross);
  });
});

describe('configuration errors are reported, not absorbed', () => {
  const expectConfigError = (rules: SalaryRuleDefinition[], fragment: string): void => {
    assert.throws(
      () => computePayslip(rules, contextFor()),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'rule_configuration_invalid');
        assert.ok(
          error.message.includes(fragment),
          `${JSON.stringify(error.message)} should mention ${JSON.stringify(fragment)}`,
        );
        return true;
      },
    );
  };

  it('rejects an empty structure', () => {
    expectConfigError([], 'contains no rules');
  });

  it('rejects a structure with no net rule', () => {
    expectConfigError(
      REGULAR_SALARY.filter((candidate) => candidate.code !== 'NET'),
      'produces no net salary',
    );
  });

  it('rejects rules supplied out of sequence', () => {
    const outOfOrder = [...REGULAR_SALARY].reverse();
    expectConfigError(outOfOrder, 'not supplied in execution order');
  });

  it('explains a percentage whose base has not been computed yet', () => {
    expectConfigError(
      [
        rule({
          code: 'HRA', sequence: 10, category_code: 'ALW', computation_type: 'percentage',
          percentage: 40, percentage_base_code: 'BASIC',
        }),
        rule({ code: 'NET', sequence: 20, category_code: 'NET', computation_type: 'fixed', amount_fixed: 0 }),
      ],
      'only take a percentage of something earlier in the sequence',
    );
  });

  it('explains a rule that references a later rule', () => {
    expectConfigError(
      [
        rule({
          code: 'BASIC', sequence: 10, category_code: 'BASIC', computation_type: 'formula',
          formula_expression: 'rules.NET * 0.5',
        }),
        rule({ code: 'NET', sequence: 20, category_code: 'NET', computation_type: 'fixed', amount_fixed: 100 }),
      ],
      'computed earlier in the sequence',
    );
  });
});
