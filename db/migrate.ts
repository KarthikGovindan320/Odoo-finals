/**
 * Forward-only migration runner.
 *
 * Applies every unapplied file in db/migrations in filename order, each inside
 * its own transaction, and records it in schema_migrations along with a checksum
 * of the file. Re-running is a no-op. Editing a migration that has already been
 * applied is an error, not a silent divergence -- the checksum catches it.
 *
 * We write this ourselves rather than pulling in a migration tool: it is short
 * enough to read in one sitting, and the schema is the part of this project we
 * most need to be able to explain.
 *
 *   node db/migrate.ts            apply pending migrations
 *   node db/migrate.ts --reset    drop the public schema first, then apply all
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

type AppliedMigration = { version: string; checksum: string };

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function loadApplied(client: pg.Client): Promise<Map<string, string>> {
  const { rows } = await client.query<AppliedMigration>(
    'SELECT version, checksum FROM schema_migrations',
  );
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

async function resetSchema(client: pg.Client): Promise<void> {
  console.log('  reset: dropping schema public');
  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
}

async function applyMigration(client: pg.Client, version: string, sql: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
      version,
      checksumOf(sql),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const shouldReset = process.argv.includes('--reset');
  const client = new pg.Client();
  await client.connect();

  try {
    if (shouldReset) {
      await resetSchema(client);
    }
    await ensureMigrationsTable(client);
    const applied = await loadApplied(client);

    const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
    let appliedCount = 0;

    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const previousChecksum = applied.get(file);

      if (previousChecksum !== undefined) {
        if (previousChecksum !== checksumOf(sql)) {
          throw new Error(
            `Migration ${file} has changed since it was applied. Migrations are forward-only: ` +
              'add a new migration instead of editing this one.',
          );
        }
        continue;
      }

      process.stdout.write(`  applying ${file} ... `);
      await applyMigration(client, file, sql);
      appliedCount += 1;
      console.log('ok');
    }

    console.log(
      appliedCount === 0
        ? `schema up to date (${files.length} migrations)`
        : `applied ${appliedCount} migration(s), ${files.length} total`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('\nmigration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
