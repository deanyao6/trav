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
import { formatClockTime, formatMoney, formatTransfer, safety } from '@trav/core';
import type { RenderContext } from './common.js';
import { GROUP, cardMessage, nameOf } from './common.js';
import type { SettleUpRenderInput } from './settleUp.js';
import { buildSettleUp } from './settleUp.js';

export interface RecapPhoto {
  readonly url: string;
  readonly byMemberId: MemberId;
  readonly alt: string;
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
      readonly amount?: Money;
    }[];
    readonly total: Money;
    readonly perPerson?: Money;
  };
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
      const who =
        e.attendees.length > 0 &&
        e.attendees.length < groupSize &&
        (prev === undefined || !sameCrew(prev.attendees, e.attendees))
          ? ` (${String(e.attendees.length)} of you)`
          : '';
      return `${e.label}${who}${e.amount !== undefined ? ` ${formatMoney(e.amount)}` : ''}`;
    });
    const more =
      events.length > MAX_INLINE_EVENTS
        ? ` · +${String(events.length - MAX_INLINE_EVENTS)} more`
        : '';
    lines.push(`${morningAfter ? 'last night' : 'yesterday'}: ${parts.join(' · ')}${more}`);
  }
  lines.push(
    input.lastNight.perPerson !== undefined
      ? `${formatMoney(input.lastNight.total)} total, ${formatMoney(input.lastNight.perPerson)} each`
      : `${formatMoney(input.lastNight.total)} total`,
  );

  const roastLines = gatedRoastLines(input.roastLines ?? [], ctx, sc);
  lines.push(...roastLines);

  const settle = buildSettleUp(
    {
      ...input.settle,
      ...(input.settle.dayNumber === undefined ? { dayNumber: input.dayNumber } : {}),
    },
    ctx,
  );
  const transfers = [...settle.card.transfers].sort(
    (a, b) => b.amount.amountMinor - a.amount.amountMinor,
  );
  const big = transfers[0];
  if (input.settle.familyTab === true) {
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
          ...(e.amount !== undefined ? { amount: e.amount } : {}),
        })),
        total: input.lastNight.total,
        ...(input.lastNight.perPerson !== undefined
          ? { perPerson: input.lastNight.perPerson }
          : {}),
      },
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
