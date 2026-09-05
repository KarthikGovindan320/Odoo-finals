/**
 * What changed since last month, and what moved it.
 *
 * The chart is a signed magnitude comparison of a handful of contributions, so
 * it is bars on a shared zero line rather than anything round: the reader's job
 * is to see which one is biggest and which way it points, and a bar answers both
 * at a glance. Colour carries polarity only -- gains and losses, the same two
 * hues the ledger already uses for net pay and deductions -- and never identity,
 * so no legend is needed and none is shown. Every bar is directly labelled with
 * its own figure, which is what makes the colour redundant rather than load
 * bearing.
 *
 * Bars are drawn from a shared scale set by the largest absolute contribution,
 * not by the net change. A month where a big gain and a big loss nearly cancel
 * has a tiny net and two long bars, and that is the honest picture of it.
 */
import { formatMoney } from '../lib/format.ts';

export type DeltaDriver = {
  name: string;
  label: string;
  previous: number;
  current: number;
  amount: number;
};

export type PayslipComparison = {
  current: PeriodSummary;
  previous: PeriodSummary | null;
  net_delta: number;
  gross_delta: number;
  changed_inputs: DeltaDriver[];
  net_from_inputs: number;
  net_from_rule_change: number;
  net_interaction: number;
  attribution: 'separable' | 'entangled';
  unavailable: string | null;
};

type PeriodSummary = {
  id: number;
  number: string;
  period_start: string;
  period_end: string;
  gross_amount: number;
  net_amount: number;
  state: string;
};

const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function monthOf(isoDate: string): string {
  return MONTH.format(new Date(`${isoDate}T00:00:00Z`));
}

function signedQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function PayslipComparison({
  comparison,
  currency,
  onOpenPrevious,
}: {
  comparison: PayslipComparison;
  currency: string;
  onOpenPrevious: (id: number) => void;
}) {
  const { previous, net_delta: netDelta } = comparison;

  if (previous === null) {
    return <p className="muted" style={{ fontSize: 12, margin: 0 }}>{comparison.unavailable}</p>;
  }

  const movers = comparison.changed_inputs.filter((driver) => driver.amount !== 0);
  const inert = comparison.changed_inputs.filter((driver) => driver.amount === 0);

  const rows: { key: string; label: string; detail: string | null; amount: number }[] = [
    ...movers.map((driver) => ({
      key: driver.name,
      label: driver.label,
      detail: `${signedQuantity(driver.previous)} → ${signedQuantity(driver.current)}`,
      amount: driver.amount,
    })),
    ...(comparison.net_from_rule_change !== 0
      ? [{
        key: '__rules',
        label: 'The salary rules themselves were edited',
        detail: 'since the previous payslip was produced',
        amount: comparison.net_from_rule_change,
      }]
      : []),
    ...(comparison.net_interaction !== 0 && comparison.attribution === 'separable'
      ? [{
        key: '__interaction',
        label: 'Combined effect',
        detail: 'no single input accounts for this on its own',
        amount: comparison.net_interaction,
      }]
      : []),
  ];

  const scale = Math.max(...rows.map((row) => Math.abs(row.amount)), 1);

  return (
    <div className="delta">
      <div className="delta__headline">
        <span className={`delta__amount delta__amount--${netDelta < 0 ? 'down' : 'up'}`}>
          {netDelta > 0 ? '+' : netDelta < 0 ? '−' : ''}
          {formatMoney(Math.abs(netDelta), currency)}
        </span>
        <span className="delta__against">
          against {monthOf(previous.period_start)} ·{' '}
          <button type="button" className="linklike" onClick={() => onOpenPrevious(previous.id)}>
            {previous.number}
          </button>
        </span>
      </div>

      {netDelta === 0 && rows.length === 0 ? (
        <p className="delta__note">Nothing that feeds this payslip moved since the last one.</p>
      ) : comparison.attribution === 'entangled' ? (
        <>
          <p className="delta__note">
            These inputs moved together, and far enough that pricing them separately would describe
            a period that never happened — putting one back on its own leaves the rest describing a
            different month. What changed:
          </p>
          <ul className="delta__plain">
            {comparison.changed_inputs.map((driver) => (
              <li key={driver.name}>
                {driver.label}{' '}
                <span className="mono">
                  {signedQuantity(driver.previous)} → {signedQuantity(driver.current)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <ul className="delta__bars">
          {rows.map((row) => {
            const width = (Math.abs(row.amount) / scale) * 50;
            const negative = row.amount < 0;

            return (
              <li key={row.key} className="delta__row">
                <span className="delta__label">
                  {row.label}
                  {row.detail !== null && <span className="delta__detail"> {row.detail}</span>}
                </span>
                <span className="delta__track" aria-hidden="true">
                  <span
                    className={`delta__bar delta__bar--${negative ? 'down' : 'up'}`}
                    style={negative
                      ? { right: '50%', width: `${width}%` }
                      : { left: '50%', width: `${width}%` }}
                  />
                </span>
                <span className={`delta__figure delta__figure--${negative ? 'down' : 'up'}`}>
                  {negative ? '−' : '+'}{formatMoney(Math.abs(row.amount), currency)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {inert.length > 0 && comparison.attribution === 'separable' && (
        <p className="delta__note">
          Moved without changing pay: {inert.map((driver) => driver.label.toLowerCase()).join(', ')}.
        </p>
      )}
    </div>
  );
}
