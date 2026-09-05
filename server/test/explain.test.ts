/**
 * The property that makes an explanation worth showing: it is the same
 * computation as the payslip, not a description of it.
 *
 * Everything here is aimed at one failure mode. A "why is my salary this?"
 * screen is easy to build as prose written beside the code, and prose does not
 * get re-run when the rule changes. These tests assert that the tree on screen
 * is produced by the evaluator itself and agrees with it on every expression the
 * language can express.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateNumericExpression,
  evaluateWithTrace,
} from '../src/services/payroll/expression/evaluator.ts';
import { explainExpression } from '../src/services/payroll/explain.ts';
import type { ExplainStep } from '../src/services/payroll/explain.ts';

const CONTEXT = new Map<string, number>([
  ['contract.monthly_wage', 60000],
  ['contract.hourly_wage', 375],
  ['worked.scheduled_days', 22],
  ['worked.unpaid_leave_days', 2],
  ['worked.overtime_hours', 8],
  ['worked.proration_factor', 1],
  ['employee.seniority_years', 3],
  ['rules.BASIC', 40000],
  ['categories.GROSS', 58200],
]);

/** Every expression shape the language has, so no node type goes untraced. */
const EXPRESSIONS = [
  '40000',
  'contract.monthly_wage',
  'contract.monthly_wage * 0.4',
  'contract.monthly_wage / worked.scheduled_days * worked.unpaid_leave_days',
  '-contract.hourly_wage',
  '(rules.BASIC + 1000) * 2 - 500',
  'min(contract.monthly_wage * 0.12, 1800)',
  'max(round(categories.GROSS * 0.05, 0), 200)',
  'worked.overtime_hours > 0 ? contract.hourly_wage * worked.overtime_hours * 1.5 : 0',
  'if(employee.seniority_years >= 5, 5000, if(employee.seniority_years >= 3, 2500, 0))',
  'worked.unpaid_leave_days > 0 and worked.scheduled_days > 0 ? 1 : 0',
  'floor(categories.GROSS / 1000) * 10',
  'abs(0 - rules.BASIC) % 7000',
];

function walk(step: ExplainStep, visit: (step: ExplainStep) => void): void {
  visit(step);
  for (const child of step.children) walk(child, visit);
}

describe('payslip explanation', () => {
  it('reports the same number the evaluator reports', () => {
    for (const source of EXPRESSIONS) {
      const { value } = explainExpression(source, CONTEXT, 'test');
      assert.equal(
        value,
        evaluateNumericExpression(source, CONTEXT, 'test'),
        `${source} should explain the number it computes`,
      );
    }
  });

  it("every step's value is the value that step produced", () => {
    // The root of the tree is the whole expression, so its recorded value has to
    // be the result. If recording drifted from evaluation, this is where it shows.
    for (const source of EXPRESSIONS) {
      const { step, value } = explainExpression(source, CONTEXT, 'test');
      assert.equal(step.value, value, `${source} root step`);
    }
  });

  it('renders each sub-expression back to something that means the same thing', () => {
    // A step shows its own source text. If rendering dropped a parenthesis, the
    // text on screen would justify a different number than the one beside it.
    for (const source of EXPRESSIONS) {
      const { step } = explainExpression(source, CONTEXT, 'test');
      walk(step, (node) => {
        if (node.value === null || typeof node.value !== 'number') return;
        assert.equal(
          evaluateNumericExpression(node.expression, CONTEXT, 'test'),
          node.value,
          `re-evaluating "${node.expression}" should give ${node.value}`,
        );
      });
    }
  });

  it('marks the branch that was not taken instead of pricing it', () => {
    const source = 'worked.overtime_hours > 0 ? 999 : 111';
    const { step } = explainExpression(source, CONTEXT, 'test');

    const unused = step.children.filter((child) => child.kind === 'unused');
    assert.equal(unused.length, 1, 'exactly one branch of a ternary is skipped');
    assert.equal(unused[0]?.expression, '111');
    assert.equal(unused[0]?.value, null, 'a branch not taken has no value');
    assert.match(unused[0]?.label ?? '', /not taken/);
  });

  it('does not record the short-circuited half of an and/or', () => {
    const { record, ast } = evaluateWithTrace('false and 1 > 0', CONTEXT, 'test');
    assert.equal(record.get(ast), false);
    assert.equal(record.size, 2, 'only the left operand and the whole expression evaluate');
  });

  it('leaves nothing recorded from a previous evaluation', () => {
    // The AST is cached and shared across every employee in a payrun, so a
    // record that outlived one evaluation would attribute one person's numbers
    // to the next. Each call must start empty.
    const first = evaluateWithTrace('contract.monthly_wage * 0.4', CONTEXT, 'test');
    const other = new Map(CONTEXT).set('contract.monthly_wage', 100000);
    const second = evaluateWithTrace('contract.monthly_wage * 0.4', other, 'test');

    assert.equal(first.record.get(first.ast), 24000);
    assert.equal(second.record.get(second.ast), 40000);
    assert.equal(first.ast, second.ast, 'the cached tree really is shared');
  });
});
