/**
 * Password hashing with scrypt from node:crypto.
 *
 * No bcrypt, no argon2: both are native modules that need a compiler on every
 * machine, and scrypt is a memory-hard KDF built into the runtime. One fewer
 * dependency, and nothing to fail at install time on someone's laptop.
 *
 * Verification uses timingSafeEqual so that comparing hashes leaks nothing about
 * how much of a wrong password was correct.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const SALT_BYTES = 16;
const KEY_BYTES = 64;

export type PasswordRecord = { hash: string; salt: string };

export async function hashPassword(plainText: string): Promise<PasswordRecord> {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const derived = (await scryptAsync(plainText, salt, KEY_BYTES)) as Buffer;
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPassword(
  plainText: string,
  record: PasswordRecord,
): Promise<boolean> {
  const derived = (await scryptAsync(plainText, record.salt, KEY_BYTES)) as Buffer;
  const stored = Buffer.from(record.hash, 'hex');

  if (stored.length !== derived.length) {
    return false;
  }
  return timingSafeEqual(stored, derived);
}
