/**
 * Deterministic pseudo-randomness for seeding.
 *
 * Seeded rather than Math.random so that every teammate's database holds the
 * same 60 employees with the same contracts and the same attendance. A demo that
 * is reproducible is a demo that can be rehearsed, and a bug that reproduces on
 * someone else's machine is a bug that can be fixed.
 *
 * mulberry32: small, fast, well-distributed for this purpose. Not for anything
 * needing cryptographic randomness -- session tokens use node:crypto.
 */
export type Random = {
  next(): number;
  int(minimum: number, maximum: number): number;
  pick<Item>(items: readonly Item[]): Item;
  chance(probability: number): boolean;
  shuffle<Item>(items: readonly Item[]): Item[];
};

export function createRandom(seed: number): Random {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  const int = (minimum: number, maximum: number): number =>
    minimum + Math.floor(next() * (maximum - minimum + 1));

  return {
    next,
    int,
    pick: <Item,>(items: readonly Item[]): Item => items[int(0, items.length - 1)] as Item,
    chance: (probability: number): boolean => next() < probability,
    shuffle: <Item,>(items: readonly Item[]): Item[] => {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const target = int(0, index);
        [copy[index], copy[target]] = [copy[target] as Item, copy[index] as Item];
      }
      return copy;
    },
  };
}
