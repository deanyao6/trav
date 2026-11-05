/**
 * The settle-up flow the loop calls (T-166, D-043): the final card with its
 * payer DMs, Sent / Got it / Undo, payment-profile words in DM, and the one
 * "which apps do you use?" ask. Rules only, never the model.
 */
import type {
  Clock,
  GroupId,
  IdGenerator,
  IsoDateTime,
  Member,
  MemberId,
  OutboundMessage,
  PaymentRail,
  Stores,
  Trip,
} from '@trav/core';
import type { FxRatesAdapter } from '@trav/adapters';
import type { RenderContext } from '../render/common.js';
import { GROUP, textMessage } from '../render/common.js';
import type { ToolContext } from '../tools/registry.js';
import { renderSettleUpFor, settleUpFor } from '../tools/ledger.js';
import { pairKey } from '../render/settleUp.js';
import { payDetailsFor, payDms } from './payDetails.js';
import { parseAppsAnswer, parseHandleStatements } from './profileText.js';
import {
  applyProfileWords,
  HANDLE_IN_GROUP_TEXT,
  profileAsk,
  profileReplyLines,
  type PendingAsk,
} from './profiles.js';
import { settleAction, type SettleActionInput, type SettleActionOutcome } from './actions.js';

export interface SettleFlowDeps {
  readonly stores: Stores;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** Reference rates for dollar-only rails (the runtime's mock; never live). */
  readonly fx?: FxRatesAdapter;
}

export interface ProfileTurnInput {
  readonly groupId: GroupId;
  readonly trip: Trip | null;
  readonly members: readonly Member[];
  readonly me: Member;
  readonly lane: 'group' | 'dm';
  readonly text: string;
  /** Group lane: said to Trav. */
  readonly addressed: boolean;
  readonly now: IsoDateTime;
}

export interface SettleFlow {
  /** The final settle card for the group, then one DM per payer with how to pay (deduped). */
  finalSettle(input: {
    readonly ctx: ToolContext;
    readonly rctx: RenderContext;
    readonly trip: Trip;
    readonly lead?: string;
  }): Promise<OutboundMessage[]>;
  /** Sent / Got it / Undo on a final settle card (`actions.ts`). */
  act(ctx: ToolContext, input: SettleActionInput): SettleActionOutcome;
  /** "my venmo is @chase-w", "venmo and zelle, venmo's my fave" in DM; a handle said in the group. */
  profileTurn(
    input: ProfileTurnInput,
  ): Promise<{ readonly drafts: OutboundMessage[]; readonly note: string } | undefined>;
  /** The one ask for members who now owe or are owed money and were never asked (commit after sending). */
  asksForBalances(input: {
    readonly groupId: GroupId;
    readonly trip: Trip | null;
    readonly members: readonly Member[];
    readonly now: IsoDateTime;
  }): PendingAsk[];
  /** The one ask at sign-up, when a member joins the chat (commit after sending). */
  askOnJoin(input: {
    readonly groupId: GroupId;
    readonly trip: Trip | null;
    readonly member: Member;
    readonly now: IsoDateTime;
  }): PendingAsk[];
}

export function createSettleFlow(deps: SettleFlowDeps): SettleFlow {
  const { stores, ids, clock } = deps;

  const toolCtx = (groupId: GroupId, trip: Trip, now: IsoDateTime): ToolContext => ({
    groupId,
    tripId: trip.tripId,
    senderMemberId: null,
    senderId: 'trav',
    lane: 'group',
    now,
    clock,
    ids,
    stores,
  });

  /** Pay details for the open rows nobody has said they sent, plus the rail of every open row. */
  async function openDetails(
    ctx: ToolContext,
    trip: Trip,
    members: readonly Member[],
    involving?: MemberId,
  ): Promise<{ dms: readonly OutboundMessage[]; rails: ReadonlyMap<string, PaymentRail> }> {
    const live = settleUpFor(ctx, 'final');
    if (live.kind !== 'ok' || live.input.familyTab === true) return { dms: [], rails: new Map() };
    const open = live.input.transfers ?? [];
    const pending = new Set((live.input.pending ?? []).map(pairKey));
    const details = await payDetailsFor({
      stores,
      trip,
      transfers: open,
      now: ctx.now,
      ...(deps.fx !== undefined ? { fx: deps.fx } : {}),
    });
    const toDm = details.filter(
      (d) =>
        !pending.has(pairKey(d.transfer)) &&
        (involving === undefined || d.transfer.to === involving || d.transfer.from === involving),
    );
    const { dms } = payDms({
      stores,
      ids,
      groupId: ctx.groupId,
      tripId: trip.tripId,
      members,
      details: toDm,
    });
    const rails = new Map<string, PaymentRail>();
    for (const d of details)
      if (d.choice.kind === 'rail') rails.set(pairKey(d.transfer), d.choice.rail);
    return { dms, rails };
  }

  return {
    async finalSettle({ ctx, rctx, trip, lead }) {
      const { dms, rails } = await openDetails(ctx, trip, rctx.members);
      const card = renderSettleUpFor(ctx, 'final', rctx, {
        ...(lead !== undefined ? { lead } : {}),
        rails,
      });
      return [card, ...dms];
    },

    act: settleAction,

    async profileTurn(input) {
      const handles = parseHandleStatements(input.text);
      if (input.lane === 'group') {
        if (!input.addressed || !handles.some((h) => h.handle !== undefined)) return undefined;
        // Not stored from the group: handles go in a DM (SAFETY §2.3, VOICE §4.6 D).
        const rctx: RenderContext = {
          groupId: input.groupId,
          members: input.members,
          timeZone: input.trip?.timeZone ?? 'UTC',
          now: input.now,
          ids,
        };
        return {
          drafts: [textMessage(rctx, GROUP, [HANDLE_IN_GROUP_TEXT])],
          note: 'payments:handle_in_group',
        };
      }
      const change = applyProfileWords({
        stores,
        groupId: input.groupId,
        tripId: input.trip?.tripId ?? null,
        memberId: input.me.memberId,
        now: input.now,
        handles,
        apps: parseAppsAnswer(input.text),
      });
      if (change === undefined) return undefined;
      const lines = profileReplyLines(change);
      if (lines.length === 0) return undefined;
      const drafts: OutboundMessage[] = [
        {
          id: ids.next('msg'),
          groupId: input.groupId,
          to: { kind: 'member', memberId: input.me.memberId },
          text: lines.join('\n'),
        },
      ];
      // A handle or app that changes how someone already settling pays (them or
      // to them): the new pay details go out now.
      const trip = input.trip;
      const settling =
        trip !== null &&
        stores.group.audit
          .listByGroup(input.groupId)
          .some((e) => e.type === 'settlement.pay_details_sent' && e.tripId === trip.tripId);
      if (trip !== null && settling && (change.savedHandles.length > 0 || change.tookApps)) {
        const ctx = toolCtx(input.groupId, trip, input.now);
        const { dms } = await openDetails(ctx, trip, input.members, input.me.memberId);
        drafts.push(...dms);
      }
      return {
        drafts,
        note:
          change.savedHandles.length > 0
            ? 'payments:handle_saved'
            : change.tookApps
              ? 'payments:apps_saved'
              : 'payments:bad_handle',
      };
    },

    asksForBalances({ groupId, trip, members, now }) {
      if (trip === null) return [];
      const live = settleUpFor(toolCtx(groupId, trip, now), 'running');
      if (live.kind !== 'ok' || live.input.familyTab === true) return [];
      const out: PendingAsk[] = [];
      for (const b of live.input.balances) {
        if (b.net.amountMinor === 0) continue;
        const member = members.find((m) => m.memberId === b.memberId);
        if (member === undefined) continue;
        const ask = profileAsk({
          stores,
          ids,
          groupId,
          tripId: trip.tripId,
          member,
          now,
          askedFor: 'first_balance',
        });
        if (ask !== undefined) out.push(ask);
      }
      return out;
    },

    askOnJoin({ groupId, trip, member, now }) {
      const ask = profileAsk({
        stores,
        ids,
        groupId,
        tripId: trip?.tripId ?? null,
        member,
        now,
        askedFor: 'sign_up',
      });
      return ask !== undefined ? [ask] : [];
    },
  };
}
