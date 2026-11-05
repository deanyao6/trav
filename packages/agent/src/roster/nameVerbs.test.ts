/**
 * T-173 (from the T-164 review): "chase" is member Chase and an English verb.
 * One helper (`isVerbUse`) decides for every reader that finds member names
 * in free text: expense lines, rider answers, booking asks.
 */
import { describe, expect, it } from 'vitest';
import type { Member, MemberId } from '@trav/core';
import { loadAllTicketInventories } from '@trav/adapters';
import { parseBookingRequest, venueIndexFrom } from '../booking/request.js';
import { parseExpenseText, type ExpenseTextContext } from '../ingest/expenseText.js';
import { parseRiderNames } from '../ingest/riders.js';
import { harness } from '../runtime.testkit.js';
import { isVerbUse, isVerbWord } from './nameVerbs.js';

const NAMES = ['Dean', 'Henry', 'Chase', 'Piotr', 'Arjun', 'Crowley'] as const;
const id = (n: string): MemberId => `mem_${n.toLowerCase()}`;
const CTX: ExpenseTextContext = {
  senderMemberId: 'mem_dean',
  members: NAMES.map((n) => ({ memberId: id(n), displayName: n })),
  tripCurrency: 'EUR',
  familyTab: false,
};
const MEMBERS: readonly Member[] = NAMES.map(
  (n) =>
    ({
      memberId: id(n),
      groupId: 'grp_test',
      displayName: n,
      role: 'member',
      active: true,
      senderId: `h_${n.toLowerCase()}`,
      ageBand: 'adult',
      joinedAt: '2026-02-01T00:00:00+01:00',
    }) as Member,
);
const INDEX = venueIndexFrom(loadAllTicketInventories());

/** Every member id an expense line names as in, or undefined when it asks who's in. */
function expenseIn(text: string): string[] | undefined {
  const r = parseExpenseText(text, CTX);
  if (r.kind !== 'drafts') return undefined;
  const p = r.drafts[0]?.participants;
  if (p === undefined) return undefined;
  return NAMES.map(id).filter((m) => JSON.stringify(p).includes(`"${m}"`));
}

/** `isVerbUse` on the first "chase" in `text`. */
function verbAt(text: string): boolean {
  const low = text.toLowerCase();
  const at = low.indexOf('chase');
  return isVerbUse(low, at, at + 'chase'.length, text);
}

describe('isVerbUse: "chase" the verb vs Chase the member', () => {
  it.each([
    "paid €30 for drinks, don't chase me for it",
    '€12 coffees, no need to chase me',
    'paid €45 for groceries, chase me up if I forget to split it',
    "i'll chase henry for it",
    'i will chase them tomorrow',
    'gonna chase the refund',
    'pls chase payment',
    'remind me to chase dean about it',
    'we chase down the money later',
  ])('verb: %s', (text) => {
    expect(verbAt(text)).toBe(true);
  });

  it.each([
    '€30 drinks with chase',
    'chase paid',
    'split with dean and chase',
    'for me and chase',
    'everyone but chase',
    "chase's round",
    'send €20 to chase',
    'can chase come too',
    // A capital mid-sentence is the name, whatever follows.
    'thanks Chase me and henry owe you',
  ])('member: %s', (text) => {
    expect(verbAt(text)).toBe(false);
  });

  it('only names in the verb list are ever verbs', () => {
    expect(isVerbWord('henry', "i'll ", ' me')).toBe(false);
    expect(isVerbWord('chase', "i'll ", ' me')).toBe(true);
  });
});

describe('the readers agree: parseExpenseText, parseRiderNames, parseBookingRequest', () => {
  it.each([
    "paid €30 for drinks, don't chase me for it",
    'paid €45 for groceries, chase me up if I forget to split it',
  ])('expense, verb: nobody named as in, so it asks: %s', (text) => {
    expect(expenseIn(text)).toBeUndefined();
  });

  it('expense, "€12 coffees, no need to chase me" reads like "€12 coffees" (no split with Chase)', () => {
    expect(parseExpenseText('€12 coffees, no need to chase me', CTX)).toEqual(
      parseExpenseText('€12 coffees', CTX),
    );
  });

  it.each([
    ['paid €30 for drinks with chase', ['mem_dean', 'mem_chase']],
    ['paid €40 for the cab, split with dean and chase', ['mem_dean', 'mem_chase']],
    ['paid €30 for drinks for me and chase', ['mem_dean', 'mem_chase']],
  ])('expense, member: %s', (text, ids) => {
    expect(expenseIn(text)).toEqual(ids);
  });

  it.each([
    // T-173 r1 #1: a name marker before "chase" wins over what follows.
    '€25 uber with chase after the club',
    '€30 drinks with chase that night',
    'paid €30 for drinks with chase this time',
    'paid €18 for the cab with chase up to park guell',
    'paid €12 for the taxi with chase down to the beach',
    'paid €30 for drinks with chase payment pending',
    'paid €30 for drinks with chase it was fun',
    'paid €30 for drinks w/ chase after the club',
    'paid €40 for the cab, split between dean and chase up the hill',
  ])('expense, a name marker before "chase": Dean and Chase: %s', (text) => {
    expect(expenseIn(text)).toEqual(['mem_dean', 'mem_chase']);
  });

  it('a name marker does not override the debt frame or a verb before it', () => {
    expect(verbAt('book razz for me and piotr and chase henry for his share')).toBe(true);
    expect(verbAt("with dean, i'll chase him for it")).toBe(true);
    expect(verbAt('with chase after the club')).toBe(false);
    expect(verbAt('dean, chase and me')).toBe(false);
  });

  it('"chase paid" still makes Chase the payer', () => {
    const r = parseExpenseText('chase paid €30 for drinks, everyone', CTX);
    expect(r.kind === 'drafts' ? r.drafts[0]!.payer : undefined).toEqual({
      kind: 'member',
      memberId: 'mem_chase',
    });
  });

  it('riders: the verb is no answer; the member is', () => {
    expect(parseRiderNames("dean and piotr, i'll chase them for it", MEMBERS, 'mem_arjun')).toEqual(
      { kind: 'none' },
    );
    expect(parseRiderNames('dean, piotr and chase', MEMBERS, 'mem_arjun')).toEqual({
      kind: 'names',
      memberIds: ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun'],
    });
    expect(parseRiderNames('everyone but chase', MEMBERS, 'mem_arjun')).toEqual({
      kind: 'names',
      memberIds: ['mem_dean', 'mem_henry', 'mem_piotr', 'mem_arjun', 'mem_crowley'],
    });
  });

  it('booking: the verb is never the member; the member is', () => {
    const ask = (t: string) => parseBookingRequest(t, INDEX, 'Dean', { roster: NAMES });
    // The verb is never Chase; Henry, named for a reason the reader can't
    // place, makes it no ask at all (the roster net, T-173 r1 #2).
    expect(ask("get razz tickets for everyone, i'll chase henry for it")).toBeUndefined();
    expect(
      parseBookingRequest("get razz tickets for everyone, i'll chase henry for it", INDEX, 'Dean'),
    ).toMatchObject({ excludedNames: [] });
    expect(ask('get razz tickets for me and chase')?.attendeeNames).toEqual(['Dean', 'Chase']);
    expect(ask('get razz tickets for everyone but chase')?.excludedNames).toEqual(['Chase']);
  });
});

describe('end to end (offline runtime): the verb never logs a split with Chase', () => {
  it.each([
    "@trav paid €30 for drinks, don't chase me for it",
    '@trav paid €45 for groceries, chase me up if I forget to split it',
  ])('%s ⇒ the usual "who\'s in" question', async (text) => {
    const h = harness();
    const turn = await h.say('h_dean', text);
    expect(turn.note).toBe('expense:clarify:participants');
    expect(turn.outbound.map((o) => ('text' in o ? o.text : '')).join('\n')).not.toMatch(/chase/i);
  });

  it('"€12 coffees, no need to chase me" logs nothing (same as "€12 coffees")', async () => {
    const h = harness();
    const turn = await h.say('h_dean', '@trav €12 coffees, no need to chase me');
    expect(turn.note).not.toBe('expense:logged');
    expect(turn.outbound.map((o) => ('text' in o ? o.text : '')).join('\n')).not.toMatch(/chase/i);
  });

  it('control: "€30 drinks with chase" still logs Dean and Chase', async () => {
    const h = harness();
    const turn = await h.say('h_dean', '@trav paid €30 for drinks with chase');
    expect(turn.note).toBe('expense:logged');
    expect(JSON.stringify(turn.outbound)).toContain('(Dean, Chase)');
  });
});
