import mediaInfoFactory from 'mediainfo.js';
import type { AudioTrack, GeneralTrack, MediaInfo, VideoTrack } from 'mediainfo.js';
import {
  ParsedMedia,
  channelsToLayout,
  normaliseAudioCodec,
  normaliseLanguage,
  normaliseVideoCodec,
} from './plex-extra-data';

const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 20000);
const PROBE_MAX_BYTES = Number(process.env.PROBE_MAX_BYTES ?? 32 * 1024 * 1024);

let mediaInfoPromise: Promise<MediaInfo<'object'>> | undefined;

function getMediaInfo(): Promise<MediaInfo<'object'>> {
  if (!mediaInfoPromise) {
    mediaInfoPromise = mediaInfoFactory({
      format: 'object',
      locateFile: () => require.resolve('mediainfo.js/MediaInfoModule.wasm'),
    }).catch((err) => {
      mediaInfoPromise = undefined;
      throw err;
    });
  }
  return mediaInfoPromise;
}

// The MediaInfo instance is shared and single-threaded: a second analyzeData()
// started while one is in progress rejects ("cannot start a new analysis while
// another is in progress"). Serialise all analyses through one promise chain so
// overlapping plays queue instead of corrupting each other.
let analysisChain: Promise<unknown> = Promise.resolve();
function analyzeExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = analysisChain.then(fn, fn);
  analysisChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function uaHeaders(userAgent?: string): Record<string, string> {
  return userAgent ? { 'user-agent': userAgent } : {};
}

export async function probeMedia(realUrl: string, userAgent?: string): Promise<ParsedMedia | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Not armed while queued behind other analyses on the shared MediaInfo
  // instance: an abort that fires during that wait can't be undone.
  const armDeadline = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  };
  let bytesRead = 0;

  try {
    armDeadline();
    const size = await getContentLength(realUrl, controller.signal, userAgent);
    clearTimeout(timer);
    if (!size) return null;

    const readChunk = async (chunkSize: number, offset: number): Promise<Uint8Array> => {
      if (bytesRead >= PROBE_MAX_BYTES) throw new Error('probe byte budget exceeded');
      const res = await fetch(realUrl, {
        // Forward the caller's UA: redirector services (e.g. 115) bind the
        // resolved URL to the agent that requested it, so a bare probe 403s.
        headers: { Range: `bytes=${offset}-${offset + chunkSize - 1}`, ...uaHeaders(userAgent) },
        signal: controller.signal,
        redirect: 'follow',
      });
      // A 200 would stream the whole file instead of the requested range.
      if (res.status !== 206) throw new Error(`range not honoured (status ${res.status})`);
      const chunk = new Uint8Array(await res.arrayBuffer());
      bytesRead += chunk.byteLength;
      return chunk;
    };

    const mediaInfo = await getMediaInfo();
    const result = await analyzeExclusive(() => {
      armDeadline();
      return mediaInfo.analyzeData(size, readChunk);
    });
    return { ...mapResult(result), sizeBytes: size };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getContentLength(
  url: string,
  signal: AbortSignal,
  userAgent?: string,
): Promise<number | undefined> {
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      headers: uaHeaders(userAgent),
      signal,
      redirect: 'follow',
    });
    const len = Number(head.headers.get('content-length'));
    if (head.ok && Number.isFinite(len) && len > 0) return len;
  } catch {}
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-0', ...uaHeaders(userAgent) },
      signal,
      redirect: 'follow',
    });
    const cr = res.headers.get('content-range'); // "bytes 0-0/123456"
    const total = cr && /\/(\d+)$/.exec(cr)?.[1];
    // Drain the body so the pooled connection is released, not left dangling.
    await res.body?.cancel();
    if (total) return Number(total);
  } catch {}
  return undefined;
}

function mapResult(result: {
  media?: { track?: ReadonlyArray<{ '@type': string }> };
}): ParsedMedia {
  const tracks = result.media?.track ?? [];
  const general = tracks.find((t) => t['@type'] === 'General') as GeneralTrack | undefined;
  const video = tracks.find((t) => t['@type'] === 'Video') as VideoTrack | undefined;
  const audio = tracks.find((t) => t['@type'] === 'Audio') as AudioTrack | undefined;

  const out: ParsedMedia = {};

  if (general?.Format) out.container = mapContainer(general.Format);

  const durationSec = Number(general?.Duration);
  if (Number.isFinite(durationSec) && durationSec > 0) {
    out.durationMs = Math.round(durationSec * 1000);
  }
  const overallBitrate = toInt(general?.OverallBitRate);
  if (overallBitrate) out.bitrate = overallBitrate;

  if (video) {
    out.videoCodec = normaliseVideoCodec(video.Format);
    const w = toInt(video.Width);
    const h = toInt(video.Height);
    if (w) out.width = w;
    if (h) out.height = h;
    out.bitDepth = toInt(video.BitDepth);
    out.chromaSubsampling = video.ChromaSubsampling;
    if (video.FrameRate !== undefined) out.frameRate = String(video.FrameRate);
    if (video.Format_Profile) out.videoProfile = video.Format_Profile.toLowerCase();
    out.colorPrimaries = mapPrimaries(video.colour_primaries);
    out.colorSpace = mapMatrix(video.matrix_coefficients);
    out.colorRange = mapRange(video.colour_range);
    out.colorTrc = mapTransfer(video.transfer_characteristics, video.HDR_Format);
    if (isDolbyVision(video.HDR_Format)) {
      out.dovi = {
        profile: doviProfile(video.HDR_Format_Profile),
        blPresent: '1',
        elPresent: '0',
        rpuPresent: '1',
        blCompatId: '1',
        version: '1.0',
      };
      out.colorTrc ??= 'smpte2084';
    } else {
      out.dovi = null;
    }
  }

  if (audio) {
    out.audioCodec = normaliseAudioCodec(audio.Format);
    const ch = channelsToLayout(audio.Channels);
    if (ch) {
      out.audioChannels = ch.count;
      out.audioChannelLayout = ch.layout;
    }
    if (audio.SamplingRate)
      out.samplingRate = String(toInt(audio.SamplingRate) ?? audio.SamplingRate);
    if (audio.Language) out.audioLanguage = normaliseLanguage(audio.Language);
  }

  return out;
}

function toInt(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

function mapContainer(format: string): string | undefined {
  const f = format.toLowerCase();
  if (f.includes('matroska')) return 'mkv';
  if (f.includes('mpeg-4') || f.includes('mp4')) return 'mp4';
  return undefined;
}

function mapPrimaries(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (v.includes('2020')) return 'bt2020';
  if (v.includes('709')) return 'bt709';
  return undefined;
}

function mapMatrix(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (v.includes('2020')) return 'bt2020nc';
  if (v.includes('709')) return 'bt709';
  return undefined;
}

function mapRange(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const r = v.toLowerCase();
  if (r.includes('limited')) return 'tv';
  if (r.includes('full')) return 'full';
  return undefined;
}

function mapTransfer(v: string | undefined, hdrFormat: string | undefined): string | undefined {
  const t = (v ?? '').toLowerCase();
  const hdr = (hdrFormat ?? '').toLowerCase();
  if (t.includes('2084') || t.includes('pq') || hdr.includes('hdr10') || hdr.includes('smpte'))
    return 'smpte2084';
  if (t.includes('hlg') || t.includes('b67') || hdr.includes('hlg')) return 'arib-std-b67';
  if (t.includes('709')) return 'bt709';
  return undefined;
}

function isDolbyVision(hdrFormat: string | undefined): boolean {
  return !!hdrFormat && hdrFormat.toLowerCase().includes('dolby vision');
}

function doviProfile(profile: string | undefined): string | undefined {
  if (!profile) return '8';
  const m = /dvhe\.(\d{2})|profile\s*(\d)/i.exec(profile);
  const p = m?.[1] ?? m?.[2];
  return p ? String(Number(p)) : '8';
}
