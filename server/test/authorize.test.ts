/**
 * Tests for the row-scoping half of authorisation.
 *
 * The route-level half (does this role hold the permission at all) is exercised
 * against the seeded permission matrix by the API. What is worth unit testing is
 * the part that decides WHICH ROWS a caller may see, because getting that wrong
 * is silent: the request succeeds and simply returns too much.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request } from 'express';

import { requireOwnEmployee, scopedEmployeeId } from '../src/middleware/authorize.ts';
import { AppError } from '../src/errors/app_error.ts';

function requestFor(scope: 'own' | 'all' | undefined, employeeId: number | null): Request {
  return {
    accessScope: scope,
    auth: scope === undefined ? undefined : { employeeId },
  } as unknown as Request;
}

describe('scopedEmployeeId', () => {
  it('returns null for a caller with full scope, so no row filter is applied', () => {
    assert.equal(scopedEmployeeId(requestFor('all', 7)), null);
  });

  it('returns the caller employee id for an own-scoped caller', () => {
    assert.equal(scopedEmployeeId(requestFor('own', 7)), 7);
  });

  it('refuses rather than returning null when an own-scoped user has no employee record', () => {
    // Returning null here would be the dangerous failure: it reads as "no filter"
    // and would show an unlinked user every employee in the company.
    assert.throws(
      () => scopedEmployeeId(requestFor('own', null)),
      (error: unknown) => error instanceof AppError && error.code === 'forbidden',
    );
  });
});

describe('requireOwnEmployee', () => {
  it('allows a full-scope caller to reach any employee', () => {
    assert.doesNotThrow(() => requireOwnEmployee(requestFor('all', 7), 999));
  });

  it('allows an own-scoped caller to reach themselves', () => {
    assert.doesNotThrow(() => requireOwnEmployee(requestFor('own', 7), 7));
  });

  it('blocks an own-scoped caller who edits the id in the URL', () => {
    assert.throws(
      () => requireOwnEmployee(requestFor('own', 7), 8),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.status, 403);
        assert.match(error.message, /only view your own records/);
        return true;
      },
    );
  });

  it('blocks an own-scoped caller with no employee record at all', () => {
    assert.throws(
      () => requireOwnEmployee(requestFor('own', null), 8),
      (error: unknown) => error instanceof AppError && error.code === 'forbidden',
    );
  });
});
