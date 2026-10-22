/**
 * Safety predicates, the outbound screen and the voice linter (T-028;
 * docs/SAFETY.md §2.7–2.8, docs/VOICE.md §1/§3). Pure. `screenOutbound` is the
 * ONE place minors/roast rules are enforced on outgoing text; the agent's
 * single send path (`packages/agent/src/outbound/send.ts`) calls it on every message.
 */
import type { IsoDateTime, MemberId } from '../primitives.js';
import type { Group, Member } from '../domain/group.js';
import type { ContentTag, Trip } from '../domain/trip.js';
import type { ConsentLookup } from '../domain/consent.js';
import type { Outbound } from '../cards.js';
import { notImplemented } from '../errors.js';

export const RESTRICTED_TAGS: readonly ContentTag[] = [
  'nightlife',
  'club',
  'bar',
  'alcohol',
  '18+',
  '21+',
  'gambling',
  'cannabis',
  'adult',
];

/** birthDate set and age < 18, or ageBand === 'under18'. Unknown age ⇒ false (but roast stays blocked). */
export function isMinor(member: Member, now: IsoDateTime): boolean {
  return notImplemented(`isMinor(${member.memberId}, ${now})`);
}

export function groupHasMinor(members: readonly Member[], now: IsoDateTime): boolean {
  return notImplemented(`groupHasMinor(${members.length}, ${now})`);
}

/** True if any member's age is unknown and the group has not confirmed everyone is 18+. */
export function groupAgeUnconfirmed(group: Group, members: readonly Member[]): boolean {
  return notImplemented(`groupAgeUnconfirmed(${group.groupId}, ${members.length})`);
}

export function audienceIncludesMinor(
  audience: readonly MemberId[],
  members: readonly Member[],
  now: IsoDateTime,
): boolean {
  return notImplemented(`audienceIncludesMinor(${audience.length}, ${members.length}, ${now})`);
}

export function isRestrictedContent(tags: readonly ContentTag[]): boolean {
  return notImplemented(`isRestrictedContent(${tags.length})`);
}

/** Family mode: derived from members, or forced in settings (VOICE §8). */
export function isFamilyMode(group: Group, members: readonly Member[], now: IsoDateTime): boolean {
  return notImplemented(`isFamilyMode(${group.groupId}, ${members.length}, ${now})`);
}

// ---------- roast gate 1 (deterministic) ----------

export type RoastBlockCause =
  | 'mode_off'
  | 'minor_in_group'
  | 'age_unconfirmed'
  | 'member_opted_out'
  | 'target_not_member'
  | 'target_inactive'
  | 'trip_over';

export type RoastGate =
  { readonly allowed: true } | { readonly allowed: false; readonly cause: RoastBlockCause };

export function roastAllowed(
  group: Group,
  members: readonly Member[],
  target: Member,
  consent: ConsentLookup,
  trip: Trip | null,
  now: IsoDateTime,
): RoastGate {
  return notImplemented(
    `roastAllowed(${group.groupId}, ${members.length}, ${target.memberId}, ${typeof consent}, ${trip?.tripId ?? ''}, ${now})`,
  );
}

export type RoastTopicCategory =
  | 'body'
  | 'romance'
  | 'outsider'
  | 'protected_trait'
  | 'health'
  | 'intoxication'
  | 'hardship'
  | 'legal'
  | 'minor'
  | 'left_member'
  | 'private_data';

/** Deterministic blocklist (fixtures/roast/blocklist.json) over a draft roast line. */
export function roastTopicBlocked(
  line: string,
  blocklist: readonly { readonly term: string; readonly category: RoastTopicCategory }[],
): RoastTopicCategory | null {
  return notImplemented(`roastTopicBlocked(${line.length}, ${blocklist.length})`);
}

// ---------- outbound screen ----------

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
}

export type SuppressionCause =
  | 'minor_nightlife'
  | 'minor_alcohol'
  | 'age_restricted'
  | 'roast_mode_off'
  | 'roast_minor_in_group'
  | 'roast_member_opted_out'
  | 'roast_topic_blocked'
  | 'dm_only_card_in_group'
  | 'private_card_in_group';

export interface ScreenResult {
  /** The message to send (roast lines stripped, `roast` cleared) or null if fully suppressed. */
  readonly outbound: Outbound | null;
  /** Each becomes a `content.suppressed` / `roast.suppressed` audit event. */
  readonly suppressed: readonly { readonly cause: SuppressionCause; readonly detail?: string }[];
}

/** Runs on EVERY Trav message before it is sent (SAFETY F1). */
export function screenOutbound(draft: Outbound, ctx: ScreenContext): ScreenResult {
  return notImplemented(`screenOutbound(${draft.id}, ${ctx.now})`);
}

// ---------- voice linter (VOICE §1, §3) ----------

export const BANNED_PHRASES: readonly string[] = [
  'certainly',
  'great question',
  "i'd be happy to",
  'please note',
  'kindly',
  'unfortunately',
  'apologies for the inconvenience',
  'feel free to',
  'as an ai',
  'assist',
  'at this time',
  'rest assured',
];

export const ALLOWED_EMOJI: readonly string[] = [
  '✅',
  '🎟️',
  '☀️',
  '💸',
  '📸',
  '✈️',
  '🏠',
  '🎉',
  '👀',
  '🏆',
];

export type MessageKind =
  'reply' | 'proposal' | 'expense' | 'recap' | 'settle_up' | 'wrapped' | 'error' | 'refusal' | 'dm';

export interface LintViolation {
  readonly rule:
    | 'banned_phrase'
    | 'exclamation'
    | 'emoji_count'
    | 'emoji_set'
    | 'markdown'
    | 'uppercase_start'
    | 'too_long'
    | 'too_many_lines'
    | 'raw_money';
  readonly detail: string;
}

export interface LintResult {
  readonly ok: boolean;
  readonly violations: readonly LintViolation[];
}

export function lintVoice(text: string, kind: MessageKind): LintResult {
  return notImplemented(`lintVoice(${text.length}, ${kind})`);
}
