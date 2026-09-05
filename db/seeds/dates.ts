/**
 * Date helpers for seeding.
 *
 * Everything here works on 'YYYY-MM-DD' strings rather than Date objects. Bare
 * dates in this system are calendar facts -- a contract starts on the 1st
 * everywhere in the world -- and routing them through a Date would anchor them to
 * the process timezone and shift them by a day for anyone west of UTC.
 */
export type IsoDate = string;

export function toIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function parseIsoDate(value: IsoDate): Date {
  return new Date(`${value}T00:00:00Z`);
}

export function addDays(value: IsoDate, days: number): IsoDate {
  const date = parseIsoDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

export function addMonths(value: IsoDate, months: number): IsoDate {
  const date = parseIsoDate(value);
  date.setUTCMonth(date.getUTCMonth() + months);
  return toIsoDate(date);
}

export function startOfMonth(value: IsoDate): IsoDate {
  return `${value.slice(0, 7)}-01`;
}

export function endOfMonth(value: IsoDate): IsoDate {
  const date = parseIsoDate(startOfMonth(value));
  date.setUTCMonth(date.getUTCMonth() + 1);
  date.setUTCDate(0);
  return toIsoDate(date);
}

/** 0 = Sunday, matching working_schedule_lines.day_of_week. */
export function dayOfWeek(value: IsoDate): number {
  return parseIsoDate(value).getUTCDay();
}

export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const days: IsoDate[] = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    days.push(cursor);
  }
  return days;
}

export function daysBetweenInclusive(from: IsoDate, to: IsoDate): number {
  const millis = parseIsoDate(to).getTime() - parseIsoDate(from).getTime();
  return Math.round(millis / 86_400_000) + 1;
}

/** A timestamptz literal in the company timezone, for attendance punches. */
export function atLocalTime(date: IsoDate, hour: number, minute: number): string {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${date} ${hh}:${mm}:00+05:30`;
}
