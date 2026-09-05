/**
 * A router on which an unguarded route cannot be written.
 *
 * Registering a route requires naming the permission it needs -- there is no
 * overload that omits it. That makes "every protected route checks permission
 * server-side" a property of the type system rather than a rule someone has to
 * remember, which is the difference between a convention and a guarantee.
 *
 * Express 5 forwards rejected promises from async handlers to the error
 * middleware on its own, so no asyncHandler wrapper is needed here.
 */
import { Router } from 'express';
import type { RequestHandler } from 'express';

import { authorize } from '../middleware/authorize.ts';
import type { PermissionCode } from '../middleware/authorize.ts';

export type GuardedRouter = {
  readonly router: Router;
  get(path: string, permission: PermissionCode, ...handlers: RequestHandler[]): void;
  post(path: string, permission: PermissionCode, ...handlers: RequestHandler[]): void;
  patch(path: string, permission: PermissionCode, ...handlers: RequestHandler[]): void;
  remove(path: string, permission: PermissionCode, ...handlers: RequestHandler[]): void;
};

export function createGuardedRouter(): GuardedRouter {
  const router = Router();

  return {
    router,
    get: (path, permission, ...handlers) => router.get(path, authorize(permission), ...handlers),
    post: (path, permission, ...handlers) => router.post(path, authorize(permission), ...handlers),
    patch: (path, permission, ...handlers) => router.patch(path, authorize(permission), ...handlers),
    remove: (path, permission, ...handlers) => router.delete(path, authorize(permission), ...handlers),
  };
}
