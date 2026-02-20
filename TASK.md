# Task: Rewrite mega-bridge in TypeScript with ALL endpoints

## Feedback from reviewer
"Du har inte följt Kortets beskrivning, det saknas t.ex många endpoints. Du skulle även kunna skriva det i TypeScript"

## What needs to happen

1. **Convert to TypeScript** - Rename server.js to server.ts, add tsconfig.json, typescript as dev dep, build step
2. **Implement ALL endpoints from the spec** (currently only /download and /health exist):
   - `GET /health` - Health check
   - `GET /folder` - List all loaded folders with aggregated download status
   - `POST /folder` - Load a shared MEGA folder, start background downloads
   - `GET /folder/:folderId` - Status for specific folder and all its files
   - `GET /folder/:folderId/:nodeId` - Download a specific file (stream from disk)
   - `DELETE /folder/:folderId` - Remove folder and delete files from disk
   - `POST /folder/:folderId/retry` - Retry failed downloads

3. **Use Node.js built-in `http` module** - NO Express, NO Fastify
4. **Use `better-sqlite3`** for persistence (SQLite)
5. **Use `megajs`** for MEGA downloads
6. **Background download workers** with configurable concurrency (MAX_CONCURRENT, default 2)
7. **Rate limit handling** - detect ETOOMANY, mark folder as rate limited, auto-retry via global setInterval (RETRY_INTERVAL minutes, default 60)
8. **File storage** at DOWNLOAD_DIR/<folderId>/<nodeId>_<filename>
9. **On startup**, resume interrupted downloads (check DB for pending/downloading files)
10. **Route parsing** - manual URL parsing, no framework

## Database schema (better-sqlite3)
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

## Environment Variables
- PORT (default 3000)
- DOWNLOAD_DIR (default /data/files)
- DB_PATH (default /data/mega-bridge.db)
- MAX_CONCURRENT (default 2)
- RETRY_INTERVAL (default 60, minutes)

## Project structure
```
mega-bridge/
├── Dockerfile
├── package.json
├── tsconfig.json
├── src/
│   └── server.ts      # All code in single file
├── README.md
└── .dockerignore
```

## Important
- Keep it in a SINGLE server.ts file
- Stream files from disk with fs.createReadStream, never load into memory
- megajs File objects are NOT serializable, keep in-memory Map
- Update Dockerfile for TypeScript build step
- Update package.json with typescript, @types/better-sqlite3, build script
- Update GitHub Actions workflow if it exists
- Update README with all endpoints
- Commit all changes with a descriptive message and push

When completely finished, run: openclaw gateway wake --text "Trello: MegaJs Proxy omskriven i TypeScript med alla endpoints enligt spec. Pushat till GitHub." --mode now
