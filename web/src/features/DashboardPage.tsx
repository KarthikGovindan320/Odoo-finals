/**
 * The payroll dashboard.
 *
 * Every figure here is an aggregate the server computed over live rows. Change
 * the filters and the numbers change because the query changes -- there is no
 * client-side fixture to fall back on, which is the spec's explicit requirement.
 */
import { useState } from 'react';
import { Link } from 'react-router';

import { queryString } from '../lib/api.ts';
import { useResource } from '../lib/use_resource.ts';
import { useReference } from '../lib/use_reference.ts';
import {
  formatDate, formatMoney, formatMoneyShort, formatMoneyWhole, formatNumber,
} from '../lib/format.ts';
import { AlertList, Badge, Panel } from '../components/Chrome.tsx';
import { BarChart, LineChart } from '../components/Charts.tsx';

type Dashboard = {
  filters: { period_start: string; period_end: string };
  kpis: {
    total_net: number; total_gross: number; payslip_count: number;
    average_net: number; employees_paid: number; headcount: number;
    active_headcount: number; attendance_health: number | null;
  };
  salary_cost_by_department: Array<{ department_name: string; employee_count: number; total_net: number }>;
  monthly_net_trend: Array<{ month: string; payslip_count: number; total_net: number }>;
  contract_expiry: {
    overdue: number;
    within_30: number;
    within_90: number;
    soonest: string | null;
  } | null;
  payrun_alerts: Array<{
    payrun_id: number; name: string; state: string;
    period_start: string; period_end: string; blockers: number; warnings: number;
  }>;
  attendance_overview: {
    records: number; present: number; late: number; overtime: number;
    early_leave: number; missing_checkout: number; manual_edits: number; total_hours: number;
  } | null;
  time_off_overview: {
    approved_requests: number; pending_requests: number;
    approved_days: number; unpaid_days: number;
  } | null;
  warnings: Array<{ severity: string; code: string; message: string; payrun_name: string }>;
};

type Reference = {
  departments: Array<{ id: number; name: string }>;
  employment_types: Array<{ id: number; name: string }>;
};

const today = new Date().toISOString().slice(0, 10);
const oneYearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);

export function DashboardPage() {
  const [periodStart, setPeriodStart] = useState(oneYearAgo);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [departmentId, setDepartmentId] = useState('');
  const [employmentTypeId, setEmploymentTypeId] = useState('');

  const reference = useReference();
  const path = `/dashboard${queryString({
    period_start: periodStart,
    period_end: periodEnd,
    department_id: departmentId,
    employment_type_id: employmentTypeId,
  })}`;
  const { data, loading, error } = useResource<Dashboard>(path);

  return (
    <>
      <div className="page__header">
        <div className="page__title">
          <h1>Payroll Dashboard</h1>
          <span className="page__subtitle">
            Live aggregates across employees, contracts, attendance, time off and payroll
          </span>
        </div>
      </div>

      <div className="panel">
        <div className="toolbar">
          <label className="filter">
            <span>Period</span>
            <input className="input" type="date" value={periodStart}
              onChange={(event) => setPeriodStart(event.target.value)} aria-label="Period from" />
          </label>
          <span className="muted">→</span>
          <label className="filter">
            <input className="input" type="date" value={periodEnd}
              onChange={(event) => setPeriodEnd(event.target.value)} aria-label="Period to" />
          </label>
          <label className="filter">
            <span>Department</span>
            <select className="select" value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}>
              <option value="">All departments</option>
              {reference.data?.departments.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <label className="filter">
            <span>Employee type</span>
            <select className="select" value={employmentTypeId}
              onChange={(event) => setEmploymentTypeId(event.target.value)}>
              <option value="">All types</option>
              {reference.data?.employment_types.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <span className="toolbar__spacer" />
          <span className="toolbar__count">Every figure below is a live aggregate</span>
        </div>
      </div>

      {error !== null && <div className="error-box">{error}</div>}
      {loading && <div className="loading">Loading dashboard…</div>}

      {data !== null && (
        <>
          <div className="kpi-row">
            <Kpi tone="green" label="Total net paid" value={formatMoneyWhole(data.kpis.total_net)}
              hint={`${formatNumber(data.kpis.employees_paid)} employees paid`} />
            <Kpi tone="petrol" label="Payslips generated" value={formatNumber(data.kpis.payslip_count)}
              hint={`Gross ${formatMoneyShort(data.kpis.total_gross)}`} />
            <Kpi tone="steel" label="Average net salary" value={formatMoneyWhole(data.kpis.average_net)}
              hint="Per payslip in this period" />
            <Kpi tone="ochre" label="Approved time off" value={`${formatNumber(data.time_off_overview?.approved_days ?? 0)} days`.replace(/\s+/g, " ")}
              hint={`${formatNumber(data.time_off_overview?.pending_requests ?? 0)} still pending`} />
            <Kpi tone="accent" label="Attendance health"
              value={data.kpis.attendance_health === null ? '—' : `${data.kpis.attendance_health}%`}
              hint="Records with no late arrival or missing check-out" />
            <Kpi tone="brick" label="Headcount" value={formatNumber(data.kpis.headcount)}
              hint={`${formatNumber(data.kpis.active_headcount)} active`} />
          </div>

          <div className="grid-2">
            <Panel title="Salary cost by department">
              <BarChart
                data={data.salary_cost_by_department.map((row) => ({
                  label: row.department_name, value: Number(row.total_net),
                }))}
              />
            </Panel>

            <Panel title="Monthly net salary trend">
              <LineChart
                data={data.monthly_net_trend.map((row) => ({
                  label: row.month, value: Number(row.total_net),
                }))}
              />
            </Panel>
          </div>

          <div className="grid-2">
            <Panel title="Attendance overview">
              {data.attendance_overview === null || data.attendance_overview.records === 0 ? (
                <p className="muted">No attendance recorded in this period.</p>
              ) : (
                <div className="stat-list">
                  <StatRow label="Records" value={formatNumber(data.attendance_overview.records)} />
                  <StatRow label="Present" value={formatNumber(data.attendance_overview.present)} />
                  <StatRow label="Late arrivals" value={formatNumber(data.attendance_overview.late)} />
                  <StatRow label="Overtime days" value={formatNumber(data.attendance_overview.overtime)} />
                  <StatRow label="Left early" value={formatNumber(data.attendance_overview.early_leave)} />
                  <StatRow label="Missing check-outs" value={formatNumber(data.attendance_overview.missing_checkout)} />
                  <StatRow label="Manual corrections" value={formatNumber(data.attendance_overview.manual_edits)} />
                  <StatRow label="Total hours worked" value={formatNumber(data.attendance_overview.total_hours, 1)} />
                </div>
              )}
            </Panel>

            <Panel title="Department breakdown">
              <table className="table">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th className="table__num">Employees paid</th>
                    <th className="table__num">Total net</th>
                  </tr>
                </thead>
                <tbody>
                  {data.salary_cost_by_department.map((row) => (
                    <tr key={row.department_name}>
                      <td>{row.department_name}</td>
                      <td className="table__num">{formatNumber(row.employee_count)}</td>
                      <td className="table__num">{formatMoney(Number(row.total_net))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>

          <Panel title="Payrun status">
            {data.payrun_alerts.length === 0 ? (
              <p className="muted">No payruns in this period.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Payrun</th><th>Period</th><th>Status</th>
                    <th className="table__num">Blockers</th><th className="table__num">Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {data.payrun_alerts.map((row) => (
                    <tr key={row.payrun_id}>
                      <td>{row.name}</td>
                      <td className="muted">{row.period_start} → {row.period_end}</td>
                      <td><Badge variant={row.state === 'paid' ? 'success' : row.state === 'validated' ? 'info' : 'warning'}>{row.state}</Badge></td>
                      <td className="table__num">{row.blockers > 0 ? <Badge variant="danger">{row.blockers}</Badge> : '—'}</td>
                      <td className="table__num">{row.warnings > 0 ? row.warnings : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Operational alerts">
            <AlertList items={data.warnings} />
          </Panel>

          {/* Not filtered by the dashboard's period, unlike everything above it.
              A contract ending in three weeks is equally urgent whether you are
              looking at last month's payroll or next year's, and a warning that
              disappears when you change the date range is one nobody can rely
              on. Hidden entirely when there is nothing to say -- an empty alert
              panel teaches people to ignore the alert panel. */}
          {data.contract_expiry !== null
            && data.contract_expiry.within_90 + data.contract_expiry.overdue > 0 && (
            <Panel title="Contracts running out">
              <div className="expiry">
                {data.contract_expiry.overdue > 0 && (
                  <Link className="expiry__band expiry__band--overdue" to="/contracts?expiring=0">
                    <span className="expiry__count">{data.contract_expiry.overdue}</span>
                    <span className="expiry__label">
                      already ended, still running
                    </span>
                  </Link>
                )}
                {data.contract_expiry.within_30 > 0 && (
                  <Link className="expiry__band expiry__band--soon" to="/contracts?expiring=30">
                    <span className="expiry__count">{data.contract_expiry.within_30}</span>
                    <span className="expiry__label">end within 30 days</span>
                  </Link>
                )}
                {data.contract_expiry.within_90 > data.contract_expiry.within_30 && (
                  <Link className="expiry__band" to="/contracts?expiring=90">
                    <span className="expiry__count">
                      {data.contract_expiry.within_90 - data.contract_expiry.within_30}
                    </span>
                    <span className="expiry__label">end in 31 to 90 days</span>
                  </Link>
                )}
              </div>
              {data.contract_expiry.soonest !== null && (
                <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
                  The next one ends {formatDate(data.contract_expiry.soonest)}.
                </p>
              )}
            </Panel>
          )}
        </>
      )}
    </>
  );
}

type KpiTone = 'accent' | 'petrol' | 'ochre' | 'brick' | 'green' | 'steel';

function Kpi({
  label, value, hint, tone,
}: {
  label: string; value: string; hint?: string; tone: KpiTone;
}) {
  return (
    <div className={`kpi kpi--${tone}`}>
      <div className="kpi__label">{label}</div>
      <div className="kpi__value">{value}</div>
      {hint !== undefined && <div className="kpi__hint">{hint}</div>}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-list__row">
      <span className="muted">{label}</span>
      <span className="stat-list__value">{value}</span>
    </div>
  );
}
