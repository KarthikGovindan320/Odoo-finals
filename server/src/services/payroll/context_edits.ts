/**
 * Changing a payslip context without making it incoherent.
 *
 * Several of the values a rule can read are not independent of the others. Paid
 * days are scheduled days less unpaid leave. The monthly and hourly wages are
 * the contract wage normalised against the schedule. Set one and leave the
 * others alone and the result is a period that could not have happened -- and
 * the engine will price it anyway, cheerfully, because it has no way to know.
 *
 * Both callers that build a hypothetical context go through here: the
 * period-over-period comparison, which puts one input back to ask what it did,
 * and the scenario simulator, which moves several at once to ask what a decision
 * would cost. Having one implementation of "what follows from what" means a
 * relationship added later cannot be honoured in one and forgotten in the other.
 */
import { normaliseWage } from './contract_wage.ts';
import type { WageType } from './contract_wage.ts';
import type { PayslipContext } from './rule_engine.ts';

/** Values fixed by other values, which therefore may never be set directly. */
export const DERIVED_CONTEXT_VALUES = new Set<string>([
  'worked.paid_days',
  'contract.monthly_wage',
  'contract.hourly_wage',
]);

/** A copy deep enough that editing it cannot reach back into the original. */
export function copyContext(context: PayslipContext): PayslipContext {
  return {
    employee: { ...context.employee },
    contract: { ...context.contract },
    period: { ...context.period },
    worked: { ...context.worked },
  };
}

/**
 * Recomputes everything that follows from everything else.
 *
 * Applied unconditionally rather than only to what the caller touched, so a
 * derived value added later cannot be forgotten on one edit path.
 */
export function reconcileContext(context: PayslipContext, wageType: WageType): PayslipContext {
  context.worked.paid_days = context.worked.scheduled_days - context.worked.unpaid_leave_days;

  const wage = normaliseWage(
    context.contract.wage,
    wageType,
    context.contract.schedule_hours_per_week,
  );
  context.contract.monthly_wage = wage.monthly_wage;
  context.contract.hourly_wage = wage.hourly_wage;

  return context;
}
