/**
 * Wire types shared by the simulator server and the browser UI. Type-only:
 * nothing here may import Node or DOM APIs (both tsconfigs include this file).
 *
 * The UI only ever sees `SimState`, which the server builds from the channel
 * transcript (`server/state.ts`). The group thread in it is filtered
 * server-side: no `ticket` card and no private `expense_confirm` card can be
 * in `GroupView.thread`, whatever the backend sent.
 */
import type { Action, ActionId, IsoDate, IsoDateTime, MemberId, RichCard } from '@trav/core';

export type BackendKind = 'scripted' | 'agent';

export interface SimMember {
  readonly memberId: MemberId;
  readonly groupId: string;
  /** Channel handle (the identity the simulator channel authenticates). */
  readonly handle: string;
  readonly name: string;
}

/** A one-tap demo line shown above the composer ("send as" member says this). */
export interface SimHint {
  readonly from: string;
  readonly text: string;
}

export interface SimGroup {
  readonly groupId: string;
  readonly conversationId: string;
  /** Chat name as the group set it ("barcelona 🇪🇸"). */
  readonly name: string;
  readonly tripName: string;
  readonly timeZone: string;
  readonly tripStart: IsoDate;
  /** Last trip day (local). "end of trip" jumps to 10am the day after (Wrapped time). */
  readonly tripEnd: IsoDate;
  /** In group member order (VOICE §3.5). */
  readonly members: readonly SimMember[];
  readonly hints: readonly SimHint[];
}

export interface ReactionSummary {
  readonly reaction: string;
  readonly count: number;
  /** Handles, in the order they reacted. */
  readonly by: readonly string[];
}

/** Derived, display-only state of a card (status chip, which buttons are still live). */
export interface CardStateView {
  readonly status: string;
  /** "Approved by Dean", "Declined by Dean", "Expired", "Picked option 2". */
  readonly label?: string;
  readonly at?: IsoDateTime;
  /** Action ids that still work. Empty once the card is resolved. */
  readonly liveActionIds: readonly ActionId[];
}

export interface AttachmentView {
  readonly kind: string;
  readonly mimeType: string;
  readonly uri: string;
  readonly alt?: string;
}

export interface ThreadMessage {
  readonly kind: 'message';
  readonly seq: number;
  readonly at: IsoDateTime;
  readonly lane: 'group' | 'dm';
  readonly messageId: string;
  readonly direction: 'inbound' | 'outbound';
  /** Sender handle (Trav's handle for outbound). */
  readonly from: string;
  readonly fromName: string;
  readonly isTrav: boolean;
  readonly text: string;
  readonly card?: RichCard;
  readonly actions: readonly Action[];
  readonly attachments: readonly AttachmentView[];
  readonly replyToMessageId?: string;
  readonly renderedAsCard: boolean;
  readonly degraded: boolean;
  readonly reactions: readonly ReactionSummary[];
  readonly cardState?: CardStateView;
}

export interface ThreadMembership {
  readonly kind: 'membership';
  readonly seq: number;
  readonly at: IsoDateTime;
  readonly type: 'member_joined' | 'member_left';
  readonly handle: string;
  readonly name: string;
}

export type ThreadEntry = ThreadMessage | ThreadMembership;

export interface GroupView {
  readonly group: SimGroup;
  /** Group lane only, DM-only cards removed. */
  readonly thread: readonly ThreadEntry[];
  /** Each member's private thread with Trav, keyed by memberId. */
  readonly dms: Readonly<Record<MemberId, readonly ThreadEntry[]>>;
  /** Trav is working on a turn in this group (typing indicator). */
  readonly typing: boolean;
  /** Last group message, for the trip list. */
  readonly preview?: { readonly fromName: string; readonly text: string; readonly at: IsoDateTime };
  /**
   * Muted operator line for this group only (never a Trav message): the last
   * tap, tapback or clock step got no visible answer, and why. Cleared by the
   * next turn in this group. Keyed per group so a line from one trip never
   * shows under another.
   */
  readonly status?: string;
  /**
   * Demo documents the simulator can feed for each member (their own card
   * charge or email receipt, from fixtures). Kind only: no amount, merchant or
   * text, so nothing private is in the payload before the owner sees the DM.
   */
  readonly intake: Readonly<Record<MemberId, readonly IntakeOffer[]>>;
}

/** One fixture document waiting to be fed through `agent.intakeDocument` for its owner. */
export interface IntakeOffer {
  readonly docId: string;
  readonly kind: 'card' | 'email';
}

/** Top-bar clock buttons (VOICE §9.1). */
export type ClockStep = 'hour' | 'morning' | 'end_of_trip';

/** A clock move: a top-bar step, or (replay `clock` lines) an exact instant. */
export type ClockRequest =
  | { readonly step: ClockStep; readonly groupId?: string }
  | { readonly to: IsoDateTime; readonly groupId?: string };

/** What this backend can do beyond chat (the UI hides what it can't). */
export interface SimControls {
  /** +1 hour / next morning / end of trip move the simulated clock. */
  readonly clock: boolean;
  /** A clock step runs due scheduled jobs (`scheduler.drain`) through Trav. */
  readonly scheduler: boolean;
  /** Demo documents can be fed through `agent.intakeDocument`. */
  readonly intake: boolean;
  /** Start over (fresh channel; the agent backend also gets a fresh runtime). */
  readonly reset: boolean;
  /** The Barcelona chat script can be replayed. */
  readonly replay: boolean;
}

export interface ReplayView {
  /** Lines already run. */
  readonly cursor: number;
  readonly total: number;
  /** Short label of the next line ("Dean: ok its official…", "clock → mar 15 10am"). */
  readonly next?: string;
  /** What the last line did, or why it was skipped. */
  readonly last?: string;
  readonly running: boolean;
}

export interface SimState {
  /** Increments on every change; the UI ignores stale SSE frames. */
  readonly version: number;
  readonly backend: BackendKind;
  /** True when no live model call can happen (`TRAV_OFFLINE=1`, or the scripted backend). */
  readonly offline: boolean;
  readonly now: IsoDateTime;
  readonly travHandle: string;
  readonly groups: readonly GroupView[];
  /** Last failed inject, shown as a small banner (never a Trav message). */
  readonly lastError?: string;
  readonly controls: SimControls;
  /** Replay progress, when the backend has the Barcelona script loaded. */
  readonly replay?: ReplayView;
}

/**
 * What the UI (or a test) asks the simulator to inject. The channel assigns
 * the message id and timestamp, so a client can never forge an inbound id or
 * claim a time; identity is the `from` handle, which the channel checks
 * against the conversation's participants.
 */
export type SimInbound =
  | {
      readonly type: 'message';
      readonly from: string;
      readonly text: string;
      /** Default: the first group. Ignored for the DM lane. */
      readonly groupId?: string;
      readonly lane?: 'group' | 'dm';
    }
  | {
      readonly type: 'reaction';
      readonly from: string;
      readonly targetMessageId: string;
      readonly reaction: string;
      readonly removed?: boolean;
    }
  | {
      readonly type: 'button_tap';
      readonly from: string;
      readonly cardMessageId: string;
      readonly actionId: string;
      readonly value?: string;
    }
  | {
      /** Replay only (no HTTP route): someone new is added to the group chat. */
      readonly type: 'member_joined';
      readonly handle: string;
      readonly displayName: string;
      readonly groupId?: string;
    };
