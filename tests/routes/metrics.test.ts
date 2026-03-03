import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { metricsRouter } from '../../src/routes/metrics';
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

async function request(app: express.Express, method: string, url: string) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      fetch(`http://127.0.0.1:${port}${url}`, { method })
        .then(async (res) => {
          const body = await res.json();
          server.close();
          resolve({ status: res.status, body });
        })
        .catch(() => {
          server.close();
          resolve({ status: 0, body: null });
        });
    });
  });
}

describe('GET /metrics', () => {
  let db: DatabaseService;
  let tmpDir: string;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-bridge-metrics-'));
    fs.mkdirSync(path.join(tmpDir, 'files'), { recursive: true });
    db = new DatabaseService(makeConfig(tmpDir));

    const downloads = {
      getMetrics: vi.fn().mockReturnValue({
        queueDepth: 5,
        activeDownloads: 2,
        cachedFolders: 1,
      }),
    } as unknown as DownloadService;

    app = express();
    app.use('/metrics', metricsRouter(db, downloads));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns metrics with correct shape', async () => {
    const res = await request(app, 'GET', '/metrics');
    expect(res.status).toBe(200);

    expect(res.body.queue).toEqual({
      depth: 5,
      activeDownloads: 2,
      cachedFolders: 1,
    });

    expect(res.body.folders).toEqual({
      total: 0,
      rateLimited: 0,
      downloading: 0,
    });

    expect(res.body.files).toEqual({
      total: 0,
      completed: 0,
      downloading: 0,
      pending: 0,
      failed: 0,
    });

    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.memoryMB).toBe('number');
  });

  it('aggregates file stats across folders', async () => {
    db.insertFolder('f1', 'k1', 'Folder 1');
    db.insertFolder('f2', 'k2', 'Folder 2');
    db.insertFile('n1', 'f1', 'a.txt', '', 100, null);
    db.insertFile('n2', 'f1', 'b.txt', '', 200, null);
    db.insertFile('n3', 'f2', 'c.txt', '', 300, null);

    db.updateFileStatus('f1', 'n1', 'completed', null, null, null);
    db.updateFileStatus('f1', 'n2', 'failed', 'err', null, null);

    const res = await request(app, 'GET', '/metrics');
    expect(res.body.folders.total).toBe(2);
    expect(res.body.files.total).toBe(3);
    expect(res.body.files.completed).toBe(1);
    expect(res.body.files.failed).toBe(1);
    expect(res.body.files.pending).toBe(1);
  });

  it('counts rate-limited and downloading folders', async () => {
    db.insertFolder('f1', 'k1', 'Folder 1');
    db.insertFolder('f2', 'k2', 'Folder 2');
    db.setFolderRateLimited('f1', true);
    db.setFolderDownloading('f2', true);

    const res = await request(app, 'GET', '/metrics');
    expect(res.body.folders.rateLimited).toBe(1);
    expect(res.body.folders.downloading).toBe(1);
  });
});
