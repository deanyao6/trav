/**
 * The outbound screen (SAFETY F1, §2.7 rule 1, §2.8; VOICE §5 card invariants,
 * §7, §8). Pure. It runs on EVERY Trav message before it is sent, in order:
 *
 *  1. Lane: DM-only cards (tickets) and private expense cards never go to the
 *     group lane → whole message suppressed.
 *  2. Roast: every roast line is checked (place, group gate, named targets,
 *     topic blocklist, private terms, per-message cap). Failing lines are
 *     stripped from `text`, `card.fallbackText` and `card.roastLines`; `roast`
 *     is cleared when none remain. If a failing line cannot be located in the
 *     text, the whole message is suppressed (fail closed).
 *  3. Content: restricted tags (supplied, or detected from the remaining text and
 *     card fields of suggestion-type messages) in a family-mode group → whole message suppressed unless an
 *     adult explicitly asked for a named adult-only audience and the reply names it.
 *
 * Each suppression carries the audit event (`content.suppressed` /
 * `roast.suppressed`) and payload for the caller to append.
 */
import type { IsoDateTime, MemberId, MessageId } from '../primitives.js';
import type { AuditEventType, AuditPayload } from '../domain/audit.js';
import type { Group, Member } from '../domain/group.js';
import type { ContentTag, Trip } from '../domain/trip.js';
import type { ConsentLookup } from '../domain/consent.js';
import type { ExpenseConfirmCard, Outbound, OutboundMessage, RichCard } from '../cards.js';
import { DM_ONLY_CARD_TYPES, isReaction } from '../cards.js';
import {
  audienceIncludesMinor,
  detectContentTags,
  isFamilyMode,
  isMinor,
  RESTRICTED_TAGS,
} from './minors.js';
import type { RoastBlockCause, RoastBlocklistEntry } from './roast.js';
import {
  DEFAULT_ROAST_BLOCKLIST,
  groupRoastBlock,
  roastAllowed,
  roastTopicBlocked,
} from './roast.js';
import { mentionsName, normalizeText } from './text.js';

export interface ScreenContext {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly consent: ConsentLookup;
  readonly now: IsoDateTime;
  /** Tags of the content the draft is about, if known (e.g. a venue suggestion). */
  readonly contentTags?: readonly ContentTag[];
  /** Audience of a suggestion; a minor in it blocks restricted content. */
  readonly audience?: readonly MemberId[];
  /** An adult explicitly asked for adult-only content for a named adult audience (SAFETY §2.7 rule 1). */
  readonly explicitAdultRequest?: boolean;
  /**
   * Roast lines inside `text` that are not in `card.roastLines` (the one-line
   * aside after a logged expense, Wrapped lines). Recap roast lines come from
   * the card automatically.
   */
  readonly roastLines?: readonly string[];
  /** Extra blocklist terms (e.g. loaded from a fixture by the agent); the default list always applies. */
  readonly roastBlocklist?: readonly RoastBlocklistEntry[];
  /**
   * Strings from members' unconfirmed private data (merchant names, amounts) that
   * must never appear in a roast (VOICE §7.4). Supplied by the send path.
   */
  readonly privateTerms?: readonly string[];
}

export type SuppressionCause =
  | 'minor_nightlife'
  | 'minor_alcohol'
  | 'age_restricted'
  | 'adult_audience_not_named'
  | 'roast_mode_off'
  | 'roast_minor_in_group'
  | 'roast_family_mode'
  | 'roast_age_unconfirmed'
  | 'roast_trip_over'
  | 'roast_member_opted_out'
  | 'roast_target_not_member'
  | 'roast_target_inactive'
  | 'roast_topic_blocked'
  | 'roast_private_data'
  | 'roast_wrong_place'
  | 'roast_line_limit'
  | 'roast_unlocatable'
  | 'dm_only_card_in_group'
  | 'private_card_in_group';

export interface Suppression {
  readonly cause: SuppressionCause;
  /** Category, tag list or member id. Never message text or private data. */
  readonly detail?: string;
  /** The audit event the caller writes for this suppression. */
  readonly event: Extract<AuditEventType, 'content.suppressed' | 'roast.suppressed'>;
  readonly payload: AuditPayload;
}

export interface ScreenResult {
  /** The message to send (roast lines stripped, `roast` cleared) or null if fully suppressed. */
  readonly outbound: Outbound | null;
  /** Each becomes a `content.suppressed` / `roast.suppressed` audit event. */
  readonly suppressed: readonly Suppression[];
}

/** Max roast lines in one message (VOICE §7.2: recaps max 2, Wrapped 1–2, asides 1). */
export const MAX_ROAST_LINES_PER_MESSAGE = 2;

/** Card types a roast line may ride on (VOICE §7.2). No card = a plain group aside. */
const ROAST_CARD_TYPES: ReadonlySet<RichCard['type']> = new Set([
  'recap',
  'wrapped',
  'expense_confirm',
]);

const ROAST_CAUSE: Readonly<Record<RoastBlockCause, SuppressionCause>> = {
  mode_off: 'roast_mode_off',
  minor_in_group: 'roast_minor_in_group',
  family_mode: 'roast_family_mode',
  age_unconfirmed: 'roast_age_unconfirmed',
  member_opted_out: 'roast_member_opted_out',
  target_not_member: 'roast_target_not_member',
  target_inactive: 'roast_target_inactive',
  trip_over: 'roast_trip_over',
};

/** SAFETY §2.2 payload `cause` for roast.suppressed. */
const ROAST_AUDIT_CAUSE: Partial<Record<SuppressionCause, string>> = {
  roast_mode_off: 'mode_off',
  roast_minor_in_group: 'minor_in_group',
  roast_family_mode: 'minor_in_group',
  roast_age_unconfirmed: 'age_unconfirmed',
  roast_trip_over: 'trip_over',
  roast_member_opted_out: 'member_opted_out',
  roast_target_not_member: 'target_not_member',
  roast_target_inactive: 'target_inactive',
  roast_topic_blocked: 'topic_blocked',
  roast_private_data: 'topic_blocked',
  roast_wrong_place: 'wrong_place',
  roast_line_limit: 'line_limit',
  roast_unlocatable: 'unlocatable',
};

function suppression(cause: SuppressionCause, draftId: MessageId, detail?: string): Suppression {
  const auditCause = ROAST_AUDIT_CAUSE[cause];
  if (auditCause !== undefined) {
    const payload: Record<string, unknown> = { cause: auditCause, messageDraftId: draftId };
    if (cause === 'roast_topic_blocked' && detail !== undefined) payload['topicCategory'] = detail;
    if (cause === 'roast_private_data') payload['topicCategory'] = 'private_data';
    if (detail !== undefined) payload['detail'] = detail;
    return {
      cause,
      ...(detail !== undefined ? { detail } : {}),
      event: 'roast.suppressed',
      payload,
    };
  }
  const payload: Record<string, unknown> = { cause, messageDraftId: draftId };
  if (detail !== undefined) payload['detail'] = detail;
  return {
    cause,
    ...(detail !== undefined ? { detail } : {}),
    event: 'content.suppressed',
    payload,
  };
}

function isPrivateExpenseCard(card: ExpenseConfirmCard): boolean {
  if (card.visibility === 'private') return true;
  return (card.digestItems ?? []).some((d) => isPrivateExpenseCard(d));
}

/** Every human-readable string a card can render (ids, URLs and QR payloads excluded). */
export function cardTexts(card: RichCard): string[] {
  const out: string[] = [card.title];
  switch (card.type) {
    case 'booking_proposal':
      out.push(card.item.name, card.item.venue ?? '', ...(card.item.details ?? []));
      break;
    case 'receipt':
      out.push(card.merchant, ...card.lineItems.map((l) => l.label));
      break;
    case 'ticket':
      out.push(card.event.name, card.event.venue, card.event.address ?? '', card.notes ?? '');
      break;
    case 'expense_confirm':
      out.push(
        card.merchant ?? '',
        card.description,
        ...(card.lineItems ?? []).map((l) => l.label),
      );
      for (const d of card.digestItems ?? []) out.push(...cardTexts(d));
      break;
    case 'settle_up':
      break;
    case 'recap':
      out.push(
        ...card.lastNight.events.map((e) => e.label),
        ...(card.today ?? []).map((t) => t.label),
        ...(card.roastLines ?? []),
        ...card.photos.map((p) => p.alt),
      );
      break;
    case 'wrapped':
      out.push(
        ...card.stats.flatMap((s) => [s.label, s.value]),
        ...card.awards.flatMap((a) => [a.title, a.evidence]),
        ...card.totals.byCategory.map((c) => c.category),
        ...card.photos.map((p) => p.alt),
      );
      break;
    case 'options':
      out.push(card.context, ...card.options.flatMap((o) => [o.label, o.tradeoff]));
      break;
  }
  return out.filter((s) => s.length > 0);
}

function contentCause(tags: readonly ContentTag[]): SuppressionCause {
  if (tags.some((t) => t === 'nightlife' || t === 'club')) return 'minor_nightlife';
  if (tags.some((t) => t === 'alcohol' || t === 'bar')) return 'minor_alcohol';
  return 'age_restricted';
}

/** Remove `line` from `text`; returns null if it is not present verbatim (after quote normalization). */
function removeLine(text: string, line: string): string | null {
  const raw = line.trim();
  if (raw.length === 0) return text;
  const at = text.indexOf(raw);
  if (at >= 0) return text.slice(0, at) + text.slice(at + raw.length);
  const needle = normalizeText(raw);
  const hay = normalizeText(text);
  const at2 = hay.indexOf(needle);
  if (at2 < 0) return null;
  return hay.slice(0, at2) + hay.slice(at2 + needle.length);
}

function tidy(text: string): string {
  return text
    .split('\n')
    .map((l) =>
      l
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([.,])/g, '$1')
        .trim(),
    )
    .map((l) => l.replace(/^[.,]\s*/, ''))
    .filter((l) => l.length > 0)
    .join('\n');
}

interface RoastCheck {
  readonly ok: boolean;
  readonly cause?: SuppressionCause;
  readonly detail?: string;
}

function checkRoastLine(
  line: string,
  draft: OutboundMessage,
  ctx: ScreenContext,
  groupBlock: RoastBlockCause | null,
): RoastCheck {
  const placeOk =
    draft.to.kind === 'group' &&
    (draft.card === undefined || ROAST_CARD_TYPES.has(draft.card.type));
  if (!placeOk) {
    return {
      ok: false,
      cause: 'roast_wrong_place',
      ...(draft.card ? { detail: draft.card.type } : { detail: 'dm' }),
    };
  }
  if (groupBlock !== null) return { ok: false, cause: ROAST_CAUSE[groupBlock] };
  // Every member named in the line (including ones who left) must pass gate 1.
  for (const m of ctx.members) {
    if (!mentionsName(line, m.displayName)) continue;
    const gate = roastAllowed(ctx.group, ctx.members, m, ctx.consent, ctx.trip, ctx.now);
    if (!gate.allowed) return { ok: false, cause: ROAST_CAUSE[gate.cause], detail: m.memberId };
  }
  const blocklist =
    ctx.roastBlocklist !== undefined && ctx.roastBlocklist.length > 0
      ? [...DEFAULT_ROAST_BLOCKLIST, ...ctx.roastBlocklist]
      : DEFAULT_ROAST_BLOCKLIST;
  const category = roastTopicBlocked(line, blocklist);
  if (category !== null) return { ok: false, cause: 'roast_topic_blocked', detail: category };
  const lower = normalizeText(line).toLowerCase();
  for (const term of ctx.privateTerms ?? []) {
    const t = normalizeText(term).trim().toLowerCase();
    if (t.length > 0 && lower.includes(t)) return { ok: false, cause: 'roast_private_data' };
  }
  return { ok: true };
}

function rewriteCard(card: RichCard, text: string, kept: readonly string[]): RichCard {
  if (card.type === 'recap') {
    const roastLines = (card.roastLines ?? []).filter((l) => kept.includes(l));
    return { ...card, fallbackText: text, roastLines };
  }
  return { ...card, fallbackText: text };
}

/** Same message with new text (card.fallbackText kept identical) and `roast` set only if lines remain. */
function withText(draft: OutboundMessage, text: string, kept: readonly string[]): OutboundMessage {
  const { roast: _roast, card, ...rest } = draft;
  return {
    ...rest,
    text,
    ...(card !== undefined ? { card: rewriteCard(card, text, kept) } : {}),
    ...(kept.length > 0 ? { roast: true } : {}),
  };
}

function screenRoast(
  draft: OutboundMessage,
  ctx: ScreenContext,
  out: Suppression[],
): OutboundMessage | null {
  const cardLines = draft.card?.type === 'recap' ? [...(draft.card.roastLines ?? [])] : [];
  const extra = (ctx.roastLines ?? []).filter((l) => !cardLines.includes(l));
  const lines = [...cardLines, ...extra].filter((l) => l.trim().length > 0);
  if (lines.length === 0 && draft.roast !== true) return draft;

  const groupBlock = groupRoastBlock(ctx.group, ctx.members, ctx.trip, ctx.now);

  if (lines.length === 0) {
    // Flagged as roast but the lines are not identified: check the whole text, fail closed.
    for (const textLine of draft.text.split('\n')) {
      const c = checkRoastLine(textLine, draft, ctx, groupBlock);
      if (!c.ok && c.cause !== undefined) {
        out.push(suppression(c.cause, draft.id, c.detail));
        out.push(suppression('roast_unlocatable', draft.id));
        return null;
      }
    }
    return draft;
  }

  let text = draft.text;
  const kept: string[] = [];
  for (const line of lines) {
    let check = checkRoastLine(line, draft, ctx, groupBlock);
    if (check.ok && kept.length >= MAX_ROAST_LINES_PER_MESSAGE) {
      check = { ok: false, cause: 'roast_line_limit' };
    }
    if (check.ok) {
      kept.push(line);
      continue;
    }
    if (check.cause !== undefined) out.push(suppression(check.cause, draft.id, check.detail));
    const next = removeLine(text, line);
    if (next === null) {
      out.push(suppression('roast_unlocatable', draft.id));
      return null;
    }
    text = next;
  }
  if (kept.length === lines.length) return draft;
  const cleaned = tidy(text);
  if (cleaned.length === 0) return null;
  return withText(draft, cleaned, kept);
}

/** Cards that record ledger facts rather than suggest plans (keyword backstop skipped; explicit tags still apply). */
const LEDGER_CARD_TYPES: ReadonlySet<RichCard['type']> = new Set([
  'expense_confirm',
  'receipt',
  'settle_up',
  'ticket',
]);

function screenContent(
  draft: OutboundMessage,
  ctx: ScreenContext,
  out: Suppression[],
): OutboundMessage | null {
  if (!isFamilyMode(ctx.group, ctx.members, ctx.now)) return draft;
  const tagSet = new Set<ContentTag>(ctx.contentTags ?? []);
  // Keyword backstop only on messages that can carry a suggestion or highlight.
  // Ledger records (logged expenses, receipts, settle-ups, tickets) state facts an
  // adult already created; SAFETY §2.7 rule 4 keeps that spend as plain numbers.
  if (draft.card === undefined || !LEDGER_CARD_TYPES.has(draft.card.type)) {
    const texts = [
      draft.text,
      ...(draft.card ? cardTexts(draft.card) : []),
      ...(draft.images ?? []).map((i) => i.alt),
    ];
    for (const t of texts) for (const tag of detectContentTags(t)) tagSet.add(tag);
  }
  const restricted = [...tagSet].filter((t) => RESTRICTED_TAGS.includes(t));
  if (restricted.length === 0) return draft;

  const detail = restricted.join(',');
  const recipient = draft.to.kind === 'member' ? draft.to.memberId : undefined;
  if (recipient !== undefined) {
    const r = ctx.members.find((m) => m.memberId === recipient);
    if (r === undefined || isMinor(r, ctx.now)) {
      // Never in a minor's DM, whatever was asked.
      out.push(suppression(contentCause(restricted), draft.id, detail));
      return null;
    }
  }
  if (
    ctx.explicitAdultRequest !== true ||
    ctx.audience === undefined ||
    ctx.audience.length === 0
  ) {
    out.push(suppression(contentCause(restricted), draft.id, detail));
    return null;
  }
  const audience =
    recipient !== undefined && !ctx.audience.includes(recipient)
      ? [...ctx.audience, recipient]
      : ctx.audience;
  if (audienceIncludesMinor(audience, ctx.members, ctx.now)) {
    out.push(suppression(contentCause(restricted), draft.id, detail));
    return null;
  }
  if (draft.to.kind === 'group') {
    // SAFETY F3: the reply names the adult audience.
    const named =
      /\badults\b/i.test(draft.text) ||
      audience.some((id) => {
        const m = ctx.members.find((x) => x.memberId === id);
        return m !== undefined && mentionsName(draft.text, m.displayName);
      });
    if (!named) {
      out.push(suppression('adult_audience_not_named', draft.id, detail));
      return null;
    }
  }
  return draft;
}

/** Runs on EVERY Trav message before it is sent (SAFETY F1). */
export function screenOutbound(draft: Outbound, ctx: ScreenContext): ScreenResult {
  if (isReaction(draft)) return { outbound: draft, suppressed: [] };
  const suppressed: Suppression[] = [];

  // 1. Lane.
  if (draft.to.kind === 'group' && draft.card !== undefined) {
    if (DM_ONLY_CARD_TYPES.includes(draft.card.type)) {
      suppressed.push(suppression('dm_only_card_in_group', draft.id, draft.card.type));
      return { outbound: null, suppressed: dedupe(suppressed) };
    }
    if (draft.card.type === 'expense_confirm' && isPrivateExpenseCard(draft.card)) {
      suppressed.push(suppression('private_card_in_group', draft.id, draft.card.type));
      return { outbound: null, suppressed: dedupe(suppressed) };
    }
  }

  // 2. Roast lines.
  const afterRoast = screenRoast(draft, ctx, suppressed);
  if (afterRoast === null) return { outbound: null, suppressed: dedupe(suppressed) };

  // 3. Restricted content.
  const afterContent = screenContent(afterRoast, ctx, suppressed);
  return { outbound: afterContent, suppressed: dedupe(suppressed) };
}

function dedupe(list: readonly Suppression[]): Suppression[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const key = `${s.cause}|${s.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
