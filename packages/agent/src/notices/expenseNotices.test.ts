/**
 * T-165 end to end on the real runtime (`harness()`: seeded Barcelona, the
 * simulator channel, the offline model, strict voice): every ingestion path
 * puts each confirmed expense in front of the group exactly once, private
 * sources (email, card) only after the owner's share, and notices that land
 * within ~60s share one line. Unit-level cases (undo before the flush,
 * seeding outside an operation, a failing send, overlapping operations) run
 * `createExpenseNotices` directly over the same seeded stores.
 */
import { describe, expect, it } from 'vitest';
import type { Expense, MemberId, Money, Outbound, OutboundMessage } from '@trav/core';
import { isReaction, ledger } from '@trav/core';
import type {
  InboundButtonTap,
  InboundEvent,
  TransactionsAdapter,
  TranscriptMessage,
} from '@trav/adapters';
import { createMockTransactions } from '@trav/adapters';
import { BARCELONA } from '../compose.js';
import { harness, type Harness } from '../runtime.testkit.js';
import type { TurnResult, TurnSender } from '../loop.js';
import { createExpenseNotices } from './expenseNotices.js';

const G = BARCELONA.groupId;
const T = BARCELONA.tripId;
const CROWLEY = 'mem_crowley';
const ORDER = BARCELONA.members.map((m) => m.memberId);
const eur = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });

// ---------- helpers ----------

function groupEntries(h: Harness): TranscriptMessage[] {
  return h.channel
    .groupTranscript(BARCELONA.conversationId)
    .filter((e): e is TranscriptMessage => e.type === 'message' && e.direction === 'outbound');
}

function notices(h: Harness): TranscriptMessage[] {
  return groupEntries(h).filter((e) => e.systemNotice);
}

/** How many times each expense on the tab reached the group: its group card, or a notice line. */
function announcements(h: Harness): Map<string, number> {
  const n = new Map<string, number>();
  const bump = (id: string): void => {
    n.set(id, (n.get(id) ?? 0) + 1);
  };
  for (const e of groupEntries(h)) {
    const card = e.outbound?.card;
    if (card?.type === 'receipt') bump(card.ledger.expenseId);
    if (card?.type === 'expense_confirm' && card.visibility === 'group' && card.status === 'logged')
      bump(card.expenseId);
    for (const id of e.outbound?.noticeExpenseIds ?? []) bump(id);
  }
  return n;
}

function expectEachAnnouncedOnce(h: Harness, before: readonly string[] = []): Expense[] {
  const fresh = h.runtime.stores.group.expenses
    .listByTrip(T)
    .filter((e) => !before.includes(e.expenseId));
  const counts = announcements(h);
  expect(fresh.length).toBeGreaterThan(0);
  for (const e of fresh) expect(counts.get(e.expenseId) ?? 0, e.description).toBe(1);
  return fresh;
}

function tabIds(h: Harness): string[] {
  return h.runtime.stores.group.expenses.listByTrip(T).map((e) => e.expenseId);
}

function emptyResult(): TurnResult {
  return {
    outbound: [],
    toolCalls: [],
    auditEventIds: [],
    silent: true,
    modelSources: [],
    note: 'unit',
  };
}

function msgs(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o));
}

function setCardConsent(h: Harness, memberId: MemberId): void {
  h.runtime.stores.private.putConsent(memberId, {
    memberId,
    groupId: G,
    photos: false,
    roast: false,
    cardImport: true,
    emailImport: false,
    memoryAcrossTrips: false,
    updatedAt: h.clock.now(),
  });
}

function tapItem(
  from: string,
  cardMessageId: string,
  itemId: string,
  at: string,
): InboundButtonTap {
  return {
    type: 'button_tap',
    channel: 'simulator',
    conversationId: `dm:${from}`,
    lane: 'dm',
    receivedAt: at,
    sender: from,
    messageId: `in_${from}_${itemId}_${at}`,
    cardMessageId,
    cardId: 'card_x',
    actionId: 'confirm',
    value: itemId,
  };
}

function keepItem(from: string, cardMessageId: string, itemId: string, at: string): InboundEvent {
  return { ...tapItem(from, cardMessageId, itemId, at), actionId: 'keep_private' };
}

function importCrowley(h: Harness, adapter: TransactionsAdapter = createMockTransactions()) {
  return h.runtime.agent.importCardTransactions({ groupId: G, ownerMemberId: CROWLEY, adapter });
}

/** Crowley's three-line "looks shared?" digest (the mock card, late in the trip). */
async function crowleyDigest(h: Harness) {
  h.clock.set('2026-03-17T21:00:00+01:00');
  setCardConsent(h, CROWLEY);
  const r = await importCrowley(h);
  const dm = msgs(r)[0]!;
  const items = h.runtime.stores.private.listPendingItems(CROWLEY, G, 'pending');
  expect(items).toHaveLength(3);
  expect(items.every((i) => i.cardMessageId === dm.id)).toBe(true);
  return { dm, items };
}

// ---------- every ingestion path ----------

describe('every ingestion path: each confirmed expense reaches the group exactly once', () => {
  it('chat text in the group: the "logged:" card is the announcement, no extra notice line', async () => {
    const h = harness();
    const before = tabIds(h);
    const turn = await h.say('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry');
    expect(turn.note).toBe('expense:logged');
    expect(notices(h)).toEqual([]);
    expect(msgs(turn).every((m) => m.kind === undefined)).toBe(true);
    expectEachAnnouncedOnce(h, before);
  });

  it('receipt photo: nothing before the poster\'s 👍; then the "logged:" card, no extra notice', async () => {
    const h = harness();
    const before = tabIds(h);
    const read = await h.say('h_piotr', "@trav dinner, i paid, Arjun didn't drink", {
      attachments: [
        { kind: 'image', mimeType: 'image/png', uri: 'fixtures/receipts/rcpt_bcn_gatblau.png' },
      ],
    });
    expect(read.note).toBe('receipt:read');
    expect(notices(h)).toEqual([]);
    const ok = await h.react('h_piotr', msgs(read)[0]!.id, '👍');
    expect(ok.note).toBe('receipt:logged');
    expect(notices(h)).toEqual([]);
    expectEachAnnouncedOnce(h, before);
  });

  it('booking (Razzmatazz): the group receipt card is the announcement, no notice line', async () => {
    const h = harness();
    const before = tabIds(h);
    const ask = await h.say('h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
    const card = msgs(ask).find((m) => m.card?.type === 'booking_proposal');
    if (card !== undefined) await h.tap('h_dean', card.id, 'approve');
    expect(groupEntries(h).some((e) => e.outbound?.card?.type === 'receipt')).toBe(true);
    expect(notices(h)).toEqual([]);
    const [razz] = expectEachAnnouncedOnce(h, before);
    expect(razz!.sourceRef.kind).toBe('booking');
  });

  // The single-charge card share (exact text, no descriptor) is in ingest/card.test.ts;
  // the email share (exact text, nothing before it) in ingest/email.test.ts and intake.test.ts.
  it('card transactions: nothing in the group before Crowley answers; his shares reach it once each, as notice lines', async () => {
    const h = harness();
    const before = tabIds(h);
    const { dm, items } = await crowleyDigest(h);
    expect(groupEntries(h)).toEqual([]);
    for (const i of items) {
      await h.runtime.agent.handleInbound(tapItem('h_crowley', dm.id, i.id, h.clock.now()));
    }
    expect(notices(h)).toHaveLength(1);
    expect(notices(h)[0]!.text.startsWith('Crowley added ')).toBe(true);
    // Built from the tab entries: no account, provider transaction id or card digits.
    const payload = JSON.stringify(groupEntries(h));
    for (const leak of ['acc_', 'txn_', 'last4', 'merchantRaw']) {
      expect(payload).not.toContain(leak);
    }
    expectEachAnnouncedOnce(h, before);
  });

  it('a payment stated in a DM logs nothing on this build, so nothing is announced', async () => {
    const h = harness();
    const before = tabIds(h);
    await h.dm('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry');
    expect(tabIds(h)).toEqual(before);
    expect(notices(h)).toEqual([]);
  });
});

// ---------- batching ----------

describe('batching: notices that land within ~60s share one line', () => {
  it('Crowley shares two lines of a digest 20s apart and keeps the third private ⇒ one line, after the last answer', async () => {
    const h = harness();
    const { dm, items } = await crowleyDigest(h);
    const [a, b, c] = items;
    const t0 = h.clock.now();
    const first = await h.runtime.agent.handleInbound(tapItem('h_crowley', dm.id, a!.id, t0));
    expect(first.note).toBe('looks_shared:shared');
    // Held: the digest still has open lines.
    expect(notices(h)).toEqual([]);
    h.clock.advanceMs(20_000);
    await h.runtime.agent.handleInbound(tapItem('h_crowley', dm.id, b!.id, h.clock.now()));
    expect(notices(h)).toEqual([]);
    h.clock.advanceMs(10_000);
    const last = await h.runtime.agent.handleInbound(
      keepItem('h_crowley', dm.id, c!.id, h.clock.now()),
    );
    const lines = notices(h);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text.startsWith('Crowley added ')).toBe(true);
    expect(lines[0]!.outbound?.noticeExpenseIds).toHaveLength(2);
    expect(msgs(last).some((m) => m.kind === 'system_notice')).toBe(true);
    expectEachAnnouncedOnce(h, []);
  });

  it('answering the whole digest in one go: every share goes out in one line', async () => {
    const h = harness();
    const { dm, items } = await crowleyDigest(h);
    for (const i of items) {
      await h.runtime.agent.handleInbound(tapItem('h_crowley', dm.id, i.id, h.clock.now()));
    }
    const lines = notices(h);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.outbound?.noticeExpenseIds).toHaveLength(3);
  });

  it('a hold never outlives the window: past 60s it goes out with the next thing that happens, on its own line', async () => {
    const h = harness();
    const { dm, items } = await crowleyDigest(h);
    await h.runtime.agent.handleInbound(tapItem('h_crowley', dm.id, items[0]!.id, h.clock.now()));
    expect(notices(h)).toEqual([]);
    h.clock.advanceMs(61_000);
    await h.say('h_chase', 'anyone up for churros');
    expect(notices(h)).toHaveLength(1);
    expect(notices(h)[0]!.outbound?.noticeExpenseIds).toHaveLength(1);
    // The other two lines, shared later, are their own line.
    h.clock.advanceMs(5_000);
    await h.runtime.agent.handleInbound(tapItem('h_crowley', dm.id, items[1]!.id, h.clock.now()));
    await h.runtime.agent.handleInbound(tapItem('h_crowley', dm.id, items[2]!.id, h.clock.now()));
    expect(notices(h)).toHaveLength(2);
    expect(notices(h)[1]!.outbound?.noticeExpenseIds).toHaveLength(2);
    expectEachAnnouncedOnce(h, []);
  });
});

// ---------- the mechanism, directly ----------

describe('createExpenseNotices (unit, over seeded stores)', () => {
  function world() {
    const h = harness();
    const sent: Outbound[][] = [];
    const sendTurn: TurnSender = (outbounds) => {
      sent.push([...outbounds]);
      return Promise.resolve(
        outbounds.map((o) => ({
          outbound: o,
          sent: { messageId: o.id, sentAt: h.clock.now(), degraded: false },
          suppressed: false,
          degraded: false,
          suppressions: [],
          violations: [],
        })),
      );
    };
    const n = createExpenseNotices({
      stores: h.runtime.stores,
      clock: h.clock,
      ids: h.ids,
      sendTurn,
    });
    let k = 0;
    const write = (over: Partial<Expense> = {}): Expense => {
      k++;
      const e: Expense = {
        expenseId: `exp_unit_${String(k)}`,
        groupId: G,
        tripId: T,
        description: `item ${String(k)}`,
        category: 'other',
        amount: eur(1200),
        paidBy: [{ memberId: 'mem_chase', amount: eur(1200) }],
        split: { method: 'exclude', excluded: ['mem_henry'] },
        source: 'chat',
        sourceRef: { kind: 'message', id: `msg_unit_${String(k)}` },
        occurredAt: h.clock.now(),
        createdAt: h.clock.now(),
        createdBy: 'mem_chase',
        status: 'logged',
        ...over,
      };
      h.runtime.stores.group.expenses.create(
        e,
        ledger.buildLedgerEntries(e, { memberOrder: ORDER, participantsUniverse: ORDER }),
      );
      return e;
    };
    const result = (): TurnResult => emptyResult();
    return { h, n, sent, write, result };
  }

  const texts = (sent: Outbound[][]): string[] =>
    sent.flat().map((o) => (isReaction(o) ? '' : o.text));

  it('writes outside an operation (seeding, fixtures) are never announced', async () => {
    const { n, sent, write, result } = world();
    write();
    await n.around(() => Promise.resolve(result()))();
    expect(sent).toEqual([]);
  });

  it("one operation, two expenses: one line; the notice is appended to the operation's outbound", async () => {
    const { n, sent, write, result } = world();
    const r = await n.around(() => {
      write();
      write();
      return Promise.resolve(result());
    })();
    expect(texts(sent)).toEqual(['Chase added item 1 €12 (5 ways) and item 2 €12 (5 ways)']);
    expect(r.outbound).toHaveLength(1);
    expect(r.silent).toBe(false);
  });

  it('inside one long operation, expenses more than 60s apart are separate lines', async () => {
    const { h, n, sent, write, result } = world();
    await n.around(() => {
      write();
      h.clock.advanceMs(61_000);
      write();
      return Promise.resolve(result());
    })();
    expect(texts(sent)).toEqual([
      'Chase added item 1 €12 · 5 ways (not Henry)',
      'Chase added item 2 €12 · 5 ways (not Henry)',
    ]);
  });

  it('undone before the operation ends: nothing to announce', async () => {
    const { h, n, sent, write, result } = world();
    await n.around(() => {
      const e = write();
      h.runtime.stores.group.expenses.replace({ ...e, status: 'undone' }, []);
      return Promise.resolve(result());
    })();
    expect(sent).toEqual([]);
  });

  it('a booking expense is left to its receipt card', async () => {
    const { n, sent, write, result } = world();
    await n.around(() => {
      write({ source: 'booking', sourceRef: { kind: 'booking', id: 'bkg_unit' } });
      return Promise.resolve(result());
    })();
    expect(sent).toEqual([]);
  });

  it('an expense a delivered group card already showed gets no second line', async () => {
    const { n, sent, write, result } = world();
    await n.around(async () => {
      const e = write();
      const card = {
        type: 'expense_confirm',
        expenseId: e.expenseId,
        status: 'logged',
        visibility: 'group',
      } as never;
      await n.sendTurn(
        [{ id: 'msg_card', groupId: G, to: { kind: 'group' }, text: 'logged: …', card }],
        {} as never,
      );
      return result();
    })();
    expect(sent).toHaveLength(1); // only the card itself
    expect(texts(sent)).toEqual(['logged: …']);
  });

  it('overlapping operations: the last one to finish sends the line for both', async () => {
    const { n, sent, write, result } = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = n.around(async () => {
      write();
      await gate;
      return result();
    })();
    const fast = await n.around(() => {
      write();
      return Promise.resolve(result());
    })();
    expect(fast.outbound).toEqual([]);
    expect(sent).toEqual([]);
    release();
    const r = await slow;
    expect(r.outbound).toHaveLength(1);
    expect(texts(sent)).toHaveLength(1);
  });

  it('a failing send never fails the operation; it is noted', async () => {
    const h = harness();
    const n = createExpenseNotices({
      stores: h.runtime.stores,
      clock: h.clock,
      ids: h.ids,
      sendTurn: () => Promise.reject(new Error('channel down')),
    });
    const r = await n.around(() => {
      const e: Expense = {
        expenseId: 'exp_fail',
        groupId: G,
        tripId: T,
        description: 'x',
        category: 'other',
        amount: eur(600),
        paidBy: [{ memberId: 'mem_dean', amount: eur(600) }],
        split: { method: 'exclude', excluded: [] },
        source: 'chat',
        sourceRef: { kind: 'message', id: 'msg_fail' },
        occurredAt: h.clock.now(),
        createdAt: h.clock.now(),
        createdBy: 'mem_dean',
        status: 'logged',
      };
      h.runtime.stores.group.expenses.create(
        e,
        ledger.buildLedgerEntries(e, { memberOrder: ORDER, participantsUniverse: ORDER }),
      );
      return Promise.resolve(emptyResult());
    })();
    expect(r.note).toBe('unit · notice_failed:1');
    expect(r.outbound).toEqual([]);
  });

  it('dispose stops listening', async () => {
    const { n, sent, write, result } = world();
    n.dispose();
    await n.around(() => {
      write();
      return Promise.resolve(result());
    })();
    expect(sent).toEqual([]);
  });
});
