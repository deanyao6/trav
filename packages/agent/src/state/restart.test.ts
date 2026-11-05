/**
 * T-185 (D-054): the runtime is killed mid-approval and a new one is built over
 * the same SQLite file. Everything Trav owns (stores, the agent's card index,
 * dedupe keys, the scheduler queue) is rebuilt from that file; the simulator
 * channel and the mock ticket and payment providers are shared, because they
 * stand in for systems that outlive Trav's process (the chat platform, the
 * ticket seller holding the seats, the card network).
 *
 * TRAV_OFFLINE=1 throughout. Money never moves: every purchase and charge is a
 * mock with a counter.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  InboundReaction,
  MockBookingPayments,
  MockTickets,
  SimulatorChannel,
} from '@trav/adapters';
import {
  createMockBookingPayments,
  createMockTickets,
  createSimulatorChannel,
  loadTicketInventory,
} from '@trav/adapters';
import type { OutboundMessage, SimulatedClock } from '@trav/core';
import {
  audit as auditCore,
  createDeterministicIdGenerator,
  createSimulatedClock,
  isReaction,
  ledger,
} from '@trav/core';
import { createSqliteStores } from '@trav/core/storage';
import { BARCELONA, BARCELONA_NOW, createTravRuntime, type TravRuntime } from '../compose.js';
import type { TurnResult } from '../loop.js';
import { FIVE, GUESTS, offlineModel, RAZZMATAZZ_ASK, tempStateDir } from '../runtime.testkit.js';

const G = BARCELONA.groupId;
const T = BARCELONA.tripId;

interface World {
  readonly path: string;
  readonly clock: SimulatedClock;
  readonly channel: SimulatorChannel;
  readonly tickets: MockTickets;
  readonly payments: MockBookingPayments;
}

const dirs: string[] = [];
const open: TravRuntime[] = [];

afterEach(() => {
  for (const r of open.splice(0)) {
    try {
      r.close();
    } catch {
      // already closed by the test (the "kill")
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'trav-t185-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.trav'));
  const clock = createSimulatedClock(BARCELONA_NOW);
  const channel = createSimulatorChannel({
    clock,
    conversations: [
      {
        conversationId: BARCELONA.conversationId,
        participants: [
          ...BARCELONA.members.map((m) => ({
            handle: m.handle,
            displayName: m.name,
            memberId: m.memberId,
          })),
          ...GUESTS.map((g) => ({ handle: g.handle, displayName: g.displayName })),
        ],
      },
    ],
  });
  const tickets = createMockTickets({
    clock,
    ids: createDeterministicIdGenerator('prov'),
    inventory: loadTicketInventory('barcelona'),
  });
  const payments = createMockBookingPayments({ clock });
  // The SQLite layer only opens files under a `.trav/` directory.
  return { path: join(dir, '.trav', 'trav.sqlite'), clock, channel, tickets, payments };
}

/** One process lifetime: fresh ids, model, executor, agent; the same SQLite file. */
function boot(w: World, life: string): TravRuntime {
  const ids = createDeterministicIdGenerator(life);
  const stores = createSqliteStores({ clock: w.clock, ids, sqlitePath: w.path });
  const runtime = createTravRuntime({
    channel: w.channel,
    clock: w.clock,
    ids,
    stores,
    seed: 'barcelona',
    offline: true,
    env: { TRAV_OFFLINE: '1', TRAV_STATE_DIR: tempStateDir() },
    model: offlineModel(w.clock),
    providers: { tickets: w.tickets, payments: w.payments },
    transactions: false,
    voice: 'strict',
  });
  open.push(runtime);
  return runtime;
}

/** Auto-buy off, so the flagship ask posts a card that waits for a 👍 (as `harness()` does). */
function cardFlow(r: TravRuntime): void {
  const g = r.stores.group.groups.get(G)!;
  r.stores.group.groups.update({
    ...g,
    spendingPolicy: { ...g.spendingPolicy, autoApproveCapMinor: 0 },
  });
}

function groupMessages(t: TurnResult): OutboundMessage[] {
  return t.outbound.filter((o): o is OutboundMessage => !isReaction(o) && o.to.kind === 'group');
}

function auditTypes(r: TravRuntime): string[] {
  return r.stores.group.audit.listByGroup(G).map((e) => e.type);
}

function count(r: TravRuntime, type: string): number {
  return auditTypes(r).filter((t) => t === type).length;
}

async function askForCard(
  w: World,
  r: TravRuntime,
): Promise<{ cardMessageId: string; proposalId: string }> {
  const ask = await w.channel.injectMessage({ from: 'h_dean', text: RAZZMATAZZ_ASK });
  const turn = await r.agent.handleInbound(ask);
  const card = groupMessages(turn)[0];
  expect(card?.card?.type).toBe('booking_proposal');
  const proposal = r.stores.group.bookings.listPendingProposals(G)[0];
  expect(proposal).toBeDefined();
  return { cardMessageId: card!.id, proposalId: proposal!.proposalId };
}

describe('T-185: a restart mid-approval (same SQLite file, new runtime)', () => {
  it("the 👍 after the restart buys exactly once; replaying that 👍's event id is a no-op, in the same life and the next", async () => {
    const w = world();

    // ---- life 1: the ask, the card, then the process dies before anyone taps.
    const first = boot(w, 'a');
    cardFlow(first);
    const { cardMessageId, proposalId } = await askForCard(w, first);
    expect(w.tickets.purchaseCount()).toBe(0);
    expect(w.payments.chargeCount()).toBe(0);
    first.close();

    // ---- life 2: everything Trav knows comes back from the file.
    const second = boot(w, 'b');
    // The card index entry and the proposal's expiry job were read back from disk.
    expect(second.stores.group.runtime.get('card', G, cardMessageId)).toBeDefined();
    expect(second.scheduler.list().map((j) => j.jobId)).toContain(`proposal_expiry:${proposalId}`);
    expect(second.stores.group.bookings.getProposal(proposalId)?.status).toBe('pending');

    const thumbs: InboundReaction = await w.channel.injectReaction({
      from: 'h_dean',
      targetMessageId: cardMessageId,
      reaction: '👍',
    });
    const approved = await second.agent.handleInbound(thumbs);
    expect(approved.note).toBe('approval:handled');

    // Exactly one purchase and one charge, one booking, one ledger entry.
    expect(w.tickets.purchaseCount()).toBe(1);
    expect(w.payments.chargeCount()).toBe(1);
    expect(count(second, 'booking.completed')).toBe(1);
    expect(count(second, 'ledger.written')).toBe(1);
    const bookings = second.stores.group.bookings.listByTrip(T);
    expect(bookings).toHaveLength(1);
    expect(bookings[0]!.status).toBe('confirmed');
    const expenses = second.stores.group.expenses
      .listByTrip(T)
      .filter((e) => e.source === 'booking');
    expect(expenses).toHaveLength(1);
    // Split among only the five (Henry is sick).
    const order = second.stores.group.members.listByGroup(G).map((m) => m.memberId);
    const shares = ledger.computeShares(expenses[0]!, {
      memberOrder: order,
      participantsUniverse: order,
    });
    expect(shares.map((s) => [s.memberId, s.amount.amountMinor])).toEqual(
      FIVE.map((id) => [id, 1800]),
    );
    // The receipt and the five ticket DMs went out in this life.
    expect(groupMessages(approved)[0]?.card?.type).toBe('receipt');
    expect(approved.outbound.filter((o) => !isReaction(o) && o.to.kind === 'member')).toHaveLength(
      5,
    );
    // The proposal is done; its expiry job is gone with it.
    expect(second.stores.group.bookings.getProposal(proposalId)?.status).toBe('completed');
    expect(second.scheduler.list().map((j) => j.jobId)).not.toContain(
      `proposal_expiry:${proposalId}`,
    );

    // The platform redelivers the same 👍 (same event id): a no-op.
    const auditBefore = auditTypes(second).length;
    const replay = await second.agent.handleInbound(thumbs);
    expect(replay.note).toBe('duplicate');
    expect(replay.outbound).toEqual([]);
    expect(auditTypes(second)).toHaveLength(auditBefore);

    // ---- life 3: killed again; a redelivery after this restart is still a no-op.
    second.close();
    const third = boot(w, 'c');
    const replayAfterRestart = await third.agent.handleInbound(thumbs);
    expect(replayAfterRestart.note).toBe('duplicate');
    expect(replayAfterRestart.outbound).toEqual([]);
    expect(auditTypes(third)).toHaveLength(auditBefore);
    // A fresh 👍 on the spent card (a new event id) buys nothing either.
    const late = await third.agent.handleInbound(
      await w.channel.injectReaction({
        from: 'h_chase',
        targetMessageId: cardMessageId,
        reaction: '👍',
      }),
    );
    expect(late.outbound).toEqual([]);

    expect(w.tickets.purchaseCount()).toBe(1);
    expect(w.payments.chargeCount()).toBe(1);
    expect(count(third, 'booking.completed')).toBe(1);
    expect(third.stores.group.bookings.listByTrip(T)).toHaveLength(1);
    expect(
      third.stores.group.expenses.listByTrip(T).filter((e) => e.source === 'booking'),
    ).toHaveLength(1);
    const verdict = auditCore.verifyAuditChain(third.stores.group.audit.listByGroup(G));
    expect(verdict.problems).toEqual([]);
  }, 30_000);

  it('a replay of the ask itself after a restart posts no second card and no second proposal', async () => {
    const w = world();
    const first = boot(w, 'a');
    cardFlow(first);
    const ask = await w.channel.injectMessage({ from: 'h_dean', text: RAZZMATAZZ_ASK });
    const turn = await first.agent.handleInbound(ask);
    expect(groupMessages(turn)[0]?.card?.type).toBe('booking_proposal');
    first.close();

    const second = boot(w, 'b');
    const auditBefore = auditTypes(second).length;
    const replay = await second.agent.handleInbound(ask);
    expect(replay.note).toBe('duplicate');
    expect(replay.outbound).toEqual([]);
    expect(second.stores.group.bookings.listPendingProposals(G)).toHaveLength(1);
    expect(auditTypes(second)).toHaveLength(auditBefore);
  }, 30_000);

  it('a bare "yes" after the restart still binds to the card Trav posted before it (last question survives)', async () => {
    const w = world();
    const first = boot(w, 'a');
    cardFlow(first);
    const { cardMessageId } = await askForCard(w, first);
    first.close();

    const second = boot(w, 'b');
    // What the normalizer sees: the newest group card and Trav's last group question.
    expect(second.agent.pendingCards.byMessageId(cardMessageId)?.card.type).toBe(
      'booking_proposal',
    );
    const yes = await second.agent.handleInbound(
      await w.channel.injectMessage({ from: 'h_dean', text: 'yes' }),
    );
    expect(yes.note).toBe('approval:handled');
    expect(w.tickets.purchaseCount()).toBe(1);
    expect(w.payments.chargeCount()).toBe(1);
    expect(count(second, 'booking.completed')).toBe(1);
  }, 30_000);
});

/** Every row of every table in the file, as one string (the "SELECT json FROM …" repro, all tables). */
function dumpFile(path: string): string {
  const db = new DatabaseSync(path);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String(r.name));
    return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join('\n');
  } finally {
    db.close();
  }
}

describe('T-185 r1 #1: no QR code outlives its trip on disk', () => {
  it('auto-buy, then "forget this trip", then a restart: no QR payload or image anywhere in the file', async () => {
    const w = world();
    const first = boot(w, 'a'); // the group's default auto-buy cap: the flagship ask buys at once
    const turn = await first.agent.handleInbound(
      await w.channel.injectMessage({ from: 'h_dean', text: RAZZMATAZZ_ASK }),
    );
    expect(w.tickets.purchaseCount()).toBe(1);
    const ticketCards = turn.outbound.flatMap((o) =>
      !isReaction(o) && o.card?.type === 'ticket' ? [o.card] : [],
    );
    expect(ticketCards).toHaveLength(5);
    const secrets = ticketCards.flatMap((c) => [c.qr.payload, c.qr.dataUrl]);
    // The agent still answers about a ticket DM in this life (memory only)…
    const dmId = turn.outbound.find((o) => !isReaction(o) && o.card?.type === 'ticket')!.id;
    expect(first.agent.pendingCards.byMessageId(dmId)?.card.type).toBe('ticket');
    first.close();
    // …but the QR is on disk only in ticket_artifacts, never in the runtime state.
    let disk = dumpFile(w.path);
    const artifactsOnly = disk.split('\n').filter((rows) => secrets.some((s) => rows.includes(s)));
    expect(artifactsOnly).toHaveLength(1); // the ticket_artifacts table
    const second = boot(w, 'b');
    for (const id of FIVE) {
      expect(JSON.stringify(second.stores.private.listRuntimeState(id, 'card'))).not.toContain(
        'TRAV-MOCK-TICKET',
      );
    }
    // The receipt card is filed under the trip, so it goes with it.
    expect(second.stores.group.runtime.list('card').every((e) => e.tripId === T)).toBe(true);

    const counts = second.stores.deleteTrip(T);
    second.agent.forgetRuntimeState({ tripId: T });
    expect(counts.ticket_artifacts).toBe(5);
    expect(counts.runtime_state).toBeGreaterThan(0);
    second.close();

    const third = boot(w, 'c');
    third.close();
    disk = dumpFile(w.path);
    for (const s of secrets) expect(disk).not.toContain(s);
    expect(disk).not.toContain('TRAV-MOCK-TICKET');
  }, 30_000);
});

describe('T-185 r1 #2 and #4: forgotten data stays forgotten; guests are not stored by handle', () => {
  it('after "forget me" (deletePartition + forgetRuntimeState) the next DM does not write the old DM state back', async () => {
    const w = world();
    const r = boot(w, 'a');
    const dm = async (text: string) =>
      r.agent.handleInbound(await w.channel.injectMessage({ from: 'h_dean', text, lane: 'dm' }));
    const mine = (ns: string): string =>
      JSON.stringify(r.stores.private.listRuntimeState('mem_dean', ns));
    const first = await dm('my sister flies in thursday');
    const firstIds = first.outbound.map((o) => o.id);
    // Before: Dean's DM words (lane guard) and Trav's reply (recent) are in his partition.
    expect(mine('lane_text')).toContain('my sister');
    expect(firstIds.some((id) => mine('recent').includes(id))).toBe(true);

    r.stores.private.deletePartition('mem_dean');
    r.agent.forgetRuntimeState({ memberId: 'mem_dean' });
    const second = await dm('what time is dinner');
    // Only the new state was written back, nothing from before the deletion.
    expect(mine('lane_text')).toContain('what time is dinner');
    expect(mine('lane_text')).not.toContain('my sister');
    expect(firstIds.some((id) => mine('recent').includes(id))).toBe(false);
    expect(second.outbound.some((o) => mine('recent').includes(o.id))).toBe(true);
    r.close();
    // And a restart has nothing of it to reload.
    const again = boot(w, 'b');
    expect(
      JSON.stringify(again.stores.private.listRuntimeState('mem_dean', 'lane_text')),
    ).not.toContain('my sister');
  }, 30_000);

  it('a guest is told once per group, stored as a hash (never the handle), and told again after the TTL', async () => {
    const w = world();
    const r = boot(w, 'a');
    const ask = async () =>
      r.agent.handleInbound(
        await w.channel.injectMessage({ from: 'h_ava', text: '@trav book us a table' }),
      );
    expect((await ask()).note).toBe('guest:refused');
    expect((await ask()).note).toBe('guest:told_once');
    const rows = r.stores.group.runtime.list('guest_told_h');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.groupId).toBe(G);
    expect(rows[0]!.key).toMatch(/^[0-9a-f]{64}$/);
    r.close();
    expect(runtimeTables(w.path)).not.toContain('h_ava');
    // After a restart, still told once; 31 days later, told again.
    const second = boot(w, 'b');
    const again = async () =>
      second.agent.handleInbound(
        await w.channel.injectMessage({ from: 'h_ava', text: '@trav book us a table' }),
      );
    expect((await again()).note).toBe('guest:told_once');
    w.clock.advanceHours(31 * 24);
    expect((await again()).note).toBe('guest:refused');
  }, 30_000);
});

/** The runtime-state tables of the file (the audit log records a guest's sender id by design, SAFETY §2.5). */
function runtimeTables(path: string): string {
  const db = new DatabaseSync(path);
  try {
    return ['runtime_state', 'private_runtime_state', 'seen_keys', 'scheduled_jobs']
      .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()))
      .join('\n');
  } finally {
    db.close();
  }
}
