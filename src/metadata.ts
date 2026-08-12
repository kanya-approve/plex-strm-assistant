import type { DatabaseSync } from 'node:sqlite';
import type { StrmPart } from './db';
import { ParsedMedia, maExtraDataContains, mergeMaExtraData } from './plex-extra-data';

const VIDEO = 1;
const AUDIO = 2;

type MaPairs = Record<string, string | number | undefined | null>;

interface StreamPlan {
  codec?: string;
  channels?: number;
  language?: string;
  extra: MaPairs;
  index: number;
}

interface WritePlan {
  item: Record<string, string | number>;
  itemExtra: MaPairs;
  video?: StreamPlan;
  audio?: StreamPlan;
}

// Upserts in place (never DELETE+INSERT) so media_streams.id is preserved, and is
// idempotent, so it also heals rows a Plex rescan reverted to placeholder h264/aac.
export function applyMediaMetadata(
  db: DatabaseSync,
  part: StrmPart,
  parsed: ParsedMedia,
  dryRun: boolean,
): boolean {
  const plan = buildPlan(parsed);
  if (!hasWork(plan)) return false;
  if (isAlreadyApplied(db, part, plan)) return false;
  if (dryRun) return true;

  withRetry(() => writePlan(db, part, plan));
  return true;
}

function buildPlan(p: ParsedMedia): WritePlan {
  const item: Record<string, string | number> = {};
  if (p.videoCodec) item.video_codec = p.videoCodec;
  if (p.audioCodec) item.audio_codec = p.audioCodec;
  if (p.width) item.width = p.width;
  if (p.height) item.height = p.height;
  if (p.audioChannels) item.audio_channels = p.audioChannels;
  if (p.colorTrc) item.color_trc = p.colorTrc;

  const plan: WritePlan = { item, itemExtra: { 'ma:videoProfile': p.videoProfile } };

  const videoExtra = videoExtraData(p);
  if (p.videoCodec || hasAny(videoExtra)) {
    plan.video = { codec: p.videoCodec, extra: videoExtra, index: 0 };
  }

  const audioExtra = audioExtraData(p);
  if (p.audioCodec || p.audioChannels || hasAny(audioExtra)) {
    plan.audio = {
      codec: p.audioCodec,
      channels: p.audioChannels,
      language: p.audioLanguage,
      extra: audioExtra,
      index: 1,
    };
  }

  return plan;
}

function videoExtraData(p: ParsedMedia): MaPairs {
  return {
    'ma:bitDepth': p.bitDepth,
    'ma:chromaSubsampling': p.chromaSubsampling,
    'ma:codedHeight': p.height,
    'ma:codedWidth': p.width,
    'ma:colorPrimaries': p.colorPrimaries,
    'ma:colorRange': p.colorRange,
    'ma:colorSpace': p.colorSpace,
    'ma:colorTrc': p.colorTrc,
    'ma:frameRate': p.frameRate,
    'ma:height': p.height,
    'ma:profile': p.videoProfile,
    'ma:width': p.width,
    ...(p.dovi
      ? {
          'ma:DOVIBLCompatID': p.dovi.blCompatId,
          'ma:DOVIBLPresent': p.dovi.blPresent,
          'ma:DOVIELPresent': p.dovi.elPresent,
          'ma:DOVILevel': p.dovi.level,
          'ma:DOVIPresent': '1',
          'ma:DOVIProfile': p.dovi.profile,
          'ma:DOVIRPUPresent': p.dovi.rpuPresent,
          'ma:DOVIVersion': p.dovi.version,
        }
      : {}),
  };
}

function audioExtraData(p: ParsedMedia): MaPairs {
  return {
    'ma:audioChannelLayout': p.audioChannelLayout,
    'ma:samplingRate': p.samplingRate,
  };
}

function hasAny(pairs: MaPairs): boolean {
  return Object.values(pairs).some((v) => v !== undefined && v !== null && v !== '');
}

function hasWork(plan: WritePlan): boolean {
  return (
    Object.keys(plan.item).length > 0 ||
    hasAny(plan.itemExtra) ||
    plan.video !== undefined ||
    plan.audio !== undefined
  );
}

function isAlreadyApplied(db: DatabaseSync, part: StrmPart, plan: WritePlan): boolean {
  const cols = Object.keys(plan.item);
  const needExtra = hasAny(plan.itemExtra);
  if (cols.length > 0 || needExtra) {
    const selectCols = [...cols, ...(needExtra ? ['extra_data'] : [])];
    const row = db
      .prepare(`SELECT ${selectCols.join(', ')} FROM media_items WHERE id = ?`)
      .get(part.mediaItemId) as Record<string, unknown> | undefined;
    if (!row) return false;
    for (const c of cols) {
      if (String(row[c] ?? '') !== String(plan.item[c])) return false;
    }
    if (needExtra && !maExtraDataContains(row.extra_data as string | null, plan.itemExtra)) {
      return false;
    }
  }
  if (plan.video && !streamMatches(db, part.id, VIDEO, plan.video)) return false;
  if (plan.audio && !streamMatches(db, part.id, AUDIO, plan.audio)) return false;
  return true;
}

function streamMatches(
  db: DatabaseSync,
  partId: number,
  streamType: number,
  s: StreamPlan,
): boolean {
  // Match the single stream at the plan's index -- never the whole type, so a
  // real extra track (a second audio stream) is neither compared nor rewritten.
  const row = db
    .prepare(
      `SELECT codec, channels, language, extra_data
       FROM media_streams WHERE media_part_id = ? AND stream_type_id = ? AND "index" = ?`,
    )
    .get(partId, streamType, s.index) as
    | {
        codec: string | null;
        channels: number | null;
        language: string | null;
        extra_data: string | null;
      }
    | undefined;
  if (!row) return false;
  if (s.codec !== undefined && (row.codec ?? '') !== s.codec) return false;
  if (s.channels !== undefined && (row.channels ?? 0) !== s.channels) return false;
  if (s.language !== undefined && (row.language ?? '') !== s.language) return false;
  if (hasAny(s.extra) && !maExtraDataContains(row.extra_data as string | null, s.extra)) {
    return false;
  }
  return true;
}

function writePlan(db: DatabaseSync, part: StrmPart, plan: WritePlan): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const cols = Object.keys(plan.item);
    const needExtra = hasAny(plan.itemExtra);
    if (cols.length > 0 || needExtra) {
      const sets = cols.map((c) => `${c} = ?`);
      const params: (string | number)[] = cols.map((c) => plan.item[c]);
      if (needExtra) {
        const current = db
          .prepare(`SELECT extra_data FROM media_items WHERE id = ?`)
          .get(part.mediaItemId) as { extra_data: string | null } | undefined;
        sets.push('extra_data = ?');
        params.push(mergeMaExtraData(current?.extra_data, plan.itemExtra));
      }
      db.prepare(
        `UPDATE media_items SET ${sets.join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`,
      ).run(...params, part.mediaItemId);
    }
    if (plan.video) upsertStream(db, part, VIDEO, plan.video);
    if (plan.audio) upsertStream(db, part, AUDIO, plan.audio);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function upsertStream(db: DatabaseSync, part: StrmPart, streamType: number, s: StreamPlan): void {
  // Merge into the existing blob so a Plex-written extra_data keeps its keys.
  const current = db
    .prepare(
      `SELECT extra_data FROM media_streams
       WHERE media_part_id = ? AND stream_type_id = ? AND "index" = ?`,
    )
    .get(part.id, streamType, s.index) as { extra_data: string | null } | undefined;
  const mergedExtra = hasAny(s.extra) ? mergeMaExtraData(current?.extra_data, s.extra) : null;

  const res = db
    .prepare(
      `UPDATE media_streams
       SET codec = COALESCE(?, codec),
           channels = COALESCE(?, channels),
           language = COALESCE(?, language),
           extra_data = COALESCE(?, extra_data),
           updated_at = strftime('%s','now')
       WHERE media_part_id = ? AND stream_type_id = ? AND "index" = ?`,
    )
    .run(s.codec ?? null, s.channels ?? null, s.language ?? null, mergedExtra, part.id, streamType, s.index);

  if (res.changes === 0) {
    // Seed a placeholder only when the part has no stream of this type at all,
    // so a synthetic row is never inserted alongside real analysed tracks.
    const exists = db
      .prepare(`SELECT 1 FROM media_streams WHERE media_part_id = ? AND stream_type_id = ? LIMIT 1`)
      .get(part.id, streamType);
    if (!exists) {
      db.prepare(
        `INSERT INTO media_streams
           (stream_type_id, media_item_id, media_part_id, codec, channels, language, "index", extra_data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))`,
      ).run(
        streamType,
        part.mediaItemId,
        part.id,
        s.codec ?? null,
        s.channels ?? null,
        s.language ?? null,
        s.index,
        mergedExtra,
      );
    }
  }
}

function withRetry(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (isBusy(err)) {
      fn();
      return;
    }
    throw err;
  }
}

function isBusy(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|database is locked/i.test(msg);
}
