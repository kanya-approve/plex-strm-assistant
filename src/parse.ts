import {
  ParsedMedia,
  channelsToLayout,
  classifyDynamicRange,
  colorInfoFor,
  normaliseAudioCodec,
  normaliseVideoCodec,
  resolutionToDimensions,
} from './plex-extra-data';

type PttModule = typeof import('@viren070/parse-torrent-title');
type PttParser = InstanceType<PttModule['Parser']>;
type PttResult = ReturnType<PttParser['parse']>;

// The package is ESM-only with no `require` condition. The Function wrapper keeps
// TypeScript's CommonJS emit from down-levelling import() to require().
const importPtt = new Function(
  'return import("@viren070/parse-torrent-title")',
) as () => Promise<PttModule>;

let parserPromise: Promise<PttParser> | undefined;

function getParser(): Promise<PttParser> {
  if (!parserPromise) {
    parserPromise = importPtt().then((m) => new m.Parser().addDefaultHandlers());
  }
  return parserPromise;
}

export async function parseMediaFilename(basename: string): Promise<ParsedMedia> {
  const name = basename.replace(/\.[^./]+$/, '');
  try {
    const parser = await getParser();
    return normalise(parser.parse(name));
  } catch {
    return {};
  }
}

function normalise(raw: PttResult): ParsedMedia {
  const out: ParsedMedia = {};

  const dims = resolutionToDimensions(raw.resolution);
  if (dims) {
    out.width = dims.width;
    out.height = dims.height;
  }

  out.videoCodec = normaliseVideoCodec(raw.codec);
  out.audioCodec = normaliseAudioCodec(raw.audio);

  const ch = channelsToLayout(raw.channels?.[0]);
  if (ch) {
    out.audioChannels = ch.count;
    out.audioChannelLayout = ch.layout;
  }

  if (raw.container && /^(mkv|mp4)$/i.test(raw.container)) {
    out.container = raw.container.toLowerCase();
  }

  if (raw.languages?.length) {
    out.audioLanguage = raw.languages[0];
  }

  // Colour / HDR: only assert when we actually have a video signal (codec or
  // resolution). Absence of an HDR tag in a Sonarr/Radarr name means SDR.
  const hasVideo = out.videoCodec !== undefined || dims !== undefined;
  if (hasVideo) {
    const range = classifyDynamicRange(raw.hdr);
    const color = colorInfoFor(range);
    out.colorTrc = color.colorTrc;
    out.colorPrimaries = color.colorPrimaries;
    out.colorSpace = color.colorSpace;
    out.dovi = color.dovi;

    // A "10bit"/"8bit" token overrides the range default (e.g. 10-bit SDR).
    const bitDepth = parseBitDepth(raw.bitDepth);
    out.bitDepth = bitDepth ?? color.bitDepth;

    if (out.bitDepth === 10 && !out.videoProfile && out.videoCodec === 'hevc') {
      out.videoProfile = 'main 10';
    }
  }

  return out;
}

function parseBitDepth(bitDepth: string | undefined): number | undefined {
  if (!bitDepth) return undefined;
  const m = /(\d+)\s*bit/i.exec(bitDepth) ?? /^(\d+)$/.exec(bitDepth.trim());
  return m ? Number(m[1]) : undefined;
}
