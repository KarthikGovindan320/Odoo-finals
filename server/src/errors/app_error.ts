/**
 * One error taxonomy for the whole server.
 *
 * Every failure that reaches a client is an AppError carrying a machine-readable
 * code, an HTTP status and a message written for the person reading the screen.
 * Anything else that escapes is a bug, and the error handler treats it as one:
 * logged in full, reported as a generic 500, never leaked to the client.
 */
export type ErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rule_configuration_invalid'
  | 'workflow_violation'
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rule_configuration_invalid: 422,
  workflow_violation: 409,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export function notFound(entity: string, id: string | number): AppError {
  return new AppError('not_found', `${entity} ${id} does not exist.`);
}

export function forbidden(message: string): AppError {
  return new AppError('forbidden', message);
}

export function workflowViolation(message: string): AppError {
  return new AppError('workflow_violation', message);
}
