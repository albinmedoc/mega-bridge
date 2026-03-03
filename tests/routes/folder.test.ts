import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { folderRouter } from '../../src/routes/folder';
import { errorHandler } from '../../src/middleware/errorHandler';
import { DatabaseService } from '../../src/services/database';
import type { DownloadService } from '../../src/services/download';
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

function mockDownloadService(overrides: Partial<DownloadService> = {}): DownloadService {
  return {
    addFolder: vi.fn().mockResolvedValue({ folderId: 'fId', name: 'Test', fileCount: 5 }),
    removeFolder: vi.fn(),
    manualRetryFolder: vi.fn().mockResolvedValue(3),
    getFilePath: vi.fn().mockReturnValue('/tmp/fake/path'),
    getMetrics: vi.fn().mockReturnValue({ queueDepth: 0, activeDownloads: 0, cachedFolders: 0 }),
    ...overrides,
  } as unknown as DownloadService;
}

// Simple HTTP request helper using Express's built-in test capability
async function request(app: express.Express, method: string, url: string, body?: unknown) {
  return new Promise<{ status: number; body: any; headers: Record<string, string> }>((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const options: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (body) options.body = JSON.stringify(body);

      fetch(`http://127.0.0.1:${port}${url}`, options)
        .then(async (res) => {
          const contentType = res.headers.get('content-type') || '';
          const responseBody = contentType.includes('json') ? await res.json() : null;
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => { headers[k] = v; });
          server.close();
          resolve({ status: res.status, body: responseBody, headers });
        })
        .catch(() => {
          server.close();
          resolve({ status: 0, body: null, headers: {} });
        });
    });
  });
}

describe('folder routes', () => {
  let db: DatabaseService;
  let tmpDir: string;
  let app: express.Express;
  let downloads: DownloadService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-bridge-route-'));
    fs.mkdirSync(path.join(tmpDir, 'files'), { recursive: true });
    db = new DatabaseService(makeConfig(tmpDir));
    downloads = mockDownloadService();
    app = express();
    app.use(express.json());
    app.use('/folder', folderRouter(db, downloads));
    app.use(errorHandler);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /folder', () => {
    it('returns empty array when no folders', async () => {
      const res = await request(app, 'GET', '/folder');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns folder summaries with file stats', async () => {
      db.insertFolder('f1', 'k1', 'Folder 1');
      db.insertFile('n1', 'f1', 'file.txt', '', 100, null);

      const res = await request(app, 'GET', '/folder');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].folderId).toBe('f1');
      expect(res.body[0].name).toBe('Folder 1');
      expect(res.body[0].files.total).toBe(1);
      expect(res.body[0].files.pending).toBe(1);
    });
  });

  describe('POST /folder', () => {
    it('creates a folder and returns 201', async () => {
      const res = await request(app, 'POST', '/folder', {
        url: 'https://mega.nz/folder/ABC#KEY',
      });
      expect(res.status).toBe(201);
      expect(res.body.folderId).toBe('fId');
      expect(res.body.fileCount).toBe(5);
      expect(downloads.addFolder).toHaveBeenCalledWith('https://mega.nz/folder/ABC#KEY', undefined);
    });

    it('returns 400 when url is missing', async () => {
      const res = await request(app, 'POST', '/folder', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/url/i);
    });

    it('returns 400 when patterns is not an array of strings', async () => {
      const res = await request(app, 'POST', '/folder', {
        url: 'https://mega.nz/folder/ABC#KEY',
        patterns: 'not-array',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/patterns/i);
    });

    it('passes patterns to addFolder', async () => {
      await request(app, 'POST', '/folder', {
        url: 'https://mega.nz/folder/ABC#KEY',
        patterns: ['*.txt'],
      });
      expect(downloads.addFolder).toHaveBeenCalledWith(
        'https://mega.nz/folder/ABC#KEY',
        ['*.txt'],
      );
    });
  });

  describe('GET /folder/:folderId', () => {
    it('returns folder detail with files', async () => {
      db.insertFolder('f1', 'k1', 'Folder 1');
      db.insertFile('n1', 'f1', 'file.txt', 'sub', 100, 1700000000);

      const res = await request(app, 'GET', '/folder/f1');
      expect(res.status).toBe(200);
      expect(res.body.folderId).toBe('f1');
      expect(res.body.files).toHaveLength(1);
      expect(res.body.files[0].nodeId).toBe('n1');
      expect(res.body.files[0].path).toBe('sub');
    });

    it('returns 404 for non-existent folder', async () => {
      const res = await request(app, 'GET', '/folder/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /folder/:folderId/:nodeId', () => {
    it('returns 404 when file does not exist', async () => {
      db.insertFolder('f1', 'k1', 'Folder');
      const res = await request(app, 'GET', '/folder/f1/missing');
      expect(res.status).toBe(404);
    });

    it('returns 409 when file is not completed', async () => {
      db.insertFolder('f1', 'k1', 'Folder');
      db.insertFile('n1', 'f1', 'file.txt', '', 100, null);
      // status is 'pending' by default

      const res = await request(app, 'GET', '/folder/f1/n1');
      expect(res.status).toBe(409);
      expect(res.body.status).toBe('pending');
    });

    it('returns 404 when file completed but not on disk', async () => {
      db.insertFolder('f1', 'k1', 'Folder');
      db.insertFile('n1', 'f1', 'file.txt', '', 100, null);
      db.updateFileStatus('f1', 'n1', 'completed', null, null, null);

      // getFilePath returns a path that doesn't exist
      const res = await request(app, 'GET', '/folder/f1/n1');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found on disk/i);
    });

    it('streams file when completed and exists on disk', async () => {
      db.insertFolder('f1', 'k1', 'Folder');
      db.insertFile('n1', 'f1', 'test.txt', '', 5, null);
      db.updateFileStatus('f1', 'n1', 'completed', null, null, null);

      // Create the actual file
      const filePath = path.join(tmpDir, 'files', 'f1', 'n1_test.txt');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'hello');

      // Mock getFilePath to return our temp file
      (downloads.getFilePath as any).mockReturnValue(filePath);

      const res = await request(app, 'GET', '/folder/f1/n1');
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('test.txt');
    });
  });

  describe('DELETE /folder/:folderId', () => {
    it('deletes a folder', async () => {
      db.insertFolder('f1', 'k1', 'Folder');
      const res = await request(app, 'DELETE', '/folder/f1');
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Folder deleted');
      expect(downloads.removeFolder).toHaveBeenCalledWith('f1');
    });
  });

  describe('POST /folder/:folderId/retry', () => {
    it('retries failed downloads', async () => {
      const res = await request(app, 'POST', '/folder/f1/retry');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(3);
      expect(downloads.manualRetryFolder).toHaveBeenCalledWith('f1');
    });
  });
});
