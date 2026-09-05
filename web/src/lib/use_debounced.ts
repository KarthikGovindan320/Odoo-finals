import { useEffect, useState } from 'react';

/**
 * A value that settles before anyone acts on it.
 *
 * Search boxes feed straight into the request path, and there was no debounce
 * anywhere: every keystroke issued a COUNT plus a paginated SELECT with four
 * leading-wildcard ILIKE predicates. Typing a five-letter name was five full
 * table scans, four of which nobody ever read.
 */
export function useDebounced<Value>(value: Value, delayMs = 300): Value {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
