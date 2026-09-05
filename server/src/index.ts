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

  // Give in-flight requests a moment to finish, then stop waiting. server.close()
  // alone waits for every keep-alive connection to drain, which one idle browser
  // tab can postpone indefinitely -- so a deploy hangs rather than restarts.
  const SHUTDOWN_GRACE_MS = 10_000;
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down`);

    const forceExit = setTimeout(() => {
      console.error(`[shutdown] still busy after ${SHUTDOWN_GRACE_MS}ms, closing anyway`);
      server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    server.close(() => {
      clearTimeout(forceExit);
      void closePool().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error('[shutdown] pool did not close cleanly:', error);
          process.exit(1);
        },
      );
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
