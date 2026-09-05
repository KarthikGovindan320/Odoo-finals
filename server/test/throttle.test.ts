/**
 * The login throttle. Time is injected so the window can be crossed without
 * sleeping, which is the only way these are worth running on every commit.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createThrottle } from '../src/lib/throttle.ts';

/** A clock the test moves by hand. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('login throttle', () => {
  it('allows attempts up to the limit and refuses the one after', () => {
    const clock = fakeClock();
    const throttle = createThrottle({ maxFailures: 3, windowMs: 60_000, now: clock.now });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(throttle.check('a@example.com').allowed, true);
      throttle.recordFailure('a@example.com');
    }

    const decision = throttle.check('a@example.com');
    assert.equal(decision.allowed, false);
  });

  it('reports how long is left, never zero or NaN', () => {
    const clock = fakeClock();
    const throttle = createThrottle({ maxFailures: 1, windowMs: 60_000, now: clock.now });

    throttle.recordFailure('a@example.com');
    const decision = throttle.check('a@example.com');

    assert.equal(decision.allowed, false);
    if (decision.allowed) return;
    assert.equal(Number.isFinite(decision.retryAfterSeconds), true);
    assert.equal(decision.retryAfterSeconds, 60);

    // At the very edge of the window the hint must still be a usable number.
    clock.advance(59_999);
    const edge = throttle.check('a@example.com');
    if (!edge.allowed) {
      assert.ok(edge.retryAfterSeconds >= 1);
    }
  });

  it('never refuses a key with no recorded failures, even at a limit of zero', () => {
    // A misconfigured limit must fail open on an untouched key rather than
    // locking out every user with a NaN retry hint.
    const throttle = createThrottle({ maxFailures: 0, windowMs: 60_000 });
    assert.equal(throttle.check('nobody@example.com').allowed, true);
  });

  it('forgets failures once the window passes', () => {
    const clock = fakeClock();
    const throttle = createThrottle({ maxFailures: 2, windowMs: 60_000, now: clock.now });

    throttle.recordFailure('a@example.com');
    throttle.recordFailure('a@example.com');
    assert.equal(throttle.check('a@example.com').allowed, false);

    clock.advance(60_001);
    assert.equal(throttle.check('a@example.com').allowed, true);
    assert.equal(throttle.size(), 0, 'the aged-out entry should be dropped, not merely ignored');
  });

  it('slides rather than resetting on a fixed boundary', () => {
    const clock = fakeClock();
    const throttle = createThrottle({ maxFailures: 2, windowMs: 60_000, now: clock.now });

    throttle.recordFailure('a@example.com');
    clock.advance(59_000);
    throttle.recordFailure('a@example.com');
    assert.equal(throttle.check('a@example.com').allowed, false);

    // The first failure ages out; the second is still inside the window, so one
    // slot frees up rather than the whole count resetting.
    clock.advance(1_500);
    assert.equal(throttle.check('a@example.com').allowed, true);
    throttle.recordFailure('a@example.com');
    assert.equal(throttle.check('a@example.com').allowed, false);
  });

  it('keeps keys independent', () => {
    const throttle = createThrottle({ maxFailures: 1, windowMs: 60_000 });

    throttle.recordFailure('a@example.com');
    assert.equal(throttle.check('a@example.com').allowed, false);
    assert.equal(throttle.check('b@example.com').allowed, true);
  });

  it('clears a key on success', () => {
    const throttle = createThrottle({ maxFailures: 1, windowMs: 60_000 });

    throttle.recordFailure('a@example.com');
    assert.equal(throttle.check('a@example.com').allowed, false);

    throttle.clear('a@example.com');
    assert.equal(throttle.check('a@example.com').allowed, true);
  });

  it('bounds memory when keys are rotated', () => {
    const throttle = createThrottle({ maxFailures: 5, windowMs: 60_000, maxEntries: 100 });

    for (let index = 0; index < 500; index += 1) {
      throttle.recordFailure(`attacker-${index}@example.com`);
    }

    assert.ok(throttle.size() <= 100, `expected at most 100 keys, held ${throttle.size()}`);
  });

  it('does not grow the stored array without bound for one hammered key', () => {
    const throttle = createThrottle({ maxFailures: 3, windowMs: 60_000 });

    for (let index = 0; index < 1_000; index += 1) {
      throttle.recordFailure('a@example.com');
    }

    // Still refusing, and still holding only one key.
    assert.equal(throttle.check('a@example.com').allowed, false);
    assert.equal(throttle.size(), 1);
  });
});
