/**
 * The turn-boundary failure lines (VOICE §4.10): a leaf module so both the
 * loop and the approval handler can say them without the handler importing
 * `loop.ts` (T-030 review note c). Two lines, no emoji, each says whether
 * money moved and what happens next.
 */

/** A turn that failed before anything was bought. */
export const TURN_FAILED_TEXT =
  "something went wrong on my end. no charge went through\n@ me again in a minute and i'll retry";

/** Same shape, for a turn that failed AFTER `booking.completed` was written: money did move. */
export const TURN_FAILED_AFTER_PURCHASE_TEXT =
  "something went wrong on my end after the purchase. the charge went through and the booking stands\n@ me in a minute and i'll sort out the receipt and tickets";

/** The auto-approve path could not hand the proposal to the approval handler; nothing was bought. */
export const AUTO_APPROVE_FAILED_TEXT =
  "couldn't complete that one. no charge went through\n@ me again in a minute and i'll retry";
