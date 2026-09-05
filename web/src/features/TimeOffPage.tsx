/**
 * Time off: requests, allocations and balances.
 *
 * The second demo flow lives here. Approving a request draws it down against a
 * named allocation and the balance moves; refusing an approved request gives the
 * balance back, because balance is derived from consumption rows rather than
 * stored as a counter.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { FormEvent } from 'react';

import { api, ApiError, queryString } from '../lib/api.ts';
import { useResource, type Page } from '../lib/use_resource.ts';
import { formatDate, humanize, stateVariant } from '../lib/format.ts';
import { useAuth } from '../lib/auth.tsx';
import { Badge, Modal, Panel, Toolbar } from '../components/Chrome.tsx';
import { DataTable, Pagination, type Column } from '../components/DataTable.tsx';
import { SelectField, TextAreaField, TextField } from '../components/Field.tsx';
import { timeOffAllocationInput, timeOffRequestInput } from '../../../shared/schemas/hr.ts';

type RequestRow = {
  id: number; employee_id: number; employee_name: string; employee_number: string;
  type_name: string; type_code: string; unit: string; is_paid: boolean;
  date_from: string; date_to: string; requested_amount: number;
  state: string; reason: string; decision_note: string;
  decided_by: string | null; consumed_amount: number;
};

type AllocationRow = {
  id: number; employee_id: number; employee_name: string;
  type_name: string; type_code: string; unit: string;
  allocated_amount: number; consumed_amount: number; remaining_amount: number;
  valid_from: string; valid_to: string; state: string; notes: string;
};

type TypeRow = {
  id: number; code: string; name: string; unit: string;
  requires_allocation: boolean; requires_approval: boolean;
  is_paid: boolean; payroll_rule_code: string | null; request_count: number;
};

type Tab = 'requests' | 'allocations' | 'types';

export function TimeOffPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const employeeFilter = params.get('employee_id') ?? '';
  const tab = (params.get('tab') as Tab | null) ?? 'requests';

  const setTab = (next: Tab): void => {
    const updated = new URLSearchParams(params);
    updated.set('tab', next);
    setParams(updated, { replace: true });
  };

  return (
    <>
      <div className="page__header">
        <div className="page__title">
          <h1>Time Off</h1>
          <span className="page__subtitle">
            Allocations grant balance, approved requests consume it, and every consumption records
            which allocation it came from.
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 'var(--space-3)' }}>
        {([
          ['requests', 'Requests'],
          ['allocations', 'Allocations'],
          ['types', 'Time Off Types'],
        ] as Array<[Tab, string]>).map(([key, label]) => (
          <button
            key={key}
            className={`btn btn--sm${tab === key ? ' btn--plum' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {employeeFilter !== '' && (
        <div className="alert alert--info">
          <span>Filtered to one employee.</span>
          <a href={`/time-off?tab=${tab}`}>Show everyone</a>
        </div>
      )}

      {tab === 'requests' && <RequestsTab employeeFilter={employeeFilter} canApprove={can('timeoff:approve')} canCreate={can('timeoff:write')} />}
      {tab === 'allocations' && <AllocationsTab employeeFilter={employeeFilter} canManage={can('timeoff:approve')} />}
      {tab === 'types' && <TypesTab />}
    </>
  );
}

/* --------------------------------------------------------------- requests -- */

function RequestsTab({
  employeeFilter, canApprove, canCreate,
}: {
  employeeFilter: string;
  canApprove: boolean;
  canCreate: boolean;
}) {
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const path = `/time-off/requests${queryString({
    employee_id: employeeFilter, state, page, page_size: 25,
  })}`;
  const { data, loading, error, reload } = useResource<Page<RequestRow>>(path);

  const decide = async (id: number, action: 'approve' | 'refuse'): Promise<void> => {
    setBusyId(id);
    setDecisionError(null);
    try {
      await api.post(`/time-off/requests/${id}/${action}`, { decision_note: '' });
      reload();
    } catch (caught: unknown) {
      // A refused approval is usually a real business answer -- no allocation
      // covers these dates, or the balance is short -- so the message is shown
      // as-is rather than reduced to "failed".
      setDecisionError(caught instanceof ApiError ? caught.message : 'Could not record the decision.');
    } finally {
      setBusyId(null);
    }
  };

  const columns: Array<Column<RequestRow>> = [
    { key: 'employee', header: 'Employee',
      render: (row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.employee_name}</div>
          <div className="muted" style={{ fontSize: 12 }}>{row.employee_number}</div>
        </div>
      ) },
    { key: 'type', header: 'Type',
      render: (row) => (
        <span>
          {row.type_name}{' '}
          {!row.is_paid && <Badge variant="warning">Unpaid</Badge>}
        </span>
      ) },
    { key: 'dates', header: 'Dates',
      render: (row) => `${formatDate(row.date_from)} → ${formatDate(row.date_to)}` },
    { key: 'amount', header: 'Duration', numeric: true,
      render: (row) => `${Number(row.requested_amount)} ${row.unit}${Number(row.requested_amount) === 1 ? '' : 's'}` },
    { key: 'consumed', header: 'Drawn from balance', numeric: true,
      render: (row) => Number(row.consumed_amount) > 0
        ? <strong>{Number(row.consumed_amount)}</strong>
        : <span className="muted">—</span> },
    { key: 'reason', header: 'Reason',
      render: (row) => <span className="muted">{row.reason || '—'}</span> },
    { key: 'state', header: 'Status',
      render: (row) => <Badge variant={stateVariant(row.state)}>{humanize(row.state)}</Badge> },
    ...(canApprove
      ? [{
          key: 'actions', header: '', numeric: true,
          render: (row: RequestRow) => (
            <span style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
              {row.state !== 'approved' && (
                <button className="btn btn--sm btn--primary" disabled={busyId === row.id}
                  onClick={() => void decide(row.id, 'approve')}>Approve</button>
              )}
              {row.state !== 'refused' && (
                <button className="btn btn--sm btn--danger" disabled={busyId === row.id}
                  onClick={() => void decide(row.id, 'refuse')}>Refuse</button>
              )}
            </span>
          ),
        }]
      : []),
  ];

  return (
    <>
      {error !== null && <div className="error-box">{error}</div>}
      {decisionError !== null && <div className="error-box" role="alert">{decisionError}</div>}

      <Panel flush>
        <Toolbar
          right={
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="toolbar__count">{data?.total ?? 0} requests</span>
              {canCreate && (
                <button className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
                  New request
                </button>
              )}
            </span>
          }
        >
          <select className="select" style={{ width: 'auto' }} value={state}
            onChange={(event) => { setPage(1); setState(event.target.value); }}
            aria-label="Filter by status">
            <option value="">Any status</option>
            <option value="to_approve">To approve</option>
            <option value="approved">Approved</option>
            <option value="refused">Refused</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </Toolbar>

        <DataTable columns={columns} rows={data?.rows ?? []} rowKey={(row) => row.id}
          loading={loading} emptyMessage="No time off requests match these filters." />
        <Pagination page={data?.page ?? 1} totalPages={data?.total_pages ?? 1}
          total={data?.total ?? 0} onPageChange={setPage} />
      </Panel>

      {creating && (
        <RequestFormModal onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); reload(); }} />
      )}
    </>
  );
}

function useEmployeeOptions() {
  const employees = useResource<Page<{
    id: number; first_name: string; last_name: string; employee_number: string;
  }>>('/employees?page_size=200');

  return (employees.data?.rows ?? []).map((item) => ({
    value: item.id,
    label: `${item.employee_number} — ${item.first_name} ${item.last_name}`,
  }));
}

function RequestFormModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const employeeOptions = useEmployeeOptions();
  const types = useResource<{ rows: TypeRow[] }>('/time-off/types');

  const today = new Date().toISOString().slice(0, 10);
  const [values, setValues] = useState<Record<string, string>>({
    employee_id: '', time_off_type_id: '', date_from: today, date_to: today,
    requested_amount: '1', reason: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: string) => (event: { target: { value: string } }): void =>
    setValues((previous) => ({ ...previous, [name]: event.target.value }));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);

    const parsed = timeOffRequestInput.safeParse(values);
    if (!parsed.success) {
      setErrors(Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.map(String).join('.'), issue.message]),
      ));
      return;
    }

    setErrors({});
    setBusy(true);
    try {
      await api.post('/time-off/requests', parsed.data);
      onSaved();
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        const fields = error.fieldMap();
        if (Object.keys(fields).length > 0) setErrors(fields);
        else setFormError(error.message);
      } else {
        setFormError('Could not create the request.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New time off request"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn--primary" form="request-form" type="submit" disabled={busy}>
            {busy ? 'Submitting…' : 'Submit request'}
          </button>
        </>
      }
    >
      {formError !== null && <div className="error-box" role="alert">{formError}</div>}

      <form id="request-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="form-grid">
          <SelectField label="Employee" name="employee_id" required placeholder="Choose an employee"
            value={values.employee_id} error={errors.employee_id} onChange={set('employee_id')}
            options={employeeOptions} />
          <SelectField label="Time off type" name="time_off_type_id" required placeholder="Choose a type"
            value={values.time_off_type_id} error={errors.time_off_type_id}
            onChange={set('time_off_type_id')}
            options={(types.data?.rows ?? []).map((item) => ({
              value: item.id,
              label: `${item.name}${item.is_paid ? '' : ' (unpaid)'}`,
            }))} />
          <TextField label="From" name="date_from" type="date" required value={values.date_from}
            error={errors.date_from} onChange={set('date_from')} />
          <TextField label="To" name="date_to" type="date" required value={values.date_to}
            error={errors.date_to} onChange={set('date_to')} />
          <TextField label="Duration" name="requested_amount" type="number" step="0.5" required
            hint="Days or hours, depending on the type."
            value={values.requested_amount} error={errors.requested_amount}
            onChange={set('requested_amount')} />
        </div>
        <TextAreaField label="Reason" name="reason" value={values.reason} error={errors.reason}
          onChange={set('reason')} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------ allocations -- */

function AllocationsTab({
  employeeFilter, canManage,
}: {
  employeeFilter: string;
  canManage: boolean;
}) {
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const path = `/time-off/allocations${queryString({
    employee_id: employeeFilter, page, page_size: 25,
  })}`;
  const { data, loading, error, reload } = useResource<{ rows: AllocationRow[] }>(path);

  const approve = async (id: number): Promise<void> => {
    setBusyId(id);
    setActionError(null);
    try {
      await api.post(`/time-off/allocations/${id}/approve`);
      reload();
    } catch (caught: unknown) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not approve the allocation.');
    } finally {
      setBusyId(null);
    }
  };

  const columns: Array<Column<AllocationRow>> = [
    { key: 'employee', header: 'Employee',
      render: (row) => <span style={{ fontWeight: 600 }}>{row.employee_name}</span> },
    { key: 'type', header: 'Type', render: (row) => row.type_name },
    { key: 'validity', header: 'Valid',
      render: (row) => `${formatDate(row.valid_from)} → ${formatDate(row.valid_to)}` },
    { key: 'allocated', header: 'Allocated', numeric: true,
      render: (row) => `${Number(row.allocated_amount)} ${row.unit}s` },
    { key: 'taken', header: 'Taken', numeric: true,
      render: (row) => Number(row.consumed_amount) },
    { key: 'remaining', header: 'Remaining', numeric: true,
      render: (row) => <strong>{Number(row.remaining_amount)}</strong> },
    { key: 'state', header: 'Status',
      render: (row) => <Badge variant={stateVariant(row.state)}>{humanize(row.state)}</Badge> },
    ...(canManage
      ? [{
          key: 'actions', header: '', numeric: true,
          render: (row: AllocationRow) => row.state === 'approved'
            ? <span className="muted">—</span>
            : (
              <button className="btn btn--sm btn--primary" disabled={busyId === row.id}
                onClick={() => void approve(row.id)}>Approve</button>
            ),
        }]
      : []),
  ];

  return (
    <>
      {error !== null && <div className="error-box">{error}</div>}
      {actionError !== null && <div className="error-box" role="alert">{actionError}</div>}

      <Panel flush>
        <Toolbar
          right={
            canManage ? (
              <button className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
                New allocation
              </button>
            ) : undefined
          }
        />
        <DataTable columns={columns} rows={data?.rows ?? []} rowKey={(row) => row.id}
          loading={loading}
          emptyMessage="No allocations yet. An employee needs one before paid leave can be approved." />
        <Pagination page={page} totalPages={page + ((data?.rows.length ?? 0) === 25 ? 1 : 0)}
          total={data?.rows.length ?? 0} onPageChange={setPage} />
      </Panel>

      {creating && (
        <AllocationFormModal onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); reload(); }} />
      )}
    </>
  );
}

function AllocationFormModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const employeeOptions = useEmployeeOptions();
  const types = useResource<{ rows: TypeRow[] }>('/time-off/types');

  const year = new Date().getUTCFullYear();
  const [values, setValues] = useState<Record<string, string>>({
    employee_id: '', time_off_type_id: '', allocated_amount: '12',
    valid_from: `${year}-01-01`, valid_to: `${year}-12-31`, notes: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: string) => (event: { target: { value: string } }): void =>
    setValues((previous) => ({ ...previous, [name]: event.target.value }));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);

    const parsed = timeOffAllocationInput.safeParse(values);
    if (!parsed.success) {
      setErrors(Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.map(String).join('.'), issue.message]),
      ));
      return;
    }

    setErrors({});
    setBusy(true);
    try {
      await api.post('/time-off/allocations', parsed.data);
      onSaved();
    } catch (error: unknown) {
      setFormError(error instanceof ApiError ? error.message : 'Could not create the allocation.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New allocation"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn--primary" form="allocation-form" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Create allocation'}
          </button>
        </>
      }
    >
      {formError !== null && <div className="error-box" role="alert">{formError}</div>}

      <p className="muted" style={{ fontSize: 13 }}>
        An allocation starts as a draft and grants no balance until it is approved. Leave can only be
        approved against an allocation whose validity covers the leave dates.
      </p>

      <form id="allocation-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="form-grid">
          <SelectField label="Employee" name="employee_id" required placeholder="Choose an employee"
            value={values.employee_id} error={errors.employee_id} onChange={set('employee_id')}
            options={employeeOptions} />
          <SelectField label="Time off type" name="time_off_type_id" required placeholder="Choose a type"
            value={values.time_off_type_id} error={errors.time_off_type_id}
            onChange={set('time_off_type_id')}
            options={(types.data?.rows ?? [])
              .filter((item) => item.requires_allocation)
              .map((item) => ({ value: item.id, label: item.name }))} />
          <TextField label="Amount" name="allocated_amount" type="number" step="0.5" required
            value={values.allocated_amount} error={errors.allocated_amount}
            onChange={set('allocated_amount')} />
          <TextField label="Valid from" name="valid_from" type="date" required
            value={values.valid_from} error={errors.valid_from} onChange={set('valid_from')} />
          <TextField label="Valid to" name="valid_to" type="date" required
            value={values.valid_to} error={errors.valid_to} onChange={set('valid_to')} />
        </div>
        <TextAreaField label="Notes" name="notes" value={values.notes} error={errors.notes}
          onChange={set('notes')} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ types -- */

function TypesTab() {
  const { data, loading, error } = useResource<{ rows: TypeRow[] }>('/time-off/types');

  return (
    <>
      {error !== null && <div className="error-box">{error}</div>}
      <Panel flush>
        {loading ? (
          <div className="loading">Loading…</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Code</th><th>Name</th><th>Unit</th>
                <th>Needs allocation</th><th>Paid</th><th>Payroll rule</th>
                <th className="table__num">Requests</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.code}</td>
                  <td style={{ fontWeight: 600 }}>{row.name}</td>
                  <td>{humanize(row.unit)}</td>
                  <td>{row.requires_allocation ? 'Yes' : 'No'}</td>
                  <td>
                    {row.is_paid
                      ? <Badge variant="success">Paid</Badge>
                      : <Badge variant="warning">Unpaid</Badge>}
                  </td>
                  <td className="mono">{row.payroll_rule_code ?? '—'}</td>
                  <td className="table__num">{row.request_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="muted" style={{ fontSize: 13 }}>
        An unpaid type carries a payroll rule code, which is how approved unpaid leave becomes a
        loss-of-pay deduction on the payslip.
      </p>
    </>
  );
}
