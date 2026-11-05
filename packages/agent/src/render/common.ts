/**
 * Shared helpers for the card renderers (T-026; docs/VOICE.md §3, §4, §5).
 *
 * Every renderer is a pure function of typed data (never model text) that
 * returns an `OutboundMessage` whose `card.fallbackText === text`. Money goes
 * through `formatMoney` only (VOICE §3.4); times through core's clock helpers
 * (VOICE §3.9); names come from `Member.displayName` in group member order
 * (VOICE §3.5).
 */
import type {
  Action,
  ActionId,
  GroupId,
  IdGenerator,
  IsoDateTime,
  Member,
  MemberId,
  OutboundMessage,
  OutboundTarget,
  RichCard,
  TimeZone,
} from '@trav/core';
import { TravError, formatClockTime, formatTime, localDate, parseIso } from '@trav/core';
import {
  APPROVE_TEXT_ALIASES,
  DECLINE_TEXT_ALIASES,
  NOT_ME_TEXT_ALIASES,
} from '../approval/whitelist.js';

/** What every renderer needs besides its own data. */
export interface RenderContext {
  readonly groupId: GroupId;
  /** Group members in group order (VOICE §3.5 name order). Include members who left so old records still render. */
  readonly members: readonly Member[];
  /** The trip's IANA zone; every time is shown in local trip time (VOICE §3.9). */
  readonly timeZone: TimeZone;
  readonly now: IsoDateTime;
  /** Message and card ids (D-011): a retried render with the same generator state yields the same ids. */
  readonly ids: IdGenerator;
}

export const GROUP: OutboundTarget = { kind: 'group' };

export function dm(memberId: MemberId): OutboundTarget {
  return { kind: 'member', memberId };
}

/** Display name of a member; throws on an unknown id (a card must never name someone who isn't in the group). */
export function nameOf(ctx: Pick<RenderContext, 'members'>, memberId: MemberId): string {
  const m = ctx.members.find((x) => x.memberId === memberId);
  if (m === undefined) {
    throw new TravError('invalid_argument', `render: unknown member ${memberId}`, { memberId });
  }
  return m.displayName;
}

/** `ids` sorted into group member order (unknown ids throw). Duplicates are dropped. */
export function inMemberOrder(
  ctx: Pick<RenderContext, 'members'>,
  ids: readonly MemberId[],
): MemberId[] {
  const wanted = new Set(ids);
  for (const id of wanted) nameOf(ctx, id);
  return ctx.members.map((m) => m.memberId).filter((id) => wanted.has(id));
}

/** `Dean, Chase, Piotr` (VOICE §3.5: first names, comma-separated, member order). */
export function listNames(ctx: Pick<RenderContext, 'members'>, ids: readonly MemberId[]): string {
  return inMemberOrder(ctx, ids)
    .map((id) => nameOf(ctx, id))
    .join(', ');
}

/** `Dean's` / `James'`. */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** `1 ticket` / `5 tickets`. */
export function plural(n: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${String(n)} ${n === 1 ? noun : pluralNoun}`;
}

/** `1 or 2` / `1, 2, or 3` (the options reply line). */
export function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0] ?? ''} or ${items[1] ?? ''}`;
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1] ?? ''}`;
}

/**
 * The day part of VOICE §3.9 relative time: `tonight`, `tomorrow night`,
 * `last night`, `today`, `tomorrow`, `yesterday`, or `sat mar 14` beyond 48h.
 */
export function dayPhrase(iso: IsoDateTime, tz: TimeZone, now: IsoDateTime): string {
  const full = formatTime(iso, tz, now);
  const time = formatClockTime(iso, tz);
  if (full === time) return 'today';
  return full.endsWith(` ${time}`) ? full.slice(0, -(time.length + 1)) : full;
}

/** A deadline: `10pm` when it falls on today's local date, else `tomorrow 2pm` / `sat mar 14 9pm` (VOICE §3.9). */
export function deadlinePhrase(iso: IsoDateTime, tz: TimeZone, now: IsoDateTime): string {
  if (localDate(iso, tz) === localDate(now, tz)) return formatClockTime(iso, tz);
  return formatTime(iso, tz, now);
}

/** `2:14am` within the last/next 24h, else `sat mar 14 2:14am` (VOICE §3.9). */
export function whenShort(iso: IsoDateTime, tz: TimeZone, now: IsoDateTime): string {
  const full = formatTime(iso, tz, now);
  const time = formatClockTime(iso, tz);
  const relative = /^(tonight|last night|tomorrow night|yesterday|tomorrow) /.test(full);
  return relative ? time : full;
}

/** Whole minutes from `now` until `iso`, never below 0. */
export function minutesUntil(iso: IsoDateTime, now: IsoDateTime): number {
  const ms = parseIso(iso) - parseIso(now);
  return Math.max(0, Math.round(ms / 60_000));
}

/** Lowercase a headline item name (VOICE §4.1 "razzmatazz tonight"). */
export function headlineName(name: string): string {
  return name.toLowerCase();
}

// ---------- actions (VOICE §3.6, §6.2, §9.3) ----------

/** Text aliases per action (VOICE §3.6 / §6.2). Kept in sync with the keyword matcher's defaults. */
const TEXT_ALIASES: Readonly<Record<ActionId, readonly string[]>> = {
  approve: APPROVE_TEXT_ALIASES,
  decline: DECLINE_TEXT_ALIASES,
  not_me: NOT_ME_TEXT_ALIASES,
  confirm: ['yes', 'yep', 'share it'],
  keep_private: ['no', 'nah', 'keep private', 'keep it private'],
  undo: ['undo'],
  paid: ['paid', 'i paid'],
  pick: [],
  sent: ['sent', 'sent it', 'paid', 'i paid'],
  got_it: ['got it', 'received'],
};

const LABELS: Readonly<Record<ActionId, string>> = {
  approve: 'Approve',
  decline: 'Decline',
  not_me: 'Not me',
  confirm: 'Share it',
  keep_private: 'Keep private',
  undo: 'Undo',
  paid: 'Paid',
  pick: 'Pick',
  sent: 'Sent',
  got_it: 'Got it',
};

const TAPBACKS: Partial<Record<ActionId, '👍' | '👎'>> = {
  approve: '👍',
  decline: '👎',
  confirm: '👍',
  keep_private: '👎',
  undo: '👎',
  paid: '👍',
  // T-166: a payee's 👍 on the settle card is Got it (a payer's 👍 is their Sent).
  got_it: '👍',
};

const STYLES: Readonly<Record<ActionId, Action['style']>> = {
  approve: 'primary',
  decline: 'secondary',
  not_me: 'secondary',
  confirm: 'primary',
  keep_private: 'secondary',
  undo: 'destructive',
  paid: 'primary',
  pick: 'primary',
  sent: 'primary',
  got_it: 'primary',
};

export function action(
  id: ActionId,
  extra: {
    readonly label?: string;
    readonly allowedMemberIds?: readonly MemberId[];
    readonly textAliases?: readonly string[];
    readonly value?: string;
  } = {},
): Action {
  const tapback = TAPBACKS[id];
  return {
    id,
    label: extra.label ?? LABELS[id],
    style: STYLES[id],
    ...(tapback !== undefined ? { tapback } : {}),
    textAliases: extra.textAliases ?? TEXT_ALIASES[id],
    ...(extra.allowedMemberIds !== undefined ? { allowedMemberIds: extra.allowedMemberIds } : {}),
    ...(extra.value !== undefined ? { value: extra.value } : {}),
  };
}

// ---------- message assembly ----------

type CardInput<C extends RichCard> = Omit<C, 'fallbackText' | 'cardId'>;

export interface MessageExtras {
  readonly mentions?: readonly MemberId[];
  readonly replyTo?: string;
  readonly images?: readonly { readonly url: string; readonly alt: string }[];
  readonly actions?: readonly Action[];
  readonly expiresAt?: IsoDateTime;
  readonly roast?: boolean;
  readonly proactive?: boolean;
  readonly urgent?: boolean;
}

/** Assemble lines into text and attach the card with `fallbackText === text` (VOICE §5 invariant). */
export function cardMessage<C extends RichCard>(
  ctx: RenderContext,
  to: OutboundTarget,
  lines: readonly string[],
  card: CardInput<C>,
  extras: MessageExtras = {},
): OutboundMessage & { readonly card: C } {
  const text = joinLines(lines);
  const full = { ...card, cardId: ctx.ids.next('card'), fallbackText: text } as unknown as C;
  return {
    id: ctx.ids.next('msg'),
    groupId: ctx.groupId,
    to,
    text,
    ...compactExtras(extras),
    card: full,
  };
}

/** A plain text message (no card), e.g. "what did you just do?". */
export function textMessage(
  ctx: RenderContext,
  to: OutboundTarget,
  lines: readonly string[],
  extras: MessageExtras = {},
): OutboundMessage {
  return {
    id: ctx.ids.next('msg'),
    groupId: ctx.groupId,
    to,
    text: joinLines(lines),
    ...compactExtras(extras),
  };
}

function joinLines(lines: readonly string[]): string {
  const text = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
  if (text.length === 0) throw new TravError('invalid_argument', 'render: empty message');
  return text;
}

type ExtraFields = Partial<Omit<OutboundMessage, 'id' | 'groupId' | 'to' | 'text' | 'card'>>;

function compactExtras(extras: MessageExtras): ExtraFields {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extras)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (v === false) continue;
    out[k] = v;
  }
  return out as ExtraFields;
}
