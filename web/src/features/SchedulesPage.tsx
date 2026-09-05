/**
 * Working schedules.
 *
 * Weekly hours are shown, never entered: the total comes from the day lines,
 * computed by the database. Editing a line and watching the total move is the
 * quickest way to see that the derivation is real.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';

import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/use_resource.ts';
import { TENANT_TIMEZONE } from '../../../shared/tenant.ts';
import { DAY_NAMES, humanize } from '../lib/format.ts';
import { useAuth } from '../lib/auth.tsx';
import { Badge, Modal, Panel } from '../components/Chrome.tsx';
import { TextField } from '../components/Field.tsx';
import { workingScheduleInput } from '../../../shared/schemas/hr.ts';

type ScheduleRow = {
  id: number; name: string; schedule_type: string;
  timezone: string; hours_per_week: number; employee_count: number;
};

type ScheduleLine = {
  id: number; day_of_week: number; start_time: string; end_time: string;
  break_minutes: number; worked_minutes: number;
};

export function SchedulesPage() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useResource<{ rows: ScheduleRow[] }>('/working-schedules');
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<(ScheduleRow & { lines: ScheduleLine[] }) | null>(null);

  return (
    <>
      <div className="page__header">
        <div className="page__title">
          <h1>Working Schedules</h1>
          <span className="page__subtitle">
            Weekly patterns. Total hours are calculated from the day lines, never typed in.
          </span>
        </div>
        {can('schedule:write') && (
          <div className="page__actions">
            <button className="btn btn--primary" onClick={() => setCreating(true)}>New schedule</button>
          </div>
        )}
      </div>

      {error !== null && <div className="error-box">{error}</div>}

      <Panel flush>
        {loading ? (
          <div className="loading">Loading…</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th><th>Type</th><th>Timezone</th>
                <th className="table__num">Hours / week</th>
                <th className="table__num">Employees</th><th />
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((row) => (
                <tr key={row.id}>
                  <td style={{ fontWeight: 600 }}>{row.name}</td>
                  <td><Badge>{humanize(row.schedule_type)}</Badge></td>
                  <td className="muted">{row.timezone}</td>
                  <td className="table__num"><strong>{Number(row.hours_per_week)}</strong></td>
                  <td className="table__num">{row.employee_count}</td>
                  <td className="table__num">
                    <button className="btn btn--sm" onClick={() => setOpenId(row.id)}>View pattern</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {openId !== null && (
        <ScheduleDetailModal
          id={openId}
          canEdit={can('schedule:write')}
          onEdit={(schedule) => { setOpenId(null); setEditing(schedule); }}
          onClose={() => setOpenId(null)}
        />
      )}
      {editing !== null && (
        <ScheduleFormModal
          schedule={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
      {creating && (
        <ScheduleFormModal onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); reload(); }} />
      )}
    </>
  );
}

function ScheduleDetailModal({
  id, canEdit, onEdit, onClose,
}: {
  id: number;
  canEdit: boolean;
  onEdit: (schedule: ScheduleRow & { lines: ScheduleLine[] }) => void;
  onClose: () => void;
}) {
  const { data, loading } = useResource<ScheduleRow & { lines: ScheduleLine[] }>(
    `/working-schedules/${id}`,
  );

  return (
    <Modal
      title={data?.name ?? 'Working schedule'}
      onClose={onClose}
      footer={
        canEdit && data !== null ? (
          <button type="button" className="btn btn--primary" onClick={() => onEdit(data)}>
            Edit schedule
          </button>
        ) : undefined
      }
    >
      {loading || data === null ? (
        <div className="loading">Loading…</div>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            {Number(data.hours_per_week)} hours per week across {data.lines.length} working day
            {data.lines.length === 1 ? '' : 's'}, computed from the lines below.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Day</th><th>Start</th><th>End</th>
                <th className="table__num">Break</th><th className="table__num">Worked</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line) => (
                <tr key={line.id}>
                  <td>{DAY_NAMES[line.day_of_week]}</td>
                  <td>{line.start_time.slice(0, 5)}</td>
                  <td>{line.end_time.slice(0, 5)}</td>
                  <td className="table__num">{line.break_minutes} min</td>
                  <td className="table__num">
                    <strong>{(line.worked_minutes / 60).toFixed(2)} h</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}

type DraftLine = { day_of_week: number; start_time: string; end_time: string; break_minutes: number };

/**
 * Create or edit a working schedule.
 *
 * PATCH /working-schedules/:id existed with nothing calling it, so a schedule's
 * days could never be corrected once saved -- and the schedule is what payroll
 * counts scheduled days from, so a wrong one is a wrong payslip every month.
 */
function ScheduleFormModal({
  schedule, onClose, onSaved,
}: {
  schedule?: { id: number; name: string; schedule_type: string; lines: ScheduleLine[] };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(schedule?.name ?? '');
  const [scheduleType, setScheduleType] = useState(schedule?.schedule_type ?? 'full_time');
  const [lines, setLines] = useState<DraftLine[]>(
    schedule !== undefined
      ? schedule.lines.map((line) => ({
          day_of_week: line.day_of_week,
          // The API returns times as HH:MM:SS; the input wants HH:MM.
          start_time: line.start_time.slice(0, 5),
          end_time: line.end_time.slice(0, 5),
          break_minutes: line.break_minutes,
        }))
      : [1, 2, 3, 4, 5].map((day) => ({
          day_of_week: day, start_time: '09:00', end_time: '18:00', break_minutes: 60,
        })),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Mirrors the database's own arithmetic so the preview matches what will be
  // stored, without waiting for a round trip.
  const previewHours = lines.reduce((total, line) => {
    const [startHour, startMinute] = line.start_time.split(':').map(Number) as [number, number];
    const [endHour, endMinute] = line.end_time.split(':').map(Number) as [number, number];
    const minutes = (endHour * 60 + endMinute) - (startHour * 60 + startMinute) - line.break_minutes;
    return total + Math.max(minutes, 0);
  }, 0) / 60;

  const updateLine = (index: number, patch: Partial<DraftLine>): void =>
    setLines((previous) => previous.map((line, position) =>
      position === index ? { ...line, ...patch } : line));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);

    const parsed = workingScheduleInput.safeParse({
      name, schedule_type: scheduleType, timezone: TENANT_TIMEZONE, lines,
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.map(String).join('.'), issue.message]),
      ));
      return;
    }

    setErrors({});
    setBusy(true);
    try {
      if (schedule === undefined) {
        await api.post('/working-schedules', parsed.data);
      } else {
        await api.patch(`/working-schedules/${schedule.id}`, parsed.data);
      }
      onSaved();
    } catch (error: unknown) {
      setFormError(error instanceof ApiError ? error.message : 'Could not save the schedule.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={schedule === undefined ? 'New working schedule' : `Edit ${schedule.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn--primary" form="schedule-form" type="submit" disabled={busy}>
            {busy ? 'Saving…' : schedule === undefined ? 'Create schedule' : 'Save changes'}
          </button>
        </>
      }
    >
      {formError !== null && <div className="error-box" role="alert">{formError}</div>}
      {Object.entries(errors).map(([field, message]) => (
        <div className="error-box" key={field}>{message}</div>
      ))}

      <form id="schedule-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="form-grid">
          <TextField label="Schedule name" name="name" required value={name}
            error={errors.name} onChange={(event) => setName(event.target.value)} />
          <label className="field">
            <span className="field__label">Type</span>
            <select className="select" value={scheduleType}
              onChange={(event) => setScheduleType(event.target.value)}>
              <option value="full_time">Full time</option>
              <option value="part_time">Part time</option>
              <option value="flexible">Flexible</option>
            </select>
          </label>
        </div>

        <div className="form-section__title" style={{ marginTop: 16 }}>
          Weekly pattern — {previewHours.toFixed(2)} hours per week
        </div>

        <table className="table">
          <thead>
            <tr><th>Day</th><th>Start</th><th>End</th><th>Break (min)</th><th /></tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td>
                  <select className="select" value={line.day_of_week}
                    onChange={(event) => updateLine(index, { day_of_week: Number(event.target.value) })}>
                    {DAY_NAMES.map((day, dayIndex) => (
                      <option key={day} value={dayIndex}>{day}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input className="input" type="time" value={line.start_time}
                    onChange={(event) => updateLine(index, { start_time: event.target.value })} />
                </td>
                <td>
                  <input className="input" type="time" value={line.end_time}
                    onChange={(event) => updateLine(index, { end_time: event.target.value })} />
                </td>
                <td>
                  <input className="input" type="number" min={0} value={line.break_minutes}
                    onChange={(event) => updateLine(index, { break_minutes: Number(event.target.value) })} />
                </td>
                <td>
                  <button type="button" className="btn btn--sm btn--danger"
                    onClick={() => setLines((previous) => previous.filter((_, position) => position !== index))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button type="button" className="btn btn--sm" style={{ marginTop: 8 }}
          onClick={() => setLines((previous) => [...previous, {
            day_of_week: 1, start_time: '09:00', end_time: '18:00', break_minutes: 60,
          }])}>
          Add day
        </button>
      </form>
    </Modal>
  );
}
