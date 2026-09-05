/**
 * Every variable name a salary rule may reference.
 *
 * Single source of truth, read by two things that must never disagree:
 * bindContext() in rule_engine.ts, which supplies the values, and
 * analyzeExpression() in expression/analyze.ts, which rejects a rule naming
 * anything absent from this list. A test asserts the binding map's keys are
 * exactly these names, so adding a variable in one place and not the other
 * fails the build rather than a payrun.
 */
export const CONTEXT_VARIABLE_NAMES = [
  'employee.seniority_years',
  'contract.wage',
  'contract.hourly_wage',
  'contract.monthly_wage',
  'contract.schedule_hours_per_week',
  'period.calendar_days',
  'worked.scheduled_days',
  'worked.attended_days',
  'worked.paid_days',
  'worked.paid_leave_days',
  'worked.unpaid_leave_days',
  'worked.worked_hours',
  'worked.overtime_hours',
  'worked.proration_factor',
] as const;

export type ContextVariableName = (typeof CONTEXT_VARIABLE_NAMES)[number];
