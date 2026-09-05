/**
 * Attendance.
 *
 * Corrections are a separate permission from recording presence, and the form
 * insists on a reason -- the database refuses an edit that does not say who made
 * it and why, so the audit trail cannot have a hole exactly where it matters.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { FormEvent, ReactNode } from 'react';

import { api, ApiError, queryString } from '../lib/api.ts';
import { useResource, type Page } from '../lib/use_resource.ts';
import { formatDateTime, formatTime, humanize, stateVariant } from '../lib/format.ts';
import { useAuth } from '../lib/auth.tsx';
import { Badge, Modal, Panel, Toolbar } from '../components/Chrome.tsx';
import { DataTable, Pagination, type Column } from '../components/DataTable.tsx';
import { TextAreaField, TextField } from '../components/Field.tsx';
import { fromLocalInput, toLocalInput, todayInTenantZone } from '../lib/timezone.ts';
import { Icon } from '../components/Icon.tsx';
import { EmployeePicker } from '../components/EmployeePicker.tsx';
import { ExportButtons } from '../components/ExportButtons.tsx';

type AttendanceRow = {
  id: number; employee_id: number; employee_name: string;
  check_in: string; check_out: string | null; worked_hours: number | null;
  status: string; is_manually_edited: boolean;
  edit_reason: string | null; edited_by: string | null;
  voided_at: string | null; void_reason: string | null; voided_by: string | null;
  /** Whether this viewer outranks this record's employee. Decided by the server. */
  can_manage: boolean;
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
  const [voiding, setVoiding] = useState<AttendanceRow | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const restore = (row: AttendanceRow): void => {
    setBusy(row.id);
    setActionError(null);
    void api.post(`/attendance/${row.id}/restore`)
      .then(() => reload())
      .catch((caught: unknown) =>
        setActionError(caught instanceof ApiError || caught instanceof Error
          ? caught.message
          : 'The record could not be restored.'))
      .finally(() => setBusy(null));
  };

  const path = `/attendance${queryString({
    employee_id: employeeFilter, status, from, to, page, page_size: 25,
  })}`;
  const { data, loading, error, reload } = useResource<Page<AttendanceRow>>(path);

  /*
   * Voided rows are struck through rather than hidden. Removing them from the
   * list would make an invalidation indistinguishable from a record that never
   * existed, and the whole point of keeping the row is that somebody can see
   * what was decided and why.
   */
  const struck = (row: AttendanceRow, content: ReactNode): ReactNode =>
    row.voided_at === null ? content : <s className="voided">{content}</s>;

  const columns: Array<Column<AttendanceRow>> = [
    { key: 'employee', header: 'Employee',
      render: (row) => <span style={{ fontWeight: 600 }}>{row.employee_name}</span> },
    { key: 'date', header: 'Date',
      render: (row) => struck(row, formatDateTime(row.check_in).split(',')[0]) },
    { key: 'check_in', header: 'Check in', render: (row) => struck(row, formatTime(row.check_in)) },
    { key: 'check_out', header: 'Check out',
      render: (row) => row.check_out === null
        ? <Badge variant="warning">Never checked out</Badge>
        : struck(row, formatTime(row.check_out)) },
    { key: 'worked_hours', header: 'Worked hours', numeric: true,
      render: (row) => row.worked_hours === null
        ? '—'
        : struck(row, `${Number(row.worked_hours).toFixed(2)} h`) },
    { key: 'status', header: 'Status',
      render: (row) => row.voided_at !== null
        ? <Badge variant="danger">Invalidated</Badge>
        : <Badge variant={stateVariant(row.status)}>{humanize(row.status)}</Badge> },
    { key: 'edited', header: 'Note',
      render: (row) => {
        if (row.voided_at !== null) {
          return (
            <span title={row.void_reason ?? ''}>
              <span className="muted" style={{ fontSize: 11 }}>
                {row.void_reason} · {row.voided_by}
              </span>
            </span>
          );
        }
        return row.is_manually_edited
          ? <span title={row.edit_reason ?? ''}>
              <Badge variant="info">Edited</Badge>
              <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{row.edited_by}</span>
            </span>
          : <span className="muted">—</span>;
      } },
    ...(can('attendance:correct')
      ? [{
          key: 'actions', header: '', numeric: true,
          render: (row: AttendanceRow) => {
            // Nothing offered on a record this viewer does not outrank. The
            // server refuses it either way; showing the button and then the
            // refusal is a worse way to learn the same thing.
            if (!row.can_manage) {
              return <span className="muted" style={{ fontSize: 11 }}>Not yours to change</span>;
            }
            if (row.voided_at !== null) {
              return (
                <button className="btn btn--sm" disabled={busy === row.id}
                  onClick={() => restore(row)}>
                  {busy === row.id ? 'Restoring…' : 'Restore'}
                </button>
              );
            }
            return (
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <button className="btn btn--sm" onClick={() => setCorrecting(row)}>Correct</button>
                <button className="btn btn--sm btn--danger" onClick={() => setVoiding(row)}>
                  Invalidate
                </button>
              </span>
            );
          },
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
        {/* Recording on somebody else's behalf: a day the reader missed, a site
            with no reader, a person who forgot. Under attendance:correct rather
            than attendance:write, because everyone holds the latter for their
            own punches. */}
        {can('attendance:correct') && (
          <div className="page__actions">
            <button className="btn btn--primary" onClick={() => setRecording(true)}>
              Record for an employee
            </button>
          </div>
        )}
      </div>

      {actionError !== null && <div className="error-box" role="alert">{actionError}</div>}

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

      {voiding !== null && (
        <VoidModal
          record={voiding}
          onClose={() => setVoiding(null)}
          onSaved={() => { setVoiding(null); reload(); }}
        />
      )}

      {recording && (
        <ProxyEntryModal
          onClose={() => setRecording(false)}
          onSaved={() => { setRecording(false); reload(); }}
        />
      )}

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

/**
 * Declaring that a record did not happen.
 *
 * A separate control from Correct, and deliberately worded as a different act.
 * "This did not happen" and "this happened at a different time" are answers to
 * different questions, and the interface offered only the second -- so a
 * duplicate punch had to be edited into something meaningless, which leaves a
 * record that still counts.
 *
 * The reason is required and the button says what it will do, because this is
 * the control that removes hours from somebody's pay.
 */
function VoidModal({
  record, onClose, onSaved,
}: {
  record: AttendanceRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    void api.post(`/attendance/${record.id}/void`, { reason })
      .then(onSaved)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError || caught instanceof Error
          ? caught.message
          : 'The record could not be invalidated.'))
      .finally(() => setSaving(false));
  };

  return (
    <Modal
      title={`Invalidate attendance — ${record.employee_name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn--danger" onClick={submit} disabled={saving || reason.trim().length < 8}>
            {saving ? 'Invalidating…' : 'Invalidate this record'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        {error !== null && <div className="error-box" role="alert">{error}</div>}

        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          {formatDateTime(record.check_in)}
          {record.check_out !== null && ` → ${formatTime(record.check_out)}`}
          {record.worked_hours !== null && ` · ${Number(record.worked_hours).toFixed(2)} h`}
        </p>
        <p style={{ fontSize: 13 }}>
          The record is kept and shown struck through, and stops counting towards worked hours,
          payroll and every total. It can be restored if this turns out to be wrong.
        </p>

        <TextAreaField
          label="Why is this record invalid?"
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          hint="A duplicate of which punch, which reader misfired, whose record it should have been."
        />
      </form>
    </Modal>
  );
}

/**
 * Recording attendance on somebody else's behalf.
 *
 * The endpoint already accepted this -- attendance:correct has always been
 * allowed to enter a record for another employee on a past date -- but the only
 * way to reach it was the API. Which employee is offered is bounded by the
 * server, not here: a request for somebody at or above the caller's own level is
 * refused, and the refusal says so.
 */
function ProxyEntryModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [employeeId, setEmployeeId] = useState('');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    void api.post('/attendance', {
      employee_id: Number(employeeId),
      check_in: fromLocalInput(checkIn),
      // An open record is a legitimate thing to enter: somebody checked in and
      // the day is not over, or the check-out genuinely is not known yet.
      check_out: checkOut === '' ? null : fromLocalInput(checkOut),
    })
      .then(onSaved)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError || caught instanceof Error
          ? caught.message
          : 'The record could not be saved.'))
      .finally(() => setSaving(false));
  };

  return (
    <Modal
      title="Record attendance for an employee"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn--primary" onClick={submit}
            disabled={saving || employeeId === '' || checkIn === ''}>
            {saving ? 'Saving…' : 'Save record'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        {error !== null && <div className="error-box" role="alert">{error}</div>}

        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          For a day the reader missed, a site without one, or somebody who forgot. The record is
          entered against your account and appears in the audit trail.
        </p>

        <EmployeePicker
          label="Employee"
          required
          value={employeeId}
          onChange={setEmployeeId}
        />
        <TextField
          label="Check in"
          type="datetime-local"
          required
          value={checkIn}
          onChange={(event) => setCheckIn(event.target.value)}
        />
        <TextField
          label="Check out"
          type="datetime-local"
          value={checkOut}
          onChange={(event) => setCheckOut(event.target.value)}
          hint="Leave empty if the day is still open."
        />
      </form>
    </Modal>
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
        <span className="punch__toggle-state">
          {busy ? '…' : on ? 'Check in' : 'Check out'}
        </span>
      </button>

      {error !== null && <span className="field__error" role="alert">{error}</span>}
    </div>
  );
}
