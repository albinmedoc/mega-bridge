import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { Logger } from '../helpers/logger';

const log = new Logger('migrator');

// Works from both src/ (dev) and dist/ (production)
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

/**
 * Lightweight migration runner for better-sqlite3.
 *
 * - Reads numbered `.sql` files from the `migrations/` directory
 * - Tracks applied migrations in a `schema_migrations` table
 * - Runs new migrations in order inside a transaction
 *
 * File naming convention: `001_description.sql`, `002_description.sql`, …
 */
export function runMigrations(db: Database.Database): void {
  // Ensure the migrations tracking table exists (this is the only hardcoded DDL)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  // Read migration files
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    log.warn('No migrations directory found', { path: MIGRATIONS_DIR });
    return;
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    log.info('No migration files found');
    return;
  }

  // Determine which migrations have already been applied
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map(r => r.version),
  );

  const pending = files.filter(f => {
    const version = parseMigrationVersion(f);
    return version !== null && !applied.has(version);
  });

  if (pending.length === 0) {
    log.info('Database is up to date', { version: applied.size });
    return;
  }

  log.info('Running migrations', { pending: pending.length });

  for (const file of pending) {
    const version = parseMigrationVersion(file)!;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

    const migrate = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(version, file, new Date().toISOString());
    });

    migrate();
    log.info(`Applied migration`, { version, file });
  }

  log.info('All migrations applied', { total: applied.size + pending.length });
}

function parseMigrationVersion(filename: string): number | null {
  const match = filename.match(/^(\d+)/);
  if (!match) return null;
  return parseInt(match[1], 10);
}
