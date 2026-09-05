/**
 * Create and edit an employee.
 *
 * Validation runs through the same zod schema the server uses, so the browser's
 * message and the server's message are literally the same string. The client
 * check is there to save a round trip, not to be the check -- submitting anyway
 * would still be rejected, with the same wording.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';

import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/use_resource.ts';
import { useReference } from '../lib/use_reference.ts';
import { Modal } from '../components/Chrome.tsx';
import { SelectField, TextAreaField, TextField } from '../components/Field.tsx';
import { employeeInput } from '../../../shared/schemas/hr.ts';

type Reference = {
  departments: Array<{ id: number; name: string }>;
  job_positions: Array<{ id: number; title: string; department_id: number | null }>;
  employment_types: Array<{ id: number; name: string }>;
  working_schedules: Array<{ id: number; name: string; hours_per_week: number }>;
};

export type EmployeeFormValues = Record<string, string>;

const EMPTY: EmployeeFormValues = {
  first_name: '', last_name: '', work_email: '', personal_email: '',
  work_phone: '', department_id: '', job_position_id: '', employment_type_id: '',
  manager_id: '', working_schedule_id: '', hire_date: new Date().toISOString().slice(0, 10),
  status: 'active', termination_date: '', bank_name: '', bank_account_number: '',
  bank_ifsc: '', address: '',
};

type Props = {
  employeeId?: number;
  /** Shown when editing. Assigned by the database, never edited here. */
  employeeNumber?: string;
  initial?: EmployeeFormValues;
  onClose: () => void;
  onSaved: () => void;
};

export function EmployeeFormModal({ employeeId, employeeNumber, initial, onClose, onSaved }: Props) {
  const reference = useReference();
  const [values, setValues] = useState<EmployeeFormValues>({ ...EMPTY, ...initial });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: string) => (
    event: { target: { value: string } },
  ): void =>
    setValues((previous) => {
      const next = { ...previous, [name]: event.target.value };

      // Dependent fields are cleared with the field they hang off, so the form
      // cannot submit a stale value the user can no longer see or correct.
      if (name === 'department_id' && event.target.value !== previous.department_id) {
        // A position belongs to a department; keeping the old one submits a
        // position from a different department, which nothing downstream checks.
        next.job_position_id = '';
      }
      if (name === 'status' && event.target.value !== 'terminated') {
        // The termination date input is hidden for any other status, so leaving
        // a value behind produced a validation error against a field that was
        // not on screen.
        next.termination_date = '';
      }

      return next;
    });

  /** Blank optional selects and dates must go to the API as null, not ''. */
  const toPayload = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = { ...values };
    for (const key of [
      'department_id', 'job_position_id', 'employment_type_id', 'manager_id',
      'working_schedule_id', 'termination_date',
    ]) {
      if (payload[key] === '') payload[key] = null;
    }
    return payload;
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);

    // The same schema the server will apply, run here first so the user hears
    // about a bad email before a round trip rather than after.
    const parsed = employeeInput.safeParse(toPayload());
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.map(String).join('.'), issue.message]),
        ),
      );
      return;
    }

    setErrors({});
    setBusy(true);

    try {
      if (employeeId === undefined) {
        await api.post('/employees', parsed.data);
      } else {
        await api.patch(`/employees/${employeeId}`, parsed.data);
      }
      onSaved();
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        const fields = error.fieldMap();
        if (Object.keys(fields).length > 0) setErrors(fields);
        else setFormError(error.message);
      } else {
        setFormError('Could not save. The server did not respond.');
      }
    } finally {
      setBusy(false);
    }
  };

  const positions = (reference.data?.job_positions ?? []).filter(
    (position) =>
      values.department_id === '' ||
      position.department_id === null ||
      String(position.department_id) === values.department_id,
  );

  return (
    <Modal
      title={employeeId === undefined ? 'New employee' : 'Edit employee'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn--primary" form="employee-form" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {formError !== null && <div className="error-box" role="alert">{formError}</div>}

      <form id="employee-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="form-section">
          <div className="form-section__title">Identity</div>
          {employeeNumber !== undefined && (
            <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
              Employee number <span className="mono">{employeeNumber}</span> — issued on creation
              from the joining year, and fixed for the life of the record.
            </p>
          )}
          <div className="form-grid">
            <TextField label="First name" name="first_name" required
              value={values.first_name} error={errors.first_name} onChange={set('first_name')} />
            <TextField label="Last name" name="last_name" required
              value={values.last_name} error={errors.last_name} onChange={set('last_name')} />
            <TextField label="Work email" name="work_email" type="email" required
              value={values.work_email} error={errors.work_email} onChange={set('work_email')} />
            <TextField label="Personal email" name="personal_email" type="email"
              value={values.personal_email} error={errors.personal_email}
              onChange={set('personal_email')} />
            <TextField label="Work phone" name="work_phone"
              value={values.work_phone} error={errors.work_phone} onChange={set('work_phone')} />
          </div>
        </div>

        <div className="form-section">
          <div className="form-section__title">Work</div>
          <div className="form-grid">
            <SelectField label="Department" name="department_id" placeholder="No department"
              value={values.department_id} error={errors.department_id} onChange={set('department_id')}
              options={(reference.data?.departments ?? []).map((item) => ({ value: item.id, label: item.name }))} />
            <SelectField label="Job position" name="job_position_id" placeholder="No position"
              value={values.job_position_id} error={errors.job_position_id} onChange={set('job_position_id')}
              options={positions.map((item) => ({ value: item.id, label: item.title }))} />
            <SelectField label="Employee type" name="employment_type_id" placeholder="Not set"
              value={values.employment_type_id} error={errors.employment_type_id}
              onChange={set('employment_type_id')}
              options={(reference.data?.employment_types ?? []).map((item) => ({ value: item.id, label: item.name }))} />
            <SelectField label="Working schedule" name="working_schedule_id" placeholder="No schedule"
              hint="Used to work out expected days and hours for payroll."
              value={values.working_schedule_id} error={errors.working_schedule_id}
              onChange={set('working_schedule_id')}
              options={(reference.data?.working_schedules ?? []).map((item) => ({
                value: item.id, label: `${item.name} (${item.hours_per_week}h/week)`,
              }))} />
            <TextField label="Hire date" name="hire_date" type="date" required
              value={values.hire_date} error={errors.hire_date} onChange={set('hire_date')} />
            <SelectField label="Status" name="status" value={values.status} error={errors.status}
              onChange={set('status')}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'on_leave', label: 'On leave' },
                { value: 'terminated', label: 'Terminated' },
              ]} />
            {values.status === 'terminated' && (
              <TextField label="Termination date" name="termination_date" type="date" required
                value={values.termination_date} error={errors.termination_date}
                onChange={set('termination_date')} />
            )}
          </div>
        </div>

        <div className="form-section">
          <div className="form-section__title">Bank details</div>
          <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
            Missing bank details raise a warning on every payrun this employee appears in.
          </p>
          <div className="form-grid">
            <TextField label="Bank name" name="bank_name" value={values.bank_name}
              error={errors.bank_name} onChange={set('bank_name')} />
            <TextField label="Account number" name="bank_account_number"
              value={values.bank_account_number} error={errors.bank_account_number}
              onChange={set('bank_account_number')} />
            <TextField label="IFSC" name="bank_ifsc" value={values.bank_ifsc}
              error={errors.bank_ifsc} onChange={set('bank_ifsc')} />
          </div>
          <TextAreaField label="Address" name="address" value={values.address}
            error={errors.address} onChange={set('address')} />
        </div>
      </form>
    </Modal>
  );
}
