/**
 * T-184: the fresh paraphrase set (`scenarios/paraphrase.json`). These tests
 * keep it honest without running Trav:
 *
 * - size and shape: 20+ scenarios per area (Razzmatazz, chat expense,
 *   exclusion, settle-up), every one held out (`heldout` + `paraphrase`),
 *   none in the regression suite, none a known gap;
 * - arithmetic: every expected expense splits its total exactly, equal parts
 *   within one cent, odd cents on the payer first (core `splits.ts`); every
 *   settle-up's expected transfers net to exactly what its logged expenses
 *   imply, within the n−1 transfer bound;
 * - contamination: no line under test repeats, contains, or nearly matches
 *   (word Jaccard ≥ 0.8) any string in another scenario file, a fixture, or a
 *   test in packages/ or apps/ (the T-081 lesson: a held-out line copied from
 *   a test is no longer held out).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFiles, repoRoot } from './arch/repo.js';
import { loadScenarios, scenariosDir, validateScenario } from './scenarios.js';
import type { Scenario, SayStep, StepExpect } from './types.js';

const FILE = 'paraphrase.json';
const AREAS = ['razz', 'expense', 'exclusion', 'settle'] as const;

function paraphrases(): Scenario[] {
  const raw = JSON.parse(readFileSync(join(scenariosDir(), FILE), 'utf8')) as unknown[];
  return raw.map((r, i) => validateScenario(r, `${FILE}[${String(i)}]`));
}

function says(s: Scenario): SayStep[] {
  return s.steps.filter((st): st is SayStep => st.do === 'say');
}

function areaOf(id: string): string {
  return /^para_([a-z]+)_\d{2}$/.exec(id)?.[1] ?? '';
}

describe('paraphrase set: size and shape', () => {
  const all = paraphrases();

  it.each(AREAS)('has at least 20 %s scenarios', (area) => {
    expect(all.filter((s) => areaOf(s.id) === area).length).toBeGreaterThanOrEqual(20);
  });

  it('has 80+ scenarios, every id in an area', () => {
    expect(all.length).toBeGreaterThanOrEqual(80);
    for (const s of all) expect(AREAS as readonly string[]).toContain(areaOf(s.id));
  });

  it('is held out, tagged paraphrase, never regression, never a known gap', () => {
    for (const s of all) {
      expect(s.tags).toContain('heldout');
      expect(s.tags).toContain('paraphrase');
      expect(s.tags).not.toContain('regression');
      expect(s.pending).toBeUndefined();
      expect(s.expect?.maxPurchases).toBe(0);
    }
  });

  it('is the only file carrying the paraphrase tag', () => {
    const tagged = loadScenarios().filter((s) => s.tags.includes('paraphrase'));
    expect(tagged.map((s) => s.id).sort()).toEqual(all.map((s) => s.id).sort());
  });

  it('razz scenarios: one five-person €90 card, never a purchase', () => {
    for (const s of all.filter((x) => areaOf(x.id) === 'razz')) {
      const [step] = says(s);
      const p = step?.expect?.proposal;
      expect(p?.attendees).toHaveLength(5);
      expect(p?.payers).toEqual(p?.attendees);
      expect(p?.excluded).toHaveLength(1);
      expect(p?.attendees).not.toContain(p?.excluded?.[0]);
      expect(p?.totalMinor).toBe(5 * 1800);
      expect(step?.expect?.purchases).toBe(0);
      expect(s.setup?.spendingPolicy).toBeUndefined();
    }
  });
});

// ---------- arithmetic ----------

const MEMBER_ORDER = ['dean', 'henry', 'chase', 'piotr', 'arjun', 'crowley'].map((m) => `mem_${m}`);

type ExpenseExpect = NonNullable<StepExpect['expense']>;

function checkSplit(e: ExpenseExpect): void {
  const shares = e.shares ?? [];
  expect(shares.length).toBeGreaterThan(0);
  expect(shares.reduce((a, s) => a + s.amountMinor, 0)).toBe(e.amountMinor);
  for (const s of shares) {
    expect(Number.isInteger(s.amountMinor)).toBe(true);
    expect(MEMBER_ORDER).toContain(s.memberId);
  }
  const base = Math.floor(e.amountMinor / shares.length);
  const extra = e.amountMinor - base * shares.length;
  // Odd cents: payer first (if in the split), then member order (core splits.ts).
  const order = [
    ...shares.filter((s) => s.memberId === e.paidBy),
    ...MEMBER_ORDER.flatMap((m) =>
      shares.filter((s) => s.memberId === m && s.memberId !== e.paidBy),
    ),
  ];
  order.forEach((s, i) => expect(s.amountMinor).toBe(base + (i < extra ? 1 : 0)));
}

/** + is owed. */
function netsOfExpenses(es: readonly ExpenseExpect[]): Map<string, number> {
  const net = new Map<string, number>();
  const add = (m: string, x: number) => net.set(m, (net.get(m) ?? 0) + x);
  for (const e of es) {
    add(e.paidBy, e.amountMinor);
    for (const s of e.shares ?? []) add(s.memberId, -s.amountMinor);
  }
  return new Map([...net].filter(([, v]) => v !== 0));
}

function netsOfTransfers(
  ts: readonly { from: string; to: string; amountMinor: number }[],
): Map<string, number> {
  const net = new Map<string, number>();
  const add = (m: string, x: number) => net.set(m, (net.get(m) ?? 0) + x);
  // The net a transfer list settles: the sender owed it (−), the receiver was owed it (+).
  for (const t of ts) {
    add(t.from, -t.amountMinor);
    add(t.to, t.amountMinor);
  }
  return new Map([...net].filter(([, v]) => v !== 0));
}

describe('paraphrase set: arithmetic', () => {
  const all = paraphrases();

  it('every expected expense splits exactly, odd cents on the payer first', () => {
    let n = 0;
    for (const s of all) {
      for (const st of says(s)) {
        if (st.expect?.expense === undefined) continue;
        checkSplit(st.expect.expense);
        n += 1;
      }
    }
    expect(n).toBeGreaterThanOrEqual(60);
  });

  it('exclusion scenarios leave the excluded members out of the split', () => {
    for (const s of all.filter((x) => areaOf(x.id) === 'exclusion')) {
      const shares = says(s)[0]?.expect?.expense?.shares ?? [];
      expect(shares.length).toBeGreaterThan(0);
      expect(shares.length).toBeLessThan(MEMBER_ORDER.length);
    }
  });

  it('settle-up transfers net to what the logged expenses imply, within n−1', () => {
    for (const s of all.filter((x) => areaOf(x.id) === 'settle')) {
      const steps = says(s);
      const ask = steps[steps.length - 1];
      const seeds = steps.slice(0, -1).map((st) => st.expect?.expense);
      expect(seeds.length).toBeGreaterThan(0);
      for (const e of seeds) expect(e).toBeDefined();
      const want = netsOfExpenses(seeds.filter((e): e is ExpenseExpect => e !== undefined));
      const transfers = ask?.expect?.transfers ?? [];
      expect(ask?.expect?.action).toEqual(['settle_up']);
      expect(netsOfTransfers(transfers)).toEqual(want);
      expect(ask?.expect?.maxTransfers).toBe(Math.max(want.size - 1, 0));
      expect(transfers.length).toBeLessThanOrEqual(ask?.expect?.maxTransfers ?? 0);
    }
  });
});

// ---------- contamination ----------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/@trav\b/g, ' ')
    .replace(/[^a-z0-9€]+/g, ' ')
    .trim();
}

function words(s: string): Set<string> {
  return new Set(normalize(s).split(' ').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function jsonStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) jsonStrings(x, out);
  else if (typeof v === 'object' && v !== null)
    for (const x of Object.values(v as Record<string, unknown>)) jsonStrings(x, out);
}

/** Strings a paraphrase must not be copied from: other scenarios, fixtures, and test sources. */
function corpus(): string[] {
  const out: string[] = [];
  const root = repoRoot();
  const files = readRepoFiles(
    root,
    (p) =>
      (p.startsWith('packages/evals/scenarios/') &&
        p.endsWith('.json') &&
        !p.endsWith(`/${FILE}`)) ||
      (p.startsWith('fixtures/') && (p.endsWith('.json') || p.endsWith('.jsonl'))) ||
      ((p.startsWith('packages/') || p.startsWith('apps/')) && /\.test\.tsx?$/.test(p)),
  );
  for (const f of files) {
    if (f.path.endsWith('.jsonl')) {
      for (const line of f.content.split('\n').filter((l) => l.trim() !== ''))
        jsonStrings(JSON.parse(line) as unknown, out);
    } else if (f.path.endsWith('.json')) {
      jsonStrings(JSON.parse(f.content) as unknown, out);
    } else {
      out.push(...literalsOf(f.content));
    }
  }
  return out.map(normalize).filter((s) => s.split(' ').length >= 4);
}

/** String literals in a test source ('…' and "…" within a line, `…` across lines). */
function literalsOf(source: string): string[] {
  return [...source.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`]*)`/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? '',
  );
}

describe('paraphrase set: written fresh', () => {
  const lines = paraphrases().flatMap((s) => says(s).map((st) => ({ id: s.id, text: st.text })));
  const seen = corpus();
  const seenWords = seen.map(words);

  it('the corpus really holds test, scenario and fixture strings (the guard is not vacuous)', () => {
    // The flagship ask lives in tests, scenarios and the Barcelona chat fixture.
    expect(seen).toContain(normalize("@trav get the 5 of us Razzmatazz tickets, Henry's sick"));
    expect(seen.length).toBeGreaterThan(2000);
    const src = `say('@trav it\\'s on me, 3 ways'); t("@trav dinner was 40"); x(\`@trav a\nb\`);`;
    expect(literalsOf(src)).toEqual([
      "@trav it\\'s on me, 3 ways",
      '@trav dinner was 40',
      '@trav a\nb',
    ]);
  });

  it('lines are unique within the set (settle seeds aside)', () => {
    const asks = paraphrases().flatMap((s) => {
      const st = says(s);
      return areaOf(s.id) === 'settle' ? st.slice(-1) : st;
    });
    const texts = asks.map((st) => normalize(st.text));
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('no line repeats, contains, or nearly matches an existing test, scenario or fixture string', () => {
    const hits: string[] = [];
    for (const { id, text } of lines) {
      const n = normalize(text);
      const w = words(text);
      seen.forEach((c, i) => {
        const near = jaccard(w, seenWords[i] ?? new Set());
        if (c === n || c.includes(n) || (c.length >= 25 && n.includes(c)) || near >= 0.8)
          hits.push(`${id}: "${text}" ~ "${c}" (${near.toFixed(2)})`);
      });
    }
    expect(hits).toEqual([]);
  });
});
