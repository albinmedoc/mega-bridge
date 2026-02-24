import Database from 'better-sqlite3';
import type { AppConfig } from '../config';
import { Logger } from '../helpers/logger';
import type { FileRow, FileStatsRow, FolderRow } from '../types';
import { runMigrations } from './migrator';

const log = new Logger('database');

export class DatabaseService {
  private db: Database.Database;
  private stmts!: ReturnType<DatabaseService['prepareStatements']>;

  constructor(config: AppConfig) {
    log.info('Initializing database', { path: config.dbPath });

    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    runMigrations(this.db);
    this.stmts = this.prepareStatements();
  }

  private prepareStatements() {
    return {
      insertFolder: this.db.prepare<[string, string, string, string, number, number, string | null]>(`
        INSERT OR REPLACE INTO folders (folder_id, folder_key, name, loaded_at, downloading, rate_limited, rate_limited_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      getFolder: this.db.prepare<[string]>('SELECT * FROM folders WHERE folder_id = ?'),
      getAllFolders: this.db.prepare('SELECT * FROM folders'),
      deleteFolder: this.db.prepare<[string]>('DELETE FROM folders WHERE folder_id = ?'),
      updateFolderDownloading: this.db.prepare<[number, string]>(
        'UPDATE folders SET downloading = ? WHERE folder_id = ?'
      ),
      updateFolderRateLimited: this.db.prepare<[number, string | null, string]>(
        'UPDATE folders SET rate_limited = ?, rate_limited_at = ? WHERE folder_id = ?'
      ),
      insertFile: this.db.prepare<[string, string, string, number, number | null, string, string | null, string | null, string | null]>(`
        INSERT OR REPLACE INTO files (node_id, folder_id, name, size, timestamp, status, error, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getFile: this.db.prepare<[string, string]>(
        'SELECT * FROM files WHERE folder_id = ? AND node_id = ?'
      ),
      getFilesForFolder: this.db.prepare<[string]>('SELECT * FROM files WHERE folder_id = ?'),
      updateFileStatus: this.db.prepare<[string, string | null, string | null, string | null, string, string]>(
        'UPDATE files SET status = ?, error = ?, started_at = ?, completed_at = ? WHERE folder_id = ? AND node_id = ?'
      ),
      getFilesWithStatus: this.db.prepare<[string]>('SELECT * FROM files WHERE status = ?'),
      deleteFilesForFolder: this.db.prepare<[string]>('DELETE FROM files WHERE folder_id = ?'),
      getFilesByFolderAndStatus: this.db.prepare<[string, string]>(
        'SELECT * FROM files WHERE folder_id = ? AND status = ?'
      ),
      getRateLimitedFolders: this.db.prepare('SELECT * FROM folders WHERE rate_limited = 1'),
      getFileStats: this.db.prepare(`
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
  }

  // ── Folder operations ───────────────────────────────────────────

  insertFolder(folderId: string, folderKey: string, name: string): void {
    const now = new Date().toISOString();
    this.stmts.insertFolder.run(folderId, folderKey, name, now, 0, 0, null);
  }

  getFolder(folderId: string): FolderRow | undefined {
    return this.stmts.getFolder.get(folderId) as FolderRow | undefined;
  }

  getAllFolders(): FolderRow[] {
    return this.stmts.getAllFolders.all() as FolderRow[];
  }

  deleteFolder(folderId: string): void {
    this.stmts.deleteFolder.run(folderId);
  }

  setFolderDownloading(folderId: string, downloading: boolean): void {
    this.stmts.updateFolderDownloading.run(downloading ? 1 : 0, folderId);
  }

  setFolderRateLimited(folderId: string, limited: boolean): void {
    this.stmts.updateFolderRateLimited.run(
      limited ? 1 : 0,
      limited ? new Date().toISOString() : null,
      folderId,
    );
  }

  // ── File operations ─────────────────────────────────────────────

  insertFile(
    nodeId: string, folderId: string, name: string, size: number, timestamp: number | null,
  ): void {
    this.stmts.insertFile.run(nodeId, folderId, name, size, timestamp, 'pending', null, null, null);
  }

  getFile(folderId: string, nodeId: string): FileRow | undefined {
    return this.stmts.getFile.get(folderId, nodeId) as FileRow | undefined;
  }

  getFilesForFolder(folderId: string): FileRow[] {
    return this.stmts.getFilesForFolder.all(folderId) as FileRow[];
  }

  updateFileStatus(
    folderId: string, nodeId: string,
    status: string, error: string | null,
    startedAt: string | null, completedAt: string | null,
  ): void {
    this.stmts.updateFileStatus.run(status, error, startedAt, completedAt, folderId, nodeId);
  }

  getFilesWithStatus(status: string): FileRow[] {
    return this.stmts.getFilesWithStatus.all(status) as FileRow[];
  }

  getFilesByFolderAndStatus(folderId: string, status: string): FileRow[] {
    return this.stmts.getFilesByFolderAndStatus.all(folderId, status) as FileRow[];
  }

  getRateLimitedFolders(): FolderRow[] {
    return this.stmts.getRateLimitedFolders.all() as FolderRow[];
  }

  getFileStats(): FileStatsRow[] {
    return this.stmts.getFileStats.all() as FileStatsRow[];
  }

  // ── Helpers ─────────────────────────────────────────────────────

  refreshFolderDownloadingStatus(folderId: string): void {
    const files = this.getFilesForFolder(folderId);
    const stillDownloading = files.some(f => f.status === 'downloading');
    if (!stillDownloading) {
      this.setFolderDownloading(folderId, false);
    }
  }

  resetInterruptedDownloads(): number {
    const downloading = this.getFilesWithStatus('downloading');
    for (const file of downloading) {
      this.updateFileStatus(file.folder_id, file.node_id, 'pending', null, null, null);
    }
    return downloading.length;
  }

  close(): void {
    log.info('Closing database');
    this.db.close();
  }
}
