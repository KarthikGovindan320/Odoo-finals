/**
 * Company-wide settings that the browser, the server and the SQL all have to
 * agree on.
 *
 * The timezone was previously written out at eleven separate call sites -- in
 * migrations, in route SQL, in the payroll context builder, in display
 * formatting and twice as a raw '+05:30' in the attendance form. Eleven copies
 * of a constant is eleven chances for one of them to be changed alone.
 *
 * Note that working_schedules.timezone exists as a column but is not what
 * decides this: attendance is bucketed into days for payroll, and a payroll day
 * is a company-level fact, not a per-schedule one. The column is retained for
 * display and is documented as such.
 */

/** The timezone every payroll day boundary is measured in. */
export const TENANT_TIMEZONE = 'Asia/Kolkata';
