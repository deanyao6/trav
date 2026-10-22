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
 *     text, the whole message is suppressed (fail closed). On a roast-flagged
 *     draft, every line NOT declared as a roast line is also scanned for roast
 *     material (blocklist topics, private terms, a named minor); a hit there
 *     means the caller mislabelled its lines and the message is suppressed.
 *     Wrapped awards and stats are roast material (VOICE §7.6, §4.8) whatever
 *     the roast flag says: failing awards/stats are stripped from the card and
 *     the text, or the message is suppressed if the text cannot be kept in sync.
 *  3. Content: restricted tags (supplied, or detected from the remaining text and
 *     card fields of suggestion-type messages, and from every field of anything
 *     addressed to a minor) in a family-mode group → whole message suppressed
 *     unless an adult explicitly asked for a named adult-only audience, the reply
 *     names it, and no minor is named as part of the plan.
 *
 * Each suppression carries the audit event (`content.suppressed` /
 * `roast.suppressed`) and payload for the caller to append.
 */
import type { IsoDateTime, MemberId, MessageId } from '../primitives.js';
import type { AuditEventType, AuditPayload } from '../domain/audit.js';
import type { Group, Member } from '../domain/group.js';
import type { ContentTag, Trip } from '../domain/trip.js';
import type { ConsentLookup } from '../domain/consent.js';
import type {
  ExpenseConfirmCard,
  Outbound,
  OutboundMessage,
  RichCard,
  WrappedCard,
} from '../cards.js';
import { DM_ONLY_CARD_TYPES, isReaction } from '../cards.js';
import {
  audienceIncludesMinor,
  detectContentTags,
  groupHasMinor,
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
import {
  findNormalized,
  mentionsName,
  minorReferentIncluded,
  namedAsIncluded,
  normalizeText,
} from './text.js';

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
   *
   * Contract: the agent must mark its roast output, either by listing the
   * lines here / in `card.roastLines` or by setting `draft.roast = true`
   * (then every line is checked and a hit fails the whole message closed).
   * Wrapped awards and stats are always treated as roast material. A
   * blocklisted topic in UNMARKED plain text (including unmarked Wrapped
   * prose) is treated like any other unmarked line: it is not a roast, so
   * gate 2 does not run on it. Enforcing the marking on the renderer side is
   * tracked separately.
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

/** SAFETY §2.2 `roast.suppressed` payload `cause` (the agent adds `classifier_blocked`). */
export type RoastSuppressedAuditCause =
  | 'mode_off'
  | 'minor_in_group'
  | 'age_unconfirmed'
  | 'trip_over'
  | 'member_opted_out'
  | 'target_not_member'
  | 'target_inactive'
  | 'topic_blocked'
  | 'classifier_blocked'
  | 'wrong_place'
  | 'line_limit'
  | 'unlocatable';

/** SAFETY §2.2 `content.suppressed` payload `cause`. */
export type ContentSuppressedAuditCause =
  | 'minor_nightlife'
  | 'minor_alcohol'
  | 'age_restricted'
  | 'adult_audience_not_named'
  | 'dm_only_card_in_group'
  | 'private_card_in_group';

/** Runtime copies of the unions above, for tests and the SAFETY §2.2 table. */
export const ROAST_AUDIT_CAUSES: readonly RoastSuppressedAuditCause[] = [
  'mode_off',
  'minor_in_group',
  'age_unconfirmed',
  'trip_over',
  'member_opted_out',
  'target_not_member',
  'target_inactive',
  'topic_blocked',
  'classifier_blocked',
  'wrong_place',
  'line_limit',
  'unlocatable',
];
export const CONTENT_AUDIT_CAUSES: readonly ContentSuppressedAuditCause[] = [
  'minor_nightlife',
  'minor_alcohol',
  'age_restricted',
  'adult_audience_not_named',
  'dm_only_card_in_group',
  'private_card_in_group',
];

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

/** SAFETY §2.2 payload `cause` for roast.suppressed; causes not listed here are content.suppressed. */
const ROAST_AUDIT_CAUSE: Partial<Record<SuppressionCause, RoastSuppressedAuditCause>> = {
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

function isContentCause(cause: SuppressionCause): cause is ContentSuppressedAuditCause {
  return ROAST_AUDIT_CAUSE[cause] === undefined;
}

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
  const contentCauseValue: ContentSuppressedAuditCause = isContentCause(cause)
    ? cause
    : 'age_restricted';
  const payload: Record<string, unknown> = { cause: contentCauseValue, messageDraftId: draftId };
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

/**
 * Remove `needle` from `text`; returns null if it is not present (verbatim or
 * after normalization). The match is located on normalized text but the splice
 * is on the original, so curly quotes elsewhere in the message are untouched.
 */
function removeLine(text: string, needle: string): string | null {
  const raw = needle.trim();
  if (raw.length === 0) return text;
  const span = locate(text, raw);
  if (span === null) return null;
  return text.slice(0, span.start) + text.slice(span.end);
}

function locate(text: string, raw: string): { start: number; end: number } | null {
  const at = text.indexOf(raw);
  if (at >= 0) return { start: at, end: at + raw.length };
  return findNormalized(text, raw);
}

/**
 * Remove one item of a " · "-separated list (Wrapped awards, stat rows) along
 * with one adjacent separator on the same line, so "awards 🏆 A · B" minus A
 * reads "awards 🏆 B", not "awards 🏆 · B". Null if `needle` is not present.
 */
function removeListItem(text: string, needle: string): string | null {
  const raw = needle.trim();
  if (raw.length === 0) return text;
  const span = locate(text, raw);
  if (span === null) return null;
  let { start, end } = span;
  const after = /^[ \t]*·[ \t]*/u.exec(text.slice(end));
  if (after !== null) {
    end += after[0].length;
  } else {
    const before = /[ \t]*·[ \t]*$/u.exec(text.slice(0, start));
    if (before !== null) start -= before[0].length;
  }
  return text.slice(0, start) + text.slice(end);
}

function containsNormalized(text: string, needle: string): boolean {
  return needle.trim().length > 0 && findNormalized(text, needle.trim()) !== null;
}

function tidy(text: string): string {
  return text
    .split('\n')
    .map((l) =>
      l
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/(?:\s*·\s*){2,}/g, ' · ')
        .replace(/^\s*·\s*/, '')
        .replace(/\s*·\s*$/, '')
        .replace(/\s+([.,])/g, '$1')
        .trim(),
    )
    .map((l) => l.replace(/^[.,]\s*/, ''))
    .filter((l) => l.length > 0 && !/^awards\s*(?:🏆\s*)?$/u.test(l))
    .join('\n');
}

interface RoastCheck {
  readonly ok: boolean;
  readonly cause?: SuppressionCause;
  readonly detail?: string;
}

const OK: RoastCheck = { ok: true };

function blocklistFor(ctx: ScreenContext): readonly RoastBlocklistEntry[] {
  return ctx.roastBlocklist !== undefined && ctx.roastBlocklist.length > 0
    ? [...DEFAULT_ROAST_BLOCKLIST, ...ctx.roastBlocklist]
    : DEFAULT_ROAST_BLOCKLIST;
}

/** Gate 2 (topic blocklist) and the private-data check for one line. */
function checkTopics(line: string, ctx: ScreenContext): RoastCheck {
  const category = roastTopicBlocked(line, blocklistFor(ctx));
  if (category !== null) return { ok: false, cause: 'roast_topic_blocked', detail: category };
  const lower = normalizeText(line).toLowerCase();
  for (const term of ctx.privateTerms ?? []) {
    const t = normalizeText(term).trim().toLowerCase();
    if (t.length > 0 && lower.includes(t)) return { ok: false, cause: 'roast_private_data' };
  }
  return OK;
}

/**
 * Who a line may be about, outside roast mode's own gate:
 *  - 'minor': only a minor is off limits (used for lines the caller did NOT
 *    declare as roasts; settle lines legitimately name opted-out or departed
 *    members, "you owe Dean €40" is a ledger fact, SAFETY §2.8).
 *  - 'award': Wrapped awards/stats. A minor (unless a "pick" award), a guest or
 *    non-member, or someone who left is never the subject; with roast mode on,
 *    an opted-out member is never named either (VOICE §7.2 "even if they're the
 *    biggest spender"). With roast mode off awards are neutral stats (VOICE §5).
 */
type NameGate = 'minor' | 'award';

function checkTarget(
  m: Member | undefined,
  id: MemberId,
  ctx: ScreenContext,
  gate: NameGate,
  pick: boolean,
): RoastCheck {
  if (gate === 'minor') {
    if (m !== undefined && isMinor(m, ctx.now)) {
      return { ok: false, cause: 'roast_minor_in_group', detail: id };
    }
    return OK;
  }
  if (m === undefined || m.groupId !== ctx.group.groupId || m.role === 'guest') {
    return { ok: false, cause: 'roast_target_not_member', detail: id };
  }
  if (isMinor(m, ctx.now) && !pick) return { ok: false, cause: 'roast_minor_in_group', detail: id };
  if (!m.active || m.leftAt !== undefined) {
    return { ok: false, cause: 'roast_target_inactive', detail: id };
  }
  if (ctx.group.settings.roastMode === true && ctx.consent(m.memberId)?.roast !== true) {
    return { ok: false, cause: 'roast_member_opted_out', detail: id };
  }
  return OK;
}

/** Topic blocklist, private terms, and `gate` for every member the line names. */
function checkNeutralLine(
  line: string,
  ctx: ScreenContext,
  gate: NameGate,
  pick = false,
): RoastCheck {
  const topics = checkTopics(line, ctx);
  if (!topics.ok) return topics;
  for (const m of ctx.members) {
    if (!mentionsName(line, m.displayName)) continue;
    const t = checkTarget(m, m.memberId, ctx, gate, pick);
    if (!t.ok) return t;
  }
  return OK;
}

/** Full roast gate for a declared roast line: place, group gate, gate 1 per named member, gate 2. */
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
  return checkTopics(line, ctx);
}

// ---------- Wrapped awards and stats ----------

const PICK_RE = /\bpick\b/iu;

function hasLetters(s: string): boolean {
  return /\p{L}/u.test(s);
}

function nameOf(ctx: ScreenContext, id: MemberId): string {
  return ctx.members.find((m) => m.memberId === id)?.displayName ?? '';
}

/**
 * Remove an award from the text in the shapes the renderer writes
 * ("Title: Name (evidence)", "Title: Name", the evidence on its own). Null if
 * the title, or an evidence string with letters, still survives (fail closed).
 */
function removeAwardFromText(
  text: string,
  award: WrappedCard['awards'][number],
  name: string,
): string | null {
  const forms = [
    ...(name.length > 0
      ? [`${award.title}: ${name} (${award.evidence})`, `${award.title}: ${name}`]
      : []),
    `${award.title} (${award.evidence})`,
    award.title,
  ];
  let t = text;
  for (const f of forms) {
    const next = removeListItem(t, f);
    if (next !== null && next !== t) {
      t = next;
      break;
    }
  }
  if (hasLetters(award.evidence)) {
    for (let guard = 0; guard < 8; guard += 1) {
      const next = removeListItem(t, award.evidence);
      if (next === null || next === t) break;
      t = next;
    }
    if (containsNormalized(t, award.evidence)) return null;
  }
  if (containsNormalized(t, award.title)) return null;
  return t;
}

interface WrappedScreen {
  readonly card: WrappedCard;
  readonly text: string;
  readonly changed: boolean;
}

/** The text shapes the renderer writes for a kept award (used to blank it out of the re-check). */
function awardForms(award: WrappedCard['awards'][number], name: string): string[] {
  return [
    ...(name.length > 0
      ? [`${award.title}: ${name} (${award.evidence})`, `${award.title}: ${name}`]
      : []),
    `${award.title} (${award.evidence})`,
    award.title,
    award.evidence,
  ];
}

/** Remove every occurrence of each form (best effort, never fails). */
function blankForms(text: string, forms: readonly string[]): string {
  let t = text;
  for (const f of forms) {
    for (let guard = 0; guard < 8; guard += 1) {
      const next = removeListItem(t, f);
      if (next === null || next === t) break;
      t = next;
    }
  }
  return t;
}

/** VOICE §7.6 / §4.8: awards and stats obey §7 rules even with roast mode off. */
function screenWrapped(
  card: WrappedCard,
  textIn: string,
  draftId: MessageId,
  ctx: ScreenContext,
  out: Suppression[],
): WrappedScreen | null {
  let text = textIn;
  let changed = false;
  let recheck = false;
  /** Members a blocked award/stat was about: their name must not survive in the text. */
  const blockedIds = new Set<MemberId>();
  const noteBlock = (check: RoastCheck, id?: MemberId): void => {
    changed = true;
    recheck = true;
    if (check.cause !== undefined) out.push(suppression(check.cause, draftId, check.detail));
    const nameCause =
      check.cause === 'roast_member_opted_out' ||
      check.cause === 'roast_minor_in_group' ||
      check.cause === 'roast_target_not_member' ||
      check.cause === 'roast_target_inactive';
    if (nameCause && check.detail !== undefined) blockedIds.add(check.detail);
    if (nameCause && id !== undefined) blockedIds.add(id);
  };

  const awards: WrappedCard['awards'][number][] = [];
  for (const a of card.awards) {
    const pick = PICK_RE.test(a.title);
    let check = checkNeutralLine(`${a.title}. ${a.evidence}`, ctx, 'award', pick);
    if (check.ok) {
      const target = ctx.members.find((m) => m.memberId === a.memberId);
      check = checkTarget(target, a.memberId, ctx, 'award', pick);
    }
    if (check.ok) {
      awards.push(a);
      continue;
    }
    noteBlock(check, a.memberId);
    const next = removeAwardFromText(text, a, nameOf(ctx, a.memberId));
    if (next === null) {
      out.push(suppression('roast_unlocatable', draftId));
      return null;
    }
    text = next;
  }

  const stats: WrappedCard['stats'][number][] = [];
  for (const s of card.stats) {
    const line = `${s.value} ${s.label}`.trim();
    const check = checkNeutralLine(line, ctx, 'award');
    if (check.ok) {
      stats.push(s);
      continue;
    }
    noteBlock(check);
    const next = removeListItem(text, line);
    if (next !== null) {
      text = next;
    } else if (containsNormalized(text, s.label) && hasLetters(s.label)) {
      // The stat is in the text in a shape we cannot strip: fail closed.
      out.push(suppression('roast_unlocatable', draftId));
      return null;
    }
  }

  if (recheck) {
    // A blocked award/stat was removed in every shape we know, but the text may
    // carry it paraphrased ("goes to Sam, so drunk he...", "Jordan paid for
    // kebabs 3 nights running"). If a blocklisted topic, private data, or the
    // name of a member the block was about still appears anywhere outside the
    // kept awards and stats, fail closed rather than send it.
    let residual = text;
    for (const a of awards) residual = blankForms(residual, awardForms(a, nameOf(ctx, a.memberId)));
    for (const s of stats) residual = blankForms(residual, [`${s.value} ${s.label}`.trim()]);
    const blockedMembers = ctx.members.filter((m) => blockedIds.has(m.memberId));
    for (const textLine of residual.split('\n')) {
      if (!checkTopics(textLine, ctx).ok) {
        out.push(suppression('roast_unlocatable', draftId));
        return null;
      }
      for (const m of blockedMembers) {
        if (!mentionsName(textLine, m.displayName)) continue;
        if (checkTarget(m, m.memberId, ctx, 'award', false).ok) continue;
        out.push(suppression('roast_unlocatable', draftId));
        return null;
      }
    }
  }

  if (!changed) return { card, text, changed: false };
  return { card: { ...card, awards, stats }, text, changed: true };
}

// ---------- roast screen ----------

/** Causes that mean the line was stripped because of WHO it named (gate 1 per target). */
const TARGET_CAUSES: ReadonlySet<SuppressionCause> = new Set([
  'roast_member_opted_out',
  'roast_target_not_member',
  'roast_target_inactive',
  'roast_minor_in_group',
]);

/** Third-person pronouns: a line with one of these and no name keeps talking about the last person named. */
const THIRD_PERSON_RE =
  /(?<![\p{L}\p{N}'])(?:he|she|they|him|her|hers|his|their|theirs|them|himself|herself|themselves)(?![\p{L}\p{N}])/iu;

function namesAnyMember(line: string, ctx: ScreenContext): boolean {
  return ctx.members.some((m) => mentionsName(line, m.displayName));
}

/**
 * Card fields the roast screen must read besides the declared lines: titles,
 * event labels, photo and image alt text. Wrapped awards and stats are handled
 * by `screenWrapped` (stripped, not failed) and recap roast lines by the
 * declared-line loop, so they are left out here.
 */
function cardSideTexts(draft: OutboundMessage): string[] {
  const out: string[] = (draft.images ?? []).map((i) => i.alt);
  const card = draft.card;
  if (card === undefined) return out.filter((s) => s.length > 0);
  switch (card.type) {
    case 'recap':
      out.push(
        card.title,
        ...card.lastNight.events.map((e) => e.label),
        ...(card.today ?? []).map((t) => t.label),
        ...card.photos.map((p) => p.alt),
      );
      break;
    case 'wrapped':
      out.push(
        card.title,
        ...card.totals.byCategory.map((c) => c.category),
        ...card.photos.map((p) => p.alt),
      );
      break;
    default:
      out.push(...cardTexts(card));
  }
  return out.filter((s) => s.length > 0);
}

function rewriteCard(
  card: RichCard,
  text: string,
  kept: readonly string[],
  wrapped: WrappedCard | undefined,
): RichCard {
  if (card.type === 'recap') {
    const roastLines = (card.roastLines ?? []).filter((l) => kept.includes(l));
    return { ...card, fallbackText: text, roastLines };
  }
  if (card.type === 'wrapped' && wrapped !== undefined) {
    return { ...wrapped, fallbackText: text };
  }
  return { ...card, fallbackText: text };
}

/** Same message with new text (card.fallbackText kept identical), `roast` per `roastFlag`. */
function withText(
  draft: OutboundMessage,
  text: string,
  kept: readonly string[],
  roastFlag: boolean,
  wrapped: WrappedCard | undefined,
): OutboundMessage {
  const { roast: _roast, card, ...rest } = draft;
  return {
    ...rest,
    text,
    ...(card !== undefined ? { card: rewriteCard(card, text, kept, wrapped) } : {}),
    ...(roastFlag ? { roast: true } : {}),
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
  const wrapped = draft.card?.type === 'wrapped' ? draft.card : undefined;
  if (lines.length === 0 && draft.roast !== true && wrapped === undefined) return draft;

  const groupBlock = groupRoastBlock(ctx.group, ctx.members, ctx.trip, ctx.now);

  if (lines.length === 0 && draft.roast === true) {
    // Flagged as roast but the lines are not identified: check the whole text, fail closed.
    for (const textLine of draft.text.split('\n')) {
      const c = checkRoastLine(textLine, draft, ctx, groupBlock);
      if (!c.ok && c.cause !== undefined) {
        out.push(suppression(c.cause, draft.id, c.detail));
        out.push(suppression('roast_unlocatable', draft.id));
        return null;
      }
    }
  }

  let text = draft.text;
  let changed = false;
  const kept: string[] = [];
  /** Set when a line is stripped for who it named; later nameless pronoun lines continue it. */
  let continuation: RoastCheck | null = null;
  for (const line of lines) {
    let check = checkRoastLine(line, draft, ctx, groupBlock);
    const names = namesAnyMember(line, ctx);
    if (check.ok && continuation !== null && !names && THIRD_PERSON_RE.test(normalizeText(line))) {
      // "he also tipped €0 every time" after the line naming him was stripped.
      check = continuation;
    }
    if (check.ok && kept.length >= MAX_ROAST_LINES_PER_MESSAGE) {
      check = { ok: false, cause: 'roast_line_limit' };
    }
    if (check.ok) {
      kept.push(line);
      if (names) continuation = null;
      continue;
    }
    if (check.cause !== undefined && TARGET_CAUSES.has(check.cause)) continuation = check;
    if (check.cause !== undefined) out.push(suppression(check.cause, draft.id, check.detail));
    const next = removeLine(text, line);
    if (next === null) {
      out.push(suppression('roast_unlocatable', draft.id));
      return null;
    }
    text = next;
    changed = true;
  }

  if (draft.roast === true || wrapped !== undefined) {
    // Card fields and alt text are sent too (SAFETY F1: every field of every
    // message). Roast material there (a blocklist topic, private data, a named
    // minor) cannot be stripped, so fail closed.
    for (const side of cardSideTexts(draft)) {
      const c = checkNeutralLine(side, ctx, 'minor');
      if (!c.ok && c.cause !== undefined) {
        out.push(suppression(c.cause, draft.id, c.detail));
        out.push(suppression('roast_unlocatable', draft.id));
        return null;
      }
    }
  }

  if (lines.length > 0 && draft.roast === true) {
    // Roast material the caller did not declare as a roast line (a blocklist
    // topic, private data, a named minor) means the lines are mislabelled:
    // we cannot strip what we cannot locate, so fail closed.
    let residual = text;
    for (const l of kept) residual = removeLine(residual, l) ?? residual;
    for (const textLine of residual.split('\n')) {
      const c = checkNeutralLine(textLine, ctx, 'minor');
      if (!c.ok && c.cause !== undefined) {
        out.push(suppression(c.cause, draft.id, c.detail));
        out.push(suppression('roast_unlocatable', draft.id));
        return null;
      }
    }
  }

  let wrappedOut = wrapped;
  if (wrapped !== undefined) {
    const w = screenWrapped(wrapped, text, draft.id, ctx, out);
    if (w === null) return null;
    if (w.changed) {
      text = w.text;
      wrappedOut = w.card;
      changed = true;
    }
  }

  if (!changed) return draft;
  const cleaned = tidy(text);
  if (cleaned.length === 0) return null;
  const roastFlag = lines.length === 0 ? draft.roast === true : kept.length > 0;
  return withText(draft, cleaned, kept, roastFlag, wrappedOut);
}

// ---------- restricted content ----------

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
  const recipient = draft.to.kind === 'member' ? draft.to.memberId : undefined;
  const recipientMember =
    recipient !== undefined ? ctx.members.find((m) => m.memberId === recipient) : undefined;
  // An unknown recipient is treated as a possible minor (fail closed).
  const recipientIsMinor =
    recipient !== undefined && (recipientMember === undefined || isMinor(recipientMember, ctx.now));

  const tagSet = new Set<ContentTag>(ctx.contentTags ?? []);
  // Keyword backstop on messages that can carry a suggestion or highlight.
  // Ledger records (logged expenses, receipts, settle-ups, tickets) state facts an
  // adult already created; SAFETY §2.7 rule 4 keeps that spend as plain numbers.
  // Anything addressed to a minor is scanned whatever the card type (VOICE §8:
  // "never in the minor's DM").
  if (draft.card === undefined || !LEDGER_CARD_TYPES.has(draft.card.type) || recipientIsMinor) {
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
  if (recipientIsMinor) {
    // Never in a minor's DM, whatever was asked.
    out.push(suppression(contentCause(restricted), draft.id, detail));
    return null;
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
  // The reply must not fold a minor into the plan ("for Dad and Lily: the bar",
  // "for the adults and the kid: the bar"). Naming a minor to keep them OFF it
  // is fine ("Lily's not on this one", "kids stay at the villa", VOICE §8).
  const minorIncluded =
    ctx.members.some(
      (m) =>
        m.active &&
        m.leftAt === undefined &&
        isMinor(m, ctx.now) &&
        namedAsIncluded(draft.text, m.displayName),
    ) ||
    (groupHasMinor(ctx.members, ctx.now) && minorReferentIncluded(draft.text));
  if (minorIncluded) {
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

  // 2. Roast lines, Wrapped awards and stats.
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
