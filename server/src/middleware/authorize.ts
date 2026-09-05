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
import { queryOne } from '../db/pool.ts';

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
 * Refuses an action against somebody at or above the caller's own seniority.
 *
 * The permission answers "may this role correct attendance at all"; this answers
 * "whose". They are different questions, and collapsing them gave an HR Manager
 * -- who holds attendance:correct over the whole company -- the ability to
 * rewrite another HR Manager's timesheet, or their own.
 *
 * Strictly greater, so equal ranks cannot touch each other. That is what stops
 * two peers editing each other, and it also means nobody corrects their own
 * attendance, which is the four-eyes property rather than an oversight.
 *
 * An employee with no user account has no role and ranks below everybody: they
 * are a record, not an actor, and the most junior corrector can act on them.
 *
 * Deliberately a query rather than a claim carried on the request. Whose
 * timesheet may be rewritten is decided against the roles as they stand now,
 * not as they stood when a session was opened, and a session can outlive a
 * promotion by a day.
 */
export async function requireAuthorityOver(
  request: Request,
  employeeId: number,
  action = 'change this record',
): Promise<void> {
  const actorRank = request.auth?.roleRank;
  if (actorRank === undefined) {
    throw new AppError('unauthenticated', 'Sign in to continue.');
  }

  const subject = await queryOne<{ rank: number | null; name: string; role_name: string | null }>(
    `SELECT r.rank,
            e.first_name || ' ' || e.last_name AS name,
            r.name AS role_name
       FROM employees e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE e.id = $1`,
    [employeeId],
  );

  if (subject === null) {
    throw new AppError('not_found', `Employee ${employeeId} does not exist.`);
  }

  // No account, no role, no rank: below everyone.
  if ((subject.rank ?? 0) < actorRank) {
    return;
  }

  throw new AppError(
    'forbidden',
    request.auth?.employeeId === employeeId
      ? `You cannot ${action} for yourself. Ask somebody senior to you to do it.`
      : `${subject.name} is ${subject.role_name ?? 'unranked'}, which is at or above your own `
        + `level, so you cannot ${action} for them.`,
    { employee_id: employeeId },
  );
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
