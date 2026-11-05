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
import { createInMemoryScheduler, isReaction, ledger } from '@trav/core';
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

  it('a hold ends with its window through a scheduled job: one share, then 30 quiet minutes ⇒ one notice', async () => {
    const h = harness();
    const { dm, items } = await crowleyDigest(h);
    await h.runtime.agent.handleInbound(tapItem('h_crowley', dm.id, items[0]!.id, h.clock.now()));
    expect(notices(h)).toEqual([]);
    const shared = h.runtime.stores.group.expenses
      .listByTrip(T)
      .find((e) => e.source === 'card_transaction')!;
    // The hold's end is on the scheduler, one window after the share.
    const job = h.runtime.scheduler.list().find((j) => j.kind === 'expense_notice');
    expect(job).toMatchObject({
      groupId: G,
      runAt: '2026-03-17T21:01:00+01:00',
      payload: { expenseIds: shared.expenseId },
    });
    // An unrelated message inside the window releases nothing.
    h.clock.advanceMs(10_000);
    await h.say('h_chase', 'anyone up for churros');
    expect(notices(h)).toEqual([]);
    // Then nobody says anything for 30 minutes: the job alone posts the line.
    h.clock.advanceMs(30 * 60_000);
    const turns = await h.runtime.drain();
    const noticeTurns = turns.filter((t) => t.note === 'scheduled:expense_notice');
    expect(noticeTurns).toHaveLength(1);
    expect(notices(h)).toHaveLength(1);
    expect(notices(h)[0]!.outbound?.noticeExpenseIds).toEqual([shared.expenseId]);
    expect(msgs(noticeTurns[0]!).map((m) => m.kind)).toEqual(['system_notice']);
    expect(h.runtime.scheduler.list().some((j) => j.kind === 'expense_notice')).toBe(false);
    // The other two lines, shared later, are their own line.
    await h.runtime.agent.handleInbound(tapItem('h_crowley', dm.id, items[1]!.id, h.clock.now()));
    await h.runtime.agent.handleInbound(tapItem('h_crowley', dm.id, items[2]!.id, h.clock.now()));
    expect(notices(h)).toHaveLength(2);
    expect(notices(h)[1]!.outbound?.noticeExpenseIds).toHaveLength(2);
    // The digest closed, so its job was cancelled: nothing more on the clock.
    h.clock.advanceMs(5 * 60_000);
    await h.runtime.drain();
    expect(notices(h)).toHaveLength(2);
    expectEachAnnouncedOnce(h, []);
  });
});

// ---------- undo ----------

describe('undo: an announced share taken back gets one correction line', () => {
  function loggedCards(h: Harness): TranscriptMessage[] {
    return h.channel
      .transcript()
      .filter(
        (e): e is TranscriptMessage =>
          e.type === 'message' &&
          e.lane === 'dm' &&
          e.outbound?.card?.type === 'expense_confirm' &&
          e.outbound.card.status === 'logged',
      );
  }

  it('Crowley undoes one of two announced shares ⇒ "Crowley took … off the tab", once', async () => {
    const h = harness();
    const { dm, items } = await crowleyDigest(h);
    for (const i of items.slice(0, 2)) {
      await h.runtime.agent.handleInbound(tapItem('h_crowley', dm.id, i.id, h.clock.now()));
    }
    await h.runtime.agent.handleInbound(keepItem('h_crowley', dm.id, items[2]!.id, h.clock.now()));
    expect(notices(h)).toHaveLength(1);
    const [first] = loggedCards(h);
    const target = h.runtime.stores.group.expenses.get(
      first!.outbound!.card!.type === 'expense_confirm' ? first!.outbound!.card!.expenseId : '',
    )!;
    h.clock.advanceMs(5 * 60_000);
    const undo = await h.tap('h_crowley', first!.messageId, 'undo');
    expect(h.runtime.stores.group.expenses.get(target.expenseId)?.status).toBe('undone');
    const lines = notices(h);
    expect(lines).toHaveLength(2);
    const amount = (target.amount.amountMinor / 100).toFixed(2).replace(/\.00$/, '');
    expect(lines[1]!.text).toBe(`Crowley took ${target.description} €${amount} off the tab`);
    expect(lines[1]!.outbound).toMatchObject({
      kind: 'system_notice',
      noticeCorrection: true,
      noticeExpenseIds: [target.expenseId],
    });
    expect(msgs(undo).some((m) => m.noticeCorrection === true)).toBe(true);
    // A replayed undo changes nothing and says nothing more.
    await h.tap('h_crowley', first!.messageId, 'undo');
    expect(notices(h)).toHaveLength(2);
  });

  it('a share undone while its notice was still held is never announced, and needs no correction', async () => {
    const h = harness();
    const { dm, items } = await crowleyDigest(h);
    await h.runtime.agent.handleInbound(tapItem('h_crowley', dm.id, items[0]!.id, h.clock.now()));
    const [first] = loggedCards(h);
    await h.tap('h_crowley', first!.messageId, 'undo');
    for (const i of items.slice(1)) {
      await h.runtime.agent.handleInbound(keepItem('h_crowley', dm.id, i.id, h.clock.now()));
    }
    h.clock.advanceMs(30 * 60_000);
    await h.runtime.drain();
    expect(notices(h)).toEqual([]);
  });

  it('undoing a chat expense the "logged:" card announced posts no correction notice (the card answers for itself)', async () => {
    const h = harness();
    const turn = await h.say('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry');
    const card = msgs(turn)[0]!;
    await h.react('h_dean', card.id, '👎');
    expect(h.runtime.stores.group.expenses.listByTrip(T)).toEqual([]);
    expect(notices(h)).toEqual([]);
  });
});

// ---------- the mechanism, directly ----------

describe('createExpenseNotices (unit, over seeded stores)', () => {
  /** `suppressCards`: the screen holds back every message with a card (nothing delivered). */
  function world(opts: { readonly suppressCards?: boolean } = {}) {
    const h = harness();
    const sent: Outbound[][] = [];
    const sendTurn: TurnSender = (outbounds) => {
      const held = (o: Outbound): boolean =>
        opts.suppressCards === true && !isReaction(o) && o.card !== undefined;
      sent.push(outbounds.filter((o) => !held(o)));
      return Promise.resolve(
        outbounds.map((o) => ({
          outbound: o,
          sent: held(o) ? null : { messageId: o.id, sentAt: h.clock.now(), degraded: false },
          suppressed: held(o),
          degraded: false,
          suppressions: [],
          violations: [],
        })),
      );
    };
    const scheduler = createInMemoryScheduler();
    const n = createExpenseNotices({
      stores: h.runtime.stores,
      clock: h.clock,
      ids: h.ids,
      sendTurn,
      scheduler,
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
    /** Runs every due `expense_notice` job as its own operation, as `runScheduled` does. */
    const drain = async (): Promise<void> => {
      for (const job of scheduler.drain(h.clock.now())) {
        await n.around(() => {
          n.release(job);
          return Promise.resolve(result());
        })();
      }
    };
    return { h, n, sent, write, result, scheduler, drain };
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

  it('a booking expense is queued and waits for its receipt card; the delivered receipt takes it off the queue', async () => {
    const { h, n, sent, write, result, scheduler, drain } = world();
    let id = '';
    await n.around(() => {
      id = write({ source: 'booking', sourceRef: { kind: 'booking', id: 'bkg_unit' } }).expenseId;
      return Promise.resolve(result());
    })();
    expect(sent).toEqual([]);
    expect(scheduler.list().map((j) => j.jobId)).toEqual([`expense_notice:${id}`]);
    // The receipt comes a turn later (the after-charge failure path): it is the announcement.
    await n.around(async () => {
      const card = { type: 'receipt', ledger: { expenseId: id } } as never;
      await n.sendTurn(
        [{ id: 'msg_receipt', groupId: G, to: { kind: 'group' }, text: 'booked', card }],
        {} as never,
      );
      return result();
    })();
    expect(scheduler.list()).toEqual([]);
    h.clock.advanceMs(10 * 60_000);
    await drain();
    expect(texts(sent)).toEqual(['booked']);
  });

  it('a booking whose receipt card never went out (suppressed, failed) gets its notice when the window ends', async () => {
    const { h, n, sent, write, result, drain } = world({ suppressCards: true });
    await n.around(async () => {
      const e = write({ source: 'booking', sourceRef: { kind: 'booking', id: 'bkg_unit' } });
      const card = { type: 'receipt', ledger: { expenseId: e.expenseId } } as never;
      // The screen held the receipt back: nothing delivered, so it announced nothing.
      await n.sendTurn(
        [{ id: 'msg_receipt', groupId: G, to: { kind: 'group' }, text: 'booked', card }],
        {} as never,
      );
      return result();
    })();
    expect(texts(sent)).toEqual([]);
    h.clock.advanceMs(59_000);
    await drain();
    expect(texts(sent)).toEqual([]);
    h.clock.advanceMs(1_000);
    await drain();
    expect(texts(sent)).toEqual(['Chase added item 1 €12 · 5 ways (not Henry)']);
  });

  it("per group: an operation still running in another chat never delays this chat's line", async () => {
    const { n, sent, write, result } = world();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const other = n.around(async () => {
      write({ groupId: 'grp_elsewhere', sourceRef: { kind: 'message', id: 'msg_elsewhere' } });
      await gate;
      return result();
    })();
    const here = await n.around(() => {
      write();
      return Promise.resolve(result());
    })();
    // Flushed at once although the other chat's operation is still running.
    expect(texts(sent)).toEqual(['Chase added item 2 €12 · 5 ways (not Henry)']);
    expect(here.outbound).toHaveLength(1);
    open();
    await other;
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
