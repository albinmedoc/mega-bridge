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
  private folderCache = new Map<string, { folder: mega.File; cachedAt: number }>();
  private retryTimer: NodeJS.Timeout | null = null;
  private retryingFolders = new Set<string>();

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
    this.folderCache.set(folderId, { folder: megaFolder, cachedAt: Date.now() });

    const files = collectFiles(megaFolder);

    for (const { file, path: filePath } of files) {
      const nodeId = getNodeId(file);
      const fileName = file.name || 'unknown';
      const fileSize = file.size || 0;
      const timestamp = file.timestamp || null;

      this.db.insertFile(nodeId, folderId, fileName, filePath, fileSize, timestamp);

      this.queue.push({ folderId, nodeId, megaFile: file, name: fileName, path: filePath, size: fileSize });
    }

    this.processQueue();
    return { folderId, name: folderName, fileCount: files.length };
  }

  async retryFolder(folderId: string): Promise<number> {
    const folder = this.db.getFolder(folderId);
    if (!folder) throw new NotFoundError('Folder not found');

    if (folder.retry_count >= this.config.maxRetries) {
      log.warn('Folder exceeded max retries, skipping', { folderId, retryCount: folder.retry_count });
      return 0;
    }

    this.db.setFolderRateLimited(folderId, false);
    this.db.incrementFolderRetryCount(folderId);

    const failed = this.db.getFilesByFolderAndStatus(folderId, 'failed');
    const pending = this.db.getFilesByFolderAndStatus(folderId, 'pending');
    const filesToRetry = [...failed, ...pending].filter(
      f => f.retry_count < this.config.maxRetries
    );

    if (filesToRetry.length === 0) return 0;

    const megaFolder = await this.ensureFolderLoaded(folderId, folder.folder_key);
    const filesMap = buildFileMap(megaFolder);

    for (const file of filesToRetry) {
      this.db.updateFileStatus(folderId, file.node_id, 'pending', null, null, null);

      const megaFile = filesMap.get(file.node_id);
      if (megaFile) {
        this.queue.push({
          folderId, nodeId: file.node_id, megaFile, name: file.name, path: file.path, size: file.size,
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

  getMetrics(): { queueDepth: number; activeDownloads: number; cachedFolders: number } {
    return {
      queueDepth: this.queue.length,
      activeDownloads: this.activeDownloads,
      cachedFolders: this.folderCache.size,
    };
  }

  getFilePath(folderId: string, nodeId: string, filename: string, subPath = ''): string {
    const safeName = path.basename(filename);
    return path.join(this.config.downloadDir, folderId, subPath, `${nodeId}_${safeName}`);
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
              folderId, nodeId: file.node_id, megaFile, name: file.name, path: file.path, size: file.size,
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
    const baseIntervalMs = this.config.retryIntervalMinutes * 60 * 1000;

    this.retryTimer = setInterval(async () => {
      const rateLimited = this.db.getRateLimitedFolders();
      const now = Date.now();

      for (const folder of rateLimited) {
        // Exponential backoff: wait baseInterval * 2^(retryCount-1) since last rate limit
        const backoffMs = baseIntervalMs * Math.pow(2, Math.min(folder.retry_count, 6));
        const rateLimitedAt = folder.rate_limited_at ? new Date(folder.rate_limited_at).getTime() : 0;

        if (now - rateLimitedAt < backoffMs) {
          log.debug('Skipping retry, backoff not elapsed', {
            folderId: folder.folder_id,
            retryCount: folder.retry_count,
            backoffMinutes: Math.round(backoffMs / 60000),
          });
          continue;
        }

        if (this.retryingFolders.has(folder.folder_id)) {
          log.debug('Skipping retry, already in progress', { folderId: folder.folder_id });
          continue;
        }

        log.info('Auto-retrying rate-limited folder', {
          folderId: folder.folder_id,
          retryCount: folder.retry_count,
        });

        this.retryingFolders.add(folder.folder_id);
        try {
          await this.retryFolder(folder.folder_id);
        } catch (err) {
          log.error('Failed to auto-retry folder', {
            folderId: folder.folder_id,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          this.retryingFolders.delete(folder.folder_id);
        }
      }
    }, baseIntervalMs);

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
    const cached = this.folderCache.get(folderId);
    if (cached) return cached.folder;

    const url = buildMegaFolderUrl(folderId, folderKey);
    const megaFolder = await loadMegaFolder(url);
    this.folderCache.set(folderId, { folder: megaFolder, cachedAt: Date.now() });
    return megaFolder;
  }

  private evictCacheIfIdle(folderId: string): void {
    const hasActiveWork = this.queue.some(t => t.folderId === folderId);
    if (!hasActiveWork) {
      this.folderCache.delete(folderId);
      log.debug('Evicted folder cache', { folderId });
    }
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
    const { folderId, nodeId, megaFile, name, path: subPath, size } = task;
    const filePath = this.getFilePath(folderId, nodeId, name, subPath);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const startedAt = new Date().toISOString();
    this.db.updateFileStatus(folderId, nodeId, 'downloading', null, startedAt, null);
    this.db.setFolderDownloading(folderId, true);

    log.info('Downloading', { name, size, folderId });

    return new Promise<void>((resolve) => {
      try {
        const stream = megaFile.download({});
        const writeStream = fs.createWriteStream(filePath);

        // Idle timeout: if no data received within the timeout, abort the download
        let idleTimer: NodeJS.Timeout | null = null;
        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            log.warn('Download timed out (idle)', { name, folderId });
            stream.destroy(new Error('Download timed out: no data received'));
          }, this.config.downloadTimeoutMs);
        };

        stream.on('data', resetIdleTimer);
        resetIdleTimer();

        const clearIdle = () => {
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        };

        stream.on('error', (err: Error) => {
          clearIdle();
          writeStream.destroy();
          const completedAt = new Date().toISOString();

          this.db.incrementFileRetryCount(folderId, nodeId);

          if (err.message.includes('ETOOMANY') || err.message.includes('Too many')) {
            log.warn('Rate limited', { name, folderId });
            this.db.updateFileStatus(folderId, nodeId, 'pending', 'Rate limited', null, null);
            this.db.setFolderRateLimited(folderId, true);
          } else {
            log.error('Download failed', { name, error: err.message });
            this.db.updateFileStatus(folderId, nodeId, 'failed', err.message, startedAt, completedAt);
          }

          this.db.refreshFolderDownloadingStatus(folderId);
          this.evictCacheIfIdle(folderId);
          resolve();
        });

        writeStream.on('finish', () => {
          clearIdle();
          const completedAt = new Date().toISOString();

          // Verify file size matches expected size from MEGA
          if (size > 0) {
            try {
              const stat = fs.statSync(filePath);
              if (stat.size !== size) {
                log.error('File size mismatch', {
                  name, folderId, expected: size, actual: stat.size,
                });
                this.db.updateFileStatus(folderId, nodeId, 'failed',
                  `Size mismatch: expected ${size} bytes, got ${stat.size}`,
                  startedAt, completedAt);
                this.db.incrementFileRetryCount(folderId, nodeId);
                this.db.refreshFolderDownloadingStatus(folderId);
                this.evictCacheIfIdle(folderId);
                resolve();
                return;
              }
            } catch {
              // If we can't stat the file, treat as failure
              log.error('Cannot verify downloaded file', { name, folderId });
              this.db.updateFileStatus(folderId, nodeId, 'failed',
                'File verification failed', startedAt, completedAt);
              this.db.refreshFolderDownloadingStatus(folderId);
              this.evictCacheIfIdle(folderId);
              resolve();
              return;
            }
          }

          log.info('Download completed', { name, folderId });
          this.db.updateFileStatus(folderId, nodeId, 'completed', null, startedAt, completedAt);
          this.db.refreshFolderDownloadingStatus(folderId);
          this.evictCacheIfIdle(folderId);
          resolve();
        });

        writeStream.on('error', (err: Error) => {
          clearIdle();
          stream.destroy();
          const completedAt = new Date().toISOString();
          log.error('Write failed', { name, error: err.message });
          this.db.updateFileStatus(folderId, nodeId, 'failed', err.message, startedAt, completedAt);
          this.db.refreshFolderDownloadingStatus(folderId);
          this.evictCacheIfIdle(folderId);
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
