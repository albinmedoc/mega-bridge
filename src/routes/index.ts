import type { Express } from 'express';
import type { DatabaseService } from '../services/database';
import type { DownloadService } from '../services/download';
import healthRouter from './health';
import { folderRouter } from './folder';

/**
 * Mount all route groups onto the Express app.
 */
export function registerRoutes(
  app: Express,
  db: DatabaseService,
  downloads: DownloadService,
): void {
  app.use('/health', healthRouter);
  app.use('/folder', folderRouter(db, downloads));
}
