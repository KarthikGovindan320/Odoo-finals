/**
 * Configuration, read once at startup.
 *
 * Anything missing or malformed fails the process immediately with a message
 * naming the variable. A server that boots with half its configuration and
 * discovers the problem on the first request is harder to diagnose than one that
 * refuses to start.
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

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: integer('PORT', 4000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  sessionTtlHours: integer('SESSION_TTL_HOURS', 12),
  smtp: {
    host: process.env.SMTP_HOST ?? '127.0.0.1',
    port: integer('SMTP_PORT', 1025),
    from: process.env.SMTP_FROM ?? 'PeoplePay360 <payroll@peoplepay360.local>',
  },
} as const;

export const isProduction = config.nodeEnv === 'production';

export { required };
