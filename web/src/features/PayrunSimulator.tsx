/**
 * Pricing a change to this payrun without making it.
 *
 * The levers are deliberately few, and every one of them names something the
 * rule engine can read. There is no "bonus" field, because a bonus has to be
 * spent through a salary rule and inventing one here would price a payroll that
 * does not exist -- that change belongs on the salary configuration screen,
 * where it would be a real rule with a real sequence position.
 *
 * The headline the screen exists to earn is the gap between what the engine
 * says and what multiplying the total by 1.07 says. Those differ whenever a rule
 * is not linear in the wage, which is most months: a capped provident fund stops
 * rising partway up a raise, so the raise costs slightly more than it looks. The
 * comparison is shown rather than described.
 */
import { useState } from 'react';

import { api, ApiError } from '../lib/api.ts';
import { formatMoney } from '../lib/format.ts';

type Totals = { employees: number; gross: number; net: number };

export type PayrunSimulation = {
  payrun: { id: number; name: string; period_start: string; period_end: string; state: string };
  scenario: Scenario;
  baseline: Totals;
  projected: Totals;
  net_delta: number;
  gross_delta: number;
  annualised_net_delta: number | null;
  by_department: {
    department_name: string | null;
    employees: number;
    baseline_net: number;
    projected_net: number;
    net_delta: number;
  }[];
  movers: {
    employee_id: number; employee_name: string; employee_number: string;
    baseline_net: number; projected_net: number; net_delta: number;
  }[];
  unmoved: number;
  skipped: { employee_name: string; reason: string }[];
  clamped: number;
  baseline_drift: { payslips: number; net: number };
};

type Scenario = {
  wage_change_percent: number;
  wage_change_amount: number;
  overtime_hours_delta: number;
  unpaid_leave_days_delta: number;
  paid_leave_days_delta: number;
  seniority_years_delta: number;
};

const NOTHING: Scenario = {
  wage_change_percent: 0,
  wage_change_amount: 0,
  overtime_hours_delta: 0,
  unpaid_leave_days_delta: 0,
  paid_leave_days_delta: 0,
  seniority_years_delta: 0,
};

const LEVERS: { key: keyof Scenario; label: string; unit: string; step: number }[] = [
  { key: 'wage_change_percent', label: 'Wage change', unit: '%', step: 0.5 },
  { key: 'wage_change_amount', label: 'Flat wage change', unit: '₹', step: 500 },
  { key: 'overtime_hours_delta', label: 'Overtime', unit: 'h', step: 1 },
  { key: 'unpaid_leave_days_delta', label: 'Unpaid leave', unit: 'd', step: 1 },
  { key: 'paid_leave_days_delta', label: 'Paid leave', unit: 'd', step: 1 },
  { key: 'seniority_years_delta', label: 'Service', unit: 'y', step: 1 },
];

const PRESETS: { label: string; scenario: Partial<Scenario> }[] = [
  { label: 'A 5% rise', scenario: { wage_change_percent: 5 } },
  { label: 'A 10% rise', scenario: { wage_change_percent: 10 } },
  { label: 'One more unpaid day each', scenario: { unpaid_leave_days_delta: 1 } },
  { label: 'Five more overtime hours each', scenario: { overtime_hours_delta: 5 } },
];

function signed(value: number, currency: string): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatMoney(Math.abs(value), currency)}`;
}

export function PayrunSimulator({ payrunId, currency }: { payrunId: number; currency: string }) {
  const [scenario, setScenario] = useState<Scenario>(NOTHING);
  const [result, setResult] = useState<PayrunSimulation | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const untouched = LEVERS.every((lever) => scenario[lever.key] === 0);

  const run = (next: Scenario): void => {
    setScenario(next);
    setRunning(true);
    setError(null);
    void api.post<PayrunSimulation>(`/payruns/${payrunId}/simulate`, next)
      .then(setResult)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError || caught instanceof Error
          ? caught.message
          : 'The simulation could not be run.'))
      .finally(() => setRunning(false));
  };

  return (
    <div className="sim">
      <p className="sim__intro">
        Every figure below is produced by running the salary rules, not by scaling a total. Nothing
        is saved, and this payrun is not touched.
      </p>

      <div className="sim__presets">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="btn btn--small"
            onClick={() => run({ ...NOTHING, ...preset.scenario })}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="sim__levers">
        {LEVERS.map((lever) => (
          <label key={lever.key} className="sim__lever">
            <span className="sim__lever-label">{lever.label}</span>
            <span className="sim__lever-input">
              <input
                className="input"
                type="number"
                step={lever.step}
                value={scenario[lever.key]}
                onChange={(event) =>
                  setScenario({ ...scenario, [lever.key]: Number(event.target.value) || 0 })}
              />
              <span className="sim__unit">{lever.unit}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="sim__actions">
        <button
          className="btn btn--primary"
          disabled={running || untouched}
          onClick={() => run(scenario)}
        >
          {running ? 'Running the rules…' : 'Price this scenario'}
        </button>
        <button
          className="btn"
          disabled={running}
          onClick={() => { setScenario(NOTHING); setResult(null); setError(null); }}
        >
          Reset
        </button>
        {untouched && result === null && (
          <span className="muted" style={{ fontSize: 12 }}>Move a lever, or pick one above.</span>
        )}
      </div>

      {error !== null && <div className="error-box" role="alert">{error}</div>}

      {result !== null && <SimulationResult result={result} currency={currency} />}
    </div>
  );
}

function SimulationResult({ result, currency }: { result: PayrunSimulation; currency: string }) {
  const percent = result.baseline.net === 0
    ? 0
    : (result.net_delta / result.baseline.net) * 100;

  /*
   * The comparison the whole feature is for. Shown only when a wage percentage
   * is the *only* lever pulled -- that is the one scenario a spreadsheet can
   * pretend to model, so it is the only one where "what the spreadsheet would
   * have said" is a fair thing to put on screen rather than a straw man.
   */
  const wageOnly = result.scenario.wage_change_percent !== 0
    && result.scenario.wage_change_amount === 0
    && result.scenario.overtime_hours_delta === 0
    && result.scenario.unpaid_leave_days_delta === 0
    && result.scenario.paid_leave_days_delta === 0
    && result.scenario.seniority_years_delta === 0;

  const naiveNet = result.baseline.net * (1 + result.scenario.wage_change_percent / 100);
  const gap = result.projected.net - naiveNet;

  return (
    <div className="sim__result">
      <div className="sim__headline">
        <div>
          <span className="sim__delta">{signed(result.net_delta, currency)}</span>
          <span className="sim__per">per period, across {result.baseline.employees} employees</span>
        </div>
        {result.annualised_net_delta !== null && (
          <div className="sim__annual">
            {signed(result.annualised_net_delta, currency)}
            <span className="sim__per">over twelve periods like this one</span>
          </div>
        )}
      </div>

      <dl className="sim__totals">
        <div><dt>Net now</dt><dd>{formatMoney(result.baseline.net, currency)}</dd></div>
        <div><dt>Net projected</dt><dd>{formatMoney(result.projected.net, currency)}</dd></div>
        <div><dt>Change</dt><dd>{percent.toFixed(3)}%</dd></div>
        <div><dt>Gross change</dt><dd>{signed(result.gross_delta, currency)}</dd></div>
      </dl>

      {wageOnly && Math.abs(gap) >= 1 && (
        <p className="sim__gap">
          Scaling the payroll total by {result.scenario.wage_change_percent}% would have said{' '}
          <strong>{formatMoney(naiveNet, currency)}</strong>. Running the rules gives{' '}
          <strong>{formatMoney(result.projected.net, currency)}</strong> — a difference of{' '}
          <strong>{signed(gap, currency)}</strong> per period
          {result.annualised_net_delta !== null
            && <>, {signed(gap * 12, currency)} over twelve</>}. Capped and conditional rules do not
          move in step with the wage, so the change is {percent.toFixed(3)}% and not exactly{' '}
          {result.scenario.wage_change_percent}%.
        </p>
      )}

      {result.unmoved > 0 && (
        <p className="sim__note">
          {result.unmoved} of {result.baseline.employees} employees are unaffected — their salary
          structure has no rule that reads what this scenario changed.
        </p>
      )}
      {result.clamped > 0 && (
        <p className="sim__note">
          {result.clamped} held at a limit: leave cannot exceed the days the schedule expected, so
          the figure for those employees is the most the period can absorb.
        </p>
      )}
      {result.baseline_drift.payslips > 0 && (
        <p className="sim__note sim__note--warn" role="alert">
          {result.baseline_drift.payslips} payslips no longer reproduce under today&apos;s rules,
          by {signed(result.baseline_drift.net, currency)} in total. The projection is priced
          against today&apos;s rules, so that difference is not part of the change above.
        </p>
      )}
      {result.skipped.length > 0 && (
        <p className="sim__note sim__note--warn">
          {result.skipped.length} could not be priced: {result.skipped[0]?.reason}
        </p>
      )}

      <h3 className="sim__subhead">Where it lands</h3>
      <table className="table table--compact">
        <thead>
          <tr>
            <th>Department</th>
            <th style={{ width: 70, textAlign: 'right' }}>People</th>
            <th style={{ width: 150, textAlign: 'right' }}>Net now</th>
            <th style={{ width: 150, textAlign: 'right' }}>Change</th>
          </tr>
        </thead>
        <tbody>
          {result.by_department.map((row) => (
            <tr key={row.department_name ?? 'none'}>
              <td>{row.department_name ?? 'No department'}</td>
              <td className="table__num">{row.employees}</td>
              <td className="table__num">{formatMoney(row.baseline_net, currency)}</td>
              <td className="table__num">{signed(row.net_delta, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {result.movers.length > 0 && (
        <>
          <h3 className="sim__subhead">Most affected</h3>
          <table className="table table--compact">
            <thead>
              <tr>
                <th>Employee</th>
                <th style={{ width: 150, textAlign: 'right' }}>Net now</th>
                <th style={{ width: 150, textAlign: 'right' }}>Projected</th>
                <th style={{ width: 130, textAlign: 'right' }}>Change</th>
              </tr>
            </thead>
            <tbody>
              {result.movers.map((mover) => (
                <tr key={mover.employee_id}>
                  <td>
                    {mover.employee_name}{' '}
                    <span className="mono muted">{mover.employee_number}</span>
                  </td>
                  <td className="table__num">{formatMoney(mover.baseline_net, currency)}</td>
                  <td className="table__num">{formatMoney(mover.projected_net, currency)}</td>
                  <td className="table__num">{signed(mover.net_delta, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
