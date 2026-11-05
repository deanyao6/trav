/**
 * T-067: card import on the simulated clock, end to end on the real runtime.
 *
 *  - the runtime's Plaid-shaped mock only returns charges that already
 *    happened, so a sync the morning after Razzmatazz yields Sam's one Uber,
 *    and later-day charges arrive only at the first slot after they happen;
 *  - a scheduled `card_import` job per consenting owner at the VOICE §2
 *    digest slots (10:00 / 20:00 trip time), consent-gated (off ⇒ the
 *    provider is never called and the job stops; on again ⇒ re-queued; a
 *    minor is never queued), every run audited owner-only;
 *  - between slots (`delivery: 'next_digest'`) two or more prompts wait for
 *    the next slot and go out as one DM there;
 *  - a charge the owner already shared that then posts at another amount
 *    updates the ledger line (or asks, when the tab can't simply follow).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Expense, MemberId, Money, OutboundMessage, Outbound, ScheduledJob } from '@trav/core';
import { audit as coreAudit, ledger, safety } from '@trav/core';
import type {
  LinkedAccount,
  MockTransactionsAdapter,
  ProviderTransaction,
  TransactionsSyncResult,
} from '@trav/adapters';
import { createMockTransactions } from '@trav/adapters';
import { BARCELONA } from '../compose.js';
import { repoRoot } from '../model/paths.js';
import { harness, optIn, type Harness } from '../runtime.testkit.js';
import {
  atCardImportSlot,
  cardImportJobId,
  cardImportJobsFor,
  cardImportSlots,
  nextCardImportSlot,
} from './cardSchedule.js';
import { postedAskText, postedUpdatedText } from './card.js';
import { importOffText } from './intake.js';

const G = BARCELONA.groupId;
const T = BARCELONA.tripId;
const SAM = 'mem_sam';
const eur = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });

const SAM_FX = JSON.parse(
  readFileSync(join(repoRoot(), 'fixtures', 'transactions', 'mem_sam.json'), 'utf8'),
) as {
  readonly accounts: readonly LinkedAccount[];
  readonly pages: readonly { readonly result: TransactionsSyncResult }[];
};
const allRows = (): ProviderTransaction[] => SAM_FX.pages.flatMap((p) => [...p.result.added]);
const UBER_PENDING = allRows().find((t) => t.transactionId === 'txn_sam_uber_0315_p')!;

const BARCELONA_TRIP = {
  tripId: T,
  groupId: G,
  timeZone: 'Europe/Madrid',
  startDate: '2026-03-12',
  endDate: '2026-03-17',
};

function henryOut(h: Harness): void {
  const razz = h.runtime.stores.group.trips.listActivities(T)[0]!;
  h.runtime.stores.group.trips.setAttendance({
    activityId: razz.activityId,
    memberId: 'mem_henry',
    status: 'out',
    updatedAt: '2026-03-14T20:00:00+01:00',
    sourceMessageId: 'msg_henry_sick',
    setBy: 'mem_dean',
  });
}

function setConsent(h: Harness, memberId: MemberId, cardImport: boolean): void {
  h.runtime.stores.private.putConsent(memberId, {
    memberId,
    groupId: G,
    photos: false,
    roast: false,
    cardImport,
    emailImport: false,
    memoryAcrossTrips: false,
    updatedAt: h.clock.now(),
  });
}

/** Sam's €28 of waters, logged from chat at the club (fixtures/chats/barcelona.jsonl msg_bcn_0139). */
function watersOnTab(h: Harness): void {
  const order = BARCELONA.members.map((m) => m.memberId);
  const expense: Expense = {
    expenseId: 'exp_waters',
    groupId: G,
    tripId: T,
    description: 'waters at Razzmatazz',
    category: 'drinks',
    amount: eur(2800),
    paidBy: [{ memberId: SAM, amount: eur(2800) }],
    split: { method: 'equal', participants: [SAM, 'mem_maya'] },
    source: 'chat',
    sourceRef: { kind: 'message', id: 'msg_waters' },
    occurredAt: '2026-03-15T01:30:00+01:00',
    createdAt: '2026-03-15T01:30:00+01:00',
    createdBy: SAM,
    status: 'logged',
  };
  h.runtime.stores.group.expenses.create(
    expense,
    ledger.buildLedgerEntries(expense, { memberOrder: order, participantsUniverse: order }),
  );
}

function msg(o: Outbound | undefined): OutboundMessage {
  if (o === undefined || ('kind' in o && o.kind === 'reaction'))
    throw new Error('expected a message');
  return o as OutboundMessage;
}

const samJob = (h: Harness): ScheduledJob | undefined =>
  h.runtime.scheduler.list().find((j) => j.jobId === cardImportJobId(T, SAM));

async function at(h: Harness, iso: string) {
  h.clock.set(iso);
  return h.runtime.drain();
}

const samDms = (h: Harness): OutboundMessage[] =>
  h.runtime.turns
    .flatMap((t) => t.outbound)
    .filter((o): o is OutboundMessage => !('kind' in o && o.kind === 'reaction'))
    .filter((o) => o.to.kind === 'member' && o.to.memberId === SAM);

const runs = (h: Harness) => h.audit().filter((e) => e.type === 'card_import.ran');

const provider = (h: Harness): MockTransactionsAdapter =>
  h.runtime.transactions as MockTransactionsAdapter;

// ---------- pure schedule ----------

describe('card import slots (VOICE §2 digest times)', () => {
  it('10:00 and 20:00 trip time, from the day before the trip to the day after', () => {
    const trip = BARCELONA_TRIP;
    const slots = cardImportSlots(trip);
    expect(slots[0]).toBe('2026-03-11T10:00:00+01:00');
    expect(slots[1]).toBe('2026-03-11T20:00:00+01:00');
    expect(slots.at(-1)).toBe('2026-03-18T20:00:00+01:00');
    expect(slots).toHaveLength(16);
    expect(nextCardImportSlot(trip, '2026-03-15T09:00:00+01:00')).toBe('2026-03-15T10:00:00+01:00');
    // Strictly after: a job that just ran at 10:00 queues 20:00.
    expect(nextCardImportSlot(trip, '2026-03-15T10:00:00+01:00')).toBe('2026-03-15T20:00:00+01:00');
    expect(nextCardImportSlot(trip, '2026-03-18T20:00:00+01:00')).toBeUndefined();
  });

  it('a clock jump that lands within an hour after a slot counts as that slot; anything else is stale', () => {
    const trip = BARCELONA_TRIP;
    expect(atCardImportSlot(trip, '2026-03-15T10:00:00+01:00')).toBe(true);
    expect(atCardImportSlot(trip, '2026-03-15T11:00:00+01:00')).toBe(true);
    expect(atCardImportSlot(trip, '2026-03-15T11:01:00+01:00')).toBe(false);
    expect(atCardImportSlot(trip, '2026-03-15T09:59:00+01:00')).toBe(false);
  });

  it('queued only for consenting active adults: consent off, a minor or a guest never get a job', () => {
    const h = harness();
    const stores = h.runtime.stores;
    const now = h.clock.now();
    expect(cardImportJobsFor(stores, now)).toEqual([]);
    setConsent(h, SAM, true);
    setConsent(h, 'mem_maya', true);
    const maya = stores.group.members.listByGroup(G).find((m) => m.memberId === 'mem_maya')!;
    stores.group.members.upsert({ ...maya, birthDate: '2010-05-01', ageBand: 'under18' });
    const jobs = cardImportJobsFor(stores, now);
    expect(jobs).toEqual([
      {
        jobId: cardImportJobId(T, SAM),
        groupId: G,
        tripId: T,
        kind: 'card_import',
        runAt: '2026-03-15T10:00:00+01:00',
        payload: { ownerMemberId: SAM },
      },
    ]);
    // Already queued ⇒ not again.
    expect(cardImportJobsFor(stores, now, new Set([cardImportJobId(T, SAM)]))).toEqual([]);
  });
});

// ---------- the runtime ----------

describe('scheduled card import on the simulated clock (T-067)', () => {
  it('"card import on" queues the next slot; the 10am sync the morning after asks about the €23.40 Uber only; later charges wait for their day', async () => {
    const h = harness(); // Saturday 9:40pm, Razzmatazz night
    henryOut(h);
    expect(samJob(h)).toBeUndefined();
    await optIn(h, 'h_sam', 'card');
    expect(samJob(h)?.runAt).toBe('2026-03-15T10:00:00+01:00');
    watersOnTab(h);

    const morning = await at(h, '2026-03-15T10:00:00+01:00');
    const job = morning.find((t) => t.note.startsWith('scheduled:card_import:'))!;
    expect(job.note).toBe('scheduled:card_import:imported');
    expect(job.outbound).toHaveLength(1);
    const dm = msg(job.outbound[0]);
    expect(dm.to).toEqual({ kind: 'member', memberId: SAM });
    expect(dm.text).toBe(
      'saw €23.40 from Uber at 2:14am, that the ride back from razzmatazz?\nlooks shared. 👍 to split with the 5 who went, 👎 to keep it off the tab',
    );
    // The rows Sam's private store holds: nothing dated after now.
    const rows = h.runtime.stores.private.listCardTransactions(SAM, G);
    expect(rows.every((r) => r.postedAt <= '2026-03-15T10:00:00+01:00')).toBe(true);
    expect(rows.some((r) => r.providerTransactionId === 'txn_sam_apolo_0316')).toBe(false);

    // Audited, owner-only, counts and status only.
    const ran = runs(h);
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({
      visibility: 'owner',
      ownerId: SAM,
      actor: { kind: 'system', id: 'scheduler' },
      payload: {
        jobId: cardImportJobId(T, SAM),
        slot: '2026-03-15T10:00:00+01:00',
        status: 'imported',
        prompted: 1,
        messages: 1,
      },
    });
    expect(coreAudit.findPrivatePayloadKeys(ran[0]!.payload)).toEqual([]);
    expect(JSON.stringify(ran[0]!.payload)).not.toMatch(/2340|uber|23\.40/i);
    // Nothing reached the group.
    expect(JSON.stringify(h.channel.groupTranscript(BARCELONA.conversationId))).not.toMatch(
      /23\.40/,
    );
    // The job queued its next slot.
    expect(samJob(h)?.runAt).toBe('2026-03-15T20:00:00+01:00');

    // Monday 10am: the 2:30am pizza and the 11:00 refund came in (personal, not asked); no Apolo yet (5:05pm).
    const before = samDms(h).length;
    await at(h, '2026-03-16T10:00:00+01:00');
    expect(samDms(h)).toHaveLength(before);
    expect(
      h.runtime.stores.private
        .listCardTransactions(SAM, G)
        .some((r) => r.providerTransactionId === 'txn_sam_apolo_0316'),
    ).toBe(false);
    // Monday 8pm: the Apolo charge (5:05pm) is there now, and it's asked about once.
    const evening = await at(h, '2026-03-16T20:00:00+01:00');
    const apolo = evening.find((t) => t.note === 'scheduled:card_import:imported')!;
    expect(apolo.outbound).toHaveLength(1);
    expect(msg(apolo.outbound[0]).text).toMatch(/^saw €90 from Sala Apolo at 5:05pm/);
    expect(runs(h).map((e) => e.payload['status'])).toEqual(['imported', 'imported', 'imported']);
    for (const t of [job, apolo]) {
      for (const o of t.outbound) expect(safety.lintVoice(msg(o).text, 'dm').ok).toBe(true);
    }
  });

  it('consent off: the job runs, never calls the provider, and stops; "card import on" again re-queues it', async () => {
    const h = harness();
    await optIn(h, 'h_sam', 'card');
    expect(samJob(h)).toBeDefined();
    await h.dm('h_sam', 'card import off');
    const syncsBefore = provider(h).syncCount();
    const turns = await at(h, '2026-03-15T10:00:00+01:00');
    expect(turns.find((t) => t.note.startsWith('scheduled:card_import:'))?.note).toBe(
      'scheduled:card_import:consent_off',
    );
    expect(provider(h).syncCount()).toBe(syncsBefore);
    expect(runs(h).map((e) => e.payload['status'])).toEqual(['consent_off']);
    expect(samJob(h)).toBeUndefined();
    expect(h.runtime.stores.private.listCardTransactions(SAM, G)).toEqual([]);

    await optIn(h, 'h_sam', 'card');
    expect(samJob(h)?.runAt).toBe('2026-03-15T20:00:00+01:00');
  });

  it('a minor who asks for card import is never queued or synced', async () => {
    const h = harness();
    const sam = h.runtime.stores.group.members.listByGroup(G).find((m) => m.memberId === SAM)!;
    h.runtime.stores.group.members.upsert({ ...sam, birthDate: '2010-05-01', ageBand: 'under18' });
    await h.dm('h_sam', 'card import on');
    setConsent(h, SAM, true); // even with the flag forced on
    await h.dm('h_sam', 'hi');
    expect(samJob(h)).toBeUndefined();
    const syncs = provider(h).syncCount();
    await at(h, '2026-03-15T10:00:00+01:00');
    expect(provider(h).syncCount()).toBe(syncs);
    expect(runs(h)).toEqual([]);
  });

  it('a job drained after a jump past its slot is stale: no sync, audited, and it waits for the next slot', async () => {
    const h = harness();
    await optIn(h, 'h_sam', 'card');
    const syncs = provider(h).syncCount();
    const turns = await at(h, '2026-03-15T15:00:00+01:00');
    expect(turns.find((t) => t.note.startsWith('scheduled:card_import:'))?.note).toBe(
      'scheduled:card_import:stale',
    );
    expect(provider(h).syncCount()).toBe(syncs);
    expect(runs(h)[0]?.payload).toMatchObject({ status: 'stale' });
    expect(samJob(h)?.runAt).toBe('2026-03-15T20:00:00+01:00');
  });

  it('a provider that throws: the job stays silent (nothing in the group), is audited as failed, and tries the next slot', async () => {
    const broken = {
      info: { provider: 'broken', mode: 'mock' as const },
      listAccounts: () => Promise.reject(new Error('boom')),
      sync: () => Promise.reject(new Error('boom')),
      disconnect: () => Promise.resolve({ ok: true as const, value: undefined }),
    };
    const h = harness({ runtime: { transactions: broken } });
    await optIn(h, 'h_sam', 'card');
    const groupBefore = h.channel.groupTranscript(BARCELONA.conversationId).length;
    const turns = await at(h, '2026-03-15T10:00:00+01:00');
    const job = turns.find((t) => t.note.startsWith('scheduled:card_import:'))!;
    expect(job).toMatchObject({ silent: true, outbound: [] });
    expect(job.note).toMatch(/^scheduled:card_import:failed/);
    expect(h.channel.groupTranscript(BARCELONA.conversationId).length).toBe(
      groupBefore +
        turns.filter((t) => !t.note.startsWith('scheduled:card_import:')).flatMap((t) => t.outbound)
          .length,
    );
    expect(runs(h).map((e) => e.payload['status'])).toEqual(['failed']);
    expect(samJob(h)?.runAt).toBe('2026-03-15T20:00:00+01:00');
  });

  it('T-090: an owner-asked sync with import off sends one DM line on how to turn it on, provider untouched; a scheduled one never does', async () => {
    const h = harness();
    h.clock.set('2026-03-15T09:00:00+01:00');
    const syncs = provider(h).syncCount();
    const r = await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: SAM,
      consentHint: true,
    });
    expect(r.status).toBe('consent_off');
    expect(provider(h).syncCount()).toBe(syncs);
    expect(r.outbound).toHaveLength(1);
    expect(msg(r.outbound[0])).toMatchObject({
      to: { kind: 'member', memberId: SAM },
      text: importOffText('cardImport'),
    });
    expect(
      h.channel
        .groupTranscript(BARCELONA.conversationId)
        .some((e) => /import/.test(JSON.stringify(e))),
    ).toBe(false);
    // Without the flag (what the scheduled job passes): silence.
    const quiet = await h.runtime.agent.importCardTransactions({ groupId: G, ownerMemberId: SAM });
    expect(quiet.outbound).toEqual([]);
  });

  it("r1 #6: only the group's current trip gets card-import jobs (one card, one sync position)", async () => {
    const h = harness();
    const stores = h.runtime.stores;
    const current = stores.group.trips.current(G, h.clock.now())!;
    stores.group.trips.create({
      ...current,
      tripId: 'trip_bcn_later',
      name: 'Barcelona again',
      startDate: '2026-06-12',
      endDate: '2026-06-15',
      status: 'planning',
    });
    setConsent(h, SAM, true);
    const jobs = cardImportJobsFor(stores, h.clock.now());
    expect(jobs.map((j) => j.tripId)).toEqual([
      stores.group.trips.current(G, h.clock.now())!.tripId,
    ]);
  });

  it('no provider (transactions: false): nothing is queued', async () => {
    const h = harness({ runtime: { transactions: false } });
    await optIn(h, 'h_sam', 'card');
    expect(samJob(h)).toBeUndefined();
    expect(h.runtime.transactions).toBeUndefined();
  });
});

describe('between digest slots (VOICE §2 batching)', () => {
  it('one new charge is asked about now; two or more wait for the next slot and go out there as one DM', async () => {
    const h = harness();
    henryOut(h);
    setConsent(h, SAM, true);
    h.clock.set('2026-03-15T09:00:00+01:00');
    // The waters are not on the tab here: two shared-looking charges at once.
    const r = await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: SAM,
      delivery: 'next_digest',
    });
    expect(r.status).toBe('imported');
    expect(r.prompted).toHaveLength(2);
    expect(r.held).toEqual(r.prompted);
    expect(r.outbound).toEqual([]);
    const items = h.runtime.stores.private.listPendingItems(SAM, G, 'pending');
    expect(items.every((i) => i.heldForDigest === true && i.cardMessageId === undefined)).toBe(
      true,
    );
    // A held item has no card yet: a typed "yes" can't share it.
    await h.dm('h_sam', 'yes');
    expect(
      h.runtime.stores.group.expenses.listByTrip(T).some((e) => e.source === 'card_transaction'),
    ).toBe(false);
    expect(samJob(h)?.runAt).toBe('2026-03-15T10:00:00+01:00');

    const turns = await at(h, '2026-03-15T10:00:00+01:00');
    const job = turns.find((t) => t.note === 'scheduled:card_import:imported')!;
    // The slot releases what was held as ONE digest DM (VOICE §2), even for two items.
    expect(job.outbound).toHaveLength(1);
    const digest = msg(job.outbound[0]);
    expect(digest.to).toEqual({ kind: 'member', memberId: SAM });
    expect(digest.text.split('\n')[0]).toBe(
      '2 charges that look shared, 👍 each one you want on the tab:',
    );
    expect(safety.lintVoice(digest.text, 'dm').ok).toBe(true);
    const after = h.runtime.stores.private.listPendingItems(SAM, G, 'pending');
    expect(after).toHaveLength(2);
    expect(after.every((i) => i.heldForDigest === undefined && i.cardMessageId === digest.id)).toBe(
      true,
    );
    const uber = after.find((i) => i.amount.amountMinor === 2340)!;
    const event = await h.channel.injectButtonTap({
      from: 'h_sam',
      cardMessageId: digest.id,
      actionId: 'confirm',
      value: uber.id,
    });
    const tap = await h.runtime.agent.handleInbound(event);
    expect(tap.note).toBe('looks_shared:shared');
  });

  it("after the trip's last digest slot there is nothing to wait for: two new charges go out now", async () => {
    const h = harness();
    setConsent(h, SAM, true);
    h.clock.set('2026-03-18T21:00:00+01:00'); // past the last slot (Mar 18, 8pm)
    const r = await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: SAM,
      delivery: 'next_digest',
    });
    expect(r.status).toBe('imported');
    expect(r.prompted.length).toBeGreaterThanOrEqual(2);
    expect(r.held).toEqual([]);
    expect(r.outbound.length).toBeGreaterThan(0);
    expect(
      h.runtime.stores.private
        .listPendingItems(SAM, G, 'pending')
        .every((i) => i.heldForDigest === undefined && i.cardMessageId !== undefined),
    ).toBe(true);
    expect(samJob(h)).toBeUndefined(); // no slot left to queue
  });

  it('a single new charge between slots is not held', async () => {
    const h = harness();
    henryOut(h);
    setConsent(h, SAM, true);
    watersOnTab(h);
    h.clock.set('2026-03-15T09:00:00+01:00');
    const r = await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: SAM,
      delivery: 'next_digest',
    });
    expect(r.held).toEqual([]);
    expect(r.outbound).toHaveLength(1);
    expect(msg(r.outbound[0]).text).toMatch(/^saw €23\.40 from Uber at 2:14am/);
    // The runtime's cursor was saved: the 10am job finds nothing new.
    const turns = await at(h, '2026-03-15T10:00:00+01:00');
    const job = turns.find((t) => t.note.startsWith('scheduled:card_import:'))!;
    expect(job.note).toBe('scheduled:card_import:imported');
    expect(job.outbound).toEqual([]);
  });
});

// ---------- posted after shared ----------

/** Sam's card with only the €19.80 pending authorization; the posted row is pushed later. */
function pendingOnlyAdapter(h: Harness): MockTransactionsAdapter {
  return createMockTransactions({
    clock: h.clock,
    fixtures: [
      {
        ownerMemberId: SAM,
        accounts: SAM_FX.accounts,
        pages: [{ added: [UBER_PENDING], modified: [], removed: [] }],
      },
    ],
  });
}

async function sharePending(h: Harness, adapter: MockTransactionsAdapter) {
  const first = await h.runtime.agent.importCardTransactions({
    groupId: G,
    ownerMemberId: SAM,
    adapter,
  });
  expect(first.prompted).toHaveLength(1);
  const card = msg(first.outbound[0]);
  expect(card.text).toMatch(/^saw €19\.80 from Uber/);
  const tap = await h.tap('h_sam', card.id, 'confirm');
  expect(tap.note).toBe('looks_shared:shared');
  const expense = h.runtime.stores.group.expenses
    .listByTrip(T)
    .find((e) => e.source === 'card_transaction')!;
  expect(expense.amount).toEqual(eur(1980));
  const logged = msg(tap.outbound[0]);
  expect(logged.text).toMatch(/^logged: /);
  return { first, expense, logged };
}

const samRawNames = (h: Harness): string[] =>
  h.runtime.stores.private.listCardTransactions(SAM, G).map((t) => t.merchantRaw);

function postUber(adapter: MockTransactionsAdapter, amount: Money): void {
  const posted = allRows().find((t) => t.transactionId === 'txn_sam_uber_0315')!;
  const pushed = adapter.pushUpdate(SAM, {
    added: [{ ...posted, amount }],
  });
  expect(pushed.ok).toBe(true);
}

const sharesOf = (h: Harness, expenseId: string): Record<string, number> =>
  Object.fromEntries(
    h.runtime.stores.group.expenses
      .listEntries(T)
      .filter((e) => e.expenseId === expenseId && e.kind === 'owes')
      .map((e) => [e.memberId, Math.abs(e.amount.amountMinor)]),
  );

describe('a charge that posts after the owner shared it (T-067)', () => {
  function setup(): Harness {
    const h = harness();
    henryOut(h);
    setConsent(h, SAM, true);
    h.clock.set('2026-03-15T03:00:00+01:00');
    return h;
  }

  it('the tab follows the posted amount: same split, one ledger edit, one DM to the owner, the group not pinged', async () => {
    const h = setup();
    const adapter = pendingOnlyAdapter(h);
    const { first, expense } = await sharePending(h, adapter);
    const before = sharesOf(h, expense.expenseId);
    expect(Object.values(before)).toEqual([396, 396, 396, 396, 396]);
    const groupBefore = h.channel.groupTranscript(BARCELONA.conversationId).length;

    h.clock.set('2026-03-16T09:00:00+01:00');
    postUber(adapter, eur(2340));
    const second = await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: SAM,
      adapter,
      cursor: first.nextCursor!,
    });
    expect(second.ledgerUpdated).toEqual([expense.expenseId]);
    expect(second.prompted).toEqual([]);
    const updated = h.runtime.stores.group.expenses.get(expense.expenseId)!;
    expect(updated).toMatchObject({
      amount: eur(2340),
      paidBy: [{ memberId: SAM, amount: eur(2340) }],
      split: expense.split,
      status: 'logged',
    });
    const after = sharesOf(h, expense.expenseId);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(Object.values(after)).toEqual([468, 468, 468, 468, 468]);
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(2340);
    const balances = ledger.computeBalances(
      h.runtime.stores.group.expenses.listEntries(T),
      'EUR',
      BARCELONA.members.map((m) => m.memberId),
    );
    expect(balances.reduce((a, b) => a + b.net.amountMinor, 0)).toBe(0);

    const edits = h.audit().filter((e) => e.type === 'ledger.entry_edited');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      visibility: 'group',
      payload: {
        expenseId: expense.expenseId,
        memberId: SAM,
        before: { amountMinor: 1980, currency: 'EUR' },
        after: { amountMinor: 2340, currency: 'EUR' },
        cause: 'card_posted',
      },
    });
    expect(coreAudit.findPrivatePayloadKeys(edits[0]!.payload)).toEqual([]);

    expect(second.outbound).toHaveLength(1);
    const dm = msg(second.outbound[0]);
    expect(dm.to).toEqual({ kind: 'member', memberId: SAM });
    expect(dm.text).toBe(postedUpdatedText('Uber', eur(2340), eur(1980)));
    expect(dm.text).toBe('your Uber charge posted at €23.40, not €19.80. updated it on the tab');
    expect(safety.lintVoice(dm.text, 'dm').ok).toBe(true);
    expect(h.channel.groupTranscript(BARCELONA.conversationId)).toHaveLength(groupBefore);

    const item = h.runtime.stores.private
      .listPendingItems(SAM, G)
      .find((i) => i.promotedExpenseId === expense.expenseId)!;
    expect(item).toMatchObject({ status: 'promoted', amount: eur(2340) });
    // One private row for the ride, now the posted one.
    const rows = h.runtime.stores.private.listCardTransactions(SAM, G);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerTransactionId: 'txn_sam_uber_0315', pending: false });

    // Again from the new cursor: nothing changes, nothing is said.
    const third = await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: SAM,
      adapter,
      cursor: second.nextCursor!,
    });
    expect(third.ledgerUpdated).toEqual([]);
    expect(third.outbound).toEqual([]);
    expect(h.audit().filter((e) => e.type === 'ledger.entry_edited')).toHaveLength(1);
  });

  it('posted in another currency: the tab is left alone and the owner is asked', async () => {
    const h = setup();
    const adapter = pendingOnlyAdapter(h);
    const { first, expense, logged } = await sharePending(h, adapter);
    postUber(adapter, { amountMinor: 2550, currency: 'USD' });
    const second = await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: SAM,
      adapter,
      cursor: first.nextCursor!,
    });
    expect(second.ledgerUpdated).toEqual([]);
    expect(h.runtime.stores.group.expenses.get(expense.expenseId)!.amount).toEqual(eur(1980));
    expect(h.audit().some((e) => e.type === 'ledger.entry_edited')).toBe(false);
    expect(second.outbound).toHaveLength(1);
    const text = msg(second.outbound[0]).text;
    expect(text).toBe(postedAskText('Uber', { amountMinor: 2550, currency: 'USD' }, eur(1980)));
    expect(text).toContain('👎 my "logged:" message');
    expect(safety.lintVoice(text, 'dm').ok).toBe(true);
    // r1 #4: the message the line points at is the one whose 👎 takes it off the tab.
    await h.react('h_sam', logged.id, '👎');
    expect(h.runtime.stores.group.expenses.get(expense.expenseId)!.status).toBe('undone');
  });

  it('r1 #2: the descriptor purged on share never comes back with the posted row', async () => {
    const h = setup();
    const adapter = pendingOnlyAdapter(h);
    const { first } = await sharePending(h, adapter);
    expect(samRawNames(h)).toEqual(['']); // purged on share (SAFETY §2.9 G4)
    postUber(adapter, eur(2340));
    await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: SAM,
      adapter,
      cursor: first.nextCursor!,
    });
    expect(samRawNames(h)).toEqual(['']);
    // And a restart's full re-sync (fresh provider, no cursor) of the shared charge.
    const restarted = createMockTransactions({
      clock: h.clock,
      fixtures: [
        {
          ownerMemberId: SAM,
          accounts: SAM_FX.accounts,
          pages: [{ added: [UBER_PENDING], modified: [], removed: [] }],
        },
      ],
    });
    postUber(restarted, eur(2340));
    await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: SAM,
      adapter: restarted,
    });
    expect(samRawNames(h)).toEqual(['']);
  });

  it('r1 #2: a restart re-sync from the start keeps answered rows purged (shared and kept private)', async () => {
    const h = setup();
    watersOnTab(h);
    h.clock.set('2026-03-15T09:00:00+01:00');
    const r = await h.runtime.agent.importCardTransactions({ groupId: G, ownerMemberId: SAM });
    expect(r.prompted).toHaveLength(1);
    await h.tap('h_sam', msg(r.outbound[0]).id, 'keep_private');
    const uberRow = () =>
      h.runtime.stores.private
        .listCardTransactions(SAM, G)
        .find((t) => t.providerTransactionId === 'txn_sam_uber_0315')!;
    expect(uberRow().merchantRaw).toBe('');
    // A restarted runtime has no cursor: a fresh provider, a full re-sync.
    const again = await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: SAM,
      adapter: createMockTransactions({ clock: h.clock }),
    });
    expect(again.prompted).toEqual([]);
    expect(again.outbound).toEqual([]);
    expect(uberRow().merchantRaw).toBe('');
  });

  it('an expense the group already undid stays undone and nothing is said', async () => {
    const h = setup();
    const adapter = pendingOnlyAdapter(h);
    const { first, expense } = await sharePending(h, adapter);
    const order = BARCELONA.members.map((m) => m.memberId);
    const undone: Expense = { ...expense, status: 'undone' };
    h.runtime.stores.group.expenses.replace(
      undone,
      ledger.buildLedgerEntries(undone, { memberOrder: order, participantsUniverse: order }),
    );
    postUber(adapter, eur(2340));
    const second = await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: SAM,
      adapter,
      cursor: first.nextCursor!,
    });
    expect(second.ledgerUpdated).toEqual([]);
    expect(second.outbound).toEqual([]);
    expect(h.runtime.stores.group.expenses.get(expense.expenseId)).toMatchObject({
      status: 'undone',
      amount: eur(1980),
    });
  });

  it('the scheduled sync applies it too (the runtime provider, at the next slot)', async () => {
    const h = setup();
    const adapter = provider(h);
    // Sam's real fixture: the €19.80 pending and the €23.40 posted row are both
    // dated 2:14am, so at 3am the runtime sync already sees the posted one.
    const r = await h.runtime.agent.importCardTransactions({ groupId: G, ownerMemberId: SAM });
    expect(r.prompted.length).toBeGreaterThanOrEqual(1);
    expect(adapter.syncCount()).toBeGreaterThan(0);
    const uber = h.runtime.stores.private
      .listPendingItems(SAM, G, 'pending')
      .find((i) => i.amount.amountMinor === 2340)!;
    const tap = await h.tap('h_sam', uber.cardMessageId!, 'confirm');
    expect(tap.note).toBe('looks_shared:shared');
    // A tip lands on the ride later: the provider modifies the posted row.
    const posted = allRows().find((t) => t.transactionId === 'txn_sam_uber_0315')!;
    expect(adapter.pushUpdate(SAM, { modified: [{ ...posted, amount: eur(2640) }] }).ok).toBe(true);
    const turns = await at(h, '2026-03-15T10:00:00+01:00');
    const job = turns.find((t) => t.note === 'scheduled:card_import:imported')!;
    expect(job.outbound.map((o) => msg(o).text)).toContain(
      'your Uber charge posted at €26.40, not €23.40. updated it on the tab',
    );
    const exp = h.runtime.stores.group.expenses
      .listByTrip(T)
      .find((e) => e.source === 'card_transaction' && e.amount.amountMinor === 2640);
    expect(exp).toBeDefined();
    expect(runs(h)[0]?.payload).toMatchObject({ status: 'imported', ledgerUpdated: 1 });
  });
});
