/**
 * The built-in functions and how many arguments each takes.
 *
 * Split out so the static checker can validate a call without importing the
 * evaluator (and the evaluator's implementations). Arity lives here; behaviour
 * lives in evaluator.ts, and a test asserts the two agree.
 */
export type Arity = { min: number; max: number };

export const FUNCTION_ARITY: Record<string, Arity> = {
  if: { min: 3, max: 3 },
  min: { min: 2, max: 8 },
  max: { min: 2, max: 8 },
  abs: { min: 1, max: 1 },
  floor: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  round: { min: 1, max: 2 },
};
