#!/usr/bin/env node
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { readStrmUrl, resolveRedirects, strmPathFromUrlPath } from './strm';
import { DEFAULT_DB_PATH, findPartByProxyPath, openDb } from './db';
import { parseMediaFilename } from './parse';
import { probeMedia } from './probe';
import { applyMediaMetadata } from './metadata';
import { mergeParsed } from './plex-extra-data';

const STRM_ROOT = path.resolve(process.env.STRM_ROOT ?? '/strm');
const PORT = Number(process.env.PORT ?? 3000);
// Follow the source URL's redirect chain server-side and hand Plex the final
// URL. Needed for services where the .strm URL is a redirector, e.g. 115 Drive.
const FOLLOW_REDIRECTS = process.env.FOLLOW_REDIRECTS === 'true';

const CONTAINER_PREFIX = process.env.CONTAINER_PREFIX ?? '/media/strm';
const STRM_PROXY_HOST = process.env.STRM_PROXY_HOST ?? 'strm-proxy';
const PROXY_BASE = `http://${STRM_PROXY_HOST}:${PORT}`;
const DB_PATH = process.env.DB_PATH ?? DEFAULT_DB_PATH;
const WRITE_METADATA = process.env.WRITE_METADATA === 'true';

let db: DatabaseSync | null = null;
if (!WRITE_METADATA) {
  console.log('Media-Info enrichment disabled (set WRITE_METADATA=true to enable)');
} else {
  try {
    if (fs.existsSync(DB_PATH)) {
      db = openDb(DB_PATH);
      console.log(`Media-Info enrichment enabled (db: ${DB_PATH})`);
    } else {
      console.log(`Media-Info enrichment disabled (no DB at ${DB_PATH})`);
    }
  } catch (err) {
    console.warn(`Media-Info enrichment disabled (${(err as Error).message})`);
  }
}

const probed = new Set<string>();

// Filename metadata is re-applied on every play (cheap, heals rescan reverts);
// the network stream probe runs only once per item per proxy session.
async function enrich(urlPath: string, filePath: string, realUrl: string): Promise<void> {
  if (!db) return;
  try {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(urlPath);
    } catch {
      decodedPath = urlPath;
    }

    const part = findPartByProxyPath(db, PROXY_BASE, CONTAINER_PREFIX, decodedPath);
    if (!part) return;

    const parsed = await parseMediaFilename(path.basename(filePath));
    applyMediaMetadata(db, part, parsed, false);

    if (probed.has(decodedPath)) return;
    probed.add(decodedPath);

    const probe = await probeMedia(realUrl);
    if (probe) applyMediaMetadata(db, part, mergeParsed(parsed, probe), false);
  } catch (err) {
    console.warn(`meta: enrichment failed for ${urlPath}: ${(err as Error).message}`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    // Strip query string and fragment. Avoid new URL() -- it can reject
    // literal spaces sent by some HTTP clients.
    const rawPath = (req.url ?? '/').split(/[?#]/)[0];

    const filePath = strmPathFromUrlPath(STRM_ROOT, rawPath);
    if (!filePath) {
      res.writeHead(404).end('Not found');
      return;
    }

    // readStrmUrl normalises the URL -- raw spaces or non-ASCII characters
    // in the Location header are rejected by Node and by upstream servers
    let url = readStrmUrl(filePath);
    if (!url) {
      res.writeHead(422).end('Not a valid HTTP URL');
      return;
    }

    if (FOLLOW_REDIRECTS) {
      url = await resolveRedirects(url, req.headers['user-agent']);
    }

    console.log(`302  ${rawPath}  ->  ${url}`);
    res.writeHead(302, { Location: url }).end();

    void enrich(rawPath, filePath, url);
  } catch (err) {
    console.error(`error handling ${req.url}: ${(err as Error).message}`);
    if (!res.headersSent) res.writeHead(500).end('Internal error');
  }
});

server.listen(PORT, () =>
  console.log(
    `strm-proxy on :${PORT}  root: ${STRM_ROOT}` +
      (FOLLOW_REDIRECTS ? '  (following upstream redirects)' : ''),
  ),
);

// node runs as PID 1 here; without a handler the kernel ignores SIGTERM and k8s
// waits the full grace period before SIGKILL.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => {
      db?.close();
      process.exit(0);
    });
  });
}
