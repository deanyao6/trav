/**
 * Heuristic prompt-injection scan for email receipts (SAFETY §2.4 "Detection").
 *
 * This is a mirror of `detectInjection` in `packages/agent/src/untrusted.ts`
 * (same pattern list, same names, same normalization): `@trav/adapters` may
 * import only `@trav/core`, so it cannot call the agent's copy. The parity
 * test (`injection.test.ts`) reads the agent's source and fails on any drift
 * in the strip ranges, pattern names or pattern sources, and checks every
 * email fixture's `expected.injectionPatterns` (from `fixtures/_gen/lib.mjs`).
 * Lifting this into `@trav/core` is a follow-up.
 *
 * Returns pattern NAMES only, never excerpts, so nothing from the body leaves
 * the parser through this path.
 */

/** Same list as the agent's `STRIP_RANGES`: controls (not tab/newline), zero-width, bidi, fillers, variation selectors, BOM. */
export const STRIP_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008], // C0 controls before tab
  [0x000b, 0x001f], // C0 controls after newline (incl. carriage return)
  [0x007f, 0x009f], // DEL + C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // arabic letter mark (bidi)
  [0x115f, 0x1160], // hangul fillers
  [0x17b4, 0x17b5], // khmer invisible vowels
  [0x180b, 0x180f], // mongolian variation selectors, vowel separator
  [0x200b, 0x200f], // zero-width space/joiners, LRM, RLM
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates
  [0x3164, 0x3164], // hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xffa0, 0xffa0], // halfwidth hangul filler
];

/** NFKC-normalize and remove control, zero-width and bidi code points. */
export function stripInvisible(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFKC')) {
    const cp = ch.codePointAt(0) ?? 0;
    if (!STRIP_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) out += ch;
  }
  return out;
}

export const INJECTION_PATTERNS: readonly (readonly [string, RegExp])[] = [
  [
    'ignore_instructions',
    /ignore (?:all |any |the )?(?:previous|prior|above|earlier|all|your)? ?(?:instructions|rules|prompts?)/i,
  ],
  ['system_prompt', /system prompt/i],
  ['you_are_now', /you are now/i],
  ['as_an_ai', /as an ai/i],
  ['disregard', /disregard/i],
  ['approve_all', /approve all/i],
  ['send_money', /send (?:money|payment|funds)/i],
  ['transfer_to', /transfer .{0,80}? to/i],
  ['api_key', /api[_ -]?key/i],
  ['password', /password/i],
  ['at_trav', /@trav/i],
  ['trav_command', /trav,? (?:book|buy|pay|approve|split|add)/i],
  ['markup_tag', /<\s*\/?\s*(?:system|untrusted|tool)/i],
  ['url', /https?:\/\//i],
];

/** Names of the patterns that match `text` (after normalization), in list order. */
export function detectInjectionPatterns(text: string): readonly string[] {
  const normalized = stripInvisible(text).replace(/\s+/g, ' ');
  return INJECTION_PATTERNS.filter(([, re]) => re.test(normalized)).map(([name]) => name);
}

/** A bare link is benign on a receipt; every other pattern counts as instruction-like text. */
export function isInstructionLike(patterns: readonly string[]): boolean {
  return patterns.some((p) => p !== 'url');
}
