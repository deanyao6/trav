/**
 * T-173 round 2: every repro from `tasks/reviews/T-173-r1.md`. Precision
 * first and fail closed: a wording the reader can't fully account for is no
 * ask, never the whole group or a shorter list.
 */
import { describe, expect, it } from 'vitest';
import { loadAllTicketInventories } from '@trav/adapters';
import { parseBookingRequest, venueIndexFrom, type BookingRequest } from './request.js';

const INDEX = venueIndexFrom(loadAllTicketInventories());
const BCN = ['Dean', 'Henry', 'Chase', 'Piotr', 'Arjun', 'Crowley'] as const;
const plain = (text: string, sender = 'Dean') => parseBookingRequest(text, INDEX, sender);
const roster = (text: string, sender = 'Dean') =>
  parseBookingRequest(text, INDEX, sender, { roster: BCN });
const both = (text: string, sender = 'Dean') => [plain(text, sender), roster(text, sender)];

/** Who the proposal service would book from this reading (lowercase), or undefined for no ask. */
function bookedFor(r: BookingRequest | undefined): string[] | undefined {
  if (r === undefined) return undefined;
  const out = new Set(r.excludedNames.map((n) => n.toLowerCase()));
  const base = r.attendeeNames ?? BCN;
  return base.map((n) => n.toLowerCase()).filter((n) => !out.has(n));
}

describe('r1 #2: an exclusion wording never leaves the excluded member in', () => {
  it.each([
    'get razz tickets for everyone but @henry',
    'get razz tickets for everyone except (henry)',
    'get razz tickets for everyone except, well, henry',
    'get razz tickets for everyone except him',
    'get razz tickets for everyone except the sick one',
    'get razz tickets for the whole group not henry',
    'get razz tickets for everyone, henry excluded',
    'get razz tickets for everyone excl henry',
    'get razz tickets for everyone excl. henry',
    'get razz tickets for everyone w/o henry',
    'get razz tickets for everyone excepting henry',
    'get razz tickets for everyone with the exception of henry',
    'get razz tickets for everyone outside of henry',
    'get razz tickets for everyone, no henry',
    'get razz tickets for everyone, skip henry',
    'get razz tickets for everyone, just not henry',
    'get razz tickets for everyone, henry stays home',
    'get razz tickets for everyone. none for henry',
  ])('%s', (text) => {
    for (const r of both(text)) expect(bookedFor(r) ?? [], text).not.toContain('henry');
  });

  it.each([
    // Wordings no rule knows: the roster net (a member named but not accounted for).
    'get razz tickets for everyone, henry gets nothing',
    'get razz tickets for everyone, henry nah',
    'get razz tickets for everyone, henry is off the list',
  ])('roster net: %s', (text) => {
    expect(roster(text), text).toBeUndefined();
  });

  it('the readable ones exclude Henry exactly', () => {
    for (const text of [
      'get razz tickets for everyone but @henry',
      'get razz tickets for everyone except (henry)',
      'get razz tickets for everyone except, well, henry',
      'get razz tickets for everyone excl. henry',
      'get razz tickets for everyone w/o henry',
      'get razz tickets for everyone with the exception of henry',
      'get razz tickets for everyone, no henry',
      'get razz tickets for everyone, henry stays home',
      'get razz tickets for everyone. none for henry',
    ]) {
      for (const r of both(text)) {
        expect(r?.excludedNames, text).toEqual(['Henry']);
        expect(r?.attendeeNames, text).toBeUndefined();
      }
    }
  });

  it('an exclusion that names no one readable is no ask', () => {
    for (const text of [
      'get razz tickets for everyone except him',
      'get razz tickets for everyone except the sick one',
      'get razz tickets for everyone except henry and the kids',
    ]) {
      for (const r of both(text)) expect(r, text).toBeUndefined();
    }
  });
});

describe('r1 #3: a multi-name exclusion keeps every name', () => {
  it.each([
    ['get razz tickets for everyone except henry, chase and piotr', ['Henry', 'Chase', 'Piotr']],
    ['get razz tickets for everyone except henry/chase', ['Henry', 'Chase']],
    ['get razz tickets for everyone except henry + chase', ['Henry', 'Chase']],
    ['get razz tickets for the whole group except henry, chase', ['Henry', 'Chase']],
    ['get razz tickets for everyone but henry & chase', ['Henry', 'Chase']],
  ] as const)('%s', (text, out) => {
    for (const r of both(text)) {
      expect(r?.excludedNames, text).toEqual(out);
      expect(r?.attendeeNames, text).toBeUndefined();
    }
  });

  it('a new clause after the list ends it', () => {
    expect(roster('get razz tickets for everyone except henry, chase is driving')).toBeUndefined();
    expect(roster("get razz tickets for everyone except henry, he's sick")?.excludedNames).toEqual([
      'Henry',
    ]);
  });
});

describe('r1 #4: a named party is that party, never the whole group or a shorter list', () => {
  it.each([
    ['get razz tickets for @chase and @crowley', ['Chase', 'Crowley']],
    ['get razz tickets for @chase, @crowley and me', ['Dean', 'Chase', 'Crowley']],
    ['get razz tickets for chase/crowley/me', ['Dean', 'Chase', 'Crowley']],
    [
      'get razz tickets for me chase piotr arjun and crowley',
      ['Dean', 'Chase', 'Piotr', 'Arjun', 'Crowley'],
    ],
  ] as const)('%s', (text, names) => {
    expect(roster(text)?.attendeeNames, text).toEqual(names);
    const p = plain(text);
    if (p !== undefined) expect(p.attendeeNames, text).toEqual(names);
  });

  it('flagship with "@henry\'s sick" excludes Henry', () => {
    for (const r of both("get the 5 of us Razzmatazz tickets, @henry's sick")) {
      expect(r).toMatchObject({ quantity: 5, excludedNames: ['Henry'] });
    }
  });

  it('a member as the object of the buy verb, or a possessive in the list: never the whole group', () => {
    for (const text of [
      'get chase razz tickets',
      'get chase and piotr razz tickets',
      "get razz tickets for henry's friend and me",
    ]) {
      for (const r of both(text)) {
        const who = bookedFor(r);
        if (who !== undefined) expect(who.length, text).toBeLessThan(6);
      }
    }
    expect(roster('get chase razz tickets')?.attendeeNames ?? ['Chase']).toEqual(['Chase']);
    expect(roster("get razz tickets for henry's friend and me")).toBeUndefined();
    expect(plain("get razz tickets for henry's friend and me")).toBeUndefined();
  });
});

describe('r1 #5: handoffs, instructions, hypotheticals and polls are never asks', () => {
  it.each([
    'we need razz tickets tonight, crowley will get them',
    'razz tickets for all of us, crowley handled it',
    'get razz tickets for everyone, crowley will pay',
    "get razz tickets for everyone, i'll do it",
    "get razz tickets for everyone, i'll sort it",
    "get razz tickets for everyone, i'll handle it",
    'get razz tickets for everyone, leave it to me',
    'get razz tickets for everyone, leave it with crowley',
    'crowley go get razz tickets for everyone',
    'crowley get razz tickets for everyone',
    'dean should get razz tickets for everyone',
    'can someone get razz tickets for all of us',
    'crowley said get razz tickets for everyone',
    'henry said trav get razz tickets for everyone',
    "i'd get razz tickets for everyone",
    'i would get razz tickets for all of us',
    'i may get razz tickets for everyone',
    'prob get razz tickets for everyone',
    'thinking we get razz tickets for everyone',
    "in the past we'd get razz tickets for everyone",
    'we should get razz tickets for everyone',
    'get razz tickets at the door for everyone',
    'get razz tickets for everyone, thoughts?',
    'get razz tickets for everyone, yes or no',
    'get razz tickets for everyone, vote',
    'vote: get razz tickets for everyone',
    // The generic rules, on wordings not in the review.
    'piotr could grab razz tickets for all of us',
    'somebody book razz for everyone',
    'arjun will book razz for all of us',
    'we might get razz tickets for everyone',
  ])('%s', (text) => {
    for (const r of both(text)) expect(r, text).toBeUndefined();
  });

  it('polite asks to Trav still are asks', () => {
    for (const text of [
      'could you get razz tickets for all of us',
      "i'd like razz tickets for all of us",
      "i'd like to get razz tickets for all of us",
      'would you book razz for everyone',
      'trav, get razz tickets for everyone',
    ]) {
      for (const r of both(text)) expect(r, text).toBeDefined();
    }
  });
});

describe('r1 #6: a cue in another clause about something else does not kill the ask', () => {
  it.each([
    "get the 5 of us Razzmatazz tickets, Henry's sick, he can't make it",
    "get the 5 of us razz tickets for tonight after dinner, Henry's sick",
    "get the 5 of us razz tickets when you get a sec, Henry's sick",
    "get the 5 of us razz tickets, Henry's sick. I can't believe it",
    "get the 5 of us razz tickets, Henry's sick, we shouldn't miss it",
    "get the 5 of us razz tickets, Henry's sick until tomorrow",
  ])('flagship tail: %s', (text) => {
    for (const r of both(text)) {
      expect(r, text).toMatchObject({ quantity: 5, excludedNames: ['Henry'] });
    }
  });

  it.each([
    "get razz tickets for all of us, but don't buy them yet",
    'get razz tickets for all of us, not yet though',
    'get razz tickets for all of us, unless henry objects',
    "if it's not sold out, get razz tickets for all of us",
    'get razz tickets for all of us after we eat',
    "get razz tickets for all of us, we can't afford vip though",
    // T-182: retraction is the default for a negation; only a small harmless
    // list (believe, wait, miss, one person's out-reason) is let through.
    "get the 5 of us razz tickets, Henry's sick, isn't that sad",
  ])('a cue that governs the buy still does: %s', (text) => {
    for (const r of both(text)) expect(r, text).toBeUndefined();
  });
});

describe('r1 #7: "already has one" in every word order', () => {
  it.each([
    ['get razz tickets for everyone, chase has one', 'Chase'],
    ['get razz tickets for everyone, henry has his own', 'Henry'],
    ['get razz tickets for everyone, henry has one already', 'Henry'],
    ['get razz tickets for everyone, chase got tickets already', 'Chase'],
    ['get razz tickets for everyone, chase is sorted', 'Chase'],
  ] as const)('%s', (text, who) => {
    for (const r of both(text)) expect(r?.excludedNames, text).toEqual([who]);
  });
});

describe('r1 #8: more ways to be sick', () => {
  it.each([
    'get the 5 of us razz tickets, Henry got sick',
    'get the 5 of us razz tickets, henry has covid',
    'get the 5 of us razz tickets, henry has a fever',
    "get the 5 of us razz tickets, henry's been sick all day",
  ])('%s', (text) => {
    for (const r of both(text)) {
      expect(r, text).toMatchObject({ quantity: 5, excludedNames: ['Henry'] });
    }
  });

  it('"chase is home sick" never keeps Chase in', () => {
    for (const r of both('get razz tickets for everyone, chase is home sick')) {
      expect(bookedFor(r) ?? [], 'home sick').not.toContain('chase');
    }
    expect(roster('get razz tickets for everyone, chase is home sick')?.excludedNames).toEqual([
      'Chase',
    ]);
  });
});

describe('r1 #9: a verb after "but" is never a name', () => {
  it('"but leave out henry" excludes Henry only', () => {
    for (const r of both('get razz tickets for everyone but leave out henry')) {
      expect(r?.excludedNames).toEqual(['Henry']);
    }
    for (const r of both('get razz tickets for everyone but skip henry')) {
      expect(r?.excludedNames).toEqual(['Henry']);
    }
  });
});

describe('the roster net: a member named in an ask is always accounted for', () => {
  it('inclusions and the sender are fine', () => {
    expect(roster("all 6, henry's back. razzmatazz")).toMatchObject({ quantity: 6 });
    expect(roster('get razz tickets for everyone, henry too')?.excludedNames).toEqual([]);
    expect(roster('get razz tickets for everyone including henry')?.excludedNames).toEqual([]);
  });

  it('a member mentioned for an unread reason is no ask', () => {
    for (const text of [
      'get razz tickets for everyone, henry is being weird',
      'get razz tickets for chase and me, piotr maybe',
      'get razz tickets for everyone, put it on piotr',
    ]) {
      expect(roster(text), text).toBeUndefined();
    }
  });
});

describe('round-2 sweep and probe regressions', () => {
  it('a bare-space list never swallows a non-name ("… and dean into razzmatazz")', () => {
    expect(
      plain('@trav book me, crowley, chase, piotr and dean into razzmatazz tonight')?.attendeeNames,
    ).toEqual(['Dean', 'Crowley', 'Chase', 'Piotr']);
  });

  it('plain mode: "no purchase" excludes no one', () => {
    expect(
      plain("get the 5 of us Razzmatazz tickets, Henry's sick, no purchase")?.excludedNames,
    ).toEqual(['Henry']);
  });

  it('the sender prefix is the sender, not an unaccounted member', () => {
    expect(roster("Dean: @trav get the 5 of us Razzmatazz tickets, Henry's sick")).toMatchObject({
      quantity: 5,
      excludedNames: ['Henry'],
    });
  });

  it('a delivered ticket ("everyone got their own") is no ask; a verbless count still is', () => {
    const delivered =
      "your razzmatazz ticket for tonight 🎟️\ndoors 12am · Carrer dels Almogàvers 122\nthis one's yours only, don't forward it. everyone got their own";
    for (const r of both(delivered)) expect(r).toBeUndefined();
    for (const r of both('@trav sporting vs braga tonight? 2 tickets')) {
      expect(r).toMatchObject({ quantity: 2 });
    }
    for (const r of both("all 6, henry's back. razzmatazz"))
      expect(r).toMatchObject({ quantity: 6 });
  });

  it('a vocative after "@trav" is still another member told to buy', () => {
    for (const r of both('@trav crowley, get razz tickets for everyone')) expect(r).toBeUndefined();
  });

  it('a weak connective right after the group must resolve ("everyone, minus the birthday boy")', () => {
    for (const text of [
      'get razz tickets for everyone, minus the birthday boy',
      "get razz tickets for all of us bar the one who's sick",
    ]) {
      for (const r of both(text)) expect(r, text).toBeUndefined();
    }
    for (const text of [
      'get razz tickets for us, no vip',
      'get razz tickets for us but not tonight',
    ]) {
      for (const r of both(text)) expect(r?.excludedNames, text).toEqual([]);
    }
    for (const r of both("get razz tickets for everyone 'cept henry")) {
      expect(r?.excludedNames).toEqual(['Henry']);
    }
  });

  it('roster mode: odd exclusion wordings never keep Henry in', () => {
    for (const text of [
      "get razz tickets for everyone, henry's a no",
      "get razz tickets for everyone, henry's out of it",
      'get razz tickets for everyone not named henry',
      'get razz tickets for everyone xcept henry',
      'get razz tickets for everyone sauf henry',
      'get razz tickets for everyone. henry: out',
    ]) {
      expect(bookedFor(roster(text)) ?? [], text).not.toContain('henry');
    }
  });

  it('inclusions keep the member in', () => {
    for (const text of [
      'get razz tickets for everyone, henry included',
      'get razz tickets for everyone and henry too',
      'get razz tickets for everyone, even henry',
      "henry's in, get razz tickets for everyone",
    ]) {
      expect(roster(text)?.excludedNames, text).toEqual([]);
    }
  });
});
