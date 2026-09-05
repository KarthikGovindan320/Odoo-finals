/**
 * A sliding-window failure counter, used to make password guessing expensive.
 *
 * In process and in memory, deliberately. A shared store would be the right
 * answer across several instances, but it is also a dependency, a connection and
 * a failure mode -- and a limiter that is wrong only when the process restarts is
 * far better than the nothing it replaces. The shape below is the one to keep if
 * this ever moves to Redis: record, check, clear.
 *
 * Only failures are counted. Counting every attempt would let a user lock
 * themselves out by signing in normally, which turns a security control into a
 * support ticket.
 */
export type ThrottleDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

type Window = {
  /** Timestamps of failures still inside the window, oldest first. */
  failures: number[];
};

export type Throttle = {
  check(key: string): ThrottleDecision;
  recordFailure(key: string): void;
  clear(key: string): void;
  /** Test seam: the number of keys currently held. */
  size(): number;
};

/**
 * `maxEntries` bounds memory. An attacker rotating keys would otherwise grow the
 * map without limit, which turns a defence into a leak; past the cap the oldest
 * quarter is dropped, which costs a little accuracy and no memory.
 */
export function createThrottle(options: {
  maxFailures: number;
  windowMs: number;
  maxEntries?: number;
  now?: () => number;
}): Throttle {
  const { maxFailures, windowMs } = options;
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;
  const windows = new Map<string, Window>();

  /** Drops failures that have aged out. Returns what is left. */
  function live(key: string): number[] {
    const window = windows.get(key);
    if (window === undefined) {
      return [];
    }
    const cutoff = now() - windowMs;
    const remaining = window.failures.filter((at) => at > cutoff);

    if (remaining.length === 0) {
      windows.delete(key);
    } else {
      window.failures = remaining;
    }
    return remaining;
  }

  function evictOldest(): void {
    // Map iterates in insertion order, so the front is the least recently added.
    const excess = Math.ceil(maxEntries / 4);
    let dropped = 0;
    for (const key of windows.keys()) {
      windows.delete(key);
      dropped += 1;
      if (dropped >= excess) {
        break;
      }
    }
  }

  return {
    check(key) {
      const failures = live(key);
      const oldest = failures[0];

      // No recorded failure means nothing to hold against this key, whatever the
      // limit is set to. Reading failures[0] without this would hand back a NaN
      // retry hint the moment a misconfigured limit let an empty window refuse.
      if (oldest === undefined || failures.length < maxFailures) {
        return { allowed: true };
      }

      // The window clears when its oldest failure ages out.
      const retryAfterMs = Math.max(oldest + windowMs - now(), 0);
      return { allowed: false, retryAfterSeconds: Math.max(Math.ceil(retryAfterMs / 1000), 1) };
    },

    recordFailure(key) {
      const failures = live(key);
      if (!windows.has(key)) {
        if (windows.size >= maxEntries) {
          evictOldest();
        }
        windows.set(key, { failures: [] });
      }
      // Cap the stored array: past the limit the decision cannot change, and an
      // unbounded push is just memory spent to reach the same answer.
      const window = windows.get(key);
      if (window !== undefined && failures.length <= maxFailures) {
        window.failures.push(now());
      }
    },

    clear(key) {
      windows.delete(key);
    },

    size() {
      return windows.size;
    },
  };
}
