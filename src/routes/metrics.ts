import { Router } from 'express';
import type { DatabaseService } from '../services/database';
import type { DownloadService } from '../services/download';

export function metricsRouter(db: DatabaseService, downloads: DownloadService): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const downloadMetrics = downloads.getMetrics();
    const stats = db.getFileStats();
    const folders = db.getAllFolders();

    const totals = stats.reduce(
      (acc, s) => ({
        total: acc.total + s.total,
        completed: acc.completed + s.completed,
        downloading: acc.downloading + s.downloading,
        pending: acc.pending + s.pending,
        failed: acc.failed + s.failed,
      }),
      { total: 0, completed: 0, downloading: 0, pending: 0, failed: 0 },
    );

    res.json({
      queue: {
        depth: downloadMetrics.queueDepth,
        activeDownloads: downloadMetrics.activeDownloads,
        cachedFolders: downloadMetrics.cachedFolders,
      },
      folders: {
        total: folders.length,
        rateLimited: folders.filter(f => f.rate_limited === 1).length,
        downloading: folders.filter(f => f.downloading === 1).length,
      },
      files: totals,
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  });

  return router;
}
