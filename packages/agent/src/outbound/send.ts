/**
 * The single send path (SAFETY F1; VOICE §10; D-009). Every Trav message,
 * reaction, card and DM leaves through `sendOutbound`, which in order:
 *  1. `safety.screenOutbound` (minors, roast gates, DM-only cards on the group lane)
 *  2. `safety.lintVoice` on `text` (a violation fails in tests; in production it is logged and the message still sends)
 *  3. resolves the lane: `to.kind === 'group'` ⇒ `channel.sendGroup`; `to.kind === 'member'` ⇒ `channel.sendDirect(handle)`
 *     (no `privateDm` capability ⇒ DM content is dropped and only a count line may be posted to the group)
 *  4. writes `message.sent` (ids only; never the text of DMs) and any `content.suppressed`/`roast.suppressed` events
 * The message-budget guard is a `ChannelAdapter` decorator (`packages/adapters/src/channel/budget.ts`), not here.
 *
 * Implementation notes (T-026):
 * - Between steps 1 and 2, the privacy/lane invariants (`render/invariants.ts`
 *   `laneViolations`: a ticket to anyone but `deliveredTo`, a private
 *   `expense_confirm` to anyone but its owner, either on the group lane) are a
 *   hard stop in EVERY `voice` mode: the message is suppressed, a
 *   `content.suppressed` event is written (cause `private_card_wrong_recipient`
 *   / `dm_only_card_in_group` / `private_card_in_group`, owner-visible to the
 *   content's owner), `onLintViolation` is told, and the channel is never
 *   called. The send path does not rely on the adapter to catch a misroute.
 * - Step 2 also checks the remaining VOICE §5 card invariants
 *   (`card.fallbackText === text`, shares/balances sum, roast flags). Violations
 *   go to `onLintViolation`; with `voice: 'strict'` (the default under Vitest)
 *   they throw `TravError('invariant_violation')` before anything is sent; with
 *   `voice: 'log'` the message still sends.
 * - A DM (or DM reaction) that cannot be delivered (`no_dm_lane`: the channel
 *   has no private DMs; `no_dm_handle`: no handle for that member) is dropped,
 *   and the drop is audited as `content.suppressed` with that cause (ids only:
 *   `messageDraftId`, `toMemberId`, `cardType`). `sendTurn` posts one count line
 *   for the dropped DMs of a turn.
 * - A message the screen suppresses is never linted or sent; its suppression
 *   events are still audited. Reactions are screened (a no-op) but not linted.
 * - `message.sent` payloads carry ids, lane, card type and flags only. DM sends
 *   are `visibility: 'owner'` events for the recipient, so they never render in
 *   group views.
 */
import type {
  AuditActor,
  AuditEventInput,
  AuditRepository,
  Clock,
  ConsentLookup,
  ContentTag,
  Group,
  IdGenerator,
  Member,
  MemberId,
  Outbound,
  OutboundMessage,
  OutboundReaction,
  Trip,
} from '@trav/core';
import { TravError, isReaction, isSystemNotice, safety } from '@trav/core';
import type { ChannelAdapter, ChannelHandle, SentMessage } from '@trav/adapters';
import { dmConversationId } from '@trav/adapters';
import type { LintKind } from '../render/lint.js';
import { voiceViolations } from '../render/lint.js';
import { listNames } from '../render/common.js';
import type { LaneViolation, LaneViolationCause } from '../render/invariants.js';
import { cardInvariantViolations, laneViolations } from '../render/invariants.js';

export interface SendDeps {
  readonly channel: ChannelAdapter;
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly consent: ConsentLookup;
  readonly audit: AuditRepository;
  readonly clock: Clock;
  /** Channel handle for a member's DM lane. */
  handleFor(memberId: MemberId): ChannelHandle | undefined;
  /** Test hook / production logger for lint violations. */
  onLintViolation?(outbound: Outbound, violations: readonly string[]): void;
  /**
   * `strict`: a voice or card-invariant violation throws before sending.
   * `log`: report via `onLintViolation` and send anyway (production).
   * Default: `strict` under Vitest (`process.env.VITEST`), else `log`.
   * Privacy/lane violations (`laneViolations`) ignore this: always suppressed, never sent.
   */
  readonly voice?: 'strict' | 'log';
  /** DM-lane conversation id for reactions on a member's private thread; default `dm:<handle>`. */
  dmConversationFor?(memberId: MemberId): string | undefined;
  /** Ids for the "couldn't DM" count line `sendTurn` may post; default derived from the turn's first id. */
  readonly ids?: IdGenerator;
}

/** Per-message facts the screen needs that the envelope does not carry. */
export interface OutboundSendOptions {
  /** VOICE §3.1 length class; default from the card type (`render/lint.ts`). Pass `error`/`refusal` for those templates. */
  readonly lintKind?: LintKind;
  readonly contentTags?: readonly ContentTag[];
  readonly audience?: readonly MemberId[];
  readonly explicitAdultRequest?: boolean;
  /** Roast lines inside `text` that are not in `card.roastLines` (Wrapped lines, the expense aside). */
  readonly roastLines?: readonly string[];
  /** Unconfirmed private strings that must never appear in a roast. */
  readonly privateTerms?: readonly string[];
  /** Extra roast blocklist terms (e.g. `fixtures/roast/blocklist.json`); the default list always applies. */
  readonly roastBlocklist?: readonly safety.RoastBlocklistEntry[];
  readonly replyToMessageId?: string;
}

export type DropReason = 'no_dm_lane' | 'no_dm_handle';

/**
 * A suppression the send path wrote to the audit log: the core screen's
 * (`safety.Suppression`) or the send path's own privacy/lane stop.
 */
export interface SendSuppression {
  readonly cause: safety.SuppressionCause | LaneViolationCause;
  readonly detail?: string;
  readonly event: safety.Suppression['event'];
  readonly payload: safety.Suppression['payload'];
}

export interface SendOutcome {
  /** What was sent (after screening), or the draft when suppressed/dropped/failed. */
  readonly outbound: Outbound;
  readonly sent: SentMessage | null;
  readonly suppressed: boolean;
  readonly degraded: boolean;
  /** Suppression records written to the audit log (empty if nothing was screened out). */
  readonly suppressions: readonly SendSuppression[];
  /** Voice/invariant violations found in step 2 (empty when clean). */
  readonly violations: readonly string[];
  /** DM content dropped because the lane does not exist. */
  readonly dropped?: DropReason;
  /** The channel refused the send (e.g. `rate_limited` from the budget decorator). */
  readonly failure?: { readonly code: string; readonly message: string };
}

const TRAV: AuditActor = { kind: 'trav', id: 'trav' };

function voiceMode(deps: SendDeps): 'strict' | 'log' {
  if (deps.voice !== undefined) return deps.voice;
  return process.env['VITEST'] === 'true' ? 'strict' : 'log';
}

function auditInput(
  deps: SendDeps,
  outbound: Outbound,
  type: AuditEventInput['type'],
  payload: Record<string, unknown>,
): AuditEventInput {
  const toMember = outbound.to.kind === 'member' ? outbound.to.memberId : undefined;
  return {
    groupId: deps.group.groupId,
    tripId: deps.trip?.tripId ?? null,
    type,
    actor: TRAV,
    visibility: toMember !== undefined ? 'owner' : 'group',
    ...(toMember !== undefined ? { ownerId: toMember } : {}),
    payload,
  };
}

function sentPayload(
  outbound: Outbound,
  sent: SentMessage,
  violations: readonly string[],
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    messageId: outbound.id,
    channelMessageId: sent.messageId,
    lane: outbound.to.kind === 'group' ? 'group' : 'dm',
    degraded: sent.degraded,
  };
  if (outbound.to.kind === 'member') base['toMemberId'] = outbound.to.memberId;
  if (isReaction(outbound)) {
    base['kind'] = 'reaction';
    base['targetMessageId'] = outbound.targetMessageId;
    return base;
  }
  base['kind'] = 'message';
  if (outbound.card !== undefined) {
    base['cardType'] = outbound.card.type;
    base['cardId'] = outbound.card.cardId;
  }
  if (outbound.roast === true) base['roast'] = true;
  if (outbound.proactive === true) base['proactive'] = true;
  if (outbound.urgent === true) base['urgent'] = true;
  if (violations.length > 0) {
    base['voiceViolations'] = violations.map((v) => v.split(':')[0] ?? v);
  }
  return base;
}

/** Ids-only record of an undeliverable DM (never the text). */
function auditDrop(deps: SendDeps, outbound: Outbound, reason: DropReason): void {
  const payload: Record<string, unknown> = {
    cause: reason,
    messageDraftId: outbound.id,
    kind: isReaction(outbound) ? 'reaction' : 'message',
  };
  if (outbound.to.kind === 'member') payload['toMemberId'] = outbound.to.memberId;
  if (!isReaction(outbound) && outbound.card !== undefined) {
    payload['cardType'] = outbound.card.type;
  }
  deps.audit.append(auditInput(deps, outbound, 'content.suppressed', payload));
}

/** Suppress a message that would put private content in the wrong place; audited, owner-visible. */
function suppressLane(
  deps: SendDeps,
  message: OutboundMessage,
  lane: readonly LaneViolation[],
): SendSuppression[] {
  return lane.map((v) => {
    const payload: Record<string, unknown> = {
      cause: v.cause,
      messageDraftId: message.id,
      cardType: v.cardType,
      lane: message.to.kind === 'group' ? 'group' : 'dm',
    };
    if (message.to.kind === 'member') payload['toMemberId'] = message.to.memberId;
    const { ownerId: _recipient, ...base } = auditInput(
      deps,
      message,
      'content.suppressed',
      payload,
    );
    // Visible to whoever owns the content, never to the wrong recipient.
    deps.audit.append(
      v.ownerId !== undefined
        ? { ...base, visibility: 'owner', ownerId: v.ownerId }
        : { ...base, visibility: 'group' },
    );
    return { cause: v.cause, event: 'content.suppressed', payload };
  });
}

/** T-165: group lane, one line, no card/buttons/images/@tags. */
function isWellFormedNotice(message: OutboundMessage): boolean {
  return (
    message.to.kind === 'group' &&
    message.card === undefined &&
    (message.actions ?? []).length === 0 &&
    (message.images ?? []).length === 0 &&
    (message.mentions ?? []).length === 0 &&
    !/[\r\n]/.test(message.text)
  );
}

/** The notice as an ordinary message, for channels without `systemNotices`. */
function plainMessage(message: OutboundMessage): OutboundMessage {
  const { kind: _kind, ...rest } = message;
  return rest;
}

function outcome(outbound: Outbound, fields: Partial<Omit<SendOutcome, 'outbound'>>): SendOutcome {
  return {
    outbound,
    sent: null,
    suppressed: false,
    degraded: false,
    suppressions: [],
    violations: [],
    ...fields,
  };
}

async function sendReaction(
  reaction: OutboundReaction,
  deps: SendDeps,
  suppressions: readonly safety.Suppression[],
): Promise<SendOutcome> {
  let conversationId: string | undefined = deps.group.conversationId;
  if (reaction.to.kind === 'member') {
    const memberId = reaction.to.memberId;
    const handle = deps.handleFor(memberId);
    conversationId =
      deps.dmConversationFor?.(memberId) ??
      (handle !== undefined ? dmConversationId(handle) : undefined);
    if (conversationId === undefined || !deps.channel.capabilities.privateDm) {
      const dropped: DropReason = deps.channel.capabilities.privateDm
        ? 'no_dm_handle'
        : 'no_dm_lane';
      auditDrop(deps, reaction, dropped);
      return outcome(reaction, { degraded: true, dropped, suppressions });
    }
  }
  const result = await deps.channel.react(conversationId, reaction);
  if (!result.ok) {
    return outcome(reaction, {
      degraded: true,
      suppressions,
      failure: { code: result.error.code, message: result.error.message },
    });
  }
  const sent: SentMessage = { messageId: reaction.id, sentAt: deps.clock.now(), degraded: false };
  deps.audit.append(auditInput(deps, reaction, 'message.sent', sentPayload(reaction, sent, [])));
  return outcome(reaction, { sent, suppressions });
}

export async function sendOutbound(
  outbound: Outbound,
  deps: SendDeps,
  options: OutboundSendOptions = {},
): Promise<SendOutcome> {
  if (outbound.groupId !== deps.group.groupId) {
    throw new TravError('invalid_argument', 'sendOutbound: message is for another group', {
      messageId: outbound.id,
    });
  }
  if (isSystemNotice(outbound) && !isWellFormedNotice(outbound)) {
    throw new TravError(
      'invalid_argument',
      'sendOutbound: a system notice is one group-lane line with nothing attached',
      { messageId: outbound.id },
    );
  }
  const now = deps.clock.now();

  // 1. screen
  const screen = safety.screenOutbound(outbound, {
    group: deps.group,
    members: deps.members,
    trip: deps.trip,
    consent: deps.consent,
    now,
    ...(options.contentTags !== undefined ? { contentTags: options.contentTags } : {}),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    ...(options.explicitAdultRequest !== undefined
      ? { explicitAdultRequest: options.explicitAdultRequest }
      : {}),
    ...(options.roastLines !== undefined ? { roastLines: options.roastLines } : {}),
    ...(options.privateTerms !== undefined ? { privateTerms: options.privateTerms } : {}),
    ...(options.roastBlocklist !== undefined ? { roastBlocklist: options.roastBlocklist } : {}),
  });
  for (const s of screen.suppressed) {
    deps.audit.append(auditInput(deps, outbound, s.event, { ...s.payload }));
  }
  if (screen.outbound === null) {
    return outcome(outbound, { suppressed: true, suppressions: screen.suppressed });
  }
  const screened = screen.outbound;
  if (isReaction(screened)) return sendReaction(screened, deps, screen.suppressed);

  // 1b. privacy/lane invariants: suppressed in every voice mode, the channel is never called
  const message: OutboundMessage = screened;
  const lane = laneViolations(message);
  if (lane.length > 0) {
    const laneSuppressions = suppressLane(deps, message, lane);
    const laneStrings = lane.map((v) => v.violation);
    deps.onLintViolation?.(message, laneStrings);
    return outcome(message, {
      suppressed: true,
      suppressions: [...screen.suppressed, ...laneSuppressions],
      violations: laneStrings,
    });
  }

  // 2. voice lint + card invariants
  const violations = [
    ...voiceViolations(message, deps.members, deps.trip, options.lintKind),
    ...cardInvariantViolations(message, {
      group: deps.group,
      members: deps.members,
      trip: deps.trip,
      consent: deps.consent,
      now,
    }),
  ];
  if (violations.length > 0) {
    deps.onLintViolation?.(message, violations);
    if (voiceMode(deps) === 'strict') {
      throw new TravError(
        'invariant_violation',
        `sendOutbound: voice violations in ${message.id}`,
        {
          messageId: message.id,
          violations,
        },
      );
    }
  }

  // 3. lane
  const sendOpts =
    options.replyToMessageId !== undefined
      ? { replyToMessageId: options.replyToMessageId }
      : undefined;
  // T-165: a channel without the subscript style gets the notice as an ordinary short message.
  const notice = isSystemNotice(message);
  const downgraded = notice && !deps.channel.capabilities.systemNotices;
  let result;
  if (message.to.kind === 'group') {
    const wire = downgraded ? plainMessage(message) : message;
    result = await deps.channel.sendGroup(deps.group.conversationId, wire, sendOpts);
  } else {
    const handle = deps.handleFor(message.to.memberId);
    if (!deps.channel.capabilities.privateDm) {
      auditDrop(deps, message, 'no_dm_lane');
      return outcome(message, {
        degraded: true,
        dropped: 'no_dm_lane',
        suppressions: screen.suppressed,
        violations,
      });
    }
    if (handle === undefined) {
      auditDrop(deps, message, 'no_dm_handle');
      return outcome(message, {
        degraded: true,
        dropped: 'no_dm_handle',
        suppressions: screen.suppressed,
        violations,
      });
    }
    result = await deps.channel.sendDirect(handle, message, sendOpts);
    if (!result.ok && result.error.code === 'not_supported') {
      auditDrop(deps, message, 'no_dm_lane');
      return outcome(message, {
        degraded: true,
        dropped: 'no_dm_lane',
        suppressions: screen.suppressed,
        violations,
      });
    }
  }
  if (!result.ok) {
    return outcome(message, {
      degraded: true,
      suppressions: screen.suppressed,
      violations,
      failure: { code: result.error.code, message: result.error.message },
    });
  }

  // 4. audit. A proposal card's send carries its proposal id, so approvals can
  // tell a delivered card from one the screen held back (T-081 r1 #1).
  const payload = sentPayload(message, result.value, violations);
  if (notice) {
    payload['systemNotice'] = true;
    payload['expenseIds'] = [...(message.noticeExpenseIds ?? [])];
    if (downgraded) payload['noticeDowngraded'] = true;
  }
  const sentEvent = auditInput(deps, message, 'message.sent', payload);
  deps.audit.append(
    message.card?.type === 'booking_proposal'
      ? { ...sentEvent, proposalId: message.card.proposalId }
      : sentEvent,
  );
  return outcome(message, {
    sent: result.value,
    degraded: result.value.degraded,
    suppressions: screen.suppressed,
    violations,
  });
}

/** Convenience: screen + lint + send every message of a turn, in order; one group message plus N DMs is the only multi-message turn (VOICE §3.7). */
export async function sendTurn(
  outbounds: readonly Outbound[],
  deps: SendDeps,
  optionsFor?: (outbound: Outbound) => OutboundSendOptions | undefined,
): Promise<readonly SendOutcome[]> {
  const groupMessages = outbounds.filter((o) => !isReaction(o) && o.to.kind === 'group');
  if (groupMessages.length > 1) {
    const violation = `turn_shape: ${String(groupMessages.length)} group messages in one turn (VOICE §3.7 allows one)`;
    deps.onLintViolation?.(groupMessages[1]!, [violation]);
    if (voiceMode(deps) === 'strict') {
      throw new TravError('invariant_violation', `sendTurn: ${violation}`);
    }
  }
  const outcomes: SendOutcome[] = [];
  for (const o of outbounds) outcomes.push(await sendOutbound(o, deps, optionsFor?.(o) ?? {}));

  // Undeliverable DMs: the content is gone; at most one count line goes to the group (D-009).
  const droppedBy = (reason: DropReason): SendOutcome[] =>
    outcomes.filter((x) => x.dropped === reason && !isReaction(x.outbound));
  const lines: string[] = [];
  const noLane = droppedBy('no_dm_lane');
  if (noLane.length > 0) {
    lines.push(`${privateMessages(noLane.length)} couldn't go out, this chat doesn't do dms`);
  }
  const noHandle = droppedBy('no_dm_handle');
  if (noHandle.length > 0) {
    lines.push(
      `${privateMessages(noHandle.length)} couldn't go out, ${noHandleWho(noHandle, deps)}`,
    );
  }
  if (lines.length > 0) {
    const first = outbounds[0]!;
    const countLine: OutboundMessage = {
      id: deps.ids?.next('msg') ?? `${first.id}_dmcount`,
      groupId: deps.group.groupId,
      to: { kind: 'group' },
      text: lines.join('\n'),
    };
    outcomes.push(await sendOutbound(countLine, deps, { lintKind: 'reply' }));
  }
  return outcomes;
}

function privateMessages(n: number): string {
  return `${String(n)} private message${n === 1 ? '' : 's'}`;
}

/**
 * Who Trav couldn't reach. Tickets are already public knowledge (the receipt
 * says "QR codes are in your dms"), so their holders are named; for anything
 * else (a "looks shared?" prompt) naming the member would hint at their
 * private data in the group, so the line stays anonymous.
 */
function noHandleWho(dropped: readonly SendOutcome[], deps: SendDeps): string {
  const allTickets = dropped.every(
    (x) => !isReaction(x.outbound) && x.outbound.card?.type === 'ticket',
  );
  if (!allTickets) return "i can't dm everyone yet";
  const ids = [
    ...new Set(
      dropped.flatMap((x) => (x.outbound.to.kind === 'member' ? [x.outbound.to.memberId] : [])),
    ),
  ].filter((id) => deps.members.some((m) => m.memberId === id));
  if (ids.length === 0) return "i can't dm everyone yet";
  return `i can't dm ${listNames(deps, ids)} yet`;
}
