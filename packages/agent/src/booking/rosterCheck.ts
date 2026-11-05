/**
 * T-198 (QA-03): the "who's in? i've got … 👍 if that's right, or tell me who
 * to swap" question (VOICE §4.11 A) is a promise that a 👍 does something.
 * When `propose_booking` stops on that question, the loop keeps the ask
 * here, keyed by the question's message id. The asker's 👍 (tapback, or a
 * "yes" that quotes the question or comes inside the reply window; inside
 * the window also a short "yep" / "that's right" / "correct",
 * `isRosterConfirmText`) runs the same ask again with exactly the people the
 * question listed.
 *
 * The re-run carries no auto-buy verdict (that comes only from the member's
 * own words, D-044), so `ApprovalPolicy` has no ask to buy on and always
 * fires C1: the answer is an options card or a proposal card that needs its
 * own 👍, never a purchase (SAFETY §2.1). A 👎 drops the check and asks who's
 * going. A stale check says so instead of going quiet. Rules only.
 */
import type { GroupId, IsoDateTime, MemberId, MessageId, OptionsCard, TripId } from '@trav/core';
import { parseIso } from '@trav/core';
import { stripInvisible } from '../untrusted.js';
import type { ProposeInput } from './proposals.js';

/** Same window as a proposal's hold (VOICE §6.4): after it the 👍 answers with the stale line. */
export const ROSTER_CHECK_TTL_MS = 15 * 60 * 1000;
/** Checks kept at once (oldest dropped first); the loop's memory stays bounded. */
export const ROSTER_CHECK_CAP = 50;

export const ROSTER_CHECK_STALE_TEXT =
  "that ask timed out, nothing's booked. @ me if you still want it";
export const ROSTER_CHECK_DECLINED_TEXT = "ok, nothing's booked. who's going?";
/** The re-run still can't tell who's in (the roster moved under it): say so once, no second 👍 ask. */
export const ROSTER_CHECK_STUCK_TEXT =
  "still can't line up who's going, nothing's booked. @ me with the names";

export interface RosterCheck {
  /** The "who's in?" message (what a 👍 lands on). */
  readonly messageId: MessageId;
  readonly groupId: GroupId;
  readonly tripId: TripId | null;
  /** Only the asker's 👍 confirms; anyone else's is ignored like a non-approver's (VOICE §6.2). */
  readonly askedBy: MemberId;
  readonly input: ProposeInput;
  /** Who the question listed, in member order. Never empty. */
  readonly attendees: readonly MemberId[];
  readonly askedAt: IsoDateTime;
}

export function rosterCheckLive(check: Pick<RosterCheck, 'askedAt'>, now: IsoDateTime): boolean {
  const age = parseIso(now) - parseIso(check.askedAt);
  return age >= 0 && age <= ROSTER_CHECK_TTL_MS;
}

/**
 * The ask with the confirmed party: exactly the listed people, by id, and
 * nothing that would re-open the question (names, exclusions, a headcount
 * that disagreed). Everything else the member asked for (venue, night,
 * tier, time, add-on) is kept as it was.
 */
export function confirmedRosterInput(
  input: ProposeInput,
  attendees: readonly MemberId[],
): ProposeInput {
  const {
    attendeeNames: _names,
    excludedNames: _excludedNames,
    excludedMemberIds: _excludedIds,
    attendeeMemberIds: _ids,
    quantity: _quantity,
    ...rest
  } = input;
  return { ...rest, attendeeMemberIds: [...attendees], quantity: attendees.length };
}

export interface RosterCheckStore {
  save(check: RosterCheck): void;
  get(messageId: MessageId): RosterCheck | undefined;
  /** Removes and returns it: one 👍 answers a check once (a double tap proposes nothing twice). */
  take(messageId: MessageId): RosterCheck | undefined;
  /** The newest check in a group (any asker). */
  latest(groupId: GroupId): RosterCheck | undefined;
}

export function createRosterCheckStore(cap = ROSTER_CHECK_CAP): RosterCheckStore {
  const byId = new Map<MessageId, RosterCheck>();
  return {
    save(check) {
      byId.delete(check.messageId);
      byId.set(check.messageId, check);
      while (byId.size > Math.max(1, cap)) {
        const oldest = byId.keys().next().value;
        if (oldest === undefined) break;
        byId.delete(oldest);
      }
    },
    get: (messageId) => byId.get(messageId),
    take(messageId) {
      const c = byId.get(messageId);
      byId.delete(messageId);
      return c;
    },
    latest(groupId) {
      let found: RosterCheck | undefined;
      for (const c of byId.values()) if (c.groupId === groupId) found = c;
      return found;
    },
  };
}

/**
 * Short "that list is right" replies (T-198 r2 #6): "yep", "that's right",
 * "correct", "yep thats right", "yes that's everyone". Read ONLY as the asker's
 * answer to their own live "who's in?" check (the loop binds it there and
 * nowhere else); it is never a booking approval (VOICE §6.2's exact list stays
 * exact). Anything with another word ("yep but not chase") is not this.
 */
const CONFIRM_PHRASE =
  "(?:yes|yep|yup|yeah|yea|ya|yess+|ok|okay|correct|right|exactly|perfect|sounds good|looks good|looks right|all good|that'?s right|that'?s correct|that'?s it|that'?s everyone|that'?s all|that'?s us|that'?s the list|all of us|👍)";
const ROSTER_CONFIRM = new RegExp(`^${CONFIRM_PHRASE}(?:[ ,]+${CONFIRM_PHRASE})*$`, 'u');
const WARM_EMOJI = /[🙏🎉🙌🔥💯😊✅]/gu;

export function isRosterConfirmText(text: string): boolean {
  const t = stripInvisible(text)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/(^|[^\w@])@trav(?![\w-])\s*[,:]?/g, ' ')
    .replace(WARM_EMOJI, ' ')
    .replace(/[.!]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length === 0 || t.length > 40) return false;
  return ROSTER_CONFIRM.test(t);
}

/**
 * "1 or 2", "1, 2 or 3" for an options card with `count` options (VOICE §4.1
 * E); `from` starts the list later ("2 or 3" for the flight card's "(or 2 or 3)").
 */
export function optionNumbers(count: number, from = 1): string {
  const n = Math.max(from, Math.floor(count));
  const nums = Array.from({ length: n - from + 1 }, (_, i) => String(i + from));
  if (nums.length === 1) return nums[0]!;
  return `${nums.slice(0, -1).join(', ')} or ${nums[nums.length - 1]!}`;
}

/** How a card is picked: a tap or a bare number, or "@trav book option N" (flights, T-074). */
export type OptionsPickStyle = 'tap_or_number' | 'book_option';

/**
 * Read from the card itself (r2 #4): a pick action with number aliases
 * ("1", "2") takes a tap or a bare number; one without (the group flight
 * card) is picked by "@trav book option N".
 */
export function optionsPickStyle(card: Pick<OptionsCard, 'pickAction'>): OptionsPickStyle {
  return card.pickAction.textAliases.length > 0 ? 'tap_or_number' : 'book_option';
}

/**
 * The one line for a 👍 (or "yes") on an options card with no pick in it
 * (QA-03): which number. A "book option" card gets its own instruction line,
 * word for word (VOICE §4.1 D: `say "@trav book option 1" (or 2 or 3). nothing's
 * booked yet`). Nothing is booked by it.
 */
export function whichOptionText(style: OptionsPickStyle, count: number): string {
  if (style === 'book_option') {
    const or = count > 1 ? ` (or ${optionNumbers(count, 2)})` : '';
    return `say "@trav book option 1"${or}. nothing's booked yet`;
  }
  return count > 1
    ? `which one? tap it or reply ${optionNumbers(count)}. nothing's booked yet`
    : "tap it or reply 1 and i'll take it from there. nothing's booked yet";
}
