/**
 * BookingExecutor (T-009): the Razzmatazz moment end to end through the real
 * runtime (`createTravRuntime`, in-memory stores, simulator channel, offline
 * model, production send path in strict voice mode, mock providers), plus the
 * executor's own refusals and provider branches called directly.
 *
 * Money never moves here: every purchase and charge is a mock with a counter.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  ApprovalGrant,
  BookingProposal,
  Member,
  OutboundMessage,
  PolicyDecision,
  Stores,
} from '@trav/core';
import {
  addMinutes,
  approval,
  audit as auditCore,
  createDeterministicIdGenerator,
  createSimulatedClock,
  isReaction,
  ledger,
  money,
  TravError,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import type {
  BookingPaymentsAdapter,
  MockBookingPayments,
  MockFlightsAdapter,
  MockLodging,
  MockTickets,
  TicketsAdapter,
} from '@trav/adapters';
import {
  createMockBookingPayments,
  createMockFlights,
  createMockLodging,
  createMockTickets,
  loadTicketInventory,
} from '@trav/adapters';
import { TURN_FAILED_AFTER_PURCHASE_TEXT } from '../approval/text.js';
import { BARCELONA, BARCELONA_NOW, seedBarcelona } from '../compose.js';
import type { TurnResult } from '../loop.js';
import { FIVE, harness, RAZZMATAZZ_ASK, type Harness } from '../runtime.testkit.js';
import {
  createBookingExecutor,
  parseSeat,
  toApprovalProof,
  travelerOf,
  type BookingExecutor,
} from './executor.js';

const G = BARCELONA.groupId;
const T = BARCELONA.tripId;
const CONV = BARCELONA.conversationId;
const OFFER = 'off_rzm_20260314_ga';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const VERIFY_SCRIPT = join(REPO_ROOT, 'scripts', 'audit-verify.ts');

/** VOICE §4.2 example A, byte for byte. */
const RECEIPT_TEXT =
  'booked ✅ razzmatazz, 5 tickets, €90\norder RZ-48213 · refundable until 10pm\nQR codes are in your dms, one each\ntab: Maya, Jordan, Priya, Sam → Dean €18';

/** VOICE §4.3 example A, byte for byte. */
const PRIYA_TICKET_TEXT =
  "your razzmatazz ticket for tonight 🎟️\ndoors 12am · Carrer dels Almogàvers 122\nthis one's yours only, don't forward it. everyone got their own";

function messages(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o));
}

function groupMessages(r: TurnResult): OutboundMessage[] {
  return messages(r).filter((m) => m.to.kind === 'group');
}

function dms(r: TurnResult): OutboundMessage[] {
  return messages(r).filter((m) => m.to.kind === 'member');
}

function payments(h: Harness): MockBookingPayments {
  return h.runtime.providers.payments as MockBookingPayments;
}

async function propose(h: Harness, from = 'h_dean', text = RAZZMATAZZ_ASK) {
  const turn = await h.say(from, text);
  const proposal = h.pending()[0];
  if (proposal === undefined) throw new Error(`no pending proposal (note ${turn.note})`);
  const cardMessageId = groupMessages(turn)[0]!.id;
  return { turn, proposal, cardMessageId };
}

function grantOf(h: Harness, proposalId: string): ApprovalGrant {
  const grant = h.runtime.stores.group.bookings.getGrantForProposal(proposalId);
  if (grant === undefined) throw new Error('no grant');
  return grant;
}

/** Completes the grant in the store directly (bypassing the handler's own roster check). */
function completeGrantDirectly(h: Harness, proposalId: string, senderId = 'h_dean'): ApprovalGrant {
  const b = h.runtime.stores.group.bookings;
  const proposal = b.getProposal(proposalId)!;
  const decision = b.getDecision(proposalId)!.decision;
  const members = h.runtime.stores.group.members.listByGroup(G);
  const member = members.find((m) => m.senderId === senderId)!;
  const applied = approval.applyApproval(
    grantOf(h, proposalId),
    decision,
    {
      memberId: member.memberId,
      senderId,
      via: 'button',
      messageId: 'msg_direct',
      at: h.clock.now(),
    },
    members,
    h.clock.now(),
  );
  if (applied.kind !== 'accepted' || !applied.grant.complete) throw new Error('grant not complete');
  b.saveGrant(applied.grant);
  h.runtime.stores.group.audit.append({
    groupId: G,
    tripId: T,
    type: 'approval.granted',
    actor: { kind: 'member', id: member.memberId },
    visibility: 'group',
    proposalId,
    idempotencyKey: proposal.idempotencyKey,
    payload: { memberId: member.memberId, via: 'button', messageId: 'msg_direct', complete: true },
  });
  return applied.grant;
}

function indexOf(h: Harness, type: string, proposalId: string): number {
  return h.audit().findIndex((e) => e.type === type && e.proposalId === proposalId);
}

describe('the Razzmatazz moment through the real runtime (TRAV_OFFLINE=1)', () => {
  it('ask ⇒ card ⇒ Approve ⇒ one purchase, one charge, receipt in the group, 5 ticket DMs, Henry gets none, ledger split among the 5, audit in order and verifiable', async () => {
    const h = harness();
    const { proposal, cardMessageId, turn: ask } = await propose(h);
    expect(proposal.attendees).toEqual([...FIVE]);
    expect(groupMessages(ask)[0]!.card?.type).toBe('booking_proposal');
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(payments(h).chargeCount()).toBe(0);

    const turn = await h.tap('h_dean', cardMessageId, 'approve');
    expect(turn.note).toBe('approval:handled');

    // One purchase, one charge (to Dean's card, €90), never more.
    expect(h.tickets.purchaseCount()).toBe(1);
    expect(payments(h).chargeCount()).toBe(1);
    expect(payments(h).listCharges()[0]).toMatchObject({
      payerMemberId: 'mem_dean',
      amount: { amountMinor: 9000, currency: 'EUR' },
    });

    // The receipt card in the group (VOICE §4.2 A), rendered from the audit log.
    const group = groupMessages(turn);
    expect(group).toHaveLength(1);
    expect(group[0]!.text).toBe(RECEIPT_TEXT);
    expect(group[0]!.card?.type).toBe('receipt');

    // Five ticket DMs, one each, to exactly the five; Henry gets nothing.
    const tickets = dms(turn);
    expect(tickets).toHaveLength(5);
    const to = tickets.map((m) => (m.to.kind === 'member' ? m.to.memberId : '')).sort();
    expect(to).toEqual([...FIVE].sort());
    for (const dm of tickets) {
      expect(dm.card?.type).toBe('ticket');
      if (dm.card?.type === 'ticket' && dm.to.kind === 'member') {
        expect(dm.card.deliveredTo).toBe(dm.to.memberId);
        expect(dm.card.ownerMemberId).toBe(dm.to.memberId);
        expect(dm.card.qr.payload).toMatch(/^TRAV-MOCK-TICKET\|NOT-VALID-FOR-ENTRY\|/);
      }
    }
    const priya = tickets.find((m) => m.to.kind === 'member' && m.to.memberId === 'mem_priya')!;
    expect(priya.text).toBe(PRIYA_TICKET_TEXT);
    expect(h.channel.dmTranscript('h_henry')).toEqual([]);

    // The booking row: 5 ticket refs (ids only), the expense linked, no barcode anywhere in GroupStore.
    const booking = h.runtime.stores.group.bookings.listByTrip(T)[0]!;
    expect(booking.status).toBe('confirmed');
    expect(booking.tickets).toHaveLength(5);
    expect(booking.tickets.map((t) => t.holderMemberId).sort()).toEqual([...FIVE].sort());
    expect(booking.orderRef).toBe('RZ-48213');
    expect(booking.expenseId).toBeDefined();
    expect(JSON.stringify(booking)).not.toContain('TRAV-MOCK-TICKET');
    for (const id of FIVE) {
      const mine = h.runtime.stores.private.listTickets(id, booking.bookingId);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.deliveredToMemberId).toBe(id);
    }
    expect(h.runtime.stores.private.listTickets('mem_henry', booking.bookingId)).toEqual([]);

    // No QR payload in any group message or audit event.
    const groupTranscript = JSON.stringify(h.channel.groupTranscript(CONV));
    expect(groupTranscript).not.toContain('TRAV-MOCK-TICKET');
    const auditJson = JSON.stringify(h.audit());
    expect(auditJson).not.toContain('TRAV-MOCK-TICKET');
    for (const id of FIVE) {
      const artifact = h.runtime.stores.private.listTickets(id, booking.bookingId)[0]!;
      expect(groupTranscript).not.toContain(artifact.qrPayload);
      expect(auditJson).not.toContain(artifact.qrPayload);
    }

    // The ledger: Dean paid €90, split €18 × 5 among exactly the five.
    const expense = h.runtime.stores.group.expenses.getBySourceRef({
      kind: 'booking',
      id: booking.bookingId,
    })!;
    expect(expense.expenseId).toBe(booking.expenseId);
    expect(expense.source).toBe('booking');
    expect(expense.paidBy).toEqual([{ memberId: 'mem_dean', amount: money(9000, 'EUR') }]);
    const order = h.runtime.stores.group.members.listByGroup(G).map((m) => m.memberId);
    const shares = ledger.computeShares(expense, {
      memberOrder: order,
      participantsUniverse: order,
    });
    expect(shares.map((s) => [s.memberId, s.amount.amountMinor])).toEqual(
      FIVE.map((id) => [id, 1800]),
    );
    expect(shares.some((s) => s.memberId === 'mem_henry')).toBe(false);

    // Audit order: policy.evaluated → approval.granted → booking.attempted → booking.completed → ledger.written.
    const p = proposal.proposalId;
    const order5 = [
      'policy.evaluated',
      'approval.granted',
      'booking.attempted',
      'booking.completed',
      'ledger.written',
    ].map((type) => indexOf(h, type, p));
    expect(order5.every((i) => i >= 0)).toBe(true);
    expect([...order5].sort((a, b) => a - b)).toEqual(order5);
    expect(h.auditTypes().filter((t) => t === 'booking.completed')).toHaveLength(1);
    const completed = h.audit().find((e) => e.type === 'booking.completed')!;
    expect(completed.id).toBe(booking.completedAuditEventId);
    expect(completed.payload).toMatchObject({
      providerRef: 'RZ-48213',
      totalMinor: 9000,
      currency: 'EUR',
      attendees: [...FIVE],
      refundable: true,
    });
    const verdict = auditCore.verifyAuditChain(h.audit());
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);

    // The grant is spent and the proposal done: nothing pending.
    expect(grantOf(h, p).status).toBe('consumed');
    expect(h.runtime.stores.group.bookings.getProposal(p)?.status).toBe('completed');
    expect(h.pending()).toEqual([]);

    // A second 👍 from Dean and a late Approve from Maya buy nothing and post nothing.
    const again = await h.react('h_dean', cardMessageId, '👍');
    const late = await h.tap('h_maya', cardMessageId, 'approve');
    expect(again.outbound).toEqual([]);
    expect(late.outbound).toEqual([]);
    expect(h.tickets.purchaseCount()).toBe(1);
    expect(payments(h).chargeCount()).toBe(1);
    expect(h.auditTypes().filter((t) => t === 'booking.completed')).toHaveLength(1);

    // A retry of execute() with the same grant is the duplicate path: same booking, no purchase.
    const retry = await h.runtime.executor.execute(p, grantOf(h, p).grantId);
    expect(retry.kind).toBe('duplicate');
    if (retry.kind === 'duplicate') expect(retry.booking.bookingId).toBe(booking.bookingId);
    expect(h.tickets.purchaseCount()).toBe(1);
    expect(payments(h).chargeCount()).toBe(1);
    expect(h.auditTypes()).toContain('booking.duplicate_suppressed');
    expect(auditCore.verifyAuditChain(h.audit()).ok).toBe(true);

    // `pnpm audit:verify` passes on the exported log.
    const dir = mkdtempSync(join(tmpdir(), 'trav-t009-'));
    const file = join(dir, 'audit.json');
    writeFileSync(file, JSON.stringify(h.audit()));
    const run = spawnSync(process.execPath, ['--import', 'tsx', VERIFY_SCRIPT, file], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, TRAV_OFFLINE: '1' },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`HEAD group=${G}`);
  }, 30_000);

  it("requester ≠ approver: Sam taps Approve on Dean's proposal and the purchase completes on Dean's card", async () => {
    const h = harness();
    const { proposal, cardMessageId } = await propose(h);
    const turn = await h.tap('h_sam', cardMessageId, 'approve');
    expect(turn.note).toBe('approval:handled');
    expect(groupMessages(turn)[0]!.text).toBe(RECEIPT_TEXT);
    expect(h.tickets.purchaseCount()).toBe(1);
    expect(payments(h).chargeCount()).toBe(1);
    expect(payments(h).listCharges()[0]!.payerMemberId).toBe('mem_dean');
    const granted = h.audit().find((e) => e.type === 'approval.granted');
    expect(granted?.actor).toEqual({ kind: 'member', id: 'mem_sam' });
    expect(grantOf(h, proposal.proposalId).grantedBy.map((g) => g.memberId)).toEqual(['mem_sam']);
    expect(dms(turn)).toHaveLength(5);
  });

  it('a failed purchase (sold out before the 👍) says so, moves no money, replies to the card and fails the proposal', async () => {
    const h = harness();
    const { proposal, cardMessageId } = await propose(h);
    // The hold is gone and so is the stock: the executor's re-read finds nothing to buy.
    await h.tickets.releaseHold(proposal.quoteRef);
    h.tickets.setAvailable(OFFER, 0);
    const turn = await h.tap('h_dean', cardMessageId, 'approve');
    expect(turn.note).toBe('approval:handled');
    const line = groupMessages(turn)[0]!;
    expect(line.text).toBe(
      "couldn't book razzmatazz. no charge went through\n@ me if you want to try another night or another place",
    );
    expect(line.replyTo).toBe(cardMessageId);
    expect(dms(turn)).toEqual([]);
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(payments(h).chargeCount()).toBe(0);
    const failed = h.audit().find((e) => e.type === 'booking.failed');
    expect(failed?.payload).toMatchObject({ errorCode: 'sold_out', moneyMoved: false });
    expect(h.auditTypes()).not.toContain('booking.completed');
    expect(h.runtime.stores.group.bookings.getProposal(proposal.proposalId)?.status).toBe('failed');
    expect(h.pending()).toEqual([]);
    expect(auditCore.verifyAuditChain(h.audit()).ok).toBe(true);
  });

  it('the price changed under the hold ⇒ the grant is invalidated, nothing is bought, Trav re-quotes with a fresh card', async () => {
    const h = harness();
    const { proposal, cardMessageId } = await propose(h);
    await h.tickets.releaseHold(proposal.quoteRef);
    h.tickets.setUnitPrice(OFFER, money(2000, 'EUR'));
    const turn = await h.tap('h_dean', cardMessageId, 'approve');
    expect(turn.note).toBe('approval:handled');
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(payments(h).chargeCount()).toBe(0);
    const invalidated = h.audit().find((e) => e.type === 'approval.invalidated');
    expect(invalidated?.payload).toMatchObject({
      cause: 'price_changed',
      currentTotalMinor: 10000,
    });
    expect(h.runtime.stores.group.bookings.getProposal(proposal.proposalId)?.status).toBe(
      'superseded',
    );
    // The re-quote is a new card at the new price that needs its own 👍 (D-021).
    const card = groupMessages(turn)[0]!;
    expect(card.card?.type).toBe('booking_proposal');
    expect(card.text).toContain('€20 each · €100 total');
    expect(h.pending()).toHaveLength(1);
    expect(h.pending()[0]!.totalMinor).toBe(10000);
  });

  it("the live roster is re-checked right before purchasing (T-030 note b): a member marked out behind the handler's back ⇒ payers_changed, no purchase", async () => {
    const h = harness();
    const { proposal } = await propose(h);
    const grant = completeGrantDirectly(h, proposal.proposalId);
    h.runtime.stores.group.trips.setAttendance({
      activityId: BARCELONA.razzmatazzActivityId,
      memberId: 'mem_maya',
      status: 'out',
      updatedAt: h.clock.now(),
      sourceMessageId: 'msg_tool',
      setBy: 'mem_maya',
    });
    const res = await h.runtime.executor.execute(proposal.proposalId, grant.grantId);
    expect(res).toEqual({ kind: 'refused', reason: 'payers_changed' });
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(payments(h).chargeCount()).toBe(0);
    expect(grantOf(h, proposal.proposalId).status).toBe('invalidated');
    const invalidated = h.audit().find((e) => e.type === 'approval.invalidated');
    expect(invalidated?.payload).toMatchObject({
      cause: 'payers_changed',
      problems: ['quantity_not_roster', 'attendee_marked_out'],
    });
    expect(h.auditTypes()).toContain('booking.attempted');
    expect(h.auditTypes()).not.toContain('booking.completed');
  });

  it('refuses an incomplete, expired, mismatched or rejected grant without touching a provider (counter stays 0)', async () => {
    const h = harness();
    const { proposal, cardMessageId } = await propose(h);
    const p = proposal.proposalId;
    const pending = grantOf(h, p);
    const exec = h.runtime.executor;

    expect(await exec.execute(p, pending.grantId)).toEqual({
      kind: 'refused',
      reason: 'incomplete',
    });

    // Another proposal's grant.
    h.runtime.stores.group.bookings.saveGrant({
      ...pending,
      grantId: 'grant_other',
      proposalId: 'prop_other',
    });
    expect(await exec.execute(p, 'grant_other')).toEqual({
      kind: 'refused',
      reason: 'proposal_mismatch',
    });

    // Unknown ids are programmer misuse, not a policy outcome.
    await expect(exec.execute('prop_nope', pending.grantId)).rejects.toMatchObject({
      code: 'grant_invalid',
    });

    // Past the TTL: expired, even if completed in the store.
    const complete = completeGrantDirectly(h, p);
    h.clock.set(addMinutes(complete.expiresAt, 1));
    expect(await exec.execute(p, complete.grantId)).toEqual({ kind: 'refused', reason: 'expired' });
    h.clock.set(BARCELONA_NOW);

    // Declined: the grant is rejected and the proposal closed.
    await h.tap('h_dean', cardMessageId, 'decline');
    expect(grantOf(h, p).status).toBe('rejected');
    const afterDecline = await exec.execute(p, complete.grantId);
    expect(afterDecline).toEqual({ kind: 'refused', reason: 'wrong_status' });

    expect(h.tickets.purchaseCount()).toBe(0);
    expect(payments(h).chargeCount()).toBe(0);
    expect(h.auditTypes()).not.toContain('booking.attempted');
    expect(h.auditTypes()).not.toContain('booking.completed');
  });

  it('AT the proof expiry the executor refuses on its own, before any provider could', async () => {
    const h = harness();
    const { proposal } = await propose(h);
    const complete = completeGrantDirectly(h, proposal.proposalId);
    h.clock.set(complete.expiresAt);
    const res = await h.runtime.executor.execute(proposal.proposalId, complete.grantId);
    expect(res).toEqual({ kind: 'refused', reason: 'expired' });
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('no saved card for the payer ⇒ failed{not_configured} before any purchase', async () => {
    const h = harness({
      runtime: {
        providers: {
          payments: createMockBookingPayments({
            clock: createSimulatedClock(BARCELONA_NOW),
            membersWithPaymentMethod: [],
          }),
        },
      },
    });
    const { proposal } = await propose(h);
    const complete = completeGrantDirectly(h, proposal.proposalId);
    const res = await h.runtime.executor.execute(proposal.proposalId, complete.grantId);
    expect(res).toMatchObject({ kind: 'failed', errorCode: 'not_configured', moneyMoved: false });
    expect(h.runtime.providers.tickets).not.toBe(h.tickets); // the harness's own tickets mock was replaced
    expect((h.runtime.providers.tickets as MockTickets).purchaseCount()).toBe(0);
    expect(h.auditTypes()).toContain('booking.attempted');
    expect(h.auditTypes()).not.toContain('booking.completed');
  });

  it('a charge that fails after the purchase is a resumable failure: no booking row, no charge; the retry replays the same order (counter 1) and charges once', async () => {
    const clock = createSimulatedClock(BARCELONA_NOW);
    const real = createMockBookingPayments({ clock });
    let fail = true;
    const flaky: BookingPaymentsAdapter = {
      ...real,
      charge: (request) =>
        fail
          ? Promise.resolve({
              ok: false,
              error: {
                code: 'provider_unavailable',
                message: 'card network down',
                retryable: true,
              },
            })
          : real.charge(request),
    };
    const h = harness({ runtime: { providers: { payments: flaky } } });
    const tickets = h.runtime.providers.tickets as MockTickets;
    const { proposal } = await propose(h);
    const complete = completeGrantDirectly(h, proposal.proposalId);
    const first = await h.runtime.executor.execute(proposal.proposalId, complete.grantId);
    expect(first).toMatchObject({
      kind: 'failed',
      errorCode: 'provider_unavailable',
      moneyMoved: false,
    });
    expect(tickets.purchaseCount()).toBe(1);
    expect(real.chargeCount()).toBe(0);
    expect(h.runtime.stores.group.bookings.listByTrip(T)).toEqual([]);
    expect(h.auditTypes()).not.toContain('booking.completed');
    expect(h.audit().find((e) => e.type === 'booking.failed')?.payload).toMatchObject({
      stage: 'charge',
      moneyMoved: false,
    });

    expect(first).toMatchObject({ resumable: true });
    // Retryable with the same key and grant: the proposal is pending again, the grant complete.
    expect(h.runtime.stores.group.bookings.getProposal(proposal.proposalId)?.status).toBe(
      'pending',
    );
    expect(grantOf(h, proposal.proposalId).status).toBe('complete');

    fail = false;
    const second = await h.runtime.executor.execute(proposal.proposalId, complete.grantId);
    expect(second.kind).toBe('completed');
    expect(tickets.purchaseCount()).toBe(1);
    expect(real.chargeCount()).toBe(1);
    expect(h.auditTypes().filter((t) => t === 'booking.completed')).toHaveLength(1);
    expect(auditCore.verifyAuditChain(h.audit()).ok).toBe(true);
  });

  it('a charge failure after the purchase leaves the card live: the group hears "nothing\'s booked yet", the next Approve replays the same order and charges once, then the receipt and 5 DMs (T-009 r1 #2)', async () => {
    const clock = createSimulatedClock(BARCELONA_NOW);
    const real = createMockBookingPayments({ clock });
    let fail = true;
    const flaky: BookingPaymentsAdapter = {
      ...real,
      charge: (request) =>
        fail
          ? Promise.resolve({
              ok: false,
              error: { code: 'provider_unavailable', message: 'declined', retryable: true },
            })
          : real.charge(request),
    };
    const h = harness({ runtime: { providers: { payments: flaky } } });
    const tickets = h.runtime.providers.tickets as MockTickets;
    const { proposal, cardMessageId } = await propose(h);

    const first = await h.tap('h_dean', cardMessageId, 'approve');
    expect(first.note).toBe('approval:handled');
    const line = groupMessages(first)[0]!;
    expect(groupMessages(first)).toHaveLength(1);
    expect(line.text).toBe(
      "couldn't charge the card for razzmatazz. no charge went through, nothing's booked yet\ntap Approve again in a few and i'll retry",
    );
    // Not a quote-reply: the card stays live in the simulator for the retry.
    expect(line.replyTo).toBeUndefined();
    expect(dms(first)).toEqual([]);
    expect(tickets.purchaseCount()).toBe(1);
    expect(real.chargeCount()).toBe(0);
    expect(h.runtime.stores.group.bookings.listByTrip(T)).toEqual([]);
    expect(h.pending().map((p) => p.proposalId)).toEqual([proposal.proposalId]);
    expect(grantOf(h, proposal.proposalId).status).toBe('complete');

    // Still failing: the same line again, still nothing charged, still one provider order.
    const second = await h.tap('h_dean', cardMessageId, 'approve');
    expect(groupMessages(second)[0]!.text).toBe(line.text);
    expect(tickets.purchaseCount()).toBe(1);
    expect(real.chargeCount()).toBe(0);

    fail = false;
    const third = await h.tap('h_sam', cardMessageId, 'approve');
    expect(third.note).toBe('approval:handled');
    expect(groupMessages(third)[0]!.text).toBe(RECEIPT_TEXT);
    expect(dms(third)).toHaveLength(5);
    expect(tickets.purchaseCount()).toBe(1);
    expect(real.chargeCount()).toBe(1);
    expect(real.listCharges()[0]!.payerMemberId).toBe('mem_dean');
    expect(h.auditTypes().filter((t) => t === 'booking.completed')).toHaveLength(1);
    expect(grantOf(h, proposal.proposalId).status).toBe('consumed');
    expect(h.pending()).toEqual([]);
    expect(auditCore.verifyAuditChain(h.audit()).ok).toBe(true);

    // And nothing more after that.
    const fourth = await h.tap('h_dean', cardMessageId, 'approve');
    expect(fourth.outbound).toEqual([]);
    expect(tickets.purchaseCount()).toBe(1);
    expect(real.chargeCount()).toBe(1);
  });

  it('a policy auto-approved ask whose charge fails: no card to tap, so the line says "say yes", and the requester\'s yes retries it (and nobody else\'s)', async () => {
    const clock = createSimulatedClock(BARCELONA_NOW);
    const real = createMockBookingPayments({ clock });
    let fail = true;
    const flaky: BookingPaymentsAdapter = {
      ...real,
      charge: (request) =>
        fail
          ? Promise.resolve({
              ok: false,
              error: { code: 'provider_unavailable', message: 'down', retryable: true },
            })
          : real.charge(request),
    };
    const h = harness({ runtime: { providers: { payments: flaky } } });
    const grp = h.runtime.stores.group.groups.get(G)!;
    h.runtime.stores.group.groups.update({
      ...grp,
      spendingPolicy: { ...grp.spendingPolicy, autoApproveCapMinor: 100_000 },
    });
    const tickets = h.runtime.providers.tickets as MockTickets;
    const ask = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(ask.note).toBe('tool:propose_booking:auto_approved');
    expect(groupMessages(ask).map((m) => m.text)).toEqual([
      "couldn't charge the card for razzmatazz. no charge went through, nothing's booked yet\nsay yes in a few and i'll retry",
    ]);
    expect(tickets.purchaseCount()).toBe(1);
    expect(real.chargeCount()).toBe(0);
    expect(h.pending()).toHaveLength(1);
    const pendingId = h.pending()[0]!.proposalId;
    expect(h.runtime.scheduler.list().map((j) => j.jobId)).toContain(
      `proposal_expiry:${pendingId}`,
    );

    fail = false;
    const notMine = await h.say('h_sam', 'yes');
    expect(notMine.outbound).toEqual([]);
    expect(real.chargeCount()).toBe(0);
    const yes = await h.say('h_dean', 'yes');
    expect(groupMessages(yes)[0]!.card?.type).toBe('receipt');
    expect(dms(yes)).toHaveLength(5);
    expect(tickets.purchaseCount()).toBe(1);
    expect(real.chargeCount()).toBe(1);
    expect(h.pending()).toEqual([]);
    expect(auditCore.verifyAuditChain(h.audit()).ok).toBe(true);
  });

  it('nobody retries a charge failure: the proposal expires with no charge, and an Approve after that buys nothing', async () => {
    const clock = createSimulatedClock(BARCELONA_NOW);
    const real = createMockBookingPayments({ clock });
    const declined: BookingPaymentsAdapter = {
      ...real,
      charge: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'provider_unavailable', message: 'declined', retryable: true },
        }),
    };
    const h = harness({ runtime: { providers: { payments: declined } } });
    const tickets = h.runtime.providers.tickets as MockTickets;
    const { proposal, cardMessageId } = await propose(h);
    await h.tap('h_dean', cardMessageId, 'approve');
    h.clock.advanceMs(30 * 60 * 1000);
    const drained = await h.runtime.drain();
    const texts = drained.flatMap((t) => groupMessages(t).map((m) => m.text));
    expect(texts).toEqual(['razzmatazz proposal expired, no charge. @ me if you still want it']);
    expect(h.runtime.stores.group.bookings.getProposal(proposal.proposalId)?.status).toBe(
      'expired',
    );
    const late = await h.tap('h_dean', cardMessageId, 'approve');
    expect(late.outbound).toEqual([]);
    expect(tickets.purchaseCount()).toBe(1);
    expect(real.chargeCount()).toBe(0);
  });

  it('getTicketForHolder failing after the charge: Booking row and ledger land first, the group hears the booking stands, the next @ fills in the tickets and sends the receipt and DMs (T-009 r1 #1)', async () => {
    const clock = createSimulatedClock(BARCELONA_NOW);
    const real = createMockTickets({
      clock,
      ids: createDeterministicIdGenerator('k'),
      inventory: loadTicketInventory('barcelona'),
    });
    const broken = new Set<string>(['mem_jordan', 'mem_priya', 'mem_sam']);
    const fetches: string[] = [];
    const flaky: TicketsAdapter = {
      ...real,
      getTicketForHolder: (orderId, memberId) => {
        fetches.push(memberId);
        return broken.has(memberId)
          ? Promise.resolve({
              ok: false,
              error: { code: 'provider_unavailable', message: 'down', retryable: true },
            })
          : real.getTicketForHolder(orderId, memberId);
      },
    };
    const h = harness({ runtime: { providers: { tickets: flaky } } });
    const { proposal, cardMessageId } = await propose(h);

    const turn = await h.tap('h_dean', cardMessageId, 'approve');
    expect(turn.note).toBe('approval:handled');
    const line = groupMessages(turn)[0]!;
    expect(groupMessages(turn)).toHaveLength(1);
    expect(line.text).toBe(TURN_FAILED_AFTER_PURCHASE_TEXT);
    expect(line.replyTo).toBe(cardMessageId);
    expect(dms(turn)).toEqual([]);
    expect(JSON.stringify(h.channel.groupTranscript(CONV))).not.toContain('no charge');
    expect(real.purchaseCount()).toBe(1);
    expect(payments(h).chargeCount()).toBe(1);

    // The Booking row and the ledger landed before the tickets were fetched.
    const booking = h.runtime.stores.group.bookings.listByTrip(T)[0]!;
    expect(booking.status).toBe('confirmed');
    expect(booking.tickets).toEqual([]);
    const expense = h.runtime.stores.group.expenses.getBySourceRef({
      kind: 'booking',
      id: booking.bookingId,
    })!;
    expect(expense.expenseId).toBe(booking.expenseId);
    const types = h.auditTypes();
    expect(types.indexOf('booking.completed')).toBeLessThan(types.indexOf('ledger.written'));
    // Maya and Dean's tickets were stored before Jordan's failed; nothing for the rest.
    expect(h.runtime.stores.private.listTickets('mem_maya', booking.bookingId)).toHaveLength(1);
    expect(h.runtime.stores.private.listTickets('mem_sam', booking.bookingId)).toEqual([]);
    expect(h.runtime.stores.group.bookings.getProposal(proposal.proposalId)?.status).toBe(
      'completed',
    );
    expect(grantOf(h, proposal.proposalId).status).toBe('consumed');

    // An @ while the provider is still down: the same truthful line, nothing bought.
    const stillDown = await h.say('h_maya', '@trav where are the tickets?');
    expect(stillDown.note).toBe('booking:resumed');
    expect(groupMessages(stillDown).map((m) => m.text)).toEqual([TURN_FAILED_AFTER_PURCHASE_TEXT]);
    expect(real.purchaseCount()).toBe(1);

    // The provider is back: the next @ finishes it. Only the missing holders are fetched.
    broken.clear();
    fetches.length = 0;
    const resumed = await h.say('h_maya', '@trav tickets?');
    expect(resumed.note).toBe('booking:resumed');
    expect(groupMessages(resumed).map((m) => m.text)).toEqual([RECEIPT_TEXT]);
    const tickets = dms(resumed);
    expect(tickets).toHaveLength(5);
    expect(tickets.map((m) => (m.to.kind === 'member' ? m.to.memberId : '')).sort()).toEqual(
      [...FIVE].sort(),
    );
    expect(h.channel.dmTranscript('h_henry')).toEqual([]);
    expect(fetches.sort()).toEqual(['mem_jordan', 'mem_priya', 'mem_sam']);
    const done = h.runtime.stores.group.bookings.getBooking(booking.bookingId)!;
    expect(done.tickets.map((t) => t.holderMemberId).sort()).toEqual([...FIVE].sort());
    for (const id of FIVE) {
      expect(h.runtime.stores.private.listTickets(id, booking.bookingId)).toHaveLength(1);
    }
    expect(real.purchaseCount()).toBe(1);
    expect(payments(h).chargeCount()).toBe(1);
    expect(h.auditTypes().filter((t) => t === 'ledger.written')).toHaveLength(1);
    expect(h.auditTypes().filter((t) => t === 'booking.completed')).toHaveLength(1);
    expect(JSON.stringify(h.audit())).not.toContain('TRAV-MOCK-TICKET');
    expect(auditCore.verifyAuditChain(h.audit()).ok).toBe(true);

    // Done: a later @ goes to the model as usual, nothing resumed or re-sent.
    const later = await h.say('h_maya', '@trav thanks, what time are doors?');
    expect(later.note).not.toBe('booking:resumed');
  });

  it('the duplicate path fills in a missing expense and tickets, even past the grant TTL (T-009 r1 #1, #4)', async () => {
    const clock = createSimulatedClock(BARCELONA_NOW);
    const real = createMockTickets({
      clock,
      ids: createDeterministicIdGenerator('k'),
      inventory: loadTicketInventory('barcelona'),
    });
    let down = true;
    const flaky: TicketsAdapter = {
      ...real,
      getTicketForHolder: (orderId, memberId) =>
        down
          ? Promise.resolve({
              ok: false,
              error: { code: 'provider_unavailable', message: 'down', retryable: true },
            })
          : real.getTicketForHolder(orderId, memberId),
    };
    const h = harness({ runtime: { providers: { tickets: flaky } } });
    const { proposal } = await propose(h);
    const complete = completeGrantDirectly(h, proposal.proposalId);
    await expect(
      h.runtime.executor.execute(proposal.proposalId, complete.grantId),
    ).rejects.toMatchObject({ code: 'invariant_violation' });
    const booking = h.runtime.stores.group.bookings.listByTrip(T)[0]!;
    expect(booking.tickets).toEqual([]);

    // The ledger landed before the tickets were tried; retry past the grant TTL.
    expect(
      h.runtime.stores.group.expenses.getBySourceRef({ kind: 'booking', id: booking.bookingId }),
    ).toBeDefined();
    h.clock.set(addMinutes(complete.expiresAt, 5));
    down = false;
    const retry = await h.runtime.executor.execute(proposal.proposalId, complete.grantId);
    expect(retry).toMatchObject({ kind: 'duplicate', repaired: true });
    if (retry.kind !== 'duplicate') throw new Error('not duplicate');
    expect(retry.booking.tickets).toHaveLength(5);
    expect(retry.expense?.expenseId).toBe(booking.expenseId);
    expect(real.purchaseCount()).toBe(1);
    expect(payments(h).chargeCount()).toBe(1);

    // Again: nothing left to repair.
    const again = await h.runtime.executor.execute(proposal.proposalId, complete.grantId);
    expect(again).toMatchObject({ kind: 'duplicate', repaired: false });
  });

  it('a retry of a completed booking after the grant TTL is the duplicate path, not refused/expired (T-009 r1 #4)', async () => {
    const h = harness();
    const { proposal, cardMessageId } = await propose(h);
    await h.tap('h_dean', cardMessageId, 'approve');
    const grant = grantOf(h, proposal.proposalId);
    expect(grant.status).toBe('consumed');
    h.clock.set(addMinutes(grant.expiresAt, 60));
    const retry = await h.runtime.executor.execute(proposal.proposalId, grant.grantId);
    expect(retry).toMatchObject({ kind: 'duplicate', repaired: false });
    expect(h.tickets.purchaseCount()).toBe(1);
    expect(payments(h).chargeCount()).toBe(1);
  });
});

// ---------- the other provider branches, called directly ----------

const PLANNING = '2026-02-20T20:30:00+01:00';

interface Rig {
  readonly stores: Stores;
  readonly executor: BookingExecutor;
  readonly tickets: MockTickets;
  readonly flights: MockFlightsAdapter;
  readonly lodging: MockLodging;
  readonly payments: MockBookingPayments;
  readonly members: readonly Member[];
  readonly now: string;
}

function rig(startAt = PLANNING): Rig {
  const clock = createSimulatedClock(startAt);
  const ids = createDeterministicIdGenerator('x');
  const stores = createMemoryStores({ clock, ids });
  seedBarcelona(stores);
  // v0 members carry a display name only; a provider traveler needs a family name.
  for (const m of stores.group.members.listByGroup(G)) {
    stores.group.members.upsert({ ...m, displayName: `${m.displayName} Testperson` });
  }
  const tickets = createMockTickets({ clock, ids, inventory: loadTicketInventory('barcelona') });
  const flights = createMockFlights({ clock });
  const lodging = createMockLodging({ clock });
  const payments = createMockBookingPayments({ clock });
  const executor = createBookingExecutor({
    stores,
    providers: { tickets, flights, lodging, payments },
    clock,
    ids,
  });
  return {
    stores,
    executor,
    tickets,
    flights,
    lodging,
    payments,
    members: stores.group.members.listByGroup(G),
    now: clock.now(),
  };
}

/** Writes a proposal, a hand-made any_one decision, and a grant completed by `approver` (audited so the chain verifies). */
function seedApproved(
  r: Rig,
  proposal: BookingProposal,
  approver = 'mem_dean',
): { readonly decision: PolicyDecision; readonly grant: ApprovalGrant } {
  const grp = r.stores.group.groups.get(G)!;
  const decision: PolicyDecision = {
    proposalId: proposal.proposalId,
    outcome: 'needs_confirmation',
    reasons: ['default_confirm'],
    ruleIds: ['C1'],
    approvalMode: 'any_one',
    requiredApprovers: [approver],
    expiresAt: addMinutes(r.now, 15),
    existingBookingId: null,
    policySnapshot: grp.spendingPolicy,
  };
  r.stores.group.bookings.createProposal(proposal);
  const evaluated = r.stores.group.audit.append({
    groupId: G,
    tripId: T,
    type: 'policy.evaluated',
    actor: { kind: 'trav', id: 'trav' },
    visibility: 'group',
    proposalId: proposal.proposalId,
    idempotencyKey: proposal.idempotencyKey,
    payload: { outcome: decision.outcome, reasons: decision.reasons, ruleIds: decision.ruleIds },
  });
  r.stores.group.bookings.saveDecision(decision, evaluated.id);
  const ids = createDeterministicIdGenerator('g');
  const member = r.members.find((m) => m.memberId === approver)!;
  const applied = approval.applyApproval(
    approval.createGrant(decision, evaluated.id, ids, r.now),
    decision,
    { memberId: approver, senderId: member.senderId, via: 'button', messageId: 'm1', at: r.now },
    r.members,
    r.now,
  );
  if (applied.kind !== 'accepted') throw new Error('not accepted');
  r.stores.group.bookings.saveGrant(applied.grant);
  r.stores.group.audit.append({
    groupId: G,
    tripId: T,
    type: 'approval.granted',
    actor: { kind: 'member', id: approver },
    visibility: 'group',
    proposalId: proposal.proposalId,
    idempotencyKey: proposal.idempotencyKey,
    payload: { memberId: approver, via: 'button', messageId: 'm1', complete: true },
  });
  return { decision, grant: applied.grant };
}

function baseProposal(r: Rig, over: Partial<BookingProposal>): BookingProposal {
  return {
    proposalId: 'prop_x',
    groupId: G,
    tripId: T,
    kind: 'ticket',
    provider: 'mock',
    itemRef: 'x',
    description: 'x',
    totalMinor: 0,
    currency: 'EUR',
    quotedAt: r.now,
    quoteRef: 'x',
    payers: [],
    attendees: [],
    paidBy: { kind: 'member_card', memberId: 'mem_dean' },
    refundable: true,
    eventDate: '',
    ageRestriction: null,
    contentTags: [],
    requestedBy: 'mem_dean',
    requestedAt: r.now,
    sourceMessageId: 'msg_x',
    idempotencyKey: 'key_x',
    status: 'pending',
    ...over,
  };
}

describe('flights and lodging go through the same executor (A1: one createOrder, one book)', () => {
  it('a flight on per-person cards: one provider order, no payments charge, an expense that nets to zero', async () => {
    const r = rig();
    const offers = await r.flights.search({
      slices: [
        { origin: 'BOS', destination: 'BCN', departureDate: '2026-03-12' },
        { origin: 'BCN', destination: 'JFK', departureDate: '2026-03-17' },
      ],
      passengers: [{ memberId: 'mem_dean', type: 'adult' }],
    });
    if (!offers.ok) throw new Error(offers.error.message);
    const offer = offers.value.find((o) => o.offerId.endsWith('_bos-jfk-1'))!;
    const total = offer.totalAmount.amountMinor;
    const proposal = baseProposal(r, {
      proposalId: 'prop_flight',
      kind: 'flight',
      provider: r.flights.info.provider,
      itemRef: offer.offerId,
      quoteRef: offer.offerId,
      description: 'BOS → BCN → JFK',
      totalMinor: total,
      payers: [{ memberId: 'mem_dean', shareMinor: total }],
      attendees: ['mem_dean'],
      paidBy: { kind: 'per_person_cards' },
      refundable: offer.conditions.refundBeforeDeparture.allowed,
      idempotencyKey: 'key_flight',
    });
    const { grant } = seedApproved(r, proposal);
    const res = await r.executor.execute(proposal.proposalId, grant.grantId);
    expect(res.kind).toBe('completed');
    if (res.kind !== 'completed') return;
    expect(r.flights.purchaseCount()).toBe(1);
    expect(r.payments.chargeCount()).toBe(0);
    expect(res.booking).toMatchObject({ kind: 'flight', totalMinor: total, tickets: [] });
    expect(res.booking.orderRef).toMatch(/^[A-Z2-9]{6}$/);
    expect(res.expense.paidBy).toEqual([{ memberId: 'mem_dean', amount: money(total, 'EUR') }]);
    const order = r.members.map((m) => m.memberId);
    const entries = ledger.buildLedgerEntries(res.expense, {
      memberOrder: order,
      participantsUniverse: order,
    });
    const net = entries.reduce(
      (sum, e) => sum + (e.kind === 'paid' ? e.amount.amountMinor : -e.amount.amountMinor),
      0,
    );
    expect(net).toBe(0);
    expect(auditCore.verifyAuditChain(r.stores.group.audit.listByGroup(G)).ok).toBe(true);
    // A retry buys nothing.
    const again = await r.executor.execute(proposal.proposalId, grant.grantId);
    expect(again.kind).toBe('duplicate');
    expect(r.flights.purchaseCount()).toBe(1);
  });

  it("a stay on the requester's card: one booking, one charge for the whole total, split equally among the six", async () => {
    const r = rig();
    const six = r.members.map((m) => m.memberId);
    const proposal = baseProposal(r, {
      proposalId: 'prop_stay',
      kind: 'lodging',
      provider: r.lodging.info.provider,
      itemRef: 'rate_bcn_eixample_3br_flex',
      quoteRef: 'rate_bcn_eixample_3br_flex',
      description: 'Eixample 3br',
      totalMinor: 138000,
      payers: six.map((memberId) => ({ memberId, shareMinor: 23000 })),
      attendees: six,
      idempotencyKey: 'key_stay',
    });
    const { grant } = seedApproved(r, proposal);
    const res = await r.executor.execute(proposal.proposalId, grant.grantId);
    expect(res.kind).toBe('completed');
    if (res.kind !== 'completed') return;
    expect(r.lodging.bookingCount()).toBe(1);
    expect(r.payments.chargeCount()).toBe(1);
    expect(r.payments.listCharges()[0]).toMatchObject({
      payerMemberId: 'mem_dean',
      amount: { amountMinor: 138000, currency: 'EUR' },
    });
    expect(res.booking.orderRef).toMatch(/^EIX/);
    expect(res.expense.split).toEqual({ method: 'equal', participants: six });
    expect(res.expense.category).toBe('lodging');
  });

  it('a ledger write that fails after the charge leaves the Booking row; the retry writes the expense once and reports repaired (T-009 r1 #1)', async () => {
    const r = rig();
    const six = r.members.map((m) => m.memberId);
    const proposal = baseProposal(r, {
      proposalId: 'prop_stay',
      kind: 'lodging',
      provider: r.lodging.info.provider,
      itemRef: 'rate_bcn_eixample_3br_flex',
      quoteRef: 'rate_bcn_eixample_3br_flex',
      description: 'Eixample 3br',
      totalMinor: 138000,
      payers: six.map((memberId) => ({ memberId, shareMinor: 23000 })),
      attendees: six,
      idempotencyKey: 'key_stay',
    });
    const { grant } = seedApproved(r, proposal);
    let ledgerDown = true;
    const expenses = r.stores.group.expenses;
    const stores: Stores = {
      ...r.stores,
      group: {
        ...r.stores.group,
        expenses: {
          ...expenses,
          create: (expense, entries) => {
            if (ledgerDown) throw new TravError('invariant_violation', 'ledger store down');
            expenses.create(expense, entries);
          },
        },
      },
    };
    const executor = createBookingExecutor({
      stores,
      providers: {
        tickets: r.tickets,
        flights: r.flights,
        lodging: r.lodging,
        payments: r.payments,
      },
      clock: createSimulatedClock(PLANNING),
      ids: createDeterministicIdGenerator('y'),
    });
    await expect(executor.execute(proposal.proposalId, grant.grantId)).rejects.toMatchObject({
      message: 'ledger store down',
    });
    const booking = r.stores.group.bookings.getBookingByKey('key_stay')!;
    expect(booking.status).toBe('confirmed');
    expect(booking.expenseId).toBeUndefined();
    expect(
      r.stores.group.expenses.getBySourceRef({ kind: 'booking', id: booking.bookingId }),
    ).toBeUndefined();

    ledgerDown = false;
    const retry = await executor.execute(proposal.proposalId, grant.grantId);
    expect(retry).toMatchObject({ kind: 'duplicate', repaired: true });
    if (retry.kind !== 'duplicate') throw new Error('not duplicate');
    expect(retry.expense?.amount).toEqual(money(138000, 'EUR'));
    expect(retry.booking.expenseId).toBe(retry.expense?.expenseId);
    expect(r.lodging.bookingCount()).toBe(1);
    expect(r.payments.chargeCount()).toBe(1);
    const again = await executor.execute(proposal.proposalId, grant.grantId);
    expect(again).toMatchObject({ kind: 'duplicate', repaired: false });
    expect(r.stores.group.expenses.listByTrip(T)).toHaveLength(1);
    expect(
      r.stores.group.audit.listByGroup(G).filter((e) => e.type === 'ledger.written'),
    ).toHaveLength(1);
    expect(auditCore.verifyAuditChain(r.stores.group.audit.listByGroup(G)).ok).toBe(true);
  });

  it('a member without a family name on file cannot be put on a flight: refused before any order, nothing invented', async () => {
    const r = rig();
    const dean = r.members.find((m) => m.memberId === 'mem_dean')!;
    r.stores.group.members.upsert({ ...dean, displayName: 'Dean' });
    const proposal = baseProposal(r, {
      proposalId: 'prop_flight2',
      kind: 'flight',
      provider: r.flights.info.provider,
      itemRef: 'off_nope',
      totalMinor: 41200,
      payers: [{ memberId: 'mem_dean', shareMinor: 41200 }],
      attendees: ['mem_dean'],
      paidBy: { kind: 'per_person_cards' },
      idempotencyKey: 'key_flight2',
    });
    const { grant } = seedApproved(r, proposal);
    const res = await r.executor.execute(proposal.proposalId, grant.grantId);
    // The unknown offer fails the re-price first; either way no order and no charge.
    expect(res.kind).toBe('failed');
    expect(r.flights.purchaseCount()).toBe(0);
    expect(travelerOf({ ...dean, displayName: 'Dean' })).toBeUndefined();
    expect(travelerOf({ ...dean, displayName: 'Dean Testperson' })).toEqual({
      memberId: 'mem_dean',
      givenName: 'Dean',
      familyName: 'Testperson',
    });
  });

  it('a kind no provider books is a typed failure, not a throw', async () => {
    const r = rig();
    const proposal = baseProposal(r, {
      proposalId: 'prop_cab',
      kind: 'transport',
      totalMinor: 2500,
      payers: [{ memberId: 'mem_dean', shareMinor: 2500 }],
      attendees: ['mem_dean'],
      idempotencyKey: 'key_cab',
    });
    const { grant } = seedApproved(r, proposal);
    const res = await r.executor.execute(proposal.proposalId, grant.grantId);
    expect(res).toMatchObject({ kind: 'failed', errorCode: 'not_supported', moneyMoved: false });
    expect(r.stores.group.bookings.getProposal('prop_cab')?.status).toBe('failed');
  });
});

describe('toApprovalProof and small helpers', () => {
  it('approvedBy always includes the requester, approvedAt is the last signature, maxAmount the total', () => {
    const r = rig();
    const proposal = baseProposal(r, {
      totalMinor: 9000,
      payers: FIVE.map((memberId) => ({ memberId, shareMinor: 1800 })),
      attendees: [...FIVE],
    });
    const { decision, grant } = seedApproved(r, proposal, 'mem_sam');
    const proof = toApprovalProof(grant, decision, proposal, 'aud_granted');
    expect(proof).toEqual({
      approvalId: grant.grantId,
      proposalId: proposal.proposalId,
      groupId: G,
      approvedBy: ['mem_dean', 'mem_sam'],
      approvedAt: r.now,
      expiresAt: grant.expiresAt,
      maxAmount: money(9000, 'EUR'),
      auditEventId: 'aud_granted',
    });
    // An incomplete grant never becomes a proof.
    expect(() =>
      toApprovalProof({ ...grant, complete: false, status: 'pending' }, decision, proposal, 'a'),
    ).toThrow(TravError);
    expect(() =>
      toApprovalProof(grant, { ...decision, proposalId: 'prop_other' }, proposal, 'a'),
    ).toThrow(/differ/);
  });

  it('a policy auto-approval (no signatures) is approved at the request time by the requester alone', () => {
    const r = rig();
    const proposal = baseProposal(r, {
      totalMinor: 1800,
      payers: [{ memberId: 'mem_dean', shareMinor: 1800 }],
      attendees: ['mem_dean'],
    });
    const decision: PolicyDecision = {
      proposalId: proposal.proposalId,
      outcome: 'auto_approve',
      reasons: ['within_all_caps'],
      ruleIds: ['A1'],
      approvalMode: 'none',
      requiredApprovers: [],
      expiresAt: null,
      existingBookingId: null,
      policySnapshot: r.stores.group.groups.get(G)!.spendingPolicy,
    };
    const grant = approval.createGrant(
      decision,
      'aud_eval',
      createDeterministicIdGenerator('g'),
      r.now,
    );
    const proof = toApprovalProof(grant, decision, proposal, 'aud_eval');
    expect(proof.approvedBy).toEqual(['mem_dean']);
    expect(proof.approvedAt).toBe(proposal.requestedAt);
  });

  it('parseSeat reads the mock seat strings', () => {
    expect(parseSeat({ section: 'gate 14 · sector 234', seat: 'row 8 · seat 11' })).toEqual({
      gate: '14',
      section: '234',
      row: '8',
      seat: '11',
    });
    expect(parseSeat({ section: 'sector 234', seat: 'seat 3' })).toEqual({
      section: '234',
      seat: '3',
    });
    expect(parseSeat({})).toBeUndefined();
  });
});
