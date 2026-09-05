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
import { isProduction } from '../config/env.ts';

type PostgresError = { code: string; constraint?: string; detail?: string };

function isPostgresError(error: unknown): error is Error & PostgresError {
  return (
    error instanceof Error &&
    typeof (error as Partial<PostgresError>).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((error as PostgresError).code)
  );
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
  payslip_no_duplicate_finalized:
    'This employee already has a finalized payslip for this exact period. Paying this one as well ' +
    'would pay them twice.',
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
    const friendly = error.constraint === undefined ? undefined : CONSTRAINT_MESSAGES[error.constraint];

    if (status !== undefined && friendly !== undefined) {
      response.status(status).json({
        error: { code: status === 409 ? 'conflict' : 'validation_failed', message: friendly },
      });
      return;
    }

    // A database error we have not written a message for is our omission, not the
    // user's mistake. Log it loudly so the gap gets closed.
    console.error(
      `[error] unmapped postgres ${error.code} on ${request.method} ${request.originalUrl}`,
      { constraint: error.constraint, detail: error.detail },
    );
    response.status(status ?? 500).json({
      error: {
        code: 'conflict',
        message: 'That change conflicts with a rule the database enforces and was not saved.',
        details: isProduction ? undefined : { constraint: error.constraint, detail: error.detail },
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
