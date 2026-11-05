/**
 * Deterministic guardrail refusals that do not need the model (T-017):
 *
 * - VOICE §4.12 D: "what did Sam's card get charged" ⇒ that's Sam's. The
 *   group lane never answers about another member's card, email or bank;
 *   the answer comes from the rule, so no prompt ever carries the question.
 * - VOICE §4.12 C / §8 / SAFETY §2.7 rule 1: in family mode, a request for
 *   nightlife or alcohol whose audience includes the minor (or names no
 *   adult-only audience) gets the family options from the trip plan plus
 *   "@ me separately and i'll keep Lily off that plan". An adult asking for a
 *   named adult-only audience ("dad and i want a quiet bar after lily's
 *   asleep") is not intercepted: that goes on to the model and the screen.
 */
import type { Activity, ContentTag, Group, IsoDateTime, Member, Trip } from '@trav/core';
import { formatTime, parseIso, safety } from '@trav/core';
import { sanitizeInline } from '../context/groupContext.js';
import { commandText } from '../settings/parse.js';
import { keepMinorOffText, privateDataRefusalText } from '../settings/text.js';

// ---------- someone else's private data (VOICE §4.12 D) ----------

/**
 * Things only their owner sees. A member's budget lives in their private
 * memory ("keep my share under 80 a day", told to Trav in a DM), so "what's
 * dad's daily budget" is someone else's private data too.
 */
const PRIVATE_NOUNS = String.raw`(?:card|cards|credit card|debit card|bank|bank account|account|statement|statements|email|emails|inbox|transactions?|charges?|venmo|card charges?|purchases|budget|budgets|spending limit|limit)`;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * A question or a reveal request: a clause that opens with a question word or
 * a "show me" verb ("what did Sam's card get charged", "show me sam's pending
 * charges", "..., and what's henry's budget"), or a message with a "?".
 * "i paid €84 on Jordan's card" and "it went on Dean's card" are statements.
 */
const REVEAL_CLAUSE =
  /(?:^|[,.;:!?]\s*|\b(?:and|also|so|but|then|plus|or|like)\s+)(?:(?:pls|please|hey|ok|okay|wait|yo)\s+)?(?:(?:can|could|will|would) (?:you|u)\s+)?(?:what|what's|whats|how|show|tell|give|reveal|see|look|check|read|list|pull|open|share|send|dig|did|does|do|has|have|is|was|were|any|who|where|which|when|why)\b/u;

/** An amount ("€200", "84 euros"). */
const AMOUNT =
  /(?:[€$£¥]\s?\d|\d(?:[\d,.]*\d)?\s?(?:€|eur|euros?|usd|dollars?|bucks|gbp|pounds?|quid)(?![\p{L}]))/u;

/** A payer or split instruction: what a logged expense carries. */
const PAYER_OR_SPLIT =
  /\b(?:split|splitting|paid|pay|paying|put|went on|goes on|go on|charged? (?:it|to|on)|covered|covering|cover|owe|owes|log|add|each|ways|between)\b/u;

/** The thing asked about is a booking Trav made, which the group already sees (receipt, audit). */
const BOOKING =
  /\b(?:tickets?|booking|bookings|booked|reservations?|flights?|deposit|lodging|airbnb|hotel booking)\b/u;

/** A payment put on a card: "it went on Dean's card", "put it on jordan's card". */
const PAID_ON_CARD =
  /\b(?:paid|put(?: it)?|went|goes|go|charged(?: it)?|was charged)\s+(?:\p{L}+\s+){0,3}?on\s+\p{L}[\p{L}-]*'s\s+(?:credit\s+|debit\s+)?card\b/u;

/** "did sam's card go through for the tickets": whether a booking charge worked. */
const WENT_THROUGH =
  /^(?:what\s+)?(?:did|has|have)\s+\p{L}[\p{L}-]*'s\s+(?:credit\s+|debit\s+)?card\s+(?:go|gone|get|got)\s+(?:through|charged|declined|approved)\s+for\s+(?:the|our|my|his|her|their)\s+[^,;.?!]{1,40}\??$/u;

/** "besides the tickets", "anything else": asks about the rest of the private data. */
const EXCLUSION =
  /\b(?:besides|except|apart from|other than|aside from|else|anything|everything|all|outside of)\b/u;

/**
 * Group facts that can be "pending" for someone (T-112 r1 #1-2): a booking
 * approval or vote, and the tab itself: settle-up, a transfer, a payment, a
 * share, a split, who owes what ("is sam's transfer to dean still pending",
 * "what's left pending for sam to pay", "is sam's share of dinner pending").
 */
const GROUP_PENDING =
  /\b(?:approv\w*|proposals?|votes?|rsvps?|settle(?:[- ]?ups?|ments?|d|s)?|settling|transfers?|payments?|pay|pays|paying|paid|repay\w*|owe|owes|owed|owing|shares?|splits?|split|tab|ious?|venmo request|reimburse\w*)\b/u;

/**
 * An exclusion that scopes a private remainder ("besides the tickets",
 * "anything else", "other than the approval"). A bare "anything/everything/
 * all" ("is anything pending for sam to approve?", "everything ok?") does not.
 */
const SCOPED_EXCLUSION =
  /\b(?:besides|except|apart from|other than|aside from|outside of|on top of)\b|\b(?:anything|everything|what|something|stuff|all) else\b/u;

const PENDING_WORD = String.raw`(?:pending|unconfirmed|unshared|waiting (?:on|for) (?:a |their |his |her )?(?:taps?|👍|confirm\w*|thumbs? up))`;

/** What a pending private item is called. */
const ITEM_NOUN = String.raw`(?:charges?|items?|receipts?|stuff|things?|emails?|transactions?|purchases?|anything|something|cards? charges?)`;

/**
 * Someone else's pending private items, asked any way (T-112, SAFETY §2.3
 * "even a count is the owner's"). Each shape names exactly whose items they
 * are, so the subject is the possessor or the "for X" target, never a name
 * that merely sits near the word "pending":
 *   "what's pending for sam", "anything pending from Sam?"
 *   "sam's pending stuff", "2 of sam's charges are pending"
 *   "summarize the charges sam has pending", "does sam have anything unconfirmed"
 *   "is sam waiting on a tap for anything"
 */
function pendingAbout(t: string, name: string): boolean {
  const n = String.raw`(?<![\p{L}])${name}(?![\p{L}'])`;
  const ns = String.raw`(?<![\p{L}])${name}'s`;
  const p = PENDING_WORD;
  return [
    // "pending for sam" (the target directly after the preposition, not "sam's X")
    String.raw`\b${p}\b[^.?!;]{0,40}?\b(?:for|of|from|by|on)\s+${n}`,
    // "what's pending on sam's end" (T-112 r2 #2)
    String.raw`\b${p}\b[^.?!;]{0,40}?\b(?:for|of|from|by|on)\s+${ns}\s+(?:end|side|stuff|account|thread|list|queue)\b`,
    // "how many pending items does sam have" (T-112 r2 #3)
    String.raw`\b${p}\s+${ITEM_NOUN}\s+(?:do|does|did)\s+${n}\s+(?:still\s+)?have\b`,
    // "sam's pending charges", "sam's unconfirmed stuff"
    String.raw`${ns}\s+(?:\p{L}+\s+){0,1}?${p}(?:\s+${ITEM_NOUN})?(?![\p{L}])`,
    // "sam's charges are pending", "2 of sam's receipts still waiting on a tap"
    String.raw`${ns}\s+(?:\p{L}+\s+){0,1}?${ITEM_NOUN}\s+(?:\p{L}+\s+){0,3}?${p}`,
    // "the charges sam has pending", "does sam have anything unconfirmed"
    String.raw`${n}\s+(?:still\s+)?(?:has|have|had|got|is holding|keeps?)\s+(?:[\p{L}\d]+\s+){0,3}?${p}`,
    // "is sam waiting on a tap"
    String.raw`${n}\s+(?:is\s+|still\s+)*waiting (?:on|for) (?:a |their |his |her )?(?:taps?|👍|confirm\w*|thumbs? up)`,
  ].some((re) => new RegExp(re, 'u').test(t));
}

/** "...for the late-night kebabs": the message names something already on the tab. */
function mentionsTabItem(t: string, tabItems: readonly string[]): boolean {
  return tabItems.some((d) => {
    const item = d.toLowerCase().replace(/\s+/gu, ' ').trim();
    if (item.length < 3) return false;
    return new RegExp(String.raw`(?<![\p{L}])${escapeRe(item)}(?![\p{L}])`, 'u').test(t);
  });
}

/**
 * The member whose private data the message asks about, if any: "what did
 * Sam's card get charged", "what's on Jordan's statement", "what did Sam spend
 * on his card", "what's dad's daily budget". Only questions or reveal requests
 * count. Never fired for an expense being logged ("i paid €84 for dinner on
 * Jordan's card, split with everyone": an amount plus a payer or split
 * instruction) or for a booking or tab item ("did sam's card go through for
 * the tickets?": the booking is a group fact). The sender's own data is not
 * "someone else's".
 */
export function privateDataSubject(
  text: string,
  members: readonly Member[],
  me: Member,
  /** Descriptions of what is on the trip's tab (a group fact, so asking about one is not private). */
  tabItems: readonly string[] = [],
): Member | undefined {
  const t = commandText(text);
  const question = text.includes('?') || REVEAL_CLAUSE.test(t);
  // Fails closed: any mention of another member's private data is refused
  // unless it is plainly an expense statement or the one booking question.
  // A statement ("i paid €84 for dinner on Jordan's card, split with
  // everyone") carries an amount plus a payer or split instruction, or puts a
  // payment on the card; it is never a question.
  if (!question && (AMOUNT.test(t) || PAID_ON_CARD.test(t)) && PAYER_OR_SPLIT.test(t)) {
    return undefined;
  }
  // "did sam's card go through for the tickets?": only that shape, about a
  // booking or a tab item, and never "besides / except / what else".
  if (
    WENT_THROUGH.test(t) &&
    !EXCLUSION.test(t) &&
    (BOOKING.test(t) || mentionsTabItem(t, tabItems))
  ) {
    return undefined;
  }
  for (const m of members) {
    if (m.memberId === me.memberId) continue;
    const name = escapeRe(m.displayName.toLowerCase());
    const possessive = new RegExp(
      String.raw`(?<![\p{L}])${name}'s\s+(?:\p{L}+\s+){0,2}?${PRIVATE_NOUNS}(?![\p{L}])`,
      'u',
    );
    const spent = new RegExp(
      String.raw`(?<![\p{L}])${name}\s+(?:spend|spent|buy|bought|charge|charged|pay|paid)\b.*\bon\s+(?:his|her|their)\s+(?:card|account)\b`,
      'u',
    );
    if (possessive.test(t) || spent.test(t)) return m;
    // A booking, an approval or the tab waiting on them is a group fact;
    // anything else pending for another member is theirs ("besides the
    // tickets" / "anything else" never exempts). The group-fact word must sit
    // in the same clause as the pending question (T-112 r2 #1): "what's
    // pending for sam and what's my share" is still about Sam's items.
    const groupFact = (s: string): boolean =>
      (BOOKING.test(s) || GROUP_PENDING.test(s) || mentionsTabItem(s, tabItems)) &&
      !SCOPED_EXCLUSION.test(t);
    const clauses = t.split(/[,;.?!]+|\s+(?:and|but|also|plus|like)\s+/u);
    const hits = clauses.filter((c) => pendingAbout(c, name));
    if (hits.some((c) => !groupFact(c))) return m;
    // A pending question that spans clauses: the whole message decides.
    if (hits.length === 0 && pendingAbout(t, name) && !groupFact(t)) return m;
  }
  return undefined;
}

export function privateDataRefusal(subject: Member): string {
  return privateDataRefusalText(subject.displayName);
}

// ---------- nightlife with a minor (VOICE §4.12 C) ----------

const ASK_WORDS =
  /\?|\b(?:book|get|find|any|suggest|recommend|recs?|ideas?|where|what'?s good|take|bring|go to|going to|hit|plan|options?)\b/u;

/**
 * A spend or tab question ("how much did we spend at the bar?", "what do we
 * owe for the casino"): money already on the tab, answered from the ledger,
 * never a nightlife suggestion. "how much does the club cost" is a plan ask
 * and is still intercepted.
 */
const SPEND_QUESTION =
  /^(?:how much (?:did|have|has|had|do|does) (?:we|i|you|they|\p{L}+) (?:spend|spent|pay|paid|put|drop|dropped|blow|blew|owe)\b|what (?:do|did|does) (?:we|i|\p{L}+) owe\b|what'?s (?:on )?the tab\b)/u;

/**
 * Anything beyond the one ledger question: a plan or ask word, a second
 * clause, or "tonight". Any of these and the intercept still runs.
 */
const BEYOND_SPEND =
  /\b(?:any|find|book|get|suggest|recommend|recs?|ideas?|where|tonight|tomorrow|take|bring|go|going|hit|plan|options?|also|and|then|plus|open|run|start)\b|[,;:]|\?\s*\S/u;

function isOnlySpendQuestion(t: string): boolean {
  return SPEND_QUESTION.test(t) && !BEYOND_SPEND.test(t);
}

const ADULTS_PHRASE =
  /\b(?:just|only) (?:the )?(?:adults|grown[- ]?ups|parents)\b|\bfor the (?:adults|grown[- ]?ups|parents)\b|\badults?[- ]only\b|\bwe'?re both (?:18|21)\+?/u;

const WHOLE_GROUP =
  /\b(?:all of us|everyone|everybody|whole family|the family|all (?:four|five|six|three) of us|the (?:two|three|four|five|six) of us|\d+ of us|(?:two|three|four|five|six) of us|all of you|the kids?)\b/u;

const SELF_WORDS = /\b(?:i|me|we'?re both|both of us|the two of us)\b/u;

function minorExcluded(t: string, name: string): boolean {
  const n = escapeRe(name.toLowerCase());
  return new RegExp(
    String.raw`\b(?:after|once|while|when)\s+${n}(?:'s|\s+is|\s+goes)?\s+(?:asleep|in bed|sleeping|gone to bed|goes to bed|to bed|down)\b|\bwithout\s+${n}\b|\b${n}(?:'s|\s+is)?\s+(?:staying|stays)\b|\bnot\s+${n}\b|\bminus\s+${n}\b`,
    'u',
  ).test(t);
}

/**
 * Who an explicit adult-only request is for, or undefined when the message
 * does not name an adult-only audience (SAFETY §2.7 rule 1: the reply must
 * name it). Fails closed: any inclusive mention of a minor, or of the whole
 * group, means it is not adult-only.
 */
export function explicitAdultAudience(
  text: string,
  members: readonly Member[],
  me: Member,
  now: IsoDateTime,
): readonly Member[] | undefined {
  const t = commandText(text);
  const active = members.filter((m) => m.active && m.role !== 'guest');
  const minors = active.filter((m) => safety.isMinor(m, now));
  const adults = active.filter((m) => !safety.isMinor(m, now));
  for (const m of minors) {
    if (safety.mentionsName(t, m.displayName) && !minorExcluded(t, m.displayName)) return undefined;
  }
  if (safety.minorReferentIncluded(t) || WHOLE_GROUP.test(t)) return undefined;
  if (ADULTS_PHRASE.test(t)) return adults;
  const named = adults.filter(
    (a) => a.memberId !== me.memberId && safety.mentionsName(t, a.displayName),
  );
  if (named.length === 0 || !SELF_WORDS.test(t)) return undefined;
  return [me, ...named.filter((a) => a.memberId !== me.memberId)];
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

function familySafe(a: Activity, minors: readonly Member[], now: IsoDateTime): boolean {
  if (a.kind === 'nightlife') return false;
  if (safety.isRestrictedContent(a.contentTags)) return false;
  if (safety.isRestrictedText(`${a.name} ${a.venue ?? ''}`)) return false;
  if (a.ageRestriction !== null) {
    for (const m of minors) {
      const age = safety.ageOn(m, now);
      if (age === undefined || age < a.ageRestriction) return false;
    }
  }
  return true;
}

export interface MinorNightlifeRefusal {
  readonly text: string;
  readonly cause: 'minor_nightlife' | 'minor_alcohol';
  readonly tags: readonly ContentTag[];
}

/**
 * VOICE §4.12 C for a family-mode group lane: undefined unless the message
 * asks for restricted content (nightlife, bars, alcohol, 18+/21+, gambling)
 * and names no adult-only audience.
 */
export function minorNightlifeRefusal(input: {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly activities: readonly Activity[];
  readonly me: Member;
  readonly text: string;
  readonly now: IsoDateTime;
}): MinorNightlifeRefusal | undefined {
  const { group, members, trip, me, now } = input;
  if (!safety.isFamilyMode(group, members, now)) return undefined;
  const t = commandText(input.text);
  const tags = safety.detectContentTags(t);
  if (!safety.isRestrictedContent(tags)) return undefined;
  if (!ASK_WORDS.test(`${t}${input.text.includes('?') ? '?' : ''}`)) return undefined;
  // "how much did we spend at the bar?" is about money already on the tab, not a plan.
  // Only when the whole message is that one question (fails closed otherwise).
  if (isOnlySpendQuestion(t)) return undefined;
  if (explicitAdultAudience(input.text, members, me, now) !== undefined) return undefined;

  const active = members.filter((m) => m.active && m.role !== 'guest');
  const minors = active.filter((m) => safety.isMinor(m, now));
  const tz = trip?.timeZone;
  const options =
    tz === undefined
      ? []
      : input.activities
          .filter((a) => a.startsAt !== undefined && parseIso(a.startsAt) >= parseIso(now))
          .filter((a) => familySafe(a, minors, now))
          .sort((a, b) => parseIso(a.startsAt!) - parseIso(b.startsAt!))
          .slice(0, 2)
          .map((a) => `${sanitizeInline(a.name, 40)} ${formatTime(a.startsAt!, tz, now)}`);
  const who = `the ${countWord(active.length)} of you`;
  const first =
    options.length > 0
      ? `for ${who}: ${options.join(', or ')}`
      : `nothing on the plan for ${who} that fits yet`;
  const names = minors.map((m) => m.displayName);
  const alcoholOnly = tags.includes('alcohol') && !tags.some((x) => x !== 'alcohol');
  return {
    text: `${first}\n${keepMinorOffText(names.length > 0 ? names : ['the kids'])}`,
    cause: alcoholOnly ? 'minor_alcohol' : 'minor_nightlife',
    tags,
  };
}
