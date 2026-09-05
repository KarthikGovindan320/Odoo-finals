/**
 * Wall-clock conversion for the tenant's timezone.
 *
 * The browser's own timezone is never used. Attendance is a fact about when
 * someone was at work, and that is answered in the timezone the company keeps —
 * not in whatever zone the laptop reading the record happens to be set to.
 *
 * Everything here goes through Intl with an explicit `timeZone`, so no fixed
 * offset is baked in anywhere. Asia/Kolkata has no daylight saving today, but
 * writing `+05:30` by hand is how a correct-looking conversion silently becomes
 * wrong the moment the constant below changes.
 */
import { TENANT_TIMEZONE } from '../../../shared/tenant.ts';

export { TENANT_TIMEZONE };

/**
 * The tenant zone's offset from UTC, in minutes, at a given instant.
 *
 * Works by formatting the instant in the zone, reading that wall clock back as
 * if it were UTC, and taking the difference.
 */
function offsetMinutesAt(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TENANT_TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);

  const field = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    // Intl can render midnight as hour 24 in some engines.
    field('hour') % 24,
    field('minute'),
    field('second'),
  );

  return (asIfUtc - instant.getTime()) / 60_000;
}

/**
 * A timestamp to the `YYYY-MM-DDTHH:mm` a datetime-local input expects, read in
 * the tenant timezone.
 *
 * The 'sv-SE' locale is used because it formats as `YYYY-MM-DD HH:mm` natively,
 * which is the input's format with one character changed.
 */
export function toLocalInput(value: string | null): string {
  if (value === null || value === '') {
    return '';
  }

  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TENANT_TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
    .format(instant)
    .replace(' ', 'T');
}

/**
 * The inverse: a wall clock the user typed, back to an absolute timestamp.
 *
 * The offset is resolved twice. A wall clock does not by itself say which offset
 * applies, and near a daylight-saving boundary the first guess can land on the
 * wrong side of it; re-reading the offset at the candidate instant settles it.
 */
export function fromLocalInput(value: string): string | null {
  if (value === '') {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (match === null) {
    return null;
  }

  const [, year, month, day, hour, minute] = match as unknown as [string, string, string, string, string, string];
  const asIfUtc = Date.UTC(+year, +month - 1, +day, +hour, +minute, 0);

  let instant = new Date(asIfUtc - offsetMinutesAt(new Date(asIfUtc)) * 60_000);
  instant = new Date(asIfUtc - offsetMinutesAt(instant) * 60_000);

  return instant.toISOString();
}

/** Today's date in the tenant timezone, as YYYY-MM-DD. */
export function todayInTenantZone(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TENANT_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
