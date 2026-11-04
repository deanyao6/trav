/**
 * Offline receipt photos (T-011): `fixtures/receipts/*.json` looked up by the
 * image's sha256, for the two zero-tool calls of the receipt flow.
 *
 *  - `receipt_ocr_v1` (the vision call) answers with the fixture's `ocrText`,
 *    the text a model would have read off the photo, injected lines included.
 *  - `receipt_extract_v1` answers with the fixture's `parsed` (`null` for the
 *    blurred photo) through `createReceiptFixtureResponder`.
 *
 * Unknown images get no answer, so the client falls through to its fixed
 * "not sure" reply and the flow tells the poster it couldn't read the photo.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompletionRequest, CompletionResponse, FallbackResponder } from '../client.js';
import { repoRoot } from '../paths.js';
import { createReceiptFixtureResponder } from './fallbacks.js';
import { deriveScriptKey, lastUserText } from './scripts.js';

export interface ReceiptFixtureEntry {
  readonly receiptId: string;
  readonly ocrText: string;
  readonly parsed: unknown;
}

export function defaultReceiptFixturesDir(): string {
  return join(repoRoot(), 'fixtures', 'receipts');
}

/** sha256 → fixture, for every receipt JSON that names an image. */
export function loadReceiptFixtures(
  dir: string = defaultReceiptFixturesDir(),
): ReadonlyMap<string, ReceiptFixtureEntry> {
  const out = new Map<string, ReceiptFixtureEntry>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    const raw: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const sha = r['imageSha256'];
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) continue;
    out.set(sha, {
      receiptId: typeof r['receiptId'] === 'string' ? r['receiptId'] : f,
      ocrText: typeof r['ocrText'] === 'string' ? r['ocrText'] : '',
      parsed: r['parsed'] ?? null,
    });
  }
  return out;
}

const IMAGE_HASH = /\[image sha256:([0-9a-f]{64})\]/;

/** The vision call's offline answer: the fixture's OCR text. */
export function createReceiptOcrResponder(
  lookup: (imageSha256: string) => string | undefined,
): FallbackResponder {
  return {
    id: 'receipt_ocr_v1',
    complete(req: CompletionRequest): CompletionResponse | undefined {
      if (req.systemPromptId !== 'receipt_ocr_v1' || req.tools.length > 0) return undefined;
      const hash = IMAGE_HASH.exec(lastUserText(req))?.[1];
      if (hash === undefined) return undefined;
      const text = lookup(hash);
      if (text === undefined) return undefined;
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        source: 'fallback',
        scriptKey: deriveScriptKey(req),
      };
    },
  };
}

/** Both receipt responders over the repo's fixtures (loaded on first use). */
export function receiptFixtureResponders(
  dir: string = defaultReceiptFixturesDir(),
): readonly FallbackResponder[] {
  let cache: ReadonlyMap<string, ReceiptFixtureEntry> | undefined;
  const get = (hash: string): ReceiptFixtureEntry | undefined => {
    cache ??= loadReceiptFixtures(dir);
    return cache.get(hash);
  };
  return [
    createReceiptOcrResponder((h) => get(h)?.ocrText),
    createReceiptFixtureResponder((h) => {
      const e = get(h);
      return e === undefined ? undefined : e.parsed;
    }),
  ];
}
