/**
 * Static checking of salary rule expressions, and the consistency of the three
 * lists it depends on.
 *
 * The drift tests matter more than they look. The whole value of checking names
 * at save time is that the checker's idea of what exists matches the engine's.
 * If someone adds a context variable to bindContext and not to
 * CONTEXT_VARIABLE_NAMES, every rule using it is rejected on the configuration
 * screen; if they add it the other way round, the check passes and the payrun
 * fails. Both are build failures here instead.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzeExpression } from '../src/services/payroll/expression/analyze.ts';
import { CONTEXT_VARIABLE_NAMES } from '../src/services/payroll/context_variables.ts';
import { FUNCTION_ARITY } from '../src/services/payroll/expression/functions.ts';
import { bindContextForTest } from '../src/services/payroll/rule_engine.ts';
import { normaliseWage } from '../src/services/payroll/contract_wage.ts';
import { evaluateNumericExpression } from '../src/services/payroll/expression/evaluator.ts';

describe('expression static analysis', () => {
  it('accepts every documented context variable', () => {
    for (const name of CONTEXT_VARIABLE_NAMES) {
      assert.deepEqual(analyzeExpression(name), [], `${name} should be a known variable`);
    }
  });

  it('rejects the typo that used to reach a payrun', () => {
    const problems = analyzeExpression('contract.wag * 2');
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.message ?? '', /Unknown variable 'contract\.wag'/);
  });

  it('suggests the name that was probably meant', () => {
    const problems = analyzeExpression('worked.paid_day');
    assert.match(problems[0]?.message ?? '', /Did you mean 'worked\.paid_days'\?/);
  });

  it('rejects an unknown function', () => {
    const problems = analyzeExpression('sqrt(contract.wage)');
    assert.match(problems[0]?.message ?? '', /Unknown function 'sqrt'/);
  });

  it('rejects a call with the wrong number of arguments', () => {
    const problems = analyzeExpression('max(contract.wage)');
    assert.match(problems[0]?.message ?? '', /takes between 2 and 8/);
  });

  it('reports every problem at once, not just the first', () => {
    const problems = analyzeExpression('contract.wag + worked.nonsense');
    assert.equal(problems.length, 2);
  });

  it('defers rules.* and categories.* to the engine, which knows the sequence', () => {
    assert.deepEqual(analyzeExpression('rules.BASIC * 0.1'), []);
    assert.deepEqual(analyzeExpression('categories.GROSS - categories.DED'), []);
  });

  it('still reports plain syntax errors', () => {
    assert.equal(analyzeExpression('contract.wage *').length, 1);
  });

  it('checks inside every branch of a conditional', () => {
    const problems = analyzeExpression('worked.overtime_hours > 0 ? contract.wag : 0');
    assert.equal(problems.length, 1);
  });
});

describe('the analyzer and the engine agree about what exists', () => {
  it('CONTEXT_VARIABLE_NAMES matches the bindings the engine actually supplies', () => {
    const supplied = [...bindContextForTest({
      employee: { id: 1, seniority_years: 3 },
      contract: { ...normaliseWage(60000, 'monthly', 40), schedule_hours_per_week: 40 },
      period: { calendar_days: 30 },
      worked: {
        scheduled_days: 22, attended_days: 22, paid_days: 22,
        paid_leave_days: 0, unpaid_leave_days: 0,
        worked_hours: 176, overtime_hours: 0, proration_factor: 1,
      },
    }).keys()].sort();

    assert.deepEqual(supplied, [...CONTEXT_VARIABLE_NAMES].sort());
  });

  it('every function the analyzer knows about is actually callable', () => {
    const bindings = new Map<string, number>([['contract.wage', 100]]);

    for (const [name, arity] of Object.entries(FUNCTION_ARITY)) {
      // 'if' takes a boolean first, so it gets its own shape.
      const call =
        name === 'if'
          ? 'if(contract.wage > 0, 1, 2)'
          : `${name}(${Array.from({ length: arity.min }, () => '1').join(', ')})`;

      assert.doesNotThrow(
        () => evaluateNumericExpression(call, bindings, `Rule using ${name}`),
        `${name}() is listed in FUNCTION_ARITY but the evaluator rejected ${call}`,
      );
    }
  });
});
