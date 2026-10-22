/**
 * ApprovalHandler (T-030) end to end through the real runtime (offline model,
 * production send path in strict voice mode) with a recording fake executor
 * that writes a SAFETY §2.2-ordered trail. No provider purchase happens
 * anywhere in these tests (`tickets.purchaseCount()` stays 0): the handler is
 * the only caller of `BookingExecutor.execute`, and the executor is a fake.
 */
import { describe, expect, it } from 'vitest';
import type {
  Booking,
  BookingProposal,
  Expense,
  GroupSpendingPolicy,
  OutboundMessage,
  TicketArtifact,
} from '@trav/core';
import { approval, isReaction, ledger, markPrivate, money, TravError } from '@trav/core';
import type { BookingExecutor, ExecuteResult } from '../booking/executor.js';
import { expiryJobId } from '../booking/proposals.js';
import { BARCELONA } from '../compose.js';
import type { TurnResult } from '../loop.js';
import {
  FIVE,
  RAZZMATAZZ_ASK,
  harness,
  type Harness,
  type HarnessOptions,
} from '../runtime.testkit.js';
import { createApprovalHandler } from './handler.js';

const G = BARCELONA.groupId;
const T = BARCELONA.tripId;
const ACT = BARCELONA.razzmatazzActivityId;
const FOUR = ['mem_dean', 'mem_jordan', 'mem_priya', 'mem_sam'] as const;

type FakeMode =
  'complete' | 'fail' | 'throw' | 'refuse_price' | 'refuse_reproposed' | 'refuse_expired';

interface Fake {
  readonly executor: BookingExecutor;
  readonly calls: { proposalId: string; grantId: string }[];
}

/** A T-009-shaped executor: checkGrant → attempted → booking → completed → ledger → tickets → consume. */
function fakeExecutor(get: () => Harness, mode: FakeMode = 'complete'): Fake {
  const calls: { proposalId: string; grantId: string }[] = [];
  const executor: BookingExecutor = {
    async execute(proposalId, grantId): Promise<ExecuteResult> {
      calls.push({ proposalId, grantId });
      const h = get();
      const s = h.runtime.stores;
      const b = s.group.bookings;
      const now = h.clock.now();
      const proposal = b.getProposal(proposalId);
      const grant = b.getGrant(grantId);
      const decision = b.getDecision(proposalId)?.decision;
      if (proposal === undefined || grant === undefined || decision === undefined) {
        throw new TravError('grant_invalid', 'unknown ids');
      }
      if (mode === 'throw') throw new TravError('not_implemented', 'executor stub');
      const check = approval.checkGrant(grant, proposal, decision, now);
      if (!check.valid) return { kind: 'refused', reason: check.reason };
      if (mode === 'refuse_expired') return { kind: 'refused', reason: 'expired' };
      if (mode === 'fail') {
        return {
          kind: 'failed',
          errorCode: 'provider_unavailable',
          retriable: true,
          moneyMoved: false,
        };
      }
      if (mode === 'refuse_price') {
        const invalidated = approval.invalidateGrant(grant, 'price_changed');
        b.saveGrant(invalidated);
        s.group.audit.append(
          approval.invalidatedAuditInput(invalidated, proposal, { kind: 'trav', id: 'trav' }),
        );
        return { kind: 'refused', reason: 'price_changed' };
      }
      if (mode === 'refuse_reproposed') {
        // An executor that re-quotes itself: the handler must post that card.
        const invalidated = approval.invalidateGrant(grant, 'price_changed');
        b.saveGrant(invalidated);
        s.group.audit.append(
          approval.invalidatedAuditInput(invalidated, proposal, { kind: 'trav', id: 'trav' }),
        );
        b.updateProposal({ ...proposal, status: 'superseded' });
        await h.runtime.proposals.releaseHold(proposal);
        const res = await h.runtime.proposals.repropose(proposal, proposal.attendees, 'msg_exec');
        if (res.kind !== 'proposal') throw new Error(`re-quote failed: ${res.kind}`);
        return { kind: 'refused', reason: 'price_changed', reproposalId: res.proposal.proposalId };
      }
      const existing = b.getBookingByKey(proposal.idempotencyKey);
      if (existing !== undefined) return { kind: 'duplicate', booking: existing };

      const ids = h.ids;
      const auditIds: string[] = [];
      const common = {
        groupId: proposal.groupId,
        tripId: proposal.tripId,
        proposalId: proposal.proposalId,
        idempotencyKey: proposal.idempotencyKey,
        visibility: 'group' as const,
        actor: { kind: 'trav' as const, id: 'trav' },
      };
      const bookingId = ids.next('bk');
      auditIds.push(
        s.group.audit.append({
          ...common,
          type: 'booking.attempted',
          bookingId,
          payload: {
            idempotencyKey: proposal.idempotencyKey,
            quoteRef: proposal.quoteRef,
            grantId,
          },
        }).id,
      );
      const orderRef = `RZ-${String(calls.length).padStart(5, '0')}`;
      const completed = s.group.audit.append({
        ...common,
        type: 'booking.completed',
        bookingId,
        payload: {
          providerRef: `mock-tickets:${orderRef}`,
          totalMinor: proposal.totalMinor,
          currency: proposal.currency,
          payers: proposal.payers,
          attendees: proposal.attendees,
          refundable: proposal.refundable,
        },
      });
      auditIds.push(completed.id);
      const tickets = proposal.attendees.map((m, i) => ({
        ticketId: `${bookingId}_t${String(i + 1)}`,
        holderMemberId: m,
        deliveredToMemberId: m,
      }));
      const expenseId = ids.next('exp');
      const booking: Booking = {
        bookingId,
        proposalId: proposal.proposalId,
        groupId: proposal.groupId,
        tripId: proposal.tripId,
        ...(proposal.activityId !== undefined ? { activityId: proposal.activityId } : {}),
        kind: proposal.kind,
        provider: proposal.provider,
        providerRef: `mock-tickets:${orderRef}`,
        orderRef,
        description: proposal.description,
        merchant: 'Razzmatazz',
        totalMinor: proposal.totalMinor,
        currency: proposal.currency,
        payers: proposal.payers,
        attendees: proposal.attendees,
        paidBy: proposal.paidBy,
        refundable: proposal.refundable,
        ...(proposal.refundDeadline !== undefined
          ? { refundDeadline: proposal.refundDeadline }
          : {}),
        idempotencyKey: proposal.idempotencyKey,
        purchasedAt: now,
        status: 'confirmed',
        tickets,
        expenseId,
        completedAuditEventId: completed.id,
      };
      b.createBooking(booking);
      const members = s.group.members.listByGroup(proposal.groupId);
      const order = members.map((m) => m.memberId);
      const expense: Expense = {
        expenseId,
        groupId: proposal.groupId,
        tripId: proposal.tripId,
        description: 'razzmatazz tickets',
        merchantDisplay: 'Razzmatazz',
        category: 'tickets',
        amount: money(proposal.totalMinor, proposal.currency),
        paidBy: [
          {
            memberId:
              proposal.paidBy.kind === 'member_card'
                ? proposal.paidBy.memberId
                : proposal.requestedBy,
            amount: money(proposal.totalMinor, proposal.currency),
          },
        ],
        split: { method: 'equal', participants: [...proposal.attendees] },
        source: 'booking',
        sourceRef: { kind: 'booking', id: bookingId },
        ...(proposal.activityId !== undefined ? { activityId: proposal.activityId } : {}),
        occurredAt: now,
        createdAt: now,
        createdBy: proposal.requestedBy,
        status: 'logged',
      };
      s.group.expenses.create(
        expense,
        ledger.buildLedgerEntries(expense, { memberOrder: order, participantsUniverse: order }),
      );
      auditIds.push(
        s.group.audit.append({
          ...common,
          type: 'ledger.written',
          bookingId,
          payload: { expenseId, bookingId, splitMethod: 'equal' },
        }).id,
      );
      for (const t of tickets) {
        const holder = members.find((m) => m.memberId === t.holderMemberId)!;
        const artifact: TicketArtifact = markPrivate({
          id: `priv_${t.ticketId}`,
          ownerMemberId: t.holderMemberId,
          groupId: proposal.groupId,
          tripId: proposal.tripId,
          createdAt: now,
          ticketId: t.ticketId,
          bookingId,
          holderName: holder.displayName,
          event: {
            name: proposal.description,
            venue: 'Razzmatazz',
            address: 'Carrer dels Almogàvers 122',
            startsAt: '2026-03-15T00:00:00+01:00',
            doorsAt: '2026-03-15T00:00:00+01:00',
          },
          qrPayload: `${orderRef}:${t.ticketId}:SECRET`,
          qrDataUrl: `data:image/png;base64,QR${t.ticketId}`,
          deliveredToMemberId: t.deliveredToMemberId,
        });
        s.private.putTicket(t.holderMemberId, artifact);
      }
      b.saveGrant(approval.consumeGrant(grant));
      b.updateProposal({ ...proposal, status: 'completed' });
      return { kind: 'completed', booking, expense, auditEventIds: auditIds };
    },
  };
  return { executor, calls };
}

function rig(mode: FakeMode = 'complete', opts: Omit<HarnessOptions, 'executor'> = {}) {
  // The fake reads the harness lazily: it is only ever called after `h` exists.
  const fake = fakeExecutor(() => h, mode);
  const h: Harness = harness({ ...opts, executor: fake.executor });
  return { h, fake };
}

function messages(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o));
}

function groupMessages(r: TurnResult): OutboundMessage[] {
  return messages(r).filter((m) => m.to.kind === 'group');
}

function dms(r: TurnResult): OutboundMessage[] {
  return messages(r).filter((m) => m.to.kind === 'member');
}

async function propose(h: Harness, from = 'h_dean', text = RAZZMATAZZ_ASK) {
  const turn = await h.say(from, text);
  const proposal = h.pending()[0];
  if (proposal === undefined) throw new Error(`no pending proposal (note ${turn.note})`);
  return { turn, proposal, cardMessageId: groupMessages(turn)[0]!.id };
}

function setPolicy(h: Harness, patch: Partial<GroupSpendingPolicy>): void {
  const grp = h.runtime.stores.group.groups.get(G)!;
  h.runtime.stores.group.groups.update({
    ...grp,
    spendingPolicy: { ...grp.spendingPolicy, ...patch },
  });
}

function status(h: Harness, proposalId: string): BookingProposal['status'] | undefined {
  return h.runtime.stores.group.bookings.getProposal(proposalId)?.status;
}

function grantStatus(h: Harness, proposalId: string): string | undefined {
  return h.runtime.stores.group.bookings.getGrantForProposal(proposalId)?.status;
}

function attempts(h: Harness) {
  return h.audit().filter((e) => e.type === 'approval.invalid_attempt');
}

function expiryJobs(h: Harness): string[] {
  return h.runtime.scheduler.list().map((j) => j.jobId);
}

describe('the Razzmatazz moment: 5 of 6, one tap, one purchase (CLAUDE.md §8)', () => {
  it("Dean's Approve books for the 5, posts the receipt FROM the audit log, DMs 5 QR tickets, splits 5 ways; Henry gets nothing", async () => {
    const { h, fake } = rig();
    const { proposal, cardMessageId } = await propose(h);
    expect(proposal.attendees).toEqual([...FIVE]);

    const turn = await h.tap('h_dean', cardMessageId, 'approve');
    expect(turn.note).toBe('approval:handled');
    const grant = h.runtime.stores.group.bookings.getGrantForProposal(proposal.proposalId)!;
    expect(fake.calls).toEqual([{ proposalId: proposal.proposalId, grantId: grant.grantId }]);
    expect(h.tickets.purchaseCount()).toBe(0);

    // One group message: the receipt card, verified against the audit trail.
    const group = groupMessages(turn);
    expect(group).toHaveLength(1);
    const receipt = group[0]!;
    expect(receipt.card?.type).toBe('receipt');
    expect(receipt.text.split('\n')[0]).toBe('booked ✅ razzmatazz, 5 tickets, €90');
    expect(receipt.text).toContain('QR codes are in your dms, one each');
    expect(receipt.text).toContain('tab: Maya, Jordan, Priya, Sam → Dean €18');
    expect(receipt.text).not.toContain('SECRET');

    // Five ticket DMs, one per attendee, none for Henry; QR payloads only on the DM lane.
    const tickets = dms(turn);
    expect(tickets).toHaveLength(5);
    expect(tickets.map((m) => (m.to.kind === 'member' ? m.to.memberId : '')).sort()).toEqual(
      [...FIVE].sort(),
    );
    expect(tickets.every((m) => m.card?.type === 'ticket')).toBe(true);
    expect(h.channel.dmTranscript('h_henry')).toEqual([]);
    expect(h.channel.dmTranscript('h_maya').filter((e) => e.direction === 'outbound')).toHaveLength(
      1,
    );
    expect(h.channel.groupTranscript().some((e) => JSON.stringify(e).includes('SECRET'))).toBe(
      false,
    );

    // Ledger: one expense split among exactly the 5, balances net to zero.
    const expenses = h.runtime.stores.group.expenses.listByTrip(T);
    expect(expenses).toHaveLength(1);
    expect(expenses[0]!.split).toEqual({ method: 'equal', participants: [...FIVE] });
    const entries = h.runtime.stores.group.expenses.listEntries(T);
    expect(
      entries
        .filter((e) => e.kind === 'owes')
        .map((e) => e.memberId)
        .sort(),
    ).toEqual([...FIVE].sort());
    expect(entries.some((e) => e.memberId === 'mem_henry')).toBe(false);
    expect(
      entries.reduce(
        (a, e) => a + (e.kind === 'paid' ? e.amount.amountMinor : -e.amount.amountMinor),
        0,
      ),
    ).toBe(0);

    // Audit order (SAFETY §2.2) and terminal state.
    const types = h.auditTypes();
    const idx = (t: string) => types.indexOf(t);
    expect(idx('policy.evaluated')).toBeLessThan(idx('approval.granted'));
    expect(idx('approval.granted')).toBeLessThan(idx('booking.attempted'));
    expect(idx('booking.attempted')).toBeLessThan(idx('booking.completed'));
    expect(idx('booking.completed')).toBeLessThan(idx('ledger.written'));
    const granted = h.audit().find((e) => e.type === 'approval.granted')!;
    expect(granted.payload).toMatchObject({ memberId: 'mem_dean', via: 'button', complete: true });
    expect(granted.lifecycle).toEqual({ complete: true });
    expect(status(h, proposal.proposalId)).toBe('completed');
    expect(grantStatus(h, proposal.proposalId)).toBe('consumed');
    expect(expiryJobs(h)).not.toContain(expiryJobId(proposal.proposalId));
  });

  it('a double 👍 (tapback twice) and a button double-press reach the executor exactly once', async () => {
    const { h, fake } = rig();
    const { proposal, cardMessageId } = await propose(h);
    await h.react('h_dean', cardMessageId, '👍');
    expect(fake.calls).toHaveLength(1);
    const again = await h.react('h_dean', cardMessageId, '👍');
    expect(again.silent).toBe(true);
    const pressed = await h.tap('h_dean', cardMessageId, 'approve');
    expect(pressed.silent).toBe(true);
    const typed = await h.say('h_dean', 'yes');
    expect(typed.silent).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(h.runtime.stores.group.bookings.listByTrip(T)).toHaveLength(1);
    expect(h.runtime.stores.group.expenses.listByTrip(T)).toHaveLength(1);
    expect(status(h, proposal.proposalId)).toBe('completed');
  });

  it('two taps racing inside one turn still execute once (the in-flight guard)', async () => {
    const { h, fake } = rig();
    const { proposal } = await propose(h);
    const handler = createApprovalHandler({
      stores: h.runtime.stores,
      executor: {
        execute: async (p, g) => {
          await new Promise((r) => setTimeout(r, 5));
          return fake.executor.execute(p, g);
        },
      },
      proposals: h.runtime.proposals,
      scheduler: h.runtime.scheduler,
      clock: h.clock,
      ids: h.ids,
    });
    const ev = (messageId: string) => ({
      kind: 'approve' as const,
      senderId: 'h_dean',
      via: 'button' as const,
      messageId,
      at: h.clock.now(),
      proposalId: proposal.proposalId,
    });
    const [a, b] = await Promise.all([handler.handle(ev('t1')), handler.handle(ev('t2'))]);
    expect(fake.calls).toHaveLength(1);
    expect(a.length + b.length).toBeGreaterThan(0);
    expect(attempts(h).at(-1)?.payload).toMatchObject({ cause: 'not_pending', messageId: 't2' });
  });

  it("the requester need not be the approver: Sam's 👍 books Dean's proposal", async () => {
    const { h, fake } = rig();
    const { proposal, cardMessageId } = await propose(h);
    const turn = await h.react('h_sam', cardMessageId, '👍');
    expect(turn.note).toBe('approval:handled');
    expect(fake.calls.map((c) => c.proposalId)).toEqual([proposal.proposalId]);
    const grant = h.runtime.stores.group.bookings.getGrantForProposal(proposal.proposalId)!;
    expect(grant.grantedBy.map((g) => g.memberId)).toEqual(['mem_sam']);
    expect(groupMessages(turn)[0]?.card?.type).toBe('receipt');
  });

  it('typed aliases take the same path: "book it" from Dean books; the card then stays dead', async () => {
    const { h, fake } = rig();
    const { cardMessageId } = await propose(h);
    const turn = await h.say('h_dean', 'book it');
    expect(turn.note).toBe('approval:handled');
    expect(fake.calls).toHaveLength(1);
    expect((await h.tap('h_maya', cardMessageId, 'not_me')).silent).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('approver eligibility (VOICE §6, SAFETY §2.5)', () => {
  it("a 👍 from someone outside the policy's approver set is ignored silently with approval.invalid_attempt{not_required_approver}", async () => {
    const { h, fake } = rig();
    setPolicy(h, { approvers: ['mem_dean'] });
    const { proposal, cardMessageId } = await propose(h);
    const turn = await h.react('h_maya', cardMessageId, '👍');
    expect(turn.silent).toBe(true);
    expect(turn.outbound).toEqual([]);
    expect(attempts(h).at(-1)?.payload).toMatchObject({
      cause: 'not_required_approver',
      senderId: 'h_maya',
      via: 'reaction',
    });
    expect(fake.calls).toEqual([]);
    expect(status(h, proposal.proposalId)).toBe('pending');
    expect(grantStatus(h, proposal.proposalId)).toBe('pending');
    // Dean's 👍 then books it.
    await h.react('h_dean', cardMessageId, '👍');
    expect(fake.calls).toHaveLength(1);
  });

  it('each_payer mode (over the per-person cap): every charged adult must 👍; Henry (not charged) cannot; one purchase at the end', async () => {
    const { h, fake } = rig();
    setPolicy(h, { perPersonAutoCapMinor: 1000 });
    const { proposal, cardMessageId } = await propose(h);
    const decision = h.runtime.stores.group.bookings.getDecision(proposal.proposalId)!.decision;
    expect(decision.approvalMode).toBe('each_payer');
    expect([...decision.requiredApprovers].sort()).toEqual([...FIVE].sort());

    const first = await h.react('h_dean', cardMessageId, '👍');
    expect(groupMessages(first)[0]?.text).toBe(
      'Dean okayed it. still need 👍 from Maya, Jordan, Priya, Sam',
    );
    expect(fake.calls).toEqual([]);
    const henry = await h.react('h_henry', cardMessageId, '👍');
    expect(henry.silent).toBe(true);
    expect(attempts(h).at(-1)?.payload).toMatchObject({
      cause: 'not_required_approver',
      senderId: 'h_henry',
    });
    expect((await h.react('h_dean', cardMessageId, '👍')).silent).toBe(true);
    expect(attempts(h).at(-1)?.payload).toMatchObject({ cause: 'already_granted' });
    for (const handle of ['h_maya', 'h_jordan', 'h_priya']) {
      await h.tap(handle, cardMessageId, 'approve');
      expect(fake.calls).toEqual([]);
    }
    const last = await h.say('h_sam', 'yes', { replyToMessageId: cardMessageId });
    expect(fake.calls).toHaveLength(1);
    expect(groupMessages(last)[0]?.card?.type).toBe('receipt');
    const grants = h.audit().filter((e) => e.type === 'approval.granted');
    expect(grants.map((e) => e.payload['complete'])).toEqual([false, false, false, false, true]);
  });

  it('handler-level: unknown senders, guests and minors are invalid attempts, never grants', async () => {
    const { h, fake } = rig();
    const { proposal } = await propose(h);
    const handler = h.runtime.approvalHandler;
    const ev = (senderId: string) => ({
      kind: 'approve' as const,
      senderId,
      via: 'reaction' as const,
      messageId: `m_${senderId}`,
      at: h.clock.now(),
      proposalId: proposal.proposalId,
    });
    expect(await handler.handle(ev('h_nobody'))).toEqual([]);
    expect(attempts(h).at(-1)?.payload).toMatchObject({
      cause: 'not_member',
      senderId: 'h_nobody',
    });
    const sam = h.runtime.stores.group.members.get('mem_sam')!;
    h.runtime.stores.group.members.upsert({ ...sam, birthDate: '2012-02-01', ageBand: 'under18' });
    expect(await handler.handle(ev('h_sam'))).toEqual([]);
    expect(attempts(h).at(-1)?.payload).toMatchObject({ cause: 'minor' });
    h.runtime.stores.group.members.upsert({ ...sam, role: 'guest' });
    expect(await handler.handle(ev('h_sam'))).toEqual([]);
    expect(attempts(h).at(-1)?.payload).toMatchObject({ cause: 'guest' });
    expect(fake.calls).toEqual([]);
    expect(grantStatus(h, proposal.proposalId)).toBe('pending');
  });
});

describe('"not me" supersedes with a re-proposal (VOICE §6.2)', () => {
  it('Maya\'s "not me" marks her out, invalidates the grant, supersedes the proposal and posts a 4-ticket one; the old card is dead', async () => {
    const { h, fake } = rig();
    const { proposal, cardMessageId } = await propose(h);
    const turn = await h.tap('h_maya', cardMessageId, 'not_me');
    expect(turn.note).toBe('approval:handled');

    const group = groupMessages(turn);
    expect(group).toHaveLength(1);
    const card = group[0]!;
    expect(card.card?.type).toBe('booking_proposal');
    expect(card.text.split('\n').slice(0, 3)).toEqual([
      'razzmatazz tonight, 4 tickets',
      'Dean, Jordan, Priya, Sam (not Henry, Maya)',
      '€18 each · €72 total · refundable until 10pm',
    ]);
    const next = h.pending();
    expect(next).toHaveLength(1);
    expect(next[0]!.attendees).toEqual([...FOUR]);
    expect(next[0]!.payers.map((p) => p.memberId)).toEqual([...FOUR]);
    expect(next[0]!.totalMinor).toBe(7200);
    expect(next[0]!.requestedBy).toBe('mem_dean');

    const old = h.runtime.stores.group.bookings.getProposal(proposal.proposalId)!;
    expect(old.status).toBe('superseded');
    expect(old.supersededBy).toBe(next[0]!.proposalId);
    expect(grantStatus(h, proposal.proposalId)).toBe('invalidated');
    const types = h.auditTypes();
    expect(types.indexOf('approval.invalidated')).toBeLessThan(
      types.indexOf('proposal.superseded'),
    );
    expect(h.audit().find((e) => e.type === 'approval.invalidated')?.payload).toMatchObject({
      cause: 'payers_changed',
      grantId: expect.any(String),
    });
    expect(h.audit().find((e) => e.type === 'proposal.superseded')?.payload).toMatchObject({
      why: 'not_me',
      supersededBy: next[0]!.proposalId,
    });
    const row = h.runtime.stores.group.trips
      .listAttendance(ACT)
      .find((r) => r.memberId === 'mem_maya');
    expect(row?.status).toBe('out');

    // The old card's actions are dead; the new one books for 4.
    expect((await h.tap('h_dean', cardMessageId, 'approve')).silent).toBe(true);
    expect(fake.calls).toEqual([]);
    const booked = await h.tap('h_dean', card.id, 'approve');
    expect(fake.calls.map((c) => c.proposalId)).toEqual([next[0]!.proposalId]);
    expect(groupMessages(booked)[0]?.text.split('\n')[0]).toBe(
      'booked ✅ razzmatazz, 4 tickets, €72',
    );
    expect(dms(booked)).toHaveLength(4);
    expect(h.channel.dmTranscript('h_maya')).toEqual([]);
  });

  it('the superseded proposal never posts an expiry line; the replacement expires once (exactly one line)', async () => {
    const { h, fake } = rig();
    const { proposal, cardMessageId } = await propose(h);
    await h.say('h_maya', 'not me', { replyToMessageId: cardMessageId });
    const next = h.pending()[0]!;
    expect(expiryJobs(h)).toEqual([expiryJobId(next.proposalId)]);
    h.clock.advanceMs(20 * 60 * 1000);
    const turns = await h.runtime.drain();
    expect(turns.map((t) => t.note)).toEqual(['scheduled:proposal_expiry']);
    expect(groupMessages(turns[0]!).map((m) => m.text)).toEqual([
      'razzmatazz proposal expired, no charge. @ me if you still want it',
    ]);
    expect(status(h, proposal.proposalId)).toBe('superseded');
    expect(status(h, next.proposalId)).toBe('expired');
    expect(await h.runtime.drain()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('"not me" from someone not charged marks them out on the roster, or says they are not on it; nothing is superseded', async () => {
    const { h } = rig();
    const { proposal, cardMessageId } = await propose(h);
    // Henry is already out (the ask synced the roster): just the line.
    const henry = await h.tap('h_henry', cardMessageId, 'not_me');
    expect(groupMessages(henry)[0]?.text).toBe(
      "you're not on that one, Henry. it's Dean, Maya, Jordan, Priya, Sam",
    );
    expect(status(h, proposal.proposalId)).toBe('pending');
    expect(h.pending()).toHaveLength(1);
  });

  it('the last attendee saying "not me" drops the proposal instead of re-proposing for nobody', async () => {
    const { h, fake } = rig();
    for (const id of ['mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam', 'mem_henry']) {
      h.runtime.stores.group.trips.setAttendance({
        activityId: ACT,
        memberId: id,
        status: 'out',
        updatedAt: h.clock.now(),
        sourceMessageId: 'msg_prior',
        setBy: id,
      });
    }
    const { proposal, cardMessageId } = await propose(
      h,
      'h_dean',
      '@trav get the 1 of us Razzmatazz tickets',
    );
    expect(proposal.attendees).toEqual(['mem_dean']);
    const turn = await h.tap('h_dean', cardMessageId, 'not_me');
    expect(groupMessages(turn)[0]?.text).toBe("dropped razzmatazz, nobody's left on it. no charge");
    expect(status(h, proposal.proposalId)).toBe('rejected');
    expect(h.pending()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe('roster change before approval invalidates the grant and re-prices', () => {
  it('"@trav Maya\'s out" mid-flow ⇒ approval.invalidated{payers_changed}, a 4-ticket re-proposal in that same turn, and a fresh 👍 is required', async () => {
    const { h, fake } = rig();
    const { proposal, cardMessageId } = await propose(h);
    const turn = await h.say('h_dean', "@trav Maya's out");
    expect(turn.note).toBe('roster:changed');
    // One group message for the turn: the re-proposal (its "who" line carries the change).
    const group = groupMessages(turn);
    expect(group).toHaveLength(1);
    expect(group[0]!.card?.type).toBe('booking_proposal');
    expect(group[0]!.text).toContain('Dean, Jordan, Priya, Sam (not Henry, Maya)');
    expect(group[0]!.text).toContain('€72 total');

    expect(status(h, proposal.proposalId)).toBe('superseded');
    expect(grantStatus(h, proposal.proposalId)).toBe('invalidated');
    expect(h.audit().find((e) => e.type === 'approval.invalidated')?.payload).toMatchObject({
      cause: 'payers_changed',
    });
    expect(h.audit().find((e) => e.type === 'proposal.superseded')?.payload).toMatchObject({
      why: 'roster_changed',
    });
    expect(JSON.stringify(h.audit())).not.toMatch(/sick|out tonight/i);

    // The old card is dead; the new proposal needs its own approval, then executes once with the new ids.
    expect((await h.tap('h_dean', cardMessageId, 'approve')).silent).toBe(true);
    expect(fake.calls).toEqual([]);
    const next = h.pending()[0]!;
    expect(next.attendees).toEqual([...FOUR]);
    await h.tap('h_dean', group[0]!.id, 'approve');
    expect(fake.calls).toEqual([{ proposalId: next.proposalId, grantId: fake.calls[0]!.grantId }]);
    expect(fake.calls[0]!.proposalId).not.toBe(proposal.proposalId);
  });

  it('a member joining mid-flow ("@trav Henry\'s in") re-prices to 6 and nothing is granted by that message', async () => {
    const { h, fake } = rig();
    const { proposal } = await propose(h);
    const turn = await h.say('h_dean', "@trav Henry's in");
    expect(turn.note).toBe('roster:changed');
    expect(groupMessages(turn)[0]!.text.split('\n').slice(0, 2)).toEqual([
      'razzmatazz tonight, 6 tickets',
      'Dean, Henry, Maya, Jordan, Priya, Sam',
    ]);
    expect(status(h, proposal.proposalId)).toBe('superseded');
    expect(h.audit().filter((e) => e.type === 'approval.granted')).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(h.pending()[0]!.totalMinor).toBe(10800);
  });

  it('a roster that drifted without a notice (rows changed directly) is caught at approval time: no execute, re-proposal', async () => {
    const { h, fake } = rig();
    const { proposal, cardMessageId } = await propose(h);
    h.runtime.stores.group.trips.setAttendance({
      activityId: ACT,
      memberId: 'mem_sam',
      status: 'maybe',
      updatedAt: h.clock.now(),
      sourceMessageId: 'msg_tool',
      setBy: 'mem_sam',
    });
    const turn = await h.tap('h_dean', cardMessageId, 'approve');
    expect(fake.calls).toEqual([]);
    expect(status(h, proposal.proposalId)).toBe('superseded');
    expect(h.audit().filter((e) => e.type === 'approval.granted')).toEqual([]);
    const card = groupMessages(turn)[0]!;
    expect(card.card?.type).toBe('booking_proposal');
    expect(card.text).toContain('Dean, Maya, Jordan, Priya (not Henry, Sam)');
    expect(h.pending()[0]!.attendees).toEqual(['mem_dean', 'mem_maya', 'mem_jordan', 'mem_priya']);
  });

  it('an empty roster blocks the purchase: checkProposalConsistency ⇒ empty_roster, the grant is invalidated, Trav asks who is in', async () => {
    const { h, fake } = rig();
    const { proposal, cardMessageId } = await propose(h);
    for (const id of FIVE) {
      h.runtime.stores.group.trips.setAttendance({
        activityId: ACT,
        memberId: id,
        status: 'out',
        updatedAt: h.clock.now(),
        sourceMessageId: 'msg_tool',
        setBy: id,
      });
    }
    const members = h.runtime.stores.group.members.listByGroup(G);
    const trip = h.runtime.stores.group.trips.get(T)!;
    const activity = h.runtime.stores.group.trips.getActivity(ACT)!;
    const check = approval.checkProposalConsistency(
      proposal,
      trip,
      activity,
      {
        activityId: ACT,
        inMemberIds: [],
        outMemberIds: [...FIVE, 'mem_henry'],
        maybeMemberIds: [],
        asOf: h.clock.now(),
      },
      members,
      h.clock.now(),
    );
    expect(check.ok).toBe(false);
    expect(check.problems).toContain('empty_roster');

    const turn = await h.tap('h_dean', cardMessageId, 'approve');
    expect(fake.calls).toEqual([]);
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(groupMessages(turn).map((m) => m.text)).toEqual([
      "who's in? nobody is marked in for that one yet",
    ]);
    expect(status(h, proposal.proposalId)).toBe('superseded');
    expect(grantStatus(h, proposal.proposalId)).toBe('invalidated');
    expect(h.audit().find((e) => e.type === 'approval.invalidated')?.payload).toMatchObject({
      cause: 'payers_changed',
      problems: expect.arrayContaining(['empty_roster']),
    });
    expect(h.pending()).toEqual([]);
  });
});

describe('decline (VOICE §6.2)', () => {
  it("Dean's 👎 rejects: approval.rejected, hold released, one line, and later taps are dead", async () => {
    const { h, fake } = rig();
    const { proposal, cardMessageId } = await propose(h);
    const turn = await h.react('h_dean', cardMessageId, '👎');
    expect(groupMessages(turn).map((m) => m.text)).toEqual(['dropped razzmatazz. no charge']);
    expect(status(h, proposal.proposalId)).toBe('rejected');
    expect(grantStatus(h, proposal.proposalId)).toBe('rejected');
    expect(h.audit().find((e) => e.type === 'approval.rejected')?.payload).toMatchObject({
      memberId: 'mem_dean',
      via: 'reaction',
    });
    expect(expiryJobs(h)).toEqual([]);
    expect((await h.tap('h_dean', cardMessageId, 'approve')).silent).toBe(true);
    expect(fake.calls).toEqual([]);
    // No expiry line later for a declined proposal.
    h.clock.advanceMs(20 * 60 * 1000);
    expect(await h.runtime.drain()).toEqual([]);
  });

  it('a "no" from someone who may not approve or cancel is ignored with approval.invalid_attempt', async () => {
    const { h } = rig();
    setPolicy(h, { approvers: ['mem_dean'] });
    const { proposal, cardMessageId } = await propose(h);
    const turn = await h.say('h_maya', 'nah', { replyToMessageId: cardMessageId });
    expect(turn.silent).toBe(true);
    expect(attempts(h).at(-1)?.payload).toMatchObject({
      cause: 'not_required_approver',
      intent: 'decline',
    });
    expect(status(h, proposal.proposalId)).toBe('pending');
  });
});

describe('15-minute expiry posts exactly one line (VOICE §6.4)', () => {
  it('the proposal_expiry job: one line, then a late 👍 is silent and never executes', async () => {
    const { h, fake } = rig();
    const { proposal, cardMessageId } = await propose(h);
    h.clock.advanceMs(16 * 60 * 1000);
    const turns = await h.runtime.drain();
    expect(turns).toHaveLength(1);
    expect(groupMessages(turns[0]!).map((m) => m.text)).toEqual([
      'razzmatazz proposal expired, no charge. @ me if you still want it',
    ]);
    expect(status(h, proposal.proposalId)).toBe('expired');
    const late = await h.tap('h_dean', cardMessageId, 'approve');
    expect(late.silent).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(await h.runtime.drain()).toEqual([]);
    expect(h.channel.groupTranscript().filter((e) => e.direction === 'outbound')).toHaveLength(2);
  });

  it('a 👍 that lands after expiry but before the job drains expires it right there: still exactly one line', async () => {
    const { h, fake } = rig();
    const { proposal, cardMessageId } = await propose(h);
    h.clock.advanceMs(16 * 60 * 1000);
    const late = await h.tap('h_dean', cardMessageId, 'approve');
    expect(groupMessages(late).map((m) => m.text)).toEqual([
      'razzmatazz proposal expired, no charge. @ me if you still want it',
    ]);
    expect(status(h, proposal.proposalId)).toBe('expired');
    expect(attempts(h).at(-1)?.payload).toMatchObject({ cause: 'expired' });
    expect(h.auditTypes().filter((t) => t === 'approval.expired')).toHaveLength(1);
    expect(fake.calls).toEqual([]);
    // The job was cancelled: draining posts nothing more.
    expect(await h.runtime.drain()).toEqual([]);
    expect(h.channel.groupTranscript().filter((e) => e.direction === 'outbound')).toHaveLength(2);
  });
});

describe('late joiner after the booking', () => {
  it('"@trav i\'m in" from Henry after the 5 are booked ⇒ a separate 1-ticket add-on proposal, never a re-buy', async () => {
    const { h, fake } = rig();
    const { cardMessageId } = await propose(h);
    await h.tap('h_dean', cardMessageId, 'approve');
    expect(fake.calls).toHaveLength(1);

    const turn = await h.say('h_henry', "@trav i'm in");
    expect(turn.note).toBe('roster:changed');
    const group = groupMessages(turn);
    expect(group).toHaveLength(1);
    const card = group[0]!;
    expect(card.card?.type).toBe('booking_proposal');
    expect(card.text.split('\n').slice(0, 3)).toEqual([
      "razzmatazz tonight, 1 more ticket (5 already booked, this one's separate)",
      'Henry',
      '€18 each · €18 total · refundable until 10pm',
    ]);
    const addOn = h.pending()[0]!;
    expect(addOn.attendees).toEqual(['mem_henry']);
    expect(addOn.payers).toEqual([{ memberId: 'mem_henry', shareMinor: 1800 }]);
    expect(addOn.requestedBy).toBe('mem_henry');

    // Approving it executes once more, for Henry only; the five are untouched.
    const booked = await h.tap('h_henry', card.id, 'approve');
    expect(fake.calls.map((c) => c.proposalId)).toEqual([
      fake.calls[0]!.proposalId,
      addOn.proposalId,
    ]);
    expect(groupMessages(booked)[0]?.text.split('\n')[0]).toBe(
      'booked ✅ razzmatazz, 1 ticket, €18',
    );
    expect(dms(booked).map((m) => (m.to.kind === 'member' ? m.to.memberId : ''))).toEqual([
      'mem_henry',
    ]);
    expect(h.runtime.stores.group.bookings.listByTrip(T)).toHaveLength(2);
    // Roll call now counts six, and a second "i'm in" from Henry changes nothing.
    const roll = await h.say('h_dean', "@trav who's in tonight?");
    expect(groupMessages(roll)[0]?.text).toBe(
      'razzmatazz tonight: 6 in · Dean, Henry, Maya, Jordan, Priya, Sam',
    );
    expect((await h.say('h_henry', "@trav i'm in")).note).toBe('roster:unchanged');
    expect(h.pending()).toEqual([]);
  });
});

describe('executor outcomes other than completed', () => {
  it('an executor that throws (the T-009 stub) ⇒ booking.failed, a VOICE §4.10 two-liner, no second attempt', async () => {
    const { h, fake } = rig('throw');
    const { proposal, cardMessageId } = await propose(h);
    const turn = await h.tap('h_dean', cardMessageId, 'approve');
    expect(groupMessages(turn).map((m) => m.text)).toEqual([
      "couldn't book razzmatazz. no charge went through\n@ me again in a few and i'll retry",
    ]);
    expect(h.audit().find((e) => e.type === 'booking.failed')?.payload).toMatchObject({
      errorCode: 'not_implemented',
      retriable: true,
      stage: 'execute',
    });
    expect(status(h, proposal.proposalId)).toBe('failed');
    expect((await h.tap('h_dean', cardMessageId, 'approve')).silent).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('a failed result ⇒ the same two-liner; a refused price change ⇒ the grant is dropped and a re-quote is posted', async () => {
    const failed = rig('fail');
    const f = await propose(failed.h);
    const t1 = await failed.h.tap('h_dean', f.cardMessageId, 'approve');
    expect(groupMessages(t1)[0]?.text).toMatch(
      /^couldn't book razzmatazz\. no charge went through\n/,
    );
    expect(status(failed.h, f.proposal.proposalId)).toBe('failed');

    const priced = rig('refuse_price');
    const p = await propose(priced.h);
    const t2 = await priced.h.tap('h_dean', p.cardMessageId, 'approve');
    expect(priced.fake.calls).toHaveLength(1);
    expect(status(priced.h, p.proposal.proposalId)).toBe('superseded');
    expect(grantStatus(priced.h, p.proposal.proposalId)).toBe('invalidated');
    expect(priced.h.auditTypes().filter((t) => t === 'approval.invalidated')).toHaveLength(1);
    const card = groupMessages(t2)[0]!;
    expect(card.card?.type).toBe('booking_proposal');
    expect(priced.h.pending()[0]!.attendees).toEqual([...FIVE]);
    // The re-quote needs its own 👍 before anything executes again.
    expect(priced.fake.calls).toHaveLength(1);
  });

  it('an executor that re-quoted itself (refused + reproposalId) ⇒ the stored re-proposal is posted as a live card with its expiry job', async () => {
    const { h, fake } = rig('refuse_reproposed');
    const { proposal, cardMessageId } = await propose(h);
    const turn = await h.tap('h_dean', cardMessageId, 'approve');
    expect(fake.calls).toHaveLength(1);
    const next = h.pending()[0]!;
    expect(next.proposalId).not.toBe(proposal.proposalId);
    expect(status(h, proposal.proposalId)).toBe('superseded');
    const card = groupMessages(turn)[0]!;
    expect(card.card?.type).toBe('booking_proposal');
    expect(card.card?.type === 'booking_proposal' ? card.card.proposalId : '').toBe(
      next.proposalId,
    );
    expect(card.actions?.map((a) => a.id)).toEqual(['approve', 'not_me', 'decline']);
    expect(card.text.split('\n')[1]).toBe('Dean, Maya, Jordan, Priya, Sam (not Henry)');
    expect(expiryJobs(h)).toEqual([expiryJobId(next.proposalId)]);
    // The new card is live: a tap on it reaches the executor again (it re-quotes again here).
    await h.tap('h_dean', card.id, 'approve');
    expect(fake.calls.map((c) => c.proposalId)).toEqual([proposal.proposalId, next.proposalId]);
  });

  it('a refused expiry from the executor expires the proposal with the one line', async () => {
    const { h } = rig('refuse_expired');
    const { proposal, cardMessageId } = await propose(h);
    const turn = await h.tap('h_dean', cardMessageId, 'approve');
    expect(groupMessages(turn).map((m) => m.text)).toEqual([
      'razzmatazz proposal expired, no charge. @ me if you still want it',
    ]);
    expect(status(h, proposal.proposalId)).toBe('expired');
    h.clock.advanceMs(20 * 60 * 1000);
    expect(await h.runtime.drain()).toEqual([]);
  });
});

describe('the reason is never stored', () => {
  it('after "Henry\'s sick", "not me" and a re-proposal, no store, audit payload or message carries the reason', async () => {
    const { h } = rig();
    await h.say('h_dean', "@trav Henry's sick");
    const { cardMessageId } = await propose(
      h,
      'h_dean',
      '@trav get the 5 of us Razzmatazz tickets',
    );
    await h.say('h_maya', "i'm out", { replyToMessageId: cardMessageId });
    const s = h.runtime.stores;
    const dump = JSON.stringify({
      rows: s.group.trips.listAttendance(ACT),
      audit: s.group.audit.listByGroup(G),
      proposals: h.pending(),
      memory: s.group.groupMemory.listByGroup(G),
      transcript: h.channel.groupTranscript().filter((e) => e.direction === 'outbound'),
    });
    expect(dump).not.toMatch(/sick/i);
    expect(s.group.trips.listAttendance(ACT).find((r) => r.memberId === 'mem_henry')).toMatchObject(
      {
        status: 'out',
        setBy: 'mem_dean',
      },
    );
  });
});
