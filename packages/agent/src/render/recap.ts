/**
 * Morning After / daily recap (VOICE §4.7, card `recap`, embeds `settle_up`).
 * Order is always: last night → money → (roast lines) → tab → today.
 *
 * Roast lines arrive pre-generated (personality engine) and are dropped here
 * unless gate 1 passes for the group (`safety.groupRoastBlock`) and every
 * named member (`safety.roastAllowed`); `screenOutbound` re-checks on send.
 * So `roastLines` is empty whenever roast mode is off or a minor is present,
 * and `roast: true` only when at least one line survived. Photos come only
 * from members who opted in (and, for a minor, whose guardian opted in).
 */
import type {
  ConsentLookup,
  Group,
  IsoDate,
  IsoDateTime,
  MemberId,
  Money,
  OutboundMessage,
  RecapCard,
  Trip,
} from '@trav/core';
import { formatClockTime, formatMoney, formatTransfer, money, safety } from '@trav/core';
import type { RenderContext } from './common.js';
import { GROUP, cardMessage, nameOf } from './common.js';
import type { SettleUpRenderInput } from './settleUp.js';
import { buildSettleUp } from './settleUp.js';

export interface RecapPhoto {
  readonly url: string;
  readonly byMemberId: MemberId;
  readonly alt: string;
  /** Album id, so "@trav drop that one" can find it (T-015). */
  readonly photoId?: string;
}

export interface SafetyContext {
  readonly group: Group;
  readonly trip: Trip | null;
  readonly consent: ConsentLookup;
}

export interface RecapRenderInput {
  readonly kind: 'morning_after' | 'daily';
  readonly date: IsoDate;
  readonly dayNumber: number;
  readonly lastNight: {
    readonly events: readonly {
      readonly label: string;
      readonly attendees: readonly MemberId[];
      /**
       * Present members who were not on it. Shown as "(5 of you, not Henry)"
       * when one or two are out: who was out is a fact, the reason is theirs
       * (IDEAS Seed A; never "(Henry was sick)", T-028).
       */
      readonly notIn?: readonly MemberId[];
      readonly amount?: Money;
      /** The single payer: "snorkel tour $260 on Dad" in the daily recap (VOICE §3.4, §4.7 C). */
      readonly paidBy?: MemberId;
    }[];
    readonly total: Money;
    readonly perPerson?: Money;
    /** The group's daily budget: "€264 total, €36 over the €228 day budget". */
    readonly budget?: Money;
  };
  /** Card/email items still waiting on their owner (a count, never the items; SAFETY §2.3). */
  readonly pendingPrivateCount?: number;
  /** Pre-generated roast lines (max 2). Dropped unless every gate passes. */
  readonly roastLines?: readonly string[];
  readonly settle: SettleUpRenderInput;
  readonly today?: readonly {
    readonly label: string;
    readonly startsAt: IsoDateTime;
    readonly ticketsDelivered?: boolean;
  }[];
  readonly photos?: readonly RecapPhoto[];
}

/** VOICE §3.8: max 3 photos per recap. */
const MAX_RECAP_PHOTOS = 3;
const MAX_ROAST_LINES = 2;
const MAX_INLINE_EVENTS = 3;
/** "not Henry" for one or two people out; more than that reads as a list of absences. */
const MAX_NOT_IN_NAMES = 2;

/** Roast lines that pass gate 1 for the group and every member they name. */
export function gatedRoastLines(
  lines: readonly string[],
  ctx: RenderContext,
  sc: SafetyContext,
): string[] {
  if (lines.length === 0) return [];
  if (safety.groupRoastBlock(sc.group, ctx.members, sc.trip, ctx.now) !== null) return [];
  return lines
    .filter((line) => line.trim().length > 0)
    .filter((line) =>
      ctx.members.every(
        (m) =>
          !new RegExp(`(^|[^\\p{L}])${escape(m.displayName)}([^\\p{L}]|$)`, 'u').test(line) ||
          safety.roastAllowed(sc.group, ctx.members, m, sc.consent, sc.trip, ctx.now).allowed,
      ),
    )
    .filter((line) => safety.roastTopicBlocked(line) === null)
    .slice(0, MAX_ROAST_LINES);
}

/** ", under the €300 day budget" / ", €36 over the €228 day budget" (same currency only). */
function budgetText(n: RecapRenderInput['lastNight']): string {
  const b = n.budget;
  if (b === undefined || b.amountMinor <= 0 || b.currency !== n.total.currency) return '';
  const over = n.total.amountMinor - b.amountMinor;
  return over > 0
    ? `, ${formatMoney(money(over, b.currency))} over the ${formatMoney(b)} day budget`
    : `, under the ${formatMoney(b)} day budget`;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Photos from opted-in members; a minor's only with the guardian's opt-in too (VOICE §8). */
export function consentedPhotos(
  photos: readonly RecapPhoto[],
  ctx: RenderContext,
  sc: SafetyContext,
  opts: { readonly allowMinors: boolean },
): RecapPhoto[] {
  return photos.filter((p) => {
    const m = ctx.members.find((x) => x.memberId === p.byMemberId);
    if (m === undefined || sc.consent(m.memberId)?.photos !== true) return false;
    if (!safety.isMinor(m, ctx.now)) return true;
    if (!opts.allowMinors || m.guardianMemberId === undefined) return false;
    return sc.consent(m.guardianMemberId)?.photos === true;
  });
}

export function renderRecap(
  input: RecapRenderInput,
  ctx: RenderContext,
  sc: SafetyContext,
): OutboundMessage & { readonly card: RecapCard } {
  const groupSize = ctx.members.filter((m) => m.active && m.role !== 'guest').length;
  const morningAfter = input.kind === 'morning_after';
  const lines: string[] = [
    `${morningAfter ? 'morning after' : 'morning'}, day ${String(input.dayNumber)} ☀️`,
  ];

  const events = input.lastNight.events;
  if (events.length > 0) {
    const sameCrew = (a: readonly MemberId[], b: readonly MemberId[]): boolean =>
      a.length === b.length && a.every((x) => b.includes(x));
    const parts = events.slice(0, MAX_INLINE_EVENTS).map((e, i) => {
      // "(5 of you)" once per crew: repeated only when the attendees change.
      const prev = i > 0 ? events[i - 1] : undefined;
      const notIn = e.notIn ?? [];
      const notInText =
        notIn.length > 0 && notIn.length <= MAX_NOT_IN_NAMES
          ? `, not ${notIn.map((id) => nameOf(ctx, id)).join(' or ')}`
          : '';
      const who =
        e.attendees.length > 0 &&
        e.attendees.length < groupSize &&
        (prev === undefined || !sameCrew(prev.attendees, e.attendees))
          ? ` (${String(e.attendees.length)} of you${notInText})`
          : '';
      // "yesterday:" names who paid (VOICE §4.7 C); only a confirmed adult is shown as a payer (VOICE §8: unknown age counts as a possible minor).
      const payer =
        !morningAfter && e.amount !== undefined && e.paidBy !== undefined
          ? ctx.members.find((m) => m.memberId === e.paidBy)
          : undefined;
      const on =
        payer !== undefined && safety.isConfirmedAdult(payer, ctx.now)
          ? ` on ${nameOf(ctx, payer.memberId)}`
          : '';
      return `${e.label}${who}${e.amount !== undefined ? ` ${formatMoney(e.amount)}` : ''}${on}`;
    });
    const more =
      events.length > MAX_INLINE_EVENTS
        ? ` · +${String(events.length - MAX_INLINE_EVENTS)} more`
        : '';
    lines.push(`${morningAfter ? 'last night' : 'yesterday'}: ${parts.join(' · ')}${more}`);
  }
  // Nothing to list (the tab moved for something outside the window): no "€0 total" line.
  if (events.length > 0 || input.lastNight.total.amountMinor !== 0) {
    lines.push(
      (input.lastNight.perPerson !== undefined
        ? `${formatMoney(input.lastNight.total)} total, ${formatMoney(input.lastNight.perPerson)} each`
        : `${formatMoney(input.lastNight.total)} total`) + budgetText(input.lastNight),
    );
  }

  const roastLines = gatedRoastLines(input.roastLines ?? [], ctx, sc);
  lines.push(...roastLines);

  // The trip's own flag counts too, as in Wrapped (T-065 review #4).
  const familyTab = input.settle.familyTab === true || sc.trip?.familyTab === true;
  const settle = buildSettleUp(
    {
      ...input.settle,
      ...(input.settle.dayNumber === undefined ? { dayNumber: input.dayNumber } : {}),
      ...(familyTab ? { familyTab: true } : {}),
    },
    ctx,
  );
  const transfers = [...settle.card.transfers].sort(
    (a, b) => b.amount.amountMinor - a.amount.amountMinor,
  );
  const big = transfers[0];
  if (familyTab) {
    // VOICE §4.7 C (family tab: one pot, no transfers, T-065).
    lines.push("everything's on the family tab, nothing to split");
  } else if (big === undefined) {
    lines.push("tab: everyone's square");
  } else {
    const t = formatTransfer(nameOf(ctx, big.from), nameOf(ctx, big.to), big.amount);
    lines.push(
      transfers.length === 1 ? `tab: ${t}` : `tab: ${t} is the big one, full list in the card`,
    );
  }

  const pending = Math.max(0, Math.floor(input.pendingPrivateCount ?? 0));
  if (pending > 0) {
    lines.push(
      pending === 1
        ? '1 charge that looks shared is waiting on a tap in dms'
        : `${String(pending)} charges that look shared are waiting on a tap in dms`,
    );
  }

  const today = input.today ?? [];
  if (today.length > 0) {
    const items = today.slice(0, MAX_INLINE_EVENTS).map((t) => {
      const tickets = t.ticketsDelivered === true ? ', tickets in your dms' : '';
      return `${t.label} at ${formatClockTime(t.startsAt, ctx.timeZone)}${tickets}`;
    });
    lines.push(`today: ${items.join(' · ')}`);
  }

  const photos = consentedPhotos(input.photos ?? [], ctx, sc, { allowMinors: true }).slice(
    0,
    MAX_RECAP_PHOTOS,
  );
  return cardMessage<RecapCard>(
    ctx,
    GROUP,
    lines,
    {
      type: 'recap',
      title: `${morningAfter ? 'morning after' : 'morning'}, day ${String(input.dayNumber)}`,
      kind: input.kind,
      date: input.date,
      dayNumber: input.dayNumber,
      lastNight: {
        events: events.map((e) => ({
          label: e.label,
          attendees: e.attendees,
          ...(e.notIn !== undefined && e.notIn.length > 0 ? { notIn: e.notIn } : {}),
          ...(e.amount !== undefined ? { amount: e.amount } : {}),
        })),
        total: input.lastNight.total,
        ...(input.lastNight.perPerson !== undefined
          ? { perPerson: input.lastNight.perPerson }
          : {}),
        ...(input.lastNight.budget !== undefined ? { budget: input.lastNight.budget } : {}),
      },
      ...(pending > 0 ? { pendingPrivateCount: pending } : {}),
      roastLines,
      settle: settle.card,
      ...(today.length > 0 ? { today: today.map((t) => ({ ...t })) } : {}),
      photos,
    },
    {
      images: photos.map((p) => ({ url: p.url, alt: p.alt })),
      roast: roastLines.length > 0,
      proactive: true,
    },
  );
}
