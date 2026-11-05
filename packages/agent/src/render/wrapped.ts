/**
 * End-of-trip Wrapped (VOICE §4.8, card `wrapped`, embeds the final settle-up).
 * Up to three emoji (🎉 🏆 💸). Awards come only from ledger/booking/attendance
 * facts (`basis`) and are passed in by the recap math, never generated here; an
 * award naming a minor survives only if it is a "pick" (VOICE §4.8, §8).
 * Roast lines (max 2) pass the same gates as the recap. Photos: opted-in
 * members only, never a minor's in the shareable card, max 6.
 */
import type { Money, OutboundMessage, WrappedCard } from '@trav/core';
import { formatMoney, formatTransfer, safety } from '@trav/core';
import type { RenderContext } from './common.js';
import { GROUP, cardMessage, nameOf, plural } from './common.js';
import type { RecapPhoto, SafetyContext } from './recap.js';
import { consentedPhotos, gatedRoastLines } from './recap.js';
import type { SettleUpRenderInput } from './settleUp.js';
import { buildSettleUp } from './settleUp.js';

export interface WrappedRenderInput {
  readonly trip: {
    readonly name: string;
    readonly days: number;
    readonly people: number;
    readonly currency: string;
    /** Family tab: one pot, nothing to split (VOICE §8). */
    readonly familyTab?: boolean;
    /** First and last trip day, carried on the card (the share card shows them). */
    readonly startDate?: string;
    readonly endDate?: string;
  };
  readonly totals: {
    readonly spent: Money;
    readonly perPerson: Money;
    readonly byCategory: readonly { readonly category: string; readonly amount: Money }[];
  };
  /** One line each in the text, as `${value} ${label}` ("23 ubers, €412"). */
  readonly stats: readonly { readonly label: string; readonly value: string }[];
  readonly awards: WrappedCard['awards'];
  readonly roastLines?: readonly string[];
  readonly photos?: readonly RecapPhoto[];
  readonly finalSettle: Omit<SettleUpRenderInput, 'mode'>;
  /** The closing "next trip?" line (IDEAS idea 8), last in the text and on the card. */
  readonly closing?: string;
}

const MAX_STAT_LINES = 5;
/** Awards named in the text; the card carries up to `MAX_CARD_AWARDS`. */
const MAX_AWARDS = 3;
const MAX_CARD_AWARDS = 9;
const MAX_WRAPPED_PHOTOS = 6;
/** Evidence short enough to ride inline after the name ("(14 photos)"). */
const INLINE_EVIDENCE_CHARS = 12;

export type WrappedMessage = OutboundMessage & { readonly card: WrappedCard };

export interface WrappedRender {
  readonly message: WrappedMessage;
  /**
   * The roast lines that made it into `message.text` (already gated, trimmed
   * exactly as they appear in the text). The Wrapped card has no `roastLines`
   * field, so the send path cannot find them on its own: pass these as
   * `sendOutbound(message, deps, { roastLines })`. If the roast gate changed
   * between render and send, the screen then strips just these lines; without
   * them it can only drop the whole Wrapped (`roast_unlocatable`).
   * `message.roast === true` exactly when this is non-empty.
   */
  readonly roastLines: readonly string[];
}

/**
 * Prefer `renderWrappedForSend`, which also returns the roast lines the send
 * path needs. Kept for existing callers; equivalent to `.message`.
 */
export function renderWrapped(
  input: WrappedRenderInput,
  ctx: RenderContext,
  sc: SafetyContext,
): WrappedMessage {
  return renderWrappedForSend(input, ctx, sc).message;
}

export function renderWrappedForSend(
  input: WrappedRenderInput,
  ctx: RenderContext,
  sc: SafetyContext,
): WrappedRender {
  const { trip, totals } = input;
  const lines: string[] = [`${trip.name.toLowerCase()} wrapped 🎉`];
  if (trip.familyTab === true) {
    lines.push(`${plural(trip.days, 'day')} · ${formatMoney(totals.spent)} on the family tab`);
  } else {
    const people = trip.people > 2 ? [plural(trip.people, 'person', 'people')] : [];
    lines.push(
      [
        plural(trip.days, 'day'),
        ...people,
        formatMoney(totals.spent),
        `${formatMoney(totals.perPerson)} each`,
      ].join(' · '),
    );
  }
  for (const s of input.stats.slice(0, MAX_STAT_LINES)) lines.push(`${s.value} ${s.label}`);
  // Gated once: the same lines go into the text, the `roast` flag and the return value.
  const roastLines = gatedRoastLines(input.roastLines ?? [], ctx, sc)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  lines.push(...roastLines);

  const cardAwards = input.awards
    .filter((a) => {
      const m = ctx.members.find((x) => x.memberId === a.memberId);
      if (m === undefined) return false;
      return !safety.isMinor(m, ctx.now) || /\bpick\b/i.test(a.title);
    })
    .slice(0, MAX_CARD_AWARDS);
  const awards = cardAwards.slice(0, MAX_AWARDS);
  if (awards.length > 0) {
    lines.push(
      `awards 🏆 ${awards
        .map((a) => {
          const ev = a.evidence.length <= INLINE_EVIDENCE_CHARS ? ` (${a.evidence})` : '';
          return `${a.title}: ${nameOf(ctx, a.memberId)}${ev}`;
        })
        .join(' · ')}`,
    );
  }

  const familyTab = trip.familyTab === true || input.finalSettle.familyTab === true;
  const settle = buildSettleUp(
    { ...input.finalSettle, mode: 'final', ...(familyTab ? { familyTab: true } : {}) },
    ctx,
  );
  // What is still owed: transfers already marked paid (T-141) are done.
  const transfers = settle.card.transfers.filter((t) => t.paid !== true);
  if (familyTab) {
    // VOICE §4.8 C: a family tab has nothing to settle, so no settle line (T-065).
  } else if (transfers.length === 0) {
    lines.push("nothing to settle, everyone's square");
  } else if (transfers.length === 1) {
    const t = transfers[0]!;
    lines.push(
      `${formatTransfer(nameOf(ctx, t.from), nameOf(ctx, t.to), t.amount)} and you're square`,
    );
  } else {
    lines.push(
      `final settle is in the card, ${String(transfers.length)} transfers and you're done 💸`,
    );
  }

  const photos = consentedPhotos(input.photos ?? [], ctx, sc, { allowMinors: false }).slice(
    0,
    MAX_WRAPPED_PHOTOS,
  );
  if (photos.length > 0) {
    lines.push(`${plural(photos.length, 'photo')} in the card, from everyone who shared`);
  }
  const closing = input.closing?.trim() ?? '';
  if (closing.length > 0) lines.push(closing);

  const message = cardMessage<WrappedCard>(
    ctx,
    GROUP,
    lines,
    {
      type: 'wrapped',
      title: `${trip.name.toLowerCase()} wrapped`,
      trip: {
        name: trip.name,
        days: trip.days,
        people: trip.people,
        currency: trip.currency,
        ...(trip.startDate !== undefined ? { startDate: trip.startDate } : {}),
        ...(trip.endDate !== undefined ? { endDate: trip.endDate } : {}),
      },
      totals: {
        spent: totals.spent,
        perPerson: totals.perPerson,
        byCategory: totals.byCategory.map((c) => ({ ...c })),
      },
      stats: input.stats.map((s) => ({ ...s })),
      awards: cardAwards.map((a) => ({ ...a })),
      photos,
      finalSettle: settle.card,
      shareable: true,
      ...(closing.length > 0 ? { closing: { text: closing } } : {}),
    },
    {
      images: photos.map((p) => ({ url: p.url, alt: p.alt })),
      roast: roastLines.length > 0,
      proactive: true,
    },
  );
  return { message, roastLines };
}
