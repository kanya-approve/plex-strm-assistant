/**
 * Shared media-metadata types and Plex-storage helpers.
 *
 * `ParsedMedia` is the normalised, source-agnostic shape produced by both the
 * filename parser (src/parse.ts) and the ffprobe-equivalent stream probe
 * (src/probe.ts). It maps directly onto the columns/blobs Plex actually stores
 * (verified against a real com.plexapp.plugins.library.db):
 *
 *   media_items:   video_codec, audio_codec, width, height, audio_channels,
 *                  container, color_trc, extra_data(ma:videoProfile)
 *   media_streams: codec, channels, language, extra_data (a JSON blob of
 *                  "ma:<Attr>":"value" pairs + a url-encoded "url" mirror)
 *
 * Every field is optional: whatever a source could not determine stays
 * undefined and is simply not written (never a bad/guessed value).
 */

/** Dolby Vision descriptor written into the video stream ma: blob. */
export interface DoviInfo {
  profile?: string; // "8", "5", "7"
  level?: string;
  blPresent?: string; // "1"/"0"
  elPresent?: string;
  rpuPresent?: string;
  blCompatId?: string;
  version?: string; // "1.0"
}

export interface ParsedMedia {
  // --- media_items ---
  videoCodec?: string; // h264 | hevc | av1
  audioCodec?: string; // eac3 | ac3 | dca | truehd | aac | flac | opus
  width?: number;
  height?: number;
  audioChannels?: number; // integer count: 6 = 5.1, 8 = 7.1, 2 = stereo
  container?: string; // mp4 | mkv
  videoProfile?: string; // e.g. "main 10", "high"

  // --- video stream ma: attributes ---
  colorTrc?: string; // smpte2084 (HDR10) | arib-std-b67 (HLG) | bt709 (SDR)
  colorPrimaries?: string; // bt2020 | bt709
  colorSpace?: string; // bt2020nc | bt709
  colorRange?: string; // tv | full
  chromaSubsampling?: string; // 4:2:0
  bitDepth?: number; // 8 | 10
  frameRate?: string; // "23.976"
  dovi?: DoviInfo;

  // --- audio stream ma: attributes ---
  audioChannelLayout?: string; // "5.1(side)" | "7.1" | "stereo" | "mono"
  samplingRate?: string; // "48000"
  audioLanguage?: string; // ISO code, e.g. "eng", "jpn"
}

// ---------------------------------------------------------------------------
// Plex extra_data blob encoding
// ---------------------------------------------------------------------------

/**
 * Percent-encodes like Plex does for the extra_data `url` mirror. This is
 * stricter than encodeURIComponent: Plex also encodes `.` `(` `)` `!` `'` `*`
 * (verified: "5.1(side)" -> "5%2E1%28side%29", "23.976" -> "23%2E976").
 */
export function plexEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[.!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Builds a Plex media_streams `extra_data` blob from a map of `ma:` pairs.
 * Emits JSON of the pairs (ASCII-sorted keys, matching Plex's own ordering)
 * plus a `url` key holding the same pairs url-encoded -- the field Plex reads.
 * Undefined/empty values are dropped. Returns '' when nothing is left.
 */
export function buildMaExtraData(
  pairs: Record<string, string | number | undefined | null>,
): string {
  const entries = Object.entries(pairs)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (entries.length === 0) return '';

  const url = entries.map(([k, v]) => `${plexEncode(k)}=${plexEncode(v)}`).join('&');
  const obj: Record<string, string> = {};
  for (const [k, v] of entries) obj[k] = v;
  obj.url = url;
  return JSON.stringify(obj);
}

/** Builds the media_items.extra_data blob (just ma:videoProfile today). */
export function buildItemExtraData(videoProfile?: string): string {
  if (!videoProfile) return '';
  return buildMaExtraData({ 'ma:videoProfile': videoProfile });
}

// ---------------------------------------------------------------------------
// Normalisation helpers (shared by parse.ts and probe.ts)
// ---------------------------------------------------------------------------

/** Maps a resolution label (1080p / 2160p / 4k / 720p / 480p / 576p) to pixels. */
export function resolutionToDimensions(
  resolution: string | undefined,
): { width: number; height: number } | undefined {
  if (!resolution) return undefined;
  const r = resolution.toLowerCase().replace(/p$/, '');
  switch (r) {
    case '4k':
    case 'uhd':
    case '2160':
      return { width: 3840, height: 2160 };
    case '1080':
      return { width: 1920, height: 1080 };
    case '720':
      return { width: 1280, height: 720 };
    case '576':
      return { width: 720, height: 576 };
    case '480':
      return { width: 640, height: 480 };
    default:
      return undefined;
  }
}

/** Normalises any video-codec token (x265, HEVC, AVC, h264, AV1, ...) to Plex's codec string. */
export function normaliseVideoCodec(codec: string | undefined): string | undefined {
  if (!codec) return undefined;
  const c = codec.toLowerCase();
  if (c.includes('265') || c.includes('hevc')) return 'hevc';
  if (c.includes('264') || c === 'avc') return 'h264';
  if (c.includes('av1')) return 'av1';
  if (c.includes('mpeg2') || c.includes('mpeg-2')) return 'mpeg2video';
  if (c.includes('vp9')) return 'vp9';
  return undefined;
}

/** Normalises any audio-codec token (DTS, DTS Lossy, E-AC-3, EAC3, TrueHD, ...) to Plex's codec string. */
export function normaliseAudioCodec(codecs: string[] | string | undefined): string | undefined {
  if (!codecs) return undefined;
  const list = Array.isArray(codecs) ? codecs : [codecs];
  // Ignore feature add-ons that are not codecs themselves.
  const candidates = list.filter((c) => !/^(atmos|dual|dolby digital plus)$/i.test(c.trim()));
  const pool = (candidates.length ? candidates : list).join(' ').toLowerCase();
  if (pool.includes('truehd') || pool.includes('mlp')) return 'truehd';
  if (
    pool.includes('eac3') ||
    pool.includes('e-ac-3') ||
    pool.includes('ddp') ||
    pool.includes('dd+')
  )
    return 'eac3';
  if (pool.includes('ac3') || pool.includes('ac-3') || /\bdd\b/.test(pool)) return 'ac3';
  if (pool.includes('dts')) return 'dca';
  if (pool.includes('flac')) return 'flac';
  if (pool.includes('opus')) return 'opus';
  if (pool.includes('aac')) return 'aac';
  if (pool.includes('mp3')) return 'mp3';
  if (pool.includes('pcm') || pool.includes('lpcm')) return 'pcm';
  return undefined;
}

/** Maps a channels token ("5.1", "7.1", "2.0") to a count and a Plex channel layout. */
export function channelsToLayout(
  channels: string | number | undefined,
): { count: number; layout: string } | undefined {
  if (channels === undefined || channels === null) return undefined;
  const s = String(channels).trim();
  switch (s) {
    case '7.1':
    case '8':
      return { count: 8, layout: '7.1' };
    case '6.1':
    case '7':
      return { count: 7, layout: '6.1' };
    case '5.1':
    case '6':
      return { count: 6, layout: '5.1(side)' };
    case '2.0':
    case '2':
      return { count: 2, layout: 'stereo' };
    case '1.0':
    case '1':
      return { count: 1, layout: 'mono' };
    default: {
      // Fall back to the leading integer (e.g. "5.1" handled above; "3" -> 3ch)
      const n = parseInt(s, 10);
      return Number.isFinite(n) && n > 0 ? { count: n, layout: `${n}ch` } : undefined;
    }
  }
}

export type DynamicRange = 'sdr' | 'hdr10' | 'hlg' | 'dovi';

/** Colour attributes derived from a dynamic-range classification. */
export interface ColorInfo {
  colorTrc: string;
  colorPrimaries: string;
  colorSpace: string;
  bitDepth: number;
  dovi?: DoviInfo;
}

/** Classifies HDR tokens (from a filename or a probe) into a dynamic range + colour set. */
export function classifyDynamicRange(tokens: string[] | undefined): DynamicRange {
  const t = (tokens ?? []).join(' ').toLowerCase();
  if (t.includes('dolby vision') || /\bdv\b/.test(t) || t.includes('dovi') || t.includes('dvhe'))
    return 'dovi';
  if (t.includes('hlg')) return 'hlg';
  if (t.includes('hdr') || t.includes('pq') || t.includes('smpte 2084') || t.includes('smpte2084'))
    return 'hdr10';
  return 'sdr';
}

/** Builds the colour attribute set for a dynamic range. */
export function colorInfoFor(range: DynamicRange): ColorInfo {
  switch (range) {
    case 'dovi':
      return {
        colorTrc: 'smpte2084',
        colorPrimaries: 'bt2020',
        colorSpace: 'bt2020nc',
        bitDepth: 10,
        dovi: {
          profile: '8',
          blPresent: '1',
          elPresent: '0',
          rpuPresent: '1',
          blCompatId: '1',
          version: '1.0',
        },
      };
    case 'hdr10':
      return {
        colorTrc: 'smpte2084',
        colorPrimaries: 'bt2020',
        colorSpace: 'bt2020nc',
        bitDepth: 10,
      };
    case 'hlg':
      return {
        colorTrc: 'arib-std-b67',
        colorPrimaries: 'bt2020',
        colorSpace: 'bt2020nc',
        bitDepth: 10,
      };
    case 'sdr':
    default:
      return { colorTrc: 'bt709', colorPrimaries: 'bt709', colorSpace: 'bt709', bitDepth: 8 };
  }
}

/**
 * Merges two ParsedMedia objects, `override` winning per-field where defined
 * (used to layer probe results over filename results). The nested `dovi`
 * object is replaced wholesale when the override has one.
 */
export function mergeParsed(base: ParsedMedia, override: ParsedMedia): ParsedMedia {
  const out: ParsedMedia = { ...base };
  for (const [k, v] of Object.entries(override) as [keyof ParsedMedia, unknown][]) {
    if (v !== undefined && v !== null && v !== '') {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
