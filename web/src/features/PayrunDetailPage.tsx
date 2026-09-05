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
import { useBackTo } from '../lib/use_back_to.ts';
import { Badge, ConfirmDialog, PAYROLL_WORKFLOW, Panel, StatusBar, WarningDigest } from '../components/Chrome.tsx';
import { PayrunSimulator } from './PayrunSimulator.tsx';

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


/**
 * The four workflow actions, described in one place.
 *
 * `confirm` is present on the three that cannot be undone: validating freezes
 * the payslips at the database level, marking paid asserts money has moved, and
 * sending mails salary documents to everyone in the batch. Compute is repeatable
 * and needs no gate.
 */
type PayrunAction = {
  slug: string;
  label: string;
  busyLabel: string;
  describe: (result: Record<string, number>) => string;
  confirm?: {
    title: string;
    question: string;
    confirmLabel: string;
    detail: string;
  };
};

function payrunActions(payslipCount: number): Record<string, PayrunAction> {
  const people = `${payslipCount} payslip${payslipCount === 1 ? '' : 's'}`;

  return {
    compute: {
      slug: 'compute',
      label: 'Compute',
      busyLabel: 'Computing…',
      describe: (result) =>
        `Computed ${result.payslipsComputed} payslip(s), ${result.payslipsFailed} could not be ` +
        `computed, ${result.warnings} warning(s).`,
    },
    validate: {
      slug: 'validate',
      label: 'Validate',
      busyLabel: 'Validating…',
      describe: (result) => `Validated ${result.validated} payslip(s).`,
      confirm: {
        title: 'Validate this payrun?',
        question: `This finalises ${people} and cannot be undone.`,
        confirmLabel: 'Validate payrun',
        detail:
          'Once validated, the database refuses any change to the computed lines or amounts. ' +
          'Recomputing will no longer be possible.',
      },
    },
    'mark-paid': {
      slug: 'mark-paid',
      label: 'Mark paid',
      busyLabel: 'Saving…',
      describe: (result) => `Marked ${result.paid} payslip(s) paid.`,
      confirm: {
        title: 'Mark this payrun as paid?',
        question: `This records that ${people} have actually been paid.`,
        confirmLabel: 'Mark as paid',
        detail: 'Only do this once the transfer has been made. It cannot be reversed.',
      },
    },
    'send-payslips': {
      slug: 'send-payslips',
      label: 'Send payslips',
      busyLabel: 'Sending…',
      describe: (result) =>
        `Sent ${result.sent}, failed ${result.failed}, skipped ${result.skipped} already delivered` +
        ((result.no_email ?? 0) > 0 ? `, ${result.no_email} with no email address on file` : '') + '.',
      confirm: {
        title: 'Send payslips by email?',
        question: `This emails a payslip to every employee in this payrun (${people}).`,
        confirmLabel: 'Send payslips',
        detail:
          'Anyone who has already received theirs is skipped. Emails cannot be recalled once sent.',
      },
    },
  };
}

export function PayrunDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const backToList = useBackTo('/payroll');
  const { can } = useAuth();

  const { data, loading, error, reload } = useResource<PayrunDetail>(`/payruns/${id}`);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PayrunAction | null>(null);

  const run = async (action: PayrunAction): Promise<void> => {
    setBusy(action.slug);
    setActionError(null);
    setNotice(null);
    try {
      const result = await api.post<Record<string, number>>(`/payruns/${id}/${action.slug}`);
      setNotice(action.describe(result));
      reload();
    } catch (caught: unknown) {
      // These failures are usually the workflow doing its job -- blockers
      // outstanding, or a payrun that is already history -- so the server's own
      // sentence is what the user needs to read.
      setActionError(caught instanceof ApiError ? caught.message : 'The action could not be completed.');
    } finally {
      setBusy(null);
      setPendingAction(null);
    }
  };

  if (loading) return <div className="loading">Loading payrun…</div>;
  if (error !== null) return <div className="error-box">{error}</div>;
  if (data === null) return null;

  const actions = payrunActions(data.payslips.length);
  const blockers = data.warnings.filter((item) => item.severity === 'blocker');

  /** Runs immediately, or opens the confirmation first. */
  const start = (action: PayrunAction): void => {
    if (action.confirm === undefined) {
      void run(action);
    } else {
      setPendingAction(action);
    }
  };
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
            <button
              className="btn"
              disabled={
                busy !== null || data.state === 'validated' || data.state === 'paid'
                || data.state === 'cancelled'
              }
              onClick={() => start(actions.compute as PayrunAction)}
            >
              {busy === 'compute' ? actions.compute?.busyLabel : actions.compute?.label}
            </button>
          )}
          {can('payrun:validate') && (
            <>
              <button className="btn btn--primary"
                disabled={busy !== null || data.state !== 'computed'}
                onClick={() => start(actions.validate as PayrunAction)}>
                {busy === 'validate' ? actions.validate?.busyLabel : actions.validate?.label}
              </button>
              <button className="btn"
                disabled={busy !== null || data.state !== 'validated'}
                onClick={() => start(actions['mark-paid'] as PayrunAction)}>
                {busy === 'mark-paid' ? actions['mark-paid']?.busyLabel : actions['mark-paid']?.label}
              </button>
              <button className="btn"
                disabled={busy !== null || (data.state !== 'validated' && data.state !== 'paid')}
                onClick={() => start(actions['send-payslips'] as PayrunAction)}>
                {busy === 'send-payslips'
                  ? actions['send-payslips']?.busyLabel
                  : actions['send-payslips']?.label}
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
          <StatusBar steps={PAYROLL_WORKFLOW} current={data.state} />
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

      <Panel
        title={`Warnings (${data.warnings.length})`}
        actions={
          <span style={{ display: 'flex', gap: 'var(--space-2)' }}>
            {blockers.length > 0 && <Badge variant="danger">{blockers.length} blocking</Badge>}
            <Badge variant="warning">
              {data.warnings.filter((item) => item.severity === 'warning').length} warnings
            </Badge>
            <Badge variant="info">
              {data.warnings.filter((item) => item.severity === 'info').length} notes
            </Badge>
          </span>
        }
      >
        {blockers.length > 0 && (
          <div className="alert alert--blocker">
            <span className="alert__code">BLOCKED</span>
            <span>
              {blockers.length} blocking issue{blockers.length === 1 ? '' : 's'} must be resolved
              before this payrun can be validated.
            </span>
          </div>
        )}
        <WarningDigest
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

      <button className="btn" onClick={backToList}>← Back to payroll</button>

      {pendingAction?.confirm !== undefined && (
        <ConfirmDialog
          title={pendingAction.confirm.title}
          question={pendingAction.confirm.question}
          detail={pendingAction.confirm.detail}
          confirmLabel={pendingAction.confirm.confirmLabel}
          destructive
          busy={busy !== null}
          onConfirm={() => void run(pendingAction)}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </>
  );
}
