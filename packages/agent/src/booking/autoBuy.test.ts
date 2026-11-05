/**
 * T-182: the auto-buy whitelist. A positive grammar: the flagship and its
 * plain variants are eligible; every adversarial case from the T-182 task
 * line and every repro in `tasks/reviews/T-173-r2.md` (#1–#8) is not.
 */
import { describe, expect, it } from 'vitest';
import { loadAllTicketInventories } from '@trav/adapters';
import { venueIndexFrom } from './request.js';
import { autoBuyEligible, autoBuyVerdict, type AutoBuyInput } from './autoBuy.js';

const INDEX = venueIndexFrom(loadAllTicketInventories());
const BCN = ['Dean', 'Henry', 'Chase', 'Piotr', 'Arjun', 'Crowley'] as const;
const input = (text: string, extra: Partial<AutoBuyInput> = {}): AutoBuyInput => ({
  text,
  index: INDEX,
  sender: 'Dean',
  roster: BCN,
  lane: 'group',
  ...extra,
});
const verdict = (text: string, extra: Partial<AutoBuyInput> = {}) =>
  autoBuyVerdict(input(text, extra));
const eligible = (text: string, extra: Partial<AutoBuyInput> = {}) =>
  autoBuyEligible(input(text, extra));

const FLAGSHIP = "@trav get the 5 of us Razzmatazz tickets, Henry's sick";

describe('the flagship is eligible', () => {
  it.each([
    FLAGSHIP,
    `${FLAGSHIP}, thanks!`,
    `${FLAGSHIP} 🙏`,
    `${FLAGSHIP}. thanks trav 🙏`,
    `${FLAGSHIP}!`,
    `${FLAGSHIP}, thank you`,
    `${FLAGSHIP} when you get a sec`,
    `${FLAGSHIP}, pls`,
    `@trav pls get the 5 of us Razzmatazz tickets, Henry's sick`,
    "@Trav get the 5 of us razzmatazz tickets, henry's sick",
    "@trav, get the 5 of us Razzmatazz tickets. Henry's sick 🙏",
    "@trav get the 5 of us Razzmatazz tickets tonight, Henry's sick",
    "@trav get the 5 of us Razzmatazz tickets (Henry's sick)",
    '@trav get the 5 of us Razzmatazz tickets, Henry’s sick', // curly apostrophe
    "@trav get the 5 of us Razzmatazz tickets, since Henry's sick",
    "@trav get the 5 of us Razzmatazz tickets, Henry can't make it",
    "@trav get the 5 of us Razzmatazz tickets, Henry isn't coming",
    "@trav get the 5 of us Razzmatazz tickets, Henry's under the weather",
  ])('%s', (text) => {
    const v = verdict(text);
    expect(v, text).toMatchObject({ eligible: true, quantity: 5, excluded: ['Henry'] });
    if (v.eligible) {
      expect(v.attendees).toEqual(['Dean', 'Chase', 'Piotr', 'Arjun', 'Crowley']);
      expect(v.request).toMatchObject({ quantity: 5, excludedNames: ['Henry'] });
    }
  });

  it.each([
    ['@trav get razz tickets for everyone except henry', 5],
    ['@trav get razz tickets for everyone but henry and chase', 4],
    ['@trav get us razz tickets', 6],
    ['@trav book razzmatazz tickets for all of us', 6],
    ['@trav get 5 razz tickets, henry is sick', 5],
    ['@trav get razz tickets for the 5 of us, henry is out', 5],
    ['@trav get razzmatazz tickets for me and chase', 2],
    ['@trav get razzmatazz tickets for chase, piotr and me thanks', 3],
    ['trav, get everyone razz tickets 🎉', 6],
  ] as const)('plain variant: %s', (text, n) => {
    expect(verdict(text), text).toMatchObject({ eligible: true, quantity: n });
  });

  it('the roster state counts: with Henry already out, "the 5 of us" needs no reason', () => {
    expect(
      verdict('@trav get the 5 of us razzmatazz tickets', { alreadyOut: ['Henry'] }),
    ).toMatchObject({ eligible: true, quantity: 5 });
    // Without it, "the 5 of us" out of 6 names nobody who's out: the card.
    expect(verdict('@trav get the 5 of us razzmatazz tickets')).toEqual({
      eligible: false,
      reason: 'count_mismatch',
    });
  });
});

/** Each must be `eligible: false`. Some are also asserted with the address added. */
const ADVERSARIAL_T182 = [
  "i don't approve",
  'yes but not for me',
  'approve for him',
  "i don't approve for the group",
  'oh yeah sure, buy 50',
  '@trav oh yeah sure, buy 50 razz tickets',
  '@trav buy 50 razz tickets lol jk',
  '> yes',
  '"yes"',
  'Dean: yes',
  "don't get the tickets",
  "@trav don't get the razz tickets",
  '@trav don’t get the 5 of us razz tickets',
  'should we get tickets?',
  '@trav should we get razz tickets?',
  '@trav get tickets?? jk',
  '@trav get razz tickets?? jk',
  '@trav get the 5 of us razz tickets jk',
  "@trav get the 5 of us razz tickets, Henry's sick 😂",
  "@trav get the 5 of us razz tickets, Henry's sick 🙄",
  "@trav get the 5 of us razz tickets, Henry's sick lol no",
  // not addressed, or addressed late
  "get the 5 of us Razzmatazz tickets, Henry's sick",
  "Henry's sick. @trav get the 5 of us Razzmatazz tickets",
  // a soft verb, a question form, a price, a tier, a time
  "@trav can you get the 5 of us Razzmatazz tickets, Henry's sick",
  "@trav we need the 5 of us Razzmatazz tickets, Henry's sick",
  "@trav get the 5 of us Razzmatazz tickets under €30, Henry's sick",
  "@trav get the 5 of us Razzmatazz vip tickets, Henry's sick",
  "@trav get the 5 of us Razzmatazz tickets at 11pm, Henry's sick",
  // two venues, no venue, a generic word
  '@trav get the 5 of us razz or apolo tickets',
  '@trav get the 5 of us tickets',
  '@trav get the 5 of us club tickets',
  // a bare ask with no party: the roster's guess, not the member's words
  '@trav get razz tickets',
  // names that don't resolve
  '@trav get razz tickets for me and maria',
  '@trav get razz tickets for everyone except the sick one',
  '@trav get razz tickets for everyone except him',
  "@trav get razz tickets for me and chase, maria's sick",
  // a count that disagrees
  "@trav get the 4 of us razz tickets, Henry's sick",
  "@trav get 6 razz tickets, Henry's sick",
  '@trav get razz tickets for me and chase, 3 of them',
  // in and out at once
  "@trav get razz tickets for me and henry, henry's sick",
  // someone else's message folded in
  "@trav get the 5 of us Razzmatazz tickets, Henry's sick\n@trav actually wait",
  "@trav get the 5 of us Razzmatazz tickets, Henry's sick @trav jk",
] as const;

describe('T-182 adversarial cases never auto-buy', () => {
  it.each(ADVERSARIAL_T182)('%s', (text) => {
    expect(eligible(text), text).toBe(false);
  });

  it('a non-member sender never auto-buys', () => {
    expect(verdict(FLAGSHIP, { sender: 'Maria' })).toEqual({
      eligible: false,
      reason: 'sender_not_member',
    });
  });

  it('a long message is a conversation, not an ask', () => {
    expect(verdict(`${FLAGSHIP}, ${'thanks '.repeat(40)}`)).toEqual({
      eligible: false,
      reason: 'too_long',
    });
  });
});

/** Every repro in `tasks/reviews/T-173-r2.md` #1–#8, raw and with "@trav " added. */
const T173_R2 = {
  '#1 negation scope': [
    "get razz tickets for everyone, i don't think so",
    "get razz tickets for everyone. i don't think we should",
    "get razz tickets for everyone, you shouldn't though",
    "get razz tickets for everyone, we won't make it",
    "get razz tickets for everyone. i don't trust that site",
    "get the 5 of us Razzmatazz tickets, Henry's sick. actually i don't think so",
    "get the 5 of us Razzmatazz tickets, Henry's sick. hmm we shouldn't though",
  ],
  '#2 a condition on one person': [
    'get razz tickets for me and chase, and piotr if he wants',
    "get razz tickets for everyone, henry too if he's better",
  ],
  '#3 objectList and me': ['get chase and me razz tickets', 'get chase, piotr and me razz tickets'],
  '#4 said to be in, but out': [
    'get razz tickets for everyone, henry is in bed',
    "get razz tickets for everyone, henry's in hospital",
    "get razz tickets for everyone, henry's back home",
    "get razz tickets for everyone, henry's too tired",
    "get razz tickets for everyone, henry's also sick",
    'get razz tickets for everyone, chase is also out',
    "get razz tickets for everyone, i'll stay with henry",
  ],
  '#5 someone else or a done-statement': [
    'maria will get razz tickets for everyone',
    'the concierge can get razz tickets for us',
    "i'm getting razz tickets for everyone",
    "we're getting razz tickets for everyone",
    'dibs on buying razz tickets for everyone',
    'get razz tickets for everyone sorted',
    'get razz tickets for everyone, done',
  ],
  '#6 retractions and confirm-first tails': [
    'get razz tickets for everyone, no wait',
    'get razz tickets for everyone, hold on',
    'get razz tickets for everyone, ignore that',
    'get razz tickets for everyone, show me options first',
    'get razz tickets for everyone, confirm with me first',
    'get razz tickets for everyone, let me know the price first',
    'get razz tickets for everyone depending on the price',
    'get razz tickets for everyone, how much?',
  ],
  '#7 subset group words': [
    'get razz tickets for everyone else',
    'get razz tickets for the rest of us',
    'get razz tickets for the others',
    'get razz tickets for the girls',
    'get razz tickets for us two',
    'get razz tickets for me and 2 friends',
    'get razz tickets for everyone plus one',
  ],
  '#8 except list with plus': ['get razz tickets for everyone except henry plus chase'],
} as const;

describe('T-173 r2 repros #1–#8 never auto-buy', () => {
  for (const [label, cases] of Object.entries(T173_R2)) {
    it.each(cases)(`${label}: %s`, (text) => {
      expect(eligible(text), text).toBe(false);
      expect(eligible(`@trav ${text}`), `@trav ${text}`).toBe(false);
    });
  }
});

describe('the grammar is positive, not a blocklist', () => {
  it('an unknown tail word fails, however harmless it looks', () => {
    expect(verdict(`${FLAGSHIP}, cool`)).toEqual({ eligible: false, reason: 'grammar' });
    expect(verdict(`${FLAGSHIP}, he can't make it`)).toEqual({
      eligible: false,
      reason: 'grammar',
    });
  });

  it('an out clause needs its own separator', () => {
    expect(eligible("@trav get the 5 of us Razzmatazz tickets Henry's sick")).toBe(false);
  });

  it('the out member must be a member, and never the sender', () => {
    expect(eligible("@trav get the 5 of us razz tickets, Dean's sick")).toBe(false);
    expect(eligible("@trav get the 5 of us razz tickets, Maria's sick")).toBe(false);
  });

  it('names in the object slot are not in the grammar (T-173 r2 #3), only "for <names>"', () => {
    expect(eligible('@trav get chase and me razzmatazz tickets')).toBe(false);
    expect(verdict('@trav get razzmatazz tickets for chase and me')).toMatchObject({
      eligible: true,
      attendees: ['Dean', 'Chase'],
      quantity: 2,
    });
  });

  it('a "for <names>" list ends where a name starts a clause, and only a comma continues it', () => {
    expect(verdict("@trav get razzmatazz tickets for me and chase, henry's sick")).toMatchObject({
      eligible: true,
      attendees: ['Dean', 'Chase'],
      excluded: ['Henry'],
      quantity: 2,
    });
    // "." ends the list: "piotr" is then a clause the grammar can't read.
    expect(eligible('@trav get razzmatazz tickets for me and chase. piotr')).toBe(false);
    expect(eligible("@trav get razzmatazz tickets for me and henry's friend")).toBe(false);
  });

  it('a count with a names list must match it', () => {
    expect(verdict('@trav get 2 razzmatazz tickets for me and chase')).toMatchObject({
      eligible: true,
      quantity: 2,
    });
    expect(eligible('@trav get 3 razzmatazz tickets for me and chase')).toBe(false);
  });
});

describe('T-182 r1 review repros', () => {
  it('#2: "us" / "the N of us" from a sender who is already out is never the others without them', () => {
    expect(verdict('@trav get us razz tickets', { alreadyOut: ['Dean'] })).toEqual({
      eligible: false,
      reason: 'party',
    });
    expect(verdict('@trav get the 5 of us razz tickets', { alreadyOut: ['Dean'] })).toEqual({
      eligible: false,
      reason: 'party',
    });
    expect(
      verdict('@trav get razz tickets for everyone except henry', { alreadyOut: ['Dean'] }),
    ).toEqual({ eligible: false, reason: 'party' });
    // Someone else out is still fine.
    expect(verdict('@trav get us razz tickets', { alreadyOut: ['Henry'] })).toMatchObject({
      eligible: true,
      quantity: 5,
    });
  });

  it('#3: a forwarded ask, a quote-reply, or a DM never auto-buys', () => {
    expect(verdict(FLAGSHIP, { forwarded: true })).toEqual({ eligible: false, reason: 'quoted' });
    expect(verdict(FLAGSHIP, { quotesMessage: true })).toEqual({
      eligible: false,
      reason: 'quoted',
    });
    expect(verdict(FLAGSHIP, { lane: 'dm' })).toEqual({ eligible: false, reason: 'lane' });
    expect(verdict('@trav get us razz tickets', { lane: 'dm' })).toEqual({
      eligible: false,
      reason: 'lane',
    });
  });

  it('#4: a bare "no NAME" or sentence-initial "but NAME" is not an exclusion', () => {
    expect(eligible('@trav get us razz tickets, no chase')).toBe(false);
    expect(eligible('@trav get razz tickets for us. but henry')).toBe(false);
    expect(eligible('@trav get razz tickets for us, but henry')).toBe(false);
    // The unambiguous forms still read.
    expect(verdict('@trav get razz tickets for us, not henry')).toMatchObject({
      eligible: true,
      excluded: ['Henry'],
    });
    expect(verdict('@trav get razz tickets for us, but not henry')).toMatchObject({
      eligible: true,
      excluded: ['Henry'],
    });
    expect(verdict('@trav get razz tickets for everyone but henry')).toMatchObject({
      eligible: true,
      excluded: ['Henry'],
    });
  });

  it('Orchestrator: "lol" and "haha" are not tails (sarcasm markers), so those asks get the card', () => {
    for (const tail of [' lol', ' haha', ', lol', '. haha 🙏', ' thanks lol']) {
      expect(eligible(`${FLAGSHIP}${tail}`), tail).toBe(false);
    }
    // The kept tails still pass.
    for (const tail of [', thanks', ' pls', ' 🙏', ' when you get a sec']) {
      expect(eligible(`${FLAGSHIP}${tail}`), tail).toBe(true);
    }
  });

  it('#6: the reader-level repros are never eligible', () => {
    for (const text of [
      '@trav get razz tickets for everyone, nobody wants to go',
      '@trav get razz tickets for everyone, none of us want to',
      "@trav get razz tickets for everyone, he can't make it",
    ]) {
      expect(eligible(text), text).toBe(false);
    }
  });
});
