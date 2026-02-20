import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import Database from 'better-sqlite3';
import mega from 'megajs';

// Environment variables
const PORT = parseInt(process.env.PORT || '3000', 10);
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/data/files';
const DB_PATH = process.env.DB_PATH || '/data/mega-bridge.db';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10);
const RETRY_INTERVAL = parseInt(process.env.RETRY_INTERVAL || '60', 10);

// Initialize database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    folder_id TEXT PRIMARY KEY,
    folder_key TEXT NOT NULL,
    name TEXT,
    loaded_at TEXT NOT NULL,
    downloading INTEGER NOT NULL DEFAULT 0,
    rate_limited INTEGER NOT NULL DEFAULT 0,
    rate_limited_at TEXT
  );

  CREATE TABLE IF NOT EXISTS files (
    node_id TEXT NOT NULL,
    folder_id TEXT NOT NULL REFERENCES folders(folder_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    timestamp INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    PRIMARY KEY (folder_id, node_id)
  );
`);

// Prepared statements
const stmts = {
  insertFolder: db.prepare(`
    INSERT OR REPLACE INTO folders (folder_id, folder_key, name, loaded_at, downloading, rate_limited, rate_limited_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getFolder: db.prepare('SELECT * FROM folders WHERE folder_id = ?'),
  getAllFolders: db.prepare('SELECT * FROM folders'),
  deleteFolder: db.prepare('DELETE FROM folders WHERE folder_id = ?'),
  updateFolderDownloading: db.prepare('UPDATE folders SET downloading = ? WHERE folder_id = ?'),
  updateFolderRateLimited: db.prepare('UPDATE folders SET rate_limited = ?, rate_limited_at = ? WHERE folder_id = ?'),
  insertFile: db.prepare(`
    INSERT OR REPLACE INTO files (node_id, folder_id, name, size, timestamp, status, error, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getFile: db.prepare('SELECT * FROM files WHERE folder_id = ? AND node_id = ?'),
  getFilesForFolder: db.prepare('SELECT * FROM files WHERE folder_id = ?'),
  updateFileStatus: db.prepare('UPDATE files SET status = ?, error = ?, started_at = ?, completed_at = ? WHERE folder_id = ? AND node_id = ?'),
  getFilesWithStatus: db.prepare('SELECT * FROM files WHERE status = ?'),
  deleteFilesForFolder: db.prepare('DELETE FROM files WHERE folder_id = ?'),
  getFailedFilesForFolder: db.prepare('SELECT * FROM files WHERE folder_id = ? AND status = ?'),
  getRateLimitedFolders: db.prepare('SELECT * FROM folders WHERE rate_limited = 1'),
  getFileStats: db.prepare(`
    SELECT
      folder_id,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'downloading' THEN 1 ELSE 0 END) as downloading,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM files
    GROUP BY folder_id
  `),
};

// In-memory map for megajs File objects (not serializable)
const folderCache = new Map<string, mega.File>();

// Download queue
interface DownloadTask {
  folderId: string;
  nodeId: string;
  megaFile: mega.File;
  name: string;
  size: number;
}

const downloadQueue: DownloadTask[] = [];
let activeDownloads = 0;

// Helper to send JSON response
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Parse MEGA folder URL
function parseMegaFolderUrl(url: string): { folderId: string; folderKey: string } | null {
  // Format: https://mega.nz/folder/FOLDER_ID#FOLDER_KEY
  const match = url.match(/mega\.nz\/folder\/([^#]+)#(.+)/);
  if (match) {
    return { folderId: match[1], folderKey: match[2] };
  }
  return null;
}

// Get file path on disk
function getFilePath(folderId: string, nodeId: string, filename: string): string {
  const folderPath = path.join(DOWNLOAD_DIR, folderId);
  return path.join(folderPath, `${nodeId}_${filename}`);
}

// Ensure directory exists
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Process download queue
async function processDownloadQueue(): Promise<void> {
  while (activeDownloads < MAX_CONCURRENT && downloadQueue.length > 0) {
    const task = downloadQueue.shift();
    if (!task) break;

    activeDownloads++;
    downloadFile(task).finally(() => {
      activeDownloads--;
      processDownloadQueue();
    });
  }
}

// Download a single file
async function downloadFile(task: DownloadTask): Promise<void> {
  const { folderId, nodeId, megaFile, name, size } = task;
  const filePath = getFilePath(folderId, nodeId, name);
  const folderPath = path.dirname(filePath);

  ensureDir(folderPath);

  // Update status to downloading
  const now = new Date().toISOString();
  stmts.updateFileStatus.run('downloading', null, now, null, folderId, nodeId);
  stmts.updateFolderDownloading.run(1, folderId);

  console.log(`[${now}] Downloading: ${name} (${size} bytes)`);

  return new Promise<void>((resolve) => {
    try {
      const stream = megaFile.download({});
      const writeStream = fs.createWriteStream(filePath);

      stream.on('error', (err: Error) => {
        writeStream.destroy();
        const errorMsg = err.message;
        const completedAt = new Date().toISOString();

        // Check for rate limiting
        if (errorMsg.includes('ETOOMANY') || errorMsg.includes('Too many')) {
          console.log(`[${completedAt}] Rate limited: ${name}`);
          stmts.updateFileStatus.run('pending', 'Rate limited', null, null, folderId, nodeId);
          stmts.updateFolderRateLimited.run(1, completedAt, folderId);
        } else {
          console.error(`[${completedAt}] Download failed: ${name} - ${errorMsg}`);
          stmts.updateFileStatus.run('failed', errorMsg, now, completedAt, folderId, nodeId);
        }

        // Check if any files are still downloading for this folder
        const downloading = stmts.getFilesForFolder.all(folderId) as { status: string }[];
        const stillDownloading = downloading.some(f => f.status === 'downloading');
        if (!stillDownloading) {
          stmts.updateFolderDownloading.run(0, folderId);
        }

        resolve();
      });

      writeStream.on('finish', () => {
        const completedAt = new Date().toISOString();
        console.log(`[${completedAt}] Completed: ${name}`);
        stmts.updateFileStatus.run('completed', null, now, completedAt, folderId, nodeId);

        // Check if any files are still downloading for this folder
        const downloading = stmts.getFilesForFolder.all(folderId) as { status: string }[];
        const stillDownloading = downloading.some(f => f.status === 'downloading');
        if (!stillDownloading) {
          stmts.updateFolderDownloading.run(0, folderId);
        }

        resolve();
      });

      writeStream.on('error', (err: Error) => {
        stream.destroy();
        const completedAt = new Date().toISOString();
        console.error(`[${completedAt}] Write failed: ${name} - ${err.message}`);
        stmts.updateFileStatus.run('failed', err.message, now, completedAt, folderId, nodeId);

        // Check if any files are still downloading for this folder
        const downloading = stmts.getFilesForFolder.all(folderId) as { status: string }[];
        const stillDownloading = downloading.some(f => f.status === 'downloading');
        if (!stillDownloading) {
          stmts.updateFolderDownloading.run(0, folderId);
        }

        resolve();
      });

      stream.pipe(writeStream);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      const completedAt = new Date().toISOString();
      console.error(`[${completedAt}] Download error: ${name} - ${errorMsg}`);
      stmts.updateFileStatus.run('failed', errorMsg, now, completedAt, folderId, nodeId);
      stmts.updateFolderDownloading.run(0, folderId);
      resolve();
    }
  });
}

// Load a MEGA folder and queue downloads
async function loadMegaFolder(url: string): Promise<{ folderId: string; name: string; fileCount: number }> {
  const parsed = parseMegaFolderUrl(url);
  if (!parsed) {
    throw new Error('Invalid MEGA folder URL');
  }

  const { folderId, folderKey } = parsed;

  // Check if already loaded
  const existing = stmts.getFolder.get(folderId);
  if (existing) {
    throw new Error('Folder already loaded');
  }

  // Load folder from MEGA
  const folder = mega.File.fromURL(url);
  await folder.loadAttributes();

  const folderName = folder.name || folderId;
  const now = new Date().toISOString();

  // Save folder to DB
  stmts.insertFolder.run(folderId, folderKey, folderName, now, 0, 0, null);

  // Cache the folder object
  folderCache.set(folderId, folder as mega.File);

  // Get all files in folder
  const children = folder.children || [];
  const files = children.filter((child: mega.File) => !child.directory);

  // Save files to DB and queue downloads
  for (const file of files) {
    const nodeId = file.nodeId || file.downloadId?.[1] || '';
    const fileName = file.name || 'unknown';
    const fileSize = file.size || 0;
    const timestamp = file.timestamp || null;

    stmts.insertFile.run(nodeId, folderId, fileName, fileSize, timestamp, 'pending', null, null, null);

    downloadQueue.push({
      folderId,
      nodeId,
      megaFile: file,
      name: fileName,
      size: fileSize,
    });
  }

  // Start processing downloads
  processDownloadQueue();

  return { folderId, name: folderName, fileCount: files.length };
}

// Retry failed downloads for a folder
async function retryFailedDownloads(folderId: string): Promise<number> {
  const folder = stmts.getFolder.get(folderId) as { folder_id: string; folder_key: string } | undefined;
  if (!folder) {
    throw new Error('Folder not found');
  }

  // Clear rate limited status
  stmts.updateFolderRateLimited.run(0, null, folderId);

  // Get failed files
  const failedFiles = stmts.getFailedFilesForFolder.all(folderId, 'failed') as { node_id: string; name: string; size: number }[];
  const pendingFiles = stmts.getFailedFilesForFolder.all(folderId, 'pending') as { node_id: string; name: string; size: number }[];
  const filesToRetry = [...failedFiles, ...pendingFiles];

  if (filesToRetry.length === 0) {
    return 0;
  }

  // Load folder from cache or MEGA
  let megaFolder = folderCache.get(folderId);
  if (!megaFolder) {
    const url = `https://mega.nz/folder/${folderId}#${folder.folder_key}`;
    megaFolder = mega.File.fromURL(url) as mega.File;
    await megaFolder.loadAttributes();
    folderCache.set(folderId, megaFolder);
  }

  const children = megaFolder.children || [];
  const filesMap = new Map<string, mega.File>();
  for (const child of children) {
    if (!child.directory) {
      const nodeId = child.nodeId || child.downloadId?.[1] || '';
      filesMap.set(nodeId, child);
    }
  }

  // Reset status and queue downloads
  for (const file of filesToRetry) {
    stmts.updateFileStatus.run('pending', null, null, null, folderId, file.node_id);

    const megaFile = filesMap.get(file.node_id);
    if (megaFile) {
      downloadQueue.push({
        folderId,
        nodeId: file.node_id,
        megaFile,
        name: file.name,
        size: file.size,
      });
    }
  }

  // Start processing downloads
  processDownloadQueue();

  return filesToRetry.length;
}

// Delete folder and files
function deleteFolder(folderId: string): void {
  const folder = stmts.getFolder.get(folderId);
  if (!folder) {
    throw new Error('Folder not found');
  }

  // Remove from download queue
  for (let i = downloadQueue.length - 1; i >= 0; i--) {
    if (downloadQueue[i].folderId === folderId) {
      downloadQueue.splice(i, 1);
    }
  }

  // Delete files from disk
  const folderPath = path.join(DOWNLOAD_DIR, folderId);
  if (fs.existsSync(folderPath)) {
    fs.rmSync(folderPath, { recursive: true, force: true });
  }

  // Delete from database (cascade will delete files)
  stmts.deleteFolder.run(folderId);

  // Remove from cache
  folderCache.delete(folderId);
}

// Route handlers
type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => Promise<void> | void;

const routes: { method: string; pattern: RegExp; handler: RouteHandler }[] = [];

function addRoute(method: string, pattern: string, handler: RouteHandler): void {
  // Convert :param to named capture groups
  const regexPattern = pattern
    .replace(/\/:([^/]+)/g, '/(?<$1>[^/]+)')
    .replace(/\//g, '\\/');
  routes.push({
    method,
    pattern: new RegExp(`^${regexPattern}$`),
    handler,
  });
}

// GET /health
addRoute('GET', '/health', (_req, res) => {
  sendJson(res, 200, { status: 'ok' });
});

// GET /folder - List all loaded folders
addRoute('GET', '/folder', (_req, res) => {
  const folders = stmts.getAllFolders.all() as { folder_id: string; name: string; loaded_at: string; downloading: number; rate_limited: number; rate_limited_at: string | null }[];
  const stats = stmts.getFileStats.all() as { folder_id: string; total: number; completed: number; downloading: number; pending: number; failed: number }[];
  const statsMap = new Map(stats.map(s => [s.folder_id, s]));

  const result = folders.map(f => {
    const s = statsMap.get(f.folder_id) || { total: 0, completed: 0, downloading: 0, pending: 0, failed: 0 };
    return {
      folderId: f.folder_id,
      name: f.name,
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

  sendJson(res, 200, result);
});

// POST /folder - Load a shared MEGA folder
addRoute('POST', '/folder', async (req, res) => {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  let data: { url?: string };
  try {
    data = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  if (!data.url) {
    sendJson(res, 400, { error: 'Missing required field: url' });
    return;
  }

  try {
    const result = await loadMegaFolder(data.url);
    sendJson(res, 201, {
      folderId: result.folderId,
      name: result.name,
      fileCount: result.fileCount,
      message: 'Folder loaded, downloads started',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('already loaded') ? 409 : 400;
    sendJson(res, status, { error: message });
  }
});

// GET /folder/:folderId - Status for specific folder
addRoute('GET', '/folder/:folderId', (_req, res, params) => {
  const { folderId } = params;
  const folder = stmts.getFolder.get(folderId) as { folder_id: string; name: string; loaded_at: string; downloading: number; rate_limited: number; rate_limited_at: string | null } | undefined;

  if (!folder) {
    sendJson(res, 404, { error: 'Folder not found' });
    return;
  }

  const files = stmts.getFilesForFolder.all(folderId) as { node_id: string; name: string; size: number; timestamp: number | null; status: string; error: string | null; started_at: string | null; completed_at: string | null }[];

  sendJson(res, 200, {
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

// GET /folder/:folderId/:nodeId - Download a specific file
addRoute('GET', '/folder/:folderId/:nodeId', (_req, res, params) => {
  const { folderId, nodeId } = params;
  const file = stmts.getFile.get(folderId, nodeId) as { node_id: string; name: string; size: number; status: string } | undefined;

  if (!file) {
    sendJson(res, 404, { error: 'File not found' });
    return;
  }

  if (file.status !== 'completed') {
    sendJson(res, 409, { error: 'File not ready', status: file.status });
    return;
  }

  const filePath = getFilePath(folderId, nodeId, file.name);

  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'File not found on disk' });
    return;
  }

  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
    'Content-Length': stat.size,
  });

  const readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

// DELETE /folder/:folderId - Remove folder and delete files
addRoute('DELETE', '/folder/:folderId', (_req, res, params) => {
  const { folderId } = params;

  try {
    deleteFolder(folderId);
    sendJson(res, 200, { message: 'Folder deleted' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    sendJson(res, 404, { error: message });
  }
});

// POST /folder/:folderId/retry - Retry failed downloads
addRoute('POST', '/folder/:folderId/retry', async (_req, res, params) => {
  const { folderId } = params;

  try {
    const count = await retryFailedDownloads(folderId);
    sendJson(res, 200, { message: 'Retrying failed downloads', count });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    sendJson(res, 404, { error: message });
  }
});

// Request handler
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method || 'GET';
  const urlStr = req.url || '/';
  const parsedUrl = new URL(urlStr, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);

  for (const route of routes) {
    if (route.method !== method) continue;

    const match = pathname.match(route.pattern);
    if (match) {
      const params = match.groups || {};
      try {
        await route.handler(req, res, params);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error handling ${method} ${pathname}:`, err);
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'Internal server error' });
        }
      }
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}

// Resume interrupted downloads on startup
async function resumeDownloads(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Checking for interrupted downloads...`);

  // Reset downloading status to pending
  const downloading = stmts.getFilesWithStatus.all('downloading') as { folder_id: string; node_id: string; name: string; size: number }[];
  for (const file of downloading) {
    stmts.updateFileStatus.run('pending', null, null, null, file.folder_id, file.node_id);
  }

  // Get all folders with pending files
  const pending = stmts.getFilesWithStatus.all('pending') as { folder_id: string; node_id: string; name: string; size: number }[];
  const folderIds = [...new Set(pending.map(f => f.folder_id))];

  for (const folderId of folderIds) {
    const folder = stmts.getFolder.get(folderId) as { folder_id: string; folder_key: string } | undefined;
    if (!folder) continue;

    try {
      // Load folder from MEGA
      const url = `https://mega.nz/folder/${folderId}#${folder.folder_key}`;
      const megaFolder = mega.File.fromURL(url) as mega.File;
      await megaFolder.loadAttributes();
      folderCache.set(folderId, megaFolder);

      const children = megaFolder.children || [];
      const filesMap = new Map<string, mega.File>();
      for (const child of children) {
        if (!child.directory) {
          const nodeId = child.nodeId || child.downloadId?.[1] || '';
          filesMap.set(nodeId, child);
        }
      }

      // Queue pending files
      const folderPending = pending.filter(f => f.folder_id === folderId);
      for (const file of folderPending) {
        const megaFile = filesMap.get(file.node_id);
        if (megaFile) {
          downloadQueue.push({
            folderId,
            nodeId: file.node_id,
            megaFile,
            name: file.name,
            size: file.size,
          });
        }
      }

      console.log(`[${new Date().toISOString()}] Resuming ${folderPending.length} downloads for folder ${folderId}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to resume folder ${folderId}:`, err);
    }
  }

  // Start processing
  processDownloadQueue();
}

// Retry rate-limited folders periodically
function startRetryInterval(): void {
  setInterval(async () => {
    const rateLimited = stmts.getRateLimitedFolders.all() as { folder_id: string }[];
    for (const folder of rateLimited) {
      console.log(`[${new Date().toISOString()}] Auto-retrying rate-limited folder ${folder.folder_id}`);
      try {
        await retryFailedDownloads(folder.folder_id);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to retry folder ${folder.folder_id}:`, err);
      }
    }
  }, RETRY_INTERVAL * 60 * 1000);
}

// Ensure download directory exists
ensureDir(DOWNLOAD_DIR);

// Create and start server
const server = http.createServer(handleRequest);

server.listen(PORT, async () => {
  console.log(`[${new Date().toISOString()}] mega-bridge listening on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Download directory: ${DOWNLOAD_DIR}`);
  console.log(`[${new Date().toISOString()}] Database: ${DB_PATH}`);
  console.log(`[${new Date().toISOString()}] Max concurrent downloads: ${MAX_CONCURRENT}`);
  console.log(`[${new Date().toISOString()}] Retry interval: ${RETRY_INTERVAL} minutes`);

  await resumeDownloads();
  startRetryInterval();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] Received SIGTERM, shutting down...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log(`[${new Date().toISOString()}] Received SIGINT, shutting down...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
