/**
 * Which contract prices this payroll period?
 *
 * This is the question the whole problem turns on. It is a range-overlap query,
 * not an is_active flag: an employee may have had three contracts, and payroll
 * must use the one that was true during the period being paid.
 *
 * Several contracts may touch one period without being in force at the same
 * instant -- a promotion on the 16th closes one and opens the next. Payroll
 * resolves that to the contract in force on the last day of the period and warns
 * that a change happened; it is not an error. Genuine simultaneity is what the
 * exclusion constraint in 006 forbids, and this module asserts it separately.
 */
import type { TransactionClient } from '../../db/pool.ts';
import { daysOverlapping } from './period.ts';

export type ResolvedContract = {
  contract_id: number;
  reference: string;
  wage: number;
  wage_type: 'monthly' | 'hourly';
  salary_structure_id: number | null;
  working_schedule_id: number | null;
  start_date: string;
  end_date: string | null;
};

export type ContractResolution =
  | {
      outcome: 'resolved';
      contract: ResolvedContract;
      coversWholePeriod: boolean;
      /** Earlier contracts that also touch this period, newest first. */
      supersededContracts: ResolvedContract[];
    }
  | { outcome: 'none' }
  | { outcome: 'ambiguous'; contracts: ResolvedContract[] };

/**
 * Two contracts may legitimately touch one payroll period without overlapping
 * each other -- a promotion on the 16th ends one contract and begins the next.
 * That is a contract change, not an ambiguity, and the exclusion constraint in
 * 006 already guarantees the two do not overlap.
 *
 * True ambiguity would mean two contracts in force at the same instant, which the
 * database forbids. We check for it anyway: a constraint we rely on is a
 * constraint worth asserting, and if it ever fires we would much rather see it
 * than silently pick a row.
 */
function findGenuineOverlap(contracts: readonly ResolvedContract[]): boolean {
  for (let outer = 0; outer < contracts.length; outer += 1) {
    for (let inner = outer + 1; inner < contracts.length; inner += 1) {
      const first = contracts[outer] as ResolvedContract;
      const second = contracts[inner] as ResolvedContract;
      const firstEnd = first.end_date;
      const secondEnd = second.end_date;

      const overlaps =
        (secondEnd === null || first.start_date <= secondEnd) &&
        (firstEnd === null || second.start_date <= firstEnd);

      if (overlaps) {
        return true;
      }
    }
  }
  return false;
}

export async function resolveContractForPeriod(
  client: TransactionClient,
  employeeId: number,
  periodStart: string,
  periodEnd: string,
): Promise<ContractResolution> {
  const contracts = await client.query<ResolvedContract>(
    `SELECT id AS contract_id, reference, wage, wage_type, salary_structure_id,
            working_schedule_id, start_date::text, end_date::text
       FROM contracts
      WHERE employee_id = $1
        AND state IN ('running', 'expired')
        AND validity && daterange($2::date, $3::date, '[]')
      ORDER BY start_date DESC`,
    [employeeId, periodStart, periodEnd],
  );

  if (contracts.length === 0) {
    return { outcome: 'none' };
  }

  if (contracts.length > 1 && findGenuineOverlap(contracts)) {
    return { outcome: 'ambiguous', contracts };
  }

  // The contract in force on the last day of the period prices it. Where a change
  // happened mid-period, that is the newer contract -- the one the employee is on
  // when the run is paid. Recorded as ambiguity #2 in plan.md, along with why we
  // do not split the payslip into two prorated segments.
  const inForceAtPeriodEnd = contracts.find(
    (candidate) =>
      candidate.start_date <= periodEnd &&
      (candidate.end_date === null || candidate.end_date >= periodEnd),
  );
  const contract = inForceAtPeriodEnd ?? (contracts[0] as ResolvedContract);

  const coveredDays = daysOverlapping(
    contract.start_date,
    contract.end_date,
    periodStart,
    periodEnd,
  );
  const periodDays = daysOverlapping(periodStart, periodEnd, periodStart, periodEnd);

  return {
    outcome: 'resolved',
    contract,
    coversWholePeriod: coveredDays >= periodDays,
    supersededContracts: contracts.filter(
      (candidate) => candidate.contract_id !== contract.contract_id,
    ),
  };
}
