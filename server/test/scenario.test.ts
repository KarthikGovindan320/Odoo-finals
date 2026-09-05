/**
 * The scenario simulator, and the premise it rests on.
 *
 * That premise is worth stating as a test rather than as a claim in a comment:
 * payroll is not linear in the wage, so a 10% rise does not cost 10%. If it did,
 * this whole feature would be a multiplication and the honest thing would be to
 * delete it. The rule set below has a capped provident fund and a seniority
 * allowance -- both ordinary, both enough to break proportionality -- and the
 * test asserts the engine disagrees with the spreadsheet.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyScenario, EMPTY_SCENARIO } from '../src/services/payroll/scenario.ts';
import { computePayslip } from '../src/services/payroll/rule_engine.ts';
import type { PayslipContext, SalaryRuleDefinition } from '../src/services/payroll/rule_engine.ts';

const CONTEXT: PayslipContext = {
  employee: { id: 1, seniority_years: 4 },
  contract: {
    wage: 50000, monthly_wage: 50000, hourly_wage: 288.46, schedule_hours_per_week: 40,
  },
  period: { calendar_days: 30 },
  worked: {
    scheduled_days: 22, attended_days: 22, paid_days: 22, paid_leave_days: 0,
    unpaid_leave_days: 0, worked_hours: 176, overtime_hours: 0, proration_factor: 1,
  },
};

let sequence = 0;
const rule = (
  code: string,
  category: string,
  sign: number,
  extra: Partial<SalaryRuleDefinition>,
): SalaryRuleDefinition => ({
  salary_rule_id: (sequence += 1),
  code,
  name: code,
  category_code: category,
  category_sign: sign,
  sequence: sequence * 10,
  computation_type: 'formula',
  amount_fixed: null,
  percentage: null,
  percentage_base_code: null,
  formula_expression: null,
  condition_type: 'always',
  condition_expression: null,
  appears_on_payslip: true,
  ...extra,
});

const RULES: SalaryRuleDefinition[] = [
  rule('BASIC', 'BASIC', 1, {
    formula_expression: 'contract.wage * (worked.paid_days / worked.scheduled_days)',
  }),
  // Unconditional, so the allowance category always exists. Without one, a
  // structure whose only allowance is conditional leaves categories.ALW
  // undefined the moment the condition is false, and GROSS fails to resolve it
  // -- the engine is right to refuse, since a skipped rule contributes nothing
  // rather than zero, but it is not the behaviour under test here.
  rule('CONV', 'ALW', 1, { formula_expression: '1600' }),
  // Conditional: does not exist below five years, so a raise cannot create it.
  rule('LONG', 'ALW', 1, {
    formula_expression: '2000',
    condition_type: 'formula',
    condition_expression: 'employee.seniority_years >= 5',
  }),
  rule('GROSS', 'GROSS', 1, { formula_expression: 'categories.BASIC + categories.ALW' }),
  // Capped: stops rising once basic pay passes 15,000.
  rule('PF', 'DED', -1, { formula_expression: 'min(rules.BASIC * 0.12, 1800)' }),
  rule('NET', 'NET', 1, { formula_expression: 'categories.GROSS - categories.DED' }),
];

describe('scenario simulation', () => {
  it('changes nothing when the scenario is empty', () => {
    // The reset button's guarantee. If an empty scenario moved a rupee, every
    // figure this screen reports would be measured against the wrong baseline.
    const { context, clamped } = applyScenario(CONTEXT, EMPTY_SCENARIO, 'monthly');
    assert.equal(clamped, false);
    assert.deepEqual(
      computePayslip(RULES, context).net_amount,
      computePayslip(RULES, CONTEXT).net_amount,
    );
  });

  it('does not cost what multiplying the total would say', () => {
    const baseline = computePayslip(RULES, CONTEXT).net_amount;
    const { context } = applyScenario(
      CONTEXT, { ...EMPTY_SCENARIO, wage_change_percent: 10 }, 'monthly',
    );
    const projected = computePayslip(RULES, context).net_amount;

    assert.ok(projected > baseline, 'a rise costs more, not less');
    assert.notEqual(
      Math.round(projected * 100),
      Math.round(baseline * 1.1 * 100),
      'a capped deduction means net does not rise by the same percentage as the wage',
    );
    // Specifically: PF is capped at 1,800 both before and after, so the whole
    // rise lands in net and net rises by *more* than the wage did.
    assert.ok(projected - baseline > baseline * 0.1, 'the capped deduction does not follow the rise');
  });

  it('applies the percentage before the flat amount', () => {
    const { context } = applyScenario(
      CONTEXT, { ...EMPTY_SCENARIO, wage_change_percent: 10, wage_change_amount: 1000 }, 'monthly',
    );
    assert.equal(context.contract.wage, 50000 * 1.1 + 1000, '10% of the wage, then the flat sum');
  });

  it('keeps leave inside the period, and says when it had to', () => {
    const { context, clamped } = applyScenario(
      CONTEXT, { ...EMPTY_SCENARIO, unpaid_leave_days_delta: 40 }, 'monthly',
    );
    assert.equal(clamped, true, 'asking for more leave than the period holds is reported');
    assert.equal(context.worked.unpaid_leave_days, 22, 'capped at the days the schedule expected');
    assert.equal(context.worked.paid_days, 0, 'and paid days follow it down to zero, never below');

    const bothKinds = applyScenario(
      CONTEXT, { ...EMPTY_SCENARIO, unpaid_leave_days_delta: 15, paid_leave_days_delta: 15 },
      'monthly',
    );
    assert.equal(
      bothKinds.context.worked.unpaid_leave_days + bothKinds.context.worked.paid_leave_days,
      22,
      'the two kinds of leave share one budget of scheduled days',
    );
  });

  it('never sends a negative quantity into the rules', () => {
    const { context } = applyScenario(
      CONTEXT,
      {
        ...EMPTY_SCENARIO,
        wage_change_percent: -500,
        overtime_hours_delta: -100,
        seniority_years_delta: -99,
        unpaid_leave_days_delta: -5,
      },
      'monthly',
    );
    assert.equal(context.contract.wage, 0);
    assert.equal(context.worked.overtime_hours, 0);
    assert.equal(context.employee.seniority_years, 0);
    assert.equal(context.worked.unpaid_leave_days, 0);
    assert.ok(computePayslip(RULES, context).net_amount >= 0);
  });

  it('lets a conditional rule appear when the scenario earns it', () => {
    // Four years of service, so LONG does not apply. One more year and it does,
    // which a multiplication could never have produced.
    const before = computePayslip(RULES, CONTEXT);
    assert.ok(before.skipped_rule_codes.includes('LONG'));

    const { context } = applyScenario(
      CONTEXT, { ...EMPTY_SCENARIO, seniority_years_delta: 1 }, 'monthly',
    );
    const after = computePayslip(RULES, context);
    assert.ok(!after.skipped_rule_codes.includes('LONG'), 'the allowance now applies');
    assert.equal(after.net_amount - before.net_amount, 2000);
  });
});
