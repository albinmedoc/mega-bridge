import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseService } from '../../src/services/database';
import type { AppConfig } from '../../src/config';

function makeConfig(tmpDir: string): AppConfig {
  return {
    port: 3000,
    downloadDir: path.join(tmpDir, 'files'),
    dbPath: path.join(tmpDir, 'test.db'),
    maxConcurrentDownloads: 2,
    retryIntervalMinutes: 1440,
    requestBodyMaxBytes: 1_048_576,
    shutdownTimeoutMs: 30_000,
    downloadTimeoutMs: 300_000,
    maxRetries: 10,
  };
}

describe('DatabaseService', () => {
  let db: DatabaseService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-bridge-db-'));
    fs.mkdirSync(path.join(tmpDir, 'files'), { recursive: true });
    db = new DatabaseService(makeConfig(tmpDir));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Folder operations ──────────────────────────────────────────

  describe('folder operations', () => {
    it('inserts and retrieves a folder', () => {
      db.insertFolder('f1', 'key1', 'My Folder');
      const folder = db.getFolder('f1');
      expect(folder).toBeDefined();
      expect(folder!.folder_id).toBe('f1');
      expect(folder!.folder_key).toBe('key1');
      expect(folder!.name).toBe('My Folder');
      expect(folder!.downloading).toBe(0);
      expect(folder!.rate_limited).toBe(0);
    });

    it('returns undefined for non-existent folder', () => {
      expect(db.getFolder('nonexistent')).toBeUndefined();
    });

    it('lists all folders', () => {
      db.insertFolder('f1', 'k1', 'Folder 1');
      db.insertFolder('f2', 'k2', 'Folder 2');
      const folders = db.getAllFolders();
      expect(folders).toHaveLength(2);
    });

    it('deletes a folder and its files (cascade)', () => {
      db.insertFolder('f1', 'k1', 'Folder');
      db.insertFile('n1', 'f1', 'file.txt', '', 100, null);
      db.deleteFolder('f1');
      expect(db.getFolder('f1')).toBeUndefined();
      expect(db.getFilesForFolder('f1')).toEqual([]);
    });

    it('sets folder downloading flag', () => {
      db.insertFolder('f1', 'k1', 'Folder');
      db.setFolderDownloading('f1', true);
      expect(db.getFolder('f1')!.downloading).toBe(1);
      db.setFolderDownloading('f1', false);
      expect(db.getFolder('f1')!.downloading).toBe(0);
    });

    it('sets folder rate limited flag', () => {
      db.insertFolder('f1', 'k1', 'Folder');
      db.setFolderRateLimited('f1', true);
      const folder = db.getFolder('f1')!;
      expect(folder.rate_limited).toBe(1);
      expect(folder.rate_limited_at).toBeTruthy();

      db.setFolderRateLimited('f1', false);
      const updated = db.getFolder('f1')!;
      expect(updated.rate_limited).toBe(0);
      expect(updated.rate_limited_at).toBeNull();
    });

    it('stores patterns as JSON', () => {
      db.insertFolder('f1', 'k1', 'Folder', ['*.txt', '*.md']);
      const folder = db.getFolder('f1')!;
      expect(JSON.parse(folder.patterns!)).toEqual(['*.txt', '*.md']);
    });

    it('stores null patterns when none provided', () => {
      db.insertFolder('f1', 'k1', 'Folder');
      expect(db.getFolder('f1')!.patterns).toBeNull();
    });

    it('gets rate-limited folders', () => {
      db.insertFolder('f1', 'k1', 'Folder 1');
      db.insertFolder('f2', 'k2', 'Folder 2');
      db.setFolderRateLimited('f1', true);
      const limited = db.getRateLimitedFolders();
      expect(limited).toHaveLength(1);
      expect(limited[0].folder_id).toBe('f1');
    });
  });

  // ── File operations ────────────────────────────────────────────

  describe('file operations', () => {
    beforeEach(() => {
      db.insertFolder('f1', 'k1', 'Folder');
    });

    it('inserts and retrieves a file', () => {
      db.insertFile('n1', 'f1', 'file.txt', 'sub/dir', 1024, 1700000000);
      const file = db.getFile('f1', 'n1');
      expect(file).toBeDefined();
      expect(file!.node_id).toBe('n1');
      expect(file!.folder_id).toBe('f1');
      expect(file!.name).toBe('file.txt');
      expect(file!.path).toBe('sub/dir');
      expect(file!.size).toBe(1024);
      expect(file!.timestamp).toBe(1700000000);
      expect(file!.status).toBe('pending');
    });

    it('returns undefined for non-existent file', () => {
      expect(db.getFile('f1', 'nonexistent')).toBeUndefined();
    });

    it('gets all files for a folder', () => {
      db.insertFile('n1', 'f1', 'a.txt', '', 100, null);
      db.insertFile('n2', 'f1', 'b.txt', '', 200, null);
      expect(db.getFilesForFolder('f1')).toHaveLength(2);
    });

    it('updates file status', () => {
      db.insertFile('n1', 'f1', 'file.txt', '', 100, null);
      const now = new Date().toISOString();
      db.updateFileStatus('f1', 'n1', 'downloading', null, now, null);
      expect(db.getFile('f1', 'n1')!.status).toBe('downloading');

      db.updateFileStatus('f1', 'n1', 'completed', null, now, now);
      expect(db.getFile('f1', 'n1')!.status).toBe('completed');
    });

    it('updates file status with error', () => {
      db.insertFile('n1', 'f1', 'file.txt', '', 100, null);
      db.updateFileStatus('f1', 'n1', 'failed', 'timeout', null, null);
      const file = db.getFile('f1', 'n1')!;
      expect(file.status).toBe('failed');
      expect(file.error).toBe('timeout');
    });

    it('gets files by status', () => {
      db.insertFile('n1', 'f1', 'a.txt', '', 100, null);
      db.insertFile('n2', 'f1', 'b.txt', '', 200, null);
      db.updateFileStatus('f1', 'n1', 'completed', null, null, null);

      expect(db.getFilesWithStatus('pending')).toHaveLength(1);
      expect(db.getFilesWithStatus('completed')).toHaveLength(1);
      expect(db.getFilesWithStatus('failed')).toHaveLength(0);
    });

    it('gets files by folder and status', () => {
      db.insertFolder('f2', 'k2', 'Folder 2');
      db.insertFile('n1', 'f1', 'a.txt', '', 100, null);
      db.insertFile('n2', 'f2', 'b.txt', '', 200, null);

      expect(db.getFilesByFolderAndStatus('f1', 'pending')).toHaveLength(1);
      expect(db.getFilesByFolderAndStatus('f2', 'pending')).toHaveLength(1);
      expect(db.getFilesByFolderAndStatus('f1', 'completed')).toHaveLength(0);
    });

    it('increments file retry count', () => {
      db.insertFile('n1', 'f1', 'file.txt', '', 100, null);
      db.incrementFileRetryCount('f1', 'n1');
      db.incrementFileRetryCount('f1', 'n1');
      expect(db.getFile('f1', 'n1')!.retry_count).toBe(2);
    });

    it('increments and resets folder retry count', () => {
      db.incrementFolderRetryCount('f1');
      db.incrementFolderRetryCount('f1');
      expect(db.getFolder('f1')!.retry_count).toBe(2);

      db.resetFolderRetryCount('f1');
      expect(db.getFolder('f1')!.retry_count).toBe(0);
    });

    it('resets file retry counts for a folder', () => {
      db.insertFile('n1', 'f1', 'a.txt', '', 100, null);
      db.insertFile('n2', 'f1', 'b.txt', '', 200, null);
      db.incrementFileRetryCount('f1', 'n1');
      db.incrementFileRetryCount('f1', 'n2');

      db.resetFileRetryCountsForFolder('f1');
      expect(db.getFile('f1', 'n1')!.retry_count).toBe(0);
      expect(db.getFile('f1', 'n2')!.retry_count).toBe(0);
    });
  });

  // ── Helpers ────────────────────────────────────────────────────

  describe('helpers', () => {
    it('refreshes folder downloading status based on file status', () => {
      db.insertFolder('f1', 'k1', 'Folder');
      db.insertFile('n1', 'f1', 'file.txt', '', 100, null);

      db.updateFileStatus('f1', 'n1', 'downloading', null, null, null);
      db.refreshFolderDownloadingStatus('f1');
      expect(db.getFolder('f1')!.downloading).toBe(1);

      db.updateFileStatus('f1', 'n1', 'completed', null, null, null);
      db.refreshFolderDownloadingStatus('f1');
      expect(db.getFolder('f1')!.downloading).toBe(0);
    });

    it('resets interrupted downloads', () => {
      db.insertFolder('f1', 'k1', 'Folder');
      db.insertFile('n1', 'f1', 'a.txt', '', 100, null);
      db.insertFile('n2', 'f1', 'b.txt', '', 200, null);

      db.updateFileStatus('f1', 'n1', 'downloading', null, null, null);
      db.updateFileStatus('f1', 'n2', 'downloading', null, null, null);

      const count = db.resetInterruptedDownloads();
      expect(count).toBe(2);
      expect(db.getFile('f1', 'n1')!.status).toBe('pending');
      expect(db.getFile('f1', 'n2')!.status).toBe('pending');
    });

    it('returns 0 when no interrupted downloads', () => {
      db.insertFolder('f1', 'k1', 'Folder');
      db.insertFile('n1', 'f1', 'a.txt', '', 100, null);
      expect(db.resetInterruptedDownloads()).toBe(0);
    });

    it('computes file stats', () => {
      db.insertFolder('f1', 'k1', 'Folder');
      db.insertFile('n1', 'f1', 'a.txt', '', 100, null);
      db.insertFile('n2', 'f1', 'b.txt', '', 200, null);
      db.insertFile('n3', 'f1', 'c.txt', '', 300, null);

      db.updateFileStatus('f1', 'n1', 'completed', null, null, null);
      db.updateFileStatus('f1', 'n2', 'failed', 'err', null, null);

      const stats = db.getFileStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].folder_id).toBe('f1');
      expect(stats[0].total).toBe(3);
      expect(stats[0].completed).toBe(1);
      expect(stats[0].failed).toBe(1);
      expect(stats[0].pending).toBe(1);
    });
  });
});
