/**
 * Pure UI logic (no React, no DOM): who may press which button, bubble runs,
 * timestamp separators, mention splitting, avatar colors. Unit-tested in
 * logic.test.ts.
 */
import { formatClockTime, formatDate, parseIso, tripDayNumber } from '@trav/core';
import type { Action, RichCard } from '@trav/core';
import type { SimGroup, SimMember, ThreadEntry, ThreadMessage } from '../shared/types.js';

/** VOICE §9.2: Trav's avatar. */
export const TRAV_TEAL = '#1C8C7A';

const PASTELS = [
  '#F6C6A8',
  '#B9D7F7',
  '#C8E6C0',
  '#F3C1D9',
  '#D9CCF5',
  '#F7E3A1',
  '#BFE3E0',
  '#F2C9C1',
];

export function avatarColor(group: SimGroup, handle: string): string {
  const i = group.members.findIndex((m) => m.handle === handle);
  return PASTELS[(i < 0 ? 0 : i) % PASTELS.length]!;
}

/** Avatar label. Pass the group's names so two single-name members sharing an initial get two letters ("Ch", "Cr"). */
export function initials(name: string, groupNames: readonly string[] = []): string {
  const parts = name.trim().split(/\s+/);
  const label = parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
  if (parts.length > 1 || label === '') return label;
  const clash = groupNames.some(
    (n) => n.trim() !== name.trim() && n.trim()[0]?.toUpperCase() === label,
  );
  return clash ? label + (parts[0]![1]?.toLowerCase() ?? '') : label;
}

export interface ButtonPlan {
  /** Buttons this member may press now. */
  readonly buttons: readonly Action[];
  /** Shown instead of buttons when the card is live but this member can't act ("waiting on Dean"). */
  readonly waitingOn?: string;
}

/** Who may trigger an action: `allowedMemberIds`, else any charged member (proposals), else anyone who sees it. */
export function mayAct(action: Action, card: RichCard | undefined, me: SimMember): boolean {
  if (action.allowedMemberIds) return action.allowedMemberIds.includes(me.memberId);
  if (card?.type === 'booking_proposal')
    return card.charged.some((c) => c.memberId === me.memberId);
  return true;
}

function names(ids: readonly string[], group: SimGroup): string[] {
  return ids.map((id) => group.members.find((m) => m.memberId === id)?.name ?? id);
}

function waitingLabel(list: readonly string[]): string {
  if (list.length <= 2) return `waiting on ${list.join(' or ')}`;
  return `waiting on ${list.slice(0, 2).join(', ')} +${list.length - 2}`;
}

/**
 * Who a live proposal is waiting on, consistent with `mayAct`: the approvers
 * who are also charged (the ones who get buttons). An any-one proposal under
 * the cap lists the whole group as approvers, but "waiting on Dean, Henry +4"
 * shown to Henry (who is out tonight) would name someone with no button.
 * Falls back to every approver if none of them is charged.
 */
function proposalWaitingOn(card: RichCard | undefined): readonly string[] {
  if (card?.type !== 'booking_proposal') return [];
  const approvers = card.policy.requiresApprovalFrom;
  const charged = new Set(card.charged.map((c) => c.memberId));
  const both = approvers.filter((id) => charged.has(id));
  return both.length > 0 ? both : approvers;
}

/** VOICE §9.3: buttons appear only for members allowed to act; others see "waiting on Dean". */
export function planButtons(msg: ThreadMessage, me: SimMember, group: SimGroup): ButtonPlan {
  const live = new Set(msg.cardState?.liveActionIds ?? msg.actions.map((a) => a.id));
  const liveActions = msg.actions.filter((a) => live.has(a.id));
  if (liveActions.length === 0) return { buttons: [] };
  const buttons = liveActions.filter((a) => mayAct(a, msg.card, me));
  if (buttons.length > 0) return { buttons };
  const primary = liveActions.find((a) => a.style === 'primary') ?? liveActions[0]!;
  const allowed = primary.allowedMemberIds ?? proposalWaitingOn(msg.card);
  return allowed.length > 0
    ? { buttons: [], waitingOn: waitingLabel(names(allowed, group)) }
    : { buttons: [] };
}

/** True if this message starts a run (name label shown) / ends one (avatar shown). */
export interface RunInfo {
  readonly first: boolean;
  readonly last: boolean;
  /** Timestamp separator text before this entry, if any. */
  readonly separator?: string;
}

const RUN_GAP_MS = 15 * 60_000;

export function separatorLabel(at: string, group: SimGroup): string {
  const day = tripDayNumber(at, group.tripStart, group.timeZone);
  const base = `${formatDate(at, group.timeZone)} · ${formatClockTime(at, group.timeZone)}`;
  return day > 0 ? `${base} · day ${day}` : base;
}

/** Bubble runs and 15-minute timestamp separators (VOICE §9.2). */
export function layoutThread(entries: readonly ThreadEntry[], group: SimGroup): RunInfo[] {
  return entries.map((e, i) => {
    const prev = entries[i - 1];
    const next = entries[i + 1];
    const gapBefore = prev === undefined || parseIso(e.at) - parseIso(prev.at) > RUN_GAP_MS;
    const gapAfter = next === undefined || parseIso(next.at) - parseIso(e.at) > RUN_GAP_MS;
    const sameAsPrev =
      !gapBefore && prev?.kind === 'message' && e.kind === 'message' && prev.from === e.from;
    const sameAsNext =
      !gapAfter && next?.kind === 'message' && e.kind === 'message' && next.from === e.from;
    return {
      first: !sameAsPrev,
      last: !sameAsNext,
      ...(gapBefore ? { separator: separatorLabel(e.at, group) } : {}),
    };
  });
}

export interface TextPart {
  readonly text: string;
  readonly mention: boolean;
}

/** Splits `@trav` / `@Dean` mentions out so they render blue (VOICE §9.2). */
export function splitMentions(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = /@[A-Za-z][\w-]*/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const before = m.index === 0 ? '' : text[m.index - 1]!;
    if (before !== '' && /[\w]/.test(before)) continue; // an email address, not a mention
    if (m.index > last) parts.push({ text: text.slice(last, m.index), mention: false });
    parts.push({ text: m[0], mention: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: false });
  return parts;
}

/** `sat mar 14 · 9:40pm · day 3` for the top bar (VOICE §9.1); `· trip over` after the last day. */
export function clockLabel(now: string, group: SimGroup): string {
  const day = tripDayNumber(now, group.tripStart, group.timeZone);
  const last = tripDayNumber(`${group.tripEnd}T12:00:00Z`, group.tripStart, 'UTC');
  if (day > last) {
    return `${formatDate(now, group.timeZone)} · ${formatClockTime(now, group.timeZone)} · trip over`;
  }
  return separatorLabel(now, group);
}

/** Tapback picker set (VOICE §9.2). */
export const TAPBACKS = ['❤️', '👍', '👎', '😂', '‼️', '❓'] as const;
