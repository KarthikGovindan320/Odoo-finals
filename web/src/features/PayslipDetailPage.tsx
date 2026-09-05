/**
 * A single payslip, with its salary computation broken down rule by rule.
 *
 * Every line shows the expression that produced it. That is the snapshot taken
 * when the payslip was computed, not a lookup against today's configuration --
 * which is why a June payslip still explains itself in September even if the
 * rules have since changed.
 */
import { useNavigate, useParams } from 'react-router';

import { useResource } from '../lib/use_resource.ts';
import { formatDate, formatMoney, humanize, stateVariant } from '../lib/format.ts';
import { Badge, Panel, StatusBar } from '../components/Chrome.tsx';

type PayslipDetail = {
  id: number; number: string; payrun_id: number; payrun_name: string; payrun_state: string;
  employee_id: number; employee_name: string; employee_number: string;
  department_name: string | null; job_title: string | null;
  contract_reference: string | null; structure_name: string;
  period_start: string; period_end: string; state: string; currency_code: string;
  scheduled_days: number; worked_days: number; worked_hours: number;
  paid_leave_days: number; unpaid_leave_days: number; overtime_hours: number;
  proration_factor: number; gross_amount: number; net_amount: number;
  bank_name: string | null; bank_account_number: string | null;
  lines: Array<{
    rule_code: string; rule_name: string; category_code: string;
    category_sign: number; amount: number;
  }>;
};

const WORKFLOW = ['draft', 'computed', 'validated', 'paid'];

export function PayslipDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, loading, error } = useResource<PayslipDetail>(`/payslips/${id}`);

  if (loading) return <div className="loading">Loading payslip…</div>;
  if (error !== null) return <div className="error-box">{error}</div>;
  if (data === null) return null;

  return (
    <>
      <div className="page__header">
        <div className="page__title">
          <h1>{data.employee_name}</h1>
          <span className="page__subtitle">
            <span className="mono">{data.number}</span> · {formatDate(data.period_start)} →{' '}
            {formatDate(data.period_end)} · {data.structure_name}
          </span>
        </div>
        <div className="page__actions">
          <a className="btn btn--primary" href={`/api/v1/payslips/${data.id}/pdf`}
            target="_blank" rel="noreferrer">
            Print payslip (PDF)
          </a>
        </div>
      </div>

      <Panel>
        <StatusBar steps={WORKFLOW} current={data.state} />
      </Panel>

      <div className="grid-2">
        <Panel title="Identification">
          <dl style={{ margin: 0 }}>
            <Row label="Employee" value={`${data.employee_name} (${data.employee_number})`} />
            <Row label="Department" value={data.department_name} />
            <Row label="Position" value={data.job_title} />
            <Row label="Contract" value={data.contract_reference} />
            <Row label="Salary structure" value={data.structure_name} />
            <Row label="Payrun" value={data.payrun_name} />
            <Row label="Status" value={<Badge variant={stateVariant(data.state)}>{humanize(data.state)}</Badge>} />
            <Row
              label="Bank"
              value={
                data.bank_account_number === null
                  ? <Badge variant="warning">Missing bank details</Badge>
                  : `${data.bank_name ?? ''} ····${data.bank_account_number.slice(-4)}`
              }
            />
          </dl>
        </Panel>

        <Panel title="Worked time">
          <dl style={{ margin: 0 }}>
            <Row label="Scheduled days" value={String(Number(data.scheduled_days))} />
            <Row label="Worked days" value={String(Number(data.worked_days))} />
            <Row label="Worked hours" value={`${Number(data.worked_hours)} h`} />
            <Row label="Paid leave days" value={String(Number(data.paid_leave_days))} />
            <Row
              label="Unpaid leave days"
              value={
                Number(data.unpaid_leave_days) > 0
                  ? <Badge variant="warning">{Number(data.unpaid_leave_days)} — reduces pay</Badge>
                  : '0'
              }
            />
            <Row label="Overtime hours" value={`${Number(data.overtime_hours)} h`} />
            <Row
              label="Proration"
              value={
                Number(data.proration_factor) < 1
                  ? `${Math.round(Number(data.proration_factor) * 100)}% — contract covers part of the period`
                  : 'Full period'
              }
            />
          </dl>
        </Panel>
      </div>

      <Panel title="Salary computation" flush>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 90 }}>Code</th>
              <th>Rule</th>
              <th style={{ width: 110 }}>Category</th>
              <th className="table__num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line) => {
              const isTotal = line.category_code === 'GROSS' || line.category_code === 'NET';
              return (
                <tr key={line.rule_code}
                  style={isTotal ? { background: 'var(--gray-100)', fontWeight: 600 } : undefined}>
                  <td className="mono">{line.rule_code}</td>
                  <td>{line.rule_name}</td>
                  <td><Badge variant={line.category_sign < 0 ? 'danger' : 'plum'}>{line.category_code}</Badge></td>
                  <td className="table__num"
                    style={line.category_sign < 0 ? { color: 'var(--danger)' } : undefined}>
                    {line.category_sign < 0 ? '− ' : ''}
                    {formatMoney(Number(line.amount), data.currency_code)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ background: 'var(--teal-light)' }}>
              <td colSpan={3} style={{ fontWeight: 700 }}>Net payable</td>
              <td className="table__num" style={{ fontWeight: 700, fontSize: 15 }}>
                {formatMoney(Number(data.net_amount), data.currency_code)}
              </td>
            </tr>
          </tfoot>
        </table>
      </Panel>

      <p className="muted" style={{ fontSize: 12 }}>
        These lines are a snapshot taken when the payslip was computed. Editing a salary rule now will
        not change this document.
      </p>

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={() => navigate(`/payroll/payruns/${data.payrun_id}`)}>
          ← Back to {data.payrun_name}
        </button>
        <button className="btn" onClick={() => navigate(`/employees/${data.employee_id}`)}>
          View employee
        </button>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-3)', padding: '5px 0',
                  borderBottom: '1px solid var(--border-subtle)' }}>
      <dt className="muted" style={{ width: 150, flex: '0 0 150px', fontSize: 13 }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: 13 }}>
        {value === null || value === undefined || value === '' ? <span className="muted">—</span> : value}
      </dd>
    </div>
  );
}
