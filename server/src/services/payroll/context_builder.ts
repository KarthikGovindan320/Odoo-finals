/**
 * Assembles the context a payslip is computed from.
 *
 * This is where the four HR modules converge: the contract supplies the wage, the
 * working schedule supplies what was expected, attendance supplies what happened,
 * and approved time off supplies why the difference is or is not the employee's
 * problem. Everything downstream is arithmetic over these numbers.
 *
 * Definitions chosen here, recorded in plan.md and defensible on their own:
 *   scheduled_days   working days in the period per the schedule, restricted to
 *                    the days the contract actually covers
 *   attended_days    distinct days with at least one attendance record
 *   paid_days        scheduled days minus unpaid leave days -- what the employee
 *                    is owed pay for, which is the proration numerator
 *   overtime_hours   per day, hours beyond that day's scheduled hours, summed.
 *                    Per day rather than per period, so a short Monday cannot
 *                    silently finance a long Friday
 *   leave days       counted only on scheduled working days, because leave on a
 *                    rest day is not leave
 */
import type { TransactionClient } from '../../db/pool.ts';
import type { PayslipContext } from './rule_engine.ts';
import type { ResolvedContract } from './contract_resolver.ts';
import { dayOfWeek, eachDay, inclusiveDayCount } from './period.ts';

export type WorkedSummary = {
  scheduled_days: number;
  attended_days: number;
  paid_days: number;
  paid_leave_days: number;
  unpaid_leave_days: number;
  worked_hours: number;
  overtime_hours: number;
  proration_factor: number;
  schedule_hours_per_week: number;
};

type ScheduleLine = { day_of_week: number; worked_minutes: number };

type AttendanceDay = { work_date: string; worked_hours: number };

type LeaveRow = {
  date_from: string;
  date_to: string;
  is_paid: boolean;
};

async function loadSchedule(
  client: TransactionClient,
  scheduleId: number | null,
): Promise<{ lines: Map<number, number>; hoursPerWeek: number }> {
  if (scheduleId === null) {
    return { lines: new Map(), hoursPerWeek: 0 };
  }

  const lines = await client.query<ScheduleLine>(
    'SELECT day_of_week, worked_minutes FROM working_schedule_lines WHERE working_schedule_id = $1',
    [scheduleId],
  );
  const schedule = await client.queryOne<{ hours_per_week: number }>(
    'SELECT hours_per_week FROM working_schedules WHERE id = $1',
    [scheduleId],
  );

  return {
    lines: new Map(lines.map((line) => [line.day_of_week, line.worked_minutes / 60])),
    hoursPerWeek: schedule?.hours_per_week ?? 0,
  };
}

export async function buildWorkedSummary(
  client: TransactionClient,
  input: {
    employeeId: number;
    contract: ResolvedContract;
    fallbackScheduleId: number | null;
    periodStart: string;
    periodEnd: string;
  },
): Promise<WorkedSummary> {
  const scheduleId = input.contract.working_schedule_id ?? input.fallbackScheduleId;
  const { lines: hoursByWeekday, hoursPerWeek } = await loadSchedule(client, scheduleId);

  const contractStart =
    input.contract.start_date > input.periodStart ? input.contract.start_date : input.periodStart;
  const contractEnd =
    input.contract.end_date !== null && input.contract.end_date < input.periodEnd
      ? input.contract.end_date
      : input.periodEnd;

  // Scheduled days across the whole period, and across only the part the contract
  // covers. Their ratio is the proration factor.
  let scheduledDaysInPeriod = 0;
  const scheduledDates = new Set<string>();

  for (const day of eachDay(input.periodStart, input.periodEnd)) {
    if (!hoursByWeekday.has(dayOfWeek(day))) {
      continue;
    }
    scheduledDaysInPeriod += 1;
    if (day >= contractStart && day <= contractEnd) {
      scheduledDates.add(day);
    }
  }

  const scheduledDays = scheduledDates.size;

  const attendance = await client.query<AttendanceDay>(
    `SELECT (check_in AT TIME ZONE 'Asia/Kolkata')::date::text AS work_date,
            SUM(COALESCE(worked_hours, 0))                     AS worked_hours
       FROM attendance_records
      WHERE employee_id = $1
        AND (check_in AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date
      GROUP BY 1`,
    [input.employeeId, contractStart, contractEnd],
  );

  let workedHours = 0;
  let overtimeHours = 0;
  let attendedDays = 0;

  for (const day of attendance) {
    if (!scheduledDates.has(day.work_date)) {
      // Work on an unscheduled day is entirely overtime.
      workedHours += day.worked_hours;
      overtimeHours += day.worked_hours;
      continue;
    }

    attendedDays += 1;
    workedHours += day.worked_hours;

    const expected = hoursByWeekday.get(dayOfWeek(day.work_date)) ?? 0;
    if (day.worked_hours > expected) {
      overtimeHours += day.worked_hours - expected;
    }
  }

  const leaves = await client.query<LeaveRow>(
    `SELECT r.date_from::text, r.date_to::text, t.is_paid
       FROM time_off_requests r
       JOIN time_off_types t ON t.id = r.time_off_type_id
      WHERE r.employee_id = $1
        AND r.state = 'approved'
        AND r.leave_period && daterange($2::date, $3::date, '[]')`,
    [input.employeeId, contractStart, contractEnd],
  );

  let paidLeaveDays = 0;
  let unpaidLeaveDays = 0;

  for (const leave of leaves) {
    const from = leave.date_from > contractStart ? leave.date_from : contractStart;
    const to = leave.date_to < contractEnd ? leave.date_to : contractEnd;

    // Only scheduled working days count. Leave over a weekend is not leave.
    const days = eachDay(from, to).filter((day) => scheduledDates.has(day)).length;
    if (leave.is_paid) {
      paidLeaveDays += days;
    } else {
      unpaidLeaveDays += days;
    }
  }

  const paidDays = Math.max(scheduledDays - unpaidLeaveDays, 0);
  const prorationFactor =
    scheduledDaysInPeriod === 0 ? 1 : Math.min(scheduledDays / scheduledDaysInPeriod, 1);

  return {
    scheduled_days: scheduledDays,
    attended_days: attendedDays,
    paid_days: paidDays,
    paid_leave_days: paidLeaveDays,
    unpaid_leave_days: unpaidLeaveDays,
    worked_hours: Math.round(workedHours * 100) / 100,
    overtime_hours: Math.round(overtimeHours * 100) / 100,
    proration_factor: Math.round(prorationFactor * 10000) / 10000,
    schedule_hours_per_week: hoursPerWeek,
  };
}

export function toPayslipContext(
  employeeId: number,
  hireDate: string,
  contract: ResolvedContract,
  worked: WorkedSummary,
  periodStart: string,
  periodEnd: string,
): PayslipContext {
  const seniorityDays = inclusiveDayCount(hireDate, periodEnd);

  return {
    employee: {
      id: employeeId,
      seniority_years: Math.floor(seniorityDays / 365),
    },
    contract: {
      wage: contract.wage,
      schedule_hours_per_week: worked.schedule_hours_per_week,
    },
    period: {
      calendar_days: inclusiveDayCount(periodStart, periodEnd),
    },
    worked: {
      scheduled_days: worked.scheduled_days,
      attended_days: worked.attended_days,
      paid_days: worked.paid_days,
      paid_leave_days: worked.paid_leave_days,
      unpaid_leave_days: worked.unpaid_leave_days,
      worked_hours: worked.worked_hours,
      overtime_hours: worked.overtime_hours,
      proration_factor: worked.proration_factor,
    },
  };
}
