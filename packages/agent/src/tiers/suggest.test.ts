/**
 * T-167: soft budgets and the learned spending tier, end to end through the
 * agent loop (offline, rules only) plus the pure pieces in `tiers/`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContentTag, Member, OutboundMessage, Trip } from '@trav/core';
import { isReaction, localDate, safety, tiers } from '@trav/core';
import { parseVenueCatalog } from '@trav/adapters';
import { BARCELONA } from '../compose.js';
import { harness, RAZZMATAZZ_ASK } from '../runtime.testkit.js';
import type { Harness } from '../runtime.testkit.js';
import type { TurnResult } from '../loop.js';
import { repoRoot } from '../model/paths.js';
import { inferTierFixture, parseTierFixture } from './fixture.js';
import type { TierFixture } from './fixture.js';
import {
  SUGGEST_MAX_CHARS,
  VIBE_QUESTION_TONIGHT,
  parseSuggestAsk,
  renderSuggestions,
} from './suggest.js';

const G = BARCELONA.groupId;
const HENRY_DM = "can you keep my share under 80 a day? money's tight this semester";

function texts(r: TurnResult): string[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o)).map((m) => m.text);
}

function text(r: TurnResult): string {
  return texts(r).join('\n');
}

function loadTierFixture(name: string): TierFixture {
  const raw: unknown = JSON.parse(
    readFileSync(join(repoRoot(), 'fixtures', 'tiers', `${name}.json`), 'utf8'),
  );
  return parseTierFixture(raw, name);
}

const CATALOG = parseVenueCatalog(
  JSON.parse(readFileSync(join(repoRoot(), 'fixtures', 'places', 'barcelona.json'), 'utf8')),
);
const LEVEL_BY_NAME = new Map(CATALOG.places.map((p) => [p.name, p.priceLevel] as const));

/** The price levels of the places a suggestion lists (by name). */
function levelsIn(t: string): number[] {
  return t
    .split('\n')
    .slice(1)
    .map((line) => {
      const name = [...LEVEL_BY_NAME.keys()].find((n) => line.includes(n));
      if (name === undefined) throw new Error(`no catalog place in line: ${line}`);
      return LEVEL_BY_NAME.get(name)!;
    });
}

function tripOf(h: Harness): Trip {
  return h.runtime.stores.group.trips.get(BARCELONA.tripId)!;
}

function membersOf(h: Harness): Member[] {
  return [...h.runtime.stores.group.members.listByGroup(G)];
}

function today(h: Harness): string {
  return localDate(h.clock.now(), tripOf(h).timeZone);
}

/** Words that would frame a tier as a judgement of someone (VOICE; T-167). */
const JUDGEMENT =
  /\b(?:you'?re|ur|he'?s|she'?s|they'?re|is|are) (?:so )?(?:cheap|broke|poor|stingy|rich|bougie|boujee|fancy|high[- ]end|budget)\b|\b(?:budget|high|mid)[- ]tier\b|\bspending tier\b/i;

function withFixture(name: string): { h: Harness; fx: TierFixture } {
  const fx = loadTierFixture(name);
  const h = harness({ runtime: { travelFacts: () => fx.travel } });
  return { h, fx };
}

// ---------- the ask parser ----------

describe('parseSuggestAsk', () => {
  it.each([
    ['@trav where should the 6 of us eat tonight', 'restaurant', 'tonight'],
    ['@trav any good bars tonight', 'bar', 'tonight'],
    ['@trav cheap eats for lunch tomorrow', 'restaurant', 'tomorrow'],
    ['@trav things to do this afternoon', 'activity', 'today'],
    ['@trav dinner spot ideas?', 'restaurant', undefined],
  ])('%s', (t, category, when) => {
    const a = parseSuggestAsk(t);
    expect(a?.category).toBe(category);
    expect(a?.when).toBe(when);
  });

  it('reads what the ask says about price', () => {
    expect(parseSuggestAsk('@trav cheap eats for lunch tomorrow')?.statedTier).toBe('budget');
    expect(parseSuggestAsk('@trav somewhere nice for dinner')?.statedTier).toBe('high');
    expect(parseSuggestAsk('@trav where should we eat, nothing too fancy')?.statedTier).toBe('mid');
    expect(parseSuggestAsk('@trav where should we eat tonight')?.statedTier).toBeUndefined();
  });

  it('reads a per-person figure only when it is money', () => {
    expect(parseSuggestAsk('@trav dinner spot under 30 a head')?.perPersonBudgetMinor).toBe(3000);
    expect(parseSuggestAsk('@trav dinner ideas under €25.50')?.perPersonBudgetMinor).toBe(2550);
    // "for 6" and "around 9" are not a figure.
    expect(
      parseSuggestAsk('@trav dinner spot for 6 around 9')?.perPersonBudgetMinor,
    ).toBeUndefined();
  });

  it.each([
    RAZZMATAZZ_ASK,
    '@trav book us a table for dinner',
    '@trav i paid 84 for dinner, split with everyone',
    '@trav any good clubs tonight',
    '@trav remember chase hates tapas',
    '@trav what time is dinner',
    '',
    // T-222: a payment being stated at a place, not an ask for places
    '@trav grabbed the check at that tapas spot, €70, everyone',
    '@trav the pizza place came to 54 euros, me and maya',
    '@trav i picked up the bill at the bar, $40',
  ])('not a suggestion ask: %s', (t) => {
    expect(parseSuggestAsk(t)).toBeUndefined();
  });

  it('a budget figure without a spend word is still an ask (T-222)', () => {
    expect(parseSuggestAsk('@trav any tapas places under €30 a head?')?.category).toBe(
      'restaurant',
    );
    expect(parseSuggestAsk('@trav dinner spot ideas around 25 euros each')?.category).toBe(
      'restaurant',
    );
    expect(parseSuggestAsk('@trav dinner places where it costs under €30 a head')).toBeDefined();
    expect(
      parseSuggestAsk('@trav the last dinner spot was €25 a head, any good places like it?'),
    ).toBeDefined();
  });

  // T-222 r1 #1: "got" in a question, "have you got", "got … left" and a bare
  // "bill" are not payments; these are all still restaurant asks
  it.each([
    '@trav got any lunch places under €25 a head?',
    '@trav got any ideas for brunch under 15 euros?',
    '@trav which tapas spots have you got under €35',
    '@trav got recs for a good lunch spot? 30 euros each max',
    '@trav we got €50 left each, any ideas for dinner?',
    "@trav we've got 30 euros each, dinner spot ideas",
    '@trav lunch spot ideas where the bill wont be huge',
    '@trav any places that do a set lunch, bill under €20',
    '@trav any recs for dinner with bill and the others tonight',
    '@trav i got the kids, any ideas for lunch under €20 a head',
  ])('still a restaurant ask: %s', (t) => {
    expect(parseSuggestAsk(t)?.category).toBe('restaurant');
  });

  it.each([
    '@trav we grabbed the tab at the wine bar, €64, everyone',
    '@trav maya got our dinner at that place, 80 euros',
    '@trav got the lunch at the beach spot, $45, split with everyone',
  ])('a payment shape with an amount is not an ask: %s', (t) => {
    expect(parseSuggestAsk(t)).toBeUndefined();
  });
});

describe('renderSuggestions', () => {
  it('fits one bubble, dropping areas then lines', () => {
    const long = CATALOG.places.slice(0, 3).map((place) => ({
      place: { ...place, name: `${place.name} ${'x'.repeat(80)}` },
      stepUp: false,
    }));
    const out = renderSuggestions('dinner ideas for tonight:', long);
    expect(out.length).toBeLessThanOrEqual(SUGGEST_MAX_CHARS);
    expect(out.startsWith('dinner ideas for tonight:\n')).toBe(true);
  });
});

// ---------- tier inferred on fixture trips ----------

describe('fixture trips: the tier is inferred correctly', () => {
  for (const name of ['barcelona-high', 'barcelona-budget', 'barcelona-mixed']) {
    it(`${name}: every member and the group match the label`, () => {
      const { h, fx } = withFixture(name);
      const got = inferTierFixture(fx, { trip: tripOf(h), members: membersOf(h) });
      expect(got.members).toEqual(fx.expect.members);
      expect(got.blend.status).toBe(fx.expect.group.status);
      expect(got.blend.target).toBe(fx.expect.group.target);
    });
  }

  it('a malformed fixture is rejected', () => {
    expect(() => parseTierFixture({ name: 'x', travel: [], spend: [] })).toThrow(/groupLines/);
    expect(() =>
      parseTierFixture({
        name: 'x',
        travel: [],
        spend: [{ shareMinor: 12.5 }],
        groupLines: [],
        expect: { members: {}, group: {} },
      }),
    ).toThrow(/integer/);
  });
});

// ---------- restaurant options shift with tier ----------

describe('restaurant options shift price level with the tier', () => {
  it('high-end trip: no question, fancy places', async () => {
    const { h, fx } = withFixture('barcelona-high');
    const r = await h.say('h_dean', '@trav where should we eat tonight');
    expect(r.note).toBe('suggest:places');
    expect(text(r)).not.toContain(VIBE_QUESTION_TONIGHT);
    const levels = levelsIn(text(r));
    expect(levels.length).toBeGreaterThanOrEqual(2);
    for (const l of levels)
      expect(l).toBeGreaterThanOrEqual(fx.expect.restaurantPriceLevelsAtLeast!);
    expect(h.model.completions).toHaveLength(0);
  });

  it('budget trip: no question, cheap places', async () => {
    const { h, fx } = withFixture('barcelona-budget');
    const r = await h.say('h_dean', '@trav where should we eat tonight');
    expect(r.note).toBe('suggest:places');
    const levels = levelsIn(text(r));
    expect(levels.length).toBeGreaterThanOrEqual(2);
    for (const l of levels) expect(l).toBeLessThanOrEqual(fx.expect.restaurantPriceLevelsAtMost!);
  });

  it('the same ask on the two trips gives disjoint lists', async () => {
    const hi = await withFixture('barcelona-high').h.say(
      'h_dean',
      '@trav where should we eat tonight',
    );
    const lo = await withFixture('barcelona-budget').h.say(
      'h_dean',
      '@trav where should we eat tonight',
    );
    const a = new Set(text(hi).split('\n').slice(1));
    for (const line of text(lo).split('\n').slice(1)) expect(a.has(line)).toBe(false);
    expect(Math.min(...levelsIn(text(hi)))).toBeGreaterThan(Math.max(...levelsIn(text(lo))));
  });

  it('what the ask says beats the trip ("cheap eats" on the high-end trip)', async () => {
    const { h } = withFixture('barcelona-high');
    const r = await h.say('h_dean', '@trav cheap eats for lunch tomorrow');
    expect(r.note).toBe('suggest:places');
    for (const l of levelsIn(text(r))) expect(l).toBeLessThanOrEqual(2);
  });

  it('a per-person figure puts in-budget places first and never drops what is over', () => {
    const ranked = tiers.rankPlaces(
      CATALOG.places.filter((p) => p.category === 'restaurant'),
      { target: 'high', perPersonBudgetMinor: 1000 },
    );
    expect(ranked[0]!.overBudget).toBe(false);
    expect(ranked.slice(1).every((r) => r.overBudget)).toBe(true);
    expect(ranked).toHaveLength(3);
  });

  it('spending exactly the figure is within it', () => {
    const ranked = tiers.rankPlaces(
      CATALOG.places.filter((p) => p.placeId === 'pl_bcn_cal_nen'),
      { target: 'budget', perPersonBudgetMinor: 1400 },
    );
    expect(ranked[0]!.overBudget).toBe(false);
  });
});

// ---------- the one clarifying question ----------

describe('"fancy or casual tonight?" fires only when signals conflict or are missing', () => {
  it('conflicting signals (first on Emirates, a 1-bedroom for six): asks once', async () => {
    const { h } = withFixture('barcelona-mixed');
    const r = await h.say('h_dean', '@trav where should we eat tonight');
    expect(r.note).toBe('suggest:question');
    expect(texts(r)).toEqual([VIBE_QUESTION_TONIGHT]);
  });

  it('no signals at all: asks once', async () => {
    const h = harness();
    const r = await h.say('h_dean', '@trav where should the 6 of us eat tonight');
    expect(texts(r)).toEqual([VIBE_QUESTION_TONIGHT]);
  });

  it('known signals: never asks (high, budget)', async () => {
    for (const name of ['barcelona-high', 'barcelona-budget']) {
      const { h } = withFixture(name);
      const r = await h.say('h_dean', '@trav where should we eat tonight');
      expect(r.note).toBe('suggest:places');
      for (const ask of ['@trav any good bars tonight', '@trav things to do tonight']) {
        expect((await h.say('h_chase', ask)).note).toBe('suggest:places');
      }
    }
  });

  it('the ask said the price: never asks, even with no signals', async () => {
    const h = harness();
    expect((await h.say('h_dean', '@trav cheap eats tonight')).note).toBe('suggest:places');
    expect((await h.say('h_dean', '@trav somewhere nice for dinner')).note).toBe('suggest:places');
    expect((await h.say('h_dean', '@trav dinner spot under 30 a head')).note).toBe(
      'suggest:places',
    );
  });

  it('the answer is remembered in group memory for that day and used for the next ask', async () => {
    const h = harness();
    await h.say('h_dean', '@trav where should the 6 of us eat tonight');
    const a = await h.say('h_chase', '@trav casual');
    expect(a.note).toBe('suggest:answered');
    expect(text(a)).toMatch(/^casual it is\. dinner ideas for tonight:/);
    for (const l of levelsIn(text(a).replace(/^casual it is\. /, '')))
      expect(l).toBeLessThanOrEqual(2);
    const facts = h.runtime.groupMemory.recall(G).map((f) => f.text);
    expect(facts).toContain(tiers.formatVibeFact('budget', today(h)));

    // Later the same day: no second question, the remembered vibe shapes it.
    h.clock.advanceMs(60 * 60_000);
    const again = await h.say('h_piotr', '@trav any good bars tonight');
    expect(again.note).toBe('suggest:places');
    for (const l of levelsIn(text(again))) expect(l).toBeLessThanOrEqual(2);
  });

  it("tonight's answer doesn't decide tomorrow (it asks again for a new day)", async () => {
    const h = harness();
    await h.say('h_dean', '@trav where should the 6 of us eat tonight');
    await h.say('h_dean', '@trav casual');
    const tmr = await h.say('h_dean', '@trav where should we eat tomorrow');
    expect(tmr.note).toBe('suggest:question');
    expect(texts(tmr)).toEqual(['fancy or casual tomorrow?']);
  });

  it('an unanswered question is never asked twice: the next ask gets the middle', async () => {
    const h = harness();
    await h.say('h_dean', '@trav where should the 6 of us eat tonight');
    const r = await h.say('h_piotr', '@trav where should we eat tonight');
    expect(r.note).toBe('suggest:places');
    expect(text(r)).not.toContain('fancy or casual');
    for (const l of levelsIn(text(r))) expect([2, 3]).toContain(l);
  });

  it('a quote-reply to the question binds without @trav; a reply to something else does not', async () => {
    const h = harness();
    const q = await h.say('h_dean', '@trav where should the 6 of us eat tonight');
    const qid = q.outbound[0]!.id;
    const other = await h.say('h_chase', '@trav fancy', { replyToMessageId: 'msg_something_else' });
    expect(other.note).not.toBe('suggest:answered');
    const r = await h.say('h_chase', 'fancy pls', { replyToMessageId: qid });
    expect(r.note).toBe('suggest:answered');
    expect(text(r)).toMatch(/^fancy it is\./);
    for (const l of levelsIn(text(r).replace(/^fancy it is\. /, '')))
      expect(l).toBeGreaterThanOrEqual(3);
  });

  it('the question expires: an answer 31 minutes later is not taken as one', async () => {
    const h = harness();
    await h.say('h_dean', '@trav where should the 6 of us eat tonight');
    h.clock.advanceMs(31 * 60_000);
    const r = await h.say('h_chase', '@trav casual');
    expect(r.note).not.toBe('suggest:answered');
    expect(h.runtime.groupMemory.recall(G).map((f) => f.text)).not.toContain(
      tiers.formatVibeFact('budget', today(h)),
    );
    // And the same day never gets the question again (VOICE §4.11).
    const later = await h.say('h_piotr', '@trav where should we eat tonight');
    expect(later.note).toBe('suggest:places');
    expect(text(later)).not.toContain('fancy or casual');
  });
});

// ---------- who's going ----------

describe('the people going, leaning to the most budget-conscious', () => {
  it("a member who's out tonight doesn't shape tonight's list", async () => {
    // Henry's own figure (€80 a day, mid) is the only signal anyone has.
    const withHenry = harness();
    await withHenry.dm('h_henry', HENRY_DM);
    expect((await withHenry.say('h_dean', '@trav where should we eat tonight')).note).toBe(
      'suggest:places',
    );

    const without = harness();
    await without.dm('h_henry', HENRY_DM);
    without.runtime.stores.group.trips.setAttendance({
      activityId: BARCELONA.razzmatazzActivityId,
      memberId: 'mem_henry',
      status: 'out',
      updatedAt: without.clock.now(),
      sourceMessageId: 'msg_prior',
      setBy: 'mem_henry',
    });
    // Nobody going has a signal: one question instead of a guess.
    expect((await without.say('h_dean', '@trav where should we eat tonight')).note).toBe(
      'suggest:question',
    );
  });

  it('a mixed group aims at the lowest tier with one step-up option', async () => {
    const fx = loadTierFixture('barcelona-high');
    const budget = loadTierFixture('barcelona-budget');
    // Dean and Chase on the budget routing; the rest on the high-end one.
    const travel = [
      ...fx.travel.filter(
        (t) => t.kind === 'flight' && t.memberId !== 'mem_dean' && t.memberId !== 'mem_chase',
      ),
      ...budget.travel.filter(
        (t) => t.kind === 'flight' && (t.memberId === 'mem_dean' || t.memberId === 'mem_chase'),
      ),
    ];
    const h = harness({ runtime: { travelFacts: () => travel } });
    const r = await h.say('h_piotr', '@trav where should we eat tonight');
    expect(r.note).toBe('suggest:places');
    const lines = text(r).split('\n').slice(1);
    const levels = levelsIn(text(r));
    expect(levels.slice(0, -1).every((l) => l <= 2)).toBe(true);
    expect(lines.at(-1)).toMatch(/a step up$/);
    // Nobody is named next to a price.
    for (const m of membersOf(h)) expect(text(r)).not.toContain(m.displayName);
  });

  it('a bar ask with a minor going gets food instead, nothing adults-only (SAFETY minors)', async () => {
    const h = harness();
    const crowley = h.runtime.stores.group.members.get('mem_crowley')!;
    h.runtime.stores.group.members.upsert({
      ...crowley,
      birthDate: '2012-02-01',
      ageBand: 'under18',
    });
    const bars = CATALOG.places.filter((p) => p.adultsOnly).map((p) => p.name);
    // A bar ask: the minors screen answers before any suggestion.
    const r = await h.say('h_dean', '@trav any good bars tonight, keep it cheap');
    expect(r.note).toBe('refusal:minor_nightlife');
    for (const b of bars) expect(text(r)).not.toContain(b);
    // Food and things to do: never an adults-only place in the list.
    for (const ask of [
      '@trav where should we eat tonight, keep it cheap',
      '@trav things to do tonight, somewhere nice',
    ]) {
      const s = await h.say('h_dean', ask);
      expect(s.note).toBe('suggest:places');
      for (const b of bars) expect(text(s)).not.toContain(b);
    }
  });

  it('the suggestion flow itself never lists a bar for someone of unknown age', async () => {
    const h = harness();
    const crowley = h.runtime.stores.group.members.get('mem_crowley')!;
    const { birthDate: _drop, ...rest } = crowley;
    h.runtime.stores.group.members.upsert({ ...rest, ageBand: 'unknown' });
    const r = await h.say('h_dean', '@trav any good bars tonight, keep it cheap');
    const bars = CATALOG.places.filter((p) => p.adultsOnly).map((p) => p.name);
    for (const b of bars) expect(text(r)).not.toContain(b);
    expect(r.note).toBe('suggest:places');
    expect(text(r).startsWith('food for everyone tonight:\n')).toBe(true);
  });
});

// ---------- T-167 r1 (tasks/reviews/T-167-r1.md) ----------

function makeMinor(h: Harness, memberId = 'mem_crowley'): void {
  const m = h.runtime.stores.group.members.get(memberId)!;
  h.runtime.stores.group.members.upsert({ ...m, birthDate: '2012-02-01', ageBand: 'under18' });
}

function markOutTonight(h: Harness, memberId: string): void {
  h.runtime.stores.group.trips.setAttendance({
    activityId: BARCELONA.razzmatazzActivityId,
    memberId,
    status: 'out',
    updatedAt: h.clock.now(),
    sourceMessageId: 'msg_prior',
    setBy: memberId,
  });
}

/** A catalog place a minor must never be shown (tags, adults-only, or its own words). */
function restrictedForMinors(p: (typeof CATALOG.places)[number]): boolean {
  return (
    p.adultsOnly ||
    /\b(?:vermut|vermouth|wine|beers?|cocktails?|champagne|cava|bar|bodega)\b/i.test(
      `${p.kind} ${p.name}`,
    ) ||
    safety.isRestrictedContent(p.tags as ContentTag[]) ||
    safety.isRestrictedText(`${p.kind} ${p.name}`)
  );
}

describe('r1 #1: nothing alcohol-led is listed with a minor going', () => {
  it('Bodega La Fusta (tapas and vermut) is tagged alcohol', () => {
    const fusta = CATALOG.places.find((p) => p.placeId === 'pl_bcn_la_fusta')!;
    expect(fusta.tags).toContain('alcohol');
  });

  it('every catalog entry: a restricted one never shows with a minor going, at any price level', async () => {
    const h = harness();
    makeMinor(h);
    const listed = new Set<string>();
    const asks = [
      '@trav cheap eats tonight',
      '@trav where should we eat tonight, nothing too fancy',
      '@trav somewhere nice for dinner tonight',
      '@trav dinner spot under 30 a head tonight',
      '@trav cheap things to do tonight',
      '@trav things to do tonight, nothing too fancy',
      '@trav things to do tonight, somewhere nice',
    ];
    for (const ask of asks) {
      const r = await h.say('h_dean', ask);
      expect(r.silent, ask).toBe(false);
      for (const p of CATALOG.places) if (text(r).includes(p.name)) listed.add(p.placeId);
    }
    expect(listed.size).toBeGreaterThan(6);
    for (const p of CATALOG.places) {
      if (restrictedForMinors(p)) expect(listed.has(p.placeId), p.name).toBe(false);
    }
  });
});

describe('r1 #2: family mode is cautious in the group, and no turn goes silent', () => {
  it.each([
    '@trav vermouth spots tonight',
    '@trav drinks tips tonight',
    '@trav any good bars tonight',
  ])('a minor out tonight, then %s: food for everyone, never silent, never a bar', async (ask) => {
    const h = harness();
    makeMinor(h);
    markOutTonight(h, 'mem_crowley');
    const r = await h.say('h_dean', ask);
    expect(r.silent).toBe(false);
    if (r.note === 'suggest:question') {
      const a = await h.say('h_chase', '@trav casual');
      expect(a.silent).toBe(false);
      expect(a.note).toBe('suggest:answered');
      for (const p of CATALOG.places.filter(restrictedForMinors)) {
        expect(text(a)).not.toContain(p.name);
      }
    } else {
      expect(r.note).toMatch(/^suggest:places|^refusal:/);
      for (const p of CATALOG.places.filter(restrictedForMinors)) {
        expect(text(r)).not.toContain(p.name);
      }
    }
  });

  it('a minor asking for bars in their own DM gets food for everyone, not silence', async () => {
    const h = harness();
    makeMinor(h);
    const r = await h.dm('h_crowley', 'any good bars tonight');
    expect(r.silent).toBe(false);
    const all = [r];
    if (r.note === 'suggest:question') all.push(await h.dm('h_crowley', 'casual'));
    for (const t of all) {
      expect(t.silent).toBe(false);
      for (const p of CATALOG.places.filter(restrictedForMinors))
        expect(text(t)).not.toContain(p.name);
    }
    expect(all.at(-1)!.note).toMatch(/^suggest:(?:places|answered)$/);
    expect(text(all.at(-1)!)).toContain('food for everyone tonight:');
  });

  it('the redirect is decided before the question: the question is about food, and the answer lands', async () => {
    const h = harness();
    makeMinor(h);
    markOutTonight(h, 'mem_crowley');
    const q = await h.say('h_dean', '@trav vermouth spots tonight');
    expect(q.note).toBe('suggest:question');
    const a = await h.say('h_dean', '@trav fancy');
    expect(a.silent).toBe(false);
    expect(text(a)).toMatch(/^fancy it is\. food for everyone tonight:\n/);
  });
});

describe('r1 #3: offhand words in unaddressed chat are not stated wants', () => {
  it('"is the dress code casual?" and "flights were cheap lol" never override a high-end trip', async () => {
    const { h } = withFixture('barcelona-high');
    for (const [who, t] of [
      ['h_dean', 'is the dress code casual?'],
      ['h_chase', 'flights were cheap lol'],
      ['h_piotr', 'casual'],
    ] as const) {
      expect((await h.say(who, t)).silent).toBe(true);
    }
    const r = await h.say('h_arjun', '@trav where should we eat tonight');
    expect(r.note).toBe('suggest:places');
    for (const l of levelsIn(text(r))) expect(l).toBeGreaterThanOrEqual(3);
  });

  it('"anyone fancy a swim?" does not suppress the question', async () => {
    const h = harness();
    await h.say('h_chase', 'anyone fancy a swim?');
    const r = await h.say('h_dean', '@trav where should we eat tonight');
    expect(r.note).toBe('suggest:question');
  });

  it('a line clearly about spending still counts ("can we keep it cheap tonight")', async () => {
    const h = harness();
    await h.say('h_piotr', 'can we keep it cheap tonight, money is tight');
    const r = await h.say('h_dean', '@trav where should we eat tonight');
    expect(r.note).toBe('suggest:places');
    for (const l of levelsIn(text(r))) expect(l).toBeLessThanOrEqual(2);
  });
});

describe('r2 #1: an adult DM in a family-mode group is cautious too, and never silent', () => {
  it.each([
    ['any good bars tonight', 'casual'],
    ['any good bars tonight, casual', undefined],
  ])('Dean DMs %s: food for everyone, sent', async (ask, answer) => {
    const h = harness();
    makeMinor(h);
    const all = [await h.dm('h_dean', ask)];
    if (all[0]!.note === 'suggest:question' && answer !== undefined)
      all.push(await h.dm('h_dean', answer));
    const last = all.at(-1)!;
    for (const t of all) expect(t.silent).toBe(false);
    expect(last.note).toMatch(/^suggest:(?:places|answered)$/);
    expect(text(last)).toContain('food for everyone tonight:');
    for (const p of CATALOG.places.filter(restrictedForMinors))
      expect(text(last)).not.toContain(p.name);
  });
});

describe('r2 #2: questions and look-backs are never stated wants', () => {
  it.each([
    "can't believe how much money we spent at that fancy place last night",
    '@trav is dinner tonight fancy? what should i wear',
  ])('a fresh group, then "%s": the question still fires', async (line) => {
    const h = harness();
    await h.say('h_chase', line);
    const r = await h.say('h_dean', '@trav where should we eat tonight');
    expect(r.note).toBe('suggest:question');
  });

  it.each(['@trav is the dress code casual at razzmatazz?', 'is that place expensive or casual?'])(
    'a high-end trip, then "%s": still high-end places',
    async (line) => {
      const { h } = withFixture('barcelona-high');
      await h.say('h_dean', line);
      const r = await h.say('h_arjun', '@trav where should we eat tonight');
      expect(r.note).toBe('suggest:places');
      for (const l of levelsIn(text(r))) expect(l).toBeGreaterThanOrEqual(3);
    },
  );

  it('"can we keep it cheap tonight?" is still a want', async () => {
    const h = harness();
    await h.say('h_piotr', 'can we keep it cheap tonight?');
    const r = await h.say('h_dean', '@trav where should we eat tonight');
    expect(r.note).toBe('suggest:places');
    for (const l of levelsIn(text(r))) expect(l).toBeLessThanOrEqual(2);
  });
});

describe('r1 #4: a suggestion ask is not a standing signal', () => {
  it('"@trav cheap eats tonight" does not decide tomorrow', async () => {
    const h = harness();
    expect((await h.say('h_dean', '@trav cheap eats tonight')).note).toBe('suggest:places');
    const tmr = await h.say('h_dean', '@trav where should we eat tomorrow');
    expect(tmr.note).toBe('suggest:question');
  });
});

describe('r1 #5: a bare "nice" is not a vibe answer', () => {
  it('"nice" answers nothing; "something nice" still means fancy', async () => {
    expect(tiers.vibeAnswer('nice')).toBeUndefined();
    expect(tiers.vibeAnswer('nice!')).toBeUndefined();
    expect(tiers.vibeAnswer('something nice')).toBe('high');
    const h = harness();
    await h.say('h_dean', '@trav where should the 6 of us eat tonight');
    expect((await h.say('h_chase', '@trav nice')).note).not.toBe('suggest:answered');
  });
});

describe('r1 #6: an open booking proposal only takes messages that bind to it', () => {
  it('a suggestion ask while a Razzmatazz card is open is still a suggestion', async () => {
    const h = harness();
    const card = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(h.pending()).toHaveLength(1);
    const r = await h.say('h_chase', '@trav where should we eat before, cheap eats');
    expect(r.note).toBe('suggest:places');
    expect(h.pending()).toHaveLength(1);
    // A quote-reply to the card is about the booking, not a suggestion.
    const bound = await h.say('h_chase', '@trav any cheap eats nearby?', {
      replyToMessageId: card.outbound[0]!.id,
    });
    expect(bound.note ?? '').not.toMatch(/^suggest:/);
  });
});

// ---------- privacy and framing ----------

describe('private budgets never appear in group text', () => {
  it("Henry's figure shapes the group list without ever being said; his DM says it to him only", async () => {
    const h = harness();
    await h.dm('h_henry', HENRY_DM);
    const groupAsks = [
      '@trav where should we eat tonight',
      '@trav any good bars tonight',
      '@trav things to do tomorrow, somewhere nice',
    ];
    for (const ask of groupAsks) {
      const r = await h.say('h_henry', ask);
      expect(r.note).toMatch(/^suggest:/);
      const t = text(r).toLowerCase();
      for (const s of ['80', 'a day', 'your', 'budget', 'henry', 'tight', 'semester']) {
        expect(t).not.toContain(s);
      }
      for (const o of r.outbound) {
        if (!isReaction(o)) expect(o.to).toEqual({ kind: 'group' });
      }
    }
    // In Henry's own DM his figure orders the list: what fits it first.
    const dm = await h.dm('h_henry', 'things to do tomorrow, somewhere nice');
    expect(dm.note).toBe('suggest:places');
    expect(dm.outbound[0]!.to).toEqual({ kind: 'member', memberId: 'mem_henry' });
    // Someone else's DM never sees it.
    const chase = await h.dm('h_chase', 'things to do tomorrow, somewhere nice');
    expect(text(chase)).not.toContain('€80');
    expect(text(chase)).not.toContain('over your');
  });

  it('in their own DM, a member is told what is over their figure, and nothing is dropped', async () => {
    const h = harness();
    await h.dm('h_dean', 'my budget is €10 a day');
    const dm = await h.dm('h_dean', 'somewhere nice for dinner tonight');
    expect(dm.note).toBe('suggest:places');
    const lines = text(dm).split('\n').slice(1);
    expect(lines[0]).toContain('Forn de Sant Pau');
    expect(lines[0]).not.toContain('over your');
    expect(lines.slice(1).every((l) => l.includes('over your €10 a day'))).toBe(true);
    // The over-figure places are still the fancy ones that were asked for.
    expect(
      levelsIn(text(dm))
        .slice(1)
        .every((l) => l >= 3),
    ).toBe(true);
    // The same ask in the group: no figure, no "over".
    const g = await h.say('h_dean', '@trav somewhere nice for dinner tonight');
    expect(text(g)).not.toMatch(/over|€10/);
  });

  it("a DM answer is kept in the member's own memory, never the group's", async () => {
    const h = harness();
    expect((await h.dm('h_henry', 'where should i eat tonight')).note).toBe('suggest:question');
    const a = await h.dm('h_henry', 'casual');
    expect(a.note).toBe('suggest:answered');
    const fact = tiers.formatVibeFact('budget', today(h));
    expect(h.runtime.groupMemory.recall(G).map((f) => f.text)).not.toContain(fact);
    expect(h.runtime.memberMemory.recall('mem_henry', G).map((f) => f.text)).toContain(fact);
    // The group still gets its own question.
    expect((await h.say('h_dean', '@trav where should we eat tonight')).note).toBe(
      'suggest:question',
    );
  });

  it('no tier is ever said about anyone, across every fixture and ask', async () => {
    for (const name of ['barcelona-high', 'barcelona-budget', 'barcelona-mixed']) {
      const { h } = withFixture(name);
      await h.dm('h_henry', HENRY_DM);
      for (const ask of [
        '@trav where should we eat tonight',
        '@trav casual',
        '@trav any good bars tonight',
        '@trav things to do tomorrow',
        '@trav cheap eats for lunch tomorrow',
      ]) {
        const r = await h.say('h_arjun', ask);
        expect(text(r)).not.toMatch(JUDGEMENT);
      }
    }
  });
});

// ---------- soft, never a gate ----------

describe('no budget ever blocks a booking', () => {
  async function razz(prep: (h: Harness) => Promise<void>): Promise<{
    note: string | undefined;
    attendees: readonly string[] | undefined;
    amount: number | undefined;
    bookings: number;
    audit: string[];
    text: string;
  }> {
    const h = harness();
    await prep(h);
    const auditBefore = h.auditTypes().length;
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    const p = h.pending().at(-1);
    return {
      note: turn.note,
      attendees: p?.attendees,
      amount: p?.totalMinor,
      bookings: h.runtime.stores.group.bookings.listByTrip(BARCELONA.tripId).length,
      audit: h.auditTypes().slice(auditBefore),
      text: text(turn),
    };
  }

  it('Henry\'s private figure, "keep it cheap", a casual answer and a budget trip change nothing about Razzmatazz', async () => {
    const base = await razz(() => Promise.resolve());
    const loaded = await razz(async (h) => {
      await h.dm('h_henry', HENRY_DM);
      await h.dm('h_dean', 'my budget is €20 a day');
      await h.say('h_piotr', 'can we keep it cheap this trip');
      await h.say('h_dean', '@trav where should the 6 of us eat tonight');
      await h.say('h_chase', '@trav casual');
    });
    expect(base.note).toBeDefined();
    expect(loaded.note).toBe(base.note);
    expect(loaded.attendees).toEqual(base.attendees);
    expect(loaded.amount).toBe(base.amount);
    expect(loaded.bookings).toBe(base.bookings);
    expect(loaded.audit).toEqual(base.audit);
    expect(base.audit.some((t) => t.startsWith('policy.'))).toBe(true);
    // Nothing in the booking reply mentions a budget.
    expect(loaded.text.toLowerCase()).not.toMatch(/budget|over your|€20|€80/);
  });

  it('a suggestion turn never books, holds or proposes anything', async () => {
    const { h } = withFixture('barcelona-high');
    const auditBefore = h.auditTypes().length;
    for (const ask of [
      '@trav where should we eat tonight',
      '@trav things to do tomorrow, somewhere nice',
    ]) {
      const r = await h.say('h_dean', ask);
      expect(r.toolCalls).toEqual([]);
    }
    expect(h.pending()).toEqual([]);
    const moneyEvents = h
      .auditTypes()
      .slice(auditBefore)
      .filter((t) => t.startsWith('booking.') || t.startsWith('policy.'));
    expect(moneyEvents).toEqual([]);
    expect(h.tickets.purchaseCount()).toBe(0);
  });
});
