/**
 * Server-side role checks. The only place a permission decision is made.
 *
 * Two distinct questions, and answering only the first is the classic security
 * failure this middleware exists to prevent:
 *
 *   1. May this role touch this resource at all?  -> the permission code
 *   2. Which rows of it are theirs?               -> the scope
 *
 * A role holding a permission at scope 'own' passes the first check and is then
 * required by the handler to restrict its query to the caller's own employee
 * record. requireOwnEmployee() below is how a handler enforces that for a route
 * addressed by employee id, so an Employee editing the URL gets 403, not data.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { AppError } from '../errors/app_error.ts';

/** Every permission code a route may require. Mirrors the permissions table. */
export type PermissionCode =
  | 'employee:read' | 'employee:write' | 'employee:delete'
  | 'contract:read' | 'contract:write'
  | 'schedule:read' | 'schedule:write'
  | 'attendance:read' | 'attendance:write' | 'attendance:correct'
  | 'timeoff:read' | 'timeoff:write' | 'timeoff:approve'
  | 'timeoff_type:read' | 'timeoff_type:write'
  | 'salary_config:read' | 'salary_config:write'
  | 'payrun:read' | 'payrun:write' | 'payrun:validate' | 'payrun:delete'
  | 'dashboard:read' | 'audit:read'
  | 'user:manage';

export function authorize(permission: PermissionCode): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (request.auth === undefined) {
      next(new AppError('unauthenticated', 'Sign in to continue.'));
      return;
    }

    const scope = request.auth.permissions.get(permission);

    if (scope === undefined) {
      next(
        new AppError(
          'forbidden',
          `Your role (${request.auth.roleName}) does not have permission to ${describe(permission)}.`,
        ),
      );
      return;
    }

    request.accessScope = scope;
    next();
  };
}

function describe(permission: PermissionCode): string {
  const [resource, action] = permission.split(':') as [string, string];
  return `${action} ${resource.replace(/_/g, ' ')} records`;
}

/**
 * For routes addressed by employee id. Under scope 'own', the caller may only
 * reach their own employee record; under 'all', anyone's.
 */
export function requireOwnEmployee(request: Request, employeeId: number): void {
  if (request.accessScope !== 'own') {
    return;
  }

  if (request.auth?.employeeId !== employeeId) {
    throw new AppError(
      'forbidden',
      'You can only view your own records. This request was for a different employee.',
    );
  }
}

/**
 * The employee id a scoped list query must be filtered by, or null when the
 * caller may see everything.
 */
export function scopedEmployeeId(request: Request): number | null {
  if (request.accessScope !== 'own') {
    return null;
  }

  if (request.auth?.employeeId == null) {
    throw new AppError(
      'forbidden',
      'Your user account is not linked to an employee record, so there are no records to show. ' +
        'Ask an administrator to link it.',
    );
  }

  return request.auth.employeeId;
}
