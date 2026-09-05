/**
 * The database connection pool, and the transaction helper every write goes
 * through.
 *
 * Three type parsers are overridden at startup, each for a correctness reason:
 *
 *   numeric  pg returns numeric as a string to protect arbitrary precision. Our
 *            money is numeric(14,2) and every computed amount is rounded to two
 *            decimals immediately, which is far inside what a double represents
 *            exactly, so parsing to number here is safe and saves a conversion
 *            at every call site -- where forgetting it would be a silent bug.
 *   int8     bigint likewise arrives as a string. Our ids are sequence values
 *            nowhere near 2^53, and an id that is sometimes '7' and sometimes 7
 *            breaks every comparison it touches.
 *   date     a bare date must NOT become a JS Date. Doing so anchors it to the
 *            process timezone and shifts contract and payroll boundaries by a
 *            day. Dates stay 'YYYY-MM-DD' strings all the way to the client.
 */
import pg from 'pg';

const NUMERIC_OID = 1700;
const INT8_OID = 20;
const DATE_OID = 1082;

pg.types.setTypeParser(NUMERIC_OID, (value: string) => Number.parseFloat(value));
pg.types.setTypeParser(INT8_OID, (value: string) => Number.parseInt(value, 10));
pg.types.setTypeParser(DATE_OID, (value: string) => value);

/**
 * Pool size.
 *
 * The dashboard fans out eight panel queries in one Promise.all, so a max of 10
 * meant two concurrent dashboard loads saturated the pool and every other
 * request waited out connectionTimeoutMillis and then failed. The ceiling now
 * leaves room for that fan-out several times over, and is configurable for a
 * deployment that knows its own Postgres max_connections.
 */
export const pool = new pg.Pool({
  max: Number(process.env.PGPOOL_MAX ?? 25),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // A statement that has run this long is not going to finish usefully, and
  // holding the connection helps nobody. Payrun compute is the longest thing
  // here and runs in well under a second per employee.
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 30_000),
});

pool.on('error', (error: Error) => {
  // An idle client failing is not tied to any request, so it has nowhere else to
  // surface. Losing it silently would mean debugging a dead pool with no clue.
  console.error('[db] idle client error:', error.message);
});

export type QueryParameter = string | number | boolean | null | Date | number[] | string[];

export async function query<Row extends pg.QueryResultRow>(
  text: string,
  params: readonly QueryParameter[] = [],
): Promise<Row[]> {
  const result = await pool.query<Row>(text, params as QueryParameter[]);
  return result.rows;
}

export async function queryOne<Row extends pg.QueryResultRow>(
  text: string,
  params: readonly QueryParameter[] = [],
): Promise<Row | null> {
  const rows = await query<Row>(text, params);
  return rows[0] ?? null;
}

export type TransactionClient = {
  query<Row extends pg.QueryResultRow>(
    text: string,
    params?: readonly QueryParameter[],
  ): Promise<Row[]>;
  queryOne<Row extends pg.QueryResultRow>(
    text: string,
    params?: readonly QueryParameter[],
  ): Promise<Row | null>;
};

/**
 * Runs `work` inside a transaction, committing on success and rolling back on
 * any throw.
 *
 * `actorUserId` is published to the transaction as app.actor_user_id, which is
 * what the audit triggers read. Setting it here rather than at each call site
 * means an audited write cannot accidentally be recorded as anonymous.
 */
export async function withTransaction<Result>(
  work: (client: TransactionClient) => Promise<Result>,
  actorUserId?: number | null,
): Promise<Result> {
  const client = await pool.connect();

  const wrapped: TransactionClient = {
    async query<Row extends pg.QueryResultRow>(text: string, params: readonly QueryParameter[] = []) {
      const result = await client.query<Row>(text, params as QueryParameter[]);
      return result.rows;
    },
    async queryOne<Row extends pg.QueryResultRow>(text: string, params: readonly QueryParameter[] = []) {
      const result = await client.query<Row>(text, params as QueryParameter[]);
      return result.rows[0] ?? null;
    },
  };

  let failed = false;

  try {
    await client.query('BEGIN');
    if (actorUserId !== undefined && actorUserId !== null) {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.actor_user_id',
        String(actorUserId),
      ]);
    }

    const result = await work(wrapped);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    failed = true;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // A rollback that itself fails almost always means the connection is gone.
      // Letting it propagate would replace the real error -- the one describing
      // what the caller did wrong -- with a connection error from the cleanup.
      console.error(
        '[db] rollback failed; the original error is being rethrown:',
        rollbackError instanceof Error ? rollbackError.message : rollbackError,
      );
    }
    throw error;
  } finally {
    // Passing the error discards the connection instead of returning a possibly
    // poisoned one (mid-transaction, or with a lost socket) to the pool.
    client.release(failed || undefined);
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

/**
 * The id from an `INSERT ... RETURNING id`, or a clear error.
 *
 * `(row as { id: number }).id` was written seven times across the codebase to
 * get past `Row | null`. It is correct for a RETURNING clause in practice, but
 * it defeats `strict` exactly where a schema drift or a silently-skipped insert
 * would otherwise be caught -- and when it is wrong the symptom is
 * "Cannot read properties of null", far from the statement that caused it.
 */
export function insertedId(row: { id: number } | null, what: string): number {
  if (row === null) {
    throw new Error(`Inserting ${what} returned no row, so it has no id.`);
  }
  return row.id;
}
