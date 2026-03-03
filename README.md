# mega-bridge

HTTP proxy that downloads and serves files from shared MEGA folders. Files are downloaded in the background and served from disk, preserving the original directory structure.

## Endpoints

### Health Check

- `GET /health` - Returns `{ "status": "ok" }`

### Folder Management

- `GET /folder` - List all loaded folders with aggregated download status
- `POST /folder` - Load a shared MEGA folder and start background downloads
  - Body: `{ "url": "https://mega.nz/folder/FOLDER_ID#FOLDER_KEY" }`
- `GET /folder/:folderId` - Get status for a specific folder and all its files
- `DELETE /folder/:folderId` - Remove folder and delete all downloaded files from disk
- `POST /folder/:folderId/retry` - Retry failed/pending downloads for a folder

### File Download

- `GET /folder/:folderId/:nodeId` - Download a specific file (streams from disk)

### Metrics

- `GET /metrics` - Queue depth, active downloads, folder/file stats, uptime, and memory usage

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `DOWNLOAD_DIR` | `/data/files` | Directory for downloaded files |
| `DB_PATH` | `/data/mega-bridge.db` | SQLite database path |
| `MAX_CONCURRENT` | `2` | Maximum concurrent downloads |
| `RETRY_INTERVAL` | `60` | Auto-retry interval for rate-limited folders (minutes) |
| `DOWNLOAD_TIMEOUT` | `300000` | Idle timeout per download in ms (default 5 min) |
| `MAX_RETRIES` | `10` | Max retry attempts per file/folder before giving up |

## Features

- Background download workers with configurable concurrency
- SQLite persistence with better-sqlite3
- Rate limit detection (ETOOMANY) with automatic retry and exponential backoff
- Resume interrupted downloads on startup
- File streaming from disk (never loaded into memory)
- Post-download file size verification
- Idle timeout for stalled downloads
- Preserves MEGA folder directory structure on disk
- `/metrics` endpoint for observability

## Docker

```bash
docker build -t mega-bridge .
docker run -p 3000:3000 -v /path/to/data:/data mega-bridge
```

## Development

```bash
npm install
npm run build
npm start
```
