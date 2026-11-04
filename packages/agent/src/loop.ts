/**
 * Trav's turn loop (T-007). One inbound event ⇒ at most one group message plus
 * N DMs. See docs/ARCHITECTURE.md "Flow 1" for the step order:
 *
 *  1. dedupe by message id; identity from the channel `senderId` only (SAFETY §2.5)
 *  2. approval-shaped events (tapback, button, "yes"/"no"/"not me") go through
 *     the identity gate and then the approval handler (T-030), never the model.
 *     A bare "yes" binds only to the sender's own proposal (SAFETY §2.1);
 *     anyone else must reply to the card or tap it, otherwise it is chat and
 *     gets at most an `approval.invalid_attempt` audit (D-019)
 *  3. guest messages and pasted/forwarded text are untrusted: `detectInjection`
 *     ⇒ `injection.detected`, zero tools, one polite line at most (SAFETY §2.4).
 *     None of it is kept for later prompts either: the `recent` transcript the
 *     next tool-enabled turn sees holds a member's own words only, with
 *     `[pasted text, not shown]` / `[guest message, not shown]` markers
 *  4. mention gate (rules → classifier → silence; guests get rules only, so
 *     their text never reaches a classifier call); "thanks trav" ⇒ ❤️. While a
 *     proposal is pending, "Dean said it's fine" is an invalid approval attempt
 *     only when the message is for Trav (addressed, or carrying an approval
 *     word); Trav names the real approver only when it was addressed;
 *     "Maya is in the shower" is chat and gets nothing, not even audit
 *  5. group context → prompt → model tool loop capped at `maxToolRounds`
 *  6. money results (proposal, logged expense, clarifying question, refusal) are
 *     rendered from the tool result, never from model prose; model prose is
 *     clamped to VOICE §3.1 (4 lines, under 280 chars)
 *  7. one group message (+ DMs) through the injected `sendTurn`
 *  8. follow-ups on the scheduler (`proposal_expiry`)
 *
 * Turn boundary (ARCHITECTURE §6): nothing thrown inside a turn escapes
 * `handleInbound` / `runScheduled`. A rejected model call, a tool crash or a
 * strict-voice throw becomes one audit event and the VOICE §4.10 two-liner
 * ("no charge went through"); the result carries `note: 'error:<code>'`.
 * "👎 to undo" on a logged expense is honoured here: the expense is voided
 * (`status: 'undone'`, no ledger entries) and `ledger.entry_deleted` written.
 * The word "undo" binds to a logged-expense card it replies to, or (bare /
 * "@trav undo") to the latest such card within the 2-minute reply window;
 * never to anything older, never through some other card.
 *
 * The loop never calls `BookingExecutor.execute`: a policy `auto_approve`
 * is handed to `ApprovalHandler.autoApproved`, so `approval/handler.ts` stays
 * the single caller (SAFETY §2.1).
 */
import type {
  Action,
  AuditEventId,
  BookingProposal,
  Clock,
  Expense,
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
import { approval, formatMoney, isReaction, ledger, money, parseIso, TravError } from '@trav/core';
import type { ChannelAdapter, ChannelHandle, InboundEvent, InboundMessage } from '@trav/adapters';
import type {
  ApprovalEvent,
  ApprovalHandler,
  NormalizeResult,
  PendingCardIndex,
  PendingCardRef,
} from './approval/events.js';
import { followSupersededBy } from './approval/events.js';
import {
  AUTO_APPROVE_FAILED_TEXT,
  TURN_FAILED_AFTER_PURCHASE_TEXT,
  TURN_FAILED_TEXT,
} from './approval/text.js';
import type { ProposalService, ProposeResult } from './booking/proposals.js';
import { shortEventName } from './booking/proposals.js';
import type { BookingExecutor, ProviderRegistry } from './booking/executor.js';
import { buildGroupContext, renderGroupPrompt, sanitizeInline } from './context/groupContext.js';
import { createChatExpenseFlow } from './ingest/chatExpense.js';
import {
  importCardTransactions as importCards,
  type CardImportInput,
  type CardImportOutcome,
} from './ingest/card.js';
import {
  importEmailReceipts as importEmails,
  type EmailImportInput,
  type EmailImportOutcome,
} from './ingest/email.js';
import { answerShare, matchShareAnswer, whichCharge, type ShareMatch } from './ingest/pending.js';
import {
  intakeDocument as screenDocument,
  type DocumentIntake,
  type DocumentIntakeOutcome,
} from './ingest/intake.js';
import {
  canRequest,
  classifyApprovalText,
  detectClaimedApproval,
  gateApproval,
  hasApprovalIntentWord,
  memberOf,
  reactionIntent,
  resolveIdentity,
  type ApprovalIntent,
  type Identity,
} from './identity.js';
import type { GroupMemory, MemberMemory } from './memory/index.js';
import {
  OFFLINE_NOT_SURE_TEXT,
  type ContentBlock,
  type ModelClient,
  type ModelMessage,
  type ResponseSource,
} from './model/client.js';
import type { SendOutcome } from './outbound/send.js';
import { DM_CHAT_PROMPT, GROUP_CHAT_PROMPT, type PromptTemplate } from './prompts/index.js';
import {
  detectMention,
  detectMentionRules,
  inReplyWindow,
  REPLY_WINDOW_MS,
  type MentionContext,
  type MentionReason,
  type MentionResult,
} from './mention.js';
import { handleRosterMessage, type RosterTurn } from './roster/turn.js';
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

/** One card-transaction import for one owner in one group (T-013, `ingest/card.ts`). */
export interface CardImportRequest extends CardImportInput {
  readonly groupId: GroupId;
}

export interface CardImportResult extends TurnResult, CardImportOutcome {}

/** One email-receipt import for one owner in one group (T-012, `ingest/email.ts`). */
export interface EmailImportRequest extends EmailImportInput {
  readonly groupId: GroupId;
}

export interface EmailImportResult extends TurnResult, EmailImportOutcome {}

export interface TravAgent {
  /** Handles one channel event end to end (identity → mention → approval event or model loop → send). */
  handleInbound(event: InboundEvent): Promise<TurnResult>;
  /**
   * Pulls an owner's card transactions through the "looks shared" classifier
   * (SAFETY §2.6): rows land only in the owner's private store, prompts go out
   * as DMs to the owner, and nothing reaches the group ledger until the owner
   * answers Share it on the card. Zero tools, zero proposals.
   */
  importCardTransactions(input: CardImportRequest): Promise<CardImportResult>;
  /**
   * Pulls an owner's forwarded email receipts through the parser and the
   * "looks shared" classifier (SAFETY §2.4, §2.6; `emailImport` consent,
   * default off): parsed facts land only in the owner's private store,
   * instruction-like text is flagged and never quoted, prompts go out as DMs
   * to the owner, and nothing reaches the group ledger until the owner
   * answers Share it. Zero tools, zero proposals.
   */
  importEmailReceipts(input: EmailImportRequest): Promise<EmailImportResult>;
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
/** VOICE §4.10 failure lines live in `approval/text.ts` (a leaf, T-030 note c); re-exported for callers. */
export {
  AUTO_APPROVE_FAILED_TEXT,
  TURN_FAILED_AFTER_PURCHASE_TEXT,
  TURN_FAILED_TEXT,
} from './approval/text.js';
/**
 * What the `recent` transcript keeps instead of untrusted text (SAFETY §2.4):
 * pasted or forwarded lines, and anything a guest says, never reach a
 * tool-enabled prompt, not even on a later turn.
 */
export const PASTED_TEXT_MARKER = '[pasted text, not shown]';
export const GUEST_TEXT_MARKER = '[guest message, not shown]';

/** VOICE §3.1 ordinary reply: 1–4 lines, under 280 characters. */
export const REPLY_MAX_LINES = 4;
export const REPLY_MAX_CHARS = 279;

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
    // VOICE §6.2 only; a bare "ok" in unrelated chat must never buy tickets.
    textAliases: ['yes', 'yep', 'go', 'book it', 'do it'],
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

/** VOICE §4.4 "👎 to undo": the button, the tapback, or the word "undo" (bare or "@trav undo"). */
const UNDO_ACTION: readonly Action[] = [
  {
    id: 'undo',
    label: 'Undo',
    style: 'secondary',
    tapback: '👎',
    textAliases: ['undo'],
  },
];
const UNDO_TEXT =
  /^[\s(]*(?:@trav\s*[,:]?\s*|(?:hey |ok |okay |yeah )?trav\s*[,:]?\s*)?undo[\s!.]*$/i;
/** The addressed form only ("@trav undo", "trav, undo"): a bare "undo" past the window is chat. */
const EXPLICIT_UNDO = /^[\s(]*(?:@trav|(?:hey |ok |okay |yeah )?trav\s*[,:])/i;
export const UNDO_WHICH_TEXT = 'which one? reply undo on the logged line you want gone';

/**
 * Clamps model prose to an ordinary reply (VOICE §3.1): the first 4 lines,
 * under 280 characters, cut at a sentence boundary when one is in reach.
 * Tool-rendered text (settle-up, proposal) has its own limits and is not clamped.
 */
export function clampReply(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1]!.length > 0));
  const out = lines.slice(0, REPLY_MAX_LINES).join('\n').trim();
  if (out.length <= REPLY_MAX_CHARS) return out;
  const head = out.slice(0, REPLY_MAX_CHARS);
  const sentence = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? '),
    head.lastIndexOf('\n'),
  );
  if (sentence >= REPLY_MAX_CHARS / 2) return head.slice(0, sentence + 1).trim();
  const space = head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head).trim();
}

// ---------- quoted / forwarded text ----------

export interface QuoteSplit {
  /** Lines the member pasted or forwarded (treated as data). */
  readonly quoted: string;
  /** The member's own words. */
  readonly remainder: string;
}

const QUOTE_LINE = /^\s*(?:>|\||»)/;
/**
 * A forward header: a header word followed by a colon ("fwd:", "FWD: re:
 * tickets", "Forwarded message:", Apple Mail's "Begin forwarded message:"), a
 * header word alone on its line ("Fwd", "---------- Forwarded message
 * ----------"), or a "from …" / "by …" line ending in a colon ("fwd from dean
 * lol:", "forwarded by maya:"). "fwd this to henry pls" is a sentence, not a
 * header (T-066).
 */
const FWD_HEADER =
  /^\s*(?:-+\s*)?(?:begin\s+)?(?:fwd?|fw|forwarded(?: message)?)\s*:|^\s*(?:-+\s*)?(?:fwd?|fw|forwarded(?: message)?)\s*(?:-+\s*)?$|^\s*(?:fwd?|fw|forwarded)\s+(?:from|by)\b.{0,60}:\s*$/i;
const FAKE_CARD_LINE = /^\s*trav\s*(?:\(bot\))?\s*:/i;
/**
 * Marks only Trav's cards carry: a check (every receipt leads "booked ✅"),
 * "👍 to …" (proposals), "👎 to undo" (logged expenses), an order number.
 */
const CARD_MARKS = /booked\s*✅|👍\s*to\s+book\b|👎\s*to\s+undo\b/iu;
/** Marks that count only on a line AFTER the first: a member's own "ok ✅ done" or "order 12345 is mine" opener is their words. */
const LATER_LINE_MARKS = /✅|\border\s*#?\s*[A-Za-z]{0,6}-?\d{3,}/iu;
/** The one lead Trav's cards use that a member would not type: "logged: €84 dinner …" (VOICE §4.4). */
const CARD_LEAD = /^\s*logged\s*:/i;

/**
 * "trav: …" is a pasted Trav card when it is not the first line, or when it
 * is the first line and the message carries a card mark on any line (✅,
 * "👍 to", "👎 to", an order number) or the line leads with Trav's own
 * "logged:". Anything else on the first line ("trav: who's in tonight?",
 * "trav: €20 taxi on me", "trav: approved, book it", "trav: booked it, see
 * you at 11", a multi-line "trav: log these\n€20 taxi") is the sender
 * addressing Trav (mention.ts reads "trav:" as the vocative).
 */
function isPastedCardLine(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  if (!FAKE_CARD_LINE.test(line)) return false;
  if (i > 0) return true;
  if (lines.some((l) => CARD_MARKS.test(l))) return true;
  if (lines.some((l, j) => j > 0 && LATER_LINE_MARKS.test(l))) return true;
  return CARD_LEAD.test(line.replace(FAKE_CARD_LINE, ''));
}

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
  for (const [i, line] of lines.entries()) {
    if (inPaste || QUOTE_LINE.test(line)) {
      quoted.push(line.replace(/^\s*(?:>|\||»)\s?/, ''));
      continue;
    }
    if (FWD_HEADER.test(line) || isPastedCardLine(lines, i)) {
      inPaste = true;
      quoted.push(line);
      continue;
    }
    remainder.push(line);
  }
  return { quoted: quoted.join('\n').trim(), remainder: remainder.join('\n').trim() };
}

// ---------- attendance lines with a tail ----------

const AT_TRAV_TOKEN = /(^|[^\w@])@trav(?![\w-])\s*[,:]?/gi;
const TRAV_VOCATIVE_PREFIX = /^\s*(?:(?:hey|hi|yo|ok|okay|yeah)\s+)?trav\s*[,:]\s*/i;
/** "too", "now too", "after all": filler on an attendance line. A bare "now" is not ("sam is going now" means leaving). */
const ATTENDANCE_FILLER = /\s+(?:now\s+too|now\s+as\s+well|too|as\s+well|again|after\s+all)$/i;
/** What may follow an attendance clause without being a separate request: "add him", "make it 6". */
const ATTENDANCE_FOLLOW_UP =
  /^(?:(?:so|and|then|pls|plz|please)\s+)*(?:add (?:him|her|them)(?:\s+(?:in|back))?|make it (?:for )?\d{1,2}(?:\s+tickets?)?|count (?:him|her|them) in|(?:get|grab|book) (?:him|her|them) (?:one|a ticket|in))(?:\s+(?:too|pls|plz|please|now|again|as well))?[\s!.?]*$/i;

/**
 * The texts the roster handler is offered for one message, in order: the
 * message itself, then (only when it differs) its attendance clause with the
 * tail dropped. "@trav henry's in now too", "@trav henry's in, make it 6" and
 * "henry's in! @trav add him" all carry "henry's in"; the tail is either
 * filler or a follow-up the roster change already implies (the re-proposal
 * carries the new count and needs a fresh 👍). A tail that is a request of
 * its own ("henry's in, can you log the taxi") is not dropped: the message
 * goes to the model whole (T-066).
 */
export function rosterTexts(text: string): string[] {
  const out = [text];
  const split = attendanceClause(text);
  if (split !== undefined && split.clause !== text.trim()) out.push(split.clause);
  return out;
}

/**
 * The headcount a "make it N" follow-up asks for ("henry's in, make it 6" ⇒
 * 6), or undefined when the message has no such tail. The loop offers the
 * attendance clause to the roster handler only when N matches the in-count
 * the change would produce; otherwise the whole message goes to the model,
 * which can ask (T-066).
 */
export function rosterFollowUpCount(text: string): number | undefined {
  const tail = attendanceClause(text)?.tail ?? '';
  const n = /\bmake it (?:for )?(\d{1,2})\b/i.exec(tail);
  return n === null ? undefined : Number(n[1]);
}

function attendanceClause(text: string): { clause: string; tail: string } | undefined {
  const t = stripInvisible(text)
    .replace(AT_TRAV_TOKEN, '$1')
    .replace(/\s+/g, ' ')
    .replace(TRAV_VOCATIVE_PREFIX, '')
    .trim();
  const m = /^(.*?)(?:[,!.;]+|\s+-\s+)\s*(.*)$/u.exec(t);
  const head = (m === null ? t : m[1]!).trim();
  const tail = m === null ? '' : m[2]!.trim();
  if (tail.length > 0 && !ATTENDANCE_FOLLOW_UP.test(tail)) return undefined;
  const clause = head.replace(ATTENDANCE_FILLER, '').trim();
  return clause.length > 0 ? { clause, tail } : undefined;
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
  /** Which group each card was sent in: the index never answers across groups. */
  const cardGroup = new Map<MessageId, GroupId>();
  const guestsTold = new Set<string>();
  /** Expense from chat text (T-010): parser first, one question when a money fact is missing. */
  const chatExpenses = createChatExpenseFlow({ stores, model, ids, clock });

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

  /**
   * The card index the approval normalizer sees. Scoped to one group when the
   * loop builds it for a turn; the public `pendingCards` (no group) scopes by
   * the member's group when a member is given and otherwise answers only when
   * exactly one group has a live question, so a card never crosses groups.
   */
  function cardIndexFor(groupId: GroupId | undefined): PendingCardIndex {
    const inGroup = (messageId: MessageId): boolean =>
      groupId === undefined || cardGroup.get(messageId) === groupId;
    return {
      byMessageId(messageId) {
        const ref = cards.get(messageId);
        return ref !== undefined && inGroup(messageId) ? ref : undefined;
      },
      pendingProposalsRequestedBy(memberId) {
        const groups =
          groupId === undefined ? stores.group.groups.list().map((g) => g.groupId) : [groupId];
        const all: BookingProposal[] = [];
        for (const g of groups) all.push(...stores.group.bookings.listPendingProposals(g));
        return all
          .filter((p) => p.requestedBy === memberId)
          .sort((a, b) => parseIso(b.requestedAt) - parseIso(a.requestedAt));
      },
      lastTravQuestion(lane, memberId) {
        const scope =
          groupId ??
          (memberId === undefined ? undefined : stores.group.members.get(memberId)?.groupId);
        let found: PendingCardRef | undefined;
        const groupsSeen = new Set<string>();
        for (const [key, ref] of lastQuestionRef) {
          const [g, l, m] = key.split(':');
          if (l !== lane) continue;
          if (lane === 'dm' && m !== memberId) continue;
          if (scope !== undefined && g !== scope) continue;
          const at = lastQuestionAt.get(key);
          if (at === undefined || parseIso(clock.now()) - parseIso(at) > REPLY_WINDOW_MS) continue;
          found ??= ref;
          if (g !== undefined) groupsSeen.add(g);
        }
        return groupsSeen.size === 1 ? found : undefined;
      },
    };
  }
  const pendingCards = cardIndexFor(undefined);

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
        cardGroup.set(msg.id, r.group.groupId);
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

  /** Members who have already 👍'd this proposal (the grant's signatures). */
  function grantedBy(proposalId: string): Set<MemberId> {
    return new Set(
      (stores.group.bookings.getGrantForProposal(proposalId)?.grantedBy ?? []).map(
        (s) => s.memberId,
      ),
    );
  }

  /**
   * Who Trav may tag when a claim names nobody whose 👍 counts: the approvers
   * still missing, never the sender. `any_one`: the requester if they may
   * approve, else the one remaining approver (a crowd is not named).
   * `each_payer`: everyone still missing, at most two (more is a list, not a
   * nudge). Empty ⇒ Trav stays silent and the audit row is the record.
   */
  function approversToName(
    proposalId: string,
    decision: PolicyDecision,
    granted: ReadonlySet<MemberId>,
    r: Resolved,
  ): Member[] {
    const others = decision.requiredApprovers.filter(
      (id) => id !== r.me?.memberId && !granted.has(id),
    );
    const requester = stores.group.bookings.getProposal(proposalId)?.requestedBy;
    let ids: readonly MemberId[] = [];
    if (decision.approvalMode === 'any_one') {
      if (granted.size === 0) {
        ids =
          requester !== undefined && others.includes(requester)
            ? [requester]
            : others.length === 1
              ? others
              : [];
      }
    } else if (decision.approvalMode === 'each_payer') {
      ids = others.length <= 2 ? others : [];
    }
    return ids
      .map((id) => r.members.find((m) => m.memberId === id))
      .filter((m): m is Member => m !== undefined);
  }

  async function routeApproval(
    r: Resolved,
    event: InboundEvent,
    intent: ApprovalIntent,
    text: string,
    via: 'button' | 'reaction' | 'text',
    boundProposalIdAsBound: string | undefined,
    messageId: MessageId,
    /** The message was for Trav (mention, quote-reply, reply window): only then may Trav answer a claim out loud. */
    addressed = false,
  ): Promise<TurnResult> {
    const before = snapshotAudit(r.group.groupId);
    const pending = pendingFor(r);
    // A "not me" on a superseded card lands on the card that replaced it
    // (D-021), so the gate sees the live proposal instead of answering
    // `no_pending`. A 👍 or 👎 on the old card stays dead.
    const boundProposalId =
      intent === 'not_me' && boundProposalIdAsBound !== undefined
        ? followSupersededBy((id) => stores.group.bookings.getProposal(id), boundProposalIdAsBound)
        : boundProposalIdAsBound;
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
      // A guest has no member actor: Trav records the attempt itself, the raw
      // handle stays in the payload (`senderId`), never in `actor`.
      audit(r, {
        type: 'approval.invalid_attempt',
        actor: r.me === null ? { kind: 'trav', id: 'trav' } : { kind: 'member', id: r.me.memberId },
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
        // "Dean said it's fine" / "everyone's in": audited, never counted. Trav
        // names the person it needs only when it was asked (VOICE §2, D-019);
        // an unaddressed claim in chat gets no reply, and an "everyone" claim
        // names nobody, so nobody is tagged.
        const claim = detectClaimedApproval(text, r.members, r.me.memberId);
        const claimedFor = claim?.kind === 'named' ? claim.claimedFor : null;
        const target =
          claimedFor === null ? undefined : r.members.find((m) => m.memberId === claimedFor);
        const proposalId = boundProposalId ?? pending[0]?.proposalId;
        invalid('claimed_for_other', proposalId, {
          claimedFor,
          claimKind: claim?.kind ?? null,
          addressed,
        });
        if (!addressed || proposalId === undefined) {
          return finish([], 'approval:claimed_for_other');
        }
        // Trav only ever tags someone whose 👍 would count (T-066): the
        // named member when they are a required approver who has not 👍'd yet, else the
        // approver(s) the decision actually needs (VOICE §6.2), else nothing.
        const decision = decisionFor(proposalId);
        const required = decision?.requiredApprovers ?? [];
        const granted = grantedBy(proposalId);
        if (
          target !== undefined &&
          required.includes(target.memberId) &&
          !granted.has(target.memberId)
        ) {
          const name = sanitizeInline(target.displayName, 40);
          const sent = await send(r, [
            message(r, `that has to come from ${name}. @${name} 👍 to book`, {
              mentions: [target.memberId],
            }),
          ]);
          return finish(sent, 'approval:claimed_for_other');
        }
        // An "everyone" claim is the sender's own attempt from a non-approver:
        // silent (VOICE §6.2, D-019 §2). Only a named claim gets the nudge.
        const needed =
          decision === undefined || claim?.kind !== 'named'
            ? []
            : approversToName(proposalId, decision, granted, r);
        if (needed.length === 0) return finish([], 'approval:claimed_for_other');
        const names = needed.map((m) => `@${sanitizeInline(m.displayName, 40)}`);
        const sent = await send(r, [
          message(r, `need a 👍 from ${names.join(' and ')} on this one`, {
            mentions: needed.map((m) => m.memberId),
          }),
        ]);
        return finish(sent, 'approval:claimed_for_other');
      }
      // A card-less "everyone's in, book it" from someone who did not ask
      // (`not_requester`) keeps its claim kind in the audit trail.
      const claim =
        gate.cause === 'not_requester' && r.me !== null && text.length > 0
          ? detectClaimedApproval(text, r.members, r.me.memberId)
          : undefined;
      invalid(
        gate.cause,
        boundProposalId ?? pending[0]?.proposalId,
        claim === undefined ? {} : { claimKind: claim.kind },
      );
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
    const normalized = deps.approval.normalize(
      event,
      cardIndexFor(r.group.groupId),
      r.me?.memberId ?? null,
      r.now,
    );
    let ev: ApprovalEvent;
    if (normalized.kind === 'event') {
      ev =
        normalized.event.proposalId === undefined
          ? { ...normalized.event, proposalId: gate.proposal.proposalId }
          : normalized.event;
    } else if (normalized.kind === 'none' && via === 'text' && event.type === 'message') {
      // "everyone's in, book it" is not a whole-message alias, so the normalizer
      // has no event for it; the gate has already established it is the
      // sender's own attempt on this one proposal (D-019). Same signature
      // shape as a bare "yes": channel sender id, text, this message.
      ev = {
        kind: intent,
        senderId: event.sender,
        via: 'text',
        messageId,
        at: r.now,
        proposalId: gate.proposal.proposalId,
      };
    } else {
      return finish([], `approval:normalize_${normalized.kind}`);
    }
    const outbound = await deps.approval.handler.handle(ev);
    const sent = await send(r, outbound);
    return finish(sent, 'approval:handled');
  }

  // ---------- the model loop ----------

  async function modelTurn(
    r: Resolved,
    event: InboundMessage,
    text: string,
    reason: MentionReason,
  ): Promise<TurnResult> {
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

    // VOICE §2: a reply-window turn is Trav guessing that a short message
    // answers its question. If the model is unsure (offline fallback, or the
    // generic clarify line) and called no tool, the guess was wrong: silence.
    if (
      terminal === undefined &&
      reason === 'reply_window' &&
      toolCalls.length === 0 &&
      (sources.at(-1) === 'fallback' || modelText.trim() === OFFLINE_NOT_SURE_TEXT)
    ) {
      return {
        outbound: [],
        toolCalls,
        auditEventIds: auditIdsSince(r.group.groupId, before),
        silent: true,
        modelSources: sources,
        note: 'reply_window:unsure',
      };
    }

    const drafts: Outbound[] = [];
    let note = 'model:text';
    if (terminal !== undefined) {
      note = `tool:${terminal.name}:${String((terminal.value as Record<string, unknown>)['kind'])}`;
      drafts.push(...(await renderTerminal(r, terminal.value, me, event.messageId, before)));
    } else {
      let text = clampReply(stripMarkdown(modelText));
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

  /**
   * The outbound(s) for a terminal tool result. Everything is one group
   * message, except a policy auto-approval, which the approval handler turns
   * into the receipt card plus the ticket DMs (or the failure line).
   */
  async function renderTerminal(
    r: Resolved,
    value: unknown,
    me: Member,
    messageId: MessageId,
    auditBefore: ReadonlySet<string>,
  ): Promise<readonly Outbound[]> {
    if (!isRecord(value)) return [];
    const kind = value['kind'];
    if (kind === 'auto_approved') {
      const res = value as Extract<ProposeResult, { kind: 'auto_approved' }>;
      return autoApproved(r, res.proposal, messageId, auditBefore);
    }
    const one = renderTerminalMessage(r, value, me);
    return one === undefined ? [] : [one];
  }

  /**
   * Flow 2 step 1 "auto_approve ⇒ skip to 4 with a synthetic complete grant":
   * the handler executes (it is the only caller of the executor, SAFETY §2.1)
   * and renders the result. If the hand-off itself throws, or no handler is
   * wired, the proposal is failed here (`booking.failed{stage:'execute'}`,
   * grant expired, expiry job cancelled) so a re-ask is not told "already
   * waiting for a 👍 above"; the line says "no charge" only when no
   * `booking.completed` was written for it this turn.
   */
  async function autoApproved(
    r: Resolved,
    proposal: BookingProposal,
    messageId: MessageId,
    auditBefore: ReadonlySet<string>,
  ): Promise<readonly Outbound[]> {
    const fail = (code: string): readonly Outbound[] => {
      const bought = auditIdsSince(r.group.groupId, auditBefore).some((id) => {
        const e = stores.group.audit.get(id);
        return e?.type === 'booking.completed' && e.proposalId === proposal.proposalId;
      });
      audit(r, {
        type: 'booking.failed',
        actor: { kind: 'trav', id: 'trav' },
        visibility: 'group',
        proposalId: proposal.proposalId,
        idempotencyKey: proposal.idempotencyKey,
        payload: {
          errorCode: code,
          retriable: true,
          stage: 'execute',
          moneyMoved: bought,
          messageId,
        },
      });
      const current = stores.group.bookings.getProposal(proposal.proposalId);
      if (current !== undefined && current.status === 'pending') {
        // Bought ⇒ the audit log already proves a completed booking: never leave it "pending".
        stores.group.bookings.updateProposal({
          ...current,
          status: bought ? 'completed' : 'failed',
        });
        const grant = stores.group.bookings.getGrantForProposal(proposal.proposalId);
        if (!bought && grant !== undefined && grant.status === 'pending') {
          stores.group.bookings.saveGrant(approval.expireGrant(grant, r.now));
        }
        scheduler.cancel(`proposal_expiry:${proposal.proposalId}`);
      }
      return [message(r, bought ? TURN_FAILED_AFTER_PURCHASE_TEXT : AUTO_APPROVE_FAILED_TEXT)];
    };
    if (deps.approval === undefined) return fail('approval_handler_not_wired');
    try {
      return await deps.approval.handler.autoApproved(proposal.proposalId, messageId);
    } catch (e) {
      return fail(e instanceof TravError ? e.code : 'failed');
    }
  }

  function renderTerminalMessage(
    r: Resolved,
    value: Record<string, unknown>,
    me: Member,
  ): OutboundMessage | undefined {
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
    // Pasted or forwarded content is data, never instructions (SAFETY §2.4);
    // flagged content is also never remembered.
    const split = splitQuoted(rawText);
    const quotedMatches = split.quoted.length > 0 ? detectInjection(split.quoted) : [];

    /**
     * What the next tool-enabled prompt may see of this message: a member's
     * own words (quoted lines replaced by a marker; only the marker when the
     * quote tripped the detector), a bare marker for a guest.
     */
    const recentText = (): string => {
      if (me === null) return GUEST_TEXT_MARKER;
      if (split.quoted.length === 0) return rawText;
      if (quotedMatches.length > 0 || split.remainder.length === 0) return PASTED_TEXT_MARKER;
      return `${split.remainder}\n${PASTED_TEXT_MARKER}`;
    };
    const recordInbound = (): void => {
      if (r.lane !== 'group') return;
      pushRecent(groupKey, {
        messageId: event.messageId,
        senderMemberId: me?.memberId ?? null,
        senderDisplayName:
          me?.displayName ??
          (r.identity.kind === 'guest' ? (r.identity.displayName ?? 'guest') : ''),
        text: recentText(),
        at: r.now,
        fromTrav: false,
      });
    };

    const myLaneKey = laneKey(r.group.groupId, r.lane, me?.memberId ?? null);
    const boundRef =
      event.replyToMessageId === undefined ? undefined : cards.get(event.replyToMessageId);
    const mentionCtx: MentionContext = {
      lane: r.lane,
      repliesToTrav:
        boundRef !== undefined ||
        (event.replyToMessageId !== undefined && isTravMessage(event.replyToMessageId)),
      platformMention: event.platformMention === true,
      ...(lastQuestionAt.get(myLaneKey) !== undefined
        ? { lastTravQuestionAt: lastQuestionAt.get(myLaneKey)! }
        : {}),
      now: r.now,
    };

    // 1. approval-shaped text ("yes", "nah", "not me"). It binds to the quoted
    // proposal card, else to the proposal card of Trav's question inside the
    // reply window, else the identity gate binds it (requester only). A quote-
    // reply to some other Trav card (a logged expense, a question) is a reply
    // to that card, not an approval of an unrelated proposal.
    const intent = classifyApprovalText(rawText);
    const askedRef =
      boundRef === undefined
        ? cardIndexFor(r.group.groupId).lastTravQuestion(r.lane, me?.memberId)
        : undefined;
    const boundProposalId = boundRef?.proposalId ?? askedRef?.proposalId;
    const approvalShaped =
      intent !== undefined && (boundRef === undefined || boundRef.proposalId !== undefined);
    if (approvalShaped && (boundProposalId !== undefined || pendingFor(r).length > 0)) {
      recordInbound();
      return routeApproval(
        r,
        event,
        intent,
        rawText,
        'text',
        boundProposalId,
        event.messageId,
        boundRef !== undefined || inReplyWindow(mentionCtx),
      );
    }

    // 1b. "undo" (bare or "@trav undo") from a member: the quoted logged-expense
    // card, else the latest logged-expense card in this group thread when it
    // is still inside the reply window (VOICE §4.4). A quote-reply to any
    // other card is not an undo of anything; past the window only 👎 or a
    // reply on the card itself undoes.
    if (me !== null && UNDO_TEXT.test(rawText)) {
      // A reply names its target: "undo" on anything but a logged-expense
      // card (a proposal, a plain Trav line, a member's message) undoes
      // nothing, and never falls back to the latest expense (T-066).
      if (event.replyToMessageId !== undefined) {
        recordInbound();
        return boundRef !== undefined && isLoggedExpenseCard(boundRef)
          ? undoExpense(r, boundRef, 'text', event.messageId)
          : silent('undo:not_expense');
      }
      const latest = r.lane === 'group' ? latestExpenseCard(r.group.groupId) : undefined;
      if (latest !== undefined && parseIso(r.now) - parseIso(latest.sentAt) <= REPLY_WINDOW_MS) {
        recordInbound();
        return undoExpense(r, latest, 'text', event.messageId);
      }
      // "@trav undo" with nothing in reach: one question (VOICE §4.11), not a
      // guess at an older line and not a model turn (there is no undo tool).
      if (EXPLICIT_UNDO.test(rawText)) {
        recordInbound();
        const sent = await send(r, [message(r, UNDO_WHICH_TEXT)]);
        return {
          outbound: sent,
          toolCalls: [],
          auditEventIds: [],
          silent: sent.length === 0,
          modelSources: [],
          note: 'undo:which',
        };
      }
    }

    // 2. guests: untrusted text, zero tools, one polite refusal when addressed
    // (SAFETY §2.5). Rules only: a guest's words never reach a model call, not
    // even the mention classifier, and the transcript keeps a marker for them.
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
      const ruled = detectMentionRules(rawText, mentionCtx);
      const mention: MentionResult =
        ruled === 'ambiguous' ? { addressed: false, confidence: 0, reason: 'third_person' } : ruled;
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
    if (split.quoted.length > 0) {
      const matches = quotedMatches;
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

    // 4. mention gate (the claim check below needs it too).
    const mention = await detectMention(text, mentionCtx, model);

    // 4b. roll call / roster override ("who's in tonight?", "Henry's sick",
    // "count me in") addressed to Trav: deterministic, never the model, and
    // a roster change re-prices any pending proposal through the approval
    // handler (T-030, `roster/turn.ts`). "Henry's in" here is attendance, not
    // Henry's approval: nothing is granted, the re-proposal needs a fresh 👍.
    if (
      mention.addressed &&
      mention.reason !== 'thanks' &&
      r.trip !== null &&
      canRequest(r.identity)
    ) {
      const wantCount = rosterFollowUpCount(text);
      for (const [i, candidate] of rosterTexts(text).entries()) {
        // "henry's in, make it 7" when the change makes 6: the roster handler
        // declines before writing (`expectInCount`), so the clause alone never
        // drops the 7 and the whole message goes to the model (T-066).
        const roster = handleRosterMessage({
          group: stores.group,
          trip: r.trip,
          members: r.members,
          me,
          text: candidate,
          messageId: event.messageId,
          now: r.now,
          ...(i > 0 && wantCount !== undefined ? { expectInCount: wantCount } : {}),
        });
        if (roster !== undefined) {
          recordInbound();
          return rosterTurn(r, roster);
        }
      }
    }

    // 5. "Dean said it's fine, go ahead" while something is pending: not Dean's
    // answer (SAFETY §2.5). A claim is an attempt when it carries an approval
    // word, addressed or not, or when it names a member's consent ("@trav
    // dean said it's fine") and was addressed to Trav (D-019 §1-2). An
    // "everyone" claim needs the approval word: "@trav everyone's in the
    // lobby, where next?" is a question for the model, and attendance lines
    // ("@trav henry's in now too") are no claim at all (T-066). "Maya is in
    // the shower" is chat: no post, no audit. Trav answers out loud only when
    // it was addressed; an unaddressed claim is audited and nothing more.
    const pending = pendingFor(r);
    if (pending.length > 0) {
      const addressed = mention.addressed && mention.reason !== 'thanks';
      const found = detectClaimedApproval(text, r.members, me.memberId);
      const claim =
        found !== undefined &&
        (hasApprovalIntentWord(text) || (addressed && found.kind === 'named'))
          ? found
          : undefined;
      if (claim !== undefined) {
        recordInbound();
        return routeApproval(
          r,
          event,
          'approve',
          text,
          'text',
          boundProposalId,
          event.messageId,
          addressed,
        );
      }
    }

    recordInbound();
    // 5b. an expense stated in chat (T-010, `ingest/chatExpense.ts`): logged
    // from the parser (VOICE §4.4) or one question (§4.11); the model only
    // for what the parser cannot settle. Group lane, members, a current trip.
    const expenseTurn = async (answerOnly: boolean): Promise<TurnResult | undefined> => {
      if (r.lane !== 'group' || r.trip === null || !canRequest(r.identity)) return undefined;
      const before = snapshotAudit(r.group.groupId);
      const res = await chatExpenses.handle(
        {
          group: r.group,
          members: r.members,
          trip: r.trip,
          me,
          messageId: event.messageId,
          text,
          at: event.receivedAt,
        },
        { answerOnly },
      );
      if (res === undefined) return undefined;
      const sent = await send(r, res.drafts);
      return {
        outbound: sent,
        toolCalls: [],
        auditEventIds: auditIdsSince(r.group.groupId, before),
        silent: sent.length === 0,
        modelSources: res.modelSources,
        note: res.note,
      };
    };
    if (!mention.addressed) {
      // T-010 r1 #7: Trav's open expense question to this member stays
      // answerable past the 2-minute reply window (its own TTL); only a short
      // reply to it is taken, nothing unaddressed is parsed fresh.
      if (chatExpenses.awaiting(r.group.groupId, me.memberId)) {
        const answered = await expenseTurn(true);
        if (answered !== undefined) return answered;
      }
      return silent(`mention:${mention.reason}`);
    }
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

    // 5b. a purchase whose receipt or tickets never landed: the "after the
    // purchase" failure line promised the next @ sorts it out (T-009 r2). The
    // repair goes out first, then the turn carries on with what the message
    // actually asked (T-009 r2 review #1).
    let resumedSent: TurnResult['outbound'] = [];
    let resumedAudit: TurnResult['auditEventIds'] = [];
    if (deps.approval !== undefined && r.trip !== null && r.lane === 'group') {
      const before = snapshotAudit(r.group.groupId);
      const resumed = await deps.approval.handler.resumeIncomplete(r.trip.tripId);
      if (resumed.length > 0) {
        resumedSent = await send(r, resumed);
        resumedAudit = auditIdsSince(r.group.groupId, before);
      }
    }
    const withResumed = (t: TurnResult): TurnResult =>
      resumedSent.length === 0
        ? t
        : {
            ...t,
            outbound: [...resumedSent, ...t.outbound],
            auditEventIds: [...new Set([...resumedAudit, ...t.auditEventIds])],
            silent: false,
          };

    const expense = await expenseTurn(false);
    if (expense !== undefined) return withResumed(expense);

    // 6. the model.
    return withResumed(await modelTurn(r, event, text, mention.reason));
  }

  /**
   * One roster turn: the roll call or the attendance line, unless the change
   * made the approval handler re-propose (or offer a late joiner a ticket), in
   * which case that card is the turn's one group message (VOICE §3.7) and
   * its "who" line carries the change.
   */
  async function rosterTurn(r: Resolved, result: RosterTurn): Promise<TurnResult> {
    const before = snapshotAudit(r.group.groupId);
    let drafts: Outbound[] = [message(r, result.text)];
    if (result.kind === 'changed' && deps.approval !== undefined) {
      const follow = await deps.approval.handler.rosterChanged(result.notice);
      const hasGroup = follow.some((o) => !isReaction(o) && o.to.kind === 'group');
      drafts = hasGroup ? [...follow] : [...drafts, ...follow];
    }
    const sent = await send(r, drafts);
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: `roster:${result.kind}`,
    };
  }

  function isTravMessage(messageId: MessageId): boolean {
    for (const list of recent.values()) {
      if (list.some((m) => m.messageId === messageId && m.fromTrav)) return true;
    }
    return false;
  }

  // ---------- undo (VOICE §4.4 "👎 to undo") ----------

  /**
   * Only a chat-logged expense card can be undone here. A "looks shared?" DM
   * card is also `expense_confirm` but `status: 'pending'`: its 👎 means "keep
   * private" and belongs to the pending-item flow, never to undo.
   */
  function isLoggedExpenseCard(ref: PendingCardRef): boolean {
    return ref.card.type === 'expense_confirm' && ref.card.status === 'logged';
  }

  function latestExpenseCard(groupId: GroupId): PendingCardRef | undefined {
    let best: PendingCardRef | undefined;
    for (const [id, ref] of cards) {
      if (!isLoggedExpenseCard(ref) || cardGroup.get(id) !== groupId) continue;
      if (best === undefined || parseIso(ref.sentAt) > parseIso(best.sentAt)) best = ref;
    }
    return best;
  }

  /**
   * Voids a chat-logged expense: `status: 'undone'`, no ledger entries (core
   * `ledger.buildLedgerEntries` yields none for an undone expense), one
   * `ledger.entry_deleted` event, one line back. Members only; within the
   * trip the expense belongs to; a second 👎 on the same card does nothing.
   */
  async function undoExpense(
    r: Resolved,
    ref: PendingCardRef,
    via: 'button' | 'reaction' | 'text',
    messageId: MessageId,
  ): Promise<TurnResult> {
    if (ref.card.type !== 'expense_confirm' || !isLoggedExpenseCard(ref))
      return silent('undo:not_expense');
    if (r.me === null || !canRequest(r.identity)) return silent('undo:guest');
    if (cardGroup.get(ref.messageId) !== r.group.groupId) return silent('undo:wrong_group');
    // One message that logged several expenses (T-010) carries them all in
    // `digestItems`; its one 👎 undoes every one still logged.
    const digest = ref.card.digestItems ?? [];
    const expenseIds = digest.length > 0 ? digest.map((d) => d.expenseId) : [ref.card.expenseId];
    const live = expenseIds
      .map((id) => stores.group.expenses.get(id))
      .filter((e): e is Expense => e !== undefined && e.status === 'logged');
    const expense = live[0];
    if (expense === undefined) {
      cards.delete(ref.messageId);
      cardGroup.delete(ref.messageId);
      return silent('undo:not_logged');
    }
    const trip = r.trip;
    if (trip === null || live.some((e) => e.tripId !== trip.tripId))
      return silent('undo:trip_over');
    // The card's Undo is for the payer and whoever logged it (`allowedMemberIds`
    // in render/expenseConfirm.ts); a 👎, a tap or "undo" from anyone else does
    // nothing (T-010 r1 #12).
    const me = r.me;
    const mayUndo = (e: Expense): boolean =>
      e.createdBy === me.memberId || e.paidBy.some((p) => p.memberId === me.memberId);
    if (!live.every(mayUndo)) return silent('undo:not_allowed');

    const before = snapshotAudit(r.group.groupId);
    const order = r.members.map((m) => m.memberId);
    for (const e of live) {
      const undone: Expense = { ...e, status: 'undone' };
      stores.group.expenses.replace(
        undone,
        ledger.buildLedgerEntries(undone, { memberOrder: order, participantsUniverse: order }),
      );
    }
    cards.delete(ref.messageId);
    cardGroup.delete(ref.messageId);
    for (const e of live) {
      audit(r, {
        type: 'ledger.entry_deleted',
        actor: { kind: 'member', id: r.me.memberId },
        visibility: 'group',
        payload: {
          expenseId: e.expenseId,
          memberId: r.me.memberId,
          before: { status: 'logged', amountMinor: e.amount.amountMinor },
          after: { status: 'undone' },
          messageId,
          cardMessageId: ref.messageId,
          via,
        },
      });
    }
    const payerOf = (e: Expense): string =>
      sanitizeInline(
        r.members.find((m) => m.memberId === e.paidBy[0]?.memberId)?.displayName ?? 'someone',
        40,
      );
    const item = (e: Expense): string =>
      `${formatMoney(e.amount)} ${sanitizeInline(e.description, 40).toLowerCase()}`;
    const onePayer = live.every((e) => payerOf(e) === payerOf(expense));
    const what = onePayer
      ? `${live.map(item).join(' and ')} on ${payerOf(expense)}`
      : live.map((e) => `${item(e)} on ${payerOf(e)}`).join(' and ');
    const sent = await send(r, [
      message(r, `undone: ${what}, ${live.length > 1 ? "they're" : "it's"} off the tab`),
    ]);
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: 'undo:done',
    };
  }

  // ---------- turn boundary (ARCHITECTURE §6) ----------

  /**
   * Nothing thrown inside a turn escapes: one audit event (`booking.failed`
   * with `stage: 'turn'`, ids only; no `agent.turn_failed` type exists in
   * core yet) and the VOICE §4.10 two-liner. Money never moves on these paths
   * without the approval handler, so "no charge went through" holds.
   */
  async function failTurn(
    r: Resolved | undefined,
    e: unknown,
    messageId: string | undefined,
    /** Audit ids before the turn: "no charge went through" is said only when no `booking.completed` landed since. */
    auditBefore: ReadonlySet<string> | undefined,
  ): Promise<TurnResult> {
    const code = e instanceof TravError ? e.code : 'failed';
    if (r === undefined) return silent(`error:${code}`);
    const auditEventIds: AuditEventId[] = [];
    let bought = false;
    try {
      bought =
        auditBefore !== undefined &&
        stores.group.audit
          .listByGroup(r.group.groupId)
          .some((ev) => !auditBefore.has(ev.id) && ev.type === 'booking.completed');
      auditEventIds.push(
        audit(r, {
          type: 'booking.failed',
          actor: { kind: 'trav', id: 'trav' },
          visibility: 'group',
          payload: {
            errorCode: code,
            retriable: true,
            stage: 'turn',
            lane: r.lane,
            moneyMoved: bought,
            ...(messageId !== undefined ? { messageId } : {}),
          },
        }),
      );
    } catch {
      // the audit store failing must not take the turn down with it
    }
    const sent = await send(r, [
      message(r, bought ? TURN_FAILED_AFTER_PURCHASE_TEXT : TURN_FAILED_TEXT),
    ]).catch((): readonly Outbound[] => []);
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds,
      silent: sent.length === 0,
      modelSources: [],
      note: `error:${code}`,
    };
  }

  // ---------- public ----------

  async function dispatch(r: Resolved, event: InboundEvent): Promise<TurnResult> {
    // 0. an answer to a "looks shared?" DM card (T-013, `ingest/pending.ts`):
    // the owner's Share it / Keep private / 👍 / 👎 / typed reply. Anyone
    // else touching the card is ignored silently.
    const share = matchShareAnswer(stores, {
      event,
      me: r.me,
      groupId: r.group.groupId,
      cardOf: (id) => cards.get(id)?.card,
    });
    if (share !== undefined) return shareTurn(r, share);
    switch (event.type) {
      case 'member_joined':
      case 'member_left':
        return silent(`membership:${event.type}`);
      case 'reaction': {
        if (event.removed) return silent('reaction:removed');
        const intent = reactionIntent(event.reaction);
        const ref = cards.get(event.targetMessageId);
        if (intent === 'decline' && ref !== undefined && isLoggedExpenseCard(ref))
          return undoExpense(r, ref, 'reaction', event.messageId);
        if (intent === undefined || ref?.proposalId === undefined)
          return silent('reaction:not_approval');
        return routeApproval(r, event, intent, '', 'reaction', ref.proposalId, event.messageId);
      }
      case 'button_tap': {
        const ref = cards.get(event.cardMessageId);
        if (event.actionId === 'undo' && ref !== undefined && isLoggedExpenseCard(ref))
          return undoExpense(r, ref, 'button', event.messageId);
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

  async function handleInbound(event: InboundEvent): Promise<TurnResult> {
    if (!remember(dedupeKey(event))) return silent('duplicate');
    let r: Resolved | undefined;
    let before: ReadonlySet<string> | undefined;
    try {
      r = resolve(event);
      if (r === undefined) return silent('unknown_conversation');
      before = snapshotAudit(r.group.groupId);
      return await dispatch(r, event);
    } catch (e) {
      return failTurn(r, e, 'messageId' in event ? event.messageId : undefined, before);
    }
  }

  async function runScheduled(job: ScheduledJob): Promise<TurnResult> {
    let before: ReadonlySet<string> | undefined;
    try {
      before = snapshotAudit(job.groupId);
      return await runScheduledJob(job);
    } catch (e) {
      const group = stores.group.groups.get(job.groupId);
      if (group === undefined) return silent(`error:${e instanceof TravError ? e.code : 'failed'}`);
      const now = clock.now();
      return failTurn(
        {
          group,
          members: stores.group.members.listByGroup(group.groupId),
          trip: stores.group.trips.current(group.groupId, now) ?? null,
          identity: { kind: 'guest', senderId: 'scheduler' },
          me: null,
          lane: 'group',
          now,
        },
        e,
        job.jobId,
        before,
      );
    }
  }

  async function runScheduledJob(job: ScheduledJob): Promise<TurnResult> {
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
    for (const [id, ref] of cards) {
      if (ref.proposalId !== proposalId) continue;
      cards.delete(id);
      cardGroup.delete(id);
    }
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

  // ---------- card charges and "looks shared?" answers (T-013, `ingest/card.ts`, `ingest/pending.ts`) ----------

  async function shareTurn(r: Resolved, share: ShareMatch): Promise<TurnResult> {
    if (share.kind === 'ignore') return silent(share.note);
    if (r.me === null) return silent('looks_shared:guest');
    const before = snapshotAudit(r.group.groupId);
    const res =
      share.kind === 'which'
        ? { drafts: [whichCharge(ids, r.group.groupId, r.me.memberId)], note: 'looks_shared:which' }
        : answerShare({ stores, clock, ids }, share, {
            group: r.group,
            members: r.members,
            trip: r.trip,
            me: r.me,
          });
    const sent = await send(r, res.drafts);
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: res.note,
    };
  }

  async function importCardTransactions(input: CardImportRequest): Promise<CardImportResult> {
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
    const outcome = await importCards(input, { stores, clock, ids, model, group, members, trip });
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
      ...outcome,
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: `cards:${outcome.status}`,
    };
  }

  async function importEmailReceipts(input: EmailImportRequest): Promise<EmailImportResult> {
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
    const outcome = await importEmails(input, { stores, clock, ids, model, group, members, trip });
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
      ...outcome,
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: `emails:${outcome.status}`,
    };
  }

  return {
    handleInbound,
    runScheduled,
    intakeDocument,
    importCardTransactions,
    importEmailReceipts,
    pendingCards,
  };
}
