# Task: Implement mega-bridge

Create the complete mega-bridge project as specified below. All code goes in a single `server.js` file.

## What to create:
1. `server.js` - All application code
2. `package.json` - With megajs and better-sqlite3 dependencies
3. `Dockerfile` - Multi-stage build with node:20-slim
4. `.dockerignore` - node_modules, .git
5. `README.md` - API docs with curl examples
6. `.github/workflows/docker.yml` - Build & push to ghcr.io/albinmedoc/mega-bridge on push to main, tag with latest + git SHA

## Full Specification

See the card description for complete API spec, database schema, download worker logic, rate limiting, etc.

Key points:
- Node.js 20, no framework (built-in http module only)
- Dependencies: megajs, better-sqlite3
- SQLite for state, in-memory Map for megajs folder objects
- Background download workers with configurable concurrency
- ETOOMANY rate limit handling with automatic retry
- Stream files to/from disk, never hold in memory
- Resume downloads on restart by checking DB state
- Env vars: PORT (3000), DOWNLOAD_DIR (/data/files), DB_PATH (/data/mega-bridge.db), MAX_CONCURRENT (2), RETRY_INTERVAL (60)

## API Endpoints:
- GET /health
- GET /folder - list all folders with aggregate status
- POST /folder - load shared MEGA folder, start background downloads
- GET /folder/:folderId - folder status + all files
- GET /folder/:folderId/:nodeId - download file (stream from disk)
- DELETE /folder/:folderId - remove folder + files
- POST /folder/:folderId/retry - retry failed downloads

## Database Schema:
```sql
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
```

## megajs usage:
- `File.fromURL({ downloadId: folderId, key: folderKey, directory: true })`
- `.loadAttributes()` to load tree
- Flatten children recursively (skip directories)
- `folder.find(n => n.nodeId === nodeId, true)` to find file
- `file.download()` returns readable stream - pipe to disk
- ETOOMANY error = rate limited

## Download worker logic:
- Spawn MAX_CONCURRENT workers per folder
- Each worker loops: get next pending file from DB, set downloading, download, set done/error
- On ETOOMANY: set folder rate_limited=1, stop workers
- Global setInterval every RETRY_INTERVAL minutes to retry rate-limited folders
- On startup: resume folders with pending/downloading files

## File storage:
- Path: DOWNLOAD_DIR/<folderId>/<nodeId>_<filename>
- Stream to disk with createWriteStream
- Clean up partial files on error
- Remove folder directory on DELETE

When done, commit all files, then create the GitHub repo and push:
```bash
gh repo create albinmedoc/mega-bridge --public --source=. --remote=origin --push
```

When completely finished, run this command to notify me:
openclaw gateway wake --text "Done: mega-bridge repo created at albinmedoc/mega-bridge with server.js, Dockerfile, CI pipeline" --mode now
