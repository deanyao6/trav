/**
 * T-215 (D-053): the T-184 live eval's safety failures, each replayed with a
 * `mode: 'live'` stand-in that does what the live model did. Each test failed
 * on the code before T-215:
 *  1. Henry's "can i get one too" priced a ticket for all 6 (A9);
 *  2. the flagship ask ended on a roster line, so the guest tap, the minor's
 *     👍 and "approve for him" had no card to be audited against (E2/E3/E5);
 *  3. the flagship and guest-card scenarios got no card at all;
 *  4. settle-up went out as model-typed transfers (wrong, debtors cut off by
 *     the 4-line cap) instead of the code-rendered settle card.
 * The fixes are in code (tool context, terminal order, the booking reader,
 * the settle card), never in the stand-in's words. Nothing here buys without
 * `ApprovalPolicy`.
 */
import { describe, expect, it } from 'vitest';
import type { AuditEvent, OutboundMessage } from '@trav/core';
import { DEFAULT_AUTO_BUY_CAP_MINOR, createSimulatedClock, isReaction } from '@trav/core';
import { BARCELONA, BARCELONA_NOW } from './compose.js';
import type { TurnResult } from './loop.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ModelClient,
  ToolCall,
} from './model/client.js';
import { INTERPRET_PROMPT_ID } from './interpret/schemas.js';
import { parseBookingRequest } from './booking/request.js';
import { bundledVenueIndex } from './model/offline/asks.js';
import type { BalancesResult } from './tools/index.js';
import { RAZZMATAZZ_ASK, FIVE, harness, offlineModel, type Harness } from './runtime.testkit.js';

const G = BARCELONA.groupId;
const ACT = BARCELONA.razzmatazzActivityId;
const SIX = ['mem_dean', 'mem_henry', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley'];

function reply(text: string, calls: readonly Omit<ToolCall, 'id'>[] = []): CompletionResponse {
  return {
    text,
    toolCalls: calls.map((c, i) => ({ id: `toolu_${String(i)}`, ...c })),
    usage: { inputTokens: 0, outputTokens: 0 },
    source: 'live',
    scriptKey: 'test',
  };
}

type Turn = (req: CompletionRequest, round: number) => CompletionResponse;
type Read = (req: CompletionRequest) => Omit<ToolCall, 'id'>;

interface StandIn {
  readonly model: ModelClient;
  /** Every group/DM chat request the stand-in answered itself. */
  readonly chats: CompletionRequest[];
  /** Every interpreter read. */
  readonly reads: CompletionRequest[];
}

/**
 * A live stand-in: the interpreter answers `read` (default pass_to_chat), the
 * chat lanes answer `chat`; everything else is the offline client.
 */
function standIn(chat?: Turn, read?: Read): StandIn {
  const inner = offlineModel(createSimulatedClock(BARCELONA_NOW));
  const chats: CompletionRequest[] = [];
  const reads: CompletionRequest[] = [];
  const model: ModelClient = {
    mode: 'live',
    async complete(req) {
      if (req.systemPromptId === INTERPRET_PROMPT_ID) {
        reads.push(req);
        return reply('', [read?.(req) ?? { name: 'pass_to_chat', input: { about: 'other' } }]);
      }
      const round = req.messages.filter((m) => m.role === 'assistant').length;
      if (
        chat !== undefined &&
        (req.systemPromptId.startsWith('group_chat') || req.systemPromptId.startsWith('dm_chat'))
      ) {
        chats.push(req);
        return chat(req, round);
      }
      return inner.complete(req);
    },
    classify: (req) => inner.classify(req),
  };
  return { model, chats, reads };
}

function groupOf(t: TurnResult): OutboundMessage[] {
  return t.outbound.filter((o): o is OutboundMessage => !isReaction(o) && o.to.kind === 'group');
}
function dmsOf(t: TurnResult): OutboundMessage[] {
  return t.outbound.filter((o): o is OutboundMessage => !isReaction(o) && o.to.kind === 'member');
}
function invalid(h: Harness, cause: string): AuditEvent[] {
  return h
    .audit()
    .filter((e) => e.type === 'approval.invalid_attempt' && e.payload['cause'] === cause);
}
function rosterRows(h: Harness) {
  return new Map(
    h.runtime.stores.group.trips.listAttendance(ACT).map((r) => [r.memberId, r.status] as const),
  );
}

/** The live model's flagship turn: read the roster, mark Henry out, stop (T-184 16-08-17Z). */
const marksHenryOut: Turn = (req, round) => {
  if (round === 0) return reply('', [{ name: 'get_roster', input: {} }]);
  if (round === 1)
    return reply('', [
      { name: 'set_attendance', input: { activityId: ACT, member: 'Henry', status: 'out' } },
    ]);
  return reply("Henry's out, want me to grab 5?");
};

/** Every proposal is for the whole group (the A9 live read of "can i get one too"). */
const proposesForAll: Turn = (_req, round) =>
  round === 0
    ? reply('', [{ name: 'propose_booking', input: { kind: 'ticket', query: 'razzmatazz' } }])
    : reply('done');

// ---------- 2, 3: the flagship posts its card in live mode ----------

describe('T-215 #3: a live flagship ask always posts the card', () => {
  it('the deterministic reader answers the ask; a model that would only mark Henry out is never asked', async () => {
    const s = standIn(marksHenryOut);
    const h = harness({ model: s.model });
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(turn.note).toBe('tool:propose_booking:proposal');
    expect(s.chats).toHaveLength(0);
    const [card] = groupOf(turn);
    expect(card?.card?.type).toBe('booking_proposal');
    const p = h.pending()[0]!;
    expect(p.attendees).toEqual([...FIVE]);
    expect(p.totalMinor).toBe(9000);
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(h.auditTypes()).toContain('policy.evaluated');
  });

  it('under the auto-buy cap the flagship is bought through the policy, receipt in chat, 5 QR DMs', async () => {
    const s = standIn(marksHenryOut);
    const h = harness({ model: s.model, autoBuyCapMinor: DEFAULT_AUTO_BUY_CAP_MINOR });
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(turn.note).toBe('tool:propose_booking:auto_approved');
    expect(s.chats).toHaveLength(0);
    expect(h.tickets.purchaseCount()).toBe(1);
    expect(groupOf(turn).some((m) => m.card?.type === 'receipt')).toBe(true);
    expect(new Set(dmsOf(turn).map((m) => (m.to as { memberId: string }).memberId))).toEqual(
      new Set(FIVE),
    );
    const types = h.auditTypes();
    expect(types.indexOf('policy.evaluated')).toBeLessThan(types.indexOf('booking.completed'));
  });

  it('a live model still owns booking asks the reader does not recognise', async () => {
    const ask = "@trav sort us out for the club later, henry's not up for it";
    expect(parseBookingRequest(ask, bundledVenueIndex(), 'Dean', { roster: [] })).toBeUndefined();
    const s = standIn(() => reply('which club, and is it the 5 of you?'));
    const h = harness({ model: s.model });
    const turn = await h.say('h_dean', ask);
    expect(s.chats.length).toBeGreaterThan(0);
    expect(groupOf(turn)[0]?.text).toBe('which club, and is it the 5 of you?');
  });
});

describe('T-215 #3: a roster line never hides the booking that follows it', () => {
  const ask = "@trav sort us out for the club later, henry's not up for it";
  const propose = {
    name: 'propose_booking',
    input: { kind: 'ticket', query: 'razzmatazz', excludedNames: ['Henry'] },
  };
  const henryOut = {
    name: 'set_attendance',
    input: { activityId: ACT, member: 'Henry', status: 'out' },
  };

  it('set_attendance and propose_booking in one round: the card goes out, never a pending proposal with no card', async () => {
    const s = standIn((_r, round) => (round === 0 ? reply('', [henryOut, propose]) : reply('ok')));
    const h = harness({ model: s.model });
    const turn = await h.say('h_dean', ask);
    expect(turn.note).toBe('tool:propose_booking:proposal');
    const msgs = groupOf(turn);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.card?.type).toBe('booking_proposal');
    expect(h.pending()).toHaveLength(1);
    expect(h.pending()[0]!.attendees).toEqual([...FIVE]);
  });

  it('set_attendance first, propose_booking next round: the turn goes on and the card goes out', async () => {
    const s = standIn((_r, round) =>
      round === 0 ? reply('', [henryOut]) : round === 1 ? reply('', [propose]) : reply('ok'),
    );
    const h = harness({ model: s.model });
    const turn = await h.say('h_dean', ask);
    expect(turn.note).toBe('tool:propose_booking:proposal');
    expect(groupOf(turn).map((m) => m.card?.type)).toEqual(['booking_proposal']);
  });

  it('set_attendance with nothing after it: the roster line in code words, not the model paraphrase', async () => {
    const s = standIn((_r, round) =>
      round === 0 ? reply('', [henryOut]) : reply('Henry is OUT!! want me to book?'),
    );
    const h = harness({ model: s.model });
    const turn = await h.say('h_dean', ask);
    expect(turn.note).toBe('tool:set_attendance:attendance_set');
    expect(groupOf(turn).map((m) => m.text)).toEqual([
      'Henry is out for razzmatazz. that leaves 5',
    ]);
    expect(h.pending()).toHaveLength(0);
  });
});

describe('T-215 #2: guest, minor and "approve for him" attempts on the live flagship card are audited', () => {
  async function liveCard(): Promise<{ h: Harness; cardId: string }> {
    const h = harness({ model: standIn(marksHenryOut).model });
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    const card = groupOf(turn).find((m) => m.card?.type === 'booking_proposal');
    if (card === undefined) throw new Error(`no card (note ${String(turn.note)})`);
    return { h, cardId: card.id };
  }

  it('a guest tap and a spoofed "Dean" 👍 ⇒ approval.invalid_attempt{guest}, nothing approved', async () => {
    const { h, cardId } = await liveCard();
    const tap = await h.tap('h_ava', cardId, 'approve');
    expect(tap.note).toBe('approval:guest');
    const spoof = await h.react('h_dean2', cardId, '👍');
    expect(spoof.note).toBe('approval:guest');
    expect(invalid(h, 'guest')).toHaveLength(2);
    expect(h.auditTypes()).not.toContain('approval.granted');
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it("a minor's 👍 ⇒ approval.invalid_attempt{minor}, nothing approved", async () => {
    const { h, cardId } = await liveCard();
    const crowley = h.runtime.stores.group.members.get('mem_crowley')!;
    h.runtime.stores.group.members.upsert({
      ...crowley,
      birthDate: '2012-02-01',
      ageBand: 'under18',
    });
    const turn = await h.react('h_crowley', cardId, '👍');
    expect(turn.note).toBe('approval:minor');
    expect(invalid(h, 'minor')).toHaveLength(1);
    expect(h.auditTypes()).not.toContain('approval.granted');
  });

  it('"approve for him" on the card ⇒ approval.invalid_attempt{claimed_for_other}; the model is never asked', async () => {
    const s = standIn(marksHenryOut);
    const h = harness({ model: s.model });
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    const cardId = groupOf(turn)[0]!.id;
    const near = await h.say('h_dean', "i don't approve", { replyToMessageId: cardId });
    expect(near.note).toBe('approval:not_whitelisted');
    expect(h.pending()).toHaveLength(1);
    const claim = await h.say('h_dean', 'approve for him', { replyToMessageId: cardId });
    expect(claim.note).toBe('approval:claimed_for_other');
    expect(invalid(h, 'claimed_for_other')).toHaveLength(1);
    expect(s.chats).toHaveLength(0);
    expect(h.auditTypes()).not.toContain('approval.granted');
  });
});

// ---------- 1: "can i get one too" is the sender's ticket ----------

describe('T-215 #1: "can i get one too" from Henry prices Henry only (A9)', () => {
  const ASK = '@trav can i get one too in case i feel better later';

  it('after the 5 are booked: the add-on card for Henry alone, the interpreter and the chat model are never asked', async () => {
    const s = standIn(proposesForAll, () => ({
      name: 'update_attendance',
      input: { member: 'me', status: 'in', plan: null, night: null, headcount: null },
    }));
    const h = harness({ model: s.model, autoBuyCapMinor: DEFAULT_AUTO_BUY_CAP_MINOR });
    await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(h.tickets.purchaseCount()).toBe(1);
    const readsBefore = s.reads.length;
    const turn = await h.say('h_henry', ASK);
    expect(s.reads).toHaveLength(readsBefore);
    expect(s.chats).toHaveLength(0);
    const addOn = h.pending()[0]!;
    expect(addOn.attendees).toEqual(['mem_henry']);
    expect(addOn.payers).toEqual([{ memberId: 'mem_henry', shareMinor: 1800 }]);
    expect(addOn.totalMinor).toBe(1800);
    expect(groupOf(turn).map((m) => m.card?.type)).toEqual(['booking_proposal']);
    expect(h.tickets.purchaseCount()).toBe(1);
  });

  it('nothing booked yet and the chat model proposes for all 6: the card is for Henry alone, nobody else is written out', async () => {
    const s = standIn(proposesForAll);
    const h = harness({ model: s.model });
    const before = rosterRows(h);
    const turn = await h.say('h_henry', ASK);
    expect(s.chats.length).toBeGreaterThan(0);
    const p = h.pending()[0]!;
    expect(p.attendees).toEqual(['mem_henry']);
    expect(p.totalMinor).toBe(1800);
    expect(p.attendees).not.toEqual(SIX);
    expect(groupOf(turn)[0]!.card?.type).toBe('booking_proposal');
    const after = rosterRows(h);
    for (const id of SIX.filter((x) => x !== 'mem_henry'))
      expect(after.get(id)).toBe(before.get(id));
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it("the model's named party can't widen it: attendee names, exclusions and a headcount are all dropped", async () => {
    const s = standIn((_r, round) =>
      round === 0
        ? reply('', [
            {
              name: 'propose_booking',
              input: {
                kind: 'ticket',
                query: 'razzmatazz',
                attendeeNames: ['Henry', 'Chase', 'Piotr'],
                quantity: 3,
              },
            },
          ])
        : reply('done'),
    );
    const h = harness({ model: s.model });
    await h.say('h_henry', '@trav can i get one too');
    expect(h.pending()[0]!.attendees).toEqual(['mem_henry']);
  });

  it('a plain ask from Henry keeps the party the model names (the clamp is only for "one too")', async () => {
    const s = standIn(proposesForAll);
    const h = harness({ model: s.model });
    await h.say('h_henry', '@trav can you look into the club for all of us later');
    expect(h.pending()[0]?.attendees).toEqual(SIX);
  });
});

// ---------- 4: settle-up is the code-rendered card ----------

describe('T-215 #4: settle-up from the model path is the settle card, never typed transfers', () => {
  const ctxFor = (h: Harness, memberId: string, handle: string, messageId = 'msg_seed') => ({
    groupId: G,
    tripId: BARCELONA.tripId,
    senderMemberId: memberId,
    senderId: handle,
    lane: 'group' as const,
    now: h.clock.now(),
    clock: h.clock,
    ids: h.ids,
    stores: h.runtime.stores,
    messageId,
  });

  /** Three expenses on the tab, written through `log_expense` (the stand-in reads nothing). */
  async function withTab(h: Harness): Promise<void> {
    const seed: [string, string, number, string[]][] = [
      ['mem_dean', 'h_dean', 12000, []],
      ['mem_chase', 'h_chase', 3000, ['Henry', 'Dean', 'Arjun', 'Crowley']],
      ['mem_arjun', 'h_arjun', 6000, ['Henry']],
    ];
    for (const [i, [memberId, handle, amountMinor, excluded]] of seed.entries()) {
      await h.runtime.tools.run(
        'log_expense',
        {
          description: 'boat',
          amountMinor,
          currency: 'EUR',
          split: { method: 'exclude', excluded },
        },
        ctxFor(h, memberId, handle, `msg_seed_${String(i)}`),
      );
    }
  }

  /** get_balances, then a wrong, short list of transfers (debtors missing). */
  const typesTransfers =
    (view?: 'settle' | 'tab'): Turn =>
    (_r, round) =>
      round === 0
        ? reply('', [{ name: 'get_balances', input: view === undefined ? {} : { view } }])
        : reply('Henry → Dean €25\nChase → Dean €5\nthat squares it');

  const ASK = '@trav what does the money picture look like between all of us';

  it('the model writes transfers after get_balances ⇒ the running tab card with every transfer; the typed list never goes out', async () => {
    const s = standIn(typesTransfers());
    const h = harness({ model: s.model });
    await withTab(h);
    const turn = await h.say('h_piotr', ASK);
    expect(turn.note).toBe('tool:get_balances:tab');
    const msgs = groupOf(turn);
    expect(msgs).toHaveLength(1);
    const card = msgs[0]!.card;
    expect(card?.type).toBe('settle_up');
    expect(msgs[0]!.text).not.toContain('that squares it');
    // Every debtor on the tab is on the card, at code's amounts.
    const balances = (await h.runtime.tools.run(
      'get_balances',
      {},
      ctxFor(h, 'mem_piotr', 'h_piotr'),
    )) as BalancesResult;
    if (card?.type !== 'settle_up') throw new Error('no settle card');
    expect(card.transfers.map((t) => [t.from, t.to, t.amount.amountMinor])).toEqual(
      balances.transfers.map((t) => [t.from, t.to, t.amountMinor]),
    );
    expect(balances.transfers.length).toBeGreaterThan(2);
    expect(dmsOf(turn)).toHaveLength(0);
  });

  it("view 'settle' ⇒ the final settle card and each payer's DM, whatever the model typed", async () => {
    const s = standIn(typesTransfers('settle'));
    const h = harness({ model: s.model });
    await withTab(h);
    const turn = await h.say('h_piotr', '@trav ok time we closed this out properly');
    expect(turn.note).toBe('tool:get_balances:settle_up');
    const msgs = groupOf(turn);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.card?.type).toBe('settle_up');
    expect(msgs[0]!.text).not.toContain('that squares it');
    expect(dmsOf(turn).length).toBeGreaterThan(0);
  });

  it("in a DM, typed numbers after get_balances become the asker's own line", async () => {
    const s = standIn(typesTransfers());
    const h = harness({ model: s.model });
    await withTab(h);
    const turn = await h.dm('h_henry', 'whats the damage looking like for me lately');
    expect(turn.note).toBe('tool:get_balances:mine');
    const out = turn.outbound.filter((o): o is OutboundMessage => !isReaction(o));
    expect(out).toHaveLength(1);
    expect(out[0]!.to).toEqual({ kind: 'member', memberId: 'mem_henry' });
    expect(out[0]!.text).not.toContain('that squares it');
    expect(out[0]!.text).not.toContain('Chase → Dean');
  });

  it('a model reply with no get_balances is left alone', async () => {
    const s = standIn(() => reply('the boat was a good call'));
    const h = harness({ model: s.model });
    await withTab(h);
    const turn = await h.say('h_piotr', '@trav was the boat worth it');
    expect(groupOf(turn).map((m) => m.text)).toEqual(['the boat was a good call']);
  });
});

describe('T-215: the ledger is untouched by the fixes', () => {
  it('the live flagship 👍 splits among only the 5', async () => {
    const h = harness({ model: standIn(marksHenryOut).model });
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    const cardId = groupOf(turn)[0]!.id;
    for (const who of ['h_dean', 'h_chase', 'h_piotr', 'h_arjun', 'h_crowley'])
      await h.react(who, cardId, '👍');
    expect(h.tickets.purchaseCount()).toBe(1);
    const expense = h.runtime.stores.group.expenses
      .listByTrip(BARCELONA.tripId)
      .find((e) => e.sourceRef.kind === 'booking');
    expect(expense?.amount.amountMinor).toBe(9000);
    const split = expense?.split;
    expect(JSON.stringify(split)).not.toContain('mem_henry');
  });
});
