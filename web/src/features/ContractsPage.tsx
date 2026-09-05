/**
 * Contracts.
 *
 * The list highlights the contract that is in force today, because "which one
 * applies?" is the question this screen exists to answer. Creating one that
 * overlaps an existing contract is rejected by a database constraint, and the
 * error the user sees names the overlap rather than the constraint.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { FormEvent } from 'react';

import { api, ApiError, queryString } from '../lib/api.ts';
import { useResource, type Page } from '../lib/use_resource.ts';
import { useReference } from '../lib/use_reference.ts';
import { useDebounced } from '../lib/use_debounced.ts';
import { formatDate, formatMoney, humanize, stateVariant } from '../lib/format.ts';
import { useAuth } from '../lib/auth.tsx';
import { Badge, Modal, Panel, Toolbar } from '../components/Chrome.tsx';
import { DataTable, Pagination, type Column } from '../components/DataTable.tsx';
import { SelectField, TextAreaField, TextField } from '../components/Field.tsx';
import { EmployeePicker } from '../components/EmployeePicker.tsx';
import { contractInput } from '../../../shared/schemas/hr.ts';

type ContractRow = {
  id: number; reference: string; employee_id: number; employee_name: string;
  employee_number: string; start_date: string; end_date: string | null;
  wage: number; wage_type: string; state: string; notes: string;
  department_name: string | null; job_title: string | null;
  schedule_name: string | null; structure_name: string | null; is_current: boolean;
  // The raw ids as well as the display names: the edit form needs something to
  // put in a <select value>, and a name is not that.
  department_id: number | null; job_position_id: number | null;
  employment_type_id: number | null; working_schedule_id: number | null;
  salary_structure_id: number | null;
};

type Reference = {
  departments: Array<{ id: number; name: string }>;
  job_positions: Array<{ id: number; title: string }>;
  employment_types: Array<{ id: number; name: string }>;
  working_schedules: Array<{ id: number; name: string }>;
  salary_structures: Array<{ id: number; name: string }>;
};

export function ContractsPage() {
  const [params] = useSearchParams();
  const { can } = useAuth();
  const employeeFilter = params.get('employee_id') ?? '';

  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const settledSearch = useDebounced(search);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ContractRow | null>(null);

  const path = `/contracts${queryString({
    q: settledSearch, state, employee_id: employeeFilter, page, page_size: 25,
  })}`;
  const { data, loading, error, reload } = useResource<Page<ContractRow>>(path);

  const columns: Array<Column<ContractRow>> = [
    { key: 'reference', header: 'Reference', width: '150px',
      render: (row) => (
        <span>
          <span className="mono">{row.reference}</span>
          {row.is_current && <> <Badge variant="success">Current</Badge></>}
        </span>
      ) },
    { key: 'employee', header: 'Employee',
      render: (row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.employee_name}</div>
          <div className="muted" style={{ fontSize: 12 }}>{row.employee_number}</div>
        </div>
      ) },
    { key: 'period', header: 'Validity',
      render: (row) => (
        <span>
          {formatDate(row.start_date)} →{' '}
          {row.end_date === null ? <span className="muted">open-ended</span> : formatDate(row.end_date)}
        </span>
      ) },
    { key: 'department', header: 'Department', render: (row) => row.department_name ?? '—' },
    { key: 'job_title', header: 'Position', render: (row) => row.job_title ?? '—' },
    { key: 'structure', header: 'Salary structure',
      render: (row) => row.structure_name ?? <Badge variant="warning">None — payroll will block</Badge> },
    { key: 'wage', header: 'Wage', numeric: true,
      render: (row) => (
        <span>{formatMoney(row.wage)}<span className="muted"> /{row.wage_type === 'monthly' ? 'mo' : 'hr'}</span></span>
      ) },
    { key: 'state', header: 'Status',
      render: (row) => <Badge variant={stateVariant(row.state)}>{humanize(row.state)}</Badge> },
  ];

  return (
    <>
      <div className="page__header">
        <div className="page__title">
          <h1>Contracts</h1>
          <span className="page__subtitle">
            Payroll uses only the contract valid for the period being paid. Overlapping contracts are
            rejected by the database, not just by this form.
          </span>
        </div>
        {can('contract:write') && (
          <div className="page__actions">
            <button className="btn btn--primary" onClick={() => setCreating(true)}>New contract</button>
          </div>
        )}
      </div>

      {employeeFilter !== '' && (
        <div className="alert alert--info">
          <span>Showing contracts for one employee only.</span>
          <a href="/contracts">Show all contracts</a>
        </div>
      )}
      {error !== null && <div className="error-box">{error}</div>}

      <Panel flush>
        <Toolbar
          search={search}
          onSearchChange={(value) => { setPage(1); setSearch(value); }}
          searchPlaceholder="Search reference or employee…"
          right={<span className="toolbar__count">{data?.total ?? 0} contracts</span>}
        >
          <select className="select" style={{ width: 'auto' }} value={state}
            onChange={(event) => { setPage(1); setState(event.target.value); }}
            aria-label="Filter by state">
            <option value="">Any state</option>
            <option value="draft">Draft</option>
            <option value="running">Running</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </Toolbar>

        <DataTable
          columns={columns} rows={data?.rows ?? []} rowKey={(row) => row.id}
          loading={loading} emptyMessage="No contracts match these filters."
          onRowClick={can('contract:write') ? (row) => setEditing(row) : undefined}
        />
        <Pagination page={data?.page ?? 1} totalPages={data?.total_pages ?? 1}
          total={data?.total ?? 0} onPageChange={setPage} />
      </Panel>

      {creating && (
        <ContractFormModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); reload(); }}
        />
      )}

      {editing !== null && (
        <ContractFormModal
          contract={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </>
  );
}

function toFormValues(contract: ContractRow): Record<string, string> {
  return {
    reference: contract.reference,
    employee_id: String(contract.employee_id),
    start_date: contract.start_date,
    end_date: contract.end_date ?? '',
    department_id: contract.department_id === null ? '' : String(contract.department_id),
    job_position_id: contract.job_position_id === null ? '' : String(contract.job_position_id),
    employment_type_id:
      contract.employment_type_id === null ? '' : String(contract.employment_type_id),
    working_schedule_id:
      contract.working_schedule_id === null ? '' : String(contract.working_schedule_id),
    wage: String(contract.wage),
    wage_type: contract.wage_type,
    salary_structure_id:
      contract.salary_structure_id === null ? '' : String(contract.salary_structure_id),
    state: contract.state,
    notes: contract.notes,
  };
}

/**
 * Create or edit a contract.
 *
 * Editing matters more than it looks: state is what payroll reads, and the
 * resolver only considers 'running' and 'expired'. With create-only screens a
 * contract could be brought into existence but never transitioned, so ending one
 * or moving a draft into force was impossible anywhere in the interface.
 */
function ContractFormModal({
  contract, onClose, onSaved,
}: {
  contract?: ContractRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const reference = useReference();
  const [values, setValues] = useState<Record<string, string>>(
    contract !== undefined
      ? toFormValues(contract)
      : {
          reference: '', employee_id: '', start_date: new Date().toISOString().slice(0, 10),
          end_date: '', department_id: '', job_position_id: '', employment_type_id: '',
          working_schedule_id: '', wage: '', wage_type: 'monthly', salary_structure_id: '',
          state: 'draft', notes: '',
        },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: string) => (event: { target: { value: string } }): void =>
    setValues((previous) => ({ ...previous, [name]: event.target.value }));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);

    const payload: Record<string, unknown> = { ...values };
    for (const key of [
      'end_date', 'department_id', 'job_position_id', 'employment_type_id',
      'working_schedule_id', 'salary_structure_id',
    ]) {
      if (payload[key] === '') payload[key] = null;
    }

    const parsed = contractInput.safeParse(payload);
    if (!parsed.success) {
      setErrors(Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.map(String).join('.'), issue.message]),
      ));
      return;
    }

    setErrors({});
    setBusy(true);
    try {
      if (contract === undefined) {
        await api.post('/contracts', parsed.data);
      } else {
        await api.patch(`/contracts/${contract.id}`, parsed.data);
      }
      onSaved();
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        const fields = error.fieldMap();
        if (Object.keys(fields).length > 0) setErrors(fields);
        else setFormError(error.message);
      } else {
        setFormError('Could not save the contract.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={contract === undefined ? 'New contract' : `Edit ${contract.reference}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn--primary" form="contract-form" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save contract'}
          </button>
        </>
      }
    >
      {formError !== null && <div className="error-box" role="alert">{formError}</div>}

      <form id="contract-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="form-grid">
          <TextField label="Reference" name="reference" required value={values.reference}
            error={errors.reference} onChange={set('reference')} hint="e.g. CTR/EMP-2024-0042/2" />
          <EmployeePicker label="Employee" required
            value={values.employee_id} error={errors.employee_id}
            onChange={(id) => setValues((previous) => ({ ...previous, employee_id: id }))} />
          <TextField label="Start date" name="start_date" type="date" required
            value={values.start_date} error={errors.start_date} onChange={set('start_date')} />
          <TextField label="End date" name="end_date" type="date" value={values.end_date}
            error={errors.end_date} onChange={set('end_date')}
            hint="Leave blank for an open-ended contract." />
          <TextField label="Wage" name="wage" type="number" step="0.01" required value={values.wage}
            error={errors.wage} onChange={set('wage')} />
          <SelectField label="Wage type" name="wage_type" value={values.wage_type}
            error={errors.wage_type} onChange={set('wage_type')}
            options={[{ value: 'monthly', label: 'Monthly' }, { value: 'hourly', label: 'Hourly' }]} />
          <SelectField label="Salary structure" name="salary_structure_id" placeholder="None"
            hint="Determines which salary rules price this contract."
            value={values.salary_structure_id} error={errors.salary_structure_id}
            onChange={set('salary_structure_id')}
            options={(reference.data?.salary_structures ?? []).map((item) => ({ value: item.id, label: item.name }))} />
          <SelectField label="Working schedule" name="working_schedule_id" placeholder="Use employee default"
            value={values.working_schedule_id} error={errors.working_schedule_id}
            onChange={set('working_schedule_id')}
            options={(reference.data?.working_schedules ?? []).map((item) => ({ value: item.id, label: item.name }))} />
          <SelectField label="Department" name="department_id" placeholder="None"
            value={values.department_id} error={errors.department_id} onChange={set('department_id')}
            options={(reference.data?.departments ?? []).map((item) => ({ value: item.id, label: item.name }))} />
          <SelectField label="Job position" name="job_position_id" placeholder="None"
            value={values.job_position_id} error={errors.job_position_id} onChange={set('job_position_id')}
            options={(reference.data?.job_positions ?? []).map((item) => ({ value: item.id, label: item.title }))} />
          <SelectField label="State" name="state" value={values.state} error={errors.state}
            onChange={set('state')}
            hint="Only running and expired contracts are checked for overlap."
            options={[
              { value: 'draft', label: 'Draft' },
              { value: 'running', label: 'Running' },
              { value: 'expired', label: 'Expired' },
              { value: 'cancelled', label: 'Cancelled' },
            ]} />
        </div>
        <TextAreaField label="Notes" name="notes" value={values.notes} error={errors.notes}
          onChange={set('notes')} />
      </form>
    </Modal>
  );
}
