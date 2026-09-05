/**
 * Tests for the salary rule expression language.
 *
 * The adversarial cases matter as much as the arithmetic ones: this module exists
 * so that user-authored rule text is never executable JavaScript, and a test suite
 * that only checks that 2+2 is 4 would not notice if that property broke.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateConditionExpression,
  evaluateNumericExpression,
} from '../src/services/payroll/expression/evaluator.ts';
import { AppError } from '../src/errors/app_error.ts';

const bindings = new Map<string, number>([
  ['contract.wage', 60000],
  ['worked.scheduled_days', 22],
  ['worked.paid_days', 20],
  ['worked.unpaid_leave_days', 2],
  ['worked.overtime_hours', 6],
  ['rules.BASIC', 50000],
  ['categories.GROSS', 72000],
  ['categories.DED', 2000],
  ['zero', 0],
]);

function evaluate(source: string): number {
  return evaluateNumericExpression(source, bindings, 'Rule TEST');
}

function expectRejection(source: string, expectedFragment: string): void {
  assert.throws(
    () => evaluate(source),
    (error: unknown) => {
      assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
      assert.equal(error.code, 'rule_configuration_invalid');
      assert.ok(
        error.message.includes(expectedFragment),
        `message ${JSON.stringify(error.message)} should mention ${JSON.stringify(expectedFragment)}`,
      );
      return true;
    },
  );
}

describe('arithmetic and precedence', () => {
  it('respects multiplicative over additive precedence', () => {
    assert.equal(evaluate('2 + 3 * 4'), 14);
    assert.equal(evaluate('(2 + 3) * 4'), 20);
  });

  it('is left associative for subtraction and division', () => {
    assert.equal(evaluate('100 - 30 - 20'), 50);
    assert.equal(evaluate('100 / 5 / 2'), 10);
  });

  it('handles unary minus, including before a parenthesised group', () => {
    assert.equal(evaluate('-5 + 10'), 5);
    assert.equal(evaluate('-(3 * 4)'), -12);
    assert.equal(evaluate('10 - -5'), 15);
  });

  it('supports decimals and the modulo operator', () => {
    assert.equal(evaluate('0.5 * 8'), 4);
    assert.equal(evaluate('.25 * 8'), 2);
    assert.equal(evaluate('17 % 5'), 2);
  });
});

describe('variables', () => {
  it('resolves dotted names from the payslip context', () => {
    assert.equal(evaluate('contract.wage'), 60000);
    assert.equal(evaluate('rules.BASIC * 0.4'), 20000);
  });

  it('computes a prorated basic the way the seeded structure does', () => {
    assert.equal(
      evaluate('contract.wage * (worked.paid_days / worked.scheduled_days)'),
      60000 * (20 / 22),
    );
  });

  it('names the unknown variable rather than failing generically', () => {
    expectRejection('rules.NOPE + 1', "Unknown variable 'rules.NOPE'");
  });

  it('explains that rules may only reference earlier results', () => {
    expectRejection('rules.NET', 'computed earlier in the sequence');
  });
});

describe('functions', () => {
  it('applies the statutory-cap pattern used by the PF rule', () => {
    assert.equal(evaluate('min(rules.BASIC * 0.12, 1800)'), 1800);
    assert.equal(evaluate('min(1000 * 0.12, 1800)'), 120);
  });

  it('supports max, abs, floor, ceil and round', () => {
    assert.equal(evaluate('max(3, 9)'), 9);
    assert.equal(evaluate('abs(0 - 7)'), 7);
    assert.equal(evaluate('floor(7.9)'), 7);
    assert.equal(evaluate('ceil(7.1)'), 8);
    assert.equal(evaluate('round(7.456, 2)'), 7.46);
  });

  it('evaluates if() lazily, so the untaken branch may be undefined', () => {
    assert.equal(evaluate('if(zero > 0, 100 / zero, 0)'), 0);
  });

  it('rejects an unknown function and lists what is available', () => {
    expectRejection('sqrt(9)', "Unknown function 'sqrt'");
    expectRejection('sqrt(9)', 'Available functions');
  });

  it('rejects the wrong number of arguments', () => {
    expectRejection('min(5)', 'between 2 and 8 arguments');
    expectRejection('if(true, 1)', 'exactly 3 arguments');
  });
});

describe('conditions and boolean logic', () => {
  const condition = (source: string): boolean =>
    evaluateConditionExpression(source, bindings, 'Rule OT');

  it('evaluates the overtime rule condition', () => {
    assert.equal(condition('worked.overtime_hours > 0'), true);
    assert.equal(condition('worked.unpaid_leave_days > 5'), false);
  });

  it('short-circuits and/or', () => {
    assert.equal(condition('zero > 0 and 100 / zero > 1'), false);
    assert.equal(condition('worked.overtime_hours > 0 or 100 / zero > 1'), true);
  });

  it('supports not and comparison chaining through parentheses', () => {
    assert.equal(condition('not (zero > 0)'), true);
    assert.equal(condition('(contract.wage > 1000) and (rules.BASIC < contract.wage)'), true);
  });

  it('supports the ternary operator', () => {
    assert.equal(evaluate('worked.overtime_hours > 0 ? 500 : 0'), 500);
    assert.equal(evaluate('zero > 0 ? 500 : 0'), 0);
  });

  it('insists a condition produce a boolean, with a worked example', () => {
    assert.throws(
      () => condition('worked.overtime_hours'),
      (error: unknown) =>
        error instanceof AppError && error.message.includes('worked.overtime_hours > 0'),
    );
  });
});

describe('refusing to be a JavaScript engine', () => {
  // These are the reason this module exists. Each one is a real escape used
  // against naive eval-based rule engines; here they are all just unknown names.
  const escapes = [
    'constructor.constructor',
    '__proto__.polluted',
    'process.exit',
    'globalThis.process',
    'this.constructor',
    'require.main',
  ];

  for (const source of escapes) {
    it(`treats '${source}' as an unknown variable, not as code`, () => {
      expectRejection(source, 'Unknown variable');
    });
  }

  it('has no string literals to smuggle anything through', () => {
    expectRejection('"a" + "b"', 'Unexpected character');
  });

  it('rejects assignment and statement separators outright', () => {
    expectRejection('a = 1', 'Unexpected character');
    expectRejection('1; 2', 'Unexpected character');
  });

  it('rejects calling a value that is not a whitelisted function', () => {
    expectRejection('rules.BASIC(1)', "Unknown function 'rules.BASIC'");
  });
});

describe('resource limits', () => {
  it('rejects an expression with too many terms before evaluating it', () => {
    const huge = Array.from({ length: 300 }, (_, index) => index).join(' + ');
    expectRejection(huge, 'too complex');
  });

  it('rejects deeply nested parentheses', () => {
    const deep = `${'('.repeat(40)}1${')'.repeat(40)}`;
    expectRejection(deep, 'nested more than');
  });
});

describe('error reporting', () => {
  it('reports the position of a syntax error', () => {
    expectRejection('1 + + 2', 'position');
  });

  it('names unbalanced parentheses', () => {
    expectRejection('(1 + 2', "Expected ')'");
  });

  it('refuses division by zero and suggests a guard', () => {
    expectRejection('contract.wage / zero', 'Division by zero');
  });

  it('rejects an empty expression', () => {
    expectRejection('   ', 'Expression is empty');
  });

  it('prefixes every message with the rule being computed', () => {
    expectRejection('nope', 'Rule TEST');
  });
});
