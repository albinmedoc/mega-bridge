import fs from 'fs';
import path from 'path';

export interface AppConfig {
  port: number;
  downloadDir: string;
  dbPath: string;
  maxConcurrentDownloads: number;
  retryIntervalMinutes: number;
  requestBodyMaxBytes: number;
  shutdownTimeoutMs: number;
}

function requirePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid config: ${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const config: AppConfig = {
    port: requirePositiveInt(process.env.PORT, 3000, 'PORT'),
    downloadDir: process.env.DOWNLOAD_DIR || '/data/files',
    dbPath: process.env.DB_PATH || '/data/mega-bridge.db',
    maxConcurrentDownloads: requirePositiveInt(process.env.MAX_CONCURRENT, 2, 'MAX_CONCURRENT'),
    retryIntervalMinutes: requirePositiveInt(process.env.RETRY_INTERVAL, 60, 'RETRY_INTERVAL'),
    requestBodyMaxBytes: requirePositiveInt(process.env.REQUEST_BODY_MAX_BYTES, 1_048_576, 'REQUEST_BODY_MAX_BYTES'),
    shutdownTimeoutMs: requirePositiveInt(process.env.SHUTDOWN_TIMEOUT_MS, 30_000, 'SHUTDOWN_TIMEOUT_MS'),
  };

  // Ensure directories exist
  const dbDir = path.dirname(config.dbPath);
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(config.downloadDir, { recursive: true });

  // Verify write access
  try {
    fs.accessSync(dbDir, fs.constants.W_OK);
  } catch {
    throw new Error(
      `Cannot write to database directory: ${dbDir}. ` +
      'If running in Docker with a volume mount, ensure the volume is writable by the container user.'
    );
  }

  try {
    fs.accessSync(config.downloadDir, fs.constants.W_OK);
  } catch {
    throw new Error(`Cannot write to download directory: ${config.downloadDir}.`);
  }

  return config;
}
