/**
 * Receipt photos the simulator can post (T-199, QA-07): the fixture images in
 * `fixtures/receipts/*.png` that have a labeled JSON next to them.
 *
 * A client never names a path. The composer sends a `receiptId` from this
 * list and the server turns it into the attachment (`fixtures/receipts/<id>.png`),
 * so the HTTP API can't be used to make Trav read any other file. The agent's
 * own reader (`createLocalImageReader`) is a second wall: it only opens files
 * under `fixtures/` and `.trav/attachments/`.
 *
 * The images are served to the browser at `/api/receipts/<id>.png` so the
 * photo shows in the thread like a sent picture. What Trav reads off the photo
 * (offline: the fixture's OCR text, by image hash) is untrusted text and goes
 * through the receipt flow's screening (SAFETY §2.4); nothing is logged until
 * the payer 👍s the read-it card (SAFETY D5).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReceiptOffer, SimAttachment } from '../shared/types.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const RECEIPTS_DIR = join(REPO_ROOT, 'fixtures', 'receipts');
/** Repo-relative, the form the agent's reader and the fixture chat use. */
const RECEIPTS_URI = 'fixtures/receipts';
/** Browser path the thread shows a posted receipt photo from. */
export const RECEIPT_IMAGE_PATH = '/api/receipts';

const ID_RE = /^rcpt_[a-z0-9_]+$/;

export interface ReceiptFixture extends ReceiptOffer {
  readonly groupId: string;
}

let cache: readonly ReceiptFixture[] | undefined;

/** "rcpt_bcn_lunch_service" → "lunch service". */
function labelOf(id: string): string {
  return id.replace(/^rcpt_[a-z]+_/, '').replace(/_/g, ' ');
}

/** Every postable receipt photo (a PNG with its labeled JSON), sorted by id. */
export function receiptFixtures(): readonly ReceiptFixture[] {
  if (cache !== undefined) return cache;
  const out: ReceiptFixture[] = [];
  let files: string[];
  try {
    files = readdirSync(RECEIPTS_DIR);
  } catch {
    files = [];
  }
  for (const f of files.filter((x) => x.endsWith('.json')).sort()) {
    const id = f.slice(0, -'.json'.length);
    if (!ID_RE.test(id) || !existsSync(join(RECEIPTS_DIR, `${id}.png`))) continue;
    let groupId = '';
    try {
      const raw = JSON.parse(readFileSync(join(RECEIPTS_DIR, f), 'utf8')) as Record<
        string,
        unknown
      >;
      if (typeof raw['groupId'] === 'string') groupId = raw['groupId'];
    } catch {
      continue;
    }
    if (groupId === '') continue;
    out.push({ receiptId: id, label: labelOf(id), groupId });
  }
  cache = out;
  return out;
}

/** The receipt photos offered in one chat's composer (that trip's fixtures). */
export function receiptsForGroup(groupId: string): readonly ReceiptOffer[] {
  return receiptFixtures()
    .filter((r) => r.groupId === groupId)
    .map(({ receiptId, label }) => ({ receiptId, label }));
}

/** The attachment for a listed receipt id, or undefined (unknown id). */
export function receiptAttachment(receiptId: string): SimAttachment | undefined {
  const r = receiptFixtures().find((x) => x.receiptId === receiptId);
  if (r === undefined) return undefined;
  return {
    kind: 'image',
    mimeType: 'image/png',
    uri: `${RECEIPTS_URI}/${r.receiptId}.png`,
    fileName: `${r.receiptId}.png`,
  };
}

/**
 * Where the browser loads a posted attachment from: a listed fixture receipt
 * maps to `/api/receipts/<id>.png`; anything else has no `src` (the thread
 * draws a placeholder and never fetches an outside URL).
 */
export function attachmentSrc(uri: string): string | undefined {
  const m = /^(?:\.\/)?fixtures\/receipts\/(rcpt_[a-z0-9_]+)\.png$/.exec(uri);
  if (m === null) return undefined;
  const id = m[1]!;
  return receiptFixtures().some((r) => r.receiptId === id)
    ? `${RECEIPT_IMAGE_PATH}/${id}.png`
    : undefined;
}

/** The PNG bytes for `GET /api/receipts/<id>.png`, only for a listed id. */
export function receiptImage(receiptId: string): Buffer | undefined {
  if (!receiptFixtures().some((r) => r.receiptId === receiptId)) return undefined;
  try {
    return readFileSync(join(RECEIPTS_DIR, `${receiptId}.png`));
  } catch {
    return undefined;
  }
}
