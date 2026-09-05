/**
 * Attendance.
 *
 * Corrections are a separate permission from recording presence, and the form
 * insists on a reason -- the database refuses an edit that does not say who made
 * it and why, so the audit trail cannot have a hole exactly where it matters.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { FormEvent } from 'react';

import { api, ApiError, queryString } from '../lib/api.ts';
import { useResource, type Page } from '../lib/use_resource.ts';
import { formatDateTime, formatTime, humanize, stateVariant } from '../lib/format.ts';
import { useAuth } from '../lib/auth.tsx';
import { Badge, Modal, Panel, Toolbar } from '../components/Chrome.tsx';
import { DataTable, Pagination, type Column } from '../components/DataTable.tsx';
import { TextAreaField, TextField } from '../components/Field.tsx';
import { fromLocalInput, toLocalInput, todayInTenantZone } from '../lib/timezone.ts';
import { Icon } from '../components/Icon.tsx';
import { ExportButtons } from '../components/ExportButtons.tsx';

type AttendanceRow = {
  id: number; employee_id: number; employee_name: string;
  check_in: string; check_out: string | null; worked_hours: number | null;
  status: string; is_manually_edited: boolean;
  edit_reason: string | null; edited_by: string | null;
};

export function AttendancePage() {
  const [params] = useSearchParams();
  const { can, user, scopeOf } = useAuth();
  const employeeFilter = params.get('employee_id') ?? '';

  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [correcting, setCorrecting] = useState<AttendanceRow | null>(null);

  const path = `/attendance${queryString({
    employee_id: employeeFilter, status, from, to, page, page_size: 25,
  })}`;
  const { data, loading, error, reload } = useResource<Page<AttendanceRow>>(path);

  const columns: Array<Column<AttendanceRow>> = [
    { key: 'employee', header: 'Employee',
      render: (row) => <span style={{ fontWeight: 600 }}>{row.employee_name}</span> },
    { key: 'date', header: 'Date',
      render: (row) => formatDateTime(row.check_in).split(',')[0] },
    { key: 'check_in', header: 'Check in', render: (row) => formatTime(row.check_in) },
    { key: 'check_out', header: 'Check out',
      render: (row) => row.check_out === null
        ? <Badge variant="warning">Never checked out</Badge>
        : formatTime(row.check_out) },
    { key: 'worked_hours', header: 'Worked hours', numeric: true,
      render: (row) => row.worked_hours === null ? '—' : `${Number(row.worked_hours).toFixed(2)} h` },
    { key: 'status', header: 'Status',
      render: (row) => <Badge variant={stateVariant(row.status)}>{humanize(row.status)}</Badge> },
    { key: 'edited', header: 'Correction',
      render: (row) => row.is_manually_edited
        ? <span title={row.edit_reason ?? ''}>
            <Badge variant="info">Edited</Badge>
            <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{row.edited_by}</span>
          </span>
        : <span className="muted">—</span> },
    ...(can('attendance:correct')
      ? [{
          key: 'actions', header: '', numeric: true,
          render: (row: AttendanceRow) => (
            <button className="btn btn--sm" onClick={() => setCorrecting(row)}>Correct</button>
          ),
        }]
      : []),
  ];

  return (
    <>
      <div className="page__header">
        <div className="page__title">
          <h1>Attendance</h1>
          <span className="page__subtitle">
            Actual presence, exceptions included. Worked hours are computed by the database from the
            check-in and check-out, so they cannot disagree with them.
          </span>
        </div>
      </div>

      {/* Self-service punching. The API, the attendance:write permission and the
          "today only" rule behind it all existed; there was simply no control
          anywhere in the interface that used them, so the Employee role could
          not record its own attendance at all. */}
      {/* The employee's own screen only. HR, payroll and admin all hold
          attendance:write at scope 'all' and are themselves linked to employee
          records, so permission alone would show this to them too -- holding it
          is not the same question as "is this my attendance screen". The scope
          is what separates the two. */}
      {scopeOf('attendance:write') === 'own' && user?.employee_id != null && (
        <PunchClock employeeId={user.employee_id} onChanged={() => reload()} />
      )}

      {employeeFilter !== '' && (
        <div className="alert alert--info">
          <span>Showing attendance for one employee only.</span>
          <Link to="/attendance">Show everyone</Link>
        </div>
      )}
      {error !== null && <div className="error-box">{error}</div>}

      <Panel flush>
        <Toolbar
          right={
            <>
              <span className="toolbar__count">{data?.total ?? 0} records</span>
              <ExportButtons
                path="/attendance/export"
                name="attendance"
                query={{ employee_id: employeeFilter, status, from, to }}
              />
            </>
          }
        >
          <select className="select" style={{ width: 'auto' }} value={status}
            onChange={(event) => { setPage(1); setStatus(event.target.value); }}
            aria-label="Filter by status">
            {/* Only the two statuses the system actually writes. Late,
                Overtime and Left early were offered but never assigned by any
                code path, so selecting one always returned an empty table. */}
            <option value="">Any status</option>
            <option value="present">Present</option>
            <option value="missing_checkout">Missing check-out</option>
          </select>
          <input className="input" style={{ width: 'auto' }} type="date" value={from}
            onChange={(event) => { setPage(1); setFrom(event.target.value); }} aria-label="From date" />
          <input className="input" style={{ width: 'auto' }} type="date" value={to}
            onChange={(event) => { setPage(1); setTo(event.target.value); }} aria-label="To date" />
        </Toolbar>

        <DataTable columns={columns} rows={data?.rows ?? []} rowKey={(row) => row.id}
          loading={loading} emptyMessage="No attendance records match these filters." />
        <Pagination page={data?.page ?? 1} totalPages={data?.total_pages ?? 1}
          total={data?.total ?? 0} onPageChange={setPage} />
      </Panel>

      {correcting !== null && (
        <CorrectionModal
          record={correcting}
          onClose={() => setCorrecting(null)}
          onSaved={() => { setCorrecting(null); reload(); }}
        />
      )}
    </>
  );
}

function CorrectionModal({
  record, onClose, onSaved,
}: {
  record: AttendanceRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [checkIn, setCheckIn] = useState(toLocalInput(record.check_in));
  const [checkOut, setCheckOut] = useState(toLocalInput(record.check_out));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);
    setErrors({});

    if (reason.trim() === '') {
      setErrors({ edit_reason: 'Give a reason — it becomes part of the audit trail.' });
      return;
    }

    setBusy(true);
    try {
      await api.patch(`/attendance/${record.id}`, {
        employee_id: record.employee_id,
        check_in: fromLocalInput(checkIn),
        check_out: fromLocalInput(checkOut),
        edit_reason: reason,
      });
      onSaved();
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        const fields = error.fieldMap();
        if (Object.keys(fields).length > 0) setErrors(fields);
        else setFormError(error.message);
      } else {
        setFormError('Could not save the correction.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Correct attendance — ${record.employee_name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn--primary" form="correction-form" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save correction'}
          </button>
        </>
      }
    >
      {formError !== null && <div className="error-box" role="alert">{formError}</div>}

      <p className="muted" style={{ fontSize: 13 }}>
        This edit is attributed to you and recorded in the audit trail. The record will be marked as
        manually corrected wherever it appears.
      </p>

      <form id="correction-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="form-grid">
          <TextField label="Check in" name="check_in" type="datetime-local" required
            value={checkIn} error={errors.check_in}
            onChange={(event) => setCheckIn(event.target.value)} />
          <TextField label="Check out" name="check_out" type="datetime-local"
            value={checkOut} error={errors.check_out}
            hint="Leave blank if the employee genuinely never checked out."
            onChange={(event) => setCheckOut(event.target.value)} />
        </div>
        <TextAreaField label="Reason for correction" name="edit_reason" required
          value={reason} error={errors.edit_reason}
          placeholder="e.g. Badge reader outage; times confirmed with the reporting manager."
          onChange={(event) => setReason(event.target.value)} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------ punch clock -- */

/**
 * Check in, and later check out.
 *
 * Check-out is a correction in the API's terms -- it edits an existing record --
 * so it needs attendance:correct, which an ordinary employee does not have.
 * Rather than hand out that permission, closing your own open punch is a POST of
 * the completed record: the exclusion constraint means the open row has to go
 * first, which the server does inside the same transaction.
 */
/**
 * The employee's own attendance control: one toggle, which is the punch.
 *
 * On means a reader has them present -- an open attendance record for today.
 * Off closes it. The button's state is read from that record rather than kept
 * beside it, so it survives a reload and cannot drift from what the table
 * below shows: both are looking at the same rows.
 *
 * "Today" matters. A punch left open from a previous day stays in the table as
 * the missing check-out it is, and does not light this up -- otherwise turning
 * it off would try to close yesterday with today's clock, which the server
 * refuses and rightly so.
 *
 * There is no reader attached. Recording the punch is a real write either way;
 * what the wording claims is the only part that is ahead of the hardware.
 */
function PunchClock({ employeeId, onChanged }: { employeeId: number; onChanged: () => void }) {
  const today = todayInTenantZone();

  const open = useResource<Page<AttendanceRow>>(
    `/attendance${queryString({
      employee_id: employeeId, status: 'missing_checkout',
      from: today, to: today, page_size: 1,
    })}`,
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = open.data?.rows[0] ?? null;
  const on = current !== null;

  const toggle = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (current === null) {
        await api.post('/attendance', {
          employee_id: employeeId,
          check_in: new Date().toISOString(),
        });
      } else {
        await api.post(`/attendance/${current.id}/check-out`, {});
      }
      open.reload();
      // The table below is the record; it has to move when this does.
      onChanged();
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`punch${on ? ' punch--biometric' : ''}`}>
      <button
        type="button"
        className={`punch__toggle${on ? ' punch__toggle--on' : ''}`}
        aria-pressed={on}
        disabled={busy || open.loading}
        onClick={() => void toggle()}
      >
        <Icon name="fingerprint" />
        Biometric Attendance
        <span className="punch__toggle-state">
          {busy ? '…' : on ? 'On' : 'Off'}
        </span>
      </button>

      {error !== null && <span className="field__error" role="alert">{error}</span>}
    </div>
  );
}
