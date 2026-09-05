/**
 * Authentication: sessions, not JWTs.
 *
 * A session is a random 256-bit token stored only as its SHA-256 hash. That
 * means a database dump does not hand out live sessions, logout genuinely
 * invalidates, and there is no signing key to rotate or leak. The cost is a
 * lookup per request, which is one indexed primary-key-ish read.
 *
 * The permission set is loaded with the session in one round trip -- the role's
 * permissions are aggregated into the same statement -- so authorisation never
 * needs a second query and can never see a role that has changed underneath it.
 */
import { createHash, randomBytes } from 'node:crypto';

import { AppError } from '../errors/app_error.ts';
import { config } from '../config/env.ts';
import { pool, queryOne } from '../db/pool.ts';
import { verifyPassword } from '../lib/password.ts';

export const SESSION_COOKIE_NAME = 'pp360_session';

export type AccessScope = 'own' | 'all';

export type AuthenticatedUser = {
  userId: number;
  email: string;
  roleCode: string;
  roleName: string;
  /**
   * Seniority, carried on the session so an authority check costs no query.
   *
   * Permissions decide what this user may do; this decides who they may do it
   * to. See requireAuthorityOver() in middleware/authorize.ts.
   */
  roleRank: number;
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
  role_rank: number;
  employee_id: number | null;
  employee_name: string | null;
};

/**
 * The role's permissions as a JSON object of code -> scope, aggregated in SQL so
 * it can ride along with the row that needs it.
 */
const PERMISSIONS_SUBQUERY = `
  COALESCE((
    SELECT jsonb_object_agg(p.code, rp.scope)
      FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = r.id
  ), '{}'::jsonb) AS permissions`;

function toPermissionMap(raw: unknown): Map<string, AccessScope> {
  if (raw === null || typeof raw !== 'object') {
    return new Map();
  }
  return new Map(Object.entries(raw as Record<string, AccessScope>));
}

export async function login(
  email: string,
  password: string,
  request: { ip?: string; userAgent?: string },
): Promise<{ token: string; user: AuthenticatedUser }> {
  const user = await queryOne<UserRow & { permissions: unknown }>(
    `SELECT u.id, u.email, u.password_hash, u.password_salt, u.is_active,
            r.code AS role_code, r.name AS role_name, r.rank AS role_rank,
            e.id   AS employee_id,
            e.first_name || ' ' || e.last_name AS employee_name,
            ${PERMISSIONS_SUBQUERY}
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
      roleRank: user.role_rank,
      employeeId: user.employee_id,
      employeeName: user.employee_name,
      permissions: toPermissionMap(user.permissions),
    },
  };
}

export async function resolveSession(token: string): Promise<AuthenticatedUser | null> {
  const row = await queryOne<{
    user_id: number;
    email: string;
    role_code: string;
    role_name: string;
    role_rank: number;
    employee_id: number | null;
    employee_name: string | null;
    permissions: unknown;
  }>(
    `SELECT u.id AS user_id, u.email, r.code AS role_code, r.name AS role_name,
            r.rank AS role_rank,
            e.id AS employee_id,
            e.first_name || ' ' || e.last_name AS employee_name,
            ${PERMISSIONS_SUBQUERY}
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
    roleRank: row.role_rank,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    permissions: toPermissionMap(row.permissions),
  };
}

export async function logout(token: string): Promise<void> {
  await pool.query(
    'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)],
  );
}
