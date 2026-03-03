import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  const originalEnv = process.env;
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-bridge-test-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns default values when env vars are not set', () => {
    process.env.DOWNLOAD_DIR = path.join(tmpDir, 'files');
    process.env.DB_PATH = path.join(tmpDir, 'test.db');
    delete process.env.PORT;
    delete process.env.MAX_CONCURRENT;
    delete process.env.RETRY_INTERVAL;
    delete process.env.DOWNLOAD_TIMEOUT;
    delete process.env.MAX_RETRIES;

    const config = loadConfig();
    expect(config.port).toBe(3000);
    expect(config.maxConcurrentDownloads).toBe(2);
    expect(config.retryIntervalMinutes).toBe(1440);
    expect(config.downloadTimeoutMs).toBe(300_000);
    expect(config.maxRetries).toBe(10);
  });

  it('parses env var overrides', () => {
    process.env.DOWNLOAD_DIR = path.join(tmpDir, 'files');
    process.env.DB_PATH = path.join(tmpDir, 'test.db');
    process.env.PORT = '8080';
    process.env.MAX_CONCURRENT = '5';
    process.env.RETRY_INTERVAL = '60';
    process.env.DOWNLOAD_TIMEOUT = '60000';
    process.env.MAX_RETRIES = '3';

    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.maxConcurrentDownloads).toBe(5);
    expect(config.retryIntervalMinutes).toBe(60);
    expect(config.downloadTimeoutMs).toBe(60_000);
    expect(config.maxRetries).toBe(3);
  });

  it('throws on invalid numeric env var', () => {
    process.env.DOWNLOAD_DIR = path.join(tmpDir, 'files');
    process.env.DB_PATH = path.join(tmpDir, 'test.db');
    process.env.PORT = 'abc';

    expect(() => loadConfig()).toThrow('Invalid config: PORT must be a positive integer');
  });

  it('throws on zero value for positive int', () => {
    process.env.DOWNLOAD_DIR = path.join(tmpDir, 'files');
    process.env.DB_PATH = path.join(tmpDir, 'test.db');
    process.env.MAX_CONCURRENT = '0';

    expect(() => loadConfig()).toThrow('Invalid config: MAX_CONCURRENT must be a positive integer');
  });

  it('creates download and db directories', () => {
    const dlDir = path.join(tmpDir, 'nested', 'files');
    const dbPath = path.join(tmpDir, 'nested', 'db', 'test.db');
    process.env.DOWNLOAD_DIR = dlDir;
    process.env.DB_PATH = dbPath;

    loadConfig();
    expect(fs.existsSync(dlDir)).toBe(true);
    expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
  });

  it('uses DOWNLOAD_DIR and DB_PATH from env', () => {
    const dlDir = path.join(tmpDir, 'dl');
    const dbPath = path.join(tmpDir, 'my.db');
    process.env.DOWNLOAD_DIR = dlDir;
    process.env.DB_PATH = dbPath;

    const config = loadConfig();
    expect(config.downloadDir).toBe(dlDir);
    expect(config.dbPath).toBe(dbPath);
  });
});
