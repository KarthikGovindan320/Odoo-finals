/**
 * A single payslip, with its salary computation broken down rule by rule.
 *
 * Every line shows the expression that produced it. That is the snapshot taken
 * when the payslip was computed, not a lookup against today's configuration --
 * which is why a June payslip still explains itself in September even if the
 * rules have since changed.
 */
import { Fragment, useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { api, openPdf } from '../lib/api.ts';
import { useResource } from '../lib/use_resource.ts';
import { formatDate, formatMoney, humanize, stateVariant } from '../lib/format.ts';
import { Badge, DetailRow, PAYROLL_WORKFLOW, Panel, StatusBar } from '../components/Chrome.tsx';
import { ExplanationContext, LineExplanation } from './PayslipExplain.tsx';
import type { PayslipExplanation } from './PayslipExplain.tsx';


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
    category_sign: number; amount: number; source_expression: string;
  }>;
};

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
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [openingPdf, setOpeningPdf] = useState(false);

  /*
   * The explanation is fetched once, on the first expand, and kept. It is a
   * re-run of the whole payslip rather than of one line, so asking for it per
   * row would repeat the same work for every row opened -- and most people who
   * open one line open the next.
   */
  const [explanation, setExplanation] = useState<PayslipExplanation | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [openLines, setOpenLines] = useState<ReadonlySet<string>>(new Set());

  const toggleLine = useCallback((ruleCode: string) => {
    setOpenLines((open) => {
      const next = new Set(open);
      if (next.has(ruleCode)) next.delete(ruleCode);
      else next.add(ruleCode);
      return next;
    });

    setExplanation((current) => {
      if (current !== null) return current;
      setExplaining(true);
      void api.get<PayslipExplanation>(`/payslips/${id}/explain`)
        .then(setExplanation)
        .catch((caught: unknown) =>
          setExplainError(
            caught instanceof Error ? caught.message : 'Could not work out this calculation.',
          ))
        .finally(() => setExplaining(false));
      return current;
    });
  }, [id]);

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
          {/* Fetched through the api client rather than linked directly, so a
              403 or a 500 becomes a message instead of a tab full of raw JSON,
              and the URL is not assumed to be same-origin. */}
          <button
            className="btn btn--primary"
            disabled={openingPdf}
            onClick={() => {
              setOpeningPdf(true);
              setPdfError(null);
              void openPdf(`/payslips/${data.id}/pdf`)
                .catch((caught: unknown) =>
                  setPdfError(
                    caught instanceof Error ? caught.message : 'Could not open the payslip PDF.',
                  ))
                .finally(() => setOpeningPdf(false));
            }}
          >
            {openingPdf ? 'Preparing…' : 'Print payslip (PDF)'}
          </button>
        </div>
      </div>

      {pdfError !== null && <div className="error-box" role="alert">{pdfError}</div>}

      <Panel>
        <StatusBar steps={PAYROLL_WORKFLOW} current={data.state} />
      </Panel>

      <div className="grid-2">
        <Panel title="Identification">
          <dl style={{ margin: 0 }}>
            <DetailRow label="Employee" value={`${data.employee_name} (${data.employee_number})`} />
            <DetailRow label="Department" value={data.department_name} />
            <DetailRow label="Position" value={data.job_title} />
            <DetailRow label="Contract" value={data.contract_reference} />
            <DetailRow label="Salary structure" value={data.structure_name} />
            <DetailRow label="Payrun" value={data.payrun_name} />
            <DetailRow label="Status" value={<Badge variant={stateVariant(data.state)}>{humanize(data.state)}</Badge>} />
            <DetailRow
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
            <DetailRow label="Scheduled days" value={String(Number(data.scheduled_days))} />
            <DetailRow label="Worked days" value={String(Number(data.worked_days))} />
            <DetailRow label="Worked hours" value={`${Number(data.worked_hours)} h`} />
            <DetailRow label="Paid leave days" value={String(Number(data.paid_leave_days))} />
            <DetailRow
              label="Unpaid leave days"
              value={
                Number(data.unpaid_leave_days) > 0
                  ? <Badge variant="warning">{Number(data.unpaid_leave_days)} — reduces pay</Badge>
                  : '0'
              }
            />
            <DetailRow label="Overtime hours" value={`${Number(data.overtime_hours)} h`} />
            <DetailRow
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

              const open = openLines.has(line.rule_code);
              const explained = explanation?.lines.find((row) => row.rule_code === line.rule_code);

              return (
                <Fragment key={line.rule_code}>
                <tr
                  className={[
                    'ledger__row',
                    `ledger__row--${line.category_code}`,
                    isSubtotal ? 'ledger__row--subtotal' : '',
                  ].filter(Boolean).join(' ')}
                >
                  <td className="ledger__code">{line.rule_code}</td>
                  <td>
                    {/* The rule name is the disclosure control. Every line can
                        be taken apart, so a separate "explain" affordance per
                        row would be a second column of identical buttons. */}
                    <button
                      type="button"
                      className="ledger__disclose"
                      aria-expanded={openLines.has(line.rule_code)}
                      onClick={() => toggleLine(line.rule_code)}
                    >
                      <span className="ledger__caret" aria-hidden="true">
                        {openLines.has(line.rule_code) ? '\u25be' : '\u25b8'}
                      </span>
                      {line.rule_name}
                    </button>
                    {/* The expression actually evaluated, snapshotted when this
                        payslip was computed. It was stored and selected all
                        along but never rendered, which left the page's own
                        promise -- that every line explains itself -- unkept. */}
                    {line.source_expression !== '' && (
                      <div className="ledger__source mono">{line.source_expression}</div>
                    )}
                  </td>
                  <td>
                    <Badge variant={CATEGORY_TONE[line.category_code] ?? 'petrol'}>
                      {line.category_code}
                    </Badge>
                  </td>
                  <td className={`ledger__amount${isDeduction ? ' ledger__amount--negative' : ''}`}>
                    {isDeduction ? '\u2212 ' : ''}
                    {formatMoney(Number(line.amount), data.currency_code)}
                    {explained !== undefined && !explained.reproduces && (
                      <span className="ledger__drift" title="This line no longer reproduces">
                        does not reproduce
                      </span>
                    )}
                  </td>
                </tr>

                {open && (
                  <tr className="ledger__row ledger__row--explain">
                    <td colSpan={4}>
                      {explaining && explained === undefined && (
                        <p className="xplain__note">Re-running this rule…</p>
                      )}
                      {explainError !== null && (
                        <p className="error-box" role="alert">{explainError}</p>
                      )}
                      {explained !== undefined && (
                        <LineExplanation line={explained} currency={data.currency_code} />
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
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
        not change this document. Select any line to see the arithmetic behind it: each row is one
        step the engine took, indented innermost-first, with the value that step produced beside it.
      </p>

      {/* Only after someone has asked. Until then this is a claim nobody made. */}
      {explanation !== null && (
        <Panel title="Recomputation check">
          {explanation.reproduces ? (
            <p className="xplain__verdict xplain__verdict--ok">
              Every line was re-run through the same engine that produced this payslip, against the
              worked time recorded on it, and all {explanation.lines.length} reproduce to the paisa.
            </p>
          ) : (
            <p className="xplain__verdict xplain__verdict--drift" role="alert">
              {explanation.lines.filter((line) => !line.reproduces).length} of{' '}
              {explanation.lines.length} lines no longer reproduce. The payslip records what was
              paid; the rules behind it have changed since. Open those lines to see where.
            </p>
          )}
          {explanation.unavailable !== null && (
            <p className="xplain__note">{explanation.unavailable}</p>
          )}

          <h3 className="xcontext__title">What the rules were evaluated against</h3>
          <ExplanationContext context={explanation.context} />
        </Panel>
      )}

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
