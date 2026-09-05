/**
 * Pratt parser for salary rule expressions.
 *
 * Produces an AST. Nothing here evaluates, and nothing here touches a value --
 * parsing is a pure syntax phase, which is what lets us reject a hostile or
 * merely enormous expression before any computation happens.
 *
 * Two limits guard the evaluator: a node budget and a nesting depth. Both are
 * checked during parsing so a pathological input costs a bounded amount of work.
 */
import { ExpressionSyntaxError, tokenize } from './lexer.ts';
import type { Token } from './lexer.ts';

export type Node =
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'variable'; name: string; position: number }
  | { type: 'unary'; operator: '-' | 'not'; operand: Node }
  | { type: 'binary'; operator: BinaryOperator; left: Node; right: Node }
  | { type: 'conditional'; condition: Node; whenTrue: Node; whenFalse: Node }
  | { type: 'call'; name: string; args: Node[]; position: number };

export type BinaryOperator =
  | '+' | '-' | '*' | '/' | '%'
  | '<' | '<=' | '>' | '>=' | '==' | '!='
  | 'and' | 'or';

const MAX_NODES = 200;
const MAX_DEPTH = 32;

/** Higher binds tighter. Ternary and unary are handled structurally, not here. */
const BINARY_PRECEDENCE: Record<BinaryOperator, number> = {
  or: 1,
  and: 2,
  '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5,
};

const LITERAL_KEYWORDS: Record<string, boolean> = { true: true, false: false };

class Parser {
  private readonly tokens: Token[];
  private index = 0;
  private nodeCount = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  parse(): Node {
    const node = this.parseExpression(0, 0);
    const token = this.peek();

    if (token.kind !== 'end') {
      throw new ExpressionSyntaxError(
        `Unexpected '${token.value}' after a complete expression.`,
        token.position,
      );
    }

    return node;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private advance(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private expect(value: string): Token {
    const token = this.peek();
    if (token.value !== value) {
      throw new ExpressionSyntaxError(
        `Expected '${value}' but found ${token.kind === 'end' ? 'end of expression' : `'${token.value}'`}.`,
        token.position,
      );
    }
    return this.advance();
  }

  private countNode(): void {
    this.nodeCount += 1;
    if (this.nodeCount > MAX_NODES) {
      throw new ExpressionSyntaxError(
        `Expression is too complex: more than ${MAX_NODES} terms.`,
        this.peek().position,
      );
    }
  }

  private guardDepth(depth: number): void {
    if (depth > MAX_DEPTH) {
      throw new ExpressionSyntaxError(
        `Expression is nested more than ${MAX_DEPTH} levels deep.`,
        this.peek().position,
      );
    }
  }

  private parseExpression(minimumPrecedence: number, depth: number): Node {
    this.guardDepth(depth);
    let left = this.parseUnary(depth + 1);

    for (;;) {
      const token = this.peek();
      const operator = this.asBinaryOperator(token);

      if (operator === null) {
        break;
      }

      const precedence = BINARY_PRECEDENCE[operator];
      if (precedence < minimumPrecedence) {
        break;
      }

      this.advance();
      // Left-associative: the right operand binds only tighter operators.
      const right = this.parseExpression(precedence + 1, depth + 1);
      this.countNode();
      left = { type: 'binary', operator, left, right };
    }

    // The conditional sits below every binary operator and associates right.
    if (minimumPrecedence === 0 && this.peek().value === '?') {
      this.advance();
      const whenTrue = this.parseExpression(0, depth + 1);
      this.expect(':');
      const whenFalse = this.parseExpression(0, depth + 1);
      this.countNode();
      return { type: 'conditional', condition: left, whenTrue, whenFalse };
    }

    return left;
  }

  private asBinaryOperator(token: Token): BinaryOperator | null {
    if (token.kind === 'operator' && token.value in BINARY_PRECEDENCE) {
      return token.value as BinaryOperator;
    }
    if (token.kind === 'identifier' && (token.value === 'and' || token.value === 'or')) {
      return token.value;
    }
    return null;
  }

  private parseUnary(depth: number): Node {
    this.guardDepth(depth);
    const token = this.peek();

    if (token.kind === 'operator' && token.value === '-') {
      this.advance();
      this.countNode();
      return { type: 'unary', operator: '-', operand: this.parseUnary(depth + 1) };
    }

    if (token.kind === 'identifier' && token.value === 'not') {
      this.advance();
      this.countNode();
      return { type: 'unary', operator: 'not', operand: this.parseUnary(depth + 1) };
    }

    return this.parsePrimary(depth + 1);
  }

  private parsePrimary(depth: number): Node {
    this.guardDepth(depth);
    const token = this.advance();
    this.countNode();

    if (token.kind === 'number') {
      const value = Number(token.value);
      if (!Number.isFinite(value)) {
        throw new ExpressionSyntaxError(`'${token.value}' is not a valid number.`, token.position);
      }
      return { type: 'number', value };
    }

    if (token.value === '(') {
      const inner = this.parseExpression(0, depth + 1);
      this.expect(')');
      return inner;
    }

    if (token.kind === 'identifier') {
      if (token.value in LITERAL_KEYWORDS) {
        return { type: 'boolean', value: LITERAL_KEYWORDS[token.value] as boolean };
      }

      if (this.peek().value === '(') {
        this.advance();
        const args = this.parseArguments(depth + 1);
        return { type: 'call', name: token.value, args, position: token.position };
      }

      return { type: 'variable', name: token.value, position: token.position };
    }

    throw new ExpressionSyntaxError(
      token.kind === 'end'
        ? 'Expression ended unexpectedly.'
        : `Unexpected '${token.value}'.`,
      token.position,
    );
  }

  private parseArguments(depth: number): Node[] {
    const args: Node[] = [];

    if (this.peek().value === ')') {
      this.advance();
      return args;
    }

    for (;;) {
      args.push(this.parseExpression(0, depth));
      const next = this.advance();

      if (next.value === ')') {
        return args;
      }
      if (next.value !== ',') {
        throw new ExpressionSyntaxError(
          `Expected ',' or ')' in function arguments but found '${next.value}'.`,
          next.position,
        );
      }
    }
  }
}

export function parse(source: string): Node {
  if (source.trim() === '') {
    throw new ExpressionSyntaxError('Expression is empty.', 0);
  }
  return new Parser(source).parse();
}
