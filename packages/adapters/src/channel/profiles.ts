/**
 * Channel profiles (T-069): named capability sets the simulator channel can
 * run under, so the whole stack is exercised the way a real line behaves
 * without naming a vendor. Everything downstream decides from the individual
 * `ChannelCapabilities` flags (degrade by capability), never from the profile
 * id or `kind`.
 *
 * - `simulator`: the local iMessage-look web UI (cards, buttons, notices).
 * - `imessage_relay_group`: an all-iPhone group reached through a relay line
 *   (Photon, Linq, Sendblue, BlueBubbles): plain text plus images, tapbacks,
 *   threaded replies, typing and read receipts, member changes and renames.
 *   No buttons and no rich cards, so every approval is a 👍 tapback or a text
 *   reply (research/connectors.md "iMessage group access (2026-11-04)").
 * - `mixed_group_mms`: the same group after an Android member joined and it
 *   fell back to MMS: text and images only. No reactions, no renames, no
 *   member changes, no threaded replies, no typing or read receipts, so
 *   approvals are text-only ("reply \"yes\"", see `fallbackText.ts`).
 *
 * Both phone-number profiles still DM members 1:1 (a relay line can text a
 * member who has texted it first; T-070 owns that consent).
 */
import type { ChannelCapabilities } from '../interfaces/channel.js';

export type ChannelProfileId = 'simulator' | 'imessage_relay_group' | 'mixed_group_mms';

export const CHANNEL_PROFILE_IDS: readonly ChannelProfileId[] = [
  'simulator',
  'imessage_relay_group',
  'mixed_group_mms',
];

/** Capability flags of a profile; `kind` belongs to the adapter, not the profile. */
export type ChannelProfile = Omit<ChannelCapabilities, 'kind'>;

/** iMessage caps a group at 32 participants (Trav included). */
const IMESSAGE_MAX_GROUP = 32;

export const CHANNEL_PROFILES: Readonly<Record<ChannelProfileId, ChannelProfile>> = {
  simulator: {
    buttons: true,
    richCards: true,
    reactions: true,
    privateDm: true,
    threadedReplies: true,
    canAddMembers: true,
    systemNotices: true,
    seesAllGroupMessages: true,
    typingIndicator: true,
    readReceipts: false,
    canRenameGroup: true,
    groupTransport: 'imessage',
  },
  imessage_relay_group: {
    buttons: false,
    richCards: false,
    reactions: true,
    privateDm: true,
    threadedReplies: true,
    canAddMembers: true,
    systemNotices: false,
    seesAllGroupMessages: true,
    typingIndicator: true,
    readReceipts: true,
    canRenameGroup: true,
    groupTransport: 'imessage',
    maxGroupSize: IMESSAGE_MAX_GROUP,
  },
  mixed_group_mms: {
    buttons: false,
    richCards: false,
    reactions: false,
    privateDm: true,
    threadedReplies: false,
    canAddMembers: false,
    systemNotices: false,
    seesAllGroupMessages: true,
    typingIndicator: false,
    readReceipts: false,
    canRenameGroup: false,
    groupTransport: 'mms',
  },
};

export function isChannelProfileId(value: string): value is ChannelProfileId {
  return (CHANNEL_PROFILE_IDS as readonly string[]).includes(value);
}

/** A profile's flags; throws on an unknown id (programmer error). */
export function channelProfile(id: ChannelProfileId): ChannelProfile {
  const profile = CHANNEL_PROFILES[id];
  if (profile === undefined) throw new Error(`unknown channel profile ${String(id)}`);
  return profile;
}
