/**
 * T-069 / T-071 end to end: the Razzmatazz moment through the real runtime
 * (offline model, mock tickets) on the simulator channel under the
 * "iMessage relay group" and "mixed group / MMS" profiles, and a 5-message
 * burst through the inbound debounce producing one agent turn.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ChannelAdapter,
  ChannelProfileId,
  DebouncedChannel,
  PacedChannel,
  SimulatorChannel,
  TranscriptEntry,
  TranscriptMessage,
} from '@trav/adapters';
import {
  createMockTickets,
  createSimulatorChannel,
  loadTicketInventory,
  withInboundDebounce,
  withOutboundPacing,
} from '@trav/adapters';
import type { SimulatedClock } from '@trav/core';
import { createDeterministicIdGenerator, createSimulatedClock, ledger } from '@trav/core';
import type { TurnResult } from '@trav/agent';
import { BARCELONA, BARCELONA_NOW, createTravRuntime } from '@trav/agent';

const ASK = "@trav get the 5 of us Razzmatazz tickets, Henry's sick";
const FIVE = ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley'];
const HANDLE_OF = new Map(BARCELONA.members.map((m) => [m.memberId, m.handle]));

interface SetupOptions {
  readonly autoBuyCapMinor?: number;
  /** Decorate the simulator channel before the runtime sees it (T-071). */
  readonly wrap?: (sim: SimulatorChannel, clock: SimulatedClock) => ChannelAdapter;
}

function setup(profile: ChannelProfileId, opts: SetupOptions = {}) {
  const clock = createSimulatedClock(BARCELONA_NOW);
  const ids = createDeterministicIdGenerator('t069');
  const sim = createSimulatorChannel({
    clock,
    profile,
    conversations: [
      {
        conversationId: BARCELONA.conversationId,
        participants: BARCELONA.members.map((m) => ({
          handle: m.handle,
          displayName: m.name,
          memberId: m.memberId,
        })),
      },
    ],
  });
  const tickets = createMockTickets({ clock, ids, inventory: loadTicketInventory('barcelona') });
  const turns: TurnResult[] = [];
  const channel = opts.wrap?.(sim, clock) ?? sim;
  const runtime = createTravRuntime({
    channel,
    clock,
    ids,
    offline: true,
    env: { TRAV_OFFLINE: '1', TRAV_STATE_DIR: mkdtempSync(join(tmpdir(), 'trav-t069-')) },
    providers: { tickets },
    subscribe: true,
    onTurn: (t) => turns.push(t),
  });
  if (opts.autoBuyCapMinor !== undefined) {
    const g = runtime.stores.group.groups.get(BARCELONA.groupId)!;
    runtime.stores.group.groups.update({
      ...g,
      spendingPolicy: { ...g.spendingPolicy, autoApproveCapMinor: opts.autoBuyCapMinor },
    });
  }
  const outbound = (entries: readonly TranscriptEntry[]): TranscriptMessage[] =>
    entries.filter(
      (e): e is TranscriptMessage => e.type === 'message' && e.direction === 'outbound',
    );
  const shares = (): [string, number][] => {
    const bookings = runtime.stores.group.expenses
      .listByTrip(BARCELONA.tripId)
      .filter((e) => e.sourceRef.kind === 'booking');
    expect(bookings).toHaveLength(1);
    const booking = bookings[0]!;
    const order = runtime.stores.group.members
      .listByGroup(BARCELONA.groupId)
      .map((m) => m.memberId);
    return ledger
      .computeShares(booking, { memberOrder: order, participantsUniverse: order })
      .filter((s) => s.amount.amountMinor !== 0)
      .map((s) => [s.memberId, s.amount.amountMinor]);
  };
  return { clock, sim, channel, tickets, runtime, turns, outbound, shares };
}

type Setup = ReturnType<typeof setup>;

/** The flagship result, whatever the channel: one purchase, a receipt, 5 QR DMs, split 5 ways. */
function expectRazzmatazzBooked(t: Setup): void {
  expect(t.tickets.purchaseCount()).toBe(1);
  const group = t.outbound(t.sim.groupTranscript());
  const receipt = group.find((m) => /^booked ✅ razzmatazz, 5 tickets, €90/.test(m.text));
  expect(receipt, group.map((m) => m.text).join('\n---\n')).toBeDefined();
  expect(receipt!.text).not.toMatch(/sick/i);
  // Text-only channels: no card, no buttons on the wire.
  for (const m of group) {
    expect(m.card).toBeUndefined();
    expect(m.actions).toEqual([]);
  }
  // One QR per attendee, as an image in their own DM; nothing for Henry.
  for (const memberId of FIVE) {
    const dms = t.outbound(t.sim.dmTranscript(HANDLE_OF.get(memberId)!));
    const qr = dms.find((m) => m.attachments.some((a) => a.kind === 'image'));
    expect(qr, memberId).toBeDefined();
    expect(qr!.card).toBeUndefined();
  }
  expect(t.outbound(t.sim.dmTranscript('h_henry'))).toEqual([]);
  // Ledger: the €90 among exactly the 5.
  expect(t.shares().sort()).toEqual(FIVE.map((id) => [id, 1800]).sort());
}

function expectNoTapsOrButtons(t: Setup): void {
  const all = t.sim.transcript();
  expect(all.filter((e) => e.type === 'reaction' && e.direction === 'outbound')).toEqual([]);
  for (const m of t.outbound(all)) {
    expect(m.actions).toEqual([]);
    expect(m.card).toBeUndefined();
    expect(m.text, m.text).not.toMatch(/👍|👎|\btaps? (Approve|Decline|Not me|Sent|Got it)\b/u);
  }
}

describe.each(['imessage_relay_group', 'mixed_group_mms'] as const)(
  'the Razzmatazz moment under the %s profile (T-069)',
  (profile) => {
    it('the explicit ask auto-buys: receipt, per-person QR images, split among the 5', async () => {
      const t = setup(profile);
      await t.sim.injectMessage({ from: 'h_dean', text: ASK });
      expect(t.turns).toHaveLength(1);
      expect(t.turns[0]!.note).toBe('tool:propose_booking:auto_approved');
      expectRazzmatazzBooked(t);
      if (profile === 'mixed_group_mms') expectNoTapsOrButtons(t);
    }, 30_000);

    it('with the card (auto-buy off), the approval works without buttons', async () => {
      const t = setup(profile, { autoBuyCapMinor: 0 });
      await t.sim.injectMessage({ from: 'h_dean', text: ASK });
      const card = t
        .outbound(t.sim.groupTranscript())
        .find((m) => m.outbound?.card?.type === 'booking_proposal');
      expect(card).toBeDefined();
      expect(t.tickets.purchaseCount()).toBe(0);
      if (profile === 'mixed_group_mms') {
        // No tapbacks on MMS: the line says to reply, and a plain "yes" books.
        expect(card!.text).toMatch(/reply "yes" to book/);
        expect(card!.text).not.toMatch(/👍/u);
        await t.sim.injectMessage({ from: 'h_dean', text: 'yes' });
        expectNoTapsOrButtons(t);
      } else {
        // A relay group keeps the 👍 tapback.
        expect(card!.text).toMatch(/👍 to book/u);
        await t.sim.injectReaction({
          from: 'h_dean',
          targetMessageId: card!.messageId,
          reaction: '👍',
        });
      }
      expectRazzmatazzBooked(t);
      // A second "yes" never buys twice.
      await t.sim.injectMessage({ from: 'h_dean', text: 'yes' });
      expect(t.tickets.purchaseCount()).toBe(1);
    }, 30_000);
  },
);

describe('relay line pacing end to end (T-071)', () => {
  let paced: PacedChannel | undefined;
  let debounced: DebouncedChannel | undefined;
  const wrap = (sim: SimulatorChannel, clock: SimulatedClock): ChannelAdapter => {
    paced = withOutboundPacing(sim, { clock });
    debounced = withInboundDebounce(paced, { clock });
    return debounced;
  };

  it('5 messages from Dean in 2 seconds produce one agent turn', async () => {
    const t = setup('imessage_relay_group', { wrap });
    const burst = ['@trav', 'get the 5 of us', 'Razzmatazz tickets', "Henry's sick", 'thanks'];
    for (const [i, text] of burst.entries()) {
      if (i > 0) t.clock.advanceMs(500);
      await t.sim.injectMessage({ from: 'h_dean', text });
    }
    expect(t.turns).toEqual([]);
    t.clock.advanceMs(3_000);
    await debounced!.tick();
    expect(t.turns).toHaveLength(1);
    expect(paced!.stats()).toMatchObject({ receivedInRatioWindow: 5, queued: 0 });
    // One turn, one answer: the merged burst is multi-line, so not the exact
    // auto-buy wording (the safe direction): one card, nothing bought yet.
    expect(t.turns[0]!.note).toBe('tool:propose_booking:proposal');
    const said = t.outbound(t.sim.groupTranscript());
    expect(said).toHaveLength(1);
    expect(said[0]!.outbound?.card?.type).toBe('booking_proposal');
    expect(t.tickets.purchaseCount()).toBe(0);
    // Dean's 👍 through the same decorated channel books once.
    await t.sim.injectReaction({
      from: 'h_dean',
      targetMessageId: said[0]!.messageId,
      reaction: '👍',
    });
    expectRazzmatazzBooked(t);
    expect(paced!.stats().queued).toBe(0);
  }, 30_000);
});
