/**
 * Calendar arithmetic and money rounding.
 *
 * Both were previously untested, which is the wrong way round: they have no I/O
 * and are trivial to test, and every payroll figure in the system is built on
 * them. The cases below are the ones that actually bite -- month ends, leap
 * days, DST-shifted zones, and the half-cent rounding boundary.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addDays,
  dayOfWeek,
  daysOverlapping,
  eachDay,
  inclusiveDayCount,
} from '../src/services/payroll/period.ts';
import { formatMoney, formatMoneyForPrint, roundMoney } from '../src/lib/money.ts';
import { normaliseWage } from '../src/services/payroll/contract_wage.ts';

describe('period arithmetic', () => {
  it('adds days across a month boundary', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });

  it('handles the leap day', () => {
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
    assert.equal(addDays('2024-02-29', 1), '2024-03-01');
    assert.equal(inclusiveDayCount('2024-02-01', '2024-02-29'), 29);
    assert.equal(inclusiveDayCount('2026-02-01', '2026-02-28'), 28);
  });

  it('counts inclusively', () => {
    assert.equal(inclusiveDayCount('2026-09-01', '2026-09-01'), 1);
    assert.equal(inclusiveDayCount('2026-09-01', '2026-09-30'), 30);
  });

  it('does not shift a date under a non-UTC process timezone', () => {
    // The whole reason these are strings rather than Dates. A process running in
    // Sydney must not turn the 1st into the 31st.
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Australia/Sydney';
      assert.equal(addDays('2026-09-01', 0), '2026-09-01');
      assert.equal(dayOfWeek('2026-09-01'), 2, '1 September 2026 is a Tuesday');
    } finally {
      process.env.TZ = original;
    }
  });

  it('computes overlap between two ranges', () => {
    assert.equal(daysOverlapping('2026-09-01', '2026-09-30', '2026-09-01', '2026-09-30'), 30);
    assert.equal(daysOverlapping('2026-09-10', '2026-09-20', '2026-09-01', '2026-09-30'), 11);
    assert.equal(daysOverlapping('2026-10-01', '2026-10-31', '2026-09-01', '2026-09-30'), 0);
  });

  it('treats a null end date as open-ended', () => {
    assert.equal(daysOverlapping('2026-09-15', null, '2026-09-01', '2026-09-30'), 16);
  });

  it('enumerates a range, and returns nothing for an inverted one', () => {
    assert.deepEqual(eachDay('2026-09-01', '2026-09-03'), ['2026-09-01', '2026-09-02', '2026-09-03']);
    assert.deepEqual(eachDay('2026-09-03', '2026-09-01'), []);
  });

  it('numbers weekdays from Sunday, matching working_schedule_lines', () => {
    assert.equal(dayOfWeek('2026-09-06'), 0, 'Sunday');
    assert.equal(dayOfWeek('2026-09-07'), 1, 'Monday');
    assert.equal(dayOfWeek('2026-09-12'), 6, 'Saturday');
  });
});

describe('money rounding', () => {
  it('rounds to two decimals', () => {
    assert.equal(roundMoney(1234.567), 1234.57);
    assert.equal(roundMoney(1234.564), 1234.56);
  });

  it('rounds half away from zero, symmetrically', () => {
    // A deduction and an earning of the same magnitude must round the same way,
    // or the printed lines stop summing to the printed total.
    assert.equal(roundMoney(0.125), 0.13);
    assert.equal(roundMoney(-0.125), -0.13);
    assert.equal(roundMoney(2.5 / 100), 0.03);
    assert.equal(roundMoney(-2.5 / 100), -0.03);
  });

  it('corrects the binary-float artefact at the boundary', () => {
    // 1.005 is stored as 1.00499999999999989, which rounds down without help.
    assert.equal(roundMoney(1.005), 1.01);
    assert.equal(roundMoney(8.475), 8.48);
  });

  it('refuses a non-finite amount rather than producing NaN', () => {
    assert.throws(() => roundMoney(Number.POSITIVE_INFINITY), RangeError);
    assert.throws(() => roundMoney(Number.NaN), RangeError);
  });

  it('prints the currency code rather than a symbol PDFKit cannot draw', () => {
    // The screen keeps the symbol; the PDF cannot, because its built-in
    // Helvetica has no glyph for U+20B9 and silently drew a superscript one.
    assert.match(formatMoney(1000), /₹/);
    assert.match(formatMoneyForPrint(1000), /INR/);
    assert.doesNotMatch(formatMoneyForPrint(1000), /₹/);
  });
});

describe('wage normalisation', () => {
  it('leaves a monthly contract alone and derives its hourly rate', () => {
    const wage = normaliseWage(60000, 'monthly', 40);
    assert.equal(wage.wage, 60000);
    assert.equal(wage.monthly_wage, 60000);
    // 40 hours a week is 173.33 a month.
    assert.ok(Math.abs(wage.hourly_wage - 346.15) < 0.01, `got ${wage.hourly_wage}`);
  });

  it('scales an hourly contract up to a month', () => {
    const wage = normaliseWage(500, 'hourly', 40);
    assert.equal(wage.wage, 500);
    assert.equal(wage.hourly_wage, 500);
    assert.ok(Math.abs(wage.monthly_wage - 86666.67) < 0.01, `got ${wage.monthly_wage}`);
  });

  it('reports zero rather than guessing when there is no schedule', () => {
    // With no hours there is no defensible conversion. Zero is visibly wrong;
    // an invented number is quietly wrong.
    const wage = normaliseWage(500, 'hourly', 0);
    assert.equal(wage.monthly_wage, 0);
    assert.equal(wage.hourly_wage, 500);
  });

  it('round-trips a monthly wage through the hourly form', () => {
    const wage = normaliseWage(60000, 'monthly', 40);
    const back = normaliseWage(wage.hourly_wage, 'hourly', 40);
    assert.ok(Math.abs(back.monthly_wage - 60000) < 0.01);
  });
});
