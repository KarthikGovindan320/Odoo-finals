/**
 * Tests for the pure half of leave consumption: how an amount is split across
 * allocations. The database half is exercised by the seed and the API.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planConsumption } from '../src/services/time_off/consumption.ts';
import type { AvailableAllocation } from '../src/services/time_off/consumption.ts';

const allocation = (id: number, validTo: string, remaining: number): AvailableAllocation => ({
  allocation_id: id,
  valid_from: '2026-01-01',
  valid_to: validTo,
  remaining_amount: remaining,
});

describe('planConsumption', () => {
  it('draws from a single allocation when it covers the request', () => {
    const { entries, shortfall } = planConsumption([allocation(1, '2026-12-31', 12)], 3);
    assert.equal(shortfall, 0);
    assert.deepEqual(entries, [{ allocation_id: 1, amount: 3 }]);
  });

  it('splits across allocations, exhausting the earliest-expiring first', () => {
    const { entries, shortfall } = planConsumption(
      [allocation(1, '2026-06-30', 2), allocation(2, '2026-12-31', 10)],
      5,
    );
    assert.equal(shortfall, 0);
    assert.deepEqual(entries, [
      { allocation_id: 1, amount: 2 },
      { allocation_id: 2, amount: 3 },
    ]);
  });

  it('reports a shortfall rather than over-drawing', () => {
    const { entries, shortfall } = planConsumption([allocation(1, '2026-12-31', 2)], 5);
    assert.equal(shortfall, 3);
    assert.deepEqual(entries, [{ allocation_id: 1, amount: 2 }]);
  });

  it('reports a shortfall when there is nothing to draw from', () => {
    const { entries, shortfall } = planConsumption([], 1);
    assert.equal(shortfall, 1);
    assert.deepEqual(entries, []);
  });

  it('ignores float noise below a hundredth of a day', () => {
    const { shortfall } = planConsumption([allocation(1, '2026-12-31', 0.1 + 0.2)], 0.3);
    assert.equal(shortfall, 0);
  });

  it('touches no more allocations than it needs', () => {
    const { entries } = planConsumption(
      [allocation(1, '2026-06-30', 10), allocation(2, '2026-12-31', 10)],
      4,
    );
    assert.equal(entries.length, 1);
  });
});
