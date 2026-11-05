import { describe, expect, it } from 'vitest';
import type { Action } from '@trav/core';
import { CHANNEL_PROFILES } from './profiles.js';
import { needsTextFallback, textForChannel } from './fallbackText.js';
import { DEFAULT_TEXT_ALIASES } from './keywords.js';
import { privateExpenseCard, proposalCard } from './testing.js';

const MMS = CHANNEL_PROFILES.mixed_group_mms;
const RELAY = CHANNEL_PROFILES.imessage_relay_group;
const SIM = CHANNEL_PROFILES.simulator;

function act(id: Action['id'], label: string, tapback?: '👍' | '👎'): Action {
  return {
    id,
    label,
    style: 'primary',
    ...(tapback ? { tapback } : {}),
    textAliases: DEFAULT_TEXT_ALIASES[id],
  };
}
const APPROVE = act('approve', 'Approve', '👍');
const DECLINE = act('decline', 'Decline', '👎');
const NOT_ME = act('not_me', 'Not me');
const PROPOSAL = [APPROVE, DECLINE, NOT_ME];

/** An answer message (it carries a proposal card), so its instructions are rewritten. */
const mms = (text: string, actions: readonly Action[] = []): string =>
  textForChannel({ text, actions, card: proposalCard() }, MMS);

describe('textForChannel (T-069)', () => {
  it('leaves text alone where the channel can tap and react', () => {
    const text = '5 tickets · €90 total\n👍 to book. price held for 15 min';
    expect(textForChannel({ text, actions: PROPOSAL }, SIM)).toBe(text);
    expect(needsTextFallback(SIM)).toBe(false);
    expect(needsTextFallback(RELAY)).toBe(true);
    expect(needsTextFallback(MMS)).toBe(true);
  });

  it('keeps 👍 instructions on a relay group (tapbacks work, buttons do not)', () => {
    expect(
      textForChannel({ text: '👍 to book. price held for 15 min', actions: PROPOSAL }, RELAY),
    ).toBe('👍 to book. price held for 15 min');
    // ...but a button that isn't there becomes a reply.
    expect(
      textForChannel(
        {
          text: "tap Sent when you've paid. whoever's getting it taps Got it or 👍",
          actions: [act('sent', 'Sent'), act('got_it', 'Got it', '👍')],
        },
        RELAY,
      ),
    ).toBe('reply "sent" when you\'ve paid. whoever\'s getting it replies "got it" or 👍');
  });

  // Every phrase Trav's renderers use today (packages/agent/src/render, loop.ts).
  it.each([
    ['👍 to book. price held for 15 min', PROPOSAL, 'reply "yes" to book. price held for 15 min'],
    [
      '👍 from each of you to book. price held for 15 min',
      PROPOSAL,
      'each of you reply "yes" to book. price held for 15 min',
    ],
    [
      '👍 from Dean to book. open for 15 min',
      PROPOSAL,
      'Dean, reply "yes" to book. open for 15 min',
    ],
    [
      '👍 from one of Dean, Chase to book. open',
      PROPOSAL,
      'one of Dean, Chase reply "yes" to book. open',
    ],
    [
      'that has to come from Dean. @Dean 👍 to book',
      [],
      'that has to come from Dean. @Dean reply "yes" to book',
    ],
    ['need a 👍 from @Dean on this one', [], 'need a "yes" from @Dean on this one'],
    ['not booked. 👍 the card or reply "yes" to book it', [], 'not booked. reply "yes" to book it'],
    [
      'not booked. everyone approves for themselves: 👍 the card or reply "yes"',
      [],
      'not booked. everyone approves for themselves: reply "yes"',
    ],
    [
      'logged: €84 dinner on Dean, 5 ways (not Henry) → €16.80 each\n👎 to undo or tell me what to change',
      [act('undo', 'Undo', '👎')],
      'logged: €84 dinner on Dean, 5 ways (not Henry) → €16.80 each\nreply "undo" or tell me what to change',
    ],
    [
      'split with Dean, Piotr and Crowley? 👍 yes · 👎 just me',
      [act('confirm', 'Share it', '👍'), act('keep_private', 'Keep private', '👎')],
      'split with Dean, Piotr and Crowley? reply "yes" · reply "no" for just me',
    ],
    [
      '3 charges that look shared, 👍 each one you want on the tab:',
      [],
      '3 charges that look shared, reply with the numbers you want on the tab:',
    ],
    ['double-check the amount before you 👍', [], 'double-check the amount before you reply "yes"'],
    [
      'lodging is on everyone paying, so all 6 of you have to 👍',
      PROPOSAL,
      'lodging is on everyone paying, so all 6 of you have to reply "yes"',
    ],
    [
      'Dean, tap Got it or 👍 once it lands',
      [act('got_it', 'Got it', '👍')],
      'Dean, reply "got it" once it lands',
    ],
    [
      'which one? tap Share it or Keep private on the charge you mean',
      [],
      'which one? reply "share it" or "keep private" on the charge you mean',
    ],
    [
      "nobody's said sent yet, so i can't tell whose landed. once they tap Sent, your 👍 clears it",
      [],
      'nobody\'s said sent yet, so i can\'t tell whose landed. once they reply "sent", your "yes" clears it',
    ],
    // receiptRead.ts: a possible duplicate receipt, and the itemized question.
    [
      "👍 only if it's a different one",
      [act('confirm', 'Log it', '👍')],
      'reply "yes" only if it\'s a different one',
    ],
    [
      'who had what? or 👍 to split it 5 ways',
      [act('confirm', 'Log it', '👍')],
      'who had what? or reply "yes" to split it 5 ways',
    ],
  ] as const)('MMS: %s', (text, actions, expected) => {
    const out = mms(text, actions);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/👍|👎|\btaps? [A-Z]/u);
  });

  it('only a message that asks for an answer is rewritten (actions or an answer card)', () => {
    // A recap, a plain reply, a nudge without actions: exactly as written.
    for (const text of ['need a 👍 from @Dean on this one', 'all good, 👍 to that', 'tap Sent']) {
      expect(textForChannel({ text }, MMS)).toBe(text);
      expect(textForChannel({ text, actions: [] }, MMS)).toBe(text);
    }
    // An expense_confirm card with no actions still asks.
    expect(textForChannel({ text: '👍 to split it', card: privateExpenseCard() }, MMS)).toBe(
      'reply "yes" to split it',
    );
  });

  it("never rewrites quoted text (a member's words or a sample reply)", () => {
    expect(mms('Dean said "👍 to the hotel". 👍 to book')).toBe(
      'Dean said "👍 to the hotel". reply "yes" to book',
    );
    expect(mms('Chase: “tap Sent then 👍 to book”\n👍 to book')).toBe(
      'Chase: “tap Sent then 👍 to book”\nreply "yes" to book',
    );
    expect(mms('> 👍 to book\n👍 to book')).toBe('> 👍 to book\nreply "yes" to book');
  });

  it('a skin-toned 👍 is the same instruction', () => {
    expect(mms('👍🏽 to book')).toBe('reply "yes" to book');
  });

  it('leaves emoji that are not instructions alone', () => {
    expect(mms('booked ✅ razzmatazz, 5 tickets, €90')).toBe(
      'booked ✅ razzmatazz, 5 tickets, €90',
    );
    expect(mms('dinner at 9 🎉')).toBe('dinner at 9 🎉');
    expect(mms('all set 👍')).toBe('all set 👍');
    expect(mms('👍')).toBe('👍');
  });

  it('the reply word is one the keyword matcher accepts for that action', () => {
    const out = mms('👍 to book', PROPOSAL);
    const word = /reply "([^"]+)"/.exec(out)?.[1];
    expect(APPROVE.textAliases).toContain(word);
  });

  it('an unknown capitalised word after "tap" is left alone', () => {
    expect(mms('tap Dean on the shoulder')).toBe('tap Dean on the shoulder');
  });
});
