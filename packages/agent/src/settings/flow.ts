/**
 * Settings, consent and roast-request turns (T-017). Rule-parsed, never the
 * model, so it behaves identically with `TRAV_OFFLINE=1`. Wired into
 * `loop.ts` as one small step after the mention gate, plus one step before
 * approval-shaped text for the answer to Trav's own confirmation question.
 *
 * - `@trav settings` shows roast mode, reply mode, family mode, the caps and
 *   the trip currency (group lane), or the member's own consent flags (DM).
 * - Caps, trip currency and reply mode change only after the requester
 *   answers "yes" to Trav's one question; caps and currency are lead calls.
 *   Every change is audited (`policy.changed` for the spending policy,
 *   `settings.changed` for the rest).
 * - Roast mode (VOICE §7.2, SAFETY §2.8): a lead turns it on; it is refused
 *   while any member is under 18 (or in family mode) and needs "everyone's
 *   18+" when ages are unknown; anyone turns it off ("roast mode off", "trav
 *   chill", "stop roasting"), effective on the very next message because
 *   every roast gate reads the stored setting.
 * - Consent (SAFETY §2.6): only the owner changes their own flags (a
 *   guardian may change a minor's `photos`, VOICE §8); every change is
 *   `consent.changed`; card/email import off drops pending items at once.
 * - Roast requests (`personality/roast.ts`), someone else's card (VOICE §4.12
 *   D) and nightlife with a minor (§4.12 C, `personality/refusals.ts`).
 */
import type {
  ConsentFlag,
  ConsentFlags,
  CurrencyCode,
  Group,
  GroupSpendingPolicy,
  IdGenerator,
  IsoDateTime,
  Member,
  MemberId,
  MessageId,
  Outbound,
  OutboundMessage,
  Stores,
  Trip,
  Clock,
} from '@trav/core';
import {
  currencyExponent,
  formatMoney,
  localDate,
  money,
  parseDecimal,
  parseIso,
  safety,
} from '@trav/core';
import { answerRoast, parseRoastRequest } from '../personality/roast.js';
import {
  minorNightlifeRefusal,
  privateDataRefusal,
  privateDataSubject,
} from '../personality/refusals.js';
import { changeConsent, optedOutOfRoasts, readConsent } from './consent.js';
import type { CapSetting, SettingChange, SettingsCommand } from './parse.js';
import { commandText, parseSettingsCommand } from './parse.js';
import * as T from './text.js';

/** How long Trav's "yes to confirm?" stays answerable by a reply to it. */
export const SETTINGS_CONFIRM_TTL_MS = 15 * 60 * 1000;

export interface SettingsTurnContext {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly me: Member;
  readonly lane: 'group' | 'dm';
  readonly now: IsoDateTime;
  /** The inbound message (tapbacks target it; audit rows cite it). */
  readonly messageId: MessageId;
}

export interface SettingsOutcome {
  readonly drafts: readonly Outbound[];
  readonly note: string;
  /** Roast lines inside a draft's text, declared to the outbound screen (T-028). */
  readonly roastLines?: readonly string[];
  /** Runs with what was actually sent (after screening). */
  readonly afterSend?: (sent: readonly Outbound[]) => void;
}

export interface PendingSettingsQuestion {
  readonly messageId: MessageId;
  readonly askedAt: IsoDateTime;
  /** Booking proposals already pending when Trav asked: a newer one owns a bare "yes". */
  readonly proposalsAtAsk: ReadonlySet<string>;
}

export interface SettingsFlow {
  /** Trav's open "yes to confirm?" to this member in this group, if any. */
  pendingQuestion(groupId: string, memberId: MemberId): PendingSettingsQuestion | undefined;
  /** The member's yes/no to that question. Undefined if nothing is pending. */
  answer(ctx: SettingsTurnContext, intent: 'approve' | 'decline'): SettingsOutcome | undefined;
  /**
   * A settings/consent command, a roast request, or a guardrail refusal.
   * Undefined ⇒ not ours, the loop carries on. Unaddressed messages are only
   * ever taken for the roast kill switches while roast mode is on.
   */
  command(ctx: SettingsTurnContext, text: string, addressed: boolean): SettingsOutcome | undefined;
}

export interface SettingsFlowDeps {
  readonly stores: Stores;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

type Pending = PendingSettingsQuestion &
  (
    | { readonly kind: 'change'; readonly change: ResolvedChange }
    | { readonly kind: 'adults_then_roast' }
  );

type ResolvedChange =
  | { readonly setting: CapSetting; readonly value: number | null }
  | { readonly setting: 'tripCurrency'; readonly currency: CurrencyCode }
  | { readonly setting: 'replyMode'; readonly quiet: boolean };

const CAP_LABEL: Readonly<Record<CapSetting, string>> = {
  perPersonAutoCapMinor: 'per-person cap',
  dailyGroupCapMinor: 'daily cap',
  tripGroupCapMinor: 'trip cap',
  hardMaxPerBookingMinor: 'per-booking max',
  autoApproveCapMinor: 'auto-approve cap',
};

function isLead(m: Member): boolean {
  return m.role === 'lead' || m.role === 'guardian';
}

function onOff(v: boolean): string {
  return v ? 'on' : 'off';
}

function capText(policy: GroupSpendingPolicy, value: number | null): string {
  return value === null ? 'off' : formatMoney(money(value, policy.currency));
}

function findMember(members: readonly Member[], name: string): Member | undefined {
  const n = name.toLowerCase();
  return members.find((m) => {
    const d = m.displayName.toLowerCase();
    return d === n || d.split(/\s+/u)[0] === n;
  });
}

/** The current settings, in the lane they were asked in (VOICE §3.1: ≤ 4 lines, < 280 chars). */
export function settingsText(
  group: Group,
  members: readonly Member[],
  trip: Trip | null,
  lane: 'group' | 'dm',
  consent: Pick<ConsentFlags, ConsentFlag>,
  now: IsoDateTime,
): string {
  const p = group.spendingPolicy;
  const currency = trip?.currency ?? group.currency;
  const family = safety.isFamilyMode(group, members, now);
  const roast = `roast mode ${onOff(group.settings.roastMode)}`;
  if (lane === 'dm') {
    const mine = `yours: photos ${onOff(consent.photos)} · roasts ${onOff(consent.roast)} · card import ${onOff(consent.cardImport)} · email import ${onOff(consent.emailImport)} · memory across trips ${onOff(consent.memoryAcrossTrips)}`;
    const groupLine = `group: ${roast} · per-person cap ${capText(p, p.perPersonAutoCapMinor)} · trip currency ${currency}`;
    return `${mine}\n${groupLine}`;
  }
  const line1 = `${roast} · replies ${group.settings.quietMode ? 'quiet' : 'normal'}${family ? ' · family mode on' : ''}`;
  const line2 = `per-person cap ${capText(p, p.perPersonAutoCapMinor)} · daily cap ${capText(p, p.dailyGroupCapMinor)} · trip cap ${capText(p, p.tripGroupCapMinor)}`;
  const auto = p.autoApproveCapMinor > 0 ? ` · auto-approve under ${capText(p, p.autoApproveCapMinor)}` : '';
  const line3 = `per-booking max ${capText(p, p.hardMaxPerBookingMinor)} · trip currency ${currency}${auto}`;
  const step = 20 * 10 ** currencyExponent(p.currency);
  const example = formatMoney(money(p.perPersonAutoCapMinor + step, p.currency));
  const line4 = `to change one: '@trav set the per-person cap to ${example}'`;
  return [line1, line2, line3, line4].join('\n');
}

export function createSettingsFlow(deps: SettingsFlowDeps): SettingsFlow {
  const { stores, clock, ids } = deps;
  const pending = new Map<string, Pending>();
  const key = (groupId: string, memberId: MemberId): string => `${groupId}:${memberId}`;

  const target = (ctx: SettingsTurnContext): OutboundMessage['to'] =>
    ctx.lane === 'dm' ? { kind: 'member', memberId: ctx.me.memberId } : { kind: 'group' };

  const line = (ctx: SettingsTurnContext, text: string, extra: Partial<OutboundMessage> = {}): OutboundMessage => ({
    id: ids.next('msg'),
    groupId: ctx.group.groupId,
    to: target(ctx),
    text,
    ...extra,
  });

  const say = (ctx: SettingsTurnContext, text: string, note: string): SettingsOutcome => ({
    drafts: [line(ctx, text)],
    note,
  });

  const thumbsUp = (ctx: SettingsTurnContext, note: string): SettingsOutcome => ({
    drafts: [
      {
        id: ids.next('msg'),
        groupId: ctx.group.groupId,
        kind: 'reaction',
        to: target(ctx),
        targetMessageId: ctx.messageId,
        emoji: '👍',
      },
    ],
    note,
  });

  function audit(
    ctx: SettingsTurnContext,
    input: Omit<Parameters<Stores['group']['audit']['append']>[0], 'groupId' | 'tripId'>,
  ): void {
    stores.group.audit.append({ groupId: ctx.group.groupId, tripId: ctx.trip?.tripId ?? null, ...input });
  }

  /** Fresh group row: a command earlier in the same turn may have changed it. */
  const groupNow = (ctx: SettingsTurnContext): Group => stores.group.groups.get(ctx.group.groupId) ?? ctx.group;

  function writeSetting(
    ctx: SettingsTurnContext,
    setting: 'roastMode' | 'allAdultsConfirmed' | 'quietMode',
    value: boolean,
  ): void {
    const group = groupNow(ctx);
    const before = group.settings[setting];
    stores.group.groups.update({ ...group, settings: { ...group.settings, [setting]: value } });
    audit(ctx, {
      type: 'settings.changed',
      actor: { kind: 'member', id: ctx.me.memberId },
      visibility: 'group',
      payload: {
        memberId: ctx.me.memberId,
        setting,
        before,
        after: value,
        messageId: ctx.messageId,
      },
    });
  }

  function familyOrMinor(ctx: SettingsTurnContext): boolean {
    const group = groupNow(ctx);
    return (
      safety.groupHasMinor(ctx.members, ctx.now) || safety.isFamilyMode(group, ctx.members, ctx.now)
    );
  }

  // ---------- roast mode ----------

  function roastMode(ctx: SettingsTurnContext, on: boolean, text: string): SettingsOutcome | undefined {
    const group = groupNow(ctx);
    if (!on) {
      if (!group.settings.roastMode) {
        // "trav chill" with nothing to turn off is not a settings command.
        return commandText(text) === 'chill' ? undefined : say(ctx, T.ROAST_ALREADY_OFF_TEXT, 'settings:roast_off:already');
      }
      writeSetting(ctx, 'roastMode', false);
      return say(ctx, T.ROAST_OFF_TEXT, 'settings:roast_off');
    }
    if (familyOrMinor(ctx)) {
      const msg = line(ctx, T.ROAST_MINOR_TEXT);
      audit(ctx, {
        type: 'roast.suppressed',
        actor: { kind: 'trav', id: 'trav' },
        visibility: 'group',
        payload: {
          cause: 'minor_in_group',
          messageDraftId: msg.id,
          detail: 'enable_request',
          memberId: ctx.me.memberId,
          messageId: ctx.messageId,
        },
      });
      return { drafts: [msg], note: 'settings:roast_on:minor' };
    }
    if (!isLead(ctx.me)) return say(ctx, T.ROAST_LEAD_ONLY_TEXT, 'settings:roast_on:not_lead');
    if (group.settings.roastMode) return say(ctx, T.ROAST_ALREADY_ON_TEXT, 'settings:roast_on:already');
    if (safety.groupAgeUnconfirmed(group, ctx.members)) {
      const msg = line(ctx, T.ROAST_AGE_QUESTION_TEXT);
      pending.set(key(ctx.group.groupId, ctx.me.memberId), {
        kind: 'adults_then_roast',
        messageId: msg.id,
        askedAt: ctx.now,
        proposalsAtAsk: pendingProposalIds(ctx),
      });
      return { drafts: [msg], note: 'settings:roast_on:ask_ages' };
    }
    writeSetting(ctx, 'roastMode', true);
    return say(ctx, T.ROAST_ON_TEXT, 'settings:roast_on');
  }

  // ---------- consent ----------

  function consent(
    ctx: SettingsTurnContext,
    cmd: Extract<SettingsCommand, { kind: 'consent' }>,
  ): SettingsOutcome | undefined {
    const via = ctx.lane === 'dm' ? 'dm' : 'chat';
    let owner = ctx.me;
    if (cmd.subject.kind === 'named') {
      const named = findMember(ctx.members, cmd.subject.name);
      if (named === undefined) return undefined;
      owner = named;
    }
    const minor = safety.isMinor(owner, ctx.now);

    if (owner.memberId !== ctx.me.memberId) {
      // Owner-only (SAFETY §2.6). The one exception: a guardian and a minor's photos (VOICE §8).
      if (cmd.flag === 'photos' && minor && owner.guardianMemberId === ctx.me.memberId) {
        const r = changeConsent(
          { stores, clock },
          {
            groupId: ctx.group.groupId,
            tripId: ctx.trip?.tripId ?? null,
            ownerMemberId: owner.memberId,
            actorMemberId: ctx.me.memberId,
            flag: 'photos',
            value: cmd.on,
            via: 'guardian',
          },
        );
        return say(
          ctx,
          r.changed ? T.minorPhotosText(owner.displayName, cmd.on) : cmd.on ? T.ALREADY_ON_TEXT : T.ALREADY_OFF_TEXT,
          `consent:photos:guardian:${r.changed ? 'changed' : 'unchanged'}`,
        );
      }
      if (cmd.flag === 'photos' && minor) {
        const guardian = ctx.members.find((m) => m.memberId === owner.guardianMemberId);
        return guardian !== undefined
          ? say(ctx, T.guardianCallText(guardian.displayName, owner.displayName), 'consent:not_guardian')
          : say(ctx, T.ownerOnlyText(owner.displayName), 'consent:owner_only');
      }
      return say(ctx, T.ownerOnlyText(owner.displayName), 'consent:owner_only');
    }

    // The member's own flag. A minor may always turn something off, never these on.
    if (minor && cmd.on) {
      if (cmd.flag === 'roast') return say(ctx, T.NOPE_TEXT, 'consent:roast:minor');
      if (cmd.flag === 'cardImport' || cmd.flag === 'emailImport') {
        return say(ctx, T.IMPORT_MINOR_TEXT, 'consent:import:minor');
      }
      if (cmd.flag === 'photos') {
        const guardian = ctx.members.find((m) => m.memberId === owner.guardianMemberId);
        return say(
          ctx,
          guardian !== undefined ? T.guardianCallText(guardian.displayName, owner.displayName) : T.MINOR_SETTINGS_TEXT,
          'consent:photos:needs_guardian',
        );
      }
      return say(ctx, T.MINOR_SETTINGS_TEXT, 'consent:minor');
    }

    const r = changeConsent(
      { stores, clock },
      {
        groupId: ctx.group.groupId,
        tripId: ctx.trip?.tripId ?? null,
        ownerMemberId: owner.memberId,
        actorMemberId: ctx.me.memberId,
        flag: cmd.flag,
        value: cmd.on,
        via,
      },
    );
    const note = `consent:${cmd.flag}:${onOff(cmd.on)}:${r.changed ? 'changed' : 'unchanged'}`;
    // "stop roasting me" / "leave me out": a 👍 tapback, nothing else (VOICE §7.2).
    if (cmd.flag === 'roast' && !cmd.on) return thumbsUp(ctx, note);
    if (!r.changed && r.dropped === 0) {
      if (cmd.flag === 'roast') return say(ctx, T.ROAST_ME_ALREADY_TEXT, note);
      return say(ctx, cmd.on ? T.ALREADY_ON_TEXT : T.ALREADY_OFF_TEXT, note);
    }
    switch (cmd.flag) {
      case 'roast':
        return say(ctx, groupNow(ctx).settings.roastMode ? T.ROAST_ME_ON_TEXT : T.ROAST_ME_ON_MODE_OFF_TEXT, note);
      case 'photos':
        return say(ctx, cmd.on ? T.PHOTOS_ON_TEXT : T.PHOTOS_OFF_TEXT, note);
      case 'cardImport':
        return say(ctx, cmd.on ? T.CARD_IMPORT_ON_TEXT : T.droppedPendingText(T.CARD_IMPORT_OFF_TEXT, r.dropped), note);
      case 'emailImport':
        return say(ctx, cmd.on ? T.EMAIL_IMPORT_ON_TEXT : T.droppedPendingText(T.EMAIL_IMPORT_OFF_TEXT, r.dropped), note);
      case 'memoryAcrossTrips':
        return say(ctx, cmd.on ? T.MEMORY_ON_TEXT : T.MEMORY_OFF_TEXT, note);
    }
  }

  // ---------- "everyone's 18+" ----------

  function adultsConfirmed(ctx: SettingsTurnContext): SettingsOutcome {
    if (!isLead(ctx.me)) return say(ctx, T.LEAD_ONLY_TEXT, 'settings:adults:not_lead');
    if (safety.groupHasMinor(ctx.members, ctx.now)) return say(ctx, T.ADULTS_HAS_MINOR_TEXT, 'settings:adults:minor');
    if (groupNow(ctx).settings.allAdultsConfirmed) return say(ctx, T.ALREADY_SET_TEXT, 'settings:adults:already');
    writeSetting(ctx, 'allAdultsConfirmed', true);
    return say(ctx, T.ADULTS_CONFIRMED_TEXT, 'settings:adults');
  }

  // ---------- caps, trip currency, reply mode (requester confirms) ----------

  function resolveChange(
    ctx: SettingsTurnContext,
    change: SettingChange,
  ): { ok: ResolvedChange; question: string } | { refuse: string; note: string } {
    const group = groupNow(ctx);
    const policy = group.spendingPolicy;
    if (safety.isMinor(ctx.me, ctx.now)) return { refuse: T.MINOR_SETTINGS_TEXT, note: 'settings:set:minor' };
    if (change.setting === 'replyMode') {
      if (group.settings.quietMode === change.quiet) return { refuse: T.ALREADY_SET_TEXT, note: 'settings:set:already' };
      const from = group.settings.quietMode ? 'quiet' : 'normal';
      const to = change.quiet ? 'quiet' : 'normal';
      return {
        ok: { setting: 'replyMode', quiet: change.quiet },
        question: `change replies from ${from} to ${to}? yes to confirm`,
      };
    }
    if (!isLead(ctx.me)) return { refuse: T.LEAD_ONLY_TEXT, note: 'settings:set:not_lead' };
    if (change.setting === 'tripCurrency') {
      const trip = ctx.trip;
      if (trip === null) return { refuse: T.NO_TRIP_TEXT, note: 'settings:currency:no_trip' };
      try {
        money(0, change.currency);
      } catch {
        return { refuse: T.UNREADABLE_CURRENCY_TEXT, note: 'settings:currency:unreadable' };
      }
      if (currencyExponent(change.currency) !== currencyExponent(policy.currency)) {
        return { refuse: T.UNREADABLE_CURRENCY_TEXT, note: 'settings:currency:exponent' };
      }
      if (trip.currency === change.currency) return { refuse: T.ALREADY_SET_TEXT, note: 'settings:set:already' };
      if (currencyLocked(ctx, trip)) {
        return { refuse: T.currencyLockedText(trip.currency), note: 'settings:currency:locked' };
      }
      return {
        ok: { setting: 'tripCurrency', currency: change.currency },
        question: `change the trip currency from ${trip.currency} to ${change.currency}? caps keep their numbers. yes to confirm`,
      };
    }
    if (change.currency !== undefined && change.currency !== policy.currency) {
      return { refuse: T.capCurrencyText(policy.currency), note: 'settings:cap:currency' };
    }
    let value: number | null = null;
    if (change.amount !== null) {
      try {
        value = parseDecimal(change.amount, policy.currency).amountMinor;
      } catch {
        return { refuse: T.UNREADABLE_CAP_TEXT, note: 'settings:cap:unreadable' };
      }
    }
    const before = policy[change.setting];
    if (before === value) return { refuse: T.ALREADY_SET_TEXT, note: 'settings:set:already' };
    return {
      ok: { setting: change.setting, value },
      question: `change the ${CAP_LABEL[change.setting]} from ${capText(policy, before)} to ${capText(policy, value)}? yes to confirm`,
    };
  }

  /** The trip currency is fixed once money is on the tab or a proposal is out (amounts are in it). */
  function currencyLocked(ctx: SettingsTurnContext, trip: Trip): boolean {
    const expenses = stores.group.expenses.listByTrip(trip.tripId, { includeUndone: true });
    const proposals = stores.group.bookings
      .listPendingProposals(ctx.group.groupId)
      .filter((p) => p.tripId === trip.tripId);
    return expenses.length > 0 || proposals.length > 0;
  }

  function setRequest(ctx: SettingsTurnContext, change: SettingChange): SettingsOutcome {
    const r = resolveChange(ctx, change);
    if ('refuse' in r) return say(ctx, r.refuse, r.note);
    const msg = line(ctx, r.question);
    pending.set(key(ctx.group.groupId, ctx.me.memberId), {
      kind: 'change',
      change: r.ok,
      messageId: msg.id,
      askedAt: ctx.now,
      proposalsAtAsk: pendingProposalIds(ctx),
    });
    return { drafts: [msg], note: `settings:set:${r.ok.setting}:ask` };
  }

  function pendingProposalIds(ctx: SettingsTurnContext): ReadonlySet<string> {
    return new Set(
      stores.group.bookings.listPendingProposals(ctx.group.groupId).map((p) => p.proposalId),
    );
  }

  function applyChange(ctx: SettingsTurnContext, change: ResolvedChange): SettingsOutcome {
    const group = groupNow(ctx);
    if (change.setting === 'replyMode') {
      writeSetting(ctx, 'quietMode', change.quiet);
      return say(
        ctx,
        change.quiet ? "quiet mode on. i'll only speak when @'d or when money needs a decision" : 'quiet mode off',
        'settings:set:replyMode',
      );
    }
    // Re-checked at "yes": the role or the tab may have moved since the question.
    if (!isLead(ctx.me)) return say(ctx, T.LEAD_ONLY_TEXT, 'settings:set:not_lead');
    const before = group.spendingPolicy;
    if (change.setting === 'tripCurrency') {
      const trip = ctx.trip === null ? undefined : stores.group.trips.get(ctx.trip.tripId);
      if (trip === undefined) return say(ctx, T.NO_TRIP_TEXT, 'settings:currency:no_trip');
      if (currencyLocked(ctx, trip)) {
        return say(ctx, T.currencyLockedText(trip.currency), 'settings:currency:locked');
      }
      const code = change.currency;
      const budget =
        trip.budget === undefined
          ? undefined
          : {
              ...(trip.budget.total !== undefined ? { total: money(trip.budget.total.amountMinor, code) } : {}),
              ...(trip.budget.perDay !== undefined ? { perDay: money(trip.budget.perDay.amountMinor, code) } : {}),
            };
      stores.group.trips.update({ ...trip, currency: code, ...(budget !== undefined ? { budget } : {}) });
      const after: GroupSpendingPolicy = { ...before, currency: code };
      stores.group.groups.update({ ...group, currency: code, spendingPolicy: after });
      audit(ctx, {
        type: 'settings.changed',
        actor: { kind: 'member', id: ctx.me.memberId },
        visibility: 'group',
        payload: {
          memberId: ctx.me.memberId,
          setting: 'tripCurrency',
          before: trip.currency,
          after: code,
          messageId: ctx.messageId,
        },
      });
      audit(ctx, {
        type: 'policy.changed',
        actor: { kind: 'member', id: ctx.me.memberId },
        visibility: 'group',
        payload: { memberId: ctx.me.memberId, setting: 'currency', before, after },
      });
      return say(
        ctx,
        `trip currency is now ${code}. per-person cap ${capText(after, after.perPersonAutoCapMinor)}`,
        'settings:set:tripCurrency',
      );
    }
    const after: GroupSpendingPolicy = { ...before, [change.setting]: change.value };
    stores.group.groups.update({ ...group, spendingPolicy: after });
    audit(ctx, {
      type: 'policy.changed',
      actor: { kind: 'member', id: ctx.me.memberId },
      visibility: 'group',
      payload: { memberId: ctx.me.memberId, setting: change.setting, before, after },
    });
    return say(
      ctx,
      `${CAP_LABEL[change.setting]} is now ${capText(after, change.value)}`,
      `settings:set:${change.setting}`,
    );
  }

  // ---------- roast requests and refusals ----------

  function roastsToday(ctx: SettingsTurnContext): number {
    const tz = ctx.trip?.timeZone ?? 'UTC';
    const today = localDate(ctx.now, tz);
    return stores.group.audit
      .listByGroup(ctx.group.groupId)
      .filter(
        (e) =>
          e.type === 'roast.generated' &&
          e.payload['place'] === 'aside' &&
          localDate(e.ts, tz) === today,
      ).length;
  }

  function roastRequest(ctx: SettingsTurnContext, text: string): SettingsOutcome | undefined {
    const req = parseRoastRequest(text);
    if (req === undefined) return undefined;
    const group = groupNow(ctx);
    const answer = answerRoast(req, {
      group,
      members: ctx.members,
      trip: ctx.trip,
      me: ctx.me,
      lane: ctx.lane,
      now: ctx.now,
      expenses:
        ctx.trip === null
          ? []
          : stores.group.expenses.listByTrip(ctx.trip.tripId).filter((e) => e.status === 'logged'),
      consent: (id) => stores.private.getConsent(id, ctx.group.groupId),
      optedOut: (id) => optedOutOfRoasts(stores, ctx.group.groupId, id),
      roastsToday: roastsToday(ctx),
    });
    const suppressed = (draftId: MessageId, cause: string, topicCategory?: string): void =>
      audit(ctx, {
        type: 'roast.suppressed',
        actor: { kind: 'trav', id: 'trav' },
        visibility: 'group',
        payload: {
          cause,
          messageDraftId: draftId,
          detail: 'request',
          targets: [...answer.targets],
          messageId: ctx.messageId,
          ...(topicCategory !== undefined ? { topicCategory } : {}),
        },
      });
    if (answer.kind === 'refuse') {
      const msg = line(ctx, answer.text);
      suppressed(msg.id, answer.cause, answer.topicCategory);
      return { drafts: [msg], note: `roast:refused:${answer.cause}` };
    }
    if (answer.kind === 'nothing') return say(ctx, answer.text, 'roast:nothing');
    const msg = line(ctx, answer.line, { roast: true });
    if (answer.dropped !== undefined) suppressed(msg.id, 'topic_blocked', answer.dropped);
    return {
      drafts: [msg],
      note: 'roast:line',
      roastLines: [answer.line],
      afterSend(sent) {
        const out = sent.find((o) => o.id === msg.id);
        if (out === undefined || !('text' in out) || out.roast !== true) return;
        audit(ctx, {
          type: 'roast.generated',
          actor: { kind: 'trav', id: 'trav' },
          visibility: 'group',
          payload: {
            targets: [...answer.targets],
            topics: [...answer.topics],
            place: 'aside',
            messageId: msg.id,
          },
        });
      },
    };
  }

  function refusals(ctx: SettingsTurnContext, text: string): SettingsOutcome | undefined {
    const subject = privateDataSubject(text, ctx.members, ctx.me);
    if (subject !== undefined) return say(ctx, privateDataRefusal(subject), 'refusal:private_data');
    if (ctx.lane !== 'group' || ctx.trip === null) return undefined;
    const nightlife = minorNightlifeRefusal({
      group: groupNow(ctx),
      members: ctx.members,
      trip: ctx.trip,
      activities: stores.group.trips.listActivities(ctx.trip.tripId),
      me: ctx.me,
      text,
      now: ctx.now,
    });
    if (nightlife === undefined) return undefined;
    const msg = line(ctx, nightlife.text);
    audit(ctx, {
      type: 'content.suppressed',
      actor: { kind: 'trav', id: 'trav' },
      visibility: 'group',
      payload: {
        cause: nightlife.cause,
        messageDraftId: msg.id,
        detail: 'request',
        tags: [...nightlife.tags],
        messageId: ctx.messageId,
      },
    });
    return { drafts: [msg], note: `refusal:${nightlife.cause}` };
  }

  // ---------- public ----------

  function command(ctx: SettingsTurnContext, text: string, addressed: boolean): SettingsOutcome | undefined {
    const cmd = parseSettingsCommand(text);
    if (!addressed) {
      // SAFETY §2.8 kill switch: "stop roasting" said to the room still works while roast mode is on.
      if (cmd === undefined || !groupNow(ctx).settings.roastMode) return undefined;
      if (cmd.kind === 'roast_mode' && !cmd.on && commandText(text) !== 'chill') {
        return roastMode(ctx, false, text);
      }
      if (cmd.kind === 'consent' && cmd.flag === 'roast' && !cmd.on && cmd.subject.kind === 'self') {
        return consent(ctx, cmd);
      }
      return undefined;
    }
    if (cmd !== undefined) {
      switch (cmd.kind) {
        case 'show': {
          const flags = readConsent(stores, ctx.me.memberId, ctx.group.groupId, ctx.now);
          return say(
            ctx,
            settingsText(groupNow(ctx), ctx.members, ctx.trip, ctx.lane, flags, ctx.now),
            'settings:show',
          );
        }
        case 'roast_mode':
          return roastMode(ctx, cmd.on, text);
        case 'consent':
          return consent(ctx, cmd);
        case 'adults_confirmed':
          return adultsConfirmed(ctx);
        case 'set':
          return setRequest(ctx, cmd.change);
        case 'set_unreadable':
          return say(
            ctx,
            cmd.setting === 'tripCurrency'
              ? T.UNREADABLE_CURRENCY_TEXT
              : cmd.setting === 'replyMode'
                ? T.UNREADABLE_REPLY_MODE_TEXT
                : cmd.offNotAllowed === true
                  ? T.ONLY_TRIP_CAP_OFF_TEXT
                  : T.UNREADABLE_CAP_TEXT,
            'settings:set:unreadable',
          );
      }
    }
    return roastRequest(ctx, text) ?? refusals(ctx, text);
  }

  function pendingQuestion(groupId: string, memberId: MemberId): PendingSettingsQuestion | undefined {
    const p = pending.get(key(groupId, memberId));
    if (p === undefined) return undefined;
    if (parseIso(clock.now()) - parseIso(p.askedAt) > SETTINGS_CONFIRM_TTL_MS) {
      pending.delete(key(groupId, memberId));
      return undefined;
    }
    return { messageId: p.messageId, askedAt: p.askedAt, proposalsAtAsk: p.proposalsAtAsk };
  }

  function answer(ctx: SettingsTurnContext, intent: 'approve' | 'decline'): SettingsOutcome | undefined {
    const k = key(ctx.group.groupId, ctx.me.memberId);
    const p = pending.get(k);
    if (p === undefined || pendingQuestion(ctx.group.groupId, ctx.me.memberId) === undefined) return undefined;
    pending.delete(k);
    if (intent === 'decline') {
      return say(
        ctx,
        p.kind === 'adults_then_roast' ? T.ROAST_AGE_DECLINED_TEXT : T.CONFIRM_DECLINED_TEXT,
        'settings:declined',
      );
    }
    if (p.kind === 'change') return applyChange(ctx, p.change);
    // "everyone's 18+?" → yes: confirm ages, then the roast mode the lead asked for.
    if (familyOrMinor(ctx)) return say(ctx, T.ROAST_MINOR_TEXT, 'settings:roast_on:minor');
    if (!isLead(ctx.me)) return say(ctx, T.ROAST_LEAD_ONLY_TEXT, 'settings:roast_on:not_lead');
    if (!groupNow(ctx).settings.allAdultsConfirmed) writeSetting(ctx, 'allAdultsConfirmed', true);
    if (!groupNow(ctx).settings.roastMode) writeSetting(ctx, 'roastMode', true);
    return say(ctx, T.ROAST_ON_TEXT, 'settings:roast_on');
  }

  return { pendingQuestion, answer, command };
}
