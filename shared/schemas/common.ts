/**
 * Validation schemas shared by the server and the browser.
 *
 * One definition, imported by both, is the whole point. An invalid email should
 * tell the user the email is invalid, and the surest way for that to be true on
 * both sides is for there to be only one rule to be true about.
 * The server still validates independently; the client just gets the same answer
 * sooner, in the same words.
 */
import { z } from 'zod';

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD.')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'That is not a real date.');

/**
 * An absolute instant: ISO 8601 with a date, a time, and an offset or Z.
 *
 * Validated here rather than left to Postgres. `z.string().min(1)` accepted any
 * non-empty text and handed it to a timestamptz column, so a mistyped time came
 * back as 22007 from the driver and, unmapped, as a 500 — telling a user that
 * something had gone wrong on our side when they had simply typed a bad date.
 *
 * The offset is required. Without one the instant depends on whoever parses it,
 * which for attendance is the difference between two calendar days.
 */
export const isoDateTime = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/,
    'Enter a date and time including a timezone, e.g. 2026-09-05T09:30:00+05:30.',
  )
  .refine((value) => !Number.isNaN(Date.parse(value)), 'That is not a real date and time.');

/** A wall-clock time of day, bounded to real hours and minutes. */
export const timeOfDay = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time as HH:MM, between 00:00 and 23:59.');

/**
 * Upper bounds matching the numeric(p,s) columns behind these fields, so an
 * out-of-range amount is a field error rather than a 22003 from the driver.
 */
export const MAX_LEAVE_AMOUNT = 999_999.99; // numeric(8,2)
export const MAX_RULE_AMOUNT = 9_999_999_999.99; // numeric(12,2)

export const email = z
  .string()
  .trim()
  .min(1, 'An email address is required.')
  .email('That email address is not valid. It should look like name@example.com.');

export const requiredText = (label: string, max = 200) =>
  z.string().trim().min(1, `${label} is required.`).max(max, `${label} must be ${max} characters or fewer.`);

export const optionalText = (max = 500) =>
  z.string().trim().max(max, `Must be ${max} characters or fewer.`).optional().or(z.literal(''));

export const positiveAmount = (label: string) =>
  z.coerce
    .number({ message: `${label} must be a number.` })
    .positive(`${label} must be greater than zero.`)
    .max(99_999_999, `${label} is unrealistically large.`);

export const identifier = z.coerce
  .number({ message: 'Expected a record id.' })
  .int('Record ids are whole numbers.')
  .positive('Record ids are positive.');

export const optionalIdentifier = identifier.nullable().optional();

// An `orderedDates` helper used to sit here, exported and never imported: every
// schema hand-rolls the same two-line refinement instead, because each names its
// own fields (end_date, valid_to, date_to, period_end) and the shared version
// could only express one of them. Removed rather than kept as a sixth copy that
// happens to be unreachable.

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(120).optional(),
  sort: z.string().trim().max(60).optional(),
});

export type Pagination = z.infer<typeof paginationQuery>;

/**
 * Which file an export should produce.
 *
 * Defaulting to csv rather than requiring the parameter: a bare /export URL in a
 * browser then gives something openable instead of a validation error.
 */
export const exportFormat = z.enum(['csv', 'xlsx']).default('csv');
