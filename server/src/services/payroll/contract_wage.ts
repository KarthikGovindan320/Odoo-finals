/**
 * Normalising a contract wage.
 *
 * wage_type was stored, edited in the UI and rendered in the contract list, but
 * never reached the rule engine: PayslipContext exposed only `contract.wage`.
 * An hourly contract at 500/hour was therefore handed to a monthly BASIC rule as
 * if 500 were a month's pay.
 *
 * Rather than branch inside every rule, the context now carries the same pay in
 * both units and rules pick the one they mean.
 */

/** Weeks per month, averaged over a year: 52 / 12. */
const WEEKS_PER_MONTH = 52 / 12;

export type NormalisedWage = {
  wage: number;
  monthly_wage: number;
  hourly_wage: number;
};

/**
 * `hoursPerWeek` comes from the working schedule. With no schedule there is no
 * defensible conversion between the two units, so the figure that was not given
 * is reported as 0 rather than guessed — a rule using it then produces 0, which
 * is visibly wrong, instead of a plausible number that is quietly wrong.
 */
export function normaliseWage(
  wage: number,
  wageType: 'monthly' | 'hourly',
  hoursPerWeek: number,
): NormalisedWage {
  const monthlyHours = hoursPerWeek * WEEKS_PER_MONTH;

  if (wageType === 'hourly') {
    return {
      wage,
      hourly_wage: wage,
      monthly_wage: monthlyHours > 0 ? wage * monthlyHours : 0,
    };
  }

  return {
    wage,
    monthly_wage: wage,
    hourly_wage: monthlyHours > 0 ? wage / monthlyHours : 0,
  };
}
