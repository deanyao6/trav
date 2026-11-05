/**
 * T-183 (D-047): model-first routing on the real runtime, with no network.
 * The model is a stand-in with `mode: 'live'` that answers `interpret_v1`
 * from a per-test function and delegates every other call to the offline
 * client (so the chat loop and its booking reader behave as offline). It
 * proves: the model's read reaches the same flows; code validates every field;
 * read-only asks stay fast paths; and nothing the model says approves or buys.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSimulatorChannel } from '@trav/adapters';
import type { Activity, Group, Member, OutboundMessage, Trip } from '@trav/core';
import {
  createDeterministicIdGenerator,
  createSimulatedClock,
  DEFAULT_AUTO_BUY_CAP_MINOR,
  isReaction,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import { BARCELONA, BARCELONA_NOW, createTravRuntime } from '../compose.js';
import type { TurnResult } from '../loop.js';
import type { CompletionRequest, ModelClient, ToolCall } from '../model/client.js';
import { repoRoot } from '../model/paths.js';
import {
  harness,
  offlineModel,
  RAZZMATAZZ_ASK,
  tempStateDir,
  type Harness,
} from '../runtime.testkit.js';
import { INTERPRET_PROMPT_ID } from './schemas.js';

type Reader = (req: CompletionRequest) => readonly ToolCall[];

function liveStandIn(read: Reader): { model: ModelClient; reads: CompletionRequest[] } {
  const inner = offlineModel(createSimulatedClock(BARCELONA_NOW));
  const reads: CompletionRequest[] = [];
  const model: ModelClient = {
    mode: 'live',
    async complete(req) {
      if (req.systemPromptId !== INTERPRET_PROMPT_ID) return inner.complete(req);
      reads.push(req);
      return {
        text: '',
        toolCalls: read(req),
        usage: { inputTokens: 0, outputTokens: 0 },
        source: 'script',
        scriptKey: 'test',
      };
    },
    classify: (req) => inner.classify(req),
  };
  return { model, reads };
}

function call(name: string, input: unknown): ToolCall {
  return { id: 'toolu_test_1', name, input };
}

function expense(over: Record<string, unknown> = {}): ToolCall {
  return call('record_expense', {
    expenses: [
      {
        description: 'dinner',
        category: 'food',
        paidBy: 'me',
        amount: '84',
        currency: 'EUR',
        perPerson: false,
        participants: { kind: 'except', members: ['Henry'], count: null, phrase: null },
        fixedShares: [],
        weights: [],
        restToPayer: false,
        lineItems: [],
        currencyDoubt: null,
        ...over,
      },
    ],
  });
}

const PASS = (about = 'other'): ToolCall => call('pass_to_chat', { about });

function setup(read: Reader, cap = 0): { h: Harness; reads: CompletionRequest[] } {
  const { model, reads } = liveStandIn(read);
  return { h: harness({ model, autoBuyCapMinor: cap }), reads };
}

function group(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o) && o.to.kind === 'group');
}

function expenses(h: Harness) {
  return h.runtime.stores.group.expenses.listByTrip(BARCELONA.tripId);
}

describe('model-first expenses', () => {
  const TEXT = "@trav dinner was 84 on me, everyone but henry's in on it";

  it("the model's read is logged through the same flow as a parsed one (card, shares)", async () => {
    const { h, reads } = setup(() => [expense()]);
    const offline = harness();
    const before = expenses(h).length;
    const turn = await h.say('h_dean', TEXT);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.tools.map((t) => t.name)).toEqual([
      'record_expense',
      'keep_off_tab',
      'update_attendance',
      'approval_reply',
      'pass_to_chat',
    ]);
    expect(turn.note).toMatch(/^expense:logged.*:model$/);
    expect(expenses(h)).toHaveLength(before + 1);
    // The same words through the parser offline post the same card.
    const parsed = await offline.say(
      'h_dean',
      '@trav I paid €84 for dinner, split w everyone but Henry',
    );
    expect(group(turn)[0]!.text).toBe(group(parsed)[0]!.text);
  });

  it('an amount that is not whole minor units is asked for, never rounded; nothing is logged', async () => {
    const { h } = setup(() => [expense({ amount: '84.005' })]);
    const before = expenses(h).length;
    const turn = await h.say('h_dean', TEXT);
    expect(turn.note).toMatch(/^expense:clarify:amount/);
    expect(expenses(h)).toHaveLength(before);
    expect(group(turn)[0]!.text).toMatch(/\?/);
  });

  it('a bare "$" on a euro trip is asked about even when the model leaves the currency empty (SC-17b in code)', async () => {
    for (const currency of [null, 'EUR']) {
      const { h } = setup(() => [expense({ amount: '40', currency, currencyDoubt: null })]);
      const before = expenses(h).length;
      const turn = await h.say('h_dean', '@trav i paid $40 for the taxi, split with everyone');
      expect(turn.note).toMatch(/^expense:clarify/);
      expect(expenses(h)).toHaveLength(before);
      expect(group(turn)[0]!.text).toBe('was that €40 or $40?');
    }
    // An explicit USD read is kept (converted, never re-asked).
    const { h } = setup(() => [expense({ amount: '40', currency: 'USD', currencyDoubt: null })]);
    const turn = await h.say('h_dean', '@trav i paid $40 for the taxi, split with everyone');
    expect(turn.note).not.toMatch(/^expense:clarify/);
  });

  it('a share put on someone outside the trip is refused; the chat loop takes it and nothing is logged', async () => {
    const { h } = setup(() => [expense({ fixedShares: [{ member: 'Ava', amount: '20' }] })]);
    const before = expenses(h).length;
    const turn = await h.say('h_dean', TEXT);
    expect(turn.note).not.toMatch(/^expense:/);
    expect(expenses(h)).toHaveLength(before);
  });

  it('a payer the model names who is not a member is a question, never a guess', async () => {
    const { h } = setup(() => [expense({ paidBy: 'Ava' })]);
    const before = expenses(h).length;
    const turn = await h.say('h_dean', TEXT);
    expect(turn.note).toMatch(/^expense:clarify:.*payer/);
    expect(expenses(h)).toHaveLength(before);
  });

  it('a malformed call (extra field, wrong type) is never logged', async () => {
    for (const bad of [
      expense({ approved: true }),
      expense({ amount: 84 }),
      call('record_expense', {}),
    ]) {
      const { h } = setup(() => [bad]);
      const before = expenses(h).length;
      await h.say('h_dean', TEXT);
      expect(expenses(h)).toHaveLength(before);
    }
  });

  it('"don\'t log it" read by the model is a 👍 and nothing on the tab', async () => {
    const { h } = setup(() => [call('keep_off_tab', {})]);
    const before = expenses(h).length;
    const turn = await h.say('h_dean', '@trav i grabbed the coffees, leave them off');
    expect(turn.note).toBe('expense:no_log:model');
    expect(expenses(h)).toHaveLength(before);
  });
});

describe('model-first attendance', () => {
  const roster = (h: Harness) =>
    h.runtime.stores.group.trips.listAttendance(BARCELONA.razzmatazzActivityId);

  it('one change, through the one roster write path, with no reason stored', async () => {
    const { h } = setup(() => [
      call('update_attendance', {
        member: 'Henry',
        status: 'out',
        plan: null,
        night: 'tonight',
        headcount: null,
      }),
    ]);
    const turn = await h.say('h_dean', '@trav henry is not feeling great, poor guy, count him out');
    expect(turn.note).toMatch(/^roster:/);
    expect(roster(h).find((a) => a.memberId === 'mem_henry')?.status).toBe('out');
    const changed = h.audit().filter((e) => e.type === 'roster.changed');
    expect(changed.length).toBeGreaterThan(0);
    expect(JSON.stringify(changed)).not.toMatch(/feeling|poor guy/);
    expect(group(turn)[0]!.text).not.toMatch(/feeling|poor/);
  });

  it('a guest or a name not on the trip is never written', async () => {
    const { h } = setup(() => [
      call('update_attendance', {
        member: 'Ava',
        status: 'in',
        plan: null,
        night: null,
        headcount: null,
      }),
    ]);
    const before = JSON.stringify(roster(h));
    await h.say('h_dean', '@trav ava is coming too');
    expect(JSON.stringify(roster(h))).toBe(before);
    expect(h.auditTypes()).not.toContain('roster.changed');
  });

  it('several changes at once go to the chat loop, never a partial write by the reader', async () => {
    const one = { member: 'Henry', status: 'out', plan: null, night: null, headcount: null };
    const { h } = setup(() => [
      call('update_attendance', one),
      call('update_attendance', { ...one, member: 'Chase' }),
    ]);
    const turn = await h.say('h_dean', '@trav henry and chase are out');
    expect(turn.note).not.toMatch(/^roster:/);
  });

  it('a read-only roll call is a fast path: no interpret call', async () => {
    const { h, reads } = setup(() => [PASS()]);
    const turn = await h.say('h_dean', "@trav who's in tonight?");
    expect(turn.note).toMatch(/^roster:roll_call/);
    expect(reads).toHaveLength(0);
  });
});

describe('model-first never approves or buys on its own say-so', () => {
  it('a model "approve" on a near-miss answer to the card is one question back, no grant, no purchase', async () => {
    const { h } = setup((req) =>
      /razzmatazz/i.test(JSON.stringify(req.messages))
        ? [PASS('booking')]
        : [call('approval_reply', { stance: 'approve' })],
    );
    const card = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(group(card).some((m) => m.card?.type === 'booking_proposal')).toBe(true);
    const turn = await h.say('h_dean', '@trav sure go on then, i suppose that works');
    expect(turn.note).toBe('approval:not_whitelisted');
    expect(group(turn)[0]!.text).toMatch(/^not booked\./);
    expect(h.auditTypes()).not.toContain('approval.granted');
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('an excluded member (Henry, off the card) never approves: not by an exact "yes", not by a model read', async () => {
    const { h } = setup((req) =>
      /razzmatazz/i.test(JSON.stringify(req.messages))
        ? [PASS('booking')]
        : [call('approval_reply', { stance: 'approve' })],
    );
    const card = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(group(card).some((m) => m.card?.type === 'booking_proposal')).toBe(true);
    await h.say('h_henry', 'yes');
    // The handler saw Henry's "yes" and refused it: he is not an approver on this card.
    const refused = h
      .audit()
      .filter((e) => e.type === 'approval.invalid_attempt')
      .map((e) => e.payload as { senderId?: string });
    expect(refused.some((p) => p.senderId === 'h_henry')).toBe(true);
    await h.say('h_henry', '@trav go on then, fine by me');
    expect(h.auditTypes()).not.toContain('approval.granted');
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('an approval read with no card open goes to the chat loop, never a grant', async () => {
    const { h } = setup(() => [call('approval_reply', { stance: 'approve' })]);
    await h.say('h_dean', '@trav yeah fine whatever');
    expect(h.auditTypes()).not.toContain('approval.granted');
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('the flagship: a recognised booking ask skips the read; the auto-buy verdict is code and the purchase goes through ApprovalPolicy', async () => {
    const { h, reads } = setup(() => [PASS('booking')], DEFAULT_AUTO_BUY_CAP_MINOR);
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(reads).toHaveLength(0);
    expect(turn.note).toBe('tool:propose_booking:auto_approved');
    expect(h.tickets.purchaseCount()).toBe(1);
    const types = h.auditTypes();
    expect(types.indexOf('policy.evaluated')).toBeGreaterThan(-1);
    expect(types.indexOf('policy.evaluated')).toBeLessThan(types.indexOf('booking.attempted'));
    const evaluated = h.audit().find((e) => e.type === 'policy.evaluated')!;
    expect(evaluated.payload).toMatchObject({ outcome: 'auto_approve', ask: 'explicit' });
  });

  it('a non-whitelisted ask the model reads as a booking still gets the card (verdict from the words, not the model)', async () => {
    const { h } = setup(() => [PASS('booking')], DEFAULT_AUTO_BUY_CAP_MINOR);
    await h.say('h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick lol");
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(h.audit().find((e) => e.type === 'policy.evaluated')?.payload).not.toMatchObject({
      outcome: 'auto_approve',
    });
  });

  it('a model that misreads a vague ask (no reader match) as an expense logs nothing without a stated amount', async () => {
    const { h, reads } = setup(
      () => [expense({ amount: null, description: 'club night' })],
      DEFAULT_AUTO_BUY_CAP_MINOR,
    );
    const before = expenses(h).length;
    await h.say('h_dean', '@trav can you sort the club thing for the lads');
    expect(reads).toHaveLength(1);
    expect(expenses(h)).toHaveLength(before);
    expect(h.tickets.purchaseCount()).toBe(0);
  });
});

describe('a booking ask the reader recognises is never the read (T-183 r2 #1)', () => {
  const misreads: [string, ToolCall][] = [
    [
      'update_attendance for Henry',
      call('update_attendance', {
        member: 'Henry',
        status: 'out',
        plan: 'razzmatazz',
        night: 'tonight',
        headcount: null,
      }),
    ],
    [
      'record_expense €150 except Henry',
      expense({ description: 'razzmatazz tickets', category: 'tickets', amount: '150' }),
    ],
  ];
  for (const [label, misread] of misreads) {
    it(`a model that would read the flagship as ${label} is never asked; the ask still auto-buys`, async () => {
      const { h, reads } = setup(() => [misread], DEFAULT_AUTO_BUY_CAP_MINOR);
      const before = expenses(h).map((e) => e.expenseId);
      const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
      expect(reads).toHaveLength(0);
      expect(turn.note).toBe('tool:propose_booking:auto_approved');
      expect(h.tickets.purchaseCount()).toBe(1);
      // The only new tab entry is the purchase's own (5 tickets, Henry not on it), never the read's €150.
      const added = expenses(h).filter((e) => !before.includes(e.expenseId));
      expect(added).toHaveLength(1);
      expect(added[0]!.source).toBe('booking');
      expect(added[0]!.amount.amountMinor).not.toBe(15000);
      expect(added.some((e) => e.source === 'chat')).toBe(false);
      // Exactly the turn a pass_to_chat read gets: the misread changed nothing.
      const control = setup(() => [PASS('booking')], DEFAULT_AUTO_BUY_CAP_MINOR).h;
      await control.say('h_dean', RAZZMATAZZ_ASK);
      expect(h.auditTypes()).toEqual(control.auditTypes());
    });
  }
});

describe("a forwarded message is never the forwarder's own words", () => {
  it('a whole-message forward gets no interpret_v1 read: nothing logged, no roster write', async () => {
    const { h, reads } = setup(() => [
      expense({
        amount: '500',
        participants: { kind: 'everyone', members: [], count: null, phrase: null },
      }),
    ]);
    const before = expenses(h).length;
    const event = await h.channel.injectMessage({
      from: 'h_chase',
      text: '@trav Total €500 for the boat, split with everyone',
    });
    await h.runtime.agent.handleInbound({ ...event, forwarded: true });
    expect(reads).toHaveLength(0);
    expect(expenses(h)).toHaveLength(before);
    expect(h.auditTypes()).not.toContain('roster.changed');
  });
});

describe('model-first minors rule (SAFETY minors, T-153)', () => {
  it('a minor the model reads as "in" for an adults-only plan stays off; nothing in is written', async () => {
    const TCI = JSON.parse(
      readFileSync(join(repoRoot(), 'fixtures', 'groups', 'turks-and-caicos.json'), 'utf8'),
    ) as { group: Group; members: Member[]; trip: Trip; activities: Activity[] };
    const clock = createSimulatedClock('2026-06-23T20:00:00-04:00');
    const ids = createDeterministicIdGenerator('t183');
    const stores = createMemoryStores({ clock, ids });
    stores.group.groups.create(TCI.group);
    for (const m of TCI.members) stores.group.members.upsert(m);
    stores.group.trips.create(TCI.trip);
    for (const a of TCI.activities) stores.group.trips.upsertActivity(a);
    const channel = createSimulatorChannel({
      clock,
      conversations: [
        {
          conversationId: TCI.group.conversationId,
          participants: TCI.members.map((m) => ({
            handle: m.senderId,
            displayName: m.displayName,
            memberId: m.memberId,
          })),
        },
      ],
    });
    const { model } = liveStandIn(() => [
      call('update_attendance', {
        member: 'Lily',
        status: 'in',
        plan: 'nightcap',
        night: null,
        headcount: null,
      }),
    ]);
    const runtime = createTravRuntime({
      channel,
      clock,
      ids,
      stores,
      model,
      offline: true,
      env: { TRAV_OFFLINE: '1', TRAV_STATE_DIR: tempStateDir() },
    });
    const event = await channel.injectMessage({
      from: 'h_dad',
      text: '@trav lily really wants to tag along to the nightcap',
    });
    const turn = await runtime.agent.handleInbound(event);
    expect(turn.note).toBe('roster:kept_off');
    expect(
      stores.group.trips
        .listAttendance('act_tci_nightcap')
        .find((a) => a.memberId === 'mem_tci_lily')?.status,
    ).toBeUndefined();
  });
});

describe('fast paths and offline', () => {
  it('balance asks never call the interpreter', async () => {
    const { h, reads } = setup(() => [PASS()]);
    for (const t of ['@trav settle now', '@trav who owes who', '@trav what do i owe']) {
      await h.say('h_dean', t);
    }
    expect(reads).toHaveLength(0);
  });

  it('an exact "yes" on the card is the whitelist, not the model', async () => {
    const { h, reads } = setup((req) =>
      /razzmatazz/i.test(JSON.stringify(req.messages)) ? [PASS('booking')] : [PASS()],
    );
    await h.say('h_dean', RAZZMATAZZ_ASK);
    const n = reads.length;
    await h.say('h_dean', 'yes');
    expect(reads).toHaveLength(n);
  });

  it('offline (parser_first) never makes an interpret_v1 call', async () => {
    const h = harness();
    await h.say('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry');
    await h.say('h_dean', "@trav Henry's sick");
    await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(h.model.completions.some((c) => c.systemPromptId === INTERPRET_PROMPT_ID)).toBe(false);
  });
});
