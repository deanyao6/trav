/**
 * Media for the relay line (T-169).
 *
 * Outbound: iMessage relays take an `https:` URL they fetch themselves, and
 * iMessage shows PNG/JPEG inline but not SVG. Trav's mock ticket QR codes are
 * SVG data URLs (`mock/tickets/qr.ts`), so before a send the core turns every
 * `data:` image into bytes, rasterizes a rect-only SVG (what the QR is) to a
 * PNG with the small encoder below, and hands the bytes to a `RelayMediaHost`
 * that returns a URL the vendor can fetch. The mock host keeps bytes in
 * memory; a live host (object storage, or the vendor's upload endpoint) is
 * a deployment choice documented in docs/RELAY.md.
 *
 * Inbound: an attachment URL from a webhook is untrusted. Only `https:` URLs
 * become `Attachment`s; a `file:`, `http:`, relative or local path is dropped
 * so a forged payload can never point Trav's receipt reader at a local file.
 * Nothing here fetches an inbound URL.
 */
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { RelayMedia } from './types.js';

// ---------------------------------------------------------------- PNG encoder

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Largest image this encoder will produce (the mock QR is 232 px). */
export const MAX_RASTER_SIDE = 2048;

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

/** 8-bit grayscale PNG from `width × height` luminance bytes (row-major). */
export function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('encodeGrayPng: width and height must be positive integers');
  }
  if (pixels.length !== width * height) {
    throw new Error('encodeGrayPng: pixel buffer does not match width × height');
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ------------------------------------------------------- rect-only SVG raster

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m?.[1];
}

function gray(fill: string): number | undefined {
  const f = fill.trim().toLowerCase();
  if (f === '#fff' || f === '#ffffff' || f === 'white') return 255;
  if (f === '#000' || f === '#000000' || f === 'black') return 0;
  return undefined;
}

function intAttr(attrs: string, name: string, fallback: number | undefined): number | undefined {
  const v = attr(attrs, name);
  if (v === undefined) return fallback;
  if (!/^\d{1,5}$/.test(v)) return undefined;
  return Number(v);
}

/**
 * Rasterizes an SVG made only of `<svg>`, `<title>`, `<g fill>` and
 * black/white integer `<rect>`s (the mock ticket QR) to a grayscale PNG.
 * Returns undefined for anything else; the caller then leaves the image out
 * rather than send something iMessage can't show.
 */
export function rasterizeRectSvg(svg: string): Buffer | undefined {
  const root = /^\s*<svg\b([^>]*)>/.exec(svg);
  if (!root) return undefined;
  const width = intAttr(root[1]!, 'width', undefined);
  const height = intAttr(root[1]!, 'height', undefined);
  if (width === undefined || height === undefined) return undefined;
  if (width < 1 || height < 1 || width > MAX_RASTER_SIDE || height > MAX_RASTER_SIDE) {
    return undefined;
  }
  const viewBox = attr(root[1]!, 'viewBox');
  if (viewBox !== undefined && viewBox.trim() !== `0 0 ${width} ${height}`) return undefined;
  const pixels = new Uint8Array(width * height).fill(255);
  const fills: number[] = [0];
  const tagRe = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>|([^<]+)/gy;
  tagRe.lastIndex = root[0].length;
  let inTitle = false;
  let closed = false;
  while (tagRe.lastIndex < svg.length) {
    const m = tagRe.exec(svg);
    if (!m) return undefined;
    if (m[5] !== undefined) {
      // Text is allowed only inside <title> (or as whitespace).
      if (!inTitle && m[5].trim().length > 0) return undefined;
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2]!.toLowerCase();
    const attrs = m[3] ?? '';
    const selfClosing = m[4] === '/';
    if (closed) return undefined;
    if (name === 'title') {
      inTitle = !closing && !selfClosing;
      continue;
    }
    if (name === 'svg') {
      if (!closing) return undefined; // nested svg
      closed = true;
      continue;
    }
    if (name === 'g') {
      if (closing) {
        if (fills.length <= 1) return undefined;
        fills.pop();
      } else {
        const f = attr(attrs, 'fill');
        const g = f === undefined ? fills[fills.length - 1]! : gray(f);
        if (g === undefined) return undefined;
        if (!selfClosing) fills.push(g);
      }
      continue;
    }
    if (name !== 'rect' || closing) return undefined;
    const x = intAttr(attrs, 'x', 0);
    const y = intAttr(attrs, 'y', 0);
    const w = intAttr(attrs, 'width', undefined);
    const h = intAttr(attrs, 'height', undefined);
    if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
    const f = attr(attrs, 'fill');
    const value = f === undefined ? fills[fills.length - 1]! : gray(f);
    if (value === undefined) return undefined;
    for (let yy = y; yy < Math.min(height, y + h); yy += 1) {
      pixels.fill(value, yy * width + x, yy * width + Math.min(width, x + w));
    }
  }
  if (!closed) return undefined;
  return encodeGrayPng(width, height, pixels);
}

// ------------------------------------------------------------- media hosting

export interface MediaBytes {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly fileName?: string;
}

/** Turns bytes into a URL the vendor can fetch. */
export interface RelayMediaHost {
  publish(media: MediaBytes): Promise<RelayMedia>;
}

export interface MemoryMediaHost extends RelayMediaHost {
  /** Bytes behind a URL this host returned (the mock relay "downloads" with it). */
  resolve(url: string): MediaBytes | undefined;
  /** The same bytes as a `data:` URL (the simulator UI shows these). */
  dataUrl(url: string): string | undefined;
  size(): number;
}

const EXT_OF: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * In-memory media host (mock relay, tests). URLs are on the reserved
 * `.invalid` TLD, so nothing outside the process could ever fetch them.
 */
export function createMemoryMediaHost(
  baseUrl = 'https://media.mock-relay.invalid/m',
): MemoryMediaHost {
  const store = new Map<string, MediaBytes>();
  return {
    async publish(media) {
      const hash = createHash('sha256').update(media.bytes).digest('hex').slice(0, 24);
      const url = `${baseUrl}/${hash}.${EXT_OF[media.mimeType] ?? 'bin'}`;
      store.set(url, media);
      return {
        url,
        mimeType: media.mimeType,
        ...(media.fileName !== undefined ? { fileName: media.fileName } : {}),
      };
    },
    resolve: (url) => store.get(url),
    dataUrl(url) {
      const m = store.get(url);
      return m ? `data:${m.mimeType};base64,${Buffer.from(m.bytes).toString('base64')}` : undefined;
    },
    size: () => store.size,
  };
}

/** `data:<mime>[;base64],<payload>` → bytes; undefined if malformed. */
export function decodeDataUrl(url: string): MediaBytes | undefined {
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[a-z0-9=.+-]+)*?)(;base64)?,(.*)$/is.exec(url);
  if (!m) return undefined;
  const mimeType = m[1]!.toLowerCase();
  const payload = m[4]!;
  try {
    const bytes =
      m[3] !== undefined
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8');
    return { bytes, mimeType };
  } catch {
    return undefined;
  }
}

function mimeOfUrl(url: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url)?.[1]?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png' || ext === 'gif' || ext === 'webp') return `image/${ext}`;
  if (ext === 'heic') return 'image/heic';
  return 'image/*';
}

export type SkippedImageReason = 'unsupported_svg' | 'bad_data_url' | 'not_public_url';

export interface PreparedImages {
  readonly media: readonly RelayMedia[];
  readonly skipped: readonly { readonly alt: string; readonly reason: SkippedImageReason }[];
}

/**
 * `OutboundMessage.images` → what the vendor gets. A `data:` image is
 * decoded (an SVG rasterized to PNG) and published; an `https:` URL passes
 * through; anything else (a relative path, `http:`) is skipped, since the
 * vendor could not fetch it.
 */
export async function prepareOutboundImages(
  images: readonly { readonly url: string; readonly alt: string }[],
  host: RelayMediaHost,
): Promise<PreparedImages> {
  const media: RelayMedia[] = [];
  const skipped: { alt: string; reason: SkippedImageReason }[] = [];
  for (const img of images) {
    if (img.url.startsWith('data:')) {
      const decoded = decodeDataUrl(img.url);
      if (!decoded) {
        skipped.push({ alt: img.alt, reason: 'bad_data_url' });
        continue;
      }
      let bytes = decoded;
      if (decoded.mimeType === 'image/svg+xml') {
        const png = rasterizeRectSvg(Buffer.from(decoded.bytes).toString('utf8'));
        if (!png) {
          skipped.push({ alt: img.alt, reason: 'unsupported_svg' });
          continue;
        }
        bytes = { bytes: png, mimeType: 'image/png' };
      }
      media.push(await host.publish(bytes));
      continue;
    }
    if (/^https:\/\//i.test(img.url)) {
      media.push({ url: img.url, mimeType: mimeOfUrl(img.url) });
      continue;
    }
    skipped.push({ alt: img.alt, reason: 'not_public_url' });
  }
  return { media, skipped };
}

/** Inbound attachment URLs Trav accepts from a webhook: `https:` only. */
export function isAcceptableInboundMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' && u.hostname.length > 0 && u.username === '' && u.password === ''
    );
  } catch {
    return false;
  }
}

/** `Attachment.kind` from a MIME type. */
export function attachmentKindOf(mimeType: string): 'image' | 'video' | 'audio' | 'file' {
  const t = mimeType.toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return 'file';
}
