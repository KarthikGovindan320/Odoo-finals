/**
 * The arithmetic behind a payslip line, shown as the evaluator walked it.
 *
 * This is not a description of what the rule does. The server re-runs the rule
 * through the same evaluator that computed the payslip and records what every
 * node produced; what renders here is that recording. So the tree cannot say one
 * thing while the payslip says another -- if they disagreed, the number would be
 * the one that changed.
 *
 * The whole explanation for every line arrives in one request, on first expand.
 * Fetching per row would make an audit of eight lines eight round trips, and the
 * payload is small because it is arithmetic, not data.
 */
import { formatMoney } from '../lib/format.ts';

export type ExplainStep = {
  expression: string;
  label: string;
  value: number | boolean | null;
  kind: 'literal' | 'variable' | 'operation' | 'function' | 'choice' | 'unused';
  children: ExplainStep[];
};

export type ExplainedLine = {
  rule_code: string;
  rule_name: string;
  amount: number;
  recomputed: number | null;
  reproduces: boolean;
  headline: string;
  steps: ExplainStep | null;
};

export type PayslipExplanation = {
  payslip_id: number;
  context: { name: string; label: string; value: number }[];
  lines: ExplainedLine[];
  reproduces: boolean;
  unavailable: string | null;
};

/**
 * Values here are quantities as much as amounts -- 22 days, 0.94, 1800 rupees --
 * so they are not passed through the currency formatter. A day count reading
 * "₹22.00" would be worse than useless.
 */
function formatValue(value: number | boolean | null): string {
  if (value === null) return 'not used';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Number.isInteger(value)) return value.toLocaleString('en-IN');
  return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function Step({ step, depth }: { step: ExplainStep; depth: number }) {
  return (
    <>
      <li
        className={`xstep xstep--${step.kind}`}
        style={{ paddingInlineStart: 8 + depth * 16 }}
      >
        <code className="xstep__expr">{step.expression}</code>
        <span className="xstep__value">{formatValue(step.value)}</span>
        <span className="xstep__label">{step.label}</span>
      </li>
      {step.children.map((child, index) => (
        <Step key={`${depth}-${index}-${child.expression}`} step={child} depth={depth + 1} />
      ))}
    </>
  );
}

export function LineExplanation({
  line,
  currency,
}: {
  line: ExplainedLine;
  currency: string;
}) {
  return (
    <div className="xplain">
      {!line.reproduces && (
        <p className="xplain__drift" role="alert">
          This line no longer reproduces. It was paid as{' '}
          <strong>{formatMoney(line.amount, currency)}</strong>, but re-running the rule as it
          stands today gives{' '}
          <strong>{formatMoney(line.recomputed ?? 0, currency)}</strong>. The payslip is the
          record of what was paid; the rule has changed since.
        </p>
      )}

      {line.steps === null ? (
        <p className="xplain__note">{line.headline}</p>
      ) : (
        // No reading hint here. It was identical on every open line, and with
        // several lines open the instruction was longer than the arithmetic it
        // introduced. It is said once, under the table.
        <ul className="xstep-list">
          <Step step={line.steps} depth={0} />
        </ul>
      )}
    </div>
  );
}

/** The values every rule on this payslip was evaluated against. */
export function ExplanationContext({ context }: { context: PayslipExplanation['context'] }) {
  return (
    <div className="xcontext">
      {context.map((entry) => (
        <div key={entry.name} className="xcontext__item">
          <span className="xcontext__value">{formatValue(entry.value)}</span>
          <span className="xcontext__label">{entry.label}</span>
          <code className="xcontext__name">{entry.name}</code>
        </div>
      ))}
    </div>
  );
}
