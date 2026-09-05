/**
 * Configuration, read once at startup.
 *
 * Anything missing or malformed fails the process immediately with a message
 * naming the variable. A server that boots with half its configuration and
 * discovers the problem on the first request is harder to diagnose than one that
 * refuses to start.
 *
 * Two rules keep an unconfigured deploy from behaving like a development one:
 *
 *   * A setting whose default is only safe on a laptop is required outright once
 *     NODE_ENV says production, rather than falling back silently.
 *   * Diagnostic output is opt-in. Anything that reveals internals is gated on
 *     development being *declared*, never merely on production not being
 *     declared -- so a deploy that forgets NODE_ENV entirely stays quiet.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Environment variable ${name} is required but was not set. See .env.example.`,
    );
  }
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got '${raw}'.`);
  }
  return value;
}

/** NODE_ENV as it was actually given to us -- undefined when nobody set it. */
const declaredEnv = process.env.NODE_ENV;

export const isProduction = declaredEnv === 'production';

/**
 * A default that only holds on a developer's machine. In production the variable
 * has to be set explicitly, because the fallback would otherwise be wrong in a
 * way nothing announces -- WEB_ORIGIN silently reflecting CORS credentials to
 * localhost being the case that motivated this.
 */
function localOnlyDefault(name: string, developmentFallback: string): string {
  if (isProduction) {
    return required(name);
  }
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? developmentFallback : value;
}

/**
 * How many reverse proxies sit in front of us.
 *
 * Express's `trust proxy` decides whether request.ip is read from the socket or
 * from X-Forwarded-For, and that value is recorded against every session. Set to
 * `true` it trusts the whole header, which means any client can write its own
 * address into the audit trail. The default here is 0 -- trust nothing -- and a
 * deploy behind one proxy sets TRUST_PROXY=1.
 */
function trustProxy(): number {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw.trim() === '') {
    return 0;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Environment variable TRUST_PROXY must be the number of proxies in front of this ` +
        `server (0 when there are none), got '${raw}'.`,
    );
  }
  return value;
}

export const config = {
  nodeEnv: declaredEnv ?? 'development',
  port: integer('PORT', 4000),
  webOrigin: localOnlyDefault('WEB_ORIGIN', 'http://localhost:5173'),
  sessionTtlHours: integer('SESSION_TTL_HOURS', 12),
  trustProxy: trustProxy(),
  loginMaxAttempts: integer('LOGIN_MAX_ATTEMPTS', 10),
  loginWindowMinutes: integer('LOGIN_WINDOW_MINUTES', 15),
  smtp: {
    host: localOnlyDefault('SMTP_HOST', '127.0.0.1'),
    port: integer('SMTP_PORT', 1025),
    from: localOnlyDefault('SMTP_FROM', 'PeoplePay360 <payroll@peoplepay360.local>'),
  },
} as const;

/**
 * Whether a response may carry internal detail: constraint names, driver
 * messages, Postgres codes.
 *
 * Deliberately keyed on development being declared rather than on production not
 * being declared. An unset NODE_ENV is the common deployment slip, and it should
 * cost diagnostics, not disclosure.
 */
export const exposeErrorDetails = declaredEnv === 'development';

export { required };
