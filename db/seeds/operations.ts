/**
 * Day-to-day HR activity: attendance punches, leave allocations and requests.
 *
 * Attendance is seeded with deliberate imperfection -- late arrivals, forgotten
 * check-outs, overtime, absences and a few authorised manual corrections -- because
 * a system that only ever sees clean data has not demonstrated that it handles
 * exceptions. The proportions are tuned so every attendance status appears in the
 * dashboard without the data looking like chaos.
 */
import { AppError } from '../../server/src/errors/app_error.ts';
import { consumeForRequest } from '../../server/src/services/time_off/consumption.ts';
import type { TransactionClient } from '../../server/src/db/pool.ts';
import { addDays, atLocalTime, dayOfWeek, eachDay, type IsoDate } from './dates.ts';
import type { Random } from './random.ts';
import type { ReferenceIds } from './reference_data.ts';
import type { SeededEmployee } from './people.ts';

type ScheduleLine = { day_of_week: number; start_time: string; end_time: string };

/** How far back attendance and leave history reaches. */
const HISTORY_MONTHS = 6;

/** Punches per INSERT. Large enough to matter, small enough to stay readable. */
const ATTENDANCE_BATCH = 1_000;

export async function seedAttendance(
  client: TransactionClient,
  employees: SeededEmployee[],
  random: Random,
  today: IsoDate,
  correctingUserId: number,
): Promise<number> {
  const lines = await client.query<ScheduleLine & { working_schedule_id: number }>(
    'SELECT working_schedule_id, day_of_week, start_time, end_time FROM working_schedule_lines',
  );

  const linesBySchedule = new Map<number, ScheduleLine[]>();
  for (const line of lines) {
    const bucket = linesBySchedule.get(line.working_schedule_id) ?? [];
    bucket.push(line);
    linesBySchedule.set(line.working_schedule_id, bucket);
  }

  const historyStart = addDays(today, -HISTORY_MONTHS * 30);
  let inserted = 0;
  const pending: PendingPunch[] = [];

  for (const employee of employees) {
    const schedule = linesBySchedule.get(employee.scheduleId) ?? [];
    const scheduledDays = new Map(schedule.map((line) => [line.day_of_week, line]));
    const from = employee.hireDate > historyStart ? employee.hireDate : historyStart;

    for (const day of eachDay(from, today)) {
      const line = scheduledDays.get(dayOfWeek(day));
      if (line === undefined) {
        continue;
      }

      // An absence is the absence of a record, not a row claiming zero hours.
      // The dashboard derives it as scheduled days minus attended days.
      if (random.chance(0.04)) {
        continue;
      }

      const [scheduledStartHour, scheduledStartMinute] = line.start_time.split(':').map(Number) as [number, number];
      const [scheduledEndHour, scheduledEndMinute] = line.end_time.split(':').map(Number) as [number, number];

      const isLate = random.chance(0.12);
      const lateMinutes = isLate ? random.int(16, 75) : random.int(-10, 12);

      // A real month has a handful of long days, not one every week. At 14% a
      // day, essentially every employee accrued overtime every month, which
      // made the figure meaningless. At 5%, roughly a third of employees have a
      // clean month -- which is what the dashboard's overtime count should mean.
      // Ordinary days drift by at most 14 minutes, inside the payroll grace, so
      // they contribute nothing.
      const worksOvertime = random.chance(0.05);
      const overtimeMinutes = worksOvertime ? random.int(65, 180) : random.int(-15, 14);

      const checkIn = shiftMinutes(day, scheduledStartHour, scheduledStartMinute, lateMinutes);
      const forgotCheckOut = random.chance(0.025);
      const checkOut = forgotCheckOut
        ? null
        : shiftMinutes(day, scheduledEndHour, scheduledEndMinute, overtimeMinutes);

      const status = forgotCheckOut
        ? 'missing_checkout'
        : worksOvertime
          ? 'overtime'
          : isLate
            ? 'late'
            : overtimeMinutes < -10
              ? 'early_leave'
              : 'present';

      const wasCorrected = !forgotCheckOut && random.chance(0.03);

      pending.push({
        employeeId: employee.id,
        checkIn,
        checkOut,
        status,
        wasCorrected,
        editedBy: wasCorrected ? correctingUserId : null,
        editedAt: wasCorrected ? checkIn : null,
        editReason: wasCorrected ? random.pick([
          'Employee forgot to check in; corrected from building access log.',
          'Badge reader outage, times confirmed with the reporting manager.',
          'Check-out recorded after the employee had already left.',
        ]) : null,
      });

      if (pending.length >= ATTENDANCE_BATCH) {
        inserted += await flushAttendance(client, pending);
      }
    }
  }

  inserted += await flushAttendance(client, pending);
  return inserted;
}

type PendingPunch = {
  employeeId: number;
  checkIn: string;
  checkOut: string | null;
  status: string;
  wasCorrected: boolean;
  editedBy: number | null;
  editedAt: string | null;
  editReason: string | null;
};

/**
 * Writes a batch of punches in one statement and empties the buffer.
 *
 * At the seed's full size this is around thirty thousand rows, and one INSERT
 * each meant thirty thousand round trips -- each also firing the audit trigger
 * and re-checking the overlap exclusion constraint. Batched, the seed is a
 * couple of minutes shorter and the transaction holds its locks for less time.
 *
 * Chunked rather than sent as one array so the parameter arrays stay a sane
 * size and a failure names a batch rather than the whole run.
 */
async function flushAttendance(
  client: TransactionClient,
  pending: PendingPunch[],
): Promise<number> {
  if (pending.length === 0) {
    return 0;
  }

  await client.query(
    `INSERT INTO attendance_records
       (employee_id, check_in, check_out, status, is_manually_edited,
        edited_by_user_id, edited_at, edit_reason)
     SELECT * FROM unnest(
       $1::bigint[], $2::timestamptz[], $3::timestamptz[], $4::text[],
       $5::boolean[], $6::bigint[], $7::timestamptz[], $8::text[]
     )`,
    [
      pending.map((row) => row.employeeId),
      pending.map((row) => row.checkIn),
      pending.map((row) => row.checkOut),
      pending.map((row) => row.status),
      pending.map((row) => row.wasCorrected),
      pending.map((row) => row.editedBy),
      pending.map((row) => row.editedAt),
      pending.map((row) => row.editReason),
    ] as never,
  );

  const written = pending.length;
  pending.length = 0;
  return written;
}

function shiftMinutes(day: IsoDate, hour: number, minute: number, offset: number): string {
  const total = hour * 60 + minute + offset;
  return atLocalTime(day, Math.floor(total / 60), total % 60);
}

export type TimeOffCounts = {
  allocations: number;
  requests: number;
  approved: number;
};

export async function seedTimeOff(
  client: TransactionClient,
  reference: ReferenceIds,
  employees: SeededEmployee[],
  random: Random,
  today: IsoDate,
  approverUserId: number,
): Promise<TimeOffCounts> {
  const types = await client.query<{
    id: number;
    code: string;
    name: string;
    requires_allocation: boolean;
  }>('SELECT id, code, name, requires_allocation FROM time_off_types');

  const allocatable = types.filter((type) => type.requires_allocation);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const yearEnd = `${today.slice(0, 4)}-12-31`;

  const counts: TimeOffCounts = { allocations: 0, requests: 0, approved: 0 };

  for (const employee of employees) {
    for (const type of allocatable) {
      // Not everyone gets every leave type, so balances differ across the list.
      if (type.code !== 'PAID' && random.chance(0.35)) {
        continue;
      }

      const amount = type.code === 'PAID' ? 18 : type.code === 'PARENTAL' ? 30 : random.int(6, 12);

      await client.query(
        `INSERT INTO time_off_allocations
           (employee_id, time_off_type_id, allocated_amount, valid_from, valid_to,
            state, approved_by_user_id, approved_at, notes)
         VALUES ($1, $2, $3, $4, $5, 'approved', $6, now(), $7)`,
        [employee.id, type.id, amount, yearStart, yearEnd, approverUserId, `Annual ${type.name} entitlement.`],
      );
      counts.allocations += 1;
    }
  }

  const historyStart = addDays(today, -HISTORY_MONTHS * 30);

  for (const employee of employees) {
    const requestCount = random.int(1, 5);
    // Approved leave may not overlap, so we track what this employee already has.
    const takenRanges: Array<[IsoDate, IsoDate]> = [];

    for (let index = 0; index < requestCount; index += 1) {
      const type = random.pick(types);
      const startOffset = random.int(0, HISTORY_MONTHS * 30 + 20);
      const dateFrom = addDays(historyStart, startOffset);
      const duration = random.int(1, 3);
      const dateTo = addDays(dateFrom, duration - 1);

      if (takenRanges.some(([from, to]) => dateFrom <= to && from <= dateTo)) {
        continue;
      }

      // Future-dated requests stay pending; past ones are mostly decided.
      const state = dateFrom > today
        ? 'to_approve'
        : random.chance(0.75)
          ? 'approved'
          : random.chance(0.5)
            ? 'refused'
            : 'to_approve';

      const amount = duration;

      const [row] = await client.query<{ id: number }>(
        `INSERT INTO time_off_requests
           (employee_id, time_off_type_id, date_from, date_to, requested_amount,
            state, reason, decided_by_user_id, decided_at, decision_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          employee.id,
          type.id,
          dateFrom,
          dateTo,
          amount,
          state,
          random.pick([
            'Family function.', 'Medical appointment.', 'Personal work.',
            'Travelling out of town.', 'Not feeling well.', 'Extending a long weekend.',
          ]),
          state === 'approved' || state === 'refused' ? approverUserId : null,
          state === 'approved' || state === 'refused' ? new Date().toISOString() : null,
          state === 'refused' ? 'Team coverage is too thin that week.' : '',
        ],
      );
      const requestId = (row as { id: number }).id;
      counts.requests += 1;

      if (state !== 'approved') {
        continue;
      }

      takenRanges.push([dateFrom, dateTo]);

      if (!type.requires_allocation) {
        counts.approved += 1;
        continue;
      }

      // Uses the same consumption service the approval endpoint uses, so the
      // seed cannot drift from production behaviour. A request with no matching
      // allocation is rolled back to pending rather than forced through.
      try {
        await consumeForRequest(client, {
          requestId,
          employeeId: employee.id,
          timeOffTypeId: type.id,
          typeName: type.name,
          dateFrom,
          dateTo,
          amount,
        });
        counts.approved += 1;
      } catch (error) {
        // Only a balance shortfall is a normal seeding outcome. Anything else --
        // a constraint violation, a lost connection -- has already aborted the
        // transaction, and swallowing it here would turn a real failure into a
        // confusing "current transaction is aborted" further down.
        if (!(error instanceof AppError) || error.code !== 'workflow_violation') {
          throw error;
        }
        await client.query(
          `UPDATE time_off_requests
              SET state = 'to_approve', decided_by_user_id = NULL, decided_at = NULL
            WHERE id = $1`,
          [requestId],
        );
        takenRanges.pop();
      }
    }
  }

  return counts;
}
