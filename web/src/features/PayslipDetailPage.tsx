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

/** Keeps the badge in step with the ledger rail colour for each category. */
const CATEGORY_TONE: Record<string, string> = {
  BASIC: 'petrol',
  ALW: 'warning',
  GROSS: 'steel',
  DED: 'danger',
  NET: 'success',
};

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
        <table className="ledger">
          <thead>
            <tr>
              <th style={{ width: 96 }}>Code</th>
              <th>Rule</th>
              <th style={{ width: 108 }}>Category</th>
              <th style={{ width: 170, textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line) => {
              const isSubtotal = line.category_code === 'GROSS' || line.category_code === 'NET';
              const isDeduction = line.category_sign < 0;

              return (
                <tr
                  key={line.rule_code}
                  className={[
                    'ledger__row',
                    `ledger__row--${line.category_code}`,
                    isSubtotal ? 'ledger__row--subtotal' : '',
                  ].filter(Boolean).join(' ')}
                >
                  <td className="ledger__code">{line.rule_code}</td>
                  <td>{line.rule_name}</td>
                  <td>
                    <Badge variant={CATEGORY_TONE[line.category_code] ?? 'petrol'}>
                      {line.category_code}
                    </Badge>
                  </td>
                  <td className={`ledger__amount${isDeduction ? ' ledger__amount--negative' : ''}`}>
                    {isDeduction ? '\u2212 ' : ''}
                    {formatMoney(Number(line.amount), data.currency_code)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* The number the employee actually receives, given the weight it has
            on the paper document it stands in for. */}
        <div className="ledger__net">
          <span className="ledger__net-label">Net payable</span>
          <span className="ledger__net-value">
            {formatMoney(Number(data.net_amount), data.currency_code)}
          </span>
        </div>
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
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>
        {value === null || value === undefined || value === '' ? <span className="muted">—</span> : value}
      </dd>
    </div>
  );
}
