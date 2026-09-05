/**
 * Tokeniser for salary rule expressions.
 *
 * The language is deliberately tiny: numbers, dotted variable names, arithmetic,
 * comparison, boolean logic, a conditional, and a fixed set of functions. There
 * are no strings, no assignment, no member access at runtime, and no way to name
 * anything the evaluator has not been handed.
 */
export type TokenKind = 'number' | 'identifier' | 'operator' | 'punctuation' | 'end';

export type Token = {
  kind: TokenKind;
  value: string;
  position: number;
};

export class ExpressionSyntaxError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = 'ExpressionSyntaxError';
    this.position = position;
  }
}

/** Longest-first, so '<=' is never mistaken for '<' followed by '='. */
const OPERATORS = ['<=', '>=', '==', '!=', '+', '-', '*', '/', '%', '<', '>'];
const PUNCTUATION = ['(', ')', ',', '?', ':'];

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_.]/;
const DIGIT = /[0-9]/;

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index] as string;

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (DIGIT.test(character) || (character === '.' && DIGIT.test(source[index + 1] ?? ''))) {
      const start = index;
      let seenDecimalPoint = false;

      while (index < source.length) {
        const next = source[index] as string;
        if (DIGIT.test(next)) {
          index += 1;
        } else if (next === '.' && !seenDecimalPoint) {
          seenDecimalPoint = true;
          index += 1;
        } else {
          break;
        }
      }

      tokens.push({ kind: 'number', value: source.slice(start, index), position: start });
      continue;
    }

    if (IDENTIFIER_START.test(character)) {
      const start = index;
      while (index < source.length && IDENTIFIER_PART.test(source[index] as string)) {
        index += 1;
      }

      const value = source.slice(start, index);
      if (value.endsWith('.') || value.includes('..')) {
        throw new ExpressionSyntaxError(`Malformed variable name '${value}'.`, start);
      }

      tokens.push({ kind: 'identifier', value, position: start });
      continue;
    }

    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator !== undefined) {
      tokens.push({ kind: 'operator', value: operator, position: index });
      index += operator.length;
      continue;
    }

    if (PUNCTUATION.includes(character)) {
      tokens.push({ kind: 'punctuation', value: character, position: index });
      index += 1;
      continue;
    }

    throw new ExpressionSyntaxError(
      `Unexpected character '${character}' in expression.`,
      index,
    );
  }

  tokens.push({ kind: 'end', value: '', position: source.length });
  return tokens;
}
