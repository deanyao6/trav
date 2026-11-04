/**
 * Builds the UI payload (`SimState`) from the simulator channel's transcript.
 * Pure: everything it needs is passed in.
 *
 * Privacy (CLAUDE.md §2, VOICE §5 card invariants): the group thread is built
 * only from group-lane entries of that group's conversation, and any message
 * whose card is DM-only (`ticket`, private `expense_confirm`, or a digest with
 * a private item) is dropped even if a backend somehow recorded it there. DM
 * threads keep only cards addressed to that member. The raw `outbound`
 * envelope is never copied into the payload.
 */
import { isDmOnlyCard } from '@trav/adapters';
import type { TranscriptEntry, TranscriptMessage } from '@trav/adapters';
import { parseIso } from '@trav/core';
import type { Action, ActionId, IsoDateTime, MemberId, RichCard } from '@trav/core';
import type {
  BackendKind,
  CardStateView,
  GroupView,
  IntakeOffer,
  ReactionSummary,
  SimControls,
  SimGroup,
  SimMember,
  SimState,
  ThreadEntry,
  ThreadMessage,
} from '../shared/types.js';

/** Tapbacks that mean approve / decline on a proposal (VOICE §3.6). */
const APPROVE_REACTIONS = new Set(['👍', 'like']);
const DECLINE_REACTIONS = new Set(['👎', 'dislike']);

/** True if this card must never appear in a group thread. */
export function isPrivateCard(card: RichCard): boolean {
  return isDmOnlyCard(card);
}

/** True if a DM-lane card may be shown in `memberId`'s private thread. */
export function cardVisibleTo(card: RichCard, memberId: MemberId): boolean {
  if (card.type === 'ticket') return card.deliveredTo === memberId;
  if (card.type === 'expense_confirm') {
    const items = [card, ...(card.digestItems ?? [])];
    return items.every((i) => i.visibility !== 'private' || i.paidBy === memberId);
  }
  return true;
}

interface Taps {
  readonly byMessage: Map<
    string,
    { handle: string; actionId: string; value?: string; at: string; seq: number }[]
  >;
  readonly reactions: Map<
    string,
    { handle: string; reaction: string; removed: boolean; at: string; seq: number }[]
  >;
}

function collectInteractions(entries: readonly TranscriptEntry[]): Taps {
  const byMessage: Taps['byMessage'] = new Map();
  const reactions: Taps['reactions'] = new Map();
  for (const e of entries) {
    if (e.type === 'button_tap') {
      const list = byMessage.get(e.cardMessageId) ?? [];
      list.push({
        handle: e.from,
        actionId: e.actionId,
        ...(e.value !== undefined ? { value: e.value } : {}),
        at: e.at,
        seq: e.seq,
      });
      byMessage.set(e.cardMessageId, list);
    } else if (e.type === 'reaction') {
      const list = reactions.get(e.targetMessageId) ?? [];
      list.push({
        handle: e.from,
        reaction: e.reaction,
        removed: e.removed,
        at: e.at,
        seq: e.seq,
      });
      reactions.set(e.targetMessageId, list);
    }
  }
  return { byMessage, reactions };
}

/** Current (not removed) reactions on a message, grouped by emoji. */
export function summarizeReactions(
  list: readonly { handle: string; reaction: string; removed: boolean }[] | undefined,
): ReactionSummary[] {
  if (!list) return [];
  const current = new Map<string, string[]>();
  for (const r of list) {
    const by = current.get(r.reaction) ?? [];
    const without = by.filter((h) => h !== r.handle);
    if (r.removed) current.set(r.reaction, without);
    else current.set(r.reaction, [...without, r.handle]);
  }
  return [...current.entries()]
    .filter(([, by]) => by.length > 0)
    .map(([reaction, by]) => ({ reaction, count: by.length, by }));
}

interface DeriveContext {
  readonly now: IsoDateTime;
  readonly memberByHandle: ReadonlyMap<string, SimMember>;
  /** Every message in the group's view (both lanes) in transcript order. */
  readonly messages: readonly TranscriptMessage[];
  readonly taps: Taps;
}

function nameOfHandle(ctx: DeriveContext, handle: string): string {
  return ctx.memberByHandle.get(handle)?.name ?? handle;
}

function liveIds(actions: readonly Action[], card: RichCard): ActionId[] {
  const ids = actions.map((a) => a.id);
  if (card.type === 'options' && !ids.includes(card.pickAction.id)) ids.push(card.pickAction.id);
  return ids;
}

function deriveProposalState(msg: TranscriptMessage, ctx: DeriveContext): CardStateView {
  const card = msg.card;
  if (card?.type !== 'booking_proposal') throw new Error('not a proposal');
  const approvers = new Set(card.policy.requiresApprovalFrom);
  const isApprover = (handle: string): boolean => {
    const m = ctx.memberByHandle.get(handle);
    return m !== undefined && approvers.has(m.memberId);
  };
  const taps = ctx.taps.byMessage.get(msg.messageId) ?? [];
  const reacts = (ctx.taps.reactions.get(msg.messageId) ?? []).filter((r) => !r.removed);
  const later = ctx.messages.filter((m) => m.seq > msg.seq && m.card !== undefined);
  const receipt = later.find(
    (m) => m.card?.type === 'receipt' && m.card.proposalId === card.proposalId,
  );
  // The approval that booked it: the earliest approving tap or tapback before
  // the receipt. A late Approve (a no-op on a done proposal) never relabels it.
  const before = (s: { seq: number }): boolean => receipt === undefined || s.seq < receipt.seq;
  const approveSignal = [
    ...taps.filter((t) => t.actionId === 'approve' && isApprover(t.handle)),
    ...reacts.filter((r) => APPROVE_REACTIONS.has(r.reaction) && isApprover(r.handle)),
  ]
    .filter(before)
    .sort((a, b) => a.seq - b.seq)[0];
  if (receipt) {
    const who = approveSignal
      ? nameOfHandle(ctx, approveSignal.handle)
      : (card.approvedBy ?? [])
          .map((id) => [...ctx.memberByHandle.values()].find((m) => m.memberId === id)?.name ?? id)
          .join(', ');
    return {
      status: 'approved',
      label: who ? `Approved by ${who}` : 'Approved',
      at: approveSignal?.at ?? receipt.at,
      liveActionIds: [],
    };
  }
  if (card.status !== 'pending') {
    return { status: card.status, label: capitalize(card.status), liveActionIds: [] };
  }
  const decline =
    taps.find((t) => t.actionId === 'decline' && isApprover(t.handle)) ??
    reacts.find((r) => DECLINE_REACTIONS.has(r.reaction) && isApprover(r.handle));
  if (decline) {
    return {
      status: 'declined',
      label: `Declined by ${nameOfHandle(ctx, decline.handle)}`,
      at: decline.at,
      liveActionIds: [],
    };
  }
  const charged = new Set(card.charged.map((c) => c.memberId));
  const notMe = taps.find(
    (t) => t.actionId === 'not_me' && charged.has(ctx.memberByHandle.get(t.handle)?.memberId ?? ''),
  );
  const superseding = later.find((m) => m.card?.type === 'booking_proposal');
  if (notMe && superseding) {
    return {
      status: 'superseded',
      label: `Replaced · ${nameOfHandle(ctx, notMe.handle)} is out`,
      at: superseding.at,
      liveActionIds: [],
    };
  }
  // A booking that failed, expired or was dropped: Trav's line quote-replies
  // the card, so the buttons go dead instead of looking like a slow Approve.
  const ended = ctx.messages.find(
    (m) =>
      m.seq > msg.seq &&
      m.direction === 'outbound' &&
      m.card === undefined &&
      m.replyToMessageId === msg.messageId,
  );
  if (ended) {
    return { ...terminalReplyState(ended.text), at: ended.at, liveActionIds: [] };
  }
  if (parseIso(ctx.now) > parseIso(card.holdExpiresAt)) {
    return { status: 'expired', label: 'Expired', at: card.holdExpiresAt, liveActionIds: [] };
  }
  return { status: 'pending', liveActionIds: liveIds(msg.actions, card) };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * The state a Trav line that quote-replies a proposal card leaves it in
 * (T-019-b review note, T-009): the approval handler replies to the card with
 * its terminal lines only (VOICE §4.10 "couldn't book … no charge went
 * through", §6.4 "… proposal expired, no charge", "dropped …"), never with a
 * partial-grant line, so any card-less reply from Trav ends the card. The one
 * terminal line that is not a failure is the post-purchase fallback ("the
 * charge went through and the booking stands", `TURN_FAILED_AFTER_PURCHASE_TEXT`):
 * money moved, so the card reads "Booked · receipt pending", never "no charge".
 */
export function terminalReplyState(text: string): Pick<CardStateView, 'status' | 'label'> {
  if (/\bno charge\b/i.test(text)) {
    if (/\bexpired\b/i.test(text)) return { status: 'expired', label: 'Expired' };
    if (/^dropped\b/i.test(text)) return { status: 'declined', label: 'Declined' };
    return { status: 'failed', label: 'Failed · no charge' };
  }
  if (/\bcharge went through\b|\bbooking stands\b/i.test(text)) {
    return { status: 'booked', label: 'Booked · receipt pending' };
  }
  if (/\bexpired\b/i.test(text)) return { status: 'expired', label: 'Expired' };
  if (/^dropped\b/i.test(text)) return { status: 'declined', label: 'Declined' };
  return { status: 'failed', label: 'Failed' };
}

function deriveGenericState(msg: TranscriptMessage, ctx: DeriveContext): CardStateView | undefined {
  const card = msg.card;
  if (!card) return undefined;
  const actions = liveIds(msg.actions, card);
  if (card.type === 'options' && card.status !== 'pending') {
    return { status: card.status, label: capitalize(card.status), liveActionIds: [] };
  }
  if (actions.length === 0) return undefined;
  const taps = ctx.taps.byMessage.get(msg.messageId) ?? [];
  // Settle-up "paid" toggles are per transfer and stay live.
  if (card.type === 'settle_up') return { status: 'open', liveActionIds: actions };
  const first = taps[0];
  if (!first) return { status: 'pending', liveActionIds: actions };
  const who = nameOfHandle(ctx, first.handle);
  if (card.type === 'options' && first.actionId === 'pick') {
    const opt = card.options.find((o) => o.id === first.value);
    return {
      status: 'picked',
      label: `${who} picked option ${opt?.index ?? first.value ?? ''}`.trim(),
      at: first.at,
      liveActionIds: [],
    };
  }
  const action = msg.actions.find((a) => a.id === first.actionId);
  return {
    status: 'resolved',
    label: `${action?.label ?? first.actionId} · ${who}`,
    at: first.at,
    liveActionIds: [],
  };
}

function toThreadMessage(
  msg: TranscriptMessage,
  ctx: DeriveContext,
  travHandle: string,
): ThreadMessage {
  const cardState = msg.card
    ? msg.card.type === 'booking_proposal'
      ? deriveProposalState(msg, ctx)
      : deriveGenericState(msg, ctx)
    : undefined;
  return {
    kind: 'message',
    seq: msg.seq,
    at: msg.at,
    lane: msg.lane,
    messageId: msg.messageId,
    direction: msg.direction,
    from: msg.from,
    fromName: msg.from === travHandle ? 'Trav' : msg.fromName,
    isTrav: msg.from === travHandle,
    text: msg.text,
    ...(msg.card ? { card: msg.card } : {}),
    actions: msg.actions,
    attachments: msg.attachments.map((a) => ({
      kind: a.kind,
      mimeType: a.mimeType,
      uri: a.uri,
      ...(a.alt !== undefined ? { alt: a.alt } : {}),
    })),
    ...(msg.replyToMessageId !== undefined ? { replyToMessageId: msg.replyToMessageId } : {}),
    renderedAsCard: msg.renderedAsCard,
    degraded: msg.degraded,
    reactions: summarizeReactions(ctx.taps.reactions.get(msg.messageId)),
    ...(cardState ? { cardState } : {}),
  };
}

export interface ChannelView {
  readonly travHandle: string;
  groupTranscript(conversationId: string): readonly TranscriptEntry[];
  dmTranscript(handle: string): readonly TranscriptEntry[];
}

/** The group thread: group-lane entries of this conversation, DM-only cards removed. */
export function buildGroupThread(
  group: SimGroup,
  channel: ChannelView,
  now: IsoDateTime,
): ThreadEntry[] {
  const raw = channel
    .groupTranscript(group.conversationId)
    .filter((e) => e.lane === 'group' && e.conversationId === group.conversationId);
  return buildEntries(
    raw,
    group,
    channel.travHandle,
    now,
    (m) => !m.card || !isPrivateCard(m.card),
  );
}

/** One member's private thread with Trav, limited to this group's messages and cards addressed to them. */
export function buildDmThread(
  group: SimGroup,
  member: SimMember,
  channel: ChannelView,
  now: IsoDateTime,
): ThreadEntry[] {
  const raw = channel.dmTranscript(member.handle).filter((e) => {
    if (e.lane !== 'dm') return false;
    if (e.type !== 'message' || e.direction !== 'outbound') return true;
    return e.outbound === undefined || e.outbound.groupId === group.groupId;
  });
  return buildEntries(
    raw,
    group,
    channel.travHandle,
    now,
    (m) => !m.card || cardVisibleTo(m.card, member.memberId),
  );
}

function buildEntries(
  raw: readonly TranscriptEntry[],
  group: SimGroup,
  travHandle: string,
  now: IsoDateTime,
  keep: (m: TranscriptMessage) => boolean,
): ThreadEntry[] {
  const messages = raw.filter((e): e is TranscriptMessage => e.type === 'message' && keep(e));
  const ctx: DeriveContext = {
    now,
    memberByHandle: new Map(group.members.map((m) => [m.handle, m])),
    messages,
    taps: collectInteractions(raw),
  };
  const kept = new Set(messages);
  const out: ThreadEntry[] = [];
  for (const e of raw) {
    if (e.type === 'message') {
      if (kept.has(e)) out.push(toThreadMessage(e, ctx, travHandle));
    } else if (e.type === 'member_joined' || e.type === 'member_left') {
      out.push({
        kind: 'membership',
        seq: e.seq,
        at: e.at,
        type: e.type,
        handle: e.handle,
        name: e.name,
      });
    }
    // Reactions and taps are folded into their target message.
  }
  return out;
}

export interface BuildStateInput {
  readonly version: number;
  readonly backend: BackendKind;
  readonly offline: boolean;
  readonly now: IsoDateTime;
  readonly groups: readonly SimGroup[];
  readonly channel: ChannelView;
  readonly typing: ReadonlySet<string>;
  readonly lastError?: string;
  /** Muted status line per groupId (`GroupView.status`). */
  readonly status?: ReadonlyMap<string, string>;
  /** Demo documents still to feed, per groupId then memberId. */
  readonly intake?: ReadonlyMap<string, Readonly<Record<MemberId, readonly IntakeOffer[]>>>;
  /** Default: no clock, no intake, no reset, no replay. */
  readonly controls?: SimControls;
}

export const NO_CONTROLS: SimControls = {
  clock: false,
  scheduler: false,
  intake: false,
  reset: false,
  replay: false,
};

export interface GroupExtras {
  readonly status?: string;
  readonly intake?: Readonly<Record<MemberId, readonly IntakeOffer[]>>;
}

export function buildGroupView(
  group: SimGroup,
  channel: ChannelView,
  now: IsoDateTime,
  typing: boolean,
  extras: GroupExtras = {},
): GroupView {
  const thread = buildGroupThread(group, channel, now);
  const dms: Record<MemberId, ThreadEntry[]> = {};
  const intake: Record<MemberId, readonly IntakeOffer[]> = {};
  for (const m of group.members) {
    dms[m.memberId] = buildDmThread(group, m, channel, now);
    intake[m.memberId] = extras.intake?.[m.memberId] ?? [];
  }
  const last = [...thread].reverse().find((e): e is ThreadMessage => e.kind === 'message');
  return {
    group,
    thread,
    dms,
    typing,
    intake,
    ...(extras.status !== undefined ? { status: extras.status } : {}),
    ...(last
      ? {
          preview: {
            fromName: last.fromName,
            text: last.card ? last.card.title : (last.text.split('\n')[0] ?? ''),
            at: last.at,
          },
        }
      : {}),
  };
}

export function buildState(input: BuildStateInput): SimState {
  return {
    version: input.version,
    backend: input.backend,
    offline: input.offline,
    now: input.now,
    travHandle: input.channel.travHandle,
    groups: input.groups.map((g) => {
      const status = input.status?.get(g.groupId);
      const intake = input.intake?.get(g.groupId);
      return buildGroupView(g, input.channel, input.now, input.typing.has(g.groupId), {
        ...(status !== undefined ? { status } : {}),
        ...(intake !== undefined ? { intake } : {}),
      });
    }),
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
    controls: input.controls ?? NO_CONTROLS,
  };
}
