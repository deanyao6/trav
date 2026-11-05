/**
 * Server-level commands, answered before the agent sees the message (T-188):
 *
 * - **STOP** (US texting rules, docs/PRIVACY_TEXTING.md): opts the sender's
 *   number out. Trav sends one confirmation and then no more DMs to that
 *   number, and ignores what it sends, until it replies START. In a DM every
 *   standard opt-out word counts (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END,
 *   QUIT, OPT OUT, REVOKE). In the group only an unambiguous one counts as the
 *   whole message (STOP, STOPALL, UNSUBSCRIBE, OPT OUT), because "cancel" there
 *   declines a booking card (VOICE §6.2) and "stop roasting" is a setting.
 * - **START** / UNSTOP: opts back in (only intercepted while opted out).
 * - **"@trav delete my data"** (or "forget me"): deletes the sender's private
 *   partition in every group they are a member of (`PrivateStore.deletePartition`)
 *   and drops the agent's runtime state for them (`TravAgent.forgetRuntimeState`),
 *   audited as `data.deleted` with per-table counts. In the group it needs an
 *   @trav; in a DM it doesn't.
 *
 * The opt-out list is in `GroupStore.runtime` (`optout`, runtime-wide), keyed by
 * an HMAC-SHA256 of the address under a per-store secret (`optout_secret`), so
 * it holds no number in the clear and its keys can't be brute-forced from the
 * phone-number space without that secret. It outlives
 * "delete my data" on purpose: honoring an opt-out means remembering it.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { InboundEvent, InboundMessage } from '@trav/adapters';
import { normalizeReply } from '@trav/adapters';
import { detectMentionRules } from '@trav/agent';
import type { Stores } from '@trav/core';

export const OPTOUT_NAMESPACE = 'optout';

export const STOP_WORDS_DM: ReadonlySet<string> = new Set([
  'stop',
  'stopall',
  'stop all',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'opt out',
  'optout',
  'revoke',
]);
export const STOP_WORDS_GROUP: ReadonlySet<string> = new Set([
  'stop',
  'stopall',
  'stop all',
  'unsubscribe',
  'opt out',
  'optout',
]);
export const START_WORDS: ReadonlySet<string> = new Set(['start', 'unstop', 'resume']);

/**
 * Matched on `normalizeReply` text, which has the @trav / "trav," address
 * already stripped. Leading politeness ("hey", "pls", "can you", ...) and a
 * trailing "please" / "thanks" are allowed. Anything else around the ask
 * ("lol i should delete my data", "forget me after the trip") isn't a command.
 */
const FILLER =
  '(?:(?:hey|hi|yo|ok|okay|so|um|please|pls|plz|can you|could you|would you|will you|can u|could u|pls can you|please can you)\\s+)*';
const TRAILER = '(?:\\s+(?:please|pls|plz|thanks|thank you|thx|now|for me|asap))*';
const DELETE_MY_DATA = new RegExp(
  `^${FILLER}(?:(?:delete|erase|wipe|remove|clear) (?:(?:all|of|everything|any) )*my (?:data|info|information|stuff|details)|forget (?:about )?me|forget everything about me)${TRAILER}$`,
);

// ---- user-facing text (VOICE §1: lowercase, short, no emoji in these) ----

export const STOP_DM_TEXT =
  "you're opted out, so i won't text you again. reply START to opt back in";
export const STOP_GROUP_TEXT =
  "got it, no more DMs from me and i'll ignore your messages here. reply START to undo";
export const START_TEXT = "you're back in. i'll text you again when there's something for you";
export const DELETED_TEXT =
  'done, i deleted your private data. your share of the group tab stays so the balances still add up';
/**
 * r1 #3: nothing to delete (every count 0, a repeat or an empty partition):
 * no "done", no audit. Worded so it fits a first request too.
 */
export const ALREADY_DELETED_TEXT = "i don't have any private data of yours, nothing to delete";
/** A guest: no member rows, so no private partition (the audit log keeps who spoke, SAFETY §2.5). */
export const NOTHING_TO_DELETE_TEXT =
  "you're not a member here, so i have no private data of yours to delete";

export type ServerCommand =
  { readonly kind: 'stop' } | { readonly kind: 'start' } | { readonly kind: 'delete_my_data' };

/** The command a message is, if any. Pure. */
export function parseCommand(
  message: Pick<
    InboundMessage,
    'text' | 'lane' | 'platformMention' | 'receivedAt' | 'replyToMessageId'
  >,
  optedOut: boolean,
): ServerCommand | undefined {
  const words = normalizeReply(message.text);
  if (words.length === 0 || words.length > 40) return undefined;
  const stopWords = message.lane === 'dm' ? STOP_WORDS_DM : STOP_WORDS_GROUP;
  if (stopWords.has(words)) return optedOut ? undefined : { kind: 'stop' };
  if (START_WORDS.has(words)) return optedOut ? { kind: 'start' } : undefined;
  if (DELETE_MY_DATA.test(words)) {
    if (message.lane === 'dm') return { kind: 'delete_my_data' };
    const mention = detectMentionRules(message.text, {
      lane: 'group',
      repliesToTrav: false,
      platformMention: message.platformMention === true,
      now: message.receivedAt,
    });
    if (mention !== 'ambiguous' && mention.addressed && mention.reason !== 'thanks') {
      return { kind: 'delete_my_data' };
    }
  }
  return undefined;
}

/** Where the store's opt-out HMAC key lives (its own namespace; never logged, never listed with the opt-outs). */
export const OPTOUT_SECRET_NAMESPACE = 'optout_secret';
const OPTOUT_SECRET_KEY = 'v1';

/**
 * r1 #5 (SAFETY T19 / SC-6): the opt-out row key is an HMAC-SHA256 of the
 * address under a per-store secret, so a leaked list of keys can't be
 * brute-forced from the (small) space of phone numbers without the secret.
 */
export function optOutKey(address: string, secret: string): string {
  const a = address.trim();
  const normalized = a.includes('@') ? a.toLowerCase() : a;
  return createHmac('sha256', secret).update(`trav-optout:${normalized}`).digest('hex');
}

/** The store's opt-out secret, created on first use (32 random bytes) and kept with the store. */
export function optOutSecret(stores: Stores): string {
  const runtime = stores.group.runtime;
  const v = runtime.get(OPTOUT_SECRET_NAMESPACE, null, OPTOUT_SECRET_KEY)?.value as
    { readonly secret?: unknown } | undefined;
  if (typeof v?.secret === 'string' && /^[0-9a-f]{64}$/.test(v.secret)) return v.secret;
  const secret = randomBytes(32).toString('hex');
  runtime.put({
    namespace: OPTOUT_SECRET_NAMESPACE,
    groupId: null,
    key: OPTOUT_SECRET_KEY,
    value: { secret },
  });
  return secret;
}

export interface OptOutList {
  has(address: string): boolean;
  add(address: string, at: string): void;
  remove(address: string): void;
  /** The stored row key for an address (tests and audits; never logged). */
  keyOf(address: string): string;
}

export function createOptOutList(stores: Stores): OptOutList {
  const runtime = stores.group.runtime;
  const secret = optOutSecret(stores);
  const keyOf = (address: string): string => optOutKey(address, secret);
  return {
    keyOf,
    has: (address) => runtime.get(OPTOUT_NAMESPACE, null, keyOf(address)) !== undefined,
    add(address, at) {
      runtime.put({
        namespace: OPTOUT_NAMESPACE,
        groupId: null,
        key: keyOf(address),
        value: { at },
      });
    },
    remove(address) {
      runtime.delete(OPTOUT_NAMESPACE, null, keyOf(address));
    },
  };
}

/** The sender of an event (a join/leave's participant counts as its sender). */
export function senderOf(event: InboundEvent): string {
  return 'sender' in event ? event.sender : event.participant.handle;
}
