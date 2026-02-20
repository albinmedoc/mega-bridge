# mega-bridge

HTTP proxy that streams file downloads from shared MEGA links.

## Endpoints

- `GET /download?url={megaUrl}&filename={optional}` — stream a file from MEGA
- `GET /health` — healthcheck

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `TIMEOUT_MS` | `300000` | Download timeout (ms) |

## Docker

```bash
docker build -t mega-bridge .
docker run -p 3000:3000 mega-bridge
```
