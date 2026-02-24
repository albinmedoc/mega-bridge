import express from 'express';
import { loadConfig } from './config';
import { logger } from './helpers/logger';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { registerRoutes } from './routes';
import { DatabaseService } from './services/database';
import { DownloadService } from './services/download';

// ── Bootstrap ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new DatabaseService(config);
  const downloads = new DownloadService(config, db);

  // ── Express app ──────────────────────────────────────────────────

  const app = express();

  app.use(express.json({ limit: config.requestBodyMaxBytes }));
  app.use(requestLogger);

  registerRoutes(app, db, downloads);

  app.use(errorHandler);

  const server = app.listen(config.port, async () => {
    logger.info('Server started', {
      port: config.port,
      downloadDir: config.downloadDir,
      dbPath: config.dbPath,
      maxConcurrent: config.maxConcurrentDownloads,
      retryIntervalMinutes: config.retryIntervalMinutes,
    });

    await downloads.resumeDownloads();
    downloads.startRetryTimer();
  });

  // ── Graceful shutdown ────────────────────────────────────────────

  let shuttingDown = false;

  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal}, shutting down`);
    downloads.shutdown();

    const forceTimer = setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceTimer.unref();

    server.close(() => {
      db.close();
      logger.info('Shutdown complete');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error('Unhandled promise rejection', { error: message });
  });
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
