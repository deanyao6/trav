/**
 * T-182: what counts as an approval, decided in code from a whitelist (D-042).
 *
 * A proposal is approved only by:
 *  - a 👍 tapback on that proposal's card, or a tap on its Approve button, or
 *  - a reply that, normalized (case, curly quotes, whitespace, trailing
 *    punctuation, a few warm emoji, a leading "@trav"/"trav,"), is exactly one
 *    of `APPROVE_REPLIES`, bound to that proposal (quote-reply on its card,
 *    Trav's question inside the reply window, or the sender's own single
 *    pending proposal). Binding is `normalizeApprovalEvent`'s job.
 *
 * Anything else is not an approval: negations ("i don't approve"), qualified
 * yeses ("yes but not for me"), approvals for someone else ("approve for him",
 * "i approve for me and henry"), sarcasm ("oh yeah sure"), and a quoted or
 * forwarded old "yes". Where it helps, Trav asks back instead (`nearMissKind`).
 */
import { stripInvisible } from '../untrusted.js';

export type ApprovalReplyIntent = 'approve' | 'decline' | 'not_me';

/** Exact approval replies (VOICE §6.2), after `normalizeApprovalReply`. */
export const APPROVE_REPLIES: readonly string[] = [
  'yes',
  'yep',
  'go',
  'book it',
  'do it',
  'approve',
  'approved',
  'i approve',
  'yes book it',
  'yes do it',
  'yep book it',
  'yep do it',
  'yes please',
  'yes pls',
  '👍',
];
export const DECLINE_REPLIES: readonly string[] = ['no', 'nah', 'cancel', 'drop it', '👎'];
export const NOT_ME_REPLIES: readonly string[] = ['not me', "i'm out", 'im out', 'without me'];

/** The words on a card's actions (`Action.textAliases`): the replies minus the tapback glyphs. */
const words = (replies: readonly string[]): readonly string[] =>
  replies.filter((r) => r !== '👍' && r !== '👎');
export const APPROVE_TEXT_ALIASES: readonly string[] = words(APPROVE_REPLIES);
export const DECLINE_TEXT_ALIASES: readonly string[] = words(DECLINE_REPLIES);
export const NOT_ME_TEXT_ALIASES: readonly string[] = words(NOT_ME_REPLIES);

/**
 * Emoji a reply may end with and still be exact ("yes 🙏", "book it 🎉").
 * Laughing, winking, eye-roll and the like can mean "not really", so they are
 * not here and keep the reply from matching.
 */
const WARM_EMOJI = /(?:🙏|🎉|🙌|🔥|💯|😊|✅|👍|👎)$/u;
const EMOJI_VARIANTS = /\p{Emoji_Modifier}|\u{FE0E}|\u{FE0F}/gu;
/** Marks a reply whose emoji contradict its words, so it matches nothing. */
const MIXED = '(mixed)';

/**
 * The reply as the whitelist compares it. Quote marks, ">" and "fwd:" are
 * kept on purpose, so a quoted or forwarded "yes" never equals "yes".
 */
export function normalizeApprovalReply(text: string): string {
  let t = fold(stripInvisible(text).replace(EMOJI_VARIANTS, ''))
    .replace(/\s+/g, ' ')
    .replace(/^[\s(]+/u, '')
    .replace(/^@trav\s*[,:]?\s*/, '')
    .replace(/^(?:hey |ok |okay |yeah )?trav\s*[,:]\s*/, '')
    .replace(/^trav\s+/, '')
    .trim();
  // Trailing punctuation and warm emoji, in any order: "yes!! 🙏", "book it 🎉.".
  const stripped: string[] = [];
  for (;;) {
    t = t.replace(/[\s!.,;:)]+$/u, '');
    const e = WARM_EMOJI.exec(t);
    if (e === null) break;
    stripped.push(e[0]);
    t = t.slice(0, e.index);
  }
  // A reply that is only emoji is a 👍 or a 👎 when every one of them is that one.
  if (t.length === 0) {
    const first = stripped[0];
    return (first === '👍' || first === '👎') && stripped.every((e) => e === first) ? first : '';
  }
  // A thumb that contradicts the words ("yes 👎", "no 👍") is no exact reply.
  const thumbs = new Set(stripped.filter((e) => e === '👍' || e === '👎'));
  if (thumbs.size > 1) return `${t} ${MIXED}`;
  if (thumbs.has('👎') && APPROVE_REPLIES.includes(t)) return `${t} ${MIXED}`;
  if (thumbs.has('👍') && !APPROVE_REPLIES.includes(t)) return `${t} ${MIXED}`;
  return t;
}

/** Lowercase, accents dropped, curly quotes straightened (as `foldText` in `booking/request.ts`). */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").toLowerCase();
}

/** The whitelist: which reply this is, or undefined for anything that is not exactly one. */
export function approvalReplyIntent(text: string): ApprovalReplyIntent | undefined {
  const t = normalizeApprovalReply(text);
  if (t.length === 0 || t.length > 20) return undefined;
  if (APPROVE_REPLIES.includes(t)) return 'approve';
  if (DECLINE_REPLIES.includes(t)) return 'decline';
  if (NOT_ME_REPLIES.includes(t)) return 'not_me';
  return undefined;
}

export interface ApprovalAttempt {
  readonly via: 'button' | 'reaction' | 'text';
  readonly intent: ApprovalReplyIntent;
  /** The message text for `text`; ignored for taps and tapbacks. */
  readonly text: string;
  /** The channel says the message was forwarded (an old "yes" from somewhere else). */
  readonly forwarded?: boolean;
}

/**
 * Does this attempt count as an approval of the proposal it is bound to? A
 * tap or a 👍 always does (the gate and the handler decide who may approve);
 * a text approval only when it is exactly a whitelisted reply and was not
 * forwarded. Declines and opt-outs never spend, so they are not gated here.
 */
export function approvalCounts(a: ApprovalAttempt): boolean {
  if (a.intent !== 'approve') return false;
  if (a.via === 'button' || a.via === 'reaction') return true;
  if (a.forwarded === true) return false;
  return approvalReplyIntent(a.text) === 'approve';
}

/** Approval-shaped words: what makes a sentence a near miss worth a question back. */
const APPROVAL_WORD =
  /^(?:yes|yep|yeah|yea|ya|sure|ok|okay|approve|approved|approving|confirm|confirmed|go|ahead|book|do|it|👍)$/u;
/**
 * The only other words a near miss may have. A message with any word outside
 * this list (or a member's name) is something else and goes on to the rest of
 * the loop: a question back must never swallow a real request.
 */
const NEAR_MISS_WORDS: ReadonlySet<string> = new Set([
  'i',
  "i'll",
  'ill',
  "i'm",
  'im',
  'we',
  'you',
  'he',
  'she',
  'they',
  'it',
  'that',
  'this',
  'them',
  'him',
  'her',
  'me',
  'us',
  'my',
  'mine',
  'myself',
  'his',
  'their',
  'the',
  'a',
  'for',
  'to',
  'of',
  'on',
  'behalf',
  'all',
  'everyone',
  'everybody',
  'group',
  'both',
  'whole',
  'but',
  'and',
  'or',
  'not',
  'no',
  "don't",
  'dont',
  'do',
  "doesn't",
  'never',
  "won't",
  "can't",
  'cant',
  'oh',
  'lol',
  'jk',
  'haha',
  'maybe',
  'probably',
  'kinda',
  'think',
  'guess',
  'so',
  'wait',
  'hmm',
  'actually',
  'just',
  'really',
  'totally',
  'definitely',
  'yet',
  'then',
  'also',
  'too',
  'out',
  'without',
  'except',
  'only',
  'fine',
  'good',
  'cool',
  'great',
  'whatever',
  'right',
  'said',
  'says',
]);

export type NearMissKind = 'not_me' | 'decline' | 'generic';

/**
 * A short message that sounds like an answer to the card but isn't exactly
 * one ("yes but not for me", "i don't approve", "oh yeah sure", "approve for
 * him"): `not_me` when it sounds like the sender wants out, else `generic`.
 * Undefined for an exact reply, or anything with a word outside the
 * near-miss vocabulary (so a real request is never swallowed).
 */
export function nearMissKind(
  text: string,
  memberNames: readonly string[],
): NearMissKind | undefined {
  if (approvalReplyIntent(text) !== undefined) return undefined;
  const t = normalizeApprovalReply(text);
  if (t.length === 0 || t.length > 80) return undefined;
  const words = t
    .replace(/[,.;:!]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 10) return undefined;
  const names = new Set(memberNames.map((n) => fold(n).trim()).filter(Boolean));
  let approvalish = false;
  for (const w of words) {
    const bare = w.replace(/'s$/, '');
    // T-182 r1 #1: a member's name means a party edit ("book it for henry
    // too", "do it for me and chase only"), never a near miss to swallow.
    if (names.has(bare)) return undefined;
    if (APPROVAL_WORD.test(w)) {
      // "do" and "it" alone are not approval words: "do it" is, "book" too.
      if (w !== 'do' && w !== 'it') approvalish = true;
      continue;
    }
    if (NEAR_MISS_WORDS.has(w)) continue;
    return undefined;
  }
  if (/\bdo it\b/.test(t)) approvalish = true;
  if (!approvalish) return undefined;
  if (PARTY_EDIT.test(t)) return undefined;
  if (/\b(?:not|no)\b(?: for)? (?:me|myself)\b|\b(?:i'?m|im) out\b/.test(t)) {
    return 'not_me';
  }
  // T-182 r1 #5: "i don't approve", "no don't book it": a no, so the decline hint.
  if (NEGATED.test(t)) return 'decline';
  return 'generic';
}

/**
 * A change to who's going (T-182 r1 #1): "book me too", "book it for him
 * also", "book it without me", "except me", "only". These go on through the
 * loop (the roster and proposal flows) and never get a near-miss answer.
 */
const PARTY_EDIT =
  /\b(?:me|myself|him|her|them|us)\s+(?:too|also)\b|\b(?:also|too)\s+(?:me|myself)\b|\b(?:without|except|only)\b/;
/** A no in a near miss. */
const NEGATED = /\b(?:don'?t|dont|do not|doesn'?t|never|no|not|won'?t|can'?t|cant)\b/;

/** Trav's question back for a near miss or a non-whitelisted approval (VOICE §6.2). */
export function nearMissReply(kind: NearMissKind, forOthers = false): string {
  if (kind === 'not_me') return 'not booked. reply "not me" to drop out, or "yes" to book it';
  if (kind === 'decline') return 'not booked. reply "no" to drop it, or "yes" to book it';
  if (forOthers) return 'not booked. everyone approves for themselves: 👍 the card or reply "yes"';
  return 'not booked. 👍 the card or reply "yes" to book it';
}
