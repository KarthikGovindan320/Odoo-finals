/**
 * Static checking for salary rule expressions.
 *
 * parse() answers "is this well-formed?". It does not answer "does this refer to
 * anything that exists?", because names are resolved by the evaluator against a
 * context that only exists during a payrun. So a rule reading `contract.wag` or
 * calling `sqrt(x)` parsed cleanly, saved cleanly, and failed at 2am — which is
 * precisely what the configuration screen claimed to prevent.
 *
 * This closes that gap for everything knowable without a payslip in hand:
 * variable names, function names and argument counts.
 *
 * What it deliberately cannot check is `rules.CODE` and `categories.CODE`. Which
 * rules precede this one is a property of the structure the rule is placed in,
 * not of the rule, and the same rule may sit at different positions in different
 * structures. Those are checked for shape here and resolved by the engine, which
 * already reports them with a message about ordering.
 */
import type { Node } from './parser.ts';
import { parse } from './parser.ts';
import { ExpressionSyntaxError } from './lexer.ts';
import { CONTEXT_VARIABLE_NAMES } from '../context_variables.ts';
import { FUNCTION_ARITY } from './functions.ts';

const KNOWN_VARIABLES = new Set<string>(CONTEXT_VARIABLE_NAMES);

/** Namespaces whose members are only knowable at computation time. */
const DEFERRED_PREFIXES = ['rules.', 'categories.'];

export type ExpressionProblem = { message: string; position: number };

function isDeferred(name: string): boolean {
  return DEFERRED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Suggests the closest known name, when one is close enough to be worth naming. */
function nearest(name: string): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;

  for (const candidate of KNOWN_VARIABLES) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  // Far enough away and the suggestion is noise rather than help.
  return best !== null && bestDistance <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (left[i - 1] === right[j - 1] ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }

  return previous[right.length] as number;
}

function walk(node: Node, problems: ExpressionProblem[]): void {
  switch (node.type) {
    case 'number':
    case 'boolean':
      return;

    case 'variable': {
      if (KNOWN_VARIABLES.has(node.name) || isDeferred(node.name)) {
        return;
      }
      const suggestion = nearest(node.name);
      problems.push({
        message:
          `Unknown variable '${node.name}'.` +
          (suggestion === null ? '' : ` Did you mean '${suggestion}'?`),
        position: node.position,
      });
      return;
    }

    case 'unary':
      walk(node.operand, problems);
      return;

    case 'binary':
      walk(node.left, problems);
      walk(node.right, problems);
      return;

    case 'conditional':
      walk(node.condition, problems);
      walk(node.whenTrue, problems);
      walk(node.whenFalse, problems);
      return;

    case 'call': {
      const arity = FUNCTION_ARITY[node.name];
      if (arity === undefined) {
        problems.push({
          message:
            `Unknown function '${node.name}'. Available: ` +
            `${Object.keys(FUNCTION_ARITY).sort().join(', ')}.`,
          position: node.position,
        });
      } else if (node.args.length < arity.min || node.args.length > arity.max) {
        const expected =
          arity.min === arity.max
            ? `exactly ${arity.min}`
            : `between ${arity.min} and ${arity.max}`;
        problems.push({
          message: `${node.name}() takes ${expected} argument(s) but was given ${node.args.length}.`,
          position: node.position,
        });
      }
      for (const argument of node.args) {
        walk(argument, problems);
      }
      return;
    }
  }
}

/**
 * Parses and statically checks an expression. Returns every problem found, so a
 * rule with two typos reports both rather than one per save.
 */
export function analyzeExpression(source: string): ExpressionProblem[] {
  let ast: Node;
  try {
    ast = parse(source);
  } catch (error) {
    if (error instanceof ExpressionSyntaxError) {
      return [{ message: error.message, position: error.position }];
    }
    throw error;
  }

  const problems: ExpressionProblem[] = [];
  walk(ast, problems);
  return problems;
}

export { KNOWN_VARIABLES };
