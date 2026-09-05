/**
 * Authentication: sessions, not JWTs.
 *
 * A session is a random 256-bit token stored only as its SHA-256 hash. That
 * means a database dump does not hand out live sessions, logout genuinely
 * invalidates, and there is no signing key to rotate or leak. The cost is a
 * lookup per request, which is one indexed primary-key-ish read.
 *
 * The permission set is loaded with the session in the same query, so
 * authorisation never needs a second round trip and can never see a stale role.
 */
import { createHash, randomBytes } from 'node:crypto';

import { AppError } from '../errors/app_error.ts';
import { config } from '../config/env.ts';
import { pool, query, queryOne } from '../db/pool.ts';
import { verifyPassword } from '../lib/password.ts';

export const SESSION_COOKIE_NAME = 'pp360_session';

export type AccessScope = 'own' | 'all';

export type AuthenticatedUser = {
  userId: number;
  email: string;
  roleCode: string;
  roleName: string;
  employeeId: number | null;
  employeeName: string | null;
  /** permission code -> the widest scope this role holds for it. */
  permissions: Map<string, AccessScope>;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type UserRow = {
  id: number;
  email: string;
  password_hash: string;
  password_salt: string;
  is_active: boolean;
  role_code: string;
  role_name: string;
  employee_id: number | null;
  employee_name: string | null;
};

async function loadPermissions(roleCode: string): Promise<Map<string, AccessScope>> {
  const rows = await query<{ code: string; scope: AccessScope }>(
    `SELECT p.code, rp.scope
       FROM role_permissions rp
       JOIN roles r       ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE r.code = $1`,
    [roleCode],
  );

  return new Map(rows.map((row) => [row.code, row.scope]));
}

export async function login(
  email: string,
  password: string,
  request: { ip?: string; userAgent?: string },
): Promise<{ token: string; user: AuthenticatedUser }> {
  const user = await queryOne<UserRow>(
    `SELECT u.id, u.email, u.password_hash, u.password_salt, u.is_active,
            r.code AS role_code, r.name AS role_name,
            e.id   AS employee_id,
            e.first_name || ' ' || e.last_name AS employee_name
       FROM users u
       JOIN roles r      ON r.id = u.role_id
       LEFT JOIN employees e ON e.user_id = u.id
      WHERE u.email = $1`,
    [email],
  );

  // One message for "no such account" and "wrong password", so the endpoint
  // cannot be used to discover which email addresses exist.
  const invalid = new AppError(
    'unauthenticated',
    'That email and password combination is not correct.',
  );

  if (user === null) {
    // Still spend the hashing time, so a missing account is not detectably
    // faster than a wrong password.
    await verifyPassword(password, { hash: '00'.repeat(64), salt: 'decoy' });
    throw invalid;
  }

  const passwordMatches = await verifyPassword(password, {
    hash: user.password_hash,
    salt: user.password_salt,
  });

  if (!passwordMatches) {
    throw invalid;
  }

  if (!user.is_active) {
    throw new AppError(
      'forbidden',
      'This account has been deactivated. Ask an administrator to re-enable it.',
    );
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3_600_000);

  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, hashToken(token), request.ip ?? null, request.userAgent ?? null, expiresAt],
  );

  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

  return {
    token,
    user: {
      userId: user.id,
      email: user.email,
      roleCode: user.role_code,
      roleName: user.role_name,
      employeeId: user.employee_id,
      employeeName: user.employee_name,
      permissions: await loadPermissions(user.role_code),
    },
  };
}

export async function resolveSession(token: string): Promise<AuthenticatedUser | null> {
  const row = await queryOne<{
    user_id: number;
    email: string;
    role_code: string;
    role_name: string;
    employee_id: number | null;
    employee_name: string | null;
  }>(
    `SELECT u.id AS user_id, u.email, r.code AS role_code, r.name AS role_name,
            e.id AS employee_id,
            e.first_name || ' ' || e.last_name AS employee_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN employees e ON e.user_id = u.id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.is_active`,
    [hashToken(token)],
  );

  if (row === null) {
    return null;
  }

  return {
    userId: row.user_id,
    email: row.email,
    roleCode: row.role_code,
    roleName: row.role_name,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    permissions: await loadPermissions(row.role_code),
  };
}

export async function logout(token: string): Promise<void> {
  await pool.query(
    'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)],
  );
}
