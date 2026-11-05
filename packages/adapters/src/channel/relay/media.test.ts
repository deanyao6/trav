import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { mockQrDataUrl } from '../../mock/tickets/qr.js';
import {
  createMemoryMediaHost,
  decodeDataUrl,
  encodeGrayPng,
  isAcceptableInboundMediaUrl,
  prepareOutboundImages,
  rasterizeRectSvg,
} from './media.js';
import {
  isTapbackName,
  parseLegacyTapbackText,
  quoteMatches,
  tapbackToEmoji,
  emojiToTapback,
} from './tapbacks.js';

/** Decodes the grayscale PNGs this module writes (filter 0 only). */
function decodeGray(png: Buffer): { width: number; height: number; pixels: Uint8Array } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('ascii');
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9]]).toEqual([8, 0]);
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (width + 1)]).toBe(0);
    pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, pixels };
}

describe('PNG encoder and rect-SVG rasterizer (T-169)', () => {
  it('encodes a decodable grayscale PNG', () => {
    const png = encodeGrayPng(3, 2, Uint8Array.from([0, 255, 0, 255, 0, 255]));
    expect(decodeGray(png)).toEqual({
      width: 3,
      height: 2,
      pixels: Uint8Array.from([0, 255, 0, 255, 0, 255]),
    });
    expect(() => encodeGrayPng(2, 2, new Uint8Array(3))).toThrow();
  });

  it('rasterizes the mock ticket QR: 232 px, white quiet zone, black finder corner', () => {
    const svg = Buffer.from(
      mockQrDataUrl('TRAV-MOCK-TICKET|o|t|C').split(',')[1]!,
      'base64',
    ).toString('utf8');
    const png = rasterizeRectSvg(svg)!;
    const { width, height, pixels } = decodeGray(png);
    expect([width, height]).toEqual([232, 232]);
    expect(pixels[0]).toBe(255); // quiet zone
    expect(pixels[16 * width + 16]).toBe(0); // top-left finder edge (module 0 at 2×8 px)
    expect(pixels[(16 + 8) * width + 16 + 8]).toBe(255); // finder ring gap
    expect(pixels[(16 + 24) * width + 16 + 24]).toBe(0); // finder core
    // Same payload ⇒ same bytes.
    expect(rasterizeRectSvg(svg)!.equals(png)).toBe(true);
  });

  it('refuses anything that is not a plain black/white rect SVG', () => {
    expect(rasterizeRectSvg('<svg width="10" height="10"><circle r="3"/></svg>')).toBeUndefined();
    expect(
      rasterizeRectSvg('<svg width="10" height="10"><rect width="2" height="2" fill="red"/></svg>'),
    ).toBeUndefined();
    expect(rasterizeRectSvg('<svg width="9999" height="10"></svg>')).toBeUndefined();
    expect(
      rasterizeRectSvg('<svg width="10" height="10"><script>x</script></svg>'),
    ).toBeUndefined();
    expect(rasterizeRectSvg('<svg width="10" height="10">text</svg>')).toBeUndefined();
    expect(
      rasterizeRectSvg('<svg width="10" height="10"><rect width="2" height="2"/>'),
    ).toBeUndefined();
    expect(rasterizeRectSvg('not svg')).toBeUndefined();
    expect(
      rasterizeRectSvg('<svg width="4" height="4"><rect width="2" height="2"/></svg>'),
    ).toBeDefined();
  });

  it('prepares outbound images: data URLs published (SVG → PNG), https passed through, others skipped', async () => {
    const host = createMemoryMediaHost();
    const out = await prepareOutboundImages(
      [
        { url: mockQrDataUrl('p'), alt: 'qr' },
        { url: 'https://album.example.test/a.jpg', alt: 'photo' },
        { url: '/local/file.png', alt: 'local' },
        { url: 'http://insecure.example.test/x.png', alt: 'http' },
        {
          url:
            'data:image/svg+xml;base64,' + Buffer.from('<svg><circle/></svg>').toString('base64'),
          alt: 'odd',
        },
      ],
      host,
    );
    expect(out.media.map((m) => m.mimeType)).toEqual(['image/png', 'image/jpeg']);
    expect(out.media[0]!.url).toMatch(/\.png$/);
    expect(host.dataUrl(out.media[0]!.url)).toMatch(/^data:image\/png;base64,/);
    expect(out.skipped.map((s) => s.reason)).toEqual([
      'not_public_url',
      'not_public_url',
      'unsupported_svg',
    ]);
  });

  it('decodes data URLs and accepts only https inbound media', () => {
    expect(decodeDataUrl('data:text/plain,hi%20there')).toMatchObject({ mimeType: 'text/plain' });
    expect(decodeDataUrl('nope')).toBeUndefined();
    expect(isAcceptableInboundMediaUrl('https://cdn.example.test/a.jpg')).toBe(true);
    for (const bad of [
      'http://cdn.example.test/a.jpg',
      'file:///etc/passwd',
      '/Users/x/a.png',
      'fixtures/receipts/r.jpg',
      'https://user:pw@cdn.example.test/a.jpg',
      'javascript:alert(1)',
    ]) {
      expect(isAcceptableInboundMediaUrl(bad), bad).toBe(false);
    }
  });
});

describe('tapbacks (T-169)', () => {
  it('maps names and spellings to emoji, and Trav emoji to names', () => {
    expect(tapbackToEmoji('like')).toBe('👍');
    expect(tapbackToEmoji('Liked')).toBe('👍');
    expect(tapbackToEmoji('heart')).toBe('❤️');
    expect(tapbackToEmoji('question')).toBe('❓');
    expect(tapbackToEmoji('🔥')).toBe('🔥');
    expect(emojiToTapback('👍')).toBe('like');
    expect(emojiToTapback('❤️')).toBe('love');
    expect(emojiToTapback('🔥')).toBeUndefined();
    expect(isTapbackName('laugh')).toBe(true);
  });

  it('parses the iOS text forms and nothing else', () => {
    expect(parseLegacyTapbackText('Liked “booked ✅ razzmatazz”')).toEqual({
      tapback: 'like',
      removed: false,
      quoted: 'booked ✅ razzmatazz',
      truncated: false,
    });
    expect(parseLegacyTapbackText('Laughed at "lol"')).toMatchObject({ tapback: 'laugh' });
    expect(parseLegacyTapbackText('Removed a like from “booked”')).toMatchObject({
      tapback: 'like',
      removed: true,
    });
    expect(parseLegacyTapbackText('Removed an exclamation from “x”')).toMatchObject({
      tapback: 'emphasize',
    });
    expect(parseLegacyTapbackText('Loved “a very long message…”')).toMatchObject({
      truncated: true,
      quoted: 'a very long message',
    });
    expect(parseLegacyTapbackText('Liked the dinner a lot')).toBeUndefined();
    expect(parseLegacyTapbackText('liked “x”')).toBeUndefined();
    expect(parseLegacyTapbackText('Liked “…”')).toBeUndefined();
  });

  it('matches a quote to what Trav sent (exact, or prefix when truncated)', () => {
    const exact = parseLegacyTapbackText('Liked “booked ✅ razzmatazz”')!;
    expect(quoteMatches(exact, 'booked ✅  razzmatazz')).toBe(true);
    expect(quoteMatches(exact, 'booked ✅ razzmatazz, 5 tickets')).toBe(false);
    const cut = parseLegacyTapbackText('Liked “booked ✅ razz…”')!;
    expect(quoteMatches(cut, 'booked ✅ razzmatazz, 5 tickets')).toBe(true);
  });
});
