/**
 * Sign in, sign out, and "who am I".
 *
 * The only routes on the API that are reachable without a session, which is why
 * they use a plain Router rather than the guarded one.
 */
import { Router } from 'express';
import { z } from 'zod';

import { AppError } from '../errors/app_error.ts';
import { config, isProduction } from '../config/env.ts';
import { login, logout, SESSION_COOKIE_NAME } from '../services/auth_service.ts';
import { readCookie } from '../middleware/authenticate.ts';
import { parseOrThrow, validateBody } from '../middleware/validate.ts';
import { createThrottle } from '../lib/throttle.ts';
import { email } from '../../../shared/schemas/common.ts';

const loginInput = z.object({
  email,
  password: z.string().min(1, 'Enter your password.'),
});

/**
 * Two counters, because they answer different questions. The per-email one stops
 * a single account being ground down from anywhere; the per-IP one stops one
 * source working through a list of accounts. Either tripping is enough to refuse.
 *
 * The IP limit is the looser of the two on purpose -- a whole office behind one
 * address shares it, and locking out a building to slow one attacker is a bad
 * trade.
 */
const perEmail = createThrottle({
  maxFailures: config.loginMaxAttempts,
  windowMs: config.loginWindowMinutes * 60_000,
});

const perAddress = createThrottle({
  maxFailures: config.loginMaxAttempts * 5,
  windowMs: config.loginWindowMinutes * 60_000,
});

export const authRouter = Router();

authRouter.post('/login', validateBody(loginInput), async (request, response) => {
  const credentials = parseOrThrow(loginInput, request.body);

  const emailKey = credentials.email.toLowerCase();
  const addressKey = request.ip ?? 'unknown';

  for (const decision of [perEmail.check(emailKey), perAddress.check(addressKey)]) {
    if (!decision.allowed) {
      response.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw new AppError(
        'rate_limited',
        `Too many failed sign-in attempts. Try again in ` +
          `${Math.ceil(decision.retryAfterSeconds / 60)} minute(s), or ask an administrator to ` +
          `reset your password.`,
      );
    }
  }

  let result;
  try {
    result = await login(credentials.email, credentials.password, {
      ip: request.ip,
      userAgent: request.get('user-agent'),
    });
  } catch (error) {
    // Only a rejected credential counts against the limit. A deactivated account
    // has already proved it knows the password, and a database fault is not the
    // caller's doing.
    if (error instanceof AppError && error.code === 'unauthenticated') {
      perEmail.recordFailure(emailKey);
      perAddress.recordFailure(addressKey);
    }
    throw error;
  }

  // A correct password is the end of any suspicion attached to this pair.
  perEmail.clear(emailKey);
  perAddress.clear(addressKey);

  response.cookie(SESSION_COOKIE_NAME, result.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: config.sessionTtlHours * 3_600_000,
    path: '/',
  });

  response.json({ user: serialize(result.user) });
});

authRouter.post('/logout', async (request, response) => {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
  if (token !== null) {
    await logout(token);
  }
  response.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  response.status(204).end();
});

authRouter.get('/me', (request, response) => {
  if (request.auth === undefined) {
    throw new AppError('unauthenticated', 'Sign in to continue.');
  }
  response.json({ user: serialize(request.auth) });
});

/**
 * The browser receives the permission list so the UI can hide what the user
 * cannot do. That is a convenience, never a control: every route re-checks
 * server-side, and hiding a button has never stopped anyone editing a URL.
 */
function serialize(user: {
  userId: number;
  email: string;
  roleCode: string;
  roleName: string;
  employeeId: number | null;
  employeeName: string | null;
  permissions: Map<string, 'own' | 'all'>;
}) {
  return {
    user_id: user.userId,
    email: user.email,
    role_code: user.roleCode,
    role_name: user.roleName,
    employee_id: user.employeeId,
    employee_name: user.employeeName,
    permissions: Object.fromEntries(user.permissions),
  };
}
