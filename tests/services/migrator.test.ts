import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/services/migrator';

describe('runMigrations', () => {
  it('creates all expected tables', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('schema_migrations');
    expect(tableNames).toContain('folders');
    expect(tableNames).toContain('files');

    db.close();
  });

  it('is idempotent (running twice does not error)', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  it('tracks applied migrations', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const migrations = db
      .prepare('SELECT * FROM schema_migrations ORDER BY version')
      .all() as { version: number; name: string; applied_at: string }[];

    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0].version).toBe(1);
    expect(migrations[0].name).toMatch(/^001_/);
    expect(migrations[0].applied_at).toBeTruthy();

    db.close();
  });

  it('creates folders table with expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const columns = db.prepare('PRAGMA table_info(folders)').all() as { name: string }[];
    const colNames = columns.map(c => c.name);

    expect(colNames).toContain('folder_id');
    expect(colNames).toContain('folder_key');
    expect(colNames).toContain('name');
    expect(colNames).toContain('loaded_at');
    expect(colNames).toContain('downloading');
    expect(colNames).toContain('rate_limited');
    expect(colNames).toContain('retry_count');
    expect(colNames).toContain('patterns');

    db.close();
  });

  it('creates files table with expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const columns = db.prepare('PRAGMA table_info(files)').all() as { name: string }[];
    const colNames = columns.map(c => c.name);

    expect(colNames).toContain('node_id');
    expect(colNames).toContain('folder_id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('path');
    expect(colNames).toContain('size');
    expect(colNames).toContain('status');
    expect(colNames).toContain('retry_count');

    db.close();
  });
});
