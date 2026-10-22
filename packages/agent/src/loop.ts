/**
 * Trav's turn loop (T-007). One inbound event ⇒ at most one group message plus
 * N DMs. See docs/ARCHITECTURE.md "Flow 1" for the step order:
 *
 *  1. dedupe by message id; identity from the channel `senderId` only (SAFETY §2.5)
 *  2. approval-shaped events (tapback, button, "yes"/"no"/"not me") go through
 *     the identity gate and then the approval handler (T-030), never the model
 *  3. guest messages and pasted/forwarded text are untrusted: `detectInjection`
 *     ⇒ `injection.detected`, zero tools, one polite line at most (SAFETY §2.4)
 *  4. mention gate (rules → classifier → silence); "thanks trav" ⇒ ❤️
 *  5. group context → prompt → model tool loop capped at `maxToolRounds`
 *  6. money results (proposal, logged expense, clarifying question, refusal) are
 *     rendered from the tool result, never from model prose
 *  7. one group message (+ DMs) through the injected `sendTurn`
 *  8. follow-ups on the scheduler (`proposal_expiry`)
 */
import type {
  Action,
  AuditEventId,
  BookingProposal,
  Clock,
  Group,
  GroupId,
  GroupMessageSummary,
  IdGenerator,
  IsoDateTime,
  Member,
  MemberId,
  MessageId,
  Outbound,
  OutboundMessage,
  PolicyDecision,
  RichCard,
  ScheduledJob,
  Scheduler,
  Stores,
  Trip,
} from '@trav/core';
import { approval, formatMoney, isReaction, money, parseIso, TravError } from '@trav/core';
import type { ChannelAdapter, ChannelHandle, InboundEvent, InboundMessage } from '@trav/adapters';
import type {
  ApprovalHandler,
  NormalizeResult,
  PendingCardIndex,
  PendingCardRef,
} from './approval/events.js';
import type { ProposalService, ProposeResult } from './booking/proposals.js';
import { shortEventName } from './booking/proposals.js';
import type { BookingExecutor, ProviderRegistry } from './booking/executor.js';
import { buildGroupContext, renderGroupPrompt, sanitizeInline } from './context/groupContext.js';
import {
  intakeDocument as screenDocument,
  type DocumentIntake,
  type DocumentIntakeOutcome,
} from './ingest/intake.js';
import {
  classifyApprovalText,
  detectClaimedApproval,
  gateApproval,
  memberOf,
  reactionIntent,
  resolveIdentity,
  type ApprovalIntent,
  type Identity,
} from './identity.js';
import type { GroupMemory, MemberMemory } from './memory/index.js';
import type { ContentBlock, ModelClient, ModelMessage, ResponseSource } from './model/client.js';
import type { SendOutcome } from './outbound/send.js';
import { DM_CHAT_PROMPT, GROUP_CHAT_PROMPT, type PromptTemplate } from './prompts/index.js';
import { detectMention, type MentionContext } from './mention.js';
import type { ToolRegistry } from './tools/registry.js';
import type { TurnToolContext } from './tools/shared.js';
import { detectInjection, stripInvisible } from './untrusted.js';

// ---------- dependencies ----------

export interface TurnSendContext {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly lane: 'group' | 'dm';
  /** Channel handle for a member's DM lane. */
  handleFor(memberId: MemberId): ChannelHandle | undefined;
}

/** The single send path, injected: `outbound/send.ts` in production, a direct channel sender in tests. */
export type TurnSender = (
  outbounds: readonly Outbound[],
  ctx: TurnSendContext,
) => Promise<readonly SendOutcome[]>;

/** T-030 plugs in here; until then approval-shaped events stop at the identity gate. */
export interface ApprovalRouting {
  normalize(
    inbound: InboundEvent,
    index: PendingCardIndex,
    senderMemberId: MemberId | null,
    now: IsoDateTime,
  ): NormalizeResult;
  readonly handler: ApprovalHandler;
}

export interface AgentDeps {
  readonly stores: Stores;
  readonly model: ModelClient;
  readonly tools: ToolRegistry;
  readonly channel: ChannelAdapter;
  readonly providers: ProviderRegistry;
  readonly executor: BookingExecutor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly scheduler: Scheduler;
  readonly groupMemory: GroupMemory;
  readonly memberMemory: MemberMemory;
  readonly proposals: ProposalService;
  readonly sendTurn: TurnSender;
  readonly approval?: ApprovalRouting;
  /** Prompt templates; default `GROUP_CHAT_PROMPT` / `DM_CHAT_PROMPT`. */
  readonly prompts?: { readonly group: PromptTemplate; readonly dm: PromptTemplate };
  /** Max model round-trips per turn (tool loop cap). Default 6. */
  readonly maxToolRounds?: number;
  /** Recent group messages kept per conversation for the prompt. Default 20. */
  readonly recentMessageLimit?: number;
}

export interface TurnResult {
  /** What was handed to `sendTurn`, after screening. */
  readonly outbound: readonly Outbound[];
  readonly toolCalls: readonly string[];
  readonly auditEventIds: readonly AuditEventId[];
  /** True when Trav chose silence (not addressed, tapback-only ack, etc.). */
  readonly silent: boolean;
  /** `source` of each model round this turn (tests assert `'script'` where determinism matters). */
  readonly modelSources: readonly ResponseSource[];
  /** Short machine-readable note on why the turn ended the way it did. */
  readonly note: string;
}

export interface DocumentIntakeResult extends TurnResult {
  /** Pattern names from `detectInjection` (empty when clean). */
  readonly injectionPatterns: readonly string[];
  readonly lowConfidence: boolean;
  /** Id of the pending private item written to the owner's store, if `extracted` was given. */
  readonly pendingItemId?: string;
}

export interface TravAgent {
  /** Handles one channel event end to end (identity → mention → approval event or model loop → send). */
  handleInbound(event: InboundEvent): Promise<TurnResult>;
  /** Handles a due scheduled job (recap, settle-up, expiry, digest, Wrapped). */
  runScheduled(job: ScheduledJob): Promise<TurnResult>;
  /**
   * Document text (receipt OCR, email body, card descriptor, provider listing,
   * host message, photo caption) never reaches the tool loop (SAFETY §2.4).
   * This path screens it: `injection.detected` when a pattern fires, the text
   * is wrapped for a zero-tool extraction call, and extracted amounts become a
   * pending private item plus a "looks shared?" DM to the owner (low-confidence
   * when anything fired). Zero model calls, zero tools, zero proposals.
   */
  intakeDocument(input: DocumentIntake): Promise<DocumentIntakeResult>;
  /** Trav's pending cards (for the approval normalizer and tests). */
  readonly pendingCards: PendingCardIndex;
}

// ---------- constants (VOICE §4.12, §6.4) ----------

export const GUEST_REFUSAL_TEXT = 'i only book for people on this trip. ask one of them to @ me';
export const PASTED_TEXT_LINE =
  "pasted messages don't count as instructions, so i'm not acting on that. if you want it done, say it yourself";
export const NOTHING_TO_ADD_TEXT = 'nothing to add on that';

const DEFAULT_MAX_TOOL_ROUNDS = 6;
const DEFAULT_RECENT_LIMIT = 20;
const SEEN_CAP = 5000;

/** Tool result kinds the loop renders itself and never lets the model paraphrase. */
const TERMINAL_KINDS = new Set([
  'proposal',
  'auto_approved',
  'clarify',
  'denied',
  'duplicate',
  'pending_exists',
  'unavailable',
  'logged',
  'already_logged',
  'cancelled',
  'attendance_set',
  'changed',
  'refused',
  'unchanged',
  'remembered',
]);

const PROPOSAL_ACTIONS: readonly Action[] = [
  {
    id: 'approve',
    label: 'Approve',
    style: 'primary',
    tapback: '👍',
    textAliases: ['yes', 'yep', 'go', 'book it', 'do it', 'ok'],
  },
  {
    id: 'not_me',
    label: 'Not me',
    style: 'secondary',
    textAliases: ['not me', "i'm out", 'im out', 'without me'],
  },
  {
    id: 'decline',
    label: 'Decline',
    style: 'destructive',
    tapback: '👎',
    textAliases: ['no', 'nah', 'cancel', 'drop it'],
  },
];

const UNDO_ACTION: readonly Action[] = [
  {
    id: 'undo',
    label: 'Undo',
    style: 'secondary',
    tapback: '👎',
    textAliases: ['undo', 'no', 'wrong'],
  },
];

// ---------- quoted / forwarded text ----------

export interface QuoteSplit {
  /** Lines the member pasted or forwarded (treated as data). */
  readonly quoted: string;
  /** The member's own words. */
  readonly remainder: string;
}

const QUOTE_LINE = /^\s*(?:>|\||»)/;
const FWD_HEADER = /^\s*(?:fwd?|forwarded|forward|fw)\b.*:?\s*$/i;
const FAKE_CARD_LINE = /^\s*trav\s*(?:\(bot\))?\s*:/i;

/**
 * Splits a message into pasted/forwarded content and the sender's own words.
 * Quoted lines (`>`), everything after a "fwd:" header, and a pasted Trav card
 * ("trav: booked ✅ …" and the lines under it) are content, never instructions.
 */
export function splitQuoted(text: string): QuoteSplit {
  const lines = stripInvisible(text).split(/\r?\n/);
  const quoted: string[] = [];
  const remainder: string[] = [];
  let inPaste = false;
  for (const line of lines) {
    if (inPaste || QUOTE_LINE.test(line)) {
      quoted.push(line.replace(/^\s*(?:>|\||»)\s?/, ''));
      continue;
    }
    if (FWD_HEADER.test(line) || FAKE_CARD_LINE.test(line)) {
      inPaste = true;
      quoted.push(line);
      continue;
    }
    remainder.push(line);
  }
  return { quoted: quoted.join('\n').trim(), remainder: remainder.join('\n').trim() };
}

// ---------- helpers ----------

function dedupeKey(event: InboundEvent): string {
  switch (event.type) {
    case 'message':
    case 'reaction':
    case 'button_tap':
      return `${event.conversationId}:${event.type}:${event.messageId}`;
    case 'member_joined':
    case 'member_left':
      return `${event.conversationId}:${event.type}:${event.participant.handle}:${event.receivedAt}`;
  }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '· ')
    .trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function resultText(v: unknown): string | undefined {
  return isRecord(v) && typeof v['text'] === 'string' ? v['text'] : undefined;
}

function resultCard(v: unknown): RichCard | undefined {
  if (!isRecord(v) || !isRecord(v['card'])) return undefined;
  const card = v['card'];
  return typeof card['cardId'] === 'string' && typeof card['type'] === 'string'
    ? (card as unknown as RichCard)
    : undefined;
}

function toolErrorResult(e: unknown): Record<string, unknown> {
  if (e instanceof TravError) return { error: e.code, message: e.message };
  return { error: 'failed', message: e instanceof Error ? e.message : String(e) };
}

function excerpt(text: string): string {
  const flat = stripInvisible(text).replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? flat.slice(0, 200) : flat;
}

function hasAtTrav(text: string): boolean {
  return /(^|[^\w@])@trav(?![\w-])/i.test(text);
}

// ---------- the agent ----------

export function createTravAgent(deps: AgentDeps): TravAgent {
  const { stores, model, tools, clock, ids, scheduler } = deps;
  const prompts = deps.prompts ?? { group: GROUP_CHAT_PROMPT, dm: DM_CHAT_PROMPT };
  const maxRounds = Math.max(1, deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS);
  const recentLimit = deps.recentMessageLimit ?? DEFAULT_RECENT_LIMIT;

  const seen = new Set<string>();
  const seenOrder: string[] = [];
  const recent = new Map<string, GroupMessageSummary[]>();
  const lastQuestionAt = new Map<string, IsoDateTime>();
  const lastQuestionRef = new Map<string, PendingCardRef>();
  const cards = new Map<MessageId, PendingCardRef>();
  const guestsTold = new Set<string>();

  const remember = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    seenOrder.push(key);
    if (seenOrder.length > SEEN_CAP) {
      const old = seenOrder.shift();
      if (old !== undefined) seen.delete(old);
    }
    return true;
  };

  const laneKey = (groupId: GroupId, lane: 'group' | 'dm', memberId: MemberId | null): string =>
    lane === 'group' ? `${groupId}:group` : `${groupId}:dm:${memberId ?? '?'}`;

  const pushRecent = (key: string, summary: GroupMessageSummary): void => {
    const list = recent.get(key) ?? [];
    list.push(summary);
    if (list.length > recentLimit) list.splice(0, list.length - recentLimit);
    recent.set(key, list);
  };

  const pendingCards: PendingCardIndex = {
    byMessageId: (messageId) => cards.get(messageId),
    pendingProposalsRequestedBy(memberId) {
      const all: BookingProposal[] = [];
      for (const g of stores.group.groups.list())
        all.push(...stores.group.bookings.listPendingProposals(g.groupId));
      return all
        .filter((p) => p.requestedBy === memberId)
        .sort((a, b) => parseIso(b.requestedAt) - parseIso(a.requestedAt));
    },
    lastTravQuestion(lane, memberId) {
      for (const [key, ref] of lastQuestionRef) {
        const [, l, m] = key.split(':');
        if (l !== lane) continue;
        if (lane === 'dm' && m !== memberId) continue;
        const at = lastQuestionAt.get(key);
        if (at !== undefined && parseIso(clock.now()) - parseIso(at) <= 2 * 60 * 1000) return ref;
      }
      return undefined;
    },
  };

  interface Resolved {
    readonly group: Group;
    readonly members: readonly Member[];
    readonly trip: Trip | null;
    readonly identity: Identity;
    readonly me: Member | null;
    readonly lane: 'group' | 'dm';
    readonly now: IsoDateTime;
  }

  function resolve(event: InboundEvent): Resolved | undefined {
    const now = clock.now();
    const sender = 'sender' in event ? event.sender : event.participant.handle;
    const displayName = 'participant' in event ? event.participant.displayName : undefined;
    let group: Group | undefined;
    if (event.lane === 'group') {
      group = stores.group.groups.getByConversation(event.conversationId);
    } else {
      const candidates = stores.group.groups
        .list()
        .filter((g) => stores.group.members.getBySenderId(g.groupId, sender) !== undefined);
      group =
        candidates.find((g) => stores.group.trips.current(g.groupId, now) !== undefined) ??
        candidates[0];
    }
    if (group === undefined) return undefined;
    const members = stores.group.members.listByGroup(group.groupId);
    const identity = resolveIdentity(stores.group.members, group.groupId, sender, displayName);
    return {
      group,
      members,
      trip: stores.group.trips.current(group.groupId, now) ?? null,
      identity,
      me: memberOf(identity),
      lane: event.lane,
      now,
    };
  }

  function audit(
    r: Resolved,
    input: Omit<Parameters<Stores['group']['audit']['append']>[0], 'groupId' | 'tripId'>,
  ): AuditEventId {
    return stores.group.audit.append({
      groupId: r.group.groupId,
      tripId: r.trip?.tripId ?? null,
      ...input,
    }).id;
  }

  function auditIdsSince(groupId: GroupId, before: ReadonlySet<string>): AuditEventId[] {
    return stores.group.audit
      .listByGroup(groupId)
      .map((e) => e.id)
      .filter((id) => !before.has(id));
  }

  function snapshotAudit(groupId: GroupId): ReadonlySet<string> {
    return new Set(stores.group.audit.listByGroup(groupId).map((e) => e.id));
  }

  const silent = (note: string, extra: Partial<TurnResult> = {}): TurnResult => ({
    outbound: [],
    toolCalls: [],
    auditEventIds: [],
    silent: true,
    modelSources: [],
    note,
    ...extra,
  });

  function targetFor(r: Resolved): OutboundMessage['to'] {
    return r.lane === 'dm' && r.me !== null
      ? { kind: 'member', memberId: r.me.memberId }
      : { kind: 'group' };
  }

  function sendCtx(r: Resolved): TurnSendContext {
    return {
      group: r.group,
      members: r.members,
      trip: r.trip,
      lane: r.lane,
      handleFor: (memberId) => stores.group.members.get(memberId)?.senderId,
    };
  }

  async function send(r: Resolved, drafts: readonly Outbound[]): Promise<readonly Outbound[]> {
    if (drafts.length === 0) return [];
    const outcomes = await deps.sendTurn(drafts, sendCtx(r));
    const sent: Outbound[] = [];
    for (const o of outcomes) {
      if (o.suppressed || o.sent === null) continue;
      sent.push(o.outbound);
      if (isReaction(o.outbound)) continue;
      const msg: OutboundMessage = o.outbound;
      const key = laneKey(
        r.group.groupId,
        msg.to.kind === 'group' ? 'group' : 'dm',
        msg.to.kind === 'member' ? msg.to.memberId : null,
      );
      pushRecent(key, {
        messageId: msg.id,
        senderMemberId: null,
        senderDisplayName: 'trav',
        text: msg.text,
        at: r.now,
        fromTrav: true,
      });
      if (msg.card !== undefined) {
        const ref: PendingCardRef = {
          cardId: msg.card.cardId,
          messageId: msg.id,
          card: msg.card,
          ...(msg.card.type === 'booking_proposal' ? { proposalId: msg.card.proposalId } : {}),
          ...(msg.expiresAt !== undefined ? { expiresAt: msg.expiresAt } : {}),
          sentAt: r.now,
        };
        cards.set(msg.id, ref);
        if (/\?/.test(msg.text)) lastQuestionRef.set(key, ref);
      }
      if (/\?/.test(msg.text)) lastQuestionAt.set(key, r.now);
    }
    return sent;
  }

  function message(
    r: Resolved,
    text: string,
    extra: Partial<Omit<OutboundMessage, 'id' | 'groupId' | 'to' | 'text'>> = {},
    id?: MessageId,
  ): OutboundMessage {
    return {
      id: id ?? ids.next('msg'),
      groupId: r.group.groupId,
      to: targetFor(r),
      text,
      ...extra,
    };
  }

  // ---------- approval-shaped events ----------

  function pendingFor(r: Resolved): BookingProposal[] {
    return stores.group.bookings
      .listPendingProposals(r.group.groupId)
      .filter((p) => r.trip === null || p.tripId === r.trip.tripId)
      .sort((a, b) => parseIso(b.requestedAt) - parseIso(a.requestedAt));
  }

  function decisionFor(proposalId: string): PolicyDecision | undefined {
    return stores.group.bookings.getDecision(proposalId)?.decision;
  }

  function proposalLine(p: BookingProposal, i: number): string {
    return `${i + 1}. ${shortEventName(p.description)} · ${formatMoney(money(p.totalMinor, p.currency))} · ${p.attendees.length} ticket${p.attendees.length === 1 ? '' : 's'}`;
  }

  async function routeApproval(
    r: Resolved,
    event: InboundEvent,
    intent: ApprovalIntent,
    text: string,
    via: 'button' | 'reaction' | 'text',
    boundProposalId: string | undefined,
    messageId: MessageId,
  ): Promise<TurnResult> {
    const before = snapshotAudit(r.group.groupId);
    const pending = pendingFor(r);
    const finish = (outbound: readonly Outbound[], note: string): TurnResult => ({
      outbound,
      toolCalls: [],
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: outbound.length === 0,
      modelSources: [],
      note,
    });
    const invalid = (
      cause: string,
      proposalId?: string,
      extra: Record<string, unknown> = {},
    ): void => {
      audit(r, {
        type: 'approval.invalid_attempt',
        actor: { kind: 'member', id: r.me?.memberId ?? ('sender' in event ? event.sender : '') },
        visibility: 'group',
        ...(proposalId !== undefined ? { proposalId } : {}),
        payload: {
          senderId: 'sender' in event ? event.sender : '',
          cause,
          messageId,
          via,
          intent,
          ...extra,
        },
      });
    };

    const gate = gateApproval({
      identity: r.identity,
      intent,
      text,
      members: r.members,
      pending,
      decisionFor,
      ...(boundProposalId !== undefined ? { boundProposalId } : {}),
      now: r.now,
    });

    if (gate.kind === 'ignored') {
      if (gate.cause === 'no_pending') return finish([], 'approval:no_pending');
      if (gate.cause === 'claimed_for_other' && r.me !== null) {
        const claim = detectClaimedApproval(text, r.members, r.me.memberId);
        const target =
          claim === undefined ? undefined : r.members.find((m) => m.memberId === claim.claimedFor);
        invalid('claimed_for_other', boundProposalId ?? pending[0]?.proposalId, {
          claimedFor: claim?.claimedFor ?? null,
        });
        if (target === undefined) return finish([], 'approval:claimed_for_other');
        const name = sanitizeInline(target.displayName, 40);
        const sent = await send(r, [
          message(r, `that has to come from ${name}. @${name} 👍 to book`, {
            mentions: [target.memberId],
          }),
        ]);
        return finish(sent, 'approval:claimed_for_other');
      }
      invalid(gate.cause, boundProposalId ?? pending[0]?.proposalId);
      return finish([], `approval:${gate.cause}`);
    }

    if (gate.kind === 'ambiguous') {
      invalid('ambiguous', undefined, { candidates: gate.candidates.map((p) => p.proposalId) });
      // VOICE §3.1: an ordinary reply is at most 4 lines, so two candidates are listed.
      const shown = gate.candidates.slice(0, 2);
      const rest = gate.candidates.length - shown.length;
      const lines = [
        'which one?',
        ...shown.map(proposalLine),
        rest > 0
          ? `reply with the number, or name it (+${rest} more pending)`
          : 'reply with the number',
      ];
      const sent = await send(r, [message(r, lines.join('\n'))]);
      return finish(sent, 'approval:ambiguous');
    }

    // A real candidate from an adult member: the approval handler owns the rest (T-030).
    if (deps.approval === undefined) {
      return finish([], 'approval:handler_not_wired');
    }
    const normalized = deps.approval.normalize(event, pendingCards, r.me?.memberId ?? null, r.now);
    if (normalized.kind !== 'event') return finish([], `approval:normalize_${normalized.kind}`);
    const ev =
      normalized.event.proposalId === undefined
        ? { ...normalized.event, proposalId: gate.proposal.proposalId }
        : normalized.event;
    const outbound = await deps.approval.handler.handle(ev);
    const sent = await send(r, outbound);
    return finish(sent, 'approval:handled');
  }

  // ---------- the model loop ----------

  async function modelTurn(r: Resolved, event: InboundMessage, text: string): Promise<TurnResult> {
    const before = snapshotAudit(r.group.groupId);
    const me = r.me;
    if (me === null) return silent('model:guest');
    const key = laneKey(r.group.groupId, r.lane, me.memberId);
    const template = r.lane === 'dm' ? prompts.dm : prompts.group;

    const ctx = buildGroupContext(
      { group: stores.group, privateCounts: stores.private, clock },
      r.group.groupId,
      r.trip?.tripId ?? null,
      { recentMessages: recent.get(key) ?? [], recentMessageLimit: recentLimit },
    );
    const prompt = renderGroupPrompt(ctx, template);
    let system = `${prompt.system}\n\n${prompt.context}`;
    if (r.lane === 'dm') {
      // DM lane only: this member's own memory and pending-item count (SAFETY §2.3).
      const facts = deps.memberMemory.recall(me.memberId, r.group.groupId);
      const pendingCount = stores.private.listPendingItems(
        me.memberId,
        r.group.groupId,
        'pending',
      ).length;
      const lines = [
        `private thread with ${sanitizeInline(me.displayName, 40)} (${sanitizeInline(me.memberId, 40)}). what they told you here stays here.`,
      ];
      if (facts.length > 0) {
        lines.push('what they have told you before:');
        for (const f of facts.slice(-20))
          lines.push(
            `- ${sanitizeInline(f.text, 200)}${f.sourceLane === 'private' ? ' (private)' : ''}`,
          );
      }
      if (pendingCount > 0)
        lines.push(`${pendingCount} of their charges are waiting for a 👍 (get_my_pending_items)`);
      system = `${system}\n\n${lines.join('\n')}`;
    }

    const userText = `${sanitizeInline(me.displayName, 40)}: ${sanitizeInline(text, 1000)}`;
    const messages: ModelMessage[] = [{ role: 'user', content: userText }];
    const toolSpecs = tools.specs(r.lane);
    const toolCtx: TurnToolContext = {
      groupId: r.group.groupId,
      tripId: r.trip?.tripId ?? null,
      senderMemberId: me.memberId,
      senderId: event.sender,
      lane: r.lane,
      now: r.now,
      clock,
      ids,
      stores,
      messageId: event.messageId,
    };

    const toolCalls: string[] = [];
    const sources: ResponseSource[] = [];
    const results: { name: string; value: unknown }[] = [];
    let terminal: { name: string; value: unknown } | undefined;
    let modelText = '';

    for (let round = 0; round < maxRounds && terminal === undefined; round += 1) {
      const res = await model.complete({
        model: 'main',
        systemPromptId: prompt.systemPromptId,
        system,
        messages: [...messages],
        tools: toolSpecs,
      });
      sources.push(res.source);
      if (res.toolCalls.length === 0) {
        modelText = res.text;
        break;
      }
      const assistant: ContentBlock[] = [];
      if (res.text.trim().length > 0) assistant.push({ type: 'text', text: res.text });
      for (const call of res.toolCalls)
        assistant.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      messages.push({ role: 'assistant', content: assistant });

      const toolResults: ContentBlock[] = [];
      for (const call of res.toolCalls) {
        toolCalls.push(call.name);
        let value: unknown;
        try {
          value = await tools.run(call.name, call.input, toolCtx);
        } catch (e) {
          value = toolErrorResult(e);
        }
        results.push({ name: call.name, value });
        if (
          terminal === undefined &&
          isRecord(value) &&
          typeof value['kind'] === 'string' &&
          TERMINAL_KINDS.has(value['kind'])
        ) {
          terminal = { name: call.name, value };
        }
        toolResults.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: JSON.stringify(value),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    const drafts: Outbound[] = [];
    let note = 'model:text';
    if (terminal !== undefined) {
      note = `tool:${terminal.name}:${String((terminal.value as Record<string, unknown>)['kind'])}`;
      const draft = await renderTerminal(r, terminal.value, me);
      if (draft !== undefined) drafts.push(draft);
    } else {
      let text = stripMarkdown(modelText);
      if (text.length === 0) {
        const fallback = [...results]
          .reverse()
          .map((x) => resultText(x.value))
          .find((t) => t !== undefined);
        text = fallback ?? (results.length > 0 ? NOTHING_TO_ADD_TEXT : '');
        note = fallback !== undefined ? 'tool:text' : 'model:empty';
      }
      if (text.length > 0) drafts.push(message(r, text));
    }

    const sent = await send(r, drafts);
    return {
      outbound: sent,
      toolCalls,
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: sent.length === 0,
      modelSources: sources,
      note,
    };
  }

  async function renderTerminal(
    r: Resolved,
    value: unknown,
    me: Member,
  ): Promise<OutboundMessage | undefined> {
    if (!isRecord(value)) return undefined;
    const kind = value['kind'];
    if (kind === 'proposal') {
      const res = value as Extract<ProposeResult, { kind: 'proposal' }>;
      const requiredOthers = res.decision.requiredApprovers.filter((id) => id !== me.memberId);
      const mentions = res.decision.requiredApprovers.includes(me.memberId) ? [] : requiredOthers;
      const expiresAt = res.decision.expiresAt ?? res.proposal.holdExpiresAt;
      if (expiresAt !== undefined) {
        scheduler.schedule({
          jobId: `proposal_expiry:${res.proposal.proposalId}`,
          groupId: r.group.groupId,
          tripId: res.proposal.tripId,
          kind: 'proposal_expiry',
          runAt: expiresAt,
          payload: { proposalId: res.proposal.proposalId },
        });
      }
      return message(
        r,
        res.text,
        {
          card: res.card,
          actions: PROPOSAL_ACTIONS,
          ...(mentions.length > 0 ? { mentions } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
        res.messageId,
      );
    }
    if (kind === 'auto_approved') {
      const res = value as Extract<ProposeResult, { kind: 'auto_approved' }>;
      try {
        const out = await deps.executor.execute(res.proposal.proposalId, res.grant.grantId);
        if (out.kind === 'completed' || out.kind === 'duplicate') {
          return message(
            r,
            `booked: ${sanitizeInline(out.booking.description, 60)}, ${formatMoney(money(out.booking.totalMinor, out.booking.currency))}. receipt and tickets on the way`,
          );
        }
        return message(r, "couldn't complete that one. no charge went through, @ me to try again");
      } catch {
        return message(r, "couldn't complete that one. no charge went through, @ me to try again");
      }
    }
    if (kind === 'clarify') {
      const q = typeof value['question'] === 'string' ? value['question'] : "who's in?";
      return message(r, q);
    }
    if (kind === 'logged') {
      const text = resultText(value) ?? 'logged';
      const card = resultCard(value);
      return message(r, text, { ...(card !== undefined ? { card } : {}), actions: UNDO_ACTION });
    }
    const text = resultText(value);
    return text === undefined ? undefined : message(r, text);
  }

  // ---------- messages ----------

  async function handleMessage(r: Resolved, event: InboundMessage): Promise<TurnResult> {
    const me = r.me;
    const groupKey = laneKey(r.group.groupId, 'group', null);
    const rawText = stripInvisible(event.text);
    const recordInbound = (): void => {
      if (r.lane !== 'group') return;
      pushRecent(groupKey, {
        messageId: event.messageId,
        senderMemberId: me?.memberId ?? null,
        senderDisplayName:
          me?.displayName ??
          (r.identity.kind === 'guest' ? (r.identity.displayName ?? 'guest') : ''),
        text: rawText,
        at: r.now,
        fromTrav: false,
      });
    };

    // 1. approval-shaped text ("yes", "nah", "not me"), bound to a card or a pending proposal.
    const intent = classifyApprovalText(rawText);
    const boundRef =
      event.replyToMessageId === undefined ? undefined : cards.get(event.replyToMessageId);
    if (intent !== undefined && (boundRef?.proposalId !== undefined || pendingFor(r).length > 0)) {
      recordInbound();
      return routeApproval(
        r,
        event,
        intent,
        rawText,
        'text',
        boundRef?.proposalId,
        event.messageId,
      );
    }

    const mentionCtx: MentionContext = {
      lane: r.lane,
      repliesToTrav:
        boundRef !== undefined ||
        (event.replyToMessageId !== undefined && isTravMessage(event.replyToMessageId)),
      platformMention: event.platformMention === true,
      ...(lastQuestionAt.get(laneKey(r.group.groupId, r.lane, me?.memberId ?? null)) !== undefined
        ? {
            lastTravQuestionAt: lastQuestionAt.get(
              laneKey(r.group.groupId, r.lane, me?.memberId ?? null),
            )!,
          }
        : {}),
      now: r.now,
    };

    // 2. guests: untrusted text, zero tools, one polite refusal when addressed (SAFETY §2.5).
    if (me === null) {
      recordInbound();
      const before = snapshotAudit(r.group.groupId);
      const matches = detectInjection(rawText);
      if (matches.length > 0) {
        audit(r, {
          type: 'injection.detected',
          actor: { kind: 'system', id: 'trav' },
          visibility: 'group',
          payload: {
            source: 'guest_message',
            itemId: event.messageId,
            matchedPattern: matches[0]!.pattern,
            patterns: matches.map((m) => m.pattern),
            excerpt: excerpt(matches[0]!.excerpt),
            senderId: event.sender,
          },
        });
      }
      const mention = await detectMention(rawText, mentionCtx, model);
      if (!mention.addressed || r.lane === 'dm') {
        return silent('guest:not_addressed', {
          auditEventIds: auditIdsSince(r.group.groupId, before),
        });
      }
      if (guestsTold.has(event.sender)) {
        return silent('guest:told_once', { auditEventIds: auditIdsSince(r.group.groupId, before) });
      }
      guestsTold.add(event.sender);
      const sent = await send(r, [message(r, GUEST_REFUSAL_TEXT)]);
      return {
        outbound: sent,
        toolCalls: [],
        auditEventIds: auditIdsSince(r.group.groupId, before),
        silent: sent.length === 0,
        modelSources: [],
        note: 'guest:refused',
      };
    }

    // 3. pasted or forwarded content is data, never instructions (SAFETY §2.4).
    let text = rawText;
    const split = splitQuoted(rawText);
    if (split.quoted.length > 0) {
      const matches = detectInjection(split.quoted);
      if (matches.length > 0) {
        recordInbound();
        const before = snapshotAudit(r.group.groupId);
        audit(r, {
          type: 'injection.detected',
          actor: { kind: 'system', id: 'trav' },
          visibility: 'group',
          payload: {
            source: 'forwarded_message',
            itemId: event.messageId,
            matchedPattern: matches[0]!.pattern,
            patterns: matches.map((m) => m.pattern),
            excerpt: excerpt(matches[0]!.excerpt),
            senderId: event.sender,
          },
        });
        const pending = pendingFor(r);
        if (
          pending.length > 0 &&
          /\b(?:approve|book it|yes|go ahead|confirm)\b/i.test(split.quoted)
        ) {
          audit(r, {
            type: 'approval.invalid_attempt',
            actor: { kind: 'member', id: me.memberId },
            visibility: 'group',
            proposalId: pending[0]!.proposalId,
            payload: {
              senderId: event.sender,
              cause: 'claimed_for_other',
              messageId: event.messageId,
              via: 'text',
            },
          });
        }
        const addressed =
          hasAtTrav(split.quoted) ||
          (await detectMention(split.remainder, mentionCtx, model)).addressed;
        const sent = addressed ? await send(r, [message(r, PASTED_TEXT_LINE)]) : [];
        return {
          outbound: sent,
          toolCalls: [],
          auditEventIds: auditIdsSince(r.group.groupId, before),
          silent: sent.length === 0,
          modelSources: [],
          note: 'injection:forwarded',
        };
      }
      text = split.remainder;
      if (text.length === 0) {
        recordInbound();
        return silent('quoted_only');
      }
    }

    // 4. "Dean said it's fine" while something is pending: not Dean's answer (SAFETY §2.5).
    const pending = pendingFor(r);
    if (pending.length > 0) {
      const claim = detectClaimedApproval(text, r.members, me.memberId);
      if (claim !== undefined) {
        recordInbound();
        return routeApproval(r, event, 'approve', text, 'text', undefined, event.messageId);
      }
    }

    // 5. mention gate.
    const mention = await detectMention(text, mentionCtx, model);
    recordInbound();
    if (!mention.addressed) return silent(`mention:${mention.reason}`);
    if (mention.reason === 'thanks') {
      const reaction: Outbound = {
        id: ids.next('msg'),
        groupId: r.group.groupId,
        kind: 'reaction',
        to: targetFor(r),
        targetMessageId: event.messageId,
        emoji: '❤️',
      };
      const sent = await send(r, [reaction]);
      return {
        outbound: sent,
        toolCalls: [],
        auditEventIds: [],
        silent: false,
        modelSources: [],
        note: 'mention:thanks',
      };
    }

    // 6. the model.
    return modelTurn(r, event, text);
  }

  function isTravMessage(messageId: MessageId): boolean {
    for (const list of recent.values()) {
      if (list.some((m) => m.messageId === messageId && m.fromTrav)) return true;
    }
    return false;
  }

  // ---------- public ----------

  async function handleInbound(event: InboundEvent): Promise<TurnResult> {
    if (!remember(dedupeKey(event))) return silent('duplicate');
    const r = resolve(event);
    if (r === undefined) return silent('unknown_conversation');

    switch (event.type) {
      case 'member_joined':
      case 'member_left':
        return silent(`membership:${event.type}`);
      case 'reaction': {
        if (event.removed) return silent('reaction:removed');
        const intent = reactionIntent(event.reaction);
        const ref = cards.get(event.targetMessageId);
        if (intent === undefined || ref?.proposalId === undefined)
          return silent('reaction:not_approval');
        return routeApproval(r, event, intent, '', 'reaction', ref.proposalId, event.messageId);
      }
      case 'button_tap': {
        const ref = cards.get(event.cardMessageId);
        const intent: ApprovalIntent | undefined =
          event.actionId === 'approve' ||
          event.actionId === 'decline' ||
          event.actionId === 'not_me'
            ? event.actionId
            : undefined;
        if (intent === undefined || ref?.proposalId === undefined)
          return silent(`button:${event.actionId}`);
        return routeApproval(r, event, intent, '', 'button', ref.proposalId, event.messageId);
      }
      case 'message':
        return handleMessage(r, event);
    }
  }

  async function runScheduled(job: ScheduledJob): Promise<TurnResult> {
    if (job.kind !== 'proposal_expiry') return silent(`scheduled:${job.kind}:not_handled`);
    const proposalId =
      typeof job.payload['proposalId'] === 'string' ? job.payload['proposalId'] : undefined;
    if (proposalId === undefined) return silent('scheduled:proposal_expiry:no_id');
    const proposal = stores.group.bookings.getProposal(proposalId);
    if (proposal === undefined || proposal.status !== 'pending')
      return silent('scheduled:proposal_expiry:not_pending');
    const group = stores.group.groups.get(proposal.groupId);
    if (group === undefined) return silent('scheduled:proposal_expiry:no_group');
    const now = clock.now();
    const before = snapshotAudit(group.groupId);
    const grant = stores.group.bookings.getGrantForProposal(proposalId);
    if (grant !== undefined) stores.group.bookings.saveGrant(approval.expireGrant(grant, now));
    stores.group.bookings.updateProposal({ ...proposal, status: 'expired' });
    stores.group.audit.append({
      groupId: group.groupId,
      tripId: proposal.tripId,
      type: 'approval.expired',
      actor: { kind: 'system', id: 'scheduler' },
      visibility: 'group',
      proposalId,
      idempotencyKey: proposal.idempotencyKey,
      payload: { expiresAt: grant?.expiresAt ?? job.runAt },
    });
    await deps.proposals.releaseHold(proposal);
    for (const [id, ref] of cards) if (ref.proposalId === proposalId) cards.delete(id);
    const r: Resolved = {
      group,
      members: stores.group.members.listByGroup(group.groupId),
      trip: stores.group.trips.get(proposal.tripId) ?? null,
      identity: { kind: 'guest', senderId: 'scheduler' },
      me: null,
      lane: 'group',
      now,
    };
    const sent = await send(r, [
      message(
        r,
        `${shortEventName(proposal.description)} proposal expired, no charge. @ me if you still want it`,
      ),
    ]);
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: 'scheduled:proposal_expiry',
    };
  }

  async function intakeDocument(input: DocumentIntake): Promise<DocumentIntakeResult> {
    const group = stores.group.groups.get(input.groupId);
    if (group === undefined) throw new TravError('not_found', `group ${input.groupId} not found`);
    const now = clock.now();
    const members = stores.group.members.listByGroup(group.groupId);
    const owner = members.find((m) => m.memberId === input.ownerMemberId);
    if (owner === undefined) {
      throw new TravError(
        'not_found',
        `member ${input.ownerMemberId} is not in group ${input.groupId}`,
      );
    }
    const before = snapshotAudit(group.groupId);
    const trip = stores.group.trips.current(group.groupId, now) ?? null;
    const outcome: DocumentIntakeOutcome = screenDocument(input, {
      stores,
      clock,
      ids,
      group,
      members,
      trip,
    });
    const r: Resolved = {
      group,
      members,
      trip,
      identity: { kind: 'member', member: owner },
      me: owner,
      lane: 'dm',
      now,
    };
    const sent = await send(r, outcome.drafts);
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: outcome.matches.length > 0 ? 'document:injection_detected' : 'document:clean',
      injectionPatterns: outcome.matches.map((m) => m.pattern),
      lowConfidence: outcome.lowConfidence,
      ...(outcome.pendingItemId !== undefined ? { pendingItemId: outcome.pendingItemId } : {}),
    };
  }

  return { handleInbound, runScheduled, intakeDocument, pendingCards };
}
