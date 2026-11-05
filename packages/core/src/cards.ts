/**
 * Outbound message envelope and the eight rich card shapes, from docs/VOICE.md §5
 * (that document owns the semantics). Text-only channels send `text`; the
 * simulator renders `card`. `card.fallbackText === text` always.
 *
 * Lane rule: `to.kind === 'group'` is the group lane; `to.kind === 'member'` is
 * the private DM lane. `TicketCard` and `ExpenseConfirmCard{visibility:'private'}`
 * may only appear on the DM lane (card invariants, VOICE §5).
 */
import type {
  BookingId,
  CardId,
  ExpenseId,
  GroupId,
  IsoDate,
  IsoDateTime,
  MemberId,
  MessageId,
  ProposalId,
} from './primitives.js';
import type { Money } from './money.js';
import type { PaidBy } from './domain/booking.js';
import type { ExpenseSource, SplitMethod } from './domain/expense.js';

export type OutboundTarget =
  { readonly kind: 'group' } | { readonly kind: 'member'; readonly memberId: MemberId };

export interface OutboundMessage {
  /**
   * Omitted = an ordinary Trav message. `system_notice` (T-165, VOICE §4.13):
   * a one-line group-lane ledger notice ("Chase added Uber €18.60 · 4 ways
   * (not Henry, Crowley)"). Channels with `capabilities.systemNotices` render
   * it like iMessage's centered grey "Dean added Chase to the conversation"
   * subscript; everything else gets it as a normal short message from Trav.
   * Never carries a card, actions, images or mentions, and never goes to a DM.
   */
  readonly kind?: 'system_notice';
  /** `system_notice` only: the expenses the line announces (audited on `message.sent`). */
  readonly noticeExpenseIds?: readonly ExpenseId[];
  /** `system_notice` only (T-165 r2): the line takes announced expenses back off the tab ("… off the tab"). */
  readonly noticeCorrection?: true;
  readonly id: MessageId;
  readonly groupId: GroupId;
  readonly to: OutboundTarget;
  /** Complete message for text-only channels; no markdown. */
  readonly text: string;
  /** Members @tagged in text (only those who must act). */
  readonly mentions?: readonly MemberId[];
  readonly replyTo?: MessageId;
  readonly card?: RichCard;
  readonly images?: readonly { readonly url: string; readonly alt: string }[];
  readonly actions?: readonly Action[];
  /** ISO; actions stop working after this. */
  readonly expiresAt?: IsoDateTime;
  /** True if any line came from roast mode. Evals assert: roast off ⇒ never true. */
  readonly roast?: boolean;
  /** Message-budget classification (D-009): replies and approvals are not proactive. */
  readonly proactive?: boolean;
  /** Urgent booking alerts are exempt from the budget but audited. */
  readonly urgent?: boolean;
}

export interface OutboundReaction {
  readonly id: MessageId;
  readonly groupId: GroupId;
  readonly kind: 'reaction';
  readonly to: OutboundTarget;
  readonly targetMessageId: MessageId;
  /** The only two Trav sends. */
  readonly emoji: '❤️' | '👍';
}

export type Outbound = OutboundMessage | OutboundReaction;

export function isReaction(o: Outbound): o is OutboundReaction {
  return 'kind' in o && o.kind === 'reaction';
}

/** T-165: a group-lane ledger notice (`OutboundMessage.kind === 'system_notice'`). */
export function isSystemNotice(
  o: Outbound,
): o is OutboundMessage & { readonly kind: 'system_notice' } {
  return 'kind' in o && o.kind === 'system_notice';
}

export type ActionId =
  'approve' | 'decline' | 'not_me' | 'confirm' | 'keep_private' | 'undo' | 'paid' | 'pick';

export interface Action {
  readonly id: ActionId;
  readonly label: string;
  readonly style: 'primary' | 'secondary' | 'destructive';
  readonly tapback?: '👍' | '👎';
  readonly textAliases: readonly string[];
  /** Who may trigger it; omitted = any charged member. */
  readonly allowedMemberIds?: readonly MemberId[];
  /** For "pick": the option id. */
  readonly value?: string;
}

export type RichCard =
  | BookingProposalCard
  | ReceiptCard
  | TicketCard
  | ExpenseConfirmCard
  | SettleUpCard
  | RecapCard
  | WrappedCard
  | OptionsCard;

export type RichCardType = RichCard['type'];

export interface CardBase {
  readonly cardId: CardId;
  readonly type: RichCardType;
  readonly title: string;
  /** Identical to OutboundMessage.text; the CLI prints this. */
  readonly fallbackText: string;
}

export interface Participant {
  readonly memberId: MemberId;
  readonly name: string;
  readonly share?: Money;
}

export interface BookingProposalCard extends CardBase {
  readonly type: 'booking_proposal';
  readonly proposalId: ProposalId;
  readonly category: 'event' | 'flight' | 'lodging' | 'transport' | 'other';
  readonly item: {
    readonly name: string;
    readonly venue?: string;
    readonly startsAt?: IsoDateTime;
    readonly endsAt?: IsoDateTime;
    readonly details?: readonly string[];
  };
  readonly quantity: number;
  readonly charged: readonly Participant[];
  readonly excluded?: readonly {
    readonly memberId: MemberId;
    readonly name: string;
    readonly reason?: string;
  }[];
  readonly pricePerPerson: Money;
  readonly total: Money;
  readonly refundable: boolean;
  readonly refundDeadline?: IsoDateTime;
  readonly paidBy: PaidBy;
  readonly policy: {
    readonly requiresApprovalFrom: readonly MemberId[];
    readonly approvalMode: 'any_one' | 'each_payer';
    readonly overCap: boolean;
    readonly capPerPerson?: Money;
    /** Human line: "over the €60/person cap". */
    readonly reason?: string;
    /** Deciding rule id from PolicyDecision, e.g. "C1". */
    readonly ruleId: string;
  };
  readonly holdExpiresAt: IsoDateTime;
  readonly status: 'pending' | 'approved' | 'declined' | 'expired' | 'superseded';
  readonly approvedBy?: readonly MemberId[];
  readonly alternativesCardId?: CardId;
}

export interface ReceiptCard extends CardBase {
  readonly type: 'receipt';
  readonly bookingId: BookingId;
  readonly proposalId: ProposalId;
  readonly merchant: string;
  readonly orderRef: string;
  readonly purchasedAt: IsoDateTime;
  readonly lineItems: readonly {
    readonly label: string;
    readonly qty: number;
    readonly unit: Money;
    readonly total: Money;
    readonly memberId?: MemberId;
  }[];
  readonly subtotal: Money;
  readonly fees?: Money;
  readonly tax?: Money;
  readonly total: Money;
  readonly refundable: boolean;
  readonly refundDeadline?: IsoDateTime;
  readonly paidBy: PaidBy;
  readonly ledger: { readonly expenseId: ExpenseId; readonly split: readonly Participant[] };
  /** DMs sent, for tests. */
  readonly tickets?: readonly { readonly memberId: MemberId; readonly ticketCardId: CardId }[];
  readonly auditEventId: string;
  readonly ruleId: string;
}

export interface TicketCard extends CardBase {
  readonly type: 'ticket';
  readonly bookingId: BookingId;
  /** The only person this card may be delivered to. */
  readonly ownerMemberId: MemberId;
  /** Normally == owner; a guardian for minors. */
  readonly deliveredTo: MemberId;
  readonly event: {
    readonly name: string;
    readonly venue: string;
    readonly address?: string;
    readonly startsAt: IsoDateTime;
    readonly doorsAt?: IsoDateTime;
  };
  readonly seat?: {
    readonly gate?: string;
    readonly section?: string;
    readonly row?: string;
    readonly seat?: string;
  };
  readonly qr: { readonly dataUrl: string; readonly payload: string };
  readonly holderName: string;
  readonly notes?: string;
}

export interface ExpenseConfirmCard extends CardBase {
  readonly type: 'expense_confirm';
  readonly expenseId: ExpenseId;
  readonly status: 'logged' | 'pending' | 'declined' | 'undone';
  readonly source: ExpenseSource;
  /** private until the owner confirms (card/email sources). */
  readonly visibility: 'group' | 'private';
  readonly merchant?: string;
  readonly description: string;
  readonly occurredAt?: IsoDateTime;
  readonly amount: Money;
  /** What was actually paid, when it was in another currency (T-084): shown as "$36 ≈ €32.94". */
  readonly original?: Money;
  readonly paidBy: MemberId;
  readonly split: {
    readonly method: SplitMethod;
    readonly participants: readonly Participant[];
    readonly excluded?: readonly Participant[];
  };
  readonly lineItems?: readonly {
    readonly label: string;
    readonly amount: Money;
    readonly participants: readonly MemberId[];
  }[];
  readonly classifier?: {
    readonly looksShared: boolean;
    readonly confidence: number;
    readonly reason: string;
  };
  /** Low-confidence parse (injection detected or confidence < threshold): "please check the total". */
  readonly lowConfidence?: boolean;
  readonly digestItems?: readonly ExpenseConfirmCard[];
}

export interface SettleUpCard extends CardBase {
  readonly type: 'settle_up';
  readonly mode: 'running' | 'final';
  readonly asOf: IsoDateTime;
  readonly dayNumber?: number;
  readonly currency: string;
  /** + is owed, − owes; sums to 0. */
  readonly balances: readonly {
    readonly memberId: MemberId;
    readonly name: string;
    readonly net: Money;
  }[];
  readonly transfers: readonly {
    readonly from: MemberId;
    readonly to: MemberId;
    readonly amount: Money;
    readonly paid?: boolean;
  }[];
  readonly totalSpent: Money;
}

export interface RecapCard extends CardBase {
  readonly type: 'recap';
  readonly kind: 'morning_after' | 'daily';
  readonly date: string;
  readonly dayNumber: number;
  readonly lastNight: {
    readonly events: readonly {
      readonly label: string;
      readonly attendees: readonly MemberId[];
      /** Present members who were not on it ("not Henry"); a fact, never a reason (T-015). */
      readonly notIn?: readonly MemberId[];
      readonly amount?: Money;
    }[];
    readonly total: Money;
    readonly perPerson?: Money;
    /** The group's daily budget, when the trip has one (pacing line). */
    readonly budget?: Money;
  };
  /** Empty unless roast mode on; evals assert guardrails on these. */
  readonly roastLines?: readonly string[];
  readonly settle: SettleUpCard;
  readonly today?: readonly {
    readonly label: string;
    readonly startsAt: IsoDateTime;
    readonly ticketsDelivered?: boolean;
  }[];
  /** Only from opted-in members. `photoId` lets "@trav drop that one" find it (T-015). */
  readonly photos: readonly {
    readonly url: string;
    readonly byMemberId: MemberId;
    readonly alt: string;
    readonly photoId?: string;
  }[];
}

export interface WrappedCard extends CardBase {
  readonly type: 'wrapped';
  readonly trip: {
    readonly name: string;
    readonly days: number;
    readonly people: number;
    readonly currency: string;
    /** First and last trip day (local dates), when known. */
    readonly startDate?: IsoDate;
    readonly endDate?: IsoDate;
  };
  readonly totals: {
    readonly spent: Money;
    readonly perPerson: Money;
    readonly byCategory: readonly { readonly category: string; readonly amount: Money }[];
  };
  readonly stats: readonly { readonly label: string; readonly value: string }[];
  readonly awards: readonly {
    readonly title: string;
    readonly memberId: MemberId;
    readonly evidence: string;
    /** Where the number comes from; `album` = consent-filtered shared album (T-016). */
    readonly basis: 'ledger' | 'booking' | 'attendance' | 'album';
  }[];
  readonly photos: readonly {
    readonly url: string;
    readonly byMemberId: MemberId;
    readonly alt: string;
  }[];
  readonly finalSettle: SettleUpCard;
  readonly shareable: true;
  /** The closing "next trip?" line (IDEAS idea 8): an invite, never a data share. */
  readonly closing?: { readonly text: string };
}

export interface OptionsCard extends CardBase {
  readonly type: 'options';
  readonly context: string;
  readonly options: readonly {
    readonly id: string;
    readonly index: number;
    readonly label: string;
    readonly price: Money;
    readonly perPerson?: Money;
    readonly refundable: boolean;
    readonly tradeoff: string;
    /** Per-person lines for the card body (T-074 group flights: "Dean BOS 7:10am → BCN 7:35pm · home to JFK · €412"). */
    readonly details?: readonly string[];
  }[];
  readonly pickAction: Action;
  readonly status: 'pending' | 'picked' | 'dropped' | 'expired';
}

/** Card types that must never be sent on the group lane. */
export const DM_ONLY_CARD_TYPES: readonly RichCardType[] = ['ticket'];
