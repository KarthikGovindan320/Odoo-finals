/**
 * Evaluates a parsed salary rule expression.
 *
 * The security property this module exists to provide: a salary rule is text a
 * user typed into a configuration screen, and it must never become executable
 * JavaScript. There is no eval, no new Function, no vm, and no property access on
 * any host object.
 *
 * Variables resolve from a flat Map of dotted names to numbers. Not an object
 * graph -- a Map. There is no traversal to hijack, so 'constructor.constructor'
 * and '__proto__.x' are not dangerous constructs that must be blocked; they are
 * simply keys nobody put in the Map, and they fail as unknown variables like any
 * other typo.
 */
import { AppError } from '../../../errors/app_error.ts';
import { parse } from './parser.ts';
import type { Node } from './parser.ts';
import { ExpressionSyntaxError } from './lexer.ts';

export type ExpressionValue = number | boolean;
export type VariableBindings = ReadonlyMap<string, number>;

/**
 * What every node of an expression evaluated to, keyed by the node itself.
 *
 * This is how a payslip explains itself. The alternative -- a second walker that
 * re-derives the arithmetic for display -- is two implementations of the same
 * rule that can disagree, and the one on screen would be the one nobody tests.
 * Recording during the real evaluation makes the explanation a byproduct of the
 * number rather than a claim about it.
 *
 * Nodes never evaluated are simply absent, which is itself worth showing: a
 * branch of an if() that was not taken did not contribute, and saying so is more
 * honest than printing the value it would have had.
 *
 * Node objects are compared by identity. The AST cache below shares one tree
 * across every employee in a payrun, so a record must not outlive the single
 * evaluation it was passed to.
 */
export type EvaluationRecord = Map<Node, ExpressionValue>;

export class ExpressionEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionEvaluationError';
  }
}

type BuiltinFunction = {
  minArgs: number;
  maxArgs: number;
  apply: (args: number[]) => number;
};

const FUNCTIONS: Record<string, BuiltinFunction> = {
  min: { minArgs: 2, maxArgs: 8, apply: (args) => Math.min(...args) },
  max: { minArgs: 2, maxArgs: 8, apply: (args) => Math.max(...args) },
  abs: { minArgs: 1, maxArgs: 1, apply: ([value]) => Math.abs(value as number) },
  floor: { minArgs: 1, maxArgs: 1, apply: ([value]) => Math.floor(value as number) },
  ceil: { minArgs: 1, maxArgs: 1, apply: ([value]) => Math.ceil(value as number) },
  round: {
    minArgs: 1,
    maxArgs: 2,
    apply: ([value, places]) => {
      const factor = 10 ** Math.trunc(places ?? 0);
      return Math.round((value as number) * factor) / factor;
    },
  },
};

/** 'if' is handled separately from FUNCTIONS because its branches are lazy. */
const CONDITIONAL_FUNCTION = 'if';

function requireNumber(value: ExpressionValue, context: string): number {
  if (typeof value !== 'number') {
    throw new ExpressionEvaluationError(
      `${context} expects a number but received a true/false value.`,
    );
  }
  return value;
}

function requireBoolean(value: ExpressionValue, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ExpressionEvaluationError(
      `${context} expects a true/false value but received the number ${value}.`,
    );
  }
  return value;
}

function evaluateNode(
  node: Node,
  bindings: VariableBindings,
  record?: EvaluationRecord,
): ExpressionValue {
  const value = computeNode(node, bindings, record);
  record?.set(node, value);
  return value;
}

/** The evaluation itself. Recording is done by its caller, in one place. */
function computeNode(
  node: Node,
  bindings: VariableBindings,
  record?: EvaluationRecord,
): ExpressionValue {
  switch (node.type) {
    case 'number':
    case 'boolean':
      return node.value;

    case 'variable': {
      const value = bindings.get(node.name);
      if (value === undefined) {
        throw new ExpressionEvaluationError(
          `Unknown variable '${node.name}'. Rules may only reference the payslip context ` +
            'and results computed earlier in the sequence.',
        );
      }
      return value;
    }

    case 'unary': {
      const operand = evaluateNode(node.operand, bindings, record);
      if (node.operator === '-') {
        return -requireNumber(operand, "Negation ('-')");
      }
      return !requireBoolean(operand, "'not'");
    }

    case 'binary':
      return evaluateBinary(node, bindings, record);

    case 'conditional': {
      const condition = requireBoolean(
        evaluateNode(node.condition, bindings, record),
        'A conditional expression',
      );
      return evaluateNode(condition ? node.whenTrue : node.whenFalse, bindings, record);
    }

    case 'call':
      return evaluateCall(node, bindings, record);
  }
}

function evaluateBinary(
  node: Extract<Node, { type: 'binary' }>,
  bindings: VariableBindings,
  record?: EvaluationRecord,
): ExpressionValue {
  const { operator } = node;

  // Boolean operators short-circuit, so the right side may legitimately be
  // undefined-ish work we never want to do.
  if (operator === 'and' || operator === 'or') {
    const left = requireBoolean(evaluateNode(node.left, bindings, record), `'${operator}'`);
    if (operator === 'and' && !left) return false;
    if (operator === 'or' && left) return true;
    return requireBoolean(evaluateNode(node.right, bindings, record), `'${operator}'`);
  }

  const left = evaluateNode(node.left, bindings, record);
  const right = evaluateNode(node.right, bindings, record);

  if (operator === '==') return left === right;
  if (operator === '!=') return left !== right;

  const leftNumber = requireNumber(left, `The left side of '${operator}'`);
  const rightNumber = requireNumber(right, `The right side of '${operator}'`);

  switch (operator) {
    case '+': return leftNumber + rightNumber;
    case '-': return leftNumber - rightNumber;
    case '*': return leftNumber * rightNumber;
    case '/':
    case '%': {
      if (rightNumber === 0) {
        throw new ExpressionEvaluationError(
          `Division by zero. Guard the divisor, for example: worked.scheduled_days > 0 ? a / worked.scheduled_days : 0`,
        );
      }
      return operator === '/' ? leftNumber / rightNumber : leftNumber % rightNumber;
    }
    case '<': return leftNumber < rightNumber;
    case '<=': return leftNumber <= rightNumber;
    case '>': return leftNumber > rightNumber;
    case '>=': return leftNumber >= rightNumber;
  }
}

function evaluateCall(
  node: Extract<Node, { type: 'call' }>,
  bindings: VariableBindings,
  record?: EvaluationRecord,
): ExpressionValue {
  if (node.name === CONDITIONAL_FUNCTION) {
    if (node.args.length !== 3) {
      throw new ExpressionEvaluationError(
        `if() takes exactly 3 arguments (condition, then, else) but received ${node.args.length}.`,
      );
    }
    const condition = requireBoolean(
      evaluateNode(node.args[0] as Node, bindings, record),
      "The first argument of if()",
    );
    return evaluateNode(node.args[condition ? 1 : 2] as Node, bindings, record);
  }

  const builtin = FUNCTIONS[node.name];
  if (builtin === undefined) {
    throw new ExpressionEvaluationError(
      `Unknown function '${node.name}'. Available functions: ` +
        `${[CONDITIONAL_FUNCTION, ...Object.keys(FUNCTIONS)].sort().join(', ')}.`,
    );
  }

  if (node.args.length < builtin.minArgs || node.args.length > builtin.maxArgs) {
    const expected =
      builtin.minArgs === builtin.maxArgs
        ? `exactly ${builtin.minArgs}`
        : `between ${builtin.minArgs} and ${builtin.maxArgs}`;
    throw new ExpressionEvaluationError(
      `${node.name}() takes ${expected} arguments but received ${node.args.length}.`,
    );
  }

  const args = node.args.map((argument, position) =>
    requireNumber(
      evaluateNode(argument, bindings, record),
      `Argument ${position + 1} of ${node.name}()`,
    ),
  );

  const result = builtin.apply(args);
  if (!Number.isFinite(result)) {
    throw new ExpressionEvaluationError(`${node.name}() produced a value that is not a number.`);
  }
  return result;
}

/**
 * Parses and evaluates an expression, returning a number.
 *
 * `label` names the rule being computed so a configuration mistake points at the
 * rule that contains it rather than at the engine.
 */
export function evaluateNumericExpression(
  source: string,
  bindings: VariableBindings,
  label: string,
): number {
  const value = evaluateExpression(source, bindings, label);
  if (typeof value !== 'number') {
    throw new AppError(
      'rule_configuration_invalid',
      `${label} must produce an amount, but its expression produced a true/false value.`,
    );
  }
  return value;
}

/** Parses and evaluates an expression used as a condition, returning a boolean. */
export function evaluateConditionExpression(
  source: string,
  bindings: VariableBindings,
  label: string,
): boolean {
  const value = evaluateExpression(source, bindings, label);
  if (typeof value !== 'boolean') {
    throw new AppError(
      'rule_configuration_invalid',
      `The condition on ${label} must produce true or false, but it produced the number ${value}. ` +
        'Compare it to something, for example: worked.overtime_hours > 0',
    );
  }
  return value;
}

/**
 * Parsed expressions, keyed by source text.
 *
 * A payrun evaluates the same dozen formula strings once per employee per rule
 * -- six thousand parses for a 500-person run on a 12-rule structure, all of
 * them producing the identical tree. The AST is never mutated, so one parse per
 * distinct string is enough.
 *
 * Bounded because rule text is user-supplied: an unbounded map keyed on it is a
 * slow leak. The cap is far above any plausible rule count, and past it the
 * cache simply stops growing rather than evicting, since a payrun's working set
 * is small and stable.
 */
const AST_CACHE = new Map<string, Node>();
const AST_CACHE_LIMIT = 500;

function parseCached(source: string): Node {
  const cached = AST_CACHE.get(source);
  if (cached !== undefined) {
    return cached;
  }

  const ast = parse(source);
  if (AST_CACHE.size < AST_CACHE_LIMIT) {
    AST_CACHE.set(source, ast);
  }
  return ast;
}

/**
 * Evaluates an expression and hands back the tree and what each node produced.
 *
 * A separate entry point rather than an extra argument on the two existing ones,
 * so the payrun path -- which runs this thousands of times and wants none of it
 * -- allocates no Map and is not asked to pass undefined.
 */
export function evaluateWithTrace(
  source: string,
  bindings: VariableBindings,
  label: string,
): { value: ExpressionValue; ast: Node; record: EvaluationRecord } {
  const record: EvaluationRecord = new Map();
  const value = evaluateExpression(source, bindings, label, record);
  return { value, ast: parseCached(source), record };
}

function evaluateExpression(
  source: string,
  bindings: VariableBindings,
  label: string,
  record?: EvaluationRecord,
): ExpressionValue {
  let ast: Node;

  try {
    ast = parseCached(source);
  } catch (error) {
    if (error instanceof ExpressionSyntaxError) {
      throw new AppError(
        'rule_configuration_invalid',
        `${label} has an invalid expression at position ${error.position + 1}: ${error.message}`,
        { expression: source, position: error.position },
      );
    }
    throw error;
  }

  try {
    const value = evaluateNode(ast, bindings, record);
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ExpressionEvaluationError('The expression produced a value that is not a number.');
    }
    return value;
  } catch (error) {
    if (error instanceof ExpressionEvaluationError) {
      throw new AppError(
        'rule_configuration_invalid',
        `${label} could not be computed: ${error.message}`,
        { expression: source },
      );
    }
    throw error;
  }
}
