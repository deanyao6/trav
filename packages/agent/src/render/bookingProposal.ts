/**
 * Booking proposal + approval request (VOICE §4.1, card `booking_proposal`, §6).
 *
 * Built from the stored `BookingProposal` and the `PolicyDecision` that
 * `approval.evaluate` returned, never from model text. The policy decides who
 * must approve; this renderer only says it in chat:
 *  - default one-tap (rule C1) by the requester ⇒ "👍 to book. price held for 15 min"
 *  - over a cap / non-refundable / someone else's card ⇒ the reason, the
 *    approver @tagged by name, and "👍 from Dean to book"
 * Every proposal states what, when, how many, who's charged, each + total,
 * refundability, the approval instruction and the hold window (VOICE §10.8).
 */
import type {
  BookingKind,
  BookingProposal,
  BookingProposalCard,
  IsoDateTime,
  MemberId,
  Money,
  OutboundMessage,
  Participant,
  PolicyDecision,
  ReasonCode,
} from '@trav/core';
import {
  TravError,
  allocateEqual,
  approval,
  formatClockTime,
  formatMoney,
  money,
  parseIso,
  sum,
  tabAutoCapOf,
} from '@trav/core';
import type { RenderContext } from './common.js';
import {
  GROUP,
  action,
  cardMessage,
  dayPhrase,
  deadlinePhrase,
  headlineName,
  inMemberOrder,
  listNames,
  minutesUntil,
  nameOf,
  plural,
  possessive,
} from './common.js';

export interface BookingProposalRenderInput {
  readonly proposal: BookingProposal;
  readonly decision: PolicyDecision;
  /** Display data from provider metadata (already sanitized; never model prose). */
  readonly item: {
    readonly name: string;
    /** Short lowercase headline ("razzmatazz"); defaults to `name` lowercased. */
    readonly headline?: string;
    readonly venue?: string;
    readonly startsAt?: IsoDateTime;
    readonly endsAt?: IsoDateTime;
    readonly details?: readonly string[];
  };
  /** Members left off this booking, with the reason the user gave (shown only in the card). Default: active members not attending. */
  readonly excluded?: readonly { readonly memberId: MemberId; readonly reason?: string }[];
  /** Quantity noun; defaults by kind (`ticket` for events). `null` omits the count. */
  readonly unit?: { readonly singular: string; readonly plural?: string } | null;
}

const CATEGORY: Readonly<Record<BookingKind, BookingProposalCard['category']>> = {
  ticket: 'event',
  flight: 'flight',
  lodging: 'lodging',
  transport: 'transport',
  other: 'other',
};

const DEFAULT_UNIT: Readonly<Record<BookingKind, { singular: string; plural?: string } | null>> = {
  ticket: { singular: 'ticket' },
  flight: { singular: 'seat' },
  lodging: null,
  transport: { singular: 'seat' },
  other: null,
};

/** At most this many approvers are @tagged by name; more become "each of you". */
const MAX_TAGGED = 3;

/** Reasons that change who approves; the default one-tap (C1) needs no explanation. */
const OVER_CAP_REASONS: readonly ReasonCode[] = [
  'over_per_person_cap',
  'over_tab_auto_cap',
  'over_member_share_cap',
  'over_daily_cap',
  'over_trip_cap',
];

function reasonLine(
  decision: PolicyDecision,
  proposal: BookingProposal,
  ctx: RenderContext,
): string | undefined {
  const policy = decision.policySnapshot;
  const cur = policy.currency;
  for (const r of decision.reasons) {
    switch (r) {
      case 'over_per_person_cap':
        return `that's over the ${formatMoney(money(policy.perPersonAutoCapMinor, cur))}/person cap`;
      case 'over_tab_auto_cap':
        // T-193 (D-046): more than the tab cap on someone else's word.
        return `that's over ${formatMoney(money(tabAutoCapOf(policy), cur))} each on ${possessive(nameOf(ctx, proposal.requestedBy))} ask`;
      case 'over_member_share_cap':
        return "that's over someone's personal cap";
      case 'over_daily_cap':
        return `that's over the ${formatMoney(money(policy.dailyGroupCapMinor, cur))} daily cap`;
      case 'over_trip_cap':
        return policy.tripGroupCapMinor === null
          ? "that's over the trip cap"
          : `that's over the ${formatMoney(money(policy.tripGroupCapMinor, cur))} trip cap`;
      case 'non_refundable':
        return "it's non-refundable";
      case 'kind_requires_each_payer':
        return proposal.kind === 'flight'
          ? 'flights are on everyone paying'
          : proposal.kind === 'lodging'
            ? 'lodging is on everyone paying'
            : 'this one is on everyone paying';
      case 'minor_is_payer':
        return 'someone on it is under 18';
      case 'payer_not_requester':
      case 'card_not_requester':
      case 'minor_requester':
        return proposal.paidBy.kind === 'member_card'
          ? `it's on ${possessive(nameOf(ctx, proposal.paidBy.memberId))} card`
          : "it's on other people's cards";
      default:
        break;
    }
  }
  return undefined;
}

function whenPart(startsAt: IsoDateTime | undefined, ctx: RenderContext): string | undefined {
  if (startsAt === undefined) return undefined;
  const day = dayPhrase(startsAt, ctx.timeZone, ctx.now);
  if (day === 'tonight') return 'tonight';
  return `${day} ${formatClockTime(startsAt, ctx.timeZone)}`;
}

function earliest(a: IsoDateTime | undefined, b: IsoDateTime | null): IsoDateTime | undefined {
  if (a === undefined) return b ?? undefined;
  if (b === null) return a;
  return parseIso(a) <= parseIso(b) ? a : b;
}

export function renderBookingProposal(
  input: BookingProposalRenderInput,
  ctx: RenderContext,
): OutboundMessage & { readonly card: BookingProposalCard } {
  const { proposal, decision, item } = input;
  if (decision.proposalId !== proposal.proposalId) {
    throw new TravError(
      'invalid_argument',
      'renderBookingProposal: decision is for another proposal',
    );
  }
  if (decision.outcome !== 'needs_confirmation') {
    throw new TravError(
      'invalid_argument',
      `renderBookingProposal: outcome ${decision.outcome} has no approval card`,
    );
  }
  const cur = proposal.currency;
  const total = money(proposal.totalMinor, cur);
  const payers = inMemberOrder(
    ctx,
    proposal.payers.map((p) => p.memberId),
  ).map((id) => proposal.payers.find((p) => p.memberId === id)!);
  const charged: Participant[] = payers.map((p) => ({
    memberId: p.memberId,
    name: nameOf(ctx, p.memberId),
    share: money(p.shareMinor, cur),
  }));
  const shareSum = sum(
    charged.map((c) => c.share ?? money(0, cur)),
    cur,
  );
  if (shareSum.amountMinor !== total.amountMinor || payers.length === 0) {
    throw new TravError(
      'invariant_violation',
      'renderBookingProposal: shares do not sum to total',
      {
        proposalId: proposal.proposalId,
      },
    );
  }

  const attendees = inMemberOrder(ctx, proposal.attendees);
  const excluded: readonly { readonly memberId: MemberId; readonly reason?: string }[] =
    input.excluded ??
    ctx.members
      .filter((m) => m.active && m.role !== 'guest' && !attendees.includes(m.memberId))
      .map((m) => ({ memberId: m.memberId }));
  const excludedIds = inMemberOrder(
    ctx,
    excluded.map((e) => e.memberId),
  );

  // 1. what, when, how many
  const headline = input.item.headline ?? headlineName(item.name);
  const unit = input.unit === undefined ? DEFAULT_UNIT[proposal.kind] : input.unit;
  const count = unit === null ? undefined : plural(attendees.length, unit.singular, unit.plural);
  const when = whenPart(item.startsAt, ctx);
  const line1 =
    when === 'tonight'
      ? [`${headline} tonight`, count].filter(Boolean).join(', ')
      : [headline, when, count].filter(Boolean).join(', ');

  // 2. who (and who's not)
  const notPart =
    excludedIds.length > 0 ? ` (not ${excludedIds.map((id) => nameOf(ctx, id)).join(', ')})` : '';
  const line2 = `${listNames(ctx, attendees)}${notPart}`;

  // 3. price each + total + refundability
  const allEqual = charged.every((c) => c.share?.amountMinor === charged[0]?.share?.amountMinor);
  const pricePart = allEqual
    ? `${formatMoney(charged[0]!.share!)} each`
    : charged.map((c) => `${c.name} ${formatMoney(c.share!)}`).join(' · ');
  const refundPart = proposal.refundable
    ? proposal.refundDeadline !== undefined
      ? `refundable until ${deadlinePhrase(proposal.refundDeadline, ctx.timeZone, ctx.now)}`
      : 'refundable'
    : 'non-refundable';
  const line3 = `${pricePart} · ${formatMoney(total)} total · ${refundPart}`;

  // 4. who's charged
  let line4: string;
  if (proposal.paidBy.kind === 'per_person_cards') {
    line4 = 'each on your own card, nothing to split';
  } else {
    const holder = proposal.paidBy.memberId;
    const card = `charged to ${possessive(nameOf(ctx, holder))} card`;
    if (payers.length > 1) line4 = `${card}, split ${String(payers.length)} ways on the tab`;
    else if (payers[0]!.memberId === holder) line4 = card;
    else line4 = `${card}, all on ${possessive(nameOf(ctx, payers[0]!.memberId))} tab`;
  }

  // 5. approval instruction + hold window
  const holdExpiresAt = earliest(proposal.holdExpiresAt, decision.expiresAt);
  if (holdExpiresAt === undefined) {
    throw new TravError('invalid_argument', 'renderBookingProposal: no hold or approval expiry');
  }
  const minutes = minutesUntil(holdExpiresAt, ctx.now);
  const hold =
    minutes < 60
      ? `price held for ${String(minutes)} min`
      : `price held until ${formatClockTime(holdExpiresAt, ctx.timeZone)}`;
  const approvers = inMemberOrder(ctx, decision.requiredApprovers);
  if (approvers.length === 0) {
    throw new TravError('invalid_argument', 'renderBookingProposal: nobody can approve this');
  }
  const reason = reasonLine(decision, proposal, ctx);
  const eachPayer = decision.approvalMode === 'each_payer' && approvers.length > 1;
  const lines = [line1, line2, line3, line4];
  let mentions: MemberId[] = [];
  const tagged = approvers.map((id) => `@${nameOf(ctx, id)}`);
  const plain = approvers.map((id) => nameOf(ctx, id));
  // Tag only a short list of people who must act (VOICE §3.5); bigger groups get "each of you".
  const canTag = approvers.length <= MAX_TAGGED;
  if (eachPayer) {
    if (canTag) mentions = approvers;
    const who = canTag ? tagged.join(', ') : `all ${String(approvers.length)} of you`;
    if (reason !== undefined)
      lines.push(`${reason}, so ${who} ${canTag ? 'each ' : ''}have to ok it`);
    lines.push(
      reason !== undefined || !canTag
        ? `👍 from each of you to book. ${hold}`
        : `👍 from ${who} to book. ${hold}`,
    );
  } else if (approvers.includes(proposal.requestedBy) && reason === undefined) {
    // The one-tap flow (VOICE §4.1 A): the requester, or anyone allowed, taps once.
    lines.push(`👍 to book. ${hold}`);
  } else if (canTag) {
    mentions = approvers;
    if (reason !== undefined) {
      lines.push(`${reason}, so ${tagged.join(' or ')} has to ok it`);
      lines.push(`👍 from ${plain.join(' or ')} to book. ${hold}`);
    } else {
      lines.push(`👍 from ${tagged.join(' or ')} to book. ${hold}`);
    }
  } else {
    if (reason !== undefined) lines.push(reason);
    lines.push(`👍 from one of ${plain.join(', ')} to book. ${hold}`);
  }

  const deciding = approval.decidingRule(decision);
  const overCap = decision.reasons.some((r) => OVER_CAP_REASONS.includes(r));
  const excludedForCard = excludedIds.map((id) => {
    const reasonGiven = excluded.find((e) => e.memberId === id)?.reason;
    return {
      memberId: id,
      name: nameOf(ctx, id),
      ...(reasonGiven !== undefined ? { reason: reasonGiven } : {}),
    };
  });
  const capPerPerson: Money = money(
    decision.policySnapshot.perPersonAutoCapMinor,
    decision.policySnapshot.currency,
  );

  return cardMessage<BookingProposalCard>(
    ctx,
    GROUP,
    lines,
    {
      type: 'booking_proposal',
      title: count !== undefined ? `${headline}, ${count}` : headline,
      proposalId: proposal.proposalId,
      category: CATEGORY[proposal.kind],
      item: {
        name: item.name,
        ...(item.venue !== undefined ? { venue: item.venue } : {}),
        ...(item.startsAt !== undefined ? { startsAt: item.startsAt } : {}),
        ...(item.endsAt !== undefined ? { endsAt: item.endsAt } : {}),
        ...(item.details !== undefined ? { details: item.details } : {}),
      },
      quantity: attendees.length,
      charged,
      ...(excludedForCard.length > 0 ? { excluded: excludedForCard } : {}),
      pricePerPerson: allEqual ? charged[0]!.share! : allocateEqual(total, payers.length)[0]!,
      total,
      refundable: proposal.refundable,
      ...(proposal.refundDeadline !== undefined ? { refundDeadline: proposal.refundDeadline } : {}),
      paidBy: proposal.paidBy,
      policy: {
        requiresApprovalFrom: approvers,
        approvalMode: eachPayer ? 'each_payer' : 'any_one',
        overCap,
        capPerPerson,
        ...(reason !== undefined ? { reason } : {}),
        ruleId: deciding?.ruleId ?? 'C1',
      },
      holdExpiresAt,
      status: 'pending',
    },
    {
      mentions,
      actions: [
        action('approve', { allowedMemberIds: approvers }),
        action('not_me', { allowedMemberIds: payers.map((p) => p.memberId) }),
        action('decline', { allowedMemberIds: approvers }),
      ],
      expiresAt: holdExpiresAt,
    },
  );
}
