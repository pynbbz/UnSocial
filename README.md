# UnSocial — Docker Mode

**Social media → RSS feed converter** — runs as a headless Docker container, turning Instagram, Twitter/X, Facebook, and LinkedIn profiles into standard RSS/Atom feeds you can subscribe to in any feed reader.

![Electron](https://img.shields.io/badge/Electron-28-blue)
![Docker](https://img.shields.io/badge/Docker-ready-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Multi-platform** — Instagram, Twitter/X, Facebook (pages, groups, events), LinkedIn (profiles, companies), custom websites, and text file URLs
- **RSS server** — Serves feeds on `http://<server-ip>:3845/feed/<username>`
- **Auto-refresh** — Smart staggered refresh keeps feeds current without hammering platforms
- **Feed authentication** — Optional token-based auth to protect feeds
- **REST management API** — Add, remove, refresh, and configure feeds remotely
- **Persistent storage** — All data survives container restarts

## Quick Start

### Docker Compose (recommended)

```bash
git clone https://github.com/pynbbz/UnSocial.git
cd UnSocial
```

Edit `docker-compose.yml` to set your tokens, then:

```bash
docker compose up -d
```

### Docker Run

```bash
docker run -d \
  --name unsocial \
  -p 3845:3845 \
  -v unsocial-data:/data \
  -e UNSOCIAL_API_TOKEN=my-secret-api-key \
  -e UNSOCIAL_FEED_TOKEN=my-secret-feed-key \
  unsocial
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UNSOCIAL_DATA` | `/data` | Persistent data directory inside the container |
| `UNSOCIAL_API_TOKEN` | *(none)* | Protects `/api/*` management routes — **strongly recommended** |
| `UNSOCIAL_FEED_TOKEN` | *(none)* | Protects RSS feed URLs — readers must append `?token=<value>` |

### Two Tokens, Two Purposes

- **`UNSOCIAL_API_TOKEN`** → secures the management API (`/api/*`). Pass via `?api_token=`, `X-Api-Token` header, or `Authorization: Bearer` header.
- **`UNSOCIAL_FEED_TOKEN`** → secures RSS feed endpoints (`/feed/*`). Pass via `?token=` query param or `Authorization: Bearer` header. Can also be set/changed later via the config API.

## Management API

All endpoints are under `/api/`. Include your `UNSOCIAL_API_TOKEN` in every request if set.

### List feeds
```bash
curl "http://localhost:3845/api/feeds?api_token=YOUR_API_TOKEN"
```

### Add a feed
```bash
curl -X POST "http://localhost:3845/api/feeds?api_token=YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.instagram.com/natgeo/"}'
```

Supported URL formats:
- Instagram: `https://www.instagram.com/username/`
- Twitter/X: `https://x.com/username`
- Facebook: `https://www.facebook.com/pagename`
- LinkedIn: `https://www.linkedin.com/in/username`
- Custom site: any URL + `"selector": "CSS selector"` for scraping
- Text file: direct `.txt` URL

### Remove a feed
```bash
curl -X DELETE "http://localhost:3845/api/feeds?api_token=YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username": "natgeo", "platform": "instagram"}'
```

### Refresh a single feed
```bash
curl -X POST "http://localhost:3845/api/feeds/refresh?api_token=YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username": "natgeo", "platform": "instagram"}'
```

### Refresh all feeds
```bash
curl -X POST "http://localhost:3845/api/refresh-all?api_token=YOUR_API_TOKEN"
```

### Rename a feed
```bash
curl -X PATCH "http://localhost:3845/api/feeds/rename?api_token=YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username": "natgeo", "platform": "instagram", "alias": "National Geographic"}'
```

### View config
```bash
curl "http://localhost:3845/api/config?api_token=YOUR_API_TOKEN"
```

### Update config
```bash
curl -X PATCH "http://localhost:3845/api/config?api_token=YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"checkIntervalMinutes": 60}'
```

Configurable fields: `checkIntervalMinutes`, `tunnelDomain`, `tunnelName`, `feedToken`

### Generate / view feed token via API
```bash
# Generate a new token
curl -X POST "http://localhost:3845/api/token/generate?api_token=YOUR_API_TOKEN"

# View current token
curl "http://localhost:3845/api/token?api_token=YOUR_API_TOKEN"
```

### Check server status
```bash
curl "http://localhost:3845/api/status?api_token=YOUR_API_TOKEN"
```

## Subscribing to Feeds

Once feeds are added, subscribe in your RSS reader using:

```
http://<server-ip>:3845/feed/<username>?token=YOUR_FEED_TOKEN
```

For Atom format, add `&format=atom`:
```
http://<server-ip>:3845/feed/<username>?token=YOUR_FEED_TOKEN&format=atom
```

Visit `http://<server-ip>:3845/` to discover all available feeds.

## Configuration Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `serverPort` | `3845` | RSS server port |
| `checkIntervalMinutes` | `30` | Base refresh interval (timing is randomized ±20 min) |
| `feedToken` | *(empty)* | When set, all feed requests require this token |
| `tunnelDomain` | *(empty)* | Custom domain for public access via Cloudflare Tunnel |
| `tunnelName` | `unsocial-tunnel` | Cloudflare Tunnel name |

## License

MIT — see [LICENSE](LICENSE) for details.

## Disclaimer

This tool is intended for personal use. Scraping social media platforms may violate their terms of service. Use responsibly and at your own risk.
