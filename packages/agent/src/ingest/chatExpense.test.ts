import { describe, expect, it } from 'vitest';
import type { FxRatesAdapter } from '@trav/adapters';
import type { Expense, ExpenseConfirmCard, Member, OutboundMessage } from '@trav/core';
import { isReaction, ledger, safety } from '@trav/core';
import { BARCELONA } from '../compose.js';
import type { TurnResult } from '../loop.js';
import { deriveScriptKey } from '../model/client.js';
import { harness, offlineModel, type Harness } from '../runtime.testkit.js';
import { createChatExpenseFlow } from './chatExpense.js';

const T = BARCELONA.tripId;
const G = BARCELONA.groupId;
const PROPER = ['Dean', 'Henry', 'Maya', 'Jordan', 'Priya', 'Sam', 'EUR', 'USD'];

function messages(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o));
}

function only(r: TurnResult): OutboundMessage {
  const m = messages(r);
  expect(m, `note ${r.note}`).toHaveLength(1);
  return m[0]!;
}

function expenses(h: Harness): readonly Expense[] {
  return h.runtime.stores.group.expenses.listByTrip(T);
}

function logged(h: Harness): readonly Expense[] {
  return expenses(h).filter((e) => e.status === 'logged');
}

function balances(h: Harness): Record<string, number> {
  const order = h.runtime.stores.group.members.listByGroup(G).map((m) => m.memberId);
  const out: Record<string, number> = {};
  for (const b of ledger.computeBalances(
    h.runtime.stores.group.expenses.listEntries(T),
    'EUR',
    order,
  ))
    out[b.memberId] = b.net.amountMinor;
  return out;
}

/** Trav's group messages that ask something. */
function questionsAsked(h: Harness): number {
  return h.channel
    .groupTranscript()
    .filter((x) => x.direction === 'outbound' && 'text' in x && /\?/.test(String(x.text))).length;
}

function expectVoice(text: string, kind: 'reply' | 'expense'): void {
  const lint = safety.lintVoice(text, { kind, properNouns: PROPER });
  expect(lint.violations, text).toEqual([]);
}

describe('expense from chat text: logged straight away when every money fact is clear (VOICE §4.4)', () => {
  it('"@trav I paid €84 for dinner, split w everyone but Henry" ⇒ one logged card, the ledger entry, no model call', async () => {
    const h = harness();
    const turn = await h.say('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry', {
      messageId: 'm_dinner',
    });
    expect(turn.note).toBe('expense:logged');
    expect(turn.toolCalls).toEqual([]);
    expect(h.model.completions).toEqual([]);
    const msg = only(turn);
    expect(msg.to).toEqual({ kind: 'group' });
    expect(msg.text).toBe(
      'logged: €84 dinner on Dean, 5 ways (not Henry) → €16.80 each\n👎 to undo or tell me what to change',
    );
    expectVoice(msg.text, 'expense');
    const card = msg.card as ExpenseConfirmCard;
    expect(card).toMatchObject({
      type: 'expense_confirm',
      status: 'logged',
      source: 'chat',
      visibility: 'group',
    });
    expect(card.fallbackText).toBe(msg.text);
    expect(msg.actions?.map((a) => a.id)).toEqual(['undo']);

    const [e] = expenses(h);
    expect(e).toMatchObject({
      paidBy: [{ memberId: 'mem_dean', amount: { amountMinor: 8400, currency: 'EUR' } }],
      split: { method: 'exclude', excluded: ['mem_henry'] },
      source: 'chat',
      sourceRef: { kind: 'message', id: 'm_dinner' },
      category: 'food',
      createdBy: 'mem_dean',
      status: 'logged',
    });
    // occurredAt is the message's time
    expect(e!.occurredAt).toBe(h.last.message!.receivedAt);
    expect(balances(h)).toMatchObject({
      mem_dean: 6720,
      mem_henry: 0,
      mem_maya: -1680,
      mem_sam: -1680,
    });
    const created = h.audit().filter((a) => a.type === 'ledger.entry_created');
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toMatchObject({
      expenseId: e!.expenseId,
      sourceMessageId: 'm_dinner',
    });
    expect(turn.auditEventIds).toContain(created[0]!.id);
  });

  it('custom shares (VOICE §4.4 B): "trav the taxi was €32, me and Sam, Sam had the suitcase so he pays 20"', async () => {
    const h = harness();
    const turn = await h.say(
      'h_maya',
      'trav the taxi was €32, me and Sam, Sam had the suitcase so he pays 20',
    );
    expect(turn.note).toBe('expense:logged');
    expect(only(turn).text).toBe('logged: €32 taxi on Maya · Sam €20 · Maya €12\n👎 to undo');
    expect(balances(h)).toMatchObject({ mem_maya: 2000, mem_sam: -2000 });
  });

  it('"the 5 of us from razz" resolves through the activity roster, not a guess by count', async () => {
    const h = harness();
    for (const id of ['mem_dean', 'mem_henry', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam']) {
      h.runtime.stores.group.trips.setAttendance({
        activityId: BARCELONA.razzmatazzActivityId,
        memberId: id,
        status: id === 'mem_henry' ? 'out' : 'in',
        updatedAt: h.clock.now(),
        sourceMessageId: 'msg_prior',
        setBy: id,
      });
    }
    const turn = await h.say('h_sam', '@trav kebabs were on me, 62 euros, the 5 of us from razz');
    expect(turn.note).toBe('expense:logged');
    expect(only(turn).text.split('\n')[0]).toBe(
      'logged: €62 kebabs on Sam, 5 ways (not Henry) → €12.40 each',
    );
  });

  it('a guest cannot put anything on the tab', async () => {
    const h = harness();
    const turn = await h.say('h_ava', '@trav i paid €84 for dinner, everyone');
    expect(turn.note).not.toMatch(/^expense:/);
    expect(expenses(h)).toEqual([]);
  });
});

describe('exactly one clarifying question when a money fact is missing (VOICE §4.11)', () => {
  it('missing amount: one question, nothing logged; the answer logs it against the original message', async () => {
    const h = harness();
    const ask = await h.say('h_henry', '@trav i paid for lunch, everyone', {
      messageId: 'm_lunch',
    });
    expect(ask.note).toBe('expense:clarify:amount');
    const q = only(ask);
    expect(q.text).toBe('how much was lunch?');
    expectVoice(q.text, 'reply');
    expect(q.card).toBeUndefined();
    expect(expenses(h)).toEqual([]);
    expect(h.model.completions).toEqual([]);

    // The answer lands inside the reply window, no @trav needed.
    const answer = await h.say('h_henry', '42.60');
    expect(answer.note).toBe('expense:logged:answer');
    expect(only(answer).text.split('\n')[0]).toBe(
      'logged: €42.60 lunch on Henry, 6 ways → €7.10 each',
    );
    const [e] = expenses(h);
    expect(e!.sourceRef).toEqual({ kind: 'message', id: 'm_lunch' });
    expect(e!.amount).toEqual({ amountMinor: 4260, currency: 'EUR' });
    expect(questionsAsked(h)).toBe(1);
  });

  it('missing who is in: one question, nothing logged; a partial answer waits silently instead of asking again', async () => {
    const h = harness();
    const ask = await h.say('h_dean', '@trav i paid for dinner');
    expect(ask.note).toBe('expense:clarify:amount+participants');
    expect(only(ask).text).toBe("how much was dinner, and who's in on it?");
    expect(expenses(h)).toEqual([]);

    const part = await h.say('h_dean', '84');
    expect(part.note).toBe('expense:waiting');
    expect(part.outbound).toEqual([]);
    expect(expenses(h)).toEqual([]);

    const rest = await h.say('h_dean', 'everyone but henry');
    expect(rest.note).toBe('expense:logged:answer');
    expect(only(rest).text.split('\n')[0]).toBe(
      'logged: €84 dinner on Dean, 5 ways (not Henry) → €16.80 each',
    );
    expect(questionsAsked(h)).toBe(1);
  });

  it('"me and the girls" is never guessed: one question by name', async () => {
    const h = harness();
    const ask = await h.say('h_maya', '@trav €40 for the club entry, me and the girls');
    expect(only(ask).text).toBe("who's in on the €40 club entry, by name?");
    expect(expenses(h)).toEqual([]);
    const answer = await h.say('h_maya', 'me priya and sam');
    expect(answer.note).toBe('expense:logged:answer');
    expect(logged(h)[0]!.split).toEqual({
      method: 'equal',
      participants: ['mem_maya', 'mem_priya', 'mem_sam'],
    });
  });

  it('"venmo me 20 each" asks currency and who in one question; "euros, me maya and dean" logs €60', async () => {
    const h = harness();
    const ask = await h.say('h_sam', '@trav venmo me 20 each for the cab');
    expect(only(ask).text).toBe("was that €20 or $20 each, and who's in on it?");
    const answer = await h.say('h_sam', 'euros, me maya and dean');
    expect(answer.note).toBe('expense:logged:answer');
    expect(logged(h)[0]!.amount).toEqual({ amountMinor: 6000, currency: 'EUR' });
  });

  it('T-084: a foreign amount is converted at the mock rate for its date, no question', async () => {
    const h = harness();
    // sat 14 mar: the table has no weekend rows, so friday 13 mar (1.0840 USD per EUR) is used
    const turn = await h.say('h_dean', '@trav $40 USD for the museum, everyone', {
      messageId: 'm_museum',
    });
    expect(turn.note).toBe('expense:logged');
    expect(questionsAsked(h)).toBe(0);
    const msg = only(turn);
    // 4000 / 1.0840 = 3690.04… ⇒ €36.90; 6 ways ⇒ €6.15 each
    expect(msg.text).toBe(
      'logged: $40 museum (≈€36.90) on Dean, 6 ways → €6.15 each\n👎 to undo or tell me what to change',
    );
    expectVoice(msg.text, 'expense');
    const card = msg.card as ExpenseConfirmCard;
    expect(card.amount).toEqual({ amountMinor: 3690, currency: 'EUR' });
    expect(card.original).toEqual({ amountMinor: 4000, currency: 'USD' });
    expect(card.title).toBe('museum, $40 ≈ €36.90');
    const [e] = logged(h);
    expect(e!.amount).toEqual({ amountMinor: 3690, currency: 'EUR' });
    expect(e!.paidBy).toEqual([{ memberId: 'mem_dean', amount: e!.amount }]);
    expect(e!.original).toEqual({
      amount: { amountMinor: 4000, currency: 'USD' },
      rate: '1.0840',
      rateDate: '2026-03-13',
      source: 'mock-fx',
    });
    // the ledger is in EUR and sums to the converted total exactly
    const b = balances(h);
    expect(Object.values(b).reduce((x, y) => x + y, 0)).toBe(0);
    expect(b['mem_dean']).toBe(3690 - 615);
    const audit = h.runtime.stores.group.audit
      .listByGroup(G)
      .find((a) => a.type === 'ledger.entry_created');
    expect(audit?.payload).toMatchObject({
      fx: { originalMinor: 4000, originalCurrency: 'USD', rate: '1.0840', rateSource: 'mock-fx' },
    });
    // a replay says it already has it, in both amounts
    const again = await h.say('h_dean', '@trav $40 USD for the museum, everyone', {
      messageId: 'm_museum',
    });
    expect(again.outbound).toHaveLength(0);
    expect(logged(h)).toHaveLength(1);
  });

  it('T-084 acceptance: msg_bcn_0063 logs 3294 EUR minor split Priya/Jordan/Sam at the 2026-03-10 mock rate', async () => {
    const h = harness();
    h.clock.set('2026-03-10T12:50:00-04:00');
    const turn = await h.say(
      'h_priya',
      '@trav i got esims for me jordan and sam before we fly, $36 total',
      { messageId: 'msg_bcn_0063' },
    );
    expect(turn.note).toBe('expense:logged');
    expect(questionsAsked(h)).toBe(0);
    const msg = only(turn);
    expect(msg.text).toContain('$36');
    expect(msg.text.split('\n')[0]).toBe(
      'logged: $36 esims (≈€32.94) on Priya, 3 ways (not Dean, Henry, Maya) → €10.98 each',
    );
    expectVoice(msg.text, 'expense');
    const [e] = logged(h);
    expect(e!.amount).toEqual({ amountMinor: 3294, currency: 'EUR' });
    expect(e!.original).toEqual({
      amount: { amountMinor: 3600, currency: 'USD' },
      rate: '1.0928',
      rateDate: '2026-03-10',
      source: 'mock-fx',
    });
    const order = h.runtime.stores.group.members.listByGroup(G).map((m) => m.memberId);
    const shares = ledger.computeShares(e!, { memberOrder: order, participantsUniverse: order });
    expect(
      Object.fromEntries(
        shares
          .filter((s) => s.amount.amountMinor !== 0)
          .map((s) => [s.memberId, s.amount.amountMinor]),
      ),
    ).toEqual({ mem_priya: 1098, mem_jordan: 1098, mem_sam: 1098 });
  });

  it('T-084: no rate for that date ⇒ the one question, never a guess; the lookup is EUR→USD on the trip-local date', async () => {
    const calls: [string, string, string | undefined][] = [];
    const noRate: FxRatesAdapter = {
      info: { provider: 'mock-fx', mode: 'mock' },
      getRate: (base, quote, on) => {
        calls.push([base, quote, on]);
        return Promise.resolve({
          ok: false,
          error: { code: 'not_found', message: 'no rate', retryable: false },
        });
      },
    };
    const h = harness({ runtime: { fx: noRate } });
    const ask = await h.say('h_dean', '@trav $40 USD for the museum, everyone');
    expect(ask.note).toBe('expense:clarify:trip_currency');
    expect(only(ask).text).toBe(
      "what was the museum in euros? the tab's in EUR and i can't convert $40 yet",
    );
    expect(expenses(h)).toEqual([]);
    expect(calls).toEqual([['EUR', 'USD', '2026-03-14']]);
    // the answer in euros is used as is
    expect((await h.say('h_dean', '37')).note).toBe('expense:logged:answer');
    expect(logged(h)[0]!.amount).toEqual({ amountMinor: 3700, currency: 'EUR' });
    expect(logged(h)[0]!.original).toBeUndefined();
  });

  it('T-084: a rate lookup that throws is no rate (the question), not a failed turn', async () => {
    const broken: FxRatesAdapter = {
      info: { provider: 'mock-fx', mode: 'mock' },
      getRate: () => Promise.reject(new Error('fx down')),
    };
    const h = harness({ runtime: { fx: broken } });
    const ask = await h.say('h_dean', '@trav $40 USD for the museum, everyone');
    expect(ask.note).toBe('expense:clarify:trip_currency');
    expect(expenses(h)).toEqual([]);
  });

  it('T-084: a euro amount never looks up a rate', async () => {
    const calls: string[] = [];
    const spy: FxRatesAdapter = {
      info: { provider: 'mock-fx', mode: 'mock' },
      getRate: (base, quote) => {
        calls.push(`${base}/${quote}`);
        return Promise.reject(new Error('should not be called'));
      },
    };
    const h = harness({ runtime: { fx: spy } });
    expect((await h.say('h_dean', '@trav i paid €84 for dinner, everyone')).note).toBe(
      'expense:logged',
    );
    expect(calls).toEqual([]);
    expect(logged(h)[0]!.original).toBeUndefined();
  });

  it('a foreign amount with no FX: one question for the trip-currency amount, the answer used as is', async () => {
    const h = harness({ runtime: { fx: false } });
    const ask = await h.say('h_dean', '@trav $40 USD for the museum, everyone');
    expect(only(ask).text).toBe(
      "what was the museum in euros? the tab's in EUR and i can't convert $40 yet",
    );
    expect(expenses(h)).toEqual([]);
    const answer = await h.say('h_dean', '37');
    expect(answer.note).toBe('expense:logged:answer');
    expect(logged(h)[0]!.amount).toEqual({ amountMinor: 3700, currency: 'EUR' });
  });

  it('someone else\'s reply never answers Dean\'s question; "nvm" drops it with a 👍', async () => {
    const h = harness();
    await h.say('h_dean', '@trav i paid for dinner, everyone');
    const other = await h.say('h_maya', '84');
    expect(other.note).not.toMatch(/^expense:logged/);
    expect(expenses(h)).toEqual([]);
    const drop = await h.say('h_dean', 'nvm');
    expect(drop.note).toBe('expense:dropped');
    expect(drop.outbound).toHaveLength(1);
    expect(isReaction(drop.outbound[0]!)).toBe(true);
    // the question is gone: a later "84" from Dean is not an answer
    const late = await h.say('h_dean', '@trav 84');
    expect(late.note).not.toMatch(/^expense:logged/);
    expect(expenses(h)).toEqual([]);
  });

  it('an open question never swallows the next request or a new statement', async () => {
    const h = harness();
    await h.say('h_dean', '@trav i paid for dinner');
    const ask = await h.say('h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
    expect(ask.toolCalls).toEqual(['propose_booking']);
    expect(expenses(h)).toEqual([]);
    const cab = await h.say('h_dean', '@trav i paid €20 for the cab, everyone');
    expect(cab.note).toBe('expense:logged');
    expect(logged(h).map((e) => [e.description, e.amount.amountMinor])).toEqual([['cab', 2000]]);
  });

  it('an unknown payer is asked alone; the answer fills only the payer, and who-is-in is asked once after', async () => {
    const h = harness();
    const ask = await h.say('h_maya', '@trav Alex paid €40 for the cab');
    expect(only(ask).text).toBe(
      'who paid for the cab? i can only put it on someone on this trip, not Alex',
    );
    expectVoice(only(ask).text, 'reply');
    const payer = await h.say('h_maya', 'jordan');
    expect(payer.note).toBe('expense:clarify:participants:answer');
    expect(only(payer).text).toBe("who's in on the €40 cab, everyone or just some of you?");
    expect(expenses(h)).toEqual([]);
    const who = await h.say('h_maya', 'everyone');
    expect(who.note).toBe('expense:logged:answer');
    expect(logged(h)[0]!.paidBy[0]!.memberId).toBe('mem_jordan');
    expect(logged(h)[0]!.split).toEqual({
      method: 'equal',
      participants: ['mem_dean', 'mem_henry', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam'],
    });
    expect(questionsAsked(h)).toBe(2); // two different facts, each asked once
  });

  it('r1 #7: the open question outlives the 2-minute reply window; a bare "84" five minutes later is the answer', async () => {
    const h = harness();
    await h.say('h_dean', '@trav i paid for dinner, everyone');
    h.clock.advanceMs(5 * 60 * 1000);
    const answer = await h.say('h_dean', '84');
    expect(answer.note).toBe('expense:logged:answer');
    expect(logged(h)[0]!.amount).toEqual({ amountMinor: 8400, currency: 'EUR' });
    // unaddressed chatter from the same member is not parsed as a new expense
    await h.say('h_dean', '@trav i paid for lunch, everyone');
    h.clock.advanceMs(5 * 60 * 1000);
    const chatter = await h.say('h_dean', 'i paid €20 for the cab lol, everyone');
    expect(chatter.note).not.toMatch(/^expense:logged/);
    // and past the TTL the question is gone
    h.clock.advanceMs(20 * 60 * 1000);
    const late = await h.say('h_dean', '12');
    expect(late.note).toBe('mention:none');
    expect(logged(h)).toHaveLength(1);
  });

  it('r1 #8: logging a cab never drops the open dinner question; a second question waits its turn', async () => {
    const h = harness();
    await h.say('h_dean', '@trav i paid for dinner, everyone');
    const cab = await h.say('h_dean', '@trav i paid €20 for the cab, everyone');
    expect(cab.note).toBe('expense:logged');
    const lunch = await h.say('h_dean', '@trav i paid for lunch, me and maya');
    expect(lunch.note).toBe('expense:queued');
    expect(isReaction(lunch.outbound[0]!)).toBe(true);
    // the dinner question is still the open one
    const dinner = await h.say('h_dean', '84');
    expect(dinner.note).toBe('expense:logged:answer:next_question');
    const msg = only(dinner);
    expect(msg.text).toBe(
      [
        'logged: €84 dinner on Dean, 6 ways → €14 each',
        '👎 to undo or tell me what to change',
        'how much was lunch?',
      ].join('\n'),
    );
    expect((msg.card as ExpenseConfirmCard).fallbackText).toBe(msg.text);
    expectVoice(msg.text, 'expense');
    const lunchAnswer = await h.say('h_dean', '30');
    expect(lunchAnswer.note).toBe('expense:logged:answer');
    expect(logged(h).map((e) => [e.description, e.amount.amountMinor])).toEqual([
      ['cab', 2000],
      ['dinner', 8400],
      ['lunch', 3000],
    ]);
  });

  it('r1 #9: above €2,000 the amount is said again before anything is logged; "yes" is not enough', async () => {
    const h = harness();
    const ask = await h.say('h_dean', '@trav i paid €84000 for dinner, everyone');
    expect(only(ask).text).toBe("€84,000 for dinner? say the amount again and i'll log it");
    expectVoice(only(ask).text, 'reply');
    const yes = await h.say('h_dean', 'yes');
    expect(yes.note).not.toMatch(/^expense:logged/);
    expect(expenses(h)).toEqual([]);
    const fixed = await h.say('h_dean', '84');
    expect(fixed.note).toBe('expense:logged:answer');
    expect(logged(h)[0]!.amount).toEqual({ amountMinor: 8400, currency: 'EUR' });
  });

  it('r1 #9: a minus sign is never logged', async () => {
    const h = harness();
    const turn = await h.say('h_dean', '@trav i paid -€20 for the taxi, everyone');
    expect(turn.note).not.toMatch(/^expense:/);
    expect(expenses(h)).toEqual([]);
  });

  it('r1 #11: "we paid" asks who paid; "me" answers it', async () => {
    const h = harness();
    const ask = await h.say('h_dean', '@trav we paid €84 for dinner, everyone');
    expect(only(ask).text).toBe('who paid for dinner? i put each one on one person');
    const me = await h.say('h_dean', 'me');
    expect(me.note).toBe('expense:logged:answer');
    expect(logged(h)[0]!.paidBy[0]!.memberId).toBe('mem_dean');
  });

  it('r1 #1: "henry wasn\'t there" leaves Henry out instead of charging him everything', async () => {
    const h = harness();
    const turn = await h.say('h_dean', "@trav i paid €84 for dinner, henry wasn't there");
    expect(only(turn).text.split('\n')[0]).toBe(
      'logged: €84 dinner on Dean, 5 ways (not Henry) → €16.80 each',
    );
    expect(balances(h)['mem_henry']).toBe(0);
  });

  it('"leave it off" is a 👍 and no ledger write', async () => {
    const h = harness();
    const turn = await h.say(
      'h_priya',
      "@trav I paid €38 for lunch but i'll expense it, leave it off",
    );
    expect(turn.note).toBe('expense:no_log');
    expect(isReaction(turn.outbound[0]!)).toBe(true);
    expect(expenses(h)).toEqual([]);
  });
});

describe("undo within the window reverses the ledger entry (the loop's undo path)", () => {
  it('👎 on the logged card voids it and the balances return to where they were', async () => {
    const h = harness();
    const before = balances(h);
    const turn = await h.say('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry');
    const card = only(turn);
    const expenseId = (card.card as ExpenseConfirmCard).expenseId;
    expect(balances(h)).not.toEqual(before);
    const undo = await h.react('h_dean', card.id, '👎');
    expect(undo.note).toBe('undo:done');
    expect(only(undo).text).toBe("undone: €84 dinner on Dean, it's off the tab");
    expectVoice(only(undo).text, 'reply');
    expect(h.runtime.stores.group.expenses.get(expenseId)?.status).toBe('undone');
    expect(expenses(h)).toEqual([]);
    expect(h.runtime.stores.group.expenses.listEntries(T)).toEqual([]);
    expect(balances(h)).toEqual(before);
    expect(h.audit().filter((a) => a.type === 'ledger.entry_deleted')).toHaveLength(1);
  });

  it('a bare "undo" inside the reply window does the same', async () => {
    const h = harness();
    await h.say('h_dean', '@trav add €45.50 for groceries, everyone');
    const undo = await h.say('h_dean', 'undo');
    expect(undo.note).toBe('undo:done');
    expect(logged(h)).toEqual([]);
  });
});

describe('one message, two expenses: per-expense sub-ids (T-005 review note)', () => {
  it('"84 for dinner and 20 for the cab" ⇒ message:<id>#1 and #2, one post, one 👎 undoes both', async () => {
    const h = harness();
    const turn = await h.say('h_dean', '@trav i paid 84 for dinner and 20 for the cab, everyone', {
      messageId: 'm_two',
    });
    expect(turn.note).toBe('expense:logged:2');
    const msg = only(turn);
    expect(msg.text).toBe(
      [
        'logged: €84 dinner on Dean, 6 ways → €14 each',
        'logged: €20 cab on Dean, 6 ways → €3.33 each',
        '👎 to undo both',
      ].join('\n'),
    );
    expectVoice(msg.text, 'expense');
    const card = msg.card as ExpenseConfirmCard;
    expect(card.fallbackText).toBe(msg.text);
    expect(card.digestItems).toHaveLength(2);
    const all = expenses(h);
    expect(all.map((e) => e.sourceRef)).toEqual([
      { kind: 'message', id: 'm_two#1' },
      { kind: 'message', id: 'm_two#2' },
    ]);
    expect(all.map((e) => e.amount.amountMinor)).toEqual([8400, 2000]);
    expect(card.digestItems!.map((d) => d.expenseId)).toEqual(all.map((e) => e.expenseId));
    expect(h.audit().filter((a) => a.type === 'ledger.entry_created')).toHaveLength(2);

    const undo = await h.react('h_dean', msg.id, '👎');
    expect(undo.note).toBe('undo:done');
    expect(only(undo).text).toBe("undone: €84 dinner and €20 cab on Dean, they're off the tab");
    expect(logged(h)).toEqual([]);
    expect(h.audit().filter((a) => a.type === 'ledger.entry_deleted')).toHaveLength(2);
  });

  it('two payers in one clause go to the scripted expense_text_v1 extraction (offline) and still log with sub-ids', async () => {
    const h = harness();
    const text = '@trav i paid 60 and jordan paid 40 for the boat, split with everyone';
    const turn = await h.say('h_dean', text, { messageId: 'm_boat' });
    expect(turn.modelSources).toEqual(['script']);
    expect(turn.note).toBe('expense:logged:2:model');
    expect(h.model.completions).toHaveLength(1);
    const req = h.model.completions[0]!;
    expect(req.systemPromptId).toBe('expense_text_v1');
    expect(req.tools).toEqual([]);
    expect(req.jsonSchema).toBeDefined();
    expect(deriveScriptKey(req)).toBe(
      'ba2cc391cefca500962a076d4cc24dd911db22cecf8e5d83471d7f1f7ba7e108',
    );
    expect(only(turn).text).toBe(
      [
        'logged: €60 boat on Dean, 6 ways → €10 each',
        'logged: €40 boat on Jordan, 6 ways → €6.67 each',
        '👎 to undo both',
      ].join('\n'),
    );
    expect(expenses(h).map((e) => [e.sourceRef.id, e.paidBy[0]!.memberId])).toEqual([
      ['m_boat#1', 'mem_dean'],
      ['m_boat#2', 'mem_jordan'],
    ]);
    // Maya neither paid nor logged either one (T-010 r1 #12); Dean logged both
    expect((await h.react('h_maya', only(turn).id, '👎')).note).toBe('undo:not_allowed');
    const undo = await h.react('h_dean', only(turn).id, '👎');
    expect(only(undo).text).toBe(
      "undone: €60 boat on Dean and €40 boat on Jordan, they're off the tab",
    );
  });

  it('an unscripted unsure phrasing falls back to the chat loop, never a guess', async () => {
    const h = harness();
    const turn = await h.say(
      'h_dean',
      '@trav i paid 30 and maya paid 50 for the bikes, split with everyone',
    );
    expect(turn.note).not.toMatch(/^expense:/);
    expect(expenses(h)).toEqual([]);
  });
});

describe('duplicates and untrusted text', () => {
  it('the same message delivered twice logs once', async () => {
    const h = harness();
    await h.say('h_dean', '@trav add €45.50 for groceries, everyone', { messageId: 'm_dup' });
    const again = await h.say('h_dean', '@trav add €45.50 for groceries, everyone', {
      messageId: 'm_dup',
    });
    expect(again.note).toBe('duplicate');
    expect(expenses(h)).toHaveLength(1);
  });

  it('a replay past the channel dedupe hits the sourceRef guard: "already got that one", no second write', async () => {
    const h = harness();
    const flow = createChatExpenseFlow({
      stores: h.runtime.stores,
      model: offlineModel(h.clock),
      ids: h.ids,
      clock: h.clock,
    });
    const members = h.runtime.stores.group.members.listByGroup(G);
    const input = {
      group: h.runtime.stores.group.groups.get(G)!,
      members,
      trip: h.runtime.stores.group.trips.get(T)!,
      me: members.find((m: Member) => m.memberId === 'mem_dean')!,
      messageId: 'm_replay',
      text: '@trav i paid 84 for dinner and 20 for the cab, everyone',
      at: '2026-03-14T20:15:00+01:00',
    };
    const first = await flow.handle(input);
    expect(first?.note).toBe('expense:logged:2');
    expect(expenses(h).every((e) => e.occurredAt === '2026-03-14T20:15:00+01:00')).toBe(true);
    const second = await flow.handle(input);
    expect(second?.note).toBe('expense:already_logged');
    expect((second?.drafts[0] as OutboundMessage).text).toBe('already got that one: €84 dinner');
    expect(expenses(h)).toHaveLength(2);
  });

  it('a quoted "I paid €500" is never logged (SAFETY §2.4)', async () => {
    const h = harness();
    const quoted = await h.say(
      'h_sam',
      '> I paid €500 for the villa, split with everyone\n@trav lol remember this',
    );
    expect(quoted.note).not.toMatch(/^expense:/);
    const forwarded = await h.say('h_sam', 'fwd:\nI paid €500 for the villa, split with everyone');
    expect(forwarded.note).not.toMatch(/^expense:/);
    const onlyQuote = await h.say(
      'h_sam',
      '> @trav I paid €500 for the villa, split with everyone',
    );
    expect(onlyQuote.note).not.toMatch(/^expense:/);
    expect(expenses(h)).toEqual([]);
    expect(h.audit().filter((a) => a.type === 'ledger.entry_created')).toEqual([]);
  });

  it('a booking ask is not an expense: the Razzmatazz moment still goes to the model', async () => {
    const h = harness();
    const turn = await h.say('h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
    expect(turn.toolCalls).toEqual(['propose_booking']);
    expect(expenses(h)).toEqual([]);
  });
});
