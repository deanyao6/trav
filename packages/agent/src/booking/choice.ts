/**
 * T-168 (b): choice purchases. When the offers for an ask really differ and
 * none is the obvious refundable default (a Barça match: two seat sections at
 * two prices, both non-refundable), Trav posts 2–4 options instead of a
 * proposal. Nothing is held or bought by the options card. The asker's pick
 * (a tap on the card, or an exact "1" / "option 1" bound to it) is the
 * approval: the proposal service re-quotes that option and, if the price is
 * the one the card showed and the policy's `pick` tier allows it, Trav buys.
 * Anything else (another member's pick, a changed price, a stale card, over
 * the cap) is the ordinary proposal card that needs a 👍.
 *
 * Pure helpers and an in-memory plan store (like `FlightPlanStore`); the
 * proposal service owns the flow (`proposals.ts`), the loop routes the taps.
 */
import type {
  CurrencyCode,
  GroupId,
  IsoDate,
  IsoDateTime,
  Member,
  MemberId,
  MessageId,
  OptionsCard,
  TripId,
} from '@trav/core';
import { formatMoney, money, parseIso } from '@trav/core';
import type { TicketOffer } from '@trav/adapters';
import { sanitizeInline } from '../context/groupContext.js';

/** VOICE §3.1: 1 headline + up to 4 options + 1 instruction line = 6 lines. */
export const MAX_TICKET_OPTIONS = 4;

export interface TicketChoiceOption {
  /** 1-based, as shown. */
  readonly index: number;
  readonly offerId: string;
  readonly tierName: string;
  /** Price plus fees, per ticket. */
  readonly unitMinor: number;
  readonly totalMinor: number;
  readonly refundable: boolean;
  /** The policy would buy this one on the asker's pick (T-168 `pick` tier). */
  readonly autoOnPick: boolean;
}

export interface TicketChoicePlan {
  /** Also the options card's `cardId`. */
  readonly planId: string;
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly eventId: string;
  readonly eventDate: IsoDate;
  readonly currency: CurrencyCode;
  readonly attendees: readonly MemberId[];
  readonly excluded: readonly MemberId[];
  /** The member who asked; their card is charged and only their pick is their ok. */
  readonly requestedBy: MemberId;
  /** Whose card the options card says it goes on (a minor's ask: the guardian's). */
  readonly cardHolder: MemberId;
  readonly sourceMessageId: MessageId;
  readonly options: readonly TicketChoiceOption[];
  readonly createdAt: IsoDateTime;
  /** After this a pick still proposes, but as a card that needs a 👍. */
  readonly expiresAt: IsoDateTime;
  readonly status: 'pending' | 'picked';
  readonly pickedIndex?: number;
  /**
   * Other members' picks (T-168 r1 #3): each became a proposal card that needs
   * a 👍. They never close the plan; the asker's own pick checks them first.
   */
  readonly otherPicks?: readonly { readonly index: number; readonly proposalId: string }[];
}

export interface TicketChoiceStore {
  save(plan: TicketChoicePlan): void;
  get(planId: string): TicketChoicePlan | undefined;
  /** The newest plan in the group, picked or not. */
  latest(groupId: GroupId): TicketChoicePlan | undefined;
}

const PLANS_KEPT = 50;

export function createTicketChoiceStore(): TicketChoiceStore {
  const byId = new Map<string, TicketChoicePlan>();
  const latestByGroup = new Map<GroupId, string>();
  return {
    save(plan) {
      const isNew = !byId.has(plan.planId);
      byId.set(plan.planId, plan);
      if (isNew) latestByGroup.set(plan.groupId, plan.planId);
      while (byId.size > PLANS_KEPT) {
        const oldest = byId.keys().next().value;
        if (oldest === undefined) break;
        byId.delete(oldest);
      }
    },
    get: (planId) => byId.get(planId),
    latest(groupId) {
      const id = latestByGroup.get(groupId);
      return id === undefined ? undefined : byId.get(id);
    },
  };
}

/**
 * The offers to choose between, or undefined when there is a clear default.
 * Refundable-first (CLAUDE.md §1.5): a refundable offer is the default and
 * the ask goes on as one proposal. With no refundable offer and two or more
 * offers to buy (seat sections at different prices), the member picks.
 * `ranked` is `rankOffers` output (bookable for the party, refundable first,
 * then cheapest).
 */
export function choiceOffers(
  ranked: readonly TicketOffer[],
  refundable: (o: TicketOffer) => boolean,
): readonly TicketOffer[] | undefined {
  if (ranked.length < 2) return undefined;
  if (ranked.some(refundable)) return undefined;
  const distinct = new Set(ranked.map((o) => sanitizeInline(o.tierName, 40).toLowerCase()));
  if (distinct.size < 2) return undefined;
  return ranked.slice(0, MAX_TICKET_OPTIONS);
}

/** Whether a pick of this plan still counts as the asker's ok (not stale). */
export function planLive(plan: TicketChoicePlan, now: IsoDateTime): boolean {
  return plan.status === 'pending' && parseIso(now) <= parseIso(plan.expiresAt);
}

/**
 * A text pick (T-168 b): exactly "1", "2", "option 2", "#2", "book option 2",
 * "pick 2", "2 please", optionally after "@trav". Anything else is not a pick.
 */
export function pickTextIndex(text: string): number | undefined {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/^@trav[\s,:]*/, '')
    .replace(/[.!🙏👍]+$/u, '')
    .trim();
  const m =
    /^(?:(?:book|pick|take)\s+)?(?:(?:option|number|no\.?|#)\s*)?([1-4])(?:\s+(?:please|pls))?$/.exec(
      t,
    );
  if (m === null) return undefined;
  return Number(m[1]);
}

function list(ids: readonly MemberId[], byId: ReadonlyMap<MemberId, Member>): string {
  return ids.map((id) => sanitizeInline(byId.get(id)?.displayName ?? id, 40)).join(', ');
}

function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]!}`;
}

/**
 * The options card (VOICE §4.1 E): what, when, how many and who; one line per
 * option with its tier, price each, total, refundability and the difference
 * from option 1; whose card and how it's split; how to pick and what a pick
 * does. Always "nothing's booked yet".
 */
export function renderTicketOptions(input: {
  readonly plan: TicketChoicePlan;
  readonly members: readonly Member[];
  /** "barça vs sevilla sunday 9pm". */
  readonly headline: string;
}): { readonly text: string; readonly card: OptionsCard } {
  const { plan, members } = input;
  const byId = new Map(members.map((m) => [m.memberId, m] as const));
  const n = plan.attendees.length;
  const cur = plan.currency;
  const who =
    plan.excluded.length > 0
      ? `${list(plan.attendees, byId)} (not ${list(plan.excluded, byId)})`
      : list(plan.attendees, byId);
  const context = `${input.headline}, ${String(n)} ticket${n === 1 ? '' : 's'}`;
  const first = plan.options[0];
  if (first === undefined) throw new Error('renderTicketOptions: no options');
  const tradeoff = (o: TicketChoiceOption): string => {
    if (o.index === 1) return '';
    const d = o.totalMinor - first.totalMinor;
    if (d === 0) return 'same price';
    return `${formatMoney(money(Math.abs(d), cur))} ${d > 0 ? 'more' : 'less'}`;
  };
  const lines = [`${context}: ${who}`];
  for (const o of plan.options) {
    const t = tradeoff(o);
    lines.push(
      [
        `${String(o.index)}. ${sanitizeInline(o.tierName, 40)}`,
        `${formatMoney(money(o.unitMinor, cur))} each`,
        `${formatMoney(money(o.totalMinor, cur))} total`,
        o.refundable ? 'refundable' : 'non-refundable',
        ...(t.length > 0 ? [t] : []),
      ].join(' · '),
    );
  }
  const holder = list([plan.cardHolder], byId);
  const split = n > 1 ? `, split ${String(n)} ways` : '';
  const numbers = plan.options.map((o) => String(o.index));
  const allAuto = plan.options.every((o) => o.autoOnPick);
  lines.push(
    allAuto
      ? `${holder}, tap one (or reply ${orList(numbers)}) and i book it on your card${split}. nothing's booked yet`
      : `tap one (or reply ${orList(numbers)}) and i'll post it for a 👍, on ${holder}'s card${split}. nothing's booked yet`,
  );
  const text = lines.join('\n');
  const card: OptionsCard = {
    cardId: plan.planId,
    type: 'options',
    title: context,
    fallbackText: text,
    context,
    options: plan.options.map((o) => ({
      id: `${plan.planId}#${String(o.index)}`,
      index: o.index,
      label: sanitizeInline(o.tierName, 40),
      price: money(o.totalMinor, cur),
      perPerson: money(o.unitMinor, cur),
      refundable: o.refundable,
      tradeoff: tradeoff(o),
    })),
    pickAction: { id: 'pick', label: 'Book this one', style: 'primary', textAliases: numbers },
    status: 'pending',
  };
  return { text, card };
}
