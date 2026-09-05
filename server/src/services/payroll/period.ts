/**
 * Calendar arithmetic for payroll periods.
 *
 * Bare dates are handled as 'YYYY-MM-DD' strings throughout. Converting them to
 * Date objects would anchor a calendar fact to the process timezone, which is how
 * a contract that starts on the 1st ends up starting on the 31st for anyone west
 * of UTC -- and payroll boundaries are exactly where that bug costs money.
 */
const MILLIS_PER_DAY = 86_400_000;

function toUtc(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}

export function addDays(value: string, days: number): string {
  return new Date(toUtc(value) + days * MILLIS_PER_DAY).toISOString().slice(0, 10);
}

export function inclusiveDayCount(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / MILLIS_PER_DAY) + 1;
}

/** Days shared by two inclusive ranges; an open-ended range has no upper bound. */
export function daysOverlapping(
  firstStart: string,
  firstEnd: string | null,
  secondStart: string,
  secondEnd: string,
): number {
  const start = firstStart > secondStart ? firstStart : secondStart;
  const end = firstEnd === null || firstEnd > secondEnd ? secondEnd : firstEnd;

  if (start > end) {
    return 0;
  }
  return inclusiveDayCount(start, end);
}

/** 0 = Sunday, matching working_schedule_lines.day_of_week. */
export function dayOfWeek(value: string): number {
  return new Date(toUtc(value)).getUTCDay();
}

export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    days.push(cursor);
  }
  return days;
}
