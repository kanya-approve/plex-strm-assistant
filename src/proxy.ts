#!/usr/bin/env node
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { readStrmUrl, resolveRedirects, strmPathFromUrlPath } from './strm';
import { DEFAULT_DB_PATH, findPartByProxyPath, markPartProbed, openDb } from './db';
import { parseMediaFilename } from './parse';
import { probeMedia } from './probe';
import { applyMediaMetadata } from './metadata';
import { mergeParsed, ParsedMedia } from './plex-extra-data';

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
let dbIno = 0;

// Returns the current DB handle, reopening it when the underlying file changes.
// Plex's "Optimize database" replaces the file with a fresh inode, and a handle
// held over that swap would silently write into the orphaned old file. Keying on
// the inode also lets enrichment start once Plex creates the DB after a bare boot.
function currentDb(): DatabaseSync | null {
  if (!WRITE_METADATA) return null;
  let ino: number;
  try {
    ino = fs.statSync(DB_PATH).ino;
  } catch {
    if (db) closeDb();
    return null;
  }
  if (db && ino === dbIno) return db;
  if (db) closeDb();
  try {
    db = openDb(DB_PATH);
    dbIno = ino;
    return db;
  } catch (err) {
    console.warn(`Media-Info enrichment: cannot open db (${(err as Error).message})`);
    return null;
  }
}

function closeDb(): void {
  try {
    db?.close();
  } catch {
    // already gone
  }
  db = null;
  dbIno = 0;
}

if (!WRITE_METADATA) {
  console.log('Media-Info enrichment disabled (set WRITE_METADATA=true to enable)');
} else if (currentDb()) {
  console.log(`Media-Info enrichment enabled (db: ${DB_PATH})`);
} else {
  console.log(`Media-Info enrichment waiting for db at ${DB_PATH}`);
}

// Once a network probe succeeds its result is authoritative for this session and
// is re-applied on later plays to heal rescan reverts -- filename guesses never
// overwrite it again. `probing` guards against overlapping probes of one item.
const probeResults = new Map<string, ParsedMedia>();
const probing = new Set<string>();

async function enrich(
  urlPath: string,
  filePath: string,
  realUrl: string,
  userAgent: string | undefined,
): Promise<void> {
  const activeDb = currentDb();
  if (!activeDb) return;
  try {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(urlPath);
    } catch {
      decodedPath = urlPath;
    }

    const part = findPartByProxyPath(activeDb, PROXY_BASE, CONTAINER_PREFIX, decodedPath);
    if (!part) return;

    const parsed = await parseMediaFilename(path.basename(filePath));

    // A probe already succeeded: its data wins. Re-apply it (heals rescan
    // reverts) and never regress to the weaker filename guess.
    const probed = probeResults.get(decodedPath);
    if (probed) {
      applyMediaMetadata(activeDb, part, probed, false);
      return;
    }

    // Populate from the filename immediately -- unless a probe already succeeded
    // in an earlier session (persisted), where the stored data is stronger.
    if (!part.probed) applyMediaMetadata(activeDb, part, parsed, false);

    // Probe once per item, never concurrently (the resolved source URL is
    // single-use and the MediaInfo instance is serialised). Failures retry.
    if (probing.has(decodedPath)) return;
    probing.add(decodedPath);
    try {
      const probe = await probeMedia(realUrl, userAgent);
      if (probe) {
        const merged = mergeParsed(parsed, probe);
        probeResults.set(decodedPath, merged);
        applyMediaMetadata(activeDb, part, merged, false);
        if (!part.probed) {
          try {
            markPartProbed(activeDb, part);
          } catch {
            // best-effort: re-marked on the next session's probe
          }
        }
      }
    } finally {
      probing.delete(decodedPath);
    }
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

    void enrich(rawPath, filePath, url, req.headers['user-agent']);
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
