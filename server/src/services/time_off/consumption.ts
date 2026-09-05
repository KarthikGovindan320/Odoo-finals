/**
 * Leave balance consumption.
 *
 * Approving a request draws it down against one or more allocations; refusing or
 * cancelling releases what it drew. Balance itself is never stored -- it is
 * allocated minus consumed, read from v_time_off_balances -- so a release is a
 * DELETE and the balance restores itself with no compensating update to get wrong.
 *
 * Allocations are drawn oldest-expiring first. That is standard leave policy and
 * it avoids stranding balance that is about to lapse while a later allocation
 * still has room.
 */
import { AppError } from '../../errors/app_error.ts';
import type { TransactionClient } from '../../db/pool.ts';

export type AvailableAllocation = {
  allocation_id: number;
  valid_from: string;
  valid_to: string;
  remaining_amount: number;
};

export type ConsumptionEntry = {
  allocation_id: number;
  amount: number;
};

/**
 * Allocations that are approved, still valid, and cover the whole leave.
 *
 * Validity is checked here rather than at request time on purpose: a request is
 * an intent and should not be blocked by a balance the approver may be about to
 * grant, but approval is the moment balance actually moves, so that is the moment
 * integrity has to hold.
 */
export async function findAvailableAllocations(
  client: TransactionClient,
  employeeId: number,
  timeOffTypeId: number,
  dateFrom: string,
  dateTo: string,
): Promise<AvailableAllocation[]> {
  return client.query<AvailableAllocation>(
    `SELECT allocation_id, valid_from, valid_to, remaining_amount
       FROM v_time_off_balances
      WHERE employee_id = $1
        AND time_off_type_id = $2
        AND remaining_amount > 0
        AND valid_from <= $3::date
        AND valid_to   >= $4::date
      ORDER BY valid_to ASC, allocation_id ASC`,
    [employeeId, timeOffTypeId, dateFrom, dateTo],
  );
}

/** Splits `amount` across allocations, oldest-expiring first. Pure. */
export function planConsumption(
  allocations: readonly AvailableAllocation[],
  amount: number,
): { entries: ConsumptionEntry[]; shortfall: number } {
  const entries: ConsumptionEntry[] = [];
  let outstanding = amount;

  for (const allocation of allocations) {
    if (outstanding <= 0) {
      break;
    }
    const drawn = Math.min(allocation.remaining_amount, outstanding);
    if (drawn > 0) {
      entries.push({ allocation_id: allocation.allocation_id, amount: drawn });
      outstanding -= drawn;
    }
  }

  // Leave is counted in halves at the finest, so anything under a hundredth of a
  // day is float noise from the subtraction above, not a real shortfall.
  const shortfall = outstanding < 0.01 ? 0 : outstanding;
  return { entries, shortfall };
}

export async function consumeForRequest(
  client: TransactionClient,
  input: {
    requestId: number;
    employeeId: number;
    timeOffTypeId: number;
    typeName: string;
    dateFrom: string;
    dateTo: string;
    amount: number;
  },
): Promise<ConsumptionEntry[]> {
  const allocations = await findAvailableAllocations(
    client,
    input.employeeId,
    input.timeOffTypeId,
    input.dateFrom,
    input.dateTo,
  );

  if (allocations.length === 0) {
    throw new AppError(
      'workflow_violation',
      `This employee has no approved ${input.typeName} allocation covering ` +
        `${input.dateFrom} to ${input.dateTo}. Grant an allocation for that period before approving.`,
    );
  }

  const { entries, shortfall } = planConsumption(allocations, input.amount);

  if (shortfall > 0) {
    const available = allocations.reduce((total, row) => total + row.remaining_amount, 0);
    throw new AppError(
      'workflow_violation',
      `Not enough ${input.typeName} balance: this request needs ${input.amount} but only ` +
        `${available.toFixed(2)} remains across valid allocations. Short by ${shortfall.toFixed(2)}.`,
    );
  }

  for (const entry of entries) {
    await client.query(
      `INSERT INTO time_off_consumptions (time_off_request_id, time_off_allocation_id, amount)
       VALUES ($1, $2, $3)`,
      [input.requestId, entry.allocation_id, entry.amount],
    );
  }

  return entries;
}

/** Releases everything a request consumed. Balance is derived, so this is enough. */
export async function releaseForRequest(
  client: TransactionClient,
  requestId: number,
): Promise<void> {
  await client.query('DELETE FROM time_off_consumptions WHERE time_off_request_id = $1', [
    requestId,
  ]);
}
