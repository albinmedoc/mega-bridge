# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

mega-bridge is an HTTP proxy that downloads and serves files from shared MEGA folders. It uses Express.js with TypeScript, SQLite for persistence, and the megajs library for MEGA API access.

## Commands

```bash
# Build (TypeScript → dist/)
npm run build

# Run production
npm run start

# Development with hot reload
npm run dev

# Docker
docker build -t mega-bridge .
docker run -p 3000:3000 -v /path/to/data:/data mega-bridge
```

There are no test or lint commands configured.

## Architecture

**Entry point:** `src/server.ts` — bootstraps Express, initializes services, handles graceful shutdown, resumes interrupted downloads on startup.

**Layers:**
- **Routes** (`src/routes/`) — `GET /health`, CRUD on `/folder`, file download via `/folder/:folderId/:nodeId`
- **Services** (`src/services/`) — `DatabaseService` (SQLite with better-sqlite3, WAL mode, prepared statements), `DownloadService` (queue-based with configurable concurrency), `Migrator` (SQL file runner)
- **Helpers** (`src/helpers/`) — `logger` (structured JSON logging), `mega` (MEGA URL parsing, folder loading, recursive file collection)
- **Middleware** (`src/middleware/`) — error handler (maps custom errors to HTTP status), request logger

**Download flow:** POST folder URL → parse & load from MEGA → insert files as 'pending' in DB → DownloadService queues with MAX_CONCURRENT limit → streams to disk as `{DOWNLOAD_DIR}/{folderId}/{nodeId}_{filename}` → rate-limit detection (ETOOMANY) triggers auto-retry after RETRY_INTERVAL.

**Database schema** (`migrations/001_initial.sql`): `folders` and `files` tables. File status enum: `pending` → `downloading` → `completed`/`failed`.

**Custom errors** (`src/types/errors.ts`): `AppError`, `NotFoundError`, `ConflictError` — mapped to 400/404/409/500.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| PORT | 3000 | Server port |
| DOWNLOAD_DIR | /data/files | File storage path |
| DB_PATH | /data/mega-bridge.db | SQLite database path |
| MAX_CONCURRENT | 2 | Concurrent download limit |
| RETRY_INTERVAL | 60 | Minutes between auto-retries |
| DOWNLOAD_TIMEOUT | 300000 | Idle timeout per download (ms) |
| LOG_LEVEL | INFO | DEBUG/INFO/WARN/ERROR |

## Key Conventions

- TypeScript strict mode enabled
- Target ES2022, CommonJS modules
- Files stream directly to disk (never buffered in memory)
- All folder/file state persists in SQLite across restarts
- Structured JSON logging with context-aware loggers per module
