/** Payload schemas for HR master data and day-to-day operations. */
import { z } from 'zod';

import {
  email,
  identifier,
  isoDate,
  optionalIdentifier,
  optionalText,
  positiveAmount,
  requiredText,
} from './common.ts';

export const employeeInput = z.object({
  employee_number: requiredText('Employee number', 20),
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
  status: z.enum(['active', 'on_leave', 'terminated']).default('active'),
  termination_date: isoDate.nullable().optional(),
  bank_name: optionalText(120),
  bank_account_number: optionalText(34),
  bank_ifsc: optionalText(15),
  address: optionalText(400),
}).superRefine((value, ctx) => {
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

export const contractInput = z.object({
  reference: requiredText('Contract reference', 60),
  employee_id: identifier,
  start_date: isoDate,
  end_date: isoDate.nullable().optional(),
  department_id: optionalIdentifier,
  job_position_id: optionalIdentifier,
  employment_type_id: optionalIdentifier,
  working_schedule_id: optionalIdentifier,
  wage: positiveAmount('Wage'),
  wage_type: z.enum(['monthly', 'hourly']).default('monthly'),
  salary_structure_id: optionalIdentifier,
  state: z.enum(['draft', 'running', 'expired', 'cancelled']).default('draft'),
  notes: optionalText(1000),
}).superRefine((value, ctx) => {
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
  start_time: z.string().regex(/^\d{2}:\d{2}$/, 'Enter a time as HH:MM.'),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, 'Enter a time as HH:MM.'),
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
  check_in: z.string().min(1, 'Check-in time is required.'),
  check_out: z.string().nullable().optional(),
  edit_reason: optionalText(300),
}).superRefine((value, ctx) => {
  if (value.check_out && value.check_out <= value.check_in) {
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
  requested_amount: positiveAmount('Duration'),
  reason: optionalText(500),
}).superRefine((value, ctx) => {
  if (value.date_to < value.date_from) {
    ctx.addIssue({ code: 'custom', path: ['date_to'], message: 'Time off cannot end before it starts.' });
  }
});

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

export type EmployeeInput = z.infer<typeof employeeInput>;
export type ContractInput = z.infer<typeof contractInput>;
export type WorkingScheduleInput = z.infer<typeof workingScheduleInput>;
export type AttendanceInput = z.infer<typeof attendanceInput>;
export type TimeOffRequestInput = z.infer<typeof timeOffRequestInput>;
export type TimeOffAllocationInput = z.infer<typeof timeOffAllocationInput>;
