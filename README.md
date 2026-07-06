# plex-strm-assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker Hub](https://img.shields.io/docker/pulls/liveinaus/plex-strm-assistant)](https://hub.docker.com/r/liveinaus/plex-strm-assistant)

Enables `.strm` file playback in Plex. Plex dropped native `.strm` support, so this tool bridges the gap with two components:

![Plex Media Info showing proxy URL and H.264 direct play](docs/media-info.png)

- **strm-proxy**: a lightweight HTTP server that reads a `.strm` file and returns a `302` redirect to the URL inside it.
- **SQLite triggers**: installed once into the Plex database. Whenever Plex scans a `.strm` file, the trigger rewrites the stored path to a proxy URL (`http://strm-proxy:3000/...`). Rescans are handled automatically, so no re-patching is needed.

---

## Quick start (Docker Compose)

This is the recommended setup. Plex and the proxy run in the same Compose file and share a Docker network, so the proxy is reachable at `strm-proxy` without exposing an IP address.

**Prerequisites:** Docker with the Compose plugin.

### 1. Create the project folder

```bash
mkdir plex-strm && cd plex-strm
mkdir strm plex-config
```

- `strm/` holds your `.strm` files (see [.strm file format](#strm-file-format) below)
- `plex-config/` persists the Plex configuration and database

### 2. Create `docker-compose.yml`

All proxy settings have sensible defaults built into the image, so no environment configuration is needed for this layout:

```yaml
services:
  strm-proxy:
    image: liveinaus/plex-strm-assistant
    container_name: strm-proxy
    environment:
      - SKIP_SETUP=${SKIP_SETUP:-false}
    volumes:
      - ./strm:/strm:ro
      - ./plex-config:/plex-config
    ports:
      - '3000:3000'
    restart: unless-stopped

  plex:
    image: lscr.io/linuxserver/plex:latest
    container_name: plex
    ports:
      - '32400:32400'
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Australia/Sydney
      - VERSION=docker
      - PLEX_CLAIM=${PLEX_CLAIM:-}
    volumes:
      - ./plex-config:/config
      - ./strm:/media/strm:ro
    restart: unless-stopped
```

> **Tip:** to link Plex to your account, get a claim token from [plex.tv/claim](https://www.plex.tv/claim/) (valid for 4 minutes) and start with `PLEX_CLAIM=claim-xxxx docker compose up plex`.

### 3. Start Plex alone and let it initialise

Plex needs to create its database before the triggers can be installed:

```bash
docker compose up -d plex
```

Open `http://localhost:32400/web` and complete the initial setup wizard. Then stop Plex:

```bash
docker compose stop plex
```

> **Important:** Plex must be stopped for the next step. Writing to the Plex database while Plex is running risks database corruption.

### 4. Start the proxy to install the triggers

```bash
docker compose up strm-proxy
```

Wait for this output, which confirms the triggers are installed:

```text
strm-proxy | Setup complete. Plex rescans and new .strm files are now handled automatically.
strm-proxy | strm-proxy on :3000  root: /strm
```

Press `Ctrl+C` to stop it.

### 5. Start everything

```bash
docker compose up -d
```

In Plex, add a library pointing at `/media/strm` and run a scan. Files will be playable immediately.

---

## .strm file format

Each `.strm` file contains a single HTTP/HTTPS URL:

```text
https://example.com/path/to/video.mp4
```

Organise them under `strm/` the same way you would real media files:

```text
strm/
  Movies/
    Big Buck Bunny (2008)/
      Big Buck Bunny (2008).strm
  TV Shows/
    Some Show/
      Season 01/
        Some Show - S01E01.strm
```

New `.strm` files are picked up automatically on the next Plex scan. No proxy restart is required.

---

## Restarting the proxy

The triggers only need to be installed once. To restart the proxy at any time without stopping Plex, set `SKIP_SETUP=true` so trigger installation is skipped:

```bash
SKIP_SETUP=true docker compose up -d strm-proxy
```

---

## Configuration

All variables are optional. The defaults match the Quick start layout, so you only need these if your mount paths or hostnames differ.

| Variable           | Default                                                                                                               | Description                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`             | `3000`                                                                                                                | Port the proxy listens on (also used to build stored proxy URLs)                                                                                                                  |
| `STRM_PROXY_HOST`  | `strm-proxy`                                                                                                          | Hostname used in proxy URLs stored in the Plex DB                                                                                                                                 |
| `STRM_ROOT`        | `/strm`                                                                                                               | Mount point for `.strm` files inside the proxy container                                                                                                                          |
| `CONTAINER_PREFIX` | `/media/strm`                                                                                                         | Path where `.strm` files are mounted inside the Plex container                                                                                                                    |
| `DB_PATH`          | `/plex-config/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db` | Full path to the Plex database inside the proxy container                                                                                                                         |
| `SKIP_SETUP`       | `false`                                                                                                               | Set to `true` to skip trigger installation (safe while Plex is running)                                                                                                           |
| `FOLLOW_REDIRECTS` | `false`                                                                                                               | Set to `true` to resolve the source URL's redirect chain server-side and return the final URL to Plex. Needed for services where the `.strm` URL is a redirector (e.g. 115 Drive) |
| `GATEWAY_ENABLED`  | `false`                                                                                                               | Set to `true` to start the direct streaming gateway alongside the proxy                                                                                                           |
| `GATEWAY_PORT`     | `32500`                                                                                                               | Port the gateway listens on                                                                                                                                                       |
| `PLEX_UPSTREAM`    | `http://plex:32400`                                                                                                   | Plex Media Server address the gateway forwards to                                                                                                                                 |

---

## Alternative setups

### Standalone (Plex runs elsewhere)

If Plex is already running outside of Docker Compose, run the proxy on its own. Set `STRM_PROXY_HOST` to a hostname or IP reachable by both the Plex server and your Plex clients. The first-run order still applies: stop Plex before the first start of the proxy so the triggers can be installed safely.

```bash
docker run -d \
  --name strm-proxy \
  -p 3000:3000 \
  -v /path/to/your/strm:/strm:ro \
  -v /path/to/plex/config:/plex-config \
  -e STRM_PROXY_HOST=<hostname-or-ip> \
  liveinaus/plex-strm-assistant
```

### Multiple `.strm` directories

If your `.strm` files live in separate directories, mount each one as a subdirectory under `/strm`. The trigger matches everything under the prefix recursively, so no code changes are needed.

```bash
docker run -d \
  --name strm-proxy \
  -p 3000:3000 \
  -v /path/to/movies-strm:/strm/Movies:ro \
  -v /path/to/tv-strm:/strm/TV:ro \
  -v /path/to/plex/config:/plex-config \
  -e STRM_PROXY_HOST=<hostname-or-ip> \
  liveinaus/plex-strm-assistant
```

Mount the same directories into Plex under `/media/strm/Movies` and `/media/strm/TV` respectively so the paths align.

### Redirect-based services (e.g. 115 Drive)

Some services store a redirector URL in the `.strm` file rather than a direct media URL, and require an extra redirect step before the real stream URL is issued. Enable server-side redirect resolution on the proxy:

```yaml
strm-proxy:
  environment:
    - FOLLOW_REDIRECTS=true
```

On each play request the proxy follows the redirect chain (forwarding the caller's User-Agent, which services like 115 bind the stream URL to) and returns the final URL to Plex. Streaming still flows through the Plex server as normal. To stream directly from the source to your clients instead, see the gateway below.

> **Note for 115 Drive:** Plex's media analysis makes many requests per file during a library scan, which can trip 115's rate limits. Keep libraries small until scan-time processing can be disabled (see Roadmap).

### Direct streaming gateway (traffic bypasses the Plex server)

By default, Plex fetches the stream itself and relays it to your clients (source -> Plex -> client). Gateway mode removes Plex from the media path: once playback starts, video flows straight from the source to the client (e.g. 115 -> client), similar to what [MediaWarp](https://github.com/AkimioJR/MediaWarp) does for Emby and Jellyfin.

It works as a reverse proxy in front of Plex. Clients connect to the gateway port instead of Plex. All requests pass through to Plex untouched, except direct-play requests for `.strm` items: the gateway resolves the final source URL (using a read-only view of the Plex database, safe while Plex runs) and answers with a `302` that the client follows directly.

Enable it on the proxy service and publish the gateway port:

```yaml
strm-proxy:
  environment:
    - GATEWAY_ENABLED=true
    - FOLLOW_REDIRECTS=true # resolve redirector URLs (e.g. 115) per play request
  ports:
    - '3000:3000'
    - '32500:32500'
```

Then point your clients at the gateway instead of Plex:

- In Plex Web / apps, connect to `http://<your-host>:32500`
- For automatic discovery, set **Settings > Network > Custom server access URLs** in Plex to `http://<your-host>:32500`

Notes:

- Only direct play is redirected. Transcoded playback still flows through the Plex server (Plex must read the stream to transcode it).
- The client fetches the media itself, so it must be able to reach the source URL (internet access to the CDN).
- Like similar tools, the gateway redirects media part requests without validating the Plex token, so keep the gateway port on your LAN or behind a VPN rather than exposing it to the internet.

---

## Troubleshooting

### Proxy logs "Waiting for Plex DB"

The proxy could not find the Plex database at `DB_PATH`. Make sure Plex has been started at least once (step 3 of the Quick start) and that the Plex config directory is mounted at `/plex-config` in the proxy container.

### "Database disk image is malformed"

If Plex reports this, recover the database:

```bash
# Stop Plex first
DB="/path/to/plex/config/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db"
sqlite3 "$DB" ".recover" | sqlite3 "${DB}.fresh"
mv "$DB" "${DB}.dead" && mv "${DB}.fresh" "$DB"
rm -f "${DB}-wal" "${DB}-shm"
# Start Plex again
```

---

## Roadmap

- [x] HTTP proxy that resolves `.strm` files to stream URLs via `302` redirect
- [x] SQLite triggers to survive Plex rescans automatically
- [x] Inject H.264/AAC codec metadata to force direct play (no transcoding)
- [x] Docker container that installs triggers on start, then runs the proxy
- [x] Multi-platform image (amd64, arm64)
- [x] Safe first-run handling: waits for the Plex DB, `SKIP_SETUP` flag for restarts
- [ ] Disable unnecessary Plex processing on `.strm` items (analysis, thumbnail generation, etc.)
- [x] Follow 302 redirects from the source URL before returning to Plex (`FOLLOW_REDIRECTS=true`), enabling compatibility with services that require a redirect step (e.g. 115 Drive)
- [x] Direct streaming gateway (`GATEWAY_ENABLED=true`): direct-play traffic goes straight from the source to the client, bypassing the Plex server (MediaWarp-style)

---

## Contributing

Contributions are welcome! Whether it's a bug fix, a new feature, or an idea from the roadmap, feel free to open an issue or submit a pull request.

If you'd like to get more involved and collaborate on the project long-term, reach out via GitHub. All skill levels are welcome.

[github.com/liveinaus/plex-strm-assistant](https://github.com/liveinaus/plex-strm-assistant)

---

## Support

If this project saves you some time, a GitHub star would be appreciated!
[github.com/liveinaus/plex-strm-assistant](https://github.com/liveinaus/plex-strm-assistant)

---

## Disclaimer

This project is an independent, community-built tool and is not affiliated with, endorsed by, or supported by Plex Inc. in any way.

Using this tool involves writing directly to the Plex SQLite database and modifying internal data structures. This may conflict with Plex's Terms of Service or void any support entitlements. Use it at your own risk.

The author accepts no responsibility for data loss, database corruption, account suspension, or any other consequence arising from the use of this software.

---

## Licence

MIT: free to use and modify. You must retain the copyright notice and a link back to this repository in any copies or derivatives. See [LICENSE](LICENSE) for the full text.
