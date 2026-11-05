/**
 * T-181 (a): the combined term matchers must match exactly where the old
 * one-regex-per-term matchers did. These tests compare against a reference
 * built from `termRegex`, the pre-T-181 behaviour, so a faster matcher can
 * never quietly let a blocked roast topic or restricted content through.
 */
import { describe, expect, it } from 'vitest';
import { loadSafetyFixture } from './test-helpers.js';
import { normalizeText, termRegex, termsRegex } from './text.js';
import type { RoastBlocklistEntry, RoastTopicCategory } from './roast.js';
import { DEFAULT_ROAST_BLOCKLIST, ROAST_IDIOMS, roastTopicBlocked } from './roast.js';
import { BENIGN_PHRASES, CONTENT_TERMS, detectContentTags } from './minors.js';
import type { ContentTag } from '../domain/trip.js';

interface BlocklistFixture {
  readonly blocked: readonly { readonly line: string }[];
  readonly allowed: readonly { readonly line: string }[];
  readonly gated: readonly { readonly line: string }[];
}

const IDIOM_RES = ROAST_IDIOMS.map((p) => new RegExp(termRegex(p).source, 'giu'));
const BENIGN_RES = BENIGN_PHRASES.map((p) => new RegExp(termRegex(p).source, 'giu'));
const CONTENT_RES = CONTENT_TERMS.map((g) => ({ tag: g.tag, res: g.terms.map(termRegex) }));
const entryCache = new WeakMap<
  readonly RoastBlocklistEntry[],
  { re: RegExp; cat: RoastTopicCategory }[]
>();

/** Pre-T-181 `roastTopicBlocked`: every entry's own regex, in list order. */
function referenceTopic(
  line: string,
  blocklist: readonly RoastBlocklistEntry[] = DEFAULT_ROAST_BLOCKLIST,
): RoastTopicCategory | null {
  let entries = entryCache.get(blocklist);
  if (entries === undefined) {
    entries = blocklist
      .filter((e) => e.term.trim().length > 0)
      .map((e) => ({ re: termRegex(e.term), cat: e.category }));
    entryCache.set(blocklist, entries);
  }
  let text = normalizeText(line);
  for (const re of IDIOM_RES) text = text.replace(re, ' ');
  for (const e of entries) if (e.re.test(text)) return e.cat;
  return null;
}

/** Pre-T-181 `detectContentTags`: every term's own regex. */
function referenceTags(text: string): ContentTag[] {
  let cleaned = normalizeText(text);
  for (const re of BENIGN_RES) cleaned = cleaned.replace(re, ' ');
  const t = normalizeText(cleaned);
  return CONTENT_RES.filter((g) => g.res.some((re) => re.test(t))).map((g) => g.tag);
}

/** Each term in the shapes that probe its boundaries, plural and case handling. */
function probes(term: string): string[] {
  const t = term.trim();
  return [
    t,
    t.toUpperCase(),
    `${t}s`,
    `${t}es`,
    `x${t}`,
    `${t}x`,
    `1${t}`,
    `${t}é`,
    `é${t}`,
    `the ${t}, honestly`,
    `(${t})`,
    t.replace(/\s+/g, '-'),
    t.replace(/\s+/g, '  '),
    t.replace(/\s+/g, ''),
  ];
}

const fixture = loadSafetyFixture<BlocklistFixture>('roast-blocklist-cases.json');
const FIXTURE_LINES = [...fixture.blocked, ...fixture.allowed, ...fixture.gated].map((c) => c.line);
const ROAST_TERMS = DEFAULT_ROAST_BLOCKLIST.map((e) => e.term);
const CONTENT_ALL = CONTENT_TERMS.flatMap((g) => g.terms);
const CORPUS = [
  ...new Set([
    ...FIXTURE_LINES,
    ...ROAST_TERMS.flatMap(probes),
    ...CONTENT_ALL.flatMap(probes),
    ...BENIGN_PHRASES.flatMap(probes),
    '',
    '€62 of it was kebabs at 3am',
    'asleep at the wheel again, and face value on the tickets',
  ]),
];

/**
 * The corpus is ~6k strings against ~400 reference regexes (about 1 s). The
 * assertions are the check; this timeout only catches a hang, so it is
 * generous enough that machine load cannot fail it (the T-181 lesson).
 */
const SLOW = { timeout: 60_000 };

describe('termsRegex (T-181)', SLOW, () => {
  it('an empty list matches nothing', () => {
    expect(termsRegex([])).toBeNull();
  });

  it('matches exactly where some termRegex matches, over every blocklist and content term', () => {
    for (const terms of [ROAST_TERMS, CONTENT_ALL, BENIGN_PHRASES, ['bar'], ["can't afford"]]) {
      const combined = termsRegex(terms);
      const singles = terms.map((t) => termRegex(t));
      for (const s of CORPUS) {
        const n = normalizeText(s);
        expect(combined?.test(n), `${JSON.stringify(s)} vs ${terms.length} terms`).toBe(
          singles.some((r) => r.test(n)),
        );
      }
    }
  });

  it('keeps the boundary rules ("bar" hits "Bar del Pla" and "bars", not "barça" or "barely")', () => {
    const re = termsRegex(['bar', 'first date']);
    expect(re?.test('Bar del Pla')).toBe(true);
    expect(re?.test('two bars')).toBe(true);
    expect(re?.test('barça')).toBe(false);
    expect(re?.test('barely')).toBe(false);
    expect(re?.test('a first-date vibe')).toBe(true);
  });
});

describe('roastTopicBlocked with combined matchers (T-181)', SLOW, () => {
  it('returns the same category as the per-entry reference on the whole corpus', () => {
    for (const s of CORPUS) expect(roastTopicBlocked(s), JSON.stringify(s)).toBe(referenceTopic(s));
  });

  it('first matching ENTRY in list order wins, not the leftmost match in the line', () => {
    const list: RoastBlocklistEntry[] = [
      { term: 'zebra', category: 'body' },
      { term: 'kebab', category: 'outsider' },
      { term: 'zebra', category: 'romance' },
    ];
    expect(roastTopicBlocked('kebab then zebra', list)).toBe('body');
    expect(roastTopicBlocked('only kebabs', list)).toBe('outsider');
  });

  it('a category split into separate runs keeps list order', () => {
    const list: RoastBlocklistEntry[] = [
      { term: 'alpha', category: 'body' },
      { term: 'beta', category: 'legal' },
      { term: 'gamma', category: 'body' },
      { term: '   ', category: 'health' },
    ];
    expect(roastTopicBlocked('gamma beta', list)).toBe('legal');
    expect(roastTopicBlocked('gamma', list)).toBe('body');
    expect(roastTopicBlocked('nothing here', list)).toBeNull();
    for (const s of ['alpha', 'beta gamma', 'gamma alpha beta', '', '   ']) {
      expect(roastTopicBlocked(s, list)).toBe(referenceTopic(s, list));
    }
  });

  it('a group blocklist appended to the default behaves like the reference', () => {
    const list = [
      ...DEFAULT_ROAST_BLOCKLIST,
      { term: 'kebab', category: 'intoxication' as const },
      { term: 'tapas crawl', category: 'body' as const },
    ];
    for (const s of [...FIXTURE_LINES, 'kebab at 3am', 'the tapas crawl again', 'nothing']) {
      expect(roastTopicBlocked(s, list), s).toBe(referenceTopic(s, list));
    }
  });
});

describe('detectContentTags with combined matchers (T-181)', SLOW, () => {
  it('returns the same tags as the per-term reference on the whole corpus', () => {
    for (const s of CORPUS)
      expect(detectContentTags(s), JSON.stringify(s)).toEqual(referenceTags(s));
  });
});
