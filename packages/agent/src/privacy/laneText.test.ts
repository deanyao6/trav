import { describe, expect, it } from 'vitest';
import {
  createLaneTextGuard,
  MAX_PRIVATE_TEXTS,
  REDACTED,
  stringLeaves,
  tokenize,
} from './laneText.js';

const G = 'grp_test';
const HENRY = "can you keep my share under 80 a day? money's tight this semester";

function guard(extra: { ownerId: string; text: string }[] = []) {
  const g = createLaneTextGuard({ extraPrivate: () => extra });
  return g;
}

describe('lane text guard (T-213)', () => {
  it('tokenizes with offsets and folds case, accents and apostrophes', () => {
    const t = tokenize('Money’s tight at Barça!');
    expect(t.map((x) => x.norm)).toEqual(['moneys', 'tight', 'at', 'barca']);
    expect('Money’s tight at Barça!'.slice(t[3]!.start, t[3]!.end)).toBe('Barça');
  });

  it("finds a DM's phrases in other text, with the owner, and redacts them", () => {
    const g = guard();
    g.notePrivate(G, 'mem_henry', HENRY);
    for (const leak of [
      "henry's money's tight",
      'keep it under €80 a day',
      'MONEY’S TIGHT THIS SEMESTER',
      'he wants to keep my share low',
    ]) {
      const spans = g.leaks(G, leak);
      expect(spans.length, leak).toBeGreaterThan(0);
      expect(spans[0]!.ownerIds).toEqual(['mem_henry']);
    }
    expect(g.redact(G, 'heads up: money’s tight this semester for him')).toBe(
      `heads up: ${REDACTED} for him`,
    );
  });

  it('never matches on function words, single words, or words the DM does not pair', () => {
    const g = guard();
    g.notePrivate(G, 'mem_henry', HENRY);
    for (const ok of [
      'can you keep a table for us',
      'tight',
      'the day after',
      'under the €500 day budget',
      'a semester abroad',
      'is it tight?',
    ]) {
      expect(g.leaks(G, ok), ok).toEqual([]);
    }
  });

  it('anything said in the group thread is public and never matches', () => {
    const g = guard();
    g.notePrivate(G, 'mem_henry', HENRY);
    expect(g.leaks(G, "money's tight").length).toBe(1);
    g.notePublic(G, "lol money's tight for all of us");
    expect(g.leaks(G, "money's tight")).toEqual([]);
    // The rest of the DM is still private.
    expect(g.leaks(G, 'under 80 a day').length).toBe(1);
  });

  it('is per group', () => {
    const g = guard();
    g.notePrivate(G, 'mem_henry', HENRY);
    expect(g.leaks('grp_other', "money's tight")).toEqual([]);
  });

  it('reads extra private texts (private notes) at check time', () => {
    const extra: { ownerId: string; text: string }[] = [];
    const g = guard(extra);
    expect(g.leaks(G, 'arjun is vegetarian')).toEqual([]);
    extra.push({ ownerId: 'mem_arjun', text: 'arjun is vegetarian' });
    expect(g.leaks(G, 'remember arjun is vegetarian')[0]?.ownerIds).toEqual(['mem_arjun']);
  });

  it('merges overlapping phrases into one span, owners combined', () => {
    const g = guard();
    g.notePrivate(G, 'mem_henry', HENRY);
    g.notePrivate(G, 'mem_chase', 'my share under 80 please');
    const spans = g.leaks(G, 'x keep my share under 80 a day y');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.ownerIds).toEqual(['mem_chase', 'mem_henry']);
    expect(g.redact(G, 'x keep my share under 80 a day y')).toBe(`x ${REDACTED} y`);
  });

  it('redactDeep redacts every string and leaves the rest', () => {
    const g = guard();
    g.notePrivate(G, 'mem_henry', HENRY);
    const v = { a: ["money's tight", 3, null], b: { c: 'fine' }, d: true };
    expect(g.redactDeep(G, v)).toEqual({ a: [REDACTED, 3, null], b: { c: 'fine' }, d: true });
    expect(v.a[0]).toBe("money's tight");
  });

  it('forgetMember drops only that member, and the cap keeps the newest texts', () => {
    const g = guard();
    g.notePrivate(G, 'mem_henry', HENRY);
    g.notePrivate(G, 'mem_arjun', "fyi i'm vegetarian, keep that in mind for dinners");
    g.forgetMember(G, 'mem_henry');
    expect(g.leaks(G, "money's tight")).toEqual([]);
    expect(g.leaks(G, 'vegetarian keep that').length).toBe(1);

    const c = guard();
    c.notePrivate(G, 'mem_henry', HENRY);
    for (let i = 0; i < MAX_PRIVATE_TEXTS; i += 1)
      c.notePrivate(G, 'mem_dean', `filler line ${String(i)}`);
    expect(c.leaks(G, "money's tight")).toEqual([]);
    expect(c.leaks(G, `filler line ${String(MAX_PRIVATE_TEXTS - 1)}`).length).toBe(1);
  });

  it('a short DM command with no content pair adds nothing', () => {
    const g = guard();
    g.notePrivate(G, 'mem_dean', 'photos on');
    expect(g.leaks(G, 'photos on for everyone')).toEqual([]);
  });

  it('stringLeaves walks nested values', () => {
    expect(stringLeaves({ a: 'x', b: [{ c: 'y' }, 2], d: null })).toEqual(['x', 'y']);
  });
});
