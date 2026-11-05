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
 * a SHA-256 of the address, so it holds no number in the clear. It outlives
 * "delete my data" on purpose: honoring an opt-out means remembering it.
 */
import { createHash } from 'node:crypto';
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

const DELETE_MY_DATA =
  /^(?:please )?(?:delete|erase|wipe|remove) (?:all )?(?:of )?my (?:data|info|stuff)(?: please)?$|^forget me$/;

// ---- user-facing text (VOICE §1: lowercase, short, no emoji in these) ----

export const STOP_DM_TEXT =
  "you're opted out, so i won't text you again. reply START to opt back in";
export const STOP_GROUP_TEXT =
  "got it, no more DMs from me and i'll ignore your messages here. reply START to undo";
export const START_TEXT = "you're back in. i'll text you again when there's something for you";
export const DELETED_TEXT =
  'done, i deleted your private data. your share of the group tab stays so the balances still add up';
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

export function optOutKey(address: string): string {
  const a = address.trim();
  const normalized = a.includes('@') ? a.toLowerCase() : a;
  return createHash('sha256').update(`trav-optout:${normalized}`).digest('hex');
}

export interface OptOutList {
  has(address: string): boolean;
  add(address: string, at: string): void;
  remove(address: string): void;
}

export function createOptOutList(stores: Stores): OptOutList {
  const runtime = stores.group.runtime;
  return {
    has: (address) => runtime.get(OPTOUT_NAMESPACE, null, optOutKey(address)) !== undefined,
    add(address, at) {
      runtime.put({
        namespace: OPTOUT_NAMESPACE,
        groupId: null,
        key: optOutKey(address),
        value: { at },
      });
    },
    remove(address) {
      runtime.delete(OPTOUT_NAMESPACE, null, optOutKey(address));
    },
  };
}

/** The sender of an event (a join/leave's participant counts as its sender). */
export function senderOf(event: InboundEvent): string {
  return 'sender' in event ? event.sender : event.participant.handle;
}
