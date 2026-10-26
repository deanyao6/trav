/**
 * ApprovalHandler (T-030; ARCHITECTURE Flow 2 steps 2–4; SAFETY §2.1, §2.5;
 * VOICE §6). Every approval input (👍/👎 tapback, Approve/Decline/Not-me
 * button, "yes"/"nah"/"not me") reaches `handle` as one `ApprovalEvent`, and
 * this module is the ONLY caller of `BookingExecutor.execute`.
 *
 * `handle(event)`, in order:
 *  1. the proposal must be pending (else `approval.invalid_attempt{not_pending}`,
 *     silence); the sender is resolved from the channel `senderId` only
 *     (guests, minors, non-members ⇒ `approval.invalid_attempt{cause}`, silence)
 *  2. approve: the activity roster is the source of truth for quantity and
 *     payers, so a roster that no longer matches the proposal, or a
 *     `checkProposalConsistency` problem (`empty_roster`, …), invalidates the
 *     grant (`approval.invalidated{payers_changed}`), supersedes the proposal
 *     and re-prices it for the current party; nothing executes. Otherwise
 *     `approval.applyApproval` decides: `ignored` ⇒ `approval.invalid_attempt`
 *     (a 👍 from someone outside `decision.requiredApprovers` is ignored
 *     silently; a second 👍 is `already_granted`); `accepted` ⇒
 *     `approval.granted{complete}`; `each_payer` waits for every approver;
 *     a complete grant ⇒ `executor.execute` exactly once (in-flight set +
 *     proposal status), then the receipt card (group) and ticket DMs are
 *     rendered FROM the audit log and stores (`render/receipt.ts`)
 *  3. decline: a required approver, the requester or a lead ⇒ `rejectGrant`,
 *     `approval.rejected`, hold released, one line; anyone else ⇒ ignored
 *  4. not me: a charged member is marked out on the roster (no reason text),
 *     the grant is invalidated, the proposal superseded (`proposal.superseded`)
 *     and re-proposed for the rest (VOICE §6.2); the old card's 👍/👎 are dead,
 *     and a "not me" on it follows `supersededBy` to the live card
 *  5. expiry: an approval that arrives after `grant.expiresAt` (or a `refused:
 *     expired` from the executor) expires the proposal here, posts the one
 *     VOICE §6.4 line and cancels the `proposal_expiry` job, so the line is
 *     posted exactly once either way
 *
 * `rosterChanged(notice)`: the newest pending proposal for the activity whose
 * party no longer matches the roster is invalidated, superseded and re-priced
 * (a proposal whose purchase is in flight is left to the executor's own
 * re-check); a member who joins after a confirmed booking is offered a
 * separate add-on ticket (`rosterMode: 'add_on'`), never a re-buy for the others.
 *
 * Nothing here executes except a complete grant from a 👍 on a pending card
 * (`approve`) or the loop's `autoApproved` hand-off for the requester's own
 * ask. A re-quote after "not me", a roster change or a price change, and a
 * late joiner's add-on, always come back as a card that needs a 👍
 * (`ProposeContext.requireConfirmation`); should one ever come back
 * `auto_approved` anyway, it is refused and nothing is bought (D-019 §3).
 *
 * Every message leaves through the loop's send path (voice lint, screen,
 * lanes); this module only builds `Outbound`s. At most one group message per
 * turn (VOICE §3.7), plus the ticket DMs.
 */
import type {
  Activity,
  ApprovalGrant,
  ApprovalSignature,
  AuditEventInput,
  AuditEventId,
  BookingProposal,
  Clock,
  Expense,
  GrantInvalidationCause,
  Group,
  IdGenerator,
  IsoDateTime,
  Member,
  MemberId,
  MessageId,
  Outbound,
  OutboundMessage,
  PolicyDecision,
  ProposalId,
  Scheduler,
  Stores,
  Trip,
} from '@trav/core';
import { approval, formatMoney, money, safety, TravError } from '@trav/core';
import type { BookingExecutor, ExecuteResult } from '../booking/executor.js';
import {
  bookedAttendees,
  expiryJobId,
  nightOf,
  PROPOSAL_ACTIONS,
  proposalExpiresAt,
  proposalMessage,
  shortEventName,
  type ProposalService,
  type ProposeResult,
} from '../booking/proposals.js';
import { sanitizeInline } from '../context/groupContext.js';
import { TURN_FAILED_AFTER_PURCHASE_TEXT } from '../loop.js';
import { renderBookingProposal } from '../render/bookingProposal.js';
import type { RenderContext } from '../render/common.js';
import { renderReceipt } from '../render/receipt.js';
import { renderTicket } from '../render/ticket.js';
import {
  bookingParty,
  renderAttendanceLine,
  rosterDiverged,
  rosterOf,
  setAttendance,
} from '../roster/index.js';
import {
  followSupersededBy,
  type ApprovalEvent,
  type ApprovalHandler,
  type RosterChangeNotice,
} from './events.js';

export interface ApprovalHandlerDeps {
  readonly stores: Stores;
  readonly executor: BookingExecutor;
  readonly proposals: ProposalService;
  readonly scheduler: Scheduler;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** VOICE §6.4: the one line at expiry. The scheduled job (`loop.ts`) posts the same text. */
export function proposalExpiredText(description: string): string {
  return `${shortEventName(description)} proposal expired, no charge. @ me if you still want it`;
}

/** VOICE §4.10: two lines, no emoji, says money did not move and what happens next. */
export function bookingFailedText(description: string, retriable: boolean): string {
  const head = `couldn't book ${shortEventName(description)}. no charge went through`;
  return retriable
    ? `${head}\n@ me again in a few and i'll retry`
    : `${head}\n@ me if you want to try another night or another place`;
}

export const EXECUTOR_REFUSED_TEXT =
  "couldn't complete that one. no charge went through\n@ me again and i'll re-quote";

type InvalidCause =
  | 'not_member'
  | 'guest'
  | 'minor'
  | 'not_required_approver'
  | 'claimed_for_other'
  | 'expired'
  | 'already_granted'
  | 'not_pending';

/** Everything `handle` needs about one pending proposal, loaded once per event. */
interface Loaded {
  readonly proposal: BookingProposal;
  readonly group: Group;
  readonly trip: Trip;
  readonly members: readonly Member[];
  readonly activity: Activity | null;
  readonly decision: PolicyDecision;
  readonly grant: ApprovalGrant;
  readonly now: IsoDateTime;
}

/** Consistency problems that mean "who is on this changed" (SAFETY §2.1 invalidation rule). */
const ROSTER_PROBLEMS: readonly string[] = [
  'empty_roster',
  'quantity_not_roster',
  'attendee_marked_out',
  'payers_not_attendees',
];

export function createApprovalHandler(deps: ApprovalHandlerDeps): ApprovalHandler {
  const { stores, executor, proposals, scheduler, clock, ids } = deps;
  const group = stores.group;
  /** Proposals whose executor call is running: a second 👍 in the same window is `not_pending`. */
  const inFlight = new Set<ProposalId>();

  // ---------- helpers ----------

  function audit(input: AuditEventInput): AuditEventId {
    return group.audit.append(input).id;
  }

  function text(groupId: string, body: string): OutboundMessage {
    return { id: ids.next('msg'), groupId, to: { kind: 'group' }, text: body };
  }

  function nameOf(members: readonly Member[], id: MemberId): string {
    return sanitizeInline(members.find((m) => m.memberId === id)?.displayName ?? id, 40);
  }

  function names(members: readonly Member[], ids_: readonly MemberId[]): string {
    const order = members.map((m) => m.memberId);
    const wanted = new Set(ids_);
    return order
      .filter((id) => wanted.has(id))
      .map((id) => nameOf(members, id))
      .join(', ');
  }

  function load(proposalId: ProposalId, now: IsoDateTime): Loaded | undefined {
    const proposal = group.bookings.getProposal(proposalId);
    if (proposal === undefined) return undefined;
    const grp = group.groups.get(proposal.groupId);
    const trip = group.trips.get(proposal.tripId);
    if (grp === undefined || trip === undefined) return undefined;
    const decision = group.bookings.getDecision(proposalId)?.decision;
    const grant = group.bookings.getGrantForProposal(proposalId);
    if (decision === undefined || grant === undefined) {
      throw new TravError(
        'invariant_violation',
        `proposal ${proposalId} has no decision or grant`,
        {
          proposalId,
        },
      );
    }
    return {
      proposal,
      group: grp,
      trip,
      members: group.members.listByGroup(proposal.groupId),
      activity:
        proposal.activityId === undefined
          ? null
          : (group.trips.getActivity(proposal.activityId) ?? null),
      decision,
      grant,
      now,
    };
  }

  function invalidAttempt(
    proposal: BookingProposal,
    event: ApprovalEvent,
    cause: InvalidCause,
    sender: Member | undefined,
    extra: Record<string, unknown> = {},
  ): void {
    audit({
      groupId: proposal.groupId,
      tripId: proposal.tripId,
      type: 'approval.invalid_attempt',
      actor:
        sender === undefined
          ? { kind: 'trav', id: 'trav' }
          : { kind: 'member', id: sender.memberId },
      visibility: 'group',
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      payload: {
        senderId: event.senderId,
        cause,
        messageId: event.messageId,
        via: event.via,
        intent: event.kind,
        ...extra,
      },
    });
  }

  function signature(event: ApprovalEvent, member: Member): ApprovalSignature {
    return {
      memberId: member.memberId,
      senderId: event.senderId,
      via: event.via,
      messageId: event.messageId,
      at: event.at,
    };
  }

  /** VOICE §6.4: the job runs at the shorter of the grant TTL and the provider hold. */
  function scheduleExpiry(
    proposal: BookingProposal,
    decision: PolicyDecision,
    groupId: string,
  ): IsoDateTime | undefined {
    const expiresAt = proposalExpiresAt(decision, proposal);
    if (expiresAt === undefined) return undefined;
    scheduler.schedule({
      jobId: expiryJobId(proposal.proposalId),
      groupId,
      tripId: proposal.tripId,
      kind: 'proposal_expiry',
      runAt: expiresAt,
      payload: { proposalId: proposal.proposalId },
    });
    return expiresAt;
  }

  function setStatus(proposalId: ProposalId, status: BookingProposal['status']): void {
    const current = group.bookings.getProposal(proposalId);
    if (current === undefined || current.status === status) return;
    group.bookings.updateProposal({ ...current, status });
  }

  // ---------- the roster is the source of truth (SAFETY §2.5) ----------

  interface Divergence {
    readonly cause: GrantInvalidationCause;
    readonly attendees: readonly MemberId[];
    readonly problems: readonly string[];
  }

  /**
   * Quantity, attendees and payers must still equal the roster's `in` members
   * (minus anyone already holding a ticket). Runs `checkProposalConsistency`
   * on that party too, so an empty roster blocks the purchase here even if
   * the roster rows changed without a notice (e.g. via the `set_attendance`
   * tool).
   */
  function divergence(ctx: Loaded): Divergence | undefined {
    const { proposal, trip, activity, members, now } = ctx;
    if (activity === null) return undefined;
    const roster = rosterOf(group.trips, activity.activityId, members, now);
    const booked = bookedAttendees(group, trip, activity.activityId);
    const party = bookingParty(roster, booked);
    const check = approval.checkProposalConsistency(
      proposal,
      trip,
      activity,
      { ...roster, inMemberIds: party.attendees },
      members,
      now,
    );
    if (!check.ok) {
      const rosterish = check.problems.some((p) => ROSTER_PROBLEMS.includes(p));
      const cause: GrantInvalidationCause =
        !rosterish && check.problems.includes('attendee_not_member')
          ? 'member_inactive'
          : 'payers_changed';
      return { cause, attendees: party.attendees, problems: check.problems };
    }
    if (rosterDiverged(roster, proposal, booked)) {
      return { cause: 'payers_changed', attendees: party.attendees, problems: [] };
    }
    return undefined;
  }

  // ---------- supersede + re-propose (not me, roster change, re-price) ----------

  async function supersede(
    ctx: Loaded,
    cause: GrantInvalidationCause,
    attendees: readonly MemberId[],
    by: { readonly memberId?: MemberId; readonly messageId: MessageId; readonly why: string },
    problems: readonly string[] = [],
  ): Promise<readonly Outbound[]> {
    const { proposal } = ctx;
    const actor =
      by.memberId === undefined
        ? ({ kind: 'trav', id: 'trav' } as const)
        : ({ kind: 'member', id: by.memberId } as const);
    const fresh = group.bookings.getGrantForProposal(proposal.proposalId) ?? ctx.grant;
    if (fresh.status === 'pending' || fresh.status === 'complete') {
      const invalidated = approval.invalidateGrant(fresh, cause);
      group.bookings.saveGrant(invalidated);
      const input = approval.invalidatedAuditInput(invalidated, proposal, actor);
      audit({
        ...input,
        payload: {
          ...input.payload,
          messageId: by.messageId,
          ...(problems.length > 0 ? { problems } : {}),
        },
      });
    }
    group.bookings.updateProposal({ ...proposal, status: 'superseded' });
    scheduler.cancel(expiryJobId(proposal.proposalId));
    await proposals.releaseHold(proposal);

    const res = await proposals.repropose(proposal, attendees, by.messageId);
    const next =
      res.kind === 'proposal' || res.kind === 'auto_approved' ? res.proposal.proposalId : null;
    if (next !== null) {
      group.bookings.updateProposal({ ...proposal, status: 'superseded', supersededBy: next });
    }
    audit({
      groupId: proposal.groupId,
      tripId: proposal.tripId,
      type: 'proposal.superseded',
      actor,
      visibility: 'group',
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      payload: { cause, why: by.why, supersededBy: next, messageId: by.messageId },
    });
    return renderProposeResult(res, proposal.groupId, ctx.now);
  }

  /**
   * The outbound for a `ProposeResult` the handler itself asked for (a
   * re-quote or an add-on): the card, a clarifying question, or the refusal
   * line. Never a purchase: an `auto_approved` result here means the
   * proposal service ignored `requireConfirmation`, and it is refused.
   */
  async function renderProposeResult(
    res: ProposeResult,
    groupId: string,
    now: IsoDateTime,
  ): Promise<readonly Outbound[]> {
    switch (res.kind) {
      case 'proposal':
        scheduleExpiry(res.proposal, res.decision, groupId);
        return [proposalMessage(res, groupId)];
      case 'auto_approved': {
        const ctx = load(res.proposal.proposalId, now);
        if (ctx === undefined) return [text(groupId, EXECUTOR_REFUSED_TEXT)];
        return refuseUnasked(ctx, res.proposal.sourceMessageId);
      }
      case 'clarify':
        return [text(groupId, res.question)];
      case 'denied':
      case 'duplicate':
      case 'pending_exists':
      case 'unavailable':
        return [text(groupId, res.text)];
    }
  }

  /**
   * D-019 §3 / SAFETY §2.1: only the requester's own ask may auto-execute,
   * and only through `autoApproved`. A synthetic complete grant on a card
   * nobody asked for is invalidated (the handler's rule, recorded as a policy
   * change), the proposal failed, the hold released, and one truthful line
   * goes out. `executor.execute` is never reached.
   */
  async function refuseUnasked(ctx: Loaded, messageId: MessageId): Promise<readonly Outbound[]> {
    const { proposal } = ctx;
    const grant = group.bookings.getGrantForProposal(proposal.proposalId) ?? ctx.grant;
    if (grant.status === 'pending' || grant.status === 'complete') {
      const invalidated = approval.invalidateGrant(grant, 'policy_changed');
      group.bookings.saveGrant(invalidated);
      const input = approval.invalidatedAuditInput(invalidated, proposal, {
        kind: 'trav',
        id: 'trav',
      });
      audit({
        ...input,
        payload: { ...input.payload, why: 'auto_approved_without_ask', messageId },
      });
    }
    audit({
      groupId: proposal.groupId,
      tripId: proposal.tripId,
      type: 'booking.failed',
      actor: { kind: 'trav', id: 'trav' },
      visibility: 'group',
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      payload: {
        errorCode: 'auto_approved_without_ask',
        retriable: true,
        stage: 'propose',
        moneyMoved: false,
        messageId,
      },
    });
    setStatus(proposal.proposalId, 'failed');
    scheduler.cancel(expiryJobId(proposal.proposalId));
    await proposals.releaseHold(proposal);
    return [text(proposal.groupId, EXECUTOR_REFUSED_TEXT)];
  }

  // ---------- expiry (VOICE §6.4: exactly one line) ----------

  async function expire(ctx: Loaded, grant: ApprovalGrant): Promise<readonly Outbound[]> {
    const { proposal } = ctx;
    group.bookings.saveGrant(grant.status === 'expired' ? grant : { ...grant, status: 'expired' });
    group.bookings.updateProposal({ ...proposal, status: 'expired' });
    audit({
      groupId: proposal.groupId,
      tripId: proposal.tripId,
      type: 'approval.expired',
      actor: { kind: 'trav', id: 'trav' },
      visibility: 'group',
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      payload: { expiresAt: grant.expiresAt },
    });
    scheduler.cancel(expiryJobId(proposal.proposalId));
    await proposals.releaseHold(proposal);
    return [text(proposal.groupId, proposalExpiredText(proposal.description))];
  }

  // ---------- THE executor call ----------

  /**
   * Exactly one `executor.execute` per complete grant. If the executor
   * throws, the audit log decides what to say: a `booking.completed` for this
   * proposal written since the call started means money moved, so the
   * proposal is marked completed, the grant consumed, and the line is the
   * loop's "the charge went through" text, never "no charge went through".
   */
  async function execute(ctx: Loaded, messageId: MessageId): Promise<readonly Outbound[]> {
    const { proposal } = ctx;
    const grant = group.bookings.getGrantForProposal(proposal.proposalId) ?? ctx.grant;
    inFlight.add(proposal.proposalId);
    const auditBefore = new Set(
      group.audit.listByProposal(proposal.proposalId).map((event) => event.id),
    );
    let result: ExecuteResult;
    try {
      result = await executor.execute(proposal.proposalId, grant.grantId);
    } catch (e) {
      const code = e instanceof TravError ? e.code : 'failed';
      const bought = group.audit
        .listByProposal(proposal.proposalId)
        .some((event) => !auditBefore.has(event.id) && event.type === 'booking.completed');
      audit({
        groupId: proposal.groupId,
        tripId: proposal.tripId,
        type: 'booking.failed',
        actor: { kind: 'trav', id: 'trav' },
        visibility: 'group',
        proposalId: proposal.proposalId,
        idempotencyKey: proposal.idempotencyKey,
        payload: {
          errorCode: code,
          retriable: !bought,
          stage: 'execute',
          moneyMoved: bought,
          messageId,
        },
      });
      if (bought) {
        // The purchase stands: the proposal is done and its grant is spent,
        // whatever the executor managed to write after the charge.
        setStatus(proposal.proposalId, 'completed');
        const latest = group.bookings.getGrantForProposal(proposal.proposalId);
        if (latest !== undefined && latest.status === 'complete' && latest.complete) {
          group.bookings.saveGrant(approval.consumeGrant(latest));
        }
      } else {
        setStatus(proposal.proposalId, 'failed');
      }
      scheduler.cancel(expiryJobId(proposal.proposalId));
      inFlight.delete(proposal.proposalId);
      return [
        text(
          proposal.groupId,
          bought
            ? TURN_FAILED_AFTER_PURCHASE_TEXT
            : bookingFailedText(proposal.description, true),
        ),
      ];
    }
    try {
      return await afterExecute(ctx, result, messageId);
    } finally {
      inFlight.delete(proposal.proposalId);
    }
  }

  async function afterExecute(
    ctx: Loaded,
    result: ExecuteResult,
    messageId: MessageId,
  ): Promise<readonly Outbound[]> {
    const { proposal } = ctx;
    switch (result.kind) {
      case 'completed': {
        scheduler.cancel(expiryJobId(proposal.proposalId));
        const current = group.bookings.getProposal(proposal.proposalId);
        if (
          current !== undefined &&
          (current.status === 'pending' || current.status === 'approved')
        ) {
          group.bookings.updateProposal({ ...current, status: 'completed' });
        }
        return renderCompleted(ctx, result.booking, result.expense);
      }
      case 'duplicate': {
        // The key already bought this (a retry after a crash, or a second tap
        // that raced the first): nothing to post twice.
        scheduler.cancel(expiryJobId(proposal.proposalId));
        setStatus(proposal.proposalId, 'completed');
        return [];
      }
      case 'refused': {
        if (result.reason === 'expired') {
          return expire(ctx, group.bookings.getGrantForProposal(proposal.proposalId) ?? ctx.grant);
        }
        if (result.reason === 'price_changed' || result.reason === 'payers_changed') {
          if (result.reproposalId !== undefined) {
            // The executor already re-quoted (new proposal, decision and grant
            // in the store): post that card, from the stored records.
            setStatus(proposal.proposalId, 'superseded');
            scheduler.cancel(expiryJobId(proposal.proposalId));
            const next = load(result.reproposalId, ctx.now);
            if (next === undefined) return [text(proposal.groupId, EXECUTOR_REFUSED_TEXT)];
            return renderStoredProposal(next);
          }
          const party = currentParty(ctx);
          return supersede(ctx, result.reason, party, { messageId, why: result.reason });
        }
        setStatus(proposal.proposalId, 'failed');
        scheduler.cancel(expiryJobId(proposal.proposalId));
        return [text(proposal.groupId, EXECUTOR_REFUSED_TEXT)];
      }
      case 'failed': {
        setStatus(proposal.proposalId, 'failed');
        scheduler.cancel(expiryJobId(proposal.proposalId));
        return [text(proposal.groupId, bookingFailedText(proposal.description, result.retriable))];
      }
    }
  }

  /** Who the roster says is on it right now (minus ticket holders); the proposal's own list when there is no activity. */
  function currentParty(ctx: Loaded): readonly MemberId[] {
    if (ctx.activity === null) return ctx.proposal.attendees;
    const roster = rosterOf(group.trips, ctx.activity.activityId, ctx.members, ctx.now);
    return bookingParty(roster, bookedAttendees(group, ctx.trip, ctx.activity.activityId))
      .attendees;
  }

  /**
   * A proposal that is already in the store (an executor re-quote) rendered
   * from its records (`render/bookingProposal.ts`), with the proposal actions
   * and its expiry job. A re-quote that came back auto-approved is refused
   * (nobody asked for it, VOICE §6.2: a re-proposal needs its own 👍).
   */
  async function renderStoredProposal(next: Loaded): Promise<readonly Outbound[]> {
    if (next.decision.outcome === 'auto_approve') {
      return refuseUnasked(next, next.proposal.sourceMessageId);
    }
    const p = next.proposal;
    const rctx: RenderContext = {
      groupId: next.group.groupId,
      members: next.members,
      timeZone: next.trip.timeZone,
      now: next.now,
      ids,
    };
    const msg = renderBookingProposal(
      {
        proposal: p,
        decision: next.decision,
        item: {
          name: p.description,
          headline: shortEventName(p.description),
          ...(next.activity?.venue !== undefined ? { venue: next.activity.venue } : {}),
          ...(next.activity?.startsAt !== undefined ? { startsAt: next.activity.startsAt } : {}),
          ...(next.activity?.endsAt !== undefined ? { endsAt: next.activity.endsAt } : {}),
        },
      },
      rctx,
    );
    const expiresAt = scheduleExpiry(p, next.decision, p.groupId);
    return [
      {
        ...msg,
        actions: msg.actions ?? PROPOSAL_ACTIONS,
        ...(msg.expiresAt === undefined && expiresAt !== undefined ? { expiresAt } : {}),
      },
    ];
  }

  /**
   * Receipt card (group) + one ticket DM per artifact in the holders' private
   * stores, all FROM the audit log and stores. If the log cannot prove the
   * receipt (an executor bug), one truthful line goes out instead: money did
   * move, so the turn-boundary "no charge went through" would be wrong.
   */
  function renderCompleted(
    ctx: Loaded,
    booking: Extract<ExecuteResult, { kind: 'completed' }>['booking'],
    expense: Expense,
  ): readonly Outbound[] {
    const rctx: RenderContext = {
      groupId: ctx.group.groupId,
      members: ctx.members,
      timeZone: ctx.trip.timeZone,
      now: ctx.now,
      ids,
    };
    const headline = shortEventName(booking.description);
    try {
      const dms: OutboundMessage[] = [];
      const tickets: { memberId: MemberId; ticketCardId: string }[] = [];
      for (const ref of booking.tickets) {
        for (const artifact of stores.private.listTickets(ref.holderMemberId, booking.bookingId)) {
          if (artifact.ticketId !== ref.ticketId) continue;
          const dm = renderTicket({ artifact, headline }, rctx);
          dms.push(dm);
          tickets.push({ memberId: ref.holderMemberId, ticketCardId: dm.card.cardId });
        }
      }
      const receipt = renderReceipt(
        {
          booking,
          expense: booking.paidBy.kind === 'per_person_cards' ? null : expense,
          auditEvents: group.audit.listByGroup(ctx.group.groupId),
          headline,
          tickets,
        },
        rctx,
      );
      return [receipt, ...dms];
    } catch {
      return [
        text(
          ctx.group.groupId,
          `booked ✅ ${headline}, ${formatMoney(money(booking.totalMinor, booking.currency))}. tickets are on the way`,
        ),
      ];
    }
  }

  // ---------- the three actions ----------

  async function approve(
    ctx: Loaded,
    event: ApprovalEvent,
    sender: Member,
  ): Promise<readonly Outbound[]> {
    const { proposal, decision, members, now } = ctx;
    // 1. only a required approver's 👍 counts for anything, including the
    //    roster check below: anyone else's is silent (VOICE §6.2, D-019 §1)
    //    and must not re-propose on their behalf.
    if (!decision.requiredApprovers.includes(sender.memberId)) {
      invalidAttempt(proposal, event, 'not_required_approver', sender);
      return [];
    }
    // 2. the roster is the source of truth: a changed party re-prices and needs a fresh 👍.
    const drift = divergence(ctx);
    if (drift !== undefined) {
      return supersede(
        ctx,
        drift.cause,
        drift.attendees,
        { memberId: sender.memberId, messageId: event.messageId, why: 'roster_changed' },
        drift.problems,
      );
    }
    // 3. the signature (identity = channel sender; the policy's approver set decides).
    const applied = approval.applyApproval(
      ctx.grant,
      decision,
      signature(event, sender),
      members,
      now,
    );
    if (applied.kind === 'ignored') {
      if (applied.cause === 'expired') {
        invalidAttempt(proposal, event, 'expired', sender);
        return expire(ctx, applied.grant);
      }
      invalidAttempt(proposal, event, applied.cause, sender);
      return [];
    }
    group.bookings.saveGrant(applied.grant);
    audit({
      groupId: proposal.groupId,
      tripId: proposal.tripId,
      type: 'approval.granted',
      actor: { kind: 'member', id: sender.memberId },
      visibility: 'group',
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      lifecycle: { complete: applied.grant.complete },
      payload: {
        memberId: sender.memberId,
        via: event.via,
        messageId: event.messageId,
        complete: applied.grant.complete,
        approvalMode: decision.approvalMode,
      },
    });
    if (!applied.grant.complete) {
      const granted = new Set(applied.grant.grantedBy.map((g) => g.memberId));
      const waiting = decision.requiredApprovers.filter((id) => !granted.has(id));
      return [
        text(
          proposal.groupId,
          `${nameOf(members, sender.memberId)} okayed it. still need 👍 from ${names(members, waiting)}`,
        ),
      ];
    }
    return execute({ ...ctx, grant: applied.grant }, event.messageId);
  }

  async function decline(
    ctx: Loaded,
    event: ApprovalEvent,
    sender: Member,
  ): Promise<readonly Outbound[]> {
    const { proposal, decision } = ctx;
    const me = sender.memberId;
    const allowed =
      decision.requiredApprovers.includes(me) ||
      proposal.requestedBy === me ||
      sender.role === 'lead' ||
      sender.role === 'guardian';
    if (!allowed) {
      invalidAttempt(proposal, event, 'not_required_approver', sender);
      return [];
    }
    return reject(
      ctx,
      signature(event, sender),
      `dropped ${shortEventName(proposal.description)}. no charge`,
    );
  }

  async function reject(
    ctx: Loaded,
    sig: ApprovalSignature,
    line: string,
  ): Promise<readonly Outbound[]> {
    const { proposal } = ctx;
    group.bookings.saveGrant(approval.rejectGrant(ctx.grant, sig));
    group.bookings.updateProposal({ ...proposal, status: 'rejected' });
    audit({
      groupId: proposal.groupId,
      tripId: proposal.tripId,
      type: 'approval.rejected',
      actor: { kind: 'member', id: sig.memberId },
      visibility: 'group',
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      payload: { memberId: sig.memberId, messageId: sig.messageId, via: sig.via },
    });
    scheduler.cancel(expiryJobId(proposal.proposalId));
    await proposals.releaseHold(proposal);
    return [text(proposal.groupId, line)];
  }

  async function notMe(
    ctx: Loaded,
    event: ApprovalEvent,
    sender: Member,
  ): Promise<readonly Outbound[]> {
    const { proposal, activity, members, now } = ctx;
    const me = sender.memberId;
    const charged =
      proposal.attendees.includes(me) || proposal.payers.some((p) => p.memberId === me);
    // The roster row first (ids and statuses only; whatever they said about why is not kept).
    const write =
      activity === null
        ? undefined
        : setAttendance(
            group,
            {
              activityId: activity.activityId,
              memberId: me,
              status: 'out',
              setBy: me,
              sourceMessageId: event.messageId,
            },
            members,
            now,
            activity,
          );
    if (!charged) {
      if (write?.changed === true && activity !== null) {
        return [
          text(proposal.groupId, renderAttendanceLine(activity, write.roster, members, me, 'out')),
        ];
      }
      return [
        text(
          proposal.groupId,
          `you're not on that one, ${nameOf(members, me)}. it's ${names(members, proposal.attendees)}`,
        ),
      ];
    }
    const rest = proposal.attendees.filter((id) => id !== me);
    if (rest.length === 0) {
      return reject(
        ctx,
        signature(event, sender),
        `dropped ${shortEventName(proposal.description)}, nobody's left on it. no charge`,
      );
    }
    return supersede(ctx, 'payers_changed', rest, {
      memberId: me,
      messageId: event.messageId,
      why: 'not_me',
    });
  }

  // ---------- public ----------

  async function handle(event: ApprovalEvent): Promise<readonly Outbound[]> {
    if (event.proposalId === undefined) return [];
    const now = clock.now();
    // A "not me" on a superseded card lands on the card that replaced it; a
    // 👍 or 👎 on it stays dead (the count and price changed).
    const proposalId =
      event.kind === 'not_me'
        ? followSupersededBy((id) => group.bookings.getProposal(id), event.proposalId)
        : event.proposalId;
    const ctx = load(proposalId, now);
    if (ctx === undefined) return [];
    const { proposal, members } = ctx;
    const sender = members.find(
      (m) => m.senderId === event.senderId && m.active && m.leftAt === undefined,
    );
    if (proposal.status !== 'pending' || inFlight.has(proposal.proposalId)) {
      invalidAttempt(proposal, event, 'not_pending', sender);
      return [];
    }
    if (sender === undefined) {
      invalidAttempt(proposal, event, 'not_member', undefined);
      return [];
    }
    if (sender.role === 'guest') {
      invalidAttempt(proposal, event, 'guest', sender);
      return [];
    }
    if (safety.isMinor(sender, now)) {
      invalidAttempt(proposal, event, 'minor', sender);
      return [];
    }
    switch (event.kind) {
      case 'approve':
        return approve(ctx, event, sender);
      case 'decline':
        return decline(ctx, event, sender);
      case 'not_me':
        return notMe(ctx, event, sender);
      default:
        return [];
    }
  }

  async function rosterChanged(notice: RosterChangeNotice): Promise<readonly Outbound[]> {
    const now = clock.now();
    const activity = group.trips.getActivity(notice.activityId);
    const grp = group.groups.get(notice.groupId);
    if (activity === undefined || grp === undefined || activity.groupId !== notice.groupId) {
      return [];
    }
    const trip = group.trips.get(activity.tripId);
    if (trip === undefined) return [];
    const members = group.members.listByGroup(notice.groupId);
    const roster = rosterOf(group.trips, activity.activityId, members, now);
    const booked = bookedAttendees(group, trip, activity.activityId);
    const party = bookingParty(roster, booked);

    // 1. the newest pending proposal for this activity whose party changed. One
    //    whose purchase is running right now is left alone: its grant is being
    //    spent, and the executor's own roster re-check decides that purchase.
    const pending = group.bookings
      .listPendingProposals(notice.groupId)
      .filter((p) => p.activityId === activity.activityId)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    const stale = pending.find(
      (p) => !inFlight.has(p.proposalId) && rosterDiverged(roster, p, booked),
    );
    if (stale !== undefined) {
      const ctx = load(stale.proposalId, now);
      if (ctx !== undefined) {
        return supersede(ctx, 'payers_changed', party.attendees, {
          memberId: notice.by,
          messageId: notice.messageId,
          why: 'roster_changed',
        });
      }
    }

    // 2. a late joiner after the booking: a separate ticket, never a re-buy.
    if (booked.size === 0) return [];
    const covered = new Set(pending.flatMap((p) => p.attendees));
    const joiners = notice.changes
      .filter((c) => c.status === 'in' && !booked.has(c.memberId) && !covered.has(c.memberId))
      .map((c) => c.memberId)
      .filter((id) => party.attendees.includes(id));
    if (joiners.length === 0) return [];
    const res = await proposals.propose(
      {
        kind: 'ticket',
        activityId: activity.activityId,
        attendeeMemberIds: joiners,
        rosterMode: 'add_on',
        query: shortEventName(activity.name),
        ...(activity.startsAt !== undefined
          ? { date: nightOf(activity.startsAt, trip.timeZone) }
          : {}),
      },
      {
        groupId: notice.groupId,
        tripId: trip.tripId,
        requestedBy: notice.by,
        sourceMessageId: notice.messageId,
        // "i'm in" is attendance, not an approval: the add-on card needs its own 👍.
        requireConfirmation: true,
      },
    );
    return renderProposeResult(res, notice.groupId, now);
  }

  /**
   * Flow 2 step 1 for a policy `auto_approve` (synthetic complete grant): the
   * loop hands the proposal here so this module stays the single caller of
   * the executor (SAFETY §2.1). Guarded like a 👍: pending, not in flight,
   * really auto-approved with a complete grant; otherwise nothing happens.
   */
  async function autoApproved(
    proposalId: ProposalId,
    sourceMessageId: MessageId,
  ): Promise<readonly Outbound[]> {
    const now = clock.now();
    const ctx = load(proposalId, now);
    if (ctx === undefined) return [];
    if (ctx.proposal.status !== 'pending' || inFlight.has(proposalId)) return [];
    if (ctx.decision.outcome !== 'auto_approve' || !ctx.grant.complete) return [];
    return execute(ctx, sourceMessageId);
  }

  return { handle, rosterChanged, autoApproved };
}
