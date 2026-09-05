/**
 * Payruns and payslips, plus the two-step payrun wizard.
 *
 * The wizard is the part of the spec most easily got wrong: clicking NEW must not
 * create a record. Step 1 and step 2 are client state; step 2 asks the server
 * which employees are eligible, which is a pure read; and the payrun only comes
 * into existence when Create Payrun is pressed.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { api, ApiError, queryString } from '../lib/api.ts';
import { useResource, type Page } from '../lib/use_resource.ts';
import { useReference } from '../lib/use_reference.ts';
import { useDebounced } from '../lib/use_debounced.ts';
import { formatDate, formatMoney, humanize, stateVariant } from '../lib/format.ts';
import { useAuth } from '../lib/auth.tsx';
import { Badge, Modal, Panel, Toolbar } from '../components/Chrome.tsx';
import { ExportButtons } from '../components/ExportButtons.tsx';
import { DataTable, Pagination, type Column } from '../components/DataTable.tsx';
import { SelectField, TextField } from '../components/Field.tsx';
import { payrunCreateInput, payrunScopeInput } from '../../../shared/schemas/payroll.ts';

type PayrunRow = {
  id: number; name: string; period_start: string; period_end: string;
  state: string; structure_name: string; payslip_count: number;
  total_net: number; blocker_count: number; warning_count: number;
};

type PayslipRow = {
  id: number; number: string; employee_id: number; employee_name: string;
  employee_number: string; payrun_name: string; structure_name: string;
  period_start: string; period_end: string; state: string;
  worked_days: number; gross_amount: number; net_amount: number; currency_code: string;
};

type Reference = {
  departments: Array<{ id: number; name: string }>;
  employment_types: Array<{ id: number; name: string }>;
  salary_structures: Array<{ id: number; name: string }>;
};

export function PayrollPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const tab = params.get('tab') === 'payslips' ? 'payslips' : 'payruns';
  const employeeFilter = params.get('employee_id') ?? '';

  const [wizardOpen, setWizardOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [state, setState] = useState('');
  const [search, setSearch] = useState('');

  const settledSearch = useDebounced(search);
  const payrunPath = `/payruns${queryString({ q: settledSearch, state, page, page_size: 25 })}`;
  const payslipPath = `/payslips${queryString({
    employee_id: employeeFilter, state, page, page_size: 25,
  })}`;

  const payruns = useResource<Page<PayrunRow>>(tab === 'payruns' ? payrunPath : null);
  const payslips = useResource<Page<PayslipRow>>(tab === 'payslips' ? payslipPath : null);

  const setTab = (next: 'payruns' | 'payslips'): void => {
    const updated = new URLSearchParams(params);
    updated.set('tab', next);
    setParams(updated, { replace: true });
    setPage(1);
    setState('');
  };

  const payrunColumns: Array<Column<PayrunRow>> = [
    { key: 'name', header: 'Payrun', render: (row) => <strong>{row.name}</strong> },
    { key: 'period', header: 'Period',
      render: (row) => `${formatDate(row.period_start)} → ${formatDate(row.period_end)}` },
    { key: 'structure', header: 'Structure', render: (row) => row.structure_name },
    { key: 'payslips', header: 'Payslips', numeric: true, render: (row) => row.payslip_count },
    { key: 'net', header: 'Total net', numeric: true,
      render: (row) => formatMoney(Number(row.total_net)) },
    { key: 'issues', header: 'Issues',
      render: (row) => (
        <span style={{ display: 'flex', gap: 4 }}>
          {row.blocker_count > 0 && <Badge variant="danger">{row.blocker_count} blocking</Badge>}
          {row.warning_count > 0 && <Badge variant="warning">{row.warning_count} warnings</Badge>}
          {row.blocker_count === 0 && row.warning_count === 0 && <span className="muted">None</span>}
        </span>
      ) },
    { key: 'state', header: 'Status',
      render: (row) => <Badge variant={stateVariant(row.state)}>{humanize(row.state)}</Badge> },
  ];

  const payslipColumns: Array<Column<PayslipRow>> = [
    { key: 'number', header: 'Payslip', render: (row) => <span className="mono">{row.number}</span> },
    { key: 'employee', header: 'Employee',
      render: (row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.employee_name}</div>
          <div className="muted" style={{ fontSize: 12 }}>{row.employee_number}</div>
        </div>
      ) },
    { key: 'payrun', header: 'Payrun', render: (row) => row.payrun_name },
    { key: 'period', header: 'Period',
      render: (row) => `${formatDate(row.period_start)} → ${formatDate(row.period_end)}` },
    { key: 'worked_days', header: 'Worked days', numeric: true,
      render: (row) => Number(row.worked_days) },
    { key: 'gross', header: 'Gross', numeric: true,
      render: (row) => formatMoney(Number(row.gross_amount), row.currency_code) },
    { key: 'net', header: 'Net', numeric: true,
      render: (row) => <strong>{formatMoney(Number(row.net_amount), row.currency_code)}</strong> },
    { key: 'state', header: 'Status',
      render: (row) => <Badge variant={stateVariant(row.state)}>{humanize(row.state)}</Badge> },
  ];

  const active = tab === 'payruns' ? payruns : payslips;

  return (
    <>
      <div className="page__header">
        <div className="page__title">
          <h1>Payroll</h1>
          <span className="page__subtitle">
            A payrun batches payslips for one period. Once validated it is history and cannot be
            recomputed.
          </span>
        </div>
        {tab === 'payruns' && can('payrun:write') && (
          <div className="page__actions">
            <button className="btn btn--primary" onClick={() => setWizardOpen(true)}>New payrun</button>
          </div>
        )}
      </div>

      <div className="segmented" style={{ marginBottom: 'var(--space-3)' }}>
        <button className={`btn btn--sm${tab === 'payruns' ? ' btn--selected' : ''}`}
          onClick={() => setTab('payruns')}>Payruns</button>
        <button className={`btn btn--sm${tab === 'payslips' ? ' btn--selected' : ''}`}
          onClick={() => setTab('payslips')}>Payslips</button>
      </div>

      {employeeFilter !== '' && tab === 'payslips' && (
        <div className="alert alert--info">
          <span>Showing payslips for one employee only.</span>
          <Link to="/payroll?tab=payslips">Show everyone</Link>
        </div>
      )}
      {active.error !== null && <div className="error-box">{active.error}</div>}

      <Panel flush>
        <Toolbar
          search={tab === 'payruns' ? search : undefined}
          onSearchChange={tab === 'payruns' ? (value) => { setPage(1); setSearch(value); } : undefined}
          searchPlaceholder="Search payrun name…"
          right={<span className="toolbar__count">{active.data?.total ?? 0} records</span>}
        >
          <select className="select" style={{ width: 'auto' }} value={state}
            onChange={(event) => { setPage(1); setState(event.target.value); }}
            aria-label="Filter by status">
            <option value="">Any status</option>
            <option value="draft">Draft</option>
            <option value="computed">Computed</option>
            <option value="validated">Validated</option>
            <option value="paid">Paid</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </Toolbar>

        {tab === 'payruns' ? (
          <DataTable columns={payrunColumns} rows={payruns.data?.rows ?? []}
            rowKey={(row) => row.id} loading={payruns.loading}
            onRowClick={(row) => navigate(`/payroll/payruns/${row.id}`)}
            emptyMessage="No payruns yet. Create one to generate payslips." />
        ) : (
          <DataTable columns={payslipColumns} rows={payslips.data?.rows ?? []}
            rowKey={(row) => row.id} loading={payslips.loading}
            onRowClick={(row) => navigate(`/payroll/payslips/${row.id}`)}
            emptyMessage="No payslips match these filters." />
        )}

        <Pagination page={active.data?.page ?? 1} totalPages={active.data?.total_pages ?? 1}
          total={active.data?.total ?? 0} onPageChange={setPage} />
      </Panel>

      {wizardOpen && (
        <PayrunWizard
          onClose={() => setWizardOpen(false)}
          onCreated={(id) => navigate(`/payroll/payruns/${id}`)}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------- wizard --- */

type EligibleEmployee = {
  employee_id: number; employee_number: string; employee_name: string;
  department_name: string | null; employment_type_name: string | null;
  contract_reference: string | null; wage: number | null;
  is_eligible: boolean; ineligible_reason: string | null;
};

function firstOfThisMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function lastOfThisMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
    .toISOString().slice(0, 10);
}

function PayrunWizard({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const reference = useReference();

  const [step, setStep] = useState<1 | 2>(1);
  const [scope, setScope] = useState<Record<string, string>>({
    salary_structure_id: '', period_start: firstOfThisMonth(), period_end: lastOfThisMonth(),
    scope_department_id: '', scope_employment_type_id: '',
  });
  const [name, setName] = useState(`PR/${firstOfThisMonth().slice(0, 7)}`);
  const [candidates, setCandidates] = useState<EligibleEmployee[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [candidateFilter, setCandidateFilter] = useState('');
  const [showIneligible, setShowIneligible] = useState(true);

  const set = (key: string) => (event: { target: { value: string } }): void =>
    setScope((previous) => ({ ...previous, [key]: event.target.value }));

  const toPayload = (): Record<string, unknown> => ({
    ...scope,
    scope_department_id: scope.scope_department_id === '' ? null : scope.scope_department_id,
    scope_employment_type_id:
      scope.scope_employment_type_id === '' ? null : scope.scope_employment_type_id,
  });

  /**
   * Continue moves to employee selection. It asks the server who is eligible --
   * a read -- and creates nothing. The payrun does not exist yet.
   */
  const goToStepTwo = async (): Promise<void> => {
    setFormError(null);

    const parsed = payrunScopeInput.safeParse(toPayload());
    if (!parsed.success) {
      setErrors(Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.map(String).join('.'), issue.message]),
      ));
      return;
    }

    setErrors({});
    setBusy(true);
    try {
      const result = await api.post<{ rows: EligibleEmployee[] }>(
        '/payruns/eligible-employees', parsed.data,
      );
      setCandidates(result.rows);
      setSelected(new Set(result.rows.filter((row) => row.is_eligible).map((row) => row.employee_id)));
      setStep(2);
    } catch (error: unknown) {
      setFormError(error instanceof ApiError ? error.message : 'Could not load eligible employees.');
    } finally {
      setBusy(false);
    }
  };

  const create = async (): Promise<void> => {
    setFormError(null);

    const parsed = payrunCreateInput.safeParse({
      ...toPayload(), name, employee_ids: [...selected],
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Check the payrun details.');
      return;
    }

    setBusy(true);
    try {
      const created = await api.post<{ id: number }>('/payruns', parsed.data);
      onCreated(created.id);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        const rejected = (error.details as { rejected?: string[] } | null)?.rejected;
        setFormError(
          rejected === undefined ? error.message : `${error.message} ${rejected.join('; ')}`,
        );
      } else {
        setFormError('Could not create the payrun.');
      }
    } finally {
      setBusy(false);
    }
  };

  const eligible = candidates.filter((row) => row.is_eligible);
  const ineligible = candidates.filter((row) => !row.is_eligible);

  // Selecting carefully matters most at the scale where an unfiltered list of
  // every candidate stops being readable, so the step filters rather than
  // rendering the whole company and trusting the reader to scroll.
  const needle = candidateFilter.trim().toLowerCase();
  const shown = needle === ''
    ? candidates
    : candidates.filter((row) =>
        row.employee_name.toLowerCase().includes(needle)
        || row.employee_number.toLowerCase().includes(needle)
        || (row.department_name ?? '').toLowerCase().includes(needle));

  return (
    <Modal
      title={step === 1 ? 'New payrun — step 1 of 2: scope' : 'New payrun — step 2 of 2: employees'}
      onClose={onClose}
      wide
      footer={
        step === 1 ? (
          <>
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn--primary" disabled={busy} onClick={() => void goToStepTwo()}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => setStep(1)} disabled={busy}>Back</button>
            <button className="btn btn--primary" disabled={busy || selected.size === 0}
              onClick={() => void create()}>
              {busy ? 'Creating…' : `Create payrun (${selected.size})`}
            </button>
          </>
        )
      }
    >
      {formError !== null && <div className="error-box" role="alert">{formError}</div>}

      {step === 1 ? (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            Nothing is created yet. Continue only looks up which employees are eligible for this
            period.
          </p>
          <div className="form-grid">
            <TextField label="Payrun name" name="name" required value={name}
              onChange={(event) => setName(event.target.value)} hint="e.g. PR/2026-09" />
            <SelectField label="Salary structure" name="salary_structure_id" required
              placeholder="Choose a structure"
              value={scope.salary_structure_id} error={errors.salary_structure_id}
              onChange={set('salary_structure_id')}
              options={(reference.data?.salary_structures ?? []).map((item) => ({
                value: item.id, label: item.name,
              }))} />
            <TextField label="Period start" name="period_start" type="date" required
              value={scope.period_start} error={errors.period_start} onChange={set('period_start')} />
            <TextField label="Period end" name="period_end" type="date" required
              value={scope.period_end} error={errors.period_end} onChange={set('period_end')} />
            <SelectField label="Department" name="scope_department_id" placeholder="All departments"
              value={scope.scope_department_id} error={errors.scope_department_id}
              onChange={set('scope_department_id')}
              options={(reference.data?.departments ?? []).map((item) => ({
                value: item.id, label: item.name,
              }))} />
            <SelectField label="Employee type" name="scope_employment_type_id" placeholder="All types"
              value={scope.scope_employment_type_id} error={errors.scope_employment_type_id}
              onChange={set('scope_employment_type_id')}
              options={(reference.data?.employment_types ?? []).map((item) => ({
                value: item.id, label: item.name,
              }))} />
          </div>
        </>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            {eligible.length} eligible, {ineligible.length} excluded. Ineligible employees are shown
            with the reason rather than hidden.
          </p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <input
              className="input"
              type="search"
              style={{ flex: '1 1 220px', minWidth: 180 }}
              placeholder="Filter by name, number or department…"
              aria-label="Filter candidates"
              value={candidateFilter}
              onChange={(event) => setCandidateFilter(event.target.value)}
            />
            <button type="button" className="btn btn--sm"
              onClick={() => setSelected(new Set(eligible.map((row) => row.employee_id)))}>
              Select all eligible
            </button>
            <button type="button" className="btn btn--sm" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
            <button type="button" className="btn btn--sm"
              onClick={() => setShowIneligible(!showIneligible)}>
              {showIneligible ? 'Hide excluded' : `Show excluded (${ineligible.length})`}
            </button>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 34 }} />
                <th>Employee</th><th>Department</th><th>Type</th>
                <th>Contract</th><th className="table__num">Wage</th>
              </tr>
            </thead>
            <tbody>
              {shown
                .filter((row) => showIneligible || row.is_eligible)
                .map((row) => (
                <tr key={row.employee_id} style={row.is_eligible ? undefined : { opacity: 0.55 }}>
                  <td>
                    <input
                      type="checkbox"
                      disabled={!row.is_eligible}
                      checked={selected.has(row.employee_id)}
                      aria-label={`Include ${row.employee_name}`}
                      onChange={(event) => {
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (event.target.checked) next.add(row.employee_id);
                          else next.delete(row.employee_id);
                          return next;
                        });
                      }}
                    />
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{row.employee_name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{row.employee_number}</div>
                    {!row.is_eligible && (
                      <div style={{ marginTop: 2 }}>
                        <Badge variant="warning">{row.ineligible_reason}</Badge>
                      </div>
                    )}
                  </td>
                  <td>{row.department_name ?? '—'}</td>
                  <td>{row.employment_type_name ?? '—'}</td>
                  <td className="mono">{row.contract_reference ?? '—'}</td>
                  <td className="table__num">
                    {row.wage === null ? '—' : formatMoney(Number(row.wage))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {shown.length === 0 && (
            <div className="table__empty">No candidates match that filter.</div>
          )}
        </>
      )}
    </Modal>
  );
}
