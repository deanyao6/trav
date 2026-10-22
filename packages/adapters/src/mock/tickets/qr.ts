/**
 * Fake ticket barcodes. The payload is clearly marked as not a real ticket and
 * cannot be scanned at any venue; the SVG is a deterministic QR-looking
 * pattern (finder squares + hashed modules) with no real QR encoding, so it
 * can be rendered in the simulator's private DM lane.
 *
 * Barcode artifacts belong in the holder's PrivateStore (D-007); nothing here
 * decides where they are shown.
 */
import { createHash } from 'node:crypto';

export const MOCK_BARCODE_PREFIX = 'TRAV-MOCK-TICKET';

/**
 * `TRAV-MOCK-TICKET|NOT-VALID-FOR-ENTRY|<orderId>|<ticketId>|<check>`.
 * The check is a short hash of the ids; no member data is embedded.
 */
export function mockBarcodePayload(orderId: string, ticketId: string): string {
  const check = createHash('sha256')
    .update(`${orderId}|${ticketId}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `${MOCK_BARCODE_PREFIX}|NOT-VALID-FOR-ENTRY|${orderId}|${ticketId}|${check}`;
}

const SIZE = 25;
const SCALE = 8;
const QUIET = 2;

function inFinder(x: number, y: number): boolean {
  const corners: readonly (readonly [number, number])[] = [
    [0, 0],
    [SIZE - 7, 0],
    [0, SIZE - 7],
  ];
  return corners.some(([cx, cy]) => x >= cx && x < cx + 7 && y >= cy && y < cy + 7);
}

function finderDark(x: number, y: number): boolean {
  const lx = x < 7 ? x : x - (SIZE - 7);
  const ly = y < 7 ? y : y - (SIZE - 7);
  const edge = lx === 0 || lx === 6 || ly === 0 || ly === 6;
  const core = lx >= 2 && lx <= 4 && ly >= 2 && ly <= 4;
  return edge || core;
}

/** Deterministic SVG data URL that looks like a QR code. Same payload ⇒ same image. */
export function mockQrDataUrl(payload: string): string {
  const bits: number[] = [];
  let block = createHash('sha256').update(payload).digest();
  while (bits.length < SIZE * SIZE) {
    for (const byte of block) for (let b = 7; b >= 0; b -= 1) bits.push((byte >> b) & 1);
    block = createHash('sha256').update(block).digest();
  }
  const rects: string[] = [];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const dark = inFinder(x, y) ? finderDark(x, y) : bits[y * SIZE + x] === 1;
      if (dark) {
        rects.push(
          `<rect x="${(x + QUIET) * SCALE}" y="${(y + QUIET) * SCALE}" width="${SCALE}" height="${SCALE}"/>`,
        );
      }
    }
  }
  const px = (SIZE + QUIET * 2) * SCALE;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">` +
    `<title>mock ticket, not valid for entry</title>` +
    `<rect width="${px}" height="${px}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
