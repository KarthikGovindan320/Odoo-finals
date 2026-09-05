/**
 * Resolves the session cookie into req.auth. Does not decide anything -- that is
 * authorize()'s job. A request with no cookie simply arrives unauthenticated.
 */
import type { NextFunction, Request, Response } from 'express';

import { resolveSession, SESSION_COOKIE_NAME } from '../services/auth_service.ts';

/**
 * Minimal cookie header parsing. cookie-parser would be one more dependency for
 * about this much code, and we only ever read one cookie.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) {
    return null;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

export async function authenticate(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);

  if (token === null) {
    next();
    return;
  }

  try {
    const user = await resolveSession(token);
    if (user !== null) {
      request.auth = user;
    }
    next();
  } catch (error) {
    next(error);
  }
}
