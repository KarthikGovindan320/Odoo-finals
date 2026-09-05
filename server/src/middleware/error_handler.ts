/**
 * The single place an error becomes an HTTP response.
 *
 * AppError carries its own status and a message written for the person reading
 * the screen. Anything else is a bug: logged in full, reported as a generic 500,
 * never leaked. Postgres constraint violations are translated on the way through,
 * because "conflicting key value violates exclusion constraint" is true but
 * useless to a payroll officer.
 */
import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../errors/app_error.ts';
import { exposeErrorDetails } from '../config/env.ts';

type PostgresError = { code: string; constraint?: string; detail?: string };

function isPostgresError(error: unknown): error is Error & PostgresError {
  if (!(error instanceof Error)) {
    return false;
  }
  // pg attaches its own fields to a plain Error, so the narrowing goes through
  // unknown -- Error and PostgresError do not overlap structurally.
  const candidate = error as unknown as Partial<PostgresError>;
  return typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code);
}

/** Constraint name -> the sentence a user should actually see. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  contract_no_overlap:
    'This contract overlaps an existing contract for the same employee. An employee can only have ' +
    'one active contract at a time — end the earlier one first, or adjust these dates.',
  attendance_no_overlap:
    'This attendance record overlaps another one for the same employee. Check whether there is ' +
    'already an open check-in that was never closed.',
  request_no_overlap:
    'This employee already has approved time off that overlaps these dates.',
  payslip_one_per_employee_per_run:
    'This employee already has a payslip in this payrun.',
  payslip_no_overlapping_finalized:
    'This employee already has a finalized payslip covering part of this period. Paying this one ' +
    'as well would pay them twice for the overlapping days.',
  allocation_not_overdrawn:
    'That would take more leave than this allocation has left. Someone may have approved another ' +
    'request against it a moment ago — reload the balances and try again.',
  // Salary rule configuration. Without these a mis-shaped rule reports only the
  // generic "conflicts with a rule the database enforces", which tells a payroll
  // manager nothing about which field to correct.
  rule_code_is_identifier:
    'A rule code must start with a letter and contain only capitals, digits and underscores — ' +
    'for example HRA_METRO.',
  rule_fixed_has_amount: 'A fixed-amount rule needs an amount.',
  rule_percentage_has_rate_and_base:
    'A percentage rule needs both a rate and a base to take the percentage of.',
  rule_formula_has_expression: 'A formula rule needs a formula.',
  rule_condition_has_expression: 'A conditional rule needs a condition.',
  structure_rule_unique: 'That rule is already part of this salary structure.',
  structure_sequence_unique:
    'Two rules in this structure share a sequence number, and the sequence is what decides the ' +
    'order they compute in.',
  salary_rules_code_key: 'A salary rule with that code already exists.',
  salary_structures_code_key: 'A salary structure with that code already exists.',
  payruns_name_key: 'A payrun with that name already exists.',
  contracts_reference_key: 'A contract with that reference already exists.',
  allocation_amount_positive: 'An allocation must be for more than zero days.',
  allocation_dates_ordered: 'An allocation cannot expire before it starts.',
  request_amount_positive: 'A time off request must be for more than zero.',
  timeoff_type_max_positive: 'The per-request maximum must be greater than zero.',
  line_break_shorter_than_span:
    'The break cannot be as long as the shift it sits inside.',
  line_day_in_week: 'Pick a day of the week for this schedule line.',
  employee_names_present: 'An employee needs both a first and a last name.',
  employee_termination_matches_status:
    'A terminated employee needs a termination date, and only a terminated employee may have one.',
  employee_termination_after_hire: 'Termination cannot be before the hire date.',
  employee_not_own_manager: 'An employee cannot be their own manager.',
  payslip_proration_is_a_fraction:
    'The computed proration for this payslip is not a fraction between 0 and 1, which means the ' +
    'period or the contract dates are inconsistent.',
  users_email_key: 'An account with that email address already exists.',
  employees_work_email_key: 'Another employee already uses that work email address.',
  employees_employee_number_key: 'That employee number is already taken.',
  employee_work_email_shaped:
    'That work email address is not valid. It should look like name@example.com.',
  user_email_shaped: 'That email address is not valid. It should look like name@example.com.',
  contract_dates_ordered: 'A contract cannot end before it starts.',
  request_dates_ordered: 'Time off cannot end before it starts.',
  line_times_ordered: 'A working schedule line must end after it starts.',
  attendance_out_after_in: 'Check-out must be later than check-in.',
  contract_wage_positive: 'A contract wage must be greater than zero.',
  attendance_edit_is_attributed:
    'A manual attendance correction must record who made it and why.',
};

const STATUS_BY_PG_CODE: Record<string, number> = {
  '23505': 409, // unique_violation
  '23P01': 409, // exclusion_violation
  '23503': 409, // foreign_key_violation
  '23514': 422, // check_violation
  '23502': 422, // not_null_violation
  // Class 22 -- data exception. These are the user's input failing to be the
  // shape the column requires, so they belong with the 422s. Previously they
  // fell through to the generic 500 branch, which told someone who had typed a
  // bad time that something had gone wrong on our side.
  '22001': 422, // string_data_right_truncation
  '22003': 422, // numeric_value_out_of_range
  '22007': 422, // invalid_datetime_format
  '22008': 422, // datetime_field_overflow
  '22P02': 422, // invalid_text_representation
};

/**
 * A data exception carries no constraint name, so there is nothing to look up in
 * CONSTRAINT_MESSAGES. These say what kind of value was wrong, which is as much
 * as the code itself knows.
 */
const DATA_ERROR_MESSAGES: Record<string, string> = {
  '22001': 'One of those values is longer than the field allows.',
  '22003': 'That number is outside the range this field can store.',
  '22007': 'That is not a valid date or time.',
  '22008': 'That date or time is out of range.',
  '22P02': 'One of those values is not in the format this field expects.',
};

export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    response.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details ?? undefined },
    });
    return;
  }

  if (isPostgresError(error)) {
    const status = STATUS_BY_PG_CODE[error.code];
    const friendly =
      (error.constraint === undefined ? undefined : CONSTRAINT_MESSAGES[error.constraint]) ??
      DATA_ERROR_MESSAGES[error.code];

    if (status !== undefined && friendly !== undefined) {
      response.status(status).json({
        error: { code: status === 409 ? 'conflict' : 'validation_failed', message: friendly },
      });
      return;
    }

    // A recognised integrity violation we have not written a sentence for is still
    // the user's action hitting a rule; say so honestly and log the gap.
    if (status !== undefined) {
      console.error(
        `[error] unmapped constraint ${error.constraint ?? error.code} on ` +
          `${request.method} ${request.originalUrl}`,
        { detail: error.detail },
      );
      response.status(status).json({
        error: {
          code: status === 409 ? 'conflict' : 'validation_failed',
          message: 'That change conflicts with a rule the database enforces and was not saved.',
          details: exposeErrorDetails ? { constraint: error.constraint, detail: error.detail } : undefined,
        },
      });
      return;
    }

    // Anything else -- a syntax error, an indeterminate parameter type, a lost
    // connection -- is our bug. Reporting it as a conflict would blame the user
    // for a mistake they did not make and hide the real fault.
    console.error(
      `[error] postgres ${error.code} on ${request.method} ${request.originalUrl}: ${error.message}`,
    );
    response.status(500).json({
      error: {
        code: 'internal_error',
        message: 'Something went wrong on our side. The problem has been logged.',
        details: exposeErrorDetails ? { pg_code: error.code, message: error.message } : undefined,
      },
    });
    return;
  }

  console.error(`[error] unhandled on ${request.method} ${request.originalUrl}:`, error);
  response.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong on our side. The problem has been logged.',
    },
  });
}
