import fs from 'fs';
import path from 'path';
import mega from 'megajs';
import type { AppConfig } from '../config';
import { Logger } from '../helpers/logger';
import {
  buildFileMap,
  buildMegaFolderUrl,
  collectFiles,
  getNodeId,
  loadMegaFolder,
  parseMegaFolderUrl,
} from '../helpers/mega';
import type { DatabaseService } from './database';
import { AppError, ConflictError, NotFoundError } from '../types/errors';
import type { DownloadTask } from '../types';

const log = new Logger('download');

export class DownloadService {
  private queue: DownloadTask[] = [];
  private activeDownloads = 0;
  private folderCache = new Map<string, mega.File>();
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private config: AppConfig,
    private db: DatabaseService,
  ) {}

  // ── Public API ────────────────────────────────────────────────────

  async addFolder(url: string): Promise<{ folderId: string; name: string; fileCount: number }> {
    const parsed = parseMegaFolderUrl(url);
    if (!parsed) {
      throw new AppError('Invalid MEGA folder URL');
    }

    const { folderId, folderKey } = parsed;

    if (this.db.getFolder(folderId)) {
      throw new ConflictError('Folder already loaded');
    }

    const megaFolder = await loadMegaFolder(url);
    const folderName = megaFolder.name || folderId;

    this.db.insertFolder(folderId, folderKey, folderName);
    this.folderCache.set(folderId, megaFolder);

    const files = collectFiles(megaFolder);

    for (const file of files) {
      const nodeId = getNodeId(file);
      const fileName = file.name || 'unknown';
      const fileSize = file.size || 0;
      const timestamp = file.timestamp || null;

      this.db.insertFile(nodeId, folderId, fileName, fileSize, timestamp);

      this.queue.push({ folderId, nodeId, megaFile: file, name: fileName, size: fileSize });
    }

    this.processQueue();
    return { folderId, name: folderName, fileCount: files.length };
  }

  async retryFolder(folderId: string): Promise<number> {
    const folder = this.db.getFolder(folderId);
    if (!folder) throw new NotFoundError('Folder not found');

    this.db.setFolderRateLimited(folderId, false);

    const failed = this.db.getFilesByFolderAndStatus(folderId, 'failed');
    const pending = this.db.getFilesByFolderAndStatus(folderId, 'pending');
    const filesToRetry = [...failed, ...pending];

    if (filesToRetry.length === 0) return 0;

    const megaFolder = await this.ensureFolderLoaded(folderId, folder.folder_key);
    const filesMap = buildFileMap(megaFolder);

    for (const file of filesToRetry) {
      this.db.updateFileStatus(folderId, file.node_id, 'pending', null, null, null);

      const megaFile = filesMap.get(file.node_id);
      if (megaFile) {
        this.queue.push({
          folderId, nodeId: file.node_id, megaFile, name: file.name, size: file.size,
        });
      }
    }

    this.processQueue();
    return filesToRetry.length;
  }

  removeFolder(folderId: string): void {
    const folder = this.db.getFolder(folderId);
    if (!folder) throw new NotFoundError('Folder not found');

    // Remove queued tasks for this folder
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].folderId === folderId) {
        this.queue.splice(i, 1);
      }
    }

    // Delete files from disk
    const folderPath = path.join(this.config.downloadDir, folderId);
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
    }

    this.db.deleteFolder(folderId);
    this.folderCache.delete(folderId);
    log.info('Folder removed', { folderId });
  }

  getFilePath(folderId: string, nodeId: string, filename: string): string {
    return path.join(this.config.downloadDir, folderId, `${nodeId}_${filename}`);
  }

  async resumeDownloads(): Promise<void> {
    log.info('Checking for interrupted downloads');

    const resetCount = this.db.resetInterruptedDownloads();
    if (resetCount > 0) {
      log.info('Reset interrupted downloads', { count: resetCount });
    }

    const pending = this.db.getFilesWithStatus('pending');
    const folderIds = [...new Set(pending.map(f => f.folder_id))];

    for (const folderId of folderIds) {
      const folder = this.db.getFolder(folderId);
      if (!folder) continue;

      try {
        const megaFolder = await this.ensureFolderLoaded(folderId, folder.folder_key);
        const filesMap = buildFileMap(megaFolder);

        const folderPending = pending.filter(f => f.folder_id === folderId);
        for (const file of folderPending) {
          const megaFile = filesMap.get(file.node_id);
          if (megaFile) {
            this.queue.push({
              folderId, nodeId: file.node_id, megaFile, name: file.name, size: file.size,
            });
          }
        }

        log.info('Resuming downloads', { folderId, count: folderPending.length });
      } catch (err) {
        log.error('Failed to resume folder', {
          folderId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.processQueue();
  }

  startRetryTimer(): void {
    const intervalMs = this.config.retryIntervalMinutes * 60 * 1000;

    this.retryTimer = setInterval(async () => {
      const rateLimited = this.db.getRateLimitedFolders();
      for (const folder of rateLimited) {
        log.info('Auto-retrying rate-limited folder', { folderId: folder.folder_id });
        try {
          await this.retryFolder(folder.folder_id);
        } catch (err) {
          log.error('Failed to auto-retry folder', {
            folderId: folder.folder_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }, intervalMs);

    this.retryTimer.unref();
  }

  shutdown(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.queue.length = 0;
  }

  // ── Private ───────────────────────────────────────────────────────

  private async ensureFolderLoaded(folderId: string, folderKey: string): Promise<mega.File> {
    let megaFolder = this.folderCache.get(folderId);
    if (!megaFolder) {
      const url = buildMegaFolderUrl(folderId, folderKey);
      megaFolder = await loadMegaFolder(url);
      this.folderCache.set(folderId, megaFolder);
    }
    return megaFolder;
  }

  private processQueue(): void {
    while (this.activeDownloads < this.config.maxConcurrentDownloads && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;

      this.activeDownloads++;
      this.downloadFile(task).finally(() => {
        this.activeDownloads--;
        this.processQueue();
      });
    }
  }

  private async downloadFile(task: DownloadTask): Promise<void> {
    const { folderId, nodeId, megaFile, name, size } = task;
    const filePath = this.getFilePath(folderId, nodeId, name);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const startedAt = new Date().toISOString();
    this.db.updateFileStatus(folderId, nodeId, 'downloading', null, startedAt, null);
    this.db.setFolderDownloading(folderId, true);

    log.info('Downloading', { name, size, folderId });

    return new Promise<void>((resolve) => {
      try {
        const stream = megaFile.download({});
        const writeStream = fs.createWriteStream(filePath);

        stream.on('error', (err: Error) => {
          writeStream.destroy();
          const completedAt = new Date().toISOString();

          if (err.message.includes('ETOOMANY') || err.message.includes('Too many')) {
            log.warn('Rate limited', { name, folderId });
            this.db.updateFileStatus(folderId, nodeId, 'pending', 'Rate limited', null, null);
            this.db.setFolderRateLimited(folderId, true);
          } else {
            log.error('Download failed', { name, error: err.message });
            this.db.updateFileStatus(folderId, nodeId, 'failed', err.message, startedAt, completedAt);
          }

          this.db.refreshFolderDownloadingStatus(folderId);
          resolve();
        });

        writeStream.on('finish', () => {
          const completedAt = new Date().toISOString();
          log.info('Download completed', { name, folderId });
          this.db.updateFileStatus(folderId, nodeId, 'completed', null, startedAt, completedAt);
          this.db.refreshFolderDownloadingStatus(folderId);
          resolve();
        });

        writeStream.on('error', (err: Error) => {
          stream.destroy();
          const completedAt = new Date().toISOString();
          log.error('Write failed', { name, error: err.message });
          this.db.updateFileStatus(folderId, nodeId, 'failed', err.message, startedAt, completedAt);
          this.db.refreshFolderDownloadingStatus(folderId);
          resolve();
        });

        stream.pipe(writeStream);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        const completedAt = new Date().toISOString();
        log.error('Download error', { name, error: errorMsg });
        this.db.updateFileStatus(folderId, nodeId, 'failed', errorMsg, startedAt, completedAt);
        this.db.setFolderDownloading(folderId, false);
        resolve();
      }
    });
  }
}
