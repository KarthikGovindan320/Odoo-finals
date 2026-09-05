/**
 * How long a leave request actually is.
 *
 * This exists because the duration used to be whatever the client sent. Two
 * subsystems then disagreed about the same request: balance consumption drew
 * down the submitted amount, while payroll walked date_from..date_to and counted
 * every scheduled working day in it as paid leave. A request for the whole of
 * September with an amount of 0.5 therefore cost half a day of balance and
 * produced twenty-two days of paid leave.
 *
 * The fix is not to validate the client's number against the dates -- it is to
 * stop asking. The duration is derived here, from the same working-schedule days
 * that payroll counts in context_builder.ts, so the two cannot drift.
 */
import { AppError } from '../../errors/app_error.ts';
import type { TransactionClient } from '../../db/pool.ts';
import { dayOfWeek, eachDay } from '../payroll/period.ts';

/**
 * A period this long is a data-entry mistake rather than a leave request, and
 * walking it a day at a time is work we should decline to do.
 */
const MAX_LEAVE_DAYS = 366;

export type LeaveDuration = {
  /** Scheduled working days the leave covers. The figure balance is drawn by. */
  amount: number;
  /** Calendar days spanned, for the message when the two differ. */
  calendarDays: number;
};

/**
 * Which weekdays this employee is scheduled to work.
 *
 * Falls back to Monday–Friday when no schedule is assigned. A leave request is
 * not the right place to refuse over missing configuration -- payroll already
 * raises NO_SCHEDULE for that, and blocking the request would leave the employee
 * unable to record an absence they are actually taking.
 */
async function scheduledWeekdays(
  client: TransactionClient,
  employeeId: number,
): Promise<Set<number>> {
  const rows = await client.query<{ day_of_week: number }>(
    `SELECT DISTINCT l.day_of_week
       FROM employees e
       JOIN working_schedule_lines l ON l.working_schedule_id = e.working_schedule_id
      WHERE e.id = $1`,
    [employeeId],
  );

  if (rows.length === 0) {
    return new Set([1, 2, 3, 4, 5]);
  }
  return new Set(rows.map((row) => row.day_of_week));
}

/**
 * Counts the scheduled working days between two dates, inclusive.
 *
 * Deliberately counts days rather than hours even for an hour-unit leave type:
 * the half-day case is the only sub-day granularity the UI offers, and inventing
 * an hours figure from a date range would be a guess presented as a measurement.
 */
export async function deriveLeaveDuration(
  client: TransactionClient,
  input: { employeeId: number; dateFrom: string; dateTo: string },
): Promise<LeaveDuration> {
  const days = eachDay(input.dateFrom, input.dateTo);

  if (days.length === 0) {
    throw new AppError('validation_failed', 'Time off cannot end before it starts.', {
      fields: [{ field: 'date_to', message: 'Time off cannot end before it starts.' }],
    });
  }

  if (days.length > MAX_LEAVE_DAYS) {
    throw new AppError(
      'validation_failed',
      `That request spans ${days.length} days. A single request covers at most ${MAX_LEAVE_DAYS}.`,
      { fields: [{ field: 'date_to', message: 'This request covers too long a period.' }] },
    );
  }

  const working = await scheduledWeekdays(client, input.employeeId);
  const amount = days.filter((day) => working.has(dayOfWeek(day))).length;

  if (amount === 0) {
    throw new AppError(
      'validation_failed',
      'Those dates contain no working days for this employee, so there is no leave to take.',
      { fields: [{ field: 'date_from', message: 'No working days fall in this range.' }] },
    );
  }

  return { amount, calendarDays: days.length };
}
