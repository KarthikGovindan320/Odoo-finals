/**
 * Turns a zod schema into request validation.
 *
 * The schemas come from shared/, so the browser and the server enforce the same
 * rule and produce the same sentence. Failures are reported per field, because
 * "validation failed" tells a user nothing and Odoo's own stated bar is that an
 * invalid email says the email is invalid.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

import { AppError } from '../errors/app_error.ts';

export type FieldError = { field: string; message: string };

export function parseOrThrow<Output>(schema: ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  const fields: FieldError[] = result.error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '_',
    message: issue.message,
  }));

  throw new AppError(
    'validation_failed',
    fields.length === 1
      ? (fields[0] as FieldError).message
      : `Please correct ${fields.length} fields before saving.`,
    { fields },
  );
}

export function validateBody<Output>(schema: ZodType<Output>): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction): void => {
    try {
      request.body = parseOrThrow(schema, request.body);
      next();
    } catch (error) {
      next(error);
    }
  };
}

// validateQuery/validatedQuery used to live here as middleware. Nothing ever
// called them -- every route parses its own query with parseOrThrow, which reads
// better at the call site because the parsed value is in scope immediately
// rather than fetched back out of the request. Removed rather than left as two
// exported functions nobody uses.
