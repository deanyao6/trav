/**
 * T-173: booking-ask precision before T-168's auto-buy. Every repro from
 * `tasks/reviews/T-158-r2.md` (names as of T-164: Maya→Chase, Jordan→Piotr,
 * Priya→Arjun, Sam→Crowley), the SAFETY A9 exclusion-connective class, and
 * the verb "chase". Precision first: the right party, or no ask at all.
 */
import { describe, expect, it } from 'vitest';
import { loadAllTicketInventories } from '@trav/adapters';
import { parseBookingRequest, venueIndexFrom } from './request.js';

const INDEX = venueIndexFrom(loadAllTicketInventories());
const BCN = ['Dean', 'Henry', 'Chase', 'Piotr', 'Arjun', 'Crowley'] as const;
const parse = (text: string, sender = 'Dean') => parseBookingRequest(text, INDEX, sender);
const withRoster = (text: string, sender = 'Dean') =>
  parseBookingRequest(text, INDEX, sender, { roster: BCN });
const both = (text: string, sender = 'Dean') => [parse(text, sender), withRoster(text, sender)];

describe('T-158 r2 #1: a non-member in a list is kept (the service asks), never dropped', () => {
  it.each([
    ['get razz tickets for chase, zed and me', ['Dean', 'Chase', 'Zed']],
    ['get razz tickets for chase, piotr, zed', ['Chase', 'Piotr', 'Zed']],
    ['get razz tickets for me, zed and chase', ['Dean', 'Zed', 'Chase']],
    // A non-member first is not "no list" (which would be the whole group).
    ['get razz tickets for zed and chase', ['Zed', 'Chase']],
  ] as const)('%s', (text, names) => {
    expect(withRoster(text)?.attendeeNames).toEqual(names);
  });

  it('a comma into a new clause still ends the list', () => {
    expect(
      withRoster('get razz tickets for chase and crowley, henry is sick')?.attendeeNames,
    ).toEqual(['Chase', 'Crowley']);
    expect(withRoster('get razz tickets for chase and zed')).toBeUndefined();
  });
});

describe('T-158 r2 #2: a first-person soft ask is the sender alone', () => {
  it.each([
    'i need razz tickets',
    'i could use razz tickets tonight',
    'i want razz tickets please',
    'pick me up razz passes tonight',
    'hook me up with razz tickets tonight',
    'set me up with razz passes tonight',
  ])('%s', (text) => {
    for (const r of both(text, 'Arjun')) {
      expect(r?.attendeeNames, text).toEqual(['Arjun']);
      expect(r?.quantity, text).toBeUndefined();
    }
    // No sender, no one to book for.
    expect(parseBookingRequest(text, INDEX)).toBeUndefined();
  });

  it('a first-person ask that names the party keeps that party', () => {
    expect(parse('i need razz tickets for all of us')?.attendeeNames).toBeUndefined();
    expect(parse('i need razz tickets for all of us')).toBeDefined();
    expect(parse('i want razz tickets for chase and me please', 'Arjun')?.attendeeNames).toEqual([
      'Arjun',
      'Chase',
    ]);
    expect(parse('i need 5 razz tickets tonight')).toMatchObject({ quantity: 5 });
    expect(parse('i need 5 razz tickets tonight')?.attendeeNames).toBeUndefined();
    expect(parse('we need razz tickets for tonight')?.attendeeNames).toBeUndefined();
  });
});

describe('never an ask', () => {
  it.each([
    // T-158 r2 #3: another clause hands off or takes back the ask.
    "we need razz tickets tonight, crowley's buying",
    'we need razz tickets tonight, crowley is on it',
    'we need razz tickets for all of us. who wants to buy',
    'we need razz tickets tonight... not',
    'we need razz tickets tonight. or tomorrow. whatever',
    'pick up razz passes for us tonight. sarcasm',
    'get razz tickets for all of us, im on it',
    'get razz tickets for us tonight /s',
    'get razz tickets for 5 or 6 of us',
    'someone should book razz for all of us',
    // Past-tense or third-party buys, a state of the tickets.
    'crowley got razz tickets for all 6',
    'i booked razz for all 6',
    'razz tickets for all 6 are sold out',
    'we already have razz tickets for all 6',
    // Negations.
    "we can't get razz tickets for all 6",
    'we cannot get razz tickets for everyone',
    "we won't get razz tickets for all of us",
    // Conditionals.
    'get razz tickets for all 6 once henry confirms',
    'get razz tickets for all 6 when henry confirms',
    'get razz tickets for all of us unless henry objects',
    "get razz tickets for all 6 if it's not sold out",
    'get razz tickets for all of us after we eat',
    'get razz tickets for all of us later',
    // Hypotheticals.
    'the plan was to get razz tickets for everyone',
    'imagine if trav could get razz tickets for all 6',
    'we could get razz tickets for all of us',
    'worth getting razz tickets for all 6?',
    // Instructions to another member.
    'i told crowley to get razz tickets for everyone',
    'crowley, get razz tickets for everyone',
    'ask henry to book razz for all of us',
    'chase can you get razz tickets for all of us',
  ])('%s', (text) => {
    for (const r of both(text)) expect(r, text).toBeUndefined();
  });

  it('manners, fillers and "can\'t wait" are not conditions, vocatives or negations', () => {
    for (const text of [
      'ok, get razz tickets for all of us',
      'guys, get razz tickets for all of us',
      'get razz tickets for all of us if possible',
      "can't wait! get razz tickets for all of us",
      'trav, get razz tickets for all of us',
    ]) {
      for (const r of both(text)) expect(r, text).toBeDefined();
    }
  });
});

describe('the three minors', () => {
  it('r2 #4: a guess at why someone is out is not a hedge on the ask', () => {
    for (const r of both("get the 5 of us Razzmatazz tickets, Henry's sick, probably the paella")) {
      expect(r).toMatchObject({ quantity: 5, excludedNames: ['Henry'] });
      expect(JSON.stringify(r).replace(r!.requestText, '')).not.toMatch(/paella|sick/i);
    }
    // A deferral after the reason still is a hedge.
    expect(parse("get the 5 of us razz tickets, henry's sick, maybe tomorrow")).toBeUndefined();
  });

  it('r2 #5: "for chase and crowley henry sick" never makes Henry an attendee', () => {
    const text = 'get razz tickets for chase and crowley henry sick';
    for (const r of both(text)) expect(r?.attendeeNames, text).toEqual(['Chase', 'Crowley']);
    expect(withRoster(text)?.excludedNames).toEqual(['Henry']);
  });

  it('r2 #6: "crowley already has one" leaves Crowley out', () => {
    for (const r of both('get razz tickets for everyone, crowley already has one')) {
      expect(r?.excludedNames).toEqual(['Crowley']);
    }
    expect(parse("get razz tickets for all of us, henry's already got one")?.excludedNames).toEqual(
      ['Henry'],
    );
  });
});

describe('the verb "chase" is never member Chase in an ask', () => {
  it('verb uses', () => {
    // Without the roster, the verb is skipped and the ask stands.
    expect(parse("get razz tickets for everyone, i'll chase henry for it")).toMatchObject({
      excludedNames: [],
    });
    expect(
      parse('book razz for me and piotr and chase henry for his share')?.attendeeNames,
    ).toEqual(['Dean', 'Piotr']);
    // With it, Henry is named for a reason the reader can't place (the roster
    // net, T-173 r1 #2): no ask, never a guess at whether he's in.
    expect(withRoster("get razz tickets for everyone, i'll chase henry for it")).toBeUndefined();
    expect(withRoster('book razz for me and piotr and chase henry for his share')).toBeUndefined();
  });

  it('the member still reads as the member', () => {
    expect(withRoster('get razz tickets for me and chase')?.attendeeNames).toEqual([
      'Dean',
      'Chase',
    ]);
    expect(withRoster('get razz tickets for everyone but chase')?.excludedNames).toEqual(['Chase']);
    expect(withRoster('get razz tickets for dean chase piotr', 'Arjun')?.attendeeNames).toEqual([
      'Dean',
      'Chase',
      'Piotr',
    ]);
    expect(withRoster("get razz tickets for all of us, chase's sick")?.excludedNames).toEqual([
      'Chase',
    ]);
  });
});

describe('SAFETY A9: an exclusion is never read back as the party', () => {
  it.each([
    ['get the whole crew razz tickets save for henry', ['Henry']],
    ['get razz tickets for everyone save henry', ['Henry']],
    ['get everyone razz tickets bar henry', ['Henry']],
    ['get razz tickets for all of us aside from henry', ['Henry']],
    ['get razz tickets for everyone besides henry', ['Henry']],
    ['get razz tickets for all 6 apart from henry and crowley', ['Henry', 'Crowley']],
    ['get all of us razz tickets except for henry', ['Henry']],
    ['get razz tickets for the gang, except for me', ['Dean']],
    ['book razz for everyone excluding henry', ['Henry']],
    ['book razz for us all, sans henry', ['Henry']],
    // No buy verb: the whole-group word is the signal.
    ['apolo friday for the whole gang, bar crowley', ['Crowley']],
    ['razz tonight for the squad besides henry', ['Henry']],
  ] as const)('(1) a connective excludes: %s', (text, out) => {
    for (const r of both(text)) {
      expect(r?.excludedNames, text).toEqual(out);
      expect(r?.attendeeNames, text).toBeUndefined();
    }
  });

  it.each([
    // An unknown connective before "for": the whole group in words, a minority by name.
    'get the whole crew razz tickets sparing for henry',
    'get everyone razz tickets, notably for henry',
    'get the gang razz tickets, sparing for henry and chase',
    'get all 6 of us razz tickets, holding for henry',
  ])('(2) the whole group in words but a minority named: no ask: %s', (text) => {
    for (const r of both(text)) expect(r, text).toBeUndefined();
  });

  it.each([
    // A connective-like word before "for" that the reader can't turn into an
    // exclusion: never the party, and never silently ignored either.
    'get razz tickets for everyone, leaving aside for henry',
    'get razz tickets for all of us, leaving for henry',
  ])('(2) an unread connective before "for <name>": no ask: %s', (text) => {
    for (const r of both(text)) expect(r, text).toBeUndefined();
  });

  it('(2) a majority named alongside "everyone" is still that party; "everyone else" is the rest', () => {
    expect(
      withRoster('get the whole crew razz tickets, for dean chase piotr crowley and me', 'Arjun')
        ?.attendeeNames,
    ).toEqual(['Arjun', 'Dean', 'Chase', 'Piotr', 'Crowley']);
    expect(
      withRoster('get razz tickets for chase and me, everyone else is staying in')?.attendeeNames,
    ).toEqual(['Dean', 'Chase']);
  });

  it('(3) a party of only members said to be out is never proposed', () => {
    for (const text of [
      'get razz tickets for henry, henry is sick',
      "get razz tickets for henry and chase, henry's sick and chase is hungover",
    ]) {
      for (const r of both(text)) expect(r, text).toBeUndefined();
    }
    // One of two out: the service drops Henry and asks about the count.
    expect(withRoster("get razz tickets for henry and chase, henry's sick")?.attendeeNames).toEqual(
      ['Henry', 'Chase'],
    );
  });

  it('a count suffix reads like "for 5"', () => {
    for (const text of [
      "razzmatazz tickets x5, henry's sick",
      "get razz tickets x 5, henry's sick",
      "get 5x razz tickets, henry's sick",
    ]) {
      for (const r of both(text)) {
        expect(r, text).toMatchObject({ quantity: 5, excludedNames: ['Henry'] });
      }
    }
  });
});

describe('flagship recall is intact', () => {
  it.each([
    "get the 5 of us Razzmatazz tickets, Henry's sick",
    "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
    "get the 5 of us Razzmatazz tickets Henry's sick",
    "get the 5 of us razz tickets, henry's feeling rough",
    'can you sort razzmatazz for 5 of us tonight? not henry, he is feeling rough',
    "we need razz entry for five tonight, henry's out sick",
    'henry is under the weather so we need 5 razz tickets',
    "could you sort out razzmatazz passes for the five of us? henry's bailing",
    "get the 5 of us razz tickets, henry isn't feeling well",
    "get the 5 of us razz tickets, henry can't make it",
  ])('quantity 5, Henry out: %s', (text) => {
    for (const r of both(text)) {
      expect(r, text).toMatchObject({ quantity: 5, excludedNames: ['Henry'] });
    }
  });

  it('the named-list and minus-X paraphrases', () => {
    expect(
      withRoster('we need razzmatazz entry tonight for dean chase piotr crowley and me', 'Arjun')
        ?.attendeeNames,
    ).toEqual(['Arjun', 'Dean', 'Chase', 'Piotr', 'Crowley']);
    expect(
      withRoster('pick up razzmatazz passes for us tonight minus henry', 'Piotr')?.excludedNames,
    ).toEqual(['Henry']);
  });
});
