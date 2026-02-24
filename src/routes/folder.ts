import { Router } from 'express';
import fs from 'fs';
import type { DatabaseService } from '../services/database';
import type { DownloadService } from '../services/download';
import type { FolderSummary } from '../types';
import { AppError } from '../types/errors';

export function folderRouter(db: DatabaseService, downloads: DownloadService): Router {
  const router = Router();

  // ── GET / — List all folders ────────────────────────────────────

  router.get('/', (_req, res) => {
    const folders = db.getAllFolders();
    const stats = db.getFileStats();
    const statsMap = new Map(stats.map(s => [s.folder_id, s]));

    const result: FolderSummary[] = folders.map(f => {
      const s = statsMap.get(f.folder_id) || {
        total: 0, completed: 0, downloading: 0, pending: 0, failed: 0,
      };
      return {
        folderId: f.folder_id,
        name: f.name || f.folder_id,
        loadedAt: f.loaded_at,
        downloading: f.downloading === 1,
        rateLimited: f.rate_limited === 1,
        rateLimitedAt: f.rate_limited_at,
        files: {
          total: s.total,
          completed: s.completed,
          downloading: s.downloading,
          pending: s.pending,
          failed: s.failed,
        },
      };
    });

    res.json(result);
  });

  // ── POST / — Add a MEGA folder ─────────────────────────────────

  router.post('/', async (req, res, next) => {
    try {
      const { url } = req.body;

      if (!url || typeof url !== 'string') {
        throw new AppError('Missing required field: url');
      }

      const result = await downloads.addFolder(url);

      res.status(201).json({
        folderId: result.folderId,
        name: result.name,
        fileCount: result.fileCount,
        message: 'Folder loaded, downloads started',
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /:folderId — Folder details ────────────────────────────

  router.get('/:folderId', (req, res) => {
    const { folderId } = req.params;
    const folder = db.getFolder(folderId);

    if (!folder) {
      res.status(404).json({ error: 'Folder not found' });
      return;
    }

    const files = db.getFilesForFolder(folderId);

    res.json({
      folderId: folder.folder_id,
      name: folder.name,
      loadedAt: folder.loaded_at,
      downloading: folder.downloading === 1,
      rateLimited: folder.rate_limited === 1,
      rateLimitedAt: folder.rate_limited_at,
      files: files.map(f => ({
        nodeId: f.node_id,
        name: f.name,
        size: f.size,
        timestamp: f.timestamp,
        status: f.status,
        error: f.error,
        startedAt: f.started_at,
        completedAt: f.completed_at,
      })),
    });
  });

  // ── GET /:folderId/:nodeId — Download a file ───────────────────

  router.get('/:folderId/:nodeId', (req, res) => {
    const { folderId, nodeId } = req.params;
    const file = db.getFile(folderId, nodeId);

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    if (file.status !== 'completed') {
      res.status(409).json({ error: 'File not ready', status: file.status });
      return;
    }

    const filePath = downloads.getFilePath(folderId, nodeId, file.name);

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    const stat = fs.statSync(filePath);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
      'Content-Length': String(stat.size),
    });

    fs.createReadStream(filePath).pipe(res);
  });

  // ── DELETE /:folderId — Remove folder ──────────────────────────

  router.delete('/:folderId', (req, res, next) => {
    try {
      downloads.removeFolder(req.params.folderId);
      res.json({ message: 'Folder deleted' });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /:folderId/retry — Retry failed downloads ─────────────

  router.post('/:folderId/retry', async (req, res, next) => {
    try {
      const count = await downloads.retryFolder(req.params.folderId);
      res.json({ message: 'Retrying failed downloads', count });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
