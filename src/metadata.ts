import type { DatabaseSync } from 'node:sqlite';
import type { StrmPart } from './db';
import { ParsedMedia, buildItemExtraData, buildMaExtraData } from './plex-extra-data';

const VIDEO = 1;
const AUDIO = 2;

interface StreamPlan {
  codec?: string;
  channels?: number;
  language?: string;
  extraData: string;
  index: number;
}

interface WritePlan {
  item: Record<string, string | number>;
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
  const itemExtra = buildItemExtraData(p.videoProfile);
  if (itemExtra) item.extra_data = itemExtra;

  const plan: WritePlan = { item };

  const videoBlob = buildVideoBlob(p);
  if (p.videoCodec || videoBlob) {
    plan.video = { codec: p.videoCodec, extraData: videoBlob, index: 0 };
  }

  const audioBlob = buildAudioBlob(p);
  if (p.audioCodec || p.audioChannels || audioBlob) {
    plan.audio = {
      codec: p.audioCodec,
      channels: p.audioChannels,
      language: p.audioLanguage,
      extraData: audioBlob,
      index: 1,
    };
  }

  return plan;
}

function buildVideoBlob(p: ParsedMedia): string {
  return buildMaExtraData({
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
  });
}

function buildAudioBlob(p: ParsedMedia): string {
  return buildMaExtraData({
    'ma:audioChannelLayout': p.audioChannelLayout,
    'ma:samplingRate': p.samplingRate,
  });
}

function hasWork(plan: WritePlan): boolean {
  return Object.keys(plan.item).length > 0 || plan.video !== undefined || plan.audio !== undefined;
}

function isAlreadyApplied(db: DatabaseSync, part: StrmPart, plan: WritePlan): boolean {
  if (Object.keys(plan.item).length > 0) {
    const cols = Object.keys(plan.item);
    const row = db
      .prepare(`SELECT ${cols.join(', ')} FROM media_items WHERE id = ?`)
      .get(part.mediaItemId) as Record<string, unknown> | undefined;
    if (!row) return false;
    for (const c of cols) {
      if (String(row[c] ?? '') !== String(plan.item[c])) return false;
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
  const row = db
    .prepare(
      `SELECT codec, channels, language, extra_data
       FROM media_streams WHERE media_part_id = ? AND stream_type_id = ? LIMIT 1`,
    )
    .get(partId, streamType) as
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
  if (s.extraData && (row.extra_data ?? '') !== s.extraData) return false;
  return true;
}

function writePlan(db: DatabaseSync, part: StrmPart, plan: WritePlan): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (Object.keys(plan.item).length > 0) {
      const cols = Object.keys(plan.item);
      const assignments = cols.map((c) => `${c} = ?`).join(', ');
      db.prepare(
        `UPDATE media_items SET ${assignments}, updated_at = strftime('%s','now') WHERE id = ?`,
      ).run(...cols.map((c) => plan.item[c]), part.mediaItemId);
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
  const res = db
    .prepare(
      `UPDATE media_streams
       SET codec = COALESCE(?, codec),
           channels = COALESCE(?, channels),
           language = COALESCE(?, language),
           extra_data = CASE WHEN ? <> '' THEN ? ELSE extra_data END,
           updated_at = strftime('%s','now')
       WHERE media_part_id = ? AND stream_type_id = ?`,
    )
    .run(
      s.codec ?? null,
      s.channels ?? null,
      s.language ?? null,
      s.extraData,
      s.extraData,
      part.id,
      streamType,
    );

  if (res.changes === 0) {
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
      s.extraData || null,
    );
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
