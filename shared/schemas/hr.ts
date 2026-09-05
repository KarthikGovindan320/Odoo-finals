/** Payload schemas for HR master data and day-to-day operations. */
import { z } from 'zod';

import {
  email,
  identifier,
  isoDate,
  isoDateTime,
  timeOfDay,
  optionalIdentifier,
  optionalText,
  positiveAmount,
  requiredText,
} from './common.ts';

/**
 * The employee record's fields, before any cross-field rule is applied.
 *
 * Kept separate from `employeeInput` so a PATCH can derive a partial version of
 * it. The cross-field rules below cannot run on a partial payload -- "a
 * terminated employee needs a termination date" is a question about the whole
 * record -- so a partial update is merged over the stored row and the merged
 * result is validated with the full schema. See employee_routes.ts.
 */
const employeeFields = z.object({
  // No employee_number. It is issued by the database as
  // EMP-<joining year>-<sequence> and never accepted from a caller: a format a
  // user can type is a format a user can mistype, and validating the input
  // would still leave them guessing which number is free.
  first_name: requiredText('First name', 80),
  last_name: requiredText('Last name', 80),
  work_email: email,
  personal_email: email.optional().or(z.literal('')),
  work_phone: optionalText(30),
  department_id: optionalIdentifier,
  job_position_id: optionalIdentifier,
  employment_type_id: optionalIdentifier,
  manager_id: optionalIdentifier,
  working_schedule_id: optionalIdentifier,
  hire_date: isoDate,
  // No .default() here on purpose -- see employeePatchInput below.
  status: z.enum(['active', 'on_leave', 'terminated']),
  termination_date: isoDate.nullable().optional(),
  bank_name: optionalText(120),
  bank_account_number: optionalText(34),
  bank_ifsc: optionalText(15),
  address: optionalText(400),
});

export const employeeInput = employeeFields
  .extend({ status: z.enum(['active', 'on_leave', 'terminated']).default('active') })
  .superRefine((value, ctx) => {
  // Mirrors the employee_termination_matches_status check constraint, so the user
  // hears about it from the form rather than from the database.
  if (value.status === 'terminated' && !value.termination_date) {
    ctx.addIssue({
      code: 'custom',
      path: ['termination_date'],
      message: 'A terminated employee needs a termination date.',
    });
  }
  if (value.status !== 'terminated' && value.termination_date) {
    ctx.addIssue({
      code: 'custom',
      path: ['termination_date'],
      message: 'Only a terminated employee can have a termination date.',
    });
  }
  if (value.termination_date && value.termination_date < value.hire_date) {
    ctx.addIssue({
      code: 'custom',
      path: ['termination_date'],
      message: 'Termination cannot be before the hire date.',
    });
  }
});

/** Contract fields without the cross-field rules. See employeeFields above. */
const contractFields = z.object({
  reference: requiredText('Contract reference', 60),
  employee_id: identifier,
  start_date: isoDate,
  end_date: isoDate.nullable().optional(),
  department_id: optionalIdentifier,
  job_position_id: optionalIdentifier,
  employment_type_id: optionalIdentifier,
  working_schedule_id: optionalIdentifier,
  wage: positiveAmount('Wage'),
  // Defaults are applied by contractInput, not here. See employeePatchInput.
  wage_type: z.enum(['monthly', 'hourly']),
  salary_structure_id: optionalIdentifier,
  state: z.enum(['draft', 'running', 'expired', 'cancelled']),
  notes: optionalText(1000),
});

export const contractInput = contractFields
  .extend({
    wage_type: z.enum(['monthly', 'hourly']).default('monthly'),
    state: z.enum(['draft', 'running', 'expired', 'cancelled']).default('draft'),
  })
  .superRefine((value, ctx) => {
  if (value.end_date && value.end_date < value.start_date) {
    ctx.addIssue({
      code: 'custom',
      path: ['end_date'],
      message: 'A contract cannot end before it starts.',
    });
  }
});

export const scheduleLineInput = z.object({
  day_of_week: z.coerce.number().int().min(0, 'Pick a day.').max(6, 'Pick a day.'),
  start_time: timeOfDay,
  end_time: timeOfDay,
  break_minutes: z.coerce.number().int().min(0, 'Break cannot be negative.').max(480).default(0),
}).superRefine((value, ctx) => {
  if (value.end_time <= value.start_time) {
    ctx.addIssue({ code: 'custom', path: ['end_time'], message: 'The end time must be after the start time.' });
    return;
  }
  const [startHour, startMinute] = value.start_time.split(':').map(Number) as [number, number];
  const [endHour, endMinute] = value.end_time.split(':').map(Number) as [number, number];
  const span = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
  if (value.break_minutes >= span) {
    ctx.addIssue({
      code: 'custom',
      path: ['break_minutes'],
      message: `The break cannot be as long as the ${span}-minute shift itself.`,
    });
  }
});

export const workingScheduleInput = z.object({
  name: requiredText('Schedule name', 120),
  schedule_type: z.enum(['full_time', 'part_time', 'flexible']).default('full_time'),
  timezone: requiredText('Timezone', 60).default('Asia/Kolkata'),
  lines: z.array(scheduleLineInput).min(1, 'A schedule needs at least one working day.'),
});

export const attendanceInput = z.object({
  employee_id: identifier,
  check_in: isoDateTime,
  check_out: isoDateTime.nullable().optional(),
  edit_reason: optionalText(300),
}).superRefine((value, ctx) => {
  // Compare instants, not strings. '2026-09-05T09:00:00+05:30' sorts after
  // '2026-09-05T10:00:00Z' lexically while being four and a half hours earlier,
  // so a string comparison here would pass a check-out that precedes check-in.
  if (value.check_out != null && Date.parse(value.check_out) <= Date.parse(value.check_in)) {
    ctx.addIssue({
      code: 'custom',
      path: ['check_out'],
      message: 'Check-out must be later than check-in.',
    });
  }
});

export const timeOffRequestInput = z.object({
  employee_id: identifier,
  time_off_type_id: identifier,
  date_from: isoDate,
  date_to: isoDate,
  reason: optionalText(500),
}).superRefine((value, ctx) => {
  if (value.date_to < value.date_from) {
    ctx.addIssue({ code: 'custom', path: ['date_to'], message: 'Time off cannot end before it starts.' });
  }
});

/**
 * Note what is NOT in the payload above: requested_amount.
 *
 * It used to be a free number the client sent alongside the dates, and nothing
 * reconciled the two. Balance was drawn down by the amount, while payroll
 * counted paid leave by walking the dates -- so a request for a whole month with
 * an amount of 0.5 cost half a day of balance and produced a month of paid
 * leave. The server now derives the duration from the dates and the employee's
 * working schedule, which is the only figure both halves can agree on.
 */

export const timeOffAllocationInput = z.object({
  employee_id: identifier,
  time_off_type_id: identifier,
  allocated_amount: positiveAmount('Allocated amount'),
  valid_from: isoDate,
  valid_to: isoDate,
  notes: optionalText(500),
}).superRefine((value, ctx) => {
  if (value.valid_to < value.valid_from) {
    ctx.addIssue({ code: 'custom', path: ['valid_to'], message: 'An allocation cannot expire before it starts.' });
  }
});

export const decisionInput = z.object({
  decision_note: optionalText(500),
});

/**
 * PATCH bodies: every field optional, no cross-field rules.
 *
 * Note that .partial() does NOT strip a .default() -- it wraps the field, and zod
 * still fills the default in for an absent key. A "partial" built over defaulted
 * fields therefore hands back status:'active' for a body that never mentioned
 * status, which is exactly the reset this is meant to prevent. So the create-time
 * defaults live on employeeInput/contractInput, and the shared field objects they
 * extend carry none.
 *
 * The route merges one of these over the stored record and validates the merged
 * result with the full schema.
 */
export const employeePatchInput = employeeFields.partial();
export const contractPatchInput = contractFields.partial();

export type EmployeeInput = z.infer<typeof employeeInput>;
export type ContractInput = z.infer<typeof contractInput>;
export type WorkingScheduleInput = z.infer<typeof workingScheduleInput>;
export type AttendanceInput = z.infer<typeof attendanceInput>;
export type TimeOffRequestInput = z.infer<typeof timeOffRequestInput>;
export type TimeOffAllocationInput = z.infer<typeof timeOffAllocationInput>;
