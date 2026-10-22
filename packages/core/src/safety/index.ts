/**
 * Safety predicates, the outbound screen and the voice linter (T-028;
 * docs/SAFETY.md §2.7–2.8, docs/VOICE.md §1/§3/§7/§8). Pure. `screenOutbound` is the
 * ONE place minors/roast rules are enforced on outgoing text; the agent's
 * single send path (`packages/agent/src/outbound/send.ts`) calls it on every message.
 *
 * - `minors.ts`: age predicates (the only place age is interpreted, D-012),
 *   restricted content tags and the SAFETY §2.7 rule-1 predicate.
 * - `roast.ts`: roast gate 1 (`roastAllowed`) and gate 2 (`roastTopicBlocked`).
 * - `screen.ts`: `screenOutbound` with audit-ready suppression records.
 * - `voice.ts`: `lintVoice` (VOICE §1, §3, §3.4).
 */
export {
  ADULT_AGE,
  BENIGN_PHRASES,
  CONTENT_TERMS,
  RESTRICTED_TAGS,
  ageOn,
  audienceIncludesMinor,
  detectContentTags,
  groupAgeUnconfirmed,
  groupHasMinor,
  isAgeUnknown,
  isConfirmedAdult,
  isFamilyMode,
  isMinor,
  isRestrictedContent,
  isRestrictedText,
  restrictedContentAllowed,
} from './minors.js';
export type { RestrictedContentInput } from './minors.js';

export {
  DEFAULT_ROAST_BLOCKLIST,
  ROAST_GRACE_DAYS,
  groupRoastBlock,
  roastAllowed,
  roastTopicBlocked,
  tripAllowsRoast,
} from './roast.js';
export type {
  RoastBlockCause,
  RoastBlocklistEntry,
  RoastGate,
  RoastTopicCategory,
} from './roast.js';

export { MAX_ROAST_LINES_PER_MESSAGE, cardTexts, screenOutbound } from './screen.js';
export type { ScreenContext, ScreenResult, Suppression, SuppressionCause } from './screen.js';

export {
  ALLOWED_EMOJI,
  BANNED_PHRASES,
  DEFAULT_PROPER_NOUNS,
  KIND_LIMITS,
  TAPBACK_GLYPHS,
  extractEmoji,
  lintVoice,
} from './voice.js';
export type { KindLimits, LintOptions, LintResult, LintViolation, MessageKind } from './voice.js';
