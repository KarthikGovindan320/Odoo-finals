/**
 * The payrun processing screen.
 *
 * A status bar across the top shows where the batch is, the four workflow actions
 * are gated by that state, and the warnings panel is what stands between a
 * computed payrun and a validated one: validation refuses while any blocker
 * remains, and says how many.
 */
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/use_resource.ts';
import { formatDate, formatMoney, humanize, stateVariant } from '../lib/format.ts';
import { useAuth } from '../lib/auth.tsx';
import { AlertList, Badge, Panel, StatusBar } from '../components/Chrome.tsx';

type PayrunDetail = {
  id: number; name: string; salary_structure_id: number;
  period_start: string; period_end: string; state: string;
  structure: { id: number; name: string; code: string } | null;
  payslips: Array<{
    id: number; number: string; employee_id: number; employee_name: string;
    employee_number: string; department_name: string | null; state: string;
    worked_days: number; scheduled_days: number; unpaid_leave_days: number;
    overtime_hours: number; gross_amount: number; net_amount: number;
    currency_code: string; contract_reference: string | null;
  }>;
  warnings: Array<{
    id: number; payslip_id: number | null; severity: string; code: string;
    message: string; payslip_number: string | null; employee_name: string | null;
  }>;
};

const WORKFLOW = ['draft', 'computed', 'validated', 'paid'];

export function PayrunDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();

  const { data, loading, error, reload } = useResource<PayrunDetail>(`/payruns/${id}`);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (action: string, describe: (result: never) => string): Promise<void> => {
    setBusy(action);
    setActionError(null);
    setNotice(null);
    try {
      const result = await api.post<never>(`/payruns/${id}/${action}`);
      setNotice(describe(result));
      reload();
    } catch (caught: unknown) {
      // These failures are usually the workflow doing its job -- blockers
      // outstanding, or a payrun that is already history -- so the server's own
      // sentence is what the user needs to read.
      setActionError(caught instanceof ApiError ? caught.message : 'The action could not be completed.');
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="loading">Loading payrun…</div>;
  if (error !== null) return <div className="error-box">{error}</div>;
  if (data === null) return null;

  const blockers = data.warnings.filter((item) => item.severity === 'blocker');
  const totalNet = data.payslips
    .filter((slip) => slip.state !== 'cancelled')
    .reduce((total, slip) => total + Number(slip.net_amount), 0);

  return (
    <>
      <div className="page__header">
        <div className="page__title">
          <h1>{data.name}</h1>
          <span className="page__subtitle">
            {formatDate(data.period_start)} → {formatDate(data.period_end)}
            {data.structure !== null && ` · ${data.structure.name}`}
          </span>
        </div>
        <div className="page__actions">
          {can('payrun:write') && (
            <button className="btn" disabled={busy !== null || data.state === 'validated' || data.state === 'paid'}
              onClick={() => void run('compute', (result: never) => {
                const summary = result as unknown as {
                  payslipsComputed: number; payslipsFailed: number; warnings: number;
                };
                return `Computed ${summary.payslipsComputed} payslip(s), ` +
                  `${summary.payslipsFailed} could not be computed, ${summary.warnings} warning(s).`;
              })}>
              {busy === 'compute' ? 'Computing…' : 'Compute'}
            </button>
          )}
          {can('payrun:validate') && (
            <>
              <button className="btn btn--primary"
                disabled={busy !== null || data.state !== 'computed'}
                onClick={() => void run('validate', (result: never) =>
                  `Validated ${(result as unknown as { validated: number }).validated} payslip(s).`)}>
                {busy === 'validate' ? 'Validating…' : 'Validate'}
              </button>
              <button className="btn"
                disabled={busy !== null || data.state !== 'validated'}
                onClick={() => void run('mark-paid', (result: never) =>
                  `Marked ${(result as unknown as { paid: number }).paid} payslip(s) paid.`)}>
                {busy === 'mark-paid' ? 'Saving…' : 'Mark paid'}
              </button>
              <button className="btn"
                disabled={busy !== null || (data.state !== 'validated' && data.state !== 'paid')}
                onClick={() => void run('send-payslips', (result: never) => {
                  const outcome = result as unknown as { sent: number; failed: number; skipped: number };
                  return `Sent ${outcome.sent}, failed ${outcome.failed}, ` +
                    `skipped ${outcome.skipped} already delivered.`;
                })}>
                {busy === 'send-payslips' ? 'Sending…' : 'Send payslips'}
              </button>
            </>
          )}
        </div>
      </div>

      {actionError !== null && <div className="error-box" role="alert">{actionError}</div>}
      {notice !== null && (
        <div className="alert alert--info"><span>{notice}</span></div>
      )}

      <Panel>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      flexWrap: 'wrap', gap: 'var(--space-3)' }}>
          <StatusBar steps={WORKFLOW} current={data.state} />
          <div style={{ display: 'flex', gap: 'var(--space-5)', fontSize: 13 }}>
            <span className="muted">
              Payslips <strong style={{ color: 'var(--text)' }}>{data.payslips.length}</strong>
            </span>
            <span className="muted">
              Total net <strong style={{ color: 'var(--text)' }}>{formatMoney(totalNet)}</strong>
            </span>
          </div>
        </div>

        {(data.state === 'validated' || data.state === 'paid') && (
          <p className="muted" style={{ fontSize: 13, marginTop: 'var(--space-3)', marginBottom: 0 }}>
            This payrun is finalized. Its payslips are historical records — the database will refuse
            any attempt to change their computed lines or amounts.
          </p>
        )}
      </Panel>

      <Panel title={`Warnings (${data.warnings.length})`}>
        {blockers.length > 0 && (
          <div className="alert alert--blocker">
            <span className="alert__code">BLOCKED</span>
            <span>
              {blockers.length} blocking issue{blockers.length === 1 ? '' : 's'} must be resolved
              before this payrun can be validated.
            </span>
          </div>
        )}
        <AlertList
          items={data.warnings.map((item) => ({
            severity: item.severity,
            code: item.code,
            message: item.message,
          }))}
        />
      </Panel>

      <Panel title="Payslips" flush>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Payslip</th><th>Employee</th><th>Department</th><th>Contract</th>
                <th className="table__num">Worked / scheduled</th>
                <th className="table__num">Unpaid days</th>
                <th className="table__num">Overtime</th>
                <th className="table__num">Gross</th>
                <th className="table__num">Net</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.payslips.map((slip) => (
                <tr key={slip.id} data-clickable=""
                  onClick={() => navigate(`/payroll/payslips/${slip.id}`)}>
                  <td className="mono">{slip.number}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{slip.employee_name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{slip.employee_number}</div>
                  </td>
                  <td>{slip.department_name ?? '—'}</td>
                  <td className="mono">{slip.contract_reference ?? '—'}</td>
                  <td className="table__num">
                    {Number(slip.worked_days)} / {Number(slip.scheduled_days)}
                  </td>
                  <td className="table__num">
                    {Number(slip.unpaid_leave_days) > 0
                      ? <Badge variant="warning">{Number(slip.unpaid_leave_days)}</Badge>
                      : '—'}
                  </td>
                  <td className="table__num">
                    {Number(slip.overtime_hours) > 0 ? `${Number(slip.overtime_hours)} h` : '—'}
                  </td>
                  <td className="table__num">{formatMoney(Number(slip.gross_amount), slip.currency_code)}</td>
                  <td className="table__num">
                    <strong>{formatMoney(Number(slip.net_amount), slip.currency_code)}</strong>
                  </td>
                  <td><Badge variant={stateVariant(slip.state)}>{humanize(slip.state)}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <button className="btn" onClick={() => navigate('/payroll')}>← Back to payroll</button>
    </>
  );
}
