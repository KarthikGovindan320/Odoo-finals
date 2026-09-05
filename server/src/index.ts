/**
 * Process entry point: start the server, and shut it down cleanly.
 *
 * A graceful shutdown matters more than it looks. Without it, a redeploy can cut
 * a transaction mid-payrun, and a half-computed payrun is exactly the kind of
 * state this system is designed never to hold.
 */
import { createApp } from './app.ts';
import { config } from './config/env.ts';
import { closePool, pool } from './db/pool.ts';

async function main(): Promise<void> {
  // Fail fast if the database is unreachable, rather than serving 500s.
  await pool.query('SELECT 1');

  const server = createApp().listen(config.port, () => {
    console.log(`peoplepay360 api listening on http://localhost:${config.port} (${config.nodeEnv})`);
  });

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received, shutting down`);
    server.close(() => {
      void closePool().then(() => process.exit(0));
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
