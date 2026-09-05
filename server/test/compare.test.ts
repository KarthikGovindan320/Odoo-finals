/**
 * The counterfactuals a period-over-period comparison is built on.
 *
 * Measuring what one input did by putting it back and re-running is only sound
 * if what comes out is a payslip that could have existed. The first version of
 * this reverted the scheduled day count on its own and left paid days where they
 * were, describing a month with 21 paid days out of 2 scheduled, and reported
 * 671,000 rupees of effect from a schedule change worth nothing like it.
 *
 * So the tests are about coherence, and about the thing most likely to break it
 * later: someone adding a context variable and not teaching this module how to
 * move it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { revertInput } from '../src/services/payroll/compare.ts';
import { DERIVED_CONTEXT_VALUES } from '../src/services/payroll/context_edits.ts';
import { CONTEXT_VARIABLE_NAMES } from '../src/services/payroll/context_variables.ts';
import { bindPayslipContext } from '../src/services/payroll/rule_engine.ts';
import { normaliseWage } from '../src/services/payroll/contract_wage.ts';
import type { PayslipContext } from '../src/services/payroll/rule_engine.ts';

const CONTEXT: PayslipContext = {
  employee: { id: 1, seniority_years: 3 },
  contract: {
    wage: 60000, monthly_wage: 60000, hourly_wage: 346.15, schedule_hours_per_week: 40,
  },
  period: { calendar_days: 30 },
  worked: {
    scheduled_days: 22, attended_days: 20, paid_days: 20, paid_leave_days: 0,
    unpaid_leave_days: 2, worked_hours: 160, overtime_hours: 4, proration_factor: 1,
  },
};

describe('period comparison counterfactuals', () => {
  it('knows how to move every input that is not derived from another', () => {
    // The drift guard. Add a context variable, forget the switch in revertInput,
    // and the comparison silently stops attributing anything to it -- a driver
    // that is missing from the list rather than wrong in it, which is the hardest
    // kind of error to notice on a screen.
    for (const name of CONTEXT_VARIABLE_NAMES) {
      if (DERIVED_CONTEXT_VALUES.has(name)) continue;
      assert.notEqual(
        revertInput(CONTEXT, name, 1, 'monthly'),
        null,
        `${name} is neither derived nor revertible, so nothing can be attributed to it`,
      );
    }
  });

  it('refuses to move a value that is fixed by other values', () => {
    for (const name of DERIVED_CONTEXT_VALUES) {
      assert.equal(revertInput(CONTEXT, name, 1, 'monthly'), null, name);
    }
  });

  it('keeps paid days equal to scheduled days less unpaid leave', () => {
    const fewerScheduled = revertInput(CONTEXT, 'worked.scheduled_days', 10, 'monthly');
    assert.equal(fewerScheduled?.worked.paid_days, 8, '10 scheduled less 2 unpaid');

    const noUnpaid = revertInput(CONTEXT, 'worked.unpaid_leave_days', 0, 'monthly');
    assert.equal(noUnpaid?.worked.paid_days, 22, '22 scheduled less none unpaid');
  });

  it('renormalises the wage when the wage or the schedule moves', () => {
    // Checked against the normaliser rather than against arithmetic on the
    // fixture: the fixture's hourly rate is a rounded literal, so doubling it
    // and doubling the real computation differ by a paisa and the test would be
    // asserting the rounding, not the behaviour.
    const raised = revertInput(CONTEXT, 'contract.wage', 120000, 'monthly');
    assert.equal(raised?.contract.monthly_wage, 120000);
    assert.deepEqual(
      { hourly: raised?.contract.hourly_wage, monthly: raised?.contract.monthly_wage },
      {
        hourly: normaliseWage(120000, 'monthly', 40).hourly_wage,
        monthly: normaliseWage(120000, 'monthly', 40).monthly_wage,
      },
    );

    const halfTime = revertInput(CONTEXT, 'contract.schedule_hours_per_week', 20, 'monthly');
    assert.equal(halfTime?.contract.monthly_wage, 60000, 'a monthly wage is not hours-dependent');
    assert.ok(
      (halfTime?.contract.hourly_wage ?? 0) > CONTEXT.contract.hourly_wage,
      'the same monthly wage over fewer hours is a higher hourly rate',
    );
  });

  it('changes nothing else about the context', () => {
    const reverted = revertInput(CONTEXT, 'worked.overtime_hours', 0, 'monthly');
    assert.equal(reverted?.worked.overtime_hours, 0);
    assert.equal(reverted?.worked.scheduled_days, CONTEXT.worked.scheduled_days);
    assert.equal(reverted?.employee.seniority_years, CONTEXT.employee.seniority_years);
    assert.equal(reverted?.period.calendar_days, CONTEXT.period.calendar_days);
    // And leaves the original alone -- it is reused for every other input.
    assert.equal(CONTEXT.worked.overtime_hours, 4);
  });

  it('produces a context the engine can bind without gaps', () => {
    const reverted = revertInput(CONTEXT, 'worked.paid_leave_days', 3, 'monthly');
    assert.notEqual(reverted, null);
    const bindings = bindPayslipContext(reverted as PayslipContext);
    for (const name of CONTEXT_VARIABLE_NAMES) {
      assert.equal(typeof bindings.get(name), 'number', `${name} must still be bound`);
    }
  });
});
