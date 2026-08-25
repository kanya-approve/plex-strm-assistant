export interface DoviInfo {
  profile?: string;
  level?: string;
  blPresent?: string;
  elPresent?: string;
  rpuPresent?: string;
  blCompatId?: string;
  version?: string;
}

export interface ParsedMedia {
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  audioChannels?: number;
  container?: string;
  videoProfile?: string;
  durationMs?: number;
  bitrate?: number;
  sizeBytes?: number;

  colorTrc?: string;
  colorPrimaries?: string;
  colorSpace?: string;
  colorRange?: string;
  chromaSubsampling?: string;
  bitDepth?: number;
  frameRate?: string;
  dovi?: DoviInfo;

  audioChannelLayout?: string;
  samplingRate?: string;
  audioLanguage?: string;
}

// Plex encodes the extra_data `url` mirror more strictly than encodeURIComponent:
// it also escapes . ! ' ( ) *  ("5.1(side)" -> "5%2E1%28side%29").
export function plexEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[.!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

// Plex stores the pairs as JSON plus a url-encoded `url` mirror (the field it
// actually reads), keys in ASCII order. Undefined/empty values are dropped.
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

export function buildItemExtraData(videoProfile?: string): string {
  if (!videoProfile) return '';
  return buildMaExtraData({ 'ma:videoProfile': videoProfile });
}

// Parses a stored extra_data blob back into its ma: pairs, dropping the url mirror
// (rebuilt on write) so existing values can be merged rather than overwritten.
export function parseMaExtraData(blob: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!blob) return out;
  try {
    const obj = JSON.parse(blob) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'url') continue;
      if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
    }
  } catch {
    // Not the JSON form we write -- treat as empty and let the caller overlay.
  }
  return out;
}

// Overlays additions onto whatever is already stored and rebuilds the blob, so a
// Plex-written extra_data keeps its keys instead of being replaced wholesale.
export function mergeMaExtraData(
  existing: string | null | undefined,
  additions: Record<string, string | number | undefined | null>,
): string {
  return buildMaExtraData({ ...parseMaExtraData(existing), ...additions });
}

export function maExtraDataContains(
  existing: string | null | undefined,
  additions: Record<string, string | number | undefined | null>,
): boolean {
  const base = parseMaExtraData(existing);
  for (const [k, v] of Object.entries(additions)) {
    if (v === undefined || v === null || v === '') continue;
    if (base[k] !== String(v)) return false;
  }
  return true;
}

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

export function normaliseAudioCodec(codecs: string[] | string | undefined): string | undefined {
  if (!codecs) return undefined;
  const list = Array.isArray(codecs) ? codecs : [codecs];
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
      const n = parseInt(s, 10);
      return Number.isFinite(n) && n > 0 ? { count: n, layout: `${n}ch` } : undefined;
    }
  }
}

export type DynamicRange = 'sdr' | 'hdr10' | 'hlg' | 'dovi';

export interface ColorInfo {
  colorTrc: string;
  colorPrimaries: string;
  colorSpace: string;
  bitDepth: number;
  dovi?: DoviInfo;
}

export function classifyDynamicRange(tokens: string[] | undefined): DynamicRange {
  const t = (tokens ?? []).join(' ').toLowerCase();
  if (t.includes('dolby vision') || /\bdv\b/.test(t) || t.includes('dovi') || t.includes('dvhe'))
    return 'dovi';
  if (t.includes('hlg')) return 'hlg';
  if (t.includes('hdr') || t.includes('pq') || t.includes('smpte 2084') || t.includes('smpte2084'))
    return 'hdr10';
  return 'sdr';
}

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

export function mergeParsed(base: ParsedMedia, override: ParsedMedia): ParsedMedia {
  const out: ParsedMedia = { ...base };
  for (const [k, v] of Object.entries(override) as [keyof ParsedMedia, unknown][]) {
    if (v !== undefined && v !== null && v !== '') {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
