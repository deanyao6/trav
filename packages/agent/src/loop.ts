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
 *     "Chase is in the shower" is chat and gets nothing, not even audit
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
  RecapCard,
  RichCard,
  ScheduledJob,
  Scheduler,
  Stores,
  Trip,
} from '@trav/core';
import {
  approval,
  formatMoney,
  isReaction,
  isSettlementPending,
  ledger,
  money,
  parseIso,
  safety,
  TravError,
} from '@trav/core';
import type {
  AlbumAdapter,
  ChannelAdapter,
  ChannelHandle,
  FxRatesAdapter,
  InboundEvent,
  InboundMessage,
  VenuesAdapter,
  TransactionsAdapter,
} from '@trav/adapters';
import type {
  ApprovalEvent,
  ApprovalHandler,
  NormalizeResult,
  PendingCardIndex,
  PendingCardRef,
} from './approval/events.js';
import { followSupersededBy, isOwnCancelText } from './approval/events.js';
import {
  APPROVE_TEXT_ALIASES,
  DECLINE_TEXT_ALIASES,
  NOT_ME_TEXT_ALIASES,
  approvalCounts,
  nearMissKind,
  nearMissReply,
  type NearMissKind,
} from './approval/whitelist.js';
import {
  AUTO_APPROVE_FAILED_TEXT,
  TURN_FAILED_AFTER_PURCHASE_TEXT,
  TURN_FAILED_TEXT,
} from './approval/text.js';
import { autoBuyVerdict } from './booking/autoBuy.js';
import { pickTextIndex, planLive } from './booking/choice.js';
import type { ProposalService, ProposeResult } from './booking/proposals.js';
import { bookingHeadline, nightOf } from './booking/proposals.js';
import { optionIndexOf } from './booking/flights.js';
import type { BookingExecutor, ProviderRegistry } from './booking/executor.js';
import { buildGroupContext, renderGroupPrompt, sanitizeInline } from './context/groupContext.js';
import { createChatExpenseFlow } from './ingest/chatExpense.js';
import { foreignOriginal } from './render/expenseConfirm.js';
import {
  createReceiptFlow,
  receiptAttachment,
  type ReceiptImageReader,
  type ReceiptOutcome,
} from './ingest/receipt.js';
import {
  importCardTransactions as importCards,
  type CardImportInput,
  type CardImportOutcome,
} from './ingest/card.js';
import { atCardImportSlot, cardImportJobsFor, nextCardImportJob } from './ingest/cardSchedule.js';
import {
  importEmailReceipts as importEmails,
  type EmailImportInput,
  type EmailImportOutcome,
} from './ingest/email.js';
import { answerShare, matchShareAnswer, whichCharge, type ShareMatch } from './ingest/pending.js';
import { LEFT_LOOKBACK_MIN } from './ingest/riders.js';
import {
  importOffText,
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
import type { OutboundSendOptions, SendOutcome } from './outbound/send.js';
import { composeWrapped } from './recaps/wrapped.js';
import { composeMorningAfter, nextMorningAfterJob, RECAP_STALE_MS } from './recaps/morningAfter.js';
import { dropRecapPhoto, parseDropPhoto, type DropPhotoRequest } from './recaps/dropPhoto.js';
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
import { bundledVenueIndex } from './model/offline/asks.js';
import { isKnownPlace, renderVenueCheck, type VenueSearchResult } from './roster/combined.js';
import { handleRosterMessage, type RosterTurn } from './roster/turn.js';
import {
  announceFamilyMode,
  createSettingsFlow,
  type SettingsOutcome,
  type SettingsTurnContext,
} from './settings/flow.js';
import { balancesFor, renderSettleUpFor } from './tools/ledger.js';
import { createSettleFlow } from './settle/flow.js';
import { settleReplyAction, type SettleAction } from './settle/actions.js';
import { WHICH_ROW_TEXT, type PendingAsk } from './settle/profiles.js';
import {
  myPositionText,
  NO_TRIP_BALANCE_TEXT,
  parseBalanceAsk,
  type BalanceAskKind,
} from './balances/ask.js';
import type { ToolRegistry } from './tools/registry.js';
import type { TurnToolContext } from './tools/shared.js';
import { detectInjection, stripInvisible } from './untrusted.js';
import { createExpenseNotices } from './notices/expenseNotices.js';
import { createSuggestFlow, parseSuggestAsk } from './tiers/suggest.js';
import type { SuggestOutcome, SuggestTurnInput } from './tiers/suggest.js';
import type { GroupLine, TravelFact } from './tiers/signals.js';

// ---------- dependencies ----------

export interface TurnSendContext {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly lane: 'group' | 'dm';
  /** Channel handle for a member's DM lane. */
  handleFor(memberId: MemberId): ChannelHandle | undefined;
  /** Per-message screen facts (e.g. Wrapped's `roastLines`, T-016); optional for senders that ignore it. */
  optionsFor?(outbound: Outbound): OutboundSendOptions | undefined;
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
  /** Shared album (T-029) for Wrapped's photos and The Photographer; absent ⇒ no photos. */
  readonly album?: AlbumAdapter;
  /** Prompt templates; default `GROUP_CHAT_PROMPT` / `DM_CHAT_PROMPT`. */
  readonly prompts?: { readonly group: PromptTemplate; readonly dm: PromptTemplate };
  /** Max model round-trips per turn (tool loop cap). Default 6. */
  readonly maxToolRounds?: number;
  /** Recent group messages kept per conversation for the prompt. Default 20. */
  readonly recentMessageLimit?: number;
  /** Receipt photo reader (T-011); default reads only the repo's `fixtures/` and `.trav/attachments/`. */
  readonly readReceiptImage?: ReceiptImageReader;
  /**
   * The linked-card provider (T-067; the runtime's is the Plaid-shaped mock on
   * the simulated clock). Absent ⇒ no scheduled card imports, and
   * `importCardTransactions` needs an explicit `adapter`.
   */
  readonly transactions?: TransactionsAdapter;
  /**
   * Reference FX rates (T-084; the runtime's is the mock table, never live).
   * Absent ⇒ an amount in another currency is asked about in the trip currency.
   */
  readonly fx?: FxRatesAdapter;
  /**
   * Restaurants, bars and things to do (T-167; the runtime's is the mock
   * catalog). Read-only. Absent ⇒ suggestion asks go to the model.
   */
  readonly places?: VenuesAdapter;
  /** Structured flights and stays per group for the spending tier (T-167); default none. */
  readonly travelFacts?: (groupId: GroupId) => readonly TravelFact[];
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
  /** T-090: the import consent the owner hasn't turned on; nothing was read or stored. */
  readonly consentMissing?: 'cardImport' | 'emailImport';
}

/** One card-transaction import for one owner in one group (T-013, `ingest/card.ts`). */
export interface CardImportRequest extends Omit<CardImportInput, 'adapter'> {
  readonly groupId: GroupId;
  /**
   * The provider to sync from. Omitted ⇒ the runtime's own (`AgentDeps.transactions`)
   * from the owner's saved cursor (the one the scheduled `card_import` job uses
   * too), unless `cursor` is given.
   */
  readonly adapter?: TransactionsAdapter;
  /**
   * T-090: the owner asked for this sync (the simulator's DM-rail card). With
   * `cardImport` off, one DM line says how to turn it on; nothing is read.
   * Scheduled imports never set it (no unsolicited DMs).
   */
  readonly consentHint?: boolean;
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
/** A proposal card the family screen held back: withdrawn, nothing booked (VOICE §4.12 C, all-ages wording). */
export const UNDELIVERED_PROPOSAL_TEXT =
  "that one's not all-ages, so i won't set it up in this chat. nothing's booked, no charge";
/** A proposal card that failed to send (channel error, no DM lane): withdrawn, nothing booked (T-148 #7). */
export const UNSENT_PROPOSAL_TEXT =
  "that card didn't go through, so i dropped it. nothing's booked, no charge. @ me to try again";
const TRAV_ACTOR = { kind: 'trav', id: 'trav' } as const;
/** A second `request_settings_change` in one turn: the first one's question comes first. */
export const ONE_SETTING_AT_A_TIME_TEXT =
  'one setting at a time. answer the first one, then ask again';
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
/** Member group lines kept per group for a ride receipt's "who left" read (T-135). */
const RIDE_LINES_CAP = 300;
const SEEN_CAP = 5000;
/** Member chat times kept per group for the Morning After signal (T-015): 2 days, at most 2000. */
const CHAT_TIMES_KEEP_MS = 48 * 60 * 60 * 1000;
const CHAT_TIMES_CAP = 2000;

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
  'settings_turn',
  'needs_confirmation',
  // T-074: the group flight options card, posted as computed (never paraphrased).
  'flight_options',
  // T-168 (b): the ticket options card; the asker's pick is the approval.
  'ticket_options',
]);

const PROPOSAL_ACTIONS: readonly Action[] = [
  {
    id: 'approve',
    label: 'Approve',
    style: 'primary',
    tapback: '👍',
    // VOICE §6.2 only; a bare "ok" in unrelated chat must never buy tickets.
    textAliases: APPROVE_TEXT_ALIASES,
  },
  {
    id: 'not_me',
    label: 'Not me',
    style: 'secondary',
    textAliases: NOT_ME_TEXT_ALIASES,
  },
  {
    id: 'decline',
    label: 'Decline',
    style: 'destructive',
    tapback: '👎',
    textAliases: DECLINE_TEXT_ALIASES,
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
/** "cancel that" quoting a Trav card that is no proposal (T-137 r1 #1): nothing is dropped. */
export const QUOTED_RECEIPT_CANCEL_TEXT =
  "that one's already booked, so there's nothing waiting to drop";
export const QUOTED_EXPENSE_CANCEL_TEXT =
  "that's a logged expense, not a booking. reply undo on it to take it off the tab";
export const QUOTED_CARD_CANCEL_TEXT = "nothing's waiting on that one, so there's nothing to drop";

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
 * lol:", "forwarded by chase:"). "fwd this to henry pls" is a sentence, not a
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
/** "too", "now too", "after all": filler on an attendance line. A bare "now" is not ("crowley is going now" means leaving). */
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
 * which can ask (T-066). A leading headcount ("it's the 5 of us tonight,
 * henry's out") is a combined roster sentence instead: the roster handler
 * parses the whole message (`roster/combined.ts`, T-082).
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

export function createTravAgent(input: AgentDeps): TravAgent {
  // T-165: every expense committed during an operation gets one group notice
  // (`notices/expenseNotices.ts`); the wrapped send path notes which ones a
  // group card already announced. Every send below goes through it.
  const notices = createExpenseNotices({
    stores: input.stores,
    clock: input.clock,
    ids: input.ids,
    sendTurn: input.sendTurn,
    scheduler: input.scheduler,
  });
  const deps: AgentDeps = { ...input, sendTurn: notices.sendTurn };
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
  /** Trav's newest card in each group thread (any type): what a bare text pick may bind to (T-168). */
  const newestGroupCard = new Map<GroupId, PendingCardRef>();
  /** Which group each card was sent in: the index never answers across groups. */
  const cardGroup = new Map<MessageId, GroupId>();
  const guestsTold = new Set<string>();
  /**
   * When members spoke in each group thread (T-015's "chat after midnight"
   * night-out signal). Times only, never text; guests and DMs never count.
   */
  const chatTimes = new Map<GroupId, IsoDateTime[]>();
  const noteChatTime = (groupId: GroupId, at: IsoDateTime): void => {
    const cutoff = parseIso(at) - CHAT_TIMES_KEEP_MS;
    const list = (chatTimes.get(groupId) ?? []).filter((t) => parseIso(t) >= cutoff);
    list.push(at);
    chatTimes.set(groupId, list.slice(-CHAT_TIMES_CAP));
  };
  /** Expense from chat text (T-010): parser first, one question when a money fact is missing. */
  const chatExpenses = createChatExpenseFlow({
    stores,
    model,
    ids,
    clock,
    ...(deps.fx !== undefined ? { fx: deps.fx } : {}),
  });
  /** Receipt photo → "who had what?" → itemized split on the poster's 👍 (T-011). */
  const receipts = createReceiptFlow({
    stores,
    model,
    ids,
    clock,
    ...(deps.readReceiptImage !== undefined ? { readImage: deps.readReceiptImage } : {}),
  });
  /** Settings, consent, roast mode and roast requests (T-017): rules only, never the model. */
  const settings = createSettingsFlow({ stores, clock, ids });
  /** Settle-up (T-166): final card + payer DMs, Sent → Got it, payment profiles. Rules only. */
  const settleFlow = createSettleFlow({
    stores,
    ids,
    clock,
    ...(deps.fx !== undefined ? { fx: deps.fx } : {}),
  });

  /** Place suggestions shaped by spending tier, and the one "fancy or casual?" (T-167). Rules only. */
  const suggestions = createSuggestFlow({
    stores,
    groupMemory: deps.groupMemory,
    memberMemory: deps.memberMemory,
    ...(deps.places !== undefined ? { places: deps.places } : {}),
    ...(deps.travelFacts !== undefined ? { travelFacts: deps.travelFacts } : {}),
  });

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
   * T-135: members' own group-thread lines from the last night out, for a
   * ride receipt's rider count (`ingest/riders.ts`, "who left the group").
   * Separate from `recent` (20 lines, busy nights push it out): every member
   * line of the last `LEFT_LOOKBACK_MIN`, at most `RIDE_LINES_CAP`. Same text
   * `recent` keeps (markers for pasted/guest text); never sent to a model.
   */
  const rideLines = new Map<GroupId, GroupMessageSummary[]>();
  const noteRideLine = (groupId: GroupId, summary: GroupMessageSummary): void => {
    if (summary.senderMemberId === null || summary.fromTrav) return;
    const cutoff = parseIso(summary.at) - LEFT_LOOKBACK_MIN * 60_000;
    const list = (rideLines.get(groupId) ?? []).filter((m) => parseIso(m.at) >= cutoff);
    list.push(summary);
    rideLines.set(groupId, list.slice(-RIDE_LINES_CAP));
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

  async function send(
    r: Resolved,
    drafts: readonly Outbound[],
    optionsFor?: TurnSendContext['optionsFor'],
  ): Promise<readonly Outbound[]> {
    if (drafts.length === 0) return [];
    const outcomes = await deps.sendTurn(drafts, {
      ...sendCtx(r),
      ...(optionsFor !== undefined ? { optionsFor } : {}),
    });
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
        // T-168 r1 #1-2: a bare text pick binds only to Trav's newest group card.
        if (msg.to.kind === 'group') newestGroupCard.set(r.group.groupId, ref);
        cardGroup.set(msg.id, r.group.groupId);
        if (/\?/.test(msg.text)) lastQuestionRef.set(key, ref);
      }
      if (/\?/.test(msg.text)) lastQuestionAt.set(key, r.now);
    }
    // A proposal card the outbound screen held back (a family group's
    // minor_alcohol / minor_nightlife screen) was never seen, so it can never
    // be approved: the proposal is withdrawn, its hold released, and one
    // all-ages line says nothing was booked (T-081 r1 #1, VOICE §4.12 C).
    // A card that never went out for any other reason (a channel error, a
    // DM with no lane) is withdrawn the same way, with its own line (T-148 #7).
    let screened = false;
    let failed = false;
    for (const o of outcomes) {
      if (o.sent !== null || isReaction(o.outbound)) continue;
      const card = o.outbound.card;
      if (card?.type !== 'booking_proposal') continue;
      if (!(await withdrawUndelivered(card.proposalId))) continue;
      if (o.suppressed) screened = true;
      else failed = true;
    }
    const notes = [
      ...(screened ? [UNDELIVERED_PROPOSAL_TEXT] : []),
      ...(failed ? [UNSENT_PROPOSAL_TEXT] : []),
    ];
    if (notes.length > 0) sent.push(...(await send(r, [message(r, notes.join('\n'))])));
    return sent;
  }

  /** Withdraws a pending proposal whose card was never delivered. True when it was pending. */
  async function withdrawUndelivered(proposalId: string): Promise<boolean> {
    const proposal = stores.group.bookings.getProposal(proposalId);
    if (proposal === undefined || proposal.status !== 'pending') return false;
    const grant = stores.group.bookings.getGrantForProposal(proposalId);
    if (grant !== undefined && (grant.status === 'pending' || grant.status === 'complete')) {
      const invalidated = approval.invalidateGrant(grant, 'policy_changed');
      stores.group.bookings.saveGrant(invalidated);
      const input = approval.invalidatedAuditInput(invalidated, proposal, TRAV_ACTOR);
      stores.group.audit.append({
        ...input,
        payload: { ...input.payload, reason: 'card_not_delivered' },
      });
    }
    stores.group.bookings.updateProposal({ ...proposal, status: 'rejected' });
    scheduler.cancel(`proposal_expiry:${proposalId}`);
    await deps.proposals.releaseHold(proposal);
    for (const [id, ref] of cards) {
      if (ref.proposalId !== proposalId) continue;
      cards.delete(id);
      cardGroup.delete(id);
    }
    return true;
  }

  /**
   * Approvals only resolve against proposals whose card actually went out
   * (`message.sent` carries its id). A policy auto-approval never has a card:
   * its "say yes and i'll retry" line is the only thing to answer.
   */
  function delivered(proposalId: string): boolean {
    if (decisionFor(proposalId)?.outcome === 'auto_approve') return true;
    return stores.group.audit.listByProposal(proposalId).some((e) => e.type === 'message.sent');
  }

  /** The proposal's card went out (its latest `message.sent`) within the 2-minute reply window. */
  function cardSentWithinWindow(proposalId: string, now: IsoDateTime): boolean {
    const sent = stores.group.audit
      .listByProposal(proposalId)
      .filter((e) => e.type === 'message.sent')
      .at(-1);
    if (sent === undefined) return false;
    const delta = parseIso(now) - parseIso(sent.ts);
    return delta >= 0 && delta <= REPLY_WINDOW_MS;
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
    const unit = p.kind === 'flight' ? 'traveler' : 'ticket';
    return `${i + 1}. ${bookingHeadline(p)} · ${formatMoney(money(p.totalMinor, p.currency))} · ${p.attendees.length} ${unit}${p.attendees.length === 1 ? '' : 's'}`;
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
    /** T-182: a near-miss answer to the card (`nearMissKind`), which never approves. */
    nearMiss?: NearMissKind,
  ): Promise<TurnResult> {
    const before = snapshotAudit(r.group.groupId);
    // Only proposals whose card actually reached the chat can be approved: a
    // bare "yes" never lands on a card nobody saw (T-081 r1 #1).
    const pending = pendingFor(r).filter((p) => delivered(p.proposalId));
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
          ...(claim?.kind === 'proxy' ? { claimedForAll: claim.others } : {}),
          // T-132 r2 review #4: a with-self claim from a non-approver keeps who it was for.
          ...(claim?.kind === 'with_self'
            ? { claimedForAll: claim.others, group: claim.group }
            : {}),
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
        claim === undefined
          ? {}
          : {
              claimKind: claim.kind,
              ...(claim.kind === 'proxy' || claim.kind === 'with_self'
                ? { claimedForAll: claim.others }
                : {}),
              ...(claim.kind === 'with_self' ? { group: claim.group } : {}),
            },
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

    // T-182: only a whitelisted reply approves by text (`approval/whitelist.ts`).
    const counts =
      intent !== 'approve' ||
      (nearMiss === undefined &&
        approvalCounts({
          via,
          intent,
          text,
          ...(event.type === 'message' && event.forwarded === true ? { forwarded: true } : {}),
        }));

    // "i approve for me and henry": the part said for anyone else is audited
    // and never counts (SAFETY §2.5, T-132). Since T-182 the sender's own part
    // doesn't count either: it isn't an exact reply (`whitelisted: false`).
    if (gate.relayedFor !== undefined) {
      invalid('claimed_for_other', gate.proposal.proposalId, {
        claimedFor: gate.relayedFor.others.length === 1 ? gate.relayedFor.others[0]! : null,
        claimedForAll: gate.relayedFor.others,
        claimKind: 'with_self',
        group: gate.relayedFor.group,
        partial: true,
        whitelisted: counts,
        addressed,
      });
    }
    if (!counts) {
      if (gate.relayedFor === undefined) {
        invalid('not_whitelisted', gate.proposal.proposalId, {
          addressed,
          ...(nearMiss !== undefined ? { nearMiss } : {}),
        });
      }
      if (!addressed) return finish([], 'approval:not_whitelisted');
      const sent = await send(r, [
        message(r, nearMissReply(nearMiss ?? 'generic', gate.relayedFor !== undefined)),
      ]);
      return finish(sent, 'approval:not_whitelisted');
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
    } else if (
      normalized.kind === 'none' &&
      via === 'text' &&
      event.type === 'message' &&
      intent !== 'approve'
    ) {
      // "actually nah, staying in. cancel that" (T-137) is not a whole-message
      // alias, so the normalizer has no event for it; the loop has already
      // bound it to the sender's own proposal. A decline never spends. An
      // approval never takes this path (T-182: only a whitelisted reply,
      // which the normalizer always reads).
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

  /**
   * [Option N] on the flight options card (T-074): the same proposal as
   * "@trav book option N" (`propose_booking` kind flight), requested by the
   * tapper, rendered like any terminal proposal result. A guest, a minor's
   * policy, a stale card (another search replaced it) and an unknown option
   * all end in the proposal service's own answer; nothing is bought here.
   */
  async function pickFlightOption(
    r: Resolved,
    ref: PendingCardRef,
    value: string | undefined,
    messageId: MessageId,
  ): Promise<TurnResult> {
    const me = r.me;
    if (me === null || me.role === 'guest' || r.lane !== 'group') return silent('pick:not_member');
    const option = optionIndexOf(value, ref.cardId);
    if (option === undefined) return silent('pick:no_option');
    const before = snapshotAudit(r.group.groupId);
    const res = await deps.proposals.propose(
      // The tapped card's own plan (its cardId): an older card never books the latest plan.
      {
        kind: 'flight',
        option,
        planId: ref.cardId,
        requestText: `tapped option ${String(option)}`,
      },
      {
        groupId: r.group.groupId,
        tripId: r.trip?.tripId ?? null,
        requestedBy: me.memberId,
        sourceMessageId: messageId,
      },
    );
    const drafts = await renderTerminal(r, res, me, messageId, before);
    const sent = await send(r, drafts);
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: `pick:${res.kind}`,
    };
  }

  /**
   * A pick on a ticket options card (T-168 b): a tap, or an exact "2" /
   * "option 2" bound to the card. The proposal service re-quotes that option
   * through the policy; the asker's own pick on a live card is the approval
   * (`pick` tier), anyone else's is a card that needs a 👍. A guest, a minor
   * (the policy), a DM and a stale card all end in the service's answer or
   * silence; nothing is bought here.
   */
  async function pickTicketTurn(
    r: Resolved,
    planId: string,
    option: number | undefined,
    messageId: MessageId,
  ): Promise<TurnResult> {
    const me = r.me;
    if (me === null || me.role === 'guest' || r.lane !== 'group') return silent('pick:not_member');
    if (option === undefined) return silent('pick:no_option');
    const before = snapshotAudit(r.group.groupId);
    const res = await deps.proposals.pickTicketOption(planId, option, {
      groupId: r.group.groupId,
      pickedBy: me.memberId,
      sourceMessageId: messageId,
    });
    const drafts = await renderTerminal(r, res, me, messageId, before);
    const sent = await send(r, drafts);
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: `pick:ticket:${res.kind}`,
    };
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
      { group: stores.group, clock },
      r.group.groupId,
      r.trip?.tripId ?? null,
      { recentMessages: recent.get(key) ?? [], recentMessageLimit: recentLimit },
    );
    const prompt = renderGroupPrompt(ctx, template, { lane: r.lane === 'dm' ? 'dm' : 'group' });
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
    // `request_settings_change` goes through the settings flow (T-017): the
    // flow's own messages (its "yes to confirm?", its refusals) are what this
    // turn sends. One settings change per turn.
    let settingsOutcome: SettingsOutcome | undefined;
    // T-168 item 0 (D-044): the only road to a purchase without a card is the
    // member's own words passing the auto-buy grammar. Computed here from the
    // raw message, never from anything the model says.
    const verdict =
      me.role === 'guest'
        ? undefined
        : autoBuyVerdict({
            text: event.text,
            index: bundledVenueIndex(),
            sender: me.displayName,
            roster: r.members
              .filter((m) => m.active && m.leftAt === undefined && m.role !== 'guest')
              .map((m) => m.displayName),
            lane: r.lane,
            ...(event.forwarded === true ? { forwarded: true } : {}),
            ...(event.replyToMessageId !== undefined ? { quotesMessage: true } : {}),
          });
    const toolCtx: TurnToolContext = {
      ...(verdict?.eligible === true ? { autoBuy: verdict } : {}),
      groupId: r.group.groupId,
      tripId: r.trip?.tripId ?? null,
      senderMemberId: me.memberId,
      senderId: event.sender,
      lane: r.lane,
      now: r.now,
      clock,
      ids,
      stores,
      ...(deps.fx !== undefined ? { fx: deps.fx } : {}),
      messageId: event.messageId,
      settings: {
        run(cmd) {
          if (settingsOutcome !== undefined) {
            return { text: ONE_SETTING_AT_A_TIME_TEXT, note: 'settings:one_per_turn' };
          }
          const out = settings.run(settingsCtx(r, me, event), cmd);
          settingsOutcome = out;
          const first = out.drafts.find((d): d is OutboundMessage => !isReaction(d));
          return { text: first?.text ?? '', note: out.note };
        },
      },
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

    if (
      settingsOutcome !== undefined &&
      terminal !== undefined &&
      isRecord(terminal.value) &&
      terminal.value['kind'] === 'settings_turn'
    ) {
      const out = await settingsTurn(r, settingsOutcome, before);
      return { ...out, toolCalls, modelSources: sources, note: `tool:${out.note}` };
    }

    const drafts: Outbound[] = [];
    let note = 'model:text';
    if (terminal !== undefined) {
      note = `tool:${terminal.name}:${String((terminal.value as Record<string, unknown>)['kind'])}`;
      drafts.push(...(await renderTerminal(r, terminal.value, me, event.messageId, before)));
    } else {
      let text = clampReply(stripMarkdown(modelText));
      const lastTool = results.at(-1);
      if (
        text.length === 0 &&
        lastTool?.name === 'get_balances' &&
        r.lane === 'group' &&
        r.trip !== null &&
        !(isRecord(lastTool.value) && 'error' in lastTool.value)
      ) {
        // "@trav settle now" (VOICE §4.6): the tab goes out as the settle_up
        // card (10-line limit), not as a 4-line reply.
        // T-166: the card, then one DM per payer on how to pay.
        const rctx = {
          groupId: r.group.groupId,
          members: r.members,
          timeZone: r.trip.timeZone,
          now: r.now,
          ids,
        };
        drafts.push(...(await settleFlow.finalSettle({ ctx: toolCtx, rctx, trip: r.trip })));
        note = 'tool:get_balances:settle_up';
        text = '';
      } else if (
        text.length === 0 &&
        lastTool?.name === 'get_balances' &&
        r.lane === 'dm' &&
        r.trip !== null &&
        !(isRecord(lastTool.value) && 'error' in lastTool.value)
      ) {
        // A DM is personal (T-101): the asker's own position, the same line
        // the rules path renders, never the group's transfer list.
        text = myPositionText({
          balances: balancesFor(toolCtx),
          me,
          members: stores.group.members.listByGroup(r.group.groupId),
          meIsMinor: safety.isMinor(me, r.now),
          groupListHint: true,
          lane: 'dm',
        });
        note = 'tool:get_balances:mine';
      } else if (text.length === 0) {
        const fallback = [...results]
          .reverse()
          .map((x) => resultText(x.value))
          .find((t) => t !== undefined);
        text = fallback ?? (results.length > 0 ? NOTHING_TO_ADD_TEXT : '');
        note = fallback !== undefined ? 'tool:text' : 'model:empty';
      }
      if (text.length > 0) drafts.push(message(r, text));
    }
    // An earlier terminal tool owns the turn; the settings flow's question or
    // answer still goes out after it, so a change never happens unsaid.
    if (settingsOutcome !== undefined) drafts.push(...settingsOutcome.drafts);

    const sent = await send(r, drafts);
    settingsOutcome?.afterSend?.(sent);
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
    if (kind === 'ticket_options') {
      // T-168 (b): 2-4 ticket options; a pick re-proposes through the policy.
      const res = value as Extract<ProposeResult, { kind: 'ticket_options' }>;
      return message(r, res.text, { card: res.card });
    }
    if (kind === 'flight_options') {
      // The ranked group flights (T-074): picked by "book option N", which
      // goes through propose_booking and the approval policy like any booking.
      const text = resultText(value);
      const card = resultCard(value);
      if (text === undefined) return undefined;
      return message(r, text, card !== undefined && card.type === 'options' ? { card } : {});
    }
    const text = resultText(value);
    return text === undefined ? undefined : message(r, text);
  }

  // ---------- messages ----------

  async function handleMessage(r: Resolved, event: InboundMessage): Promise<TurnResult> {
    const me = r.me;
    const groupKey = laneKey(r.group.groupId, 'group', null);
    const rawText = stripInvisible(event.text);
    if (r.lane === 'group' && me !== null && me.role !== 'guest')
      noteChatTime(r.group.groupId, r.now);
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
      const summary: GroupMessageSummary = {
        messageId: event.messageId,
        senderMemberId: me?.memberId ?? null,
        senderDisplayName:
          me?.displayName ??
          (r.identity.kind === 'guest' ? (r.identity.displayName ?? 'guest') : ''),
        text: recentText(),
        at: r.now,
        fromTrav: false,
      };
      pushRecent(groupKey, summary);
      if (me !== null && me.role !== 'guest') noteRideLine(r.group.groupId, summary);
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

    const intent = classifyApprovalText(rawText);

    // 0. the requester's yes/no to Trav's own "yes to confirm?" on a settings
    // change (T-017, `settings/flow.ts`): a reply to that question, or a bare
    // answer while it is still Trav's latest question in this lane, inside the
    // reply window, with no proposal requested since. Anything else is not it.
    if (me !== null && canRequest(r.identity) && (intent === 'approve' || intent === 'decline')) {
      const q = settings.pendingQuestion(r.group.groupId, me.memberId);
      const bare =
        q !== undefined &&
        event.replyToMessageId === undefined &&
        lastQuestionAt.get(myLaneKey) === q.askedAt &&
        parseIso(r.now) - parseIso(q.askedAt) <= REPLY_WINDOW_MS &&
        !pendingFor(r).some((p) => !q.proposalsAtAsk.has(p.proposalId));
      if (q !== undefined && (event.replyToMessageId === q.messageId || bare)) {
        const before = snapshotAudit(r.group.groupId);
        const out = settings.answer(settingsCtx(r, me, event), intent);
        if (out !== undefined) {
          recordInbound();
          return settingsTurn(r, out, before);
        }
      }
    }

    // 0b. a pick on a ticket options card (T-168 b): exactly "2" / "option 2"
    // / "@trav 2", quote-replying the card, or bare while that card is the
    // group's newest ticket options card and still live. Never forwarded.
    const pickIndex =
      r.lane === 'group' && me !== null && canRequest(r.identity) && event.forwarded !== true
        ? pickTextIndex(rawText)
        : undefined;
    if (pickIndex !== undefined) {
      // T-168 r1 #1-2: a quote-reply to the options card itself, or a bare pick
      // while that options card is Trav's newest card in the group (any later
      // card, a flight options card, a proposal, anything, makes it stale) and
      // still live. An unaddressed bare pick ("2") binds only while the options
      // card is the last message in the group thread: any later message, from
      // anyone (the picker, another member, Trav's plain text), makes a bare
      // digit need "@trav 2" or a quote-reply (T-168 r2 #1). The thread's last
      // entry is never dropped by the window cap, so this fails closed.
      const quoted =
        boundRef !== undefined ? deps.proposals.ticketChoice(boundRef.cardId) : undefined;
      const newest =
        event.replyToMessageId === undefined ? newestGroupCard.get(r.group.groupId) : undefined;
      const latest =
        newest !== undefined && newest.card.type === 'options'
          ? deps.proposals.ticketChoice(newest.cardId)
          : undefined;
      const addressed = /^\s*@trav\b/i.test(rawText) || event.platformMention === true;
      const cardIsLast =
        newest !== undefined && (recent.get(groupKey) ?? []).at(-1)?.messageId === newest.messageId;
      const bare =
        latest !== undefined && planLive(latest, r.now) && (addressed || cardIsLast)
          ? latest
          : undefined;
      const plan = quoted ?? bare;
      if (plan !== undefined) {
        recordInbound();
        return pickTicketTurn(r, plan.planId, pickIndex, event.messageId);
      }
    }

    // 1. approval-shaped text ("yes", "nah", "not me"). It binds to the quoted
    // proposal card, else to the proposal card of Trav's question inside the
    // reply window, else the identity gate binds it (requester only). A quote-
    // reply to some other Trav card (a logged expense, a question) is a reply
    // to that card, not an approval of an unrelated proposal.
    const askedRef =
      boundRef === undefined
        ? cardIndexFor(r.group.groupId).lastTravQuestion(r.lane, me?.memberId)
        : undefined;
    const boundProposalId = boundRef?.proposalId ?? askedRef?.proposalId;
    // T-182: a "yes" quote-replying a member's message answers that member, not
    // a proposal, and a forwarded "yes" is someone's old words: neither binds.
    const quotesMember =
      event.replyToMessageId !== undefined &&
      boundRef === undefined &&
      !isTravMessage(event.replyToMessageId);
    const approvalShaped =
      intent !== undefined &&
      event.forwarded !== true &&
      !quotesMember &&
      (boundRef === undefined || boundRef.proposalId !== undefined);
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

    // 1·. a quote-reply on the final settle card (T-166): "sent", "got it", "undo".
    if (me !== null && boundRef !== undefined && isFinalSettleCard(r, boundRef)) {
      const said = settleReplyAction(rawText);
      if (said !== undefined) {
        recordInbound();
        return settleTurn(r, boundRef, said, 'text', event.messageId);
      }
    }

    // 1a. "actually nah, staying in. cancel that" (T-137): the sender's own
    // pending proposal, dropped like their 👎. It binds only to a proposal the
    // sender asked for (a quote-reply to someone else's card, or nothing of
    // theirs pending, is not this), never to a completed booking. It counts
    // when it quotes the card, says "@trav", or comes inside the reply window
    // of the card going out; otherwise it is chat. A quote-reply binds to the
    // quoted card only: quoting anything but one of the sender's own proposal
    // cards (an expense, a receipt, a recap, a member's line) is not this
    // (T-137 r1 #1). Addressed by the window alone, it reaches only the
    // sender's cards that went out inside the window (r1 #3).
    if (me !== null && canRequest(r.identity) && r.lane === 'group' && isOwnCancelText(rawText)) {
      const own = pendingFor(r).filter(
        (p) => p.requestedBy === me.memberId && delivered(p.proposalId),
      );
      // Quoting a Trav card that is no proposal (a logged expense, a booking
      // receipt, a recap): never a cancel of some pending card, and never
      // handed to the model's cancel either. One line, nothing changes. A
      // still-open expense card (a receipt read, a looks-shared ask) keeps
      // its own flow below.
      // A quoted proposal card that is no longer pending (booked, expired,
      // dropped): same, one line; the model's cancel tool would otherwise drop
      // some other card of the sender's (T-137 r2 #1).
      const quotedProposal =
        boundRef?.proposalId === undefined
          ? undefined
          : stores.group.bookings.getProposal(boundRef.proposalId);
      const quotedDone =
        quotedProposal !== undefined &&
        quotedProposal.status !== 'pending' &&
        // a superseded card follows its replacement, as on a 👎
        quotedProposal.status !== 'superseded';
      if (
        boundRef !== undefined &&
        (quotedDone ||
          (boundRef.proposalId === undefined &&
            !(boundRef.card.type === 'expense_confirm' && boundRef.card.status !== 'logged') &&
            // "drop that one" on a recap is a photo drop (T-015), never a cancel (r2 #2).
            !(boundRef.card.type === 'recap' && /\bdrop\b/i.test(rawText))))
      ) {
        recordInbound();
        const line =
          boundRef.card.type === 'receipt' || quotedProposal?.status === 'completed'
            ? QUOTED_RECEIPT_CANCEL_TEXT
            : isLoggedExpenseCard(boundRef)
              ? QUOTED_EXPENSE_CANCEL_TEXT
              : QUOTED_CARD_CANCEL_TEXT;
        const before = snapshotAudit(r.group.groupId);
        const sent = await send(r, [message(r, line)]);
        return {
          outbound: sent,
          toolCalls: [],
          auditEventIds: auditIdsSince(r.group.groupId, before),
          silent: sent.length === 0,
          modelSources: [],
          note: 'cancel:quoted_not_a_proposal',
        };
      }
      let target: BookingProposal[];
      if (event.replyToMessageId !== undefined) {
        const quoted = boundRef?.proposalId;
        target = quoted === undefined ? [] : own.filter((p) => p.proposalId === quoted);
      } else if (hasAtTrav(rawText) || TRAV_VOCATIVE_PREFIX.test(rawText)) {
        target = own;
      } else {
        target = own.filter((p) => cardSentWithinWindow(p.proposalId, r.now));
      }
      if (target.length > 0) {
        recordInbound();
        return routeApproval(
          r,
          event,
          'decline',
          rawText,
          'text',
          target.length === 1 ? target[0]!.proposalId : undefined,
          event.messageId,
          true,
        );
      }
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

    // 1c. "@trav drop that one" (T-015): a member removes a recap photo, for
    // good (this recap's re-renders and Wrapped). Rules only, no model turn.
    const drop = me !== null && r.lane === 'group' ? parseDropPhoto(rawText) : undefined;
    if (drop !== undefined && me !== null) {
      const turn = await dropPhotoTurn(r, me, event, boundRef, drop);
      if (turn !== undefined) {
        recordInbound();
        return turn;
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

    // 4·. settings, consent and roast-mode commands, roast requests, and the
    // rule-made refusals (someone else's card; nightlife with a minor)
    // (T-017, `settings/flow.ts`). Deterministic, never the model. Unaddressed
    // text is only ever the roast kill switch, and only while roast mode is on.
    if (canRequest(r.identity)) {
      const before = snapshotAudit(r.group.groupId);
      const out = settings.command(
        settingsCtx(r, me, event),
        text,
        mention.addressed && mention.reason !== 'thanks',
      );
      if (out !== undefined) {
        recordInbound();
        return settingsTurn(r, out, before);
      }
    }

    // 4·· payment apps and handles (T-166): "my venmo is @chase-w" or "venmo
    // and zelle, venmo's my fave" in a DM is saved to the member's private
    // profile; a handle said to Trav in the group is not stored (one line).
    if (canRequest(r.identity) && event.forwarded !== true) {
      const before = snapshotAudit(r.group.groupId);
      const pay = await settleFlow.profileTurn({
        groupId: r.group.groupId,
        trip: r.trip,
        members: r.members,
        me,
        lane: r.lane,
        text,
        addressed: mention.addressed && mention.reason !== 'thanks',
        now: r.now,
      });
      if (pay !== undefined) {
        recordInbound();
        const sent = await send(r, pay.drafts);
        return {
          outbound: sent,
          toolCalls: [],
          auditEventIds: auditIdsSince(r.group.groupId, before),
          silent: sent.length === 0,
          modelSources: [],
          note: pay.note,
        };
      }
    }

    // 4a. a receipt photo, or words about one Trav just read ("who had what?",
    // T-011, `ingest/receipt.ts`). OCR text never reaches the tool loop; the
    // poster's 👍 on the card is what logs it.
    if (canRequest(r.identity)) {
      const addressed = mention.addressed && mention.reason !== 'thanks';
      const photo = receiptAttachment(event.attachments);
      const before = snapshotAudit(r.group.groupId);
      let res: ReceiptOutcome | undefined;
      if (photo !== undefined && (addressed || r.lane === 'dm')) {
        res = await receipts.photo({
          group: r.group,
          members: r.members,
          trip: r.trip,
          me,
          lane: r.lane,
          messageId: event.messageId,
          at: event.receivedAt,
          attachment: photo,
          text,
        });
      } else if (
        photo === undefined &&
        r.lane === 'group' &&
        receipts.wants(r.group.groupId, me.memberId, event.replyToMessageId)
      ) {
        res = receipts.text({
          group: r.group,
          members: r.members,
          trip: r.trip,
          me,
          messageId: event.messageId,
          at: event.receivedAt,
          text,
          addressed,
          otherPending: pendingFor(r).length > 0,
          mentioned:
            mention.addressed &&
            (mention.reason === 'at_mention' ||
              mention.reason === 'leading_name' ||
              mention.reason === 'reply_to_trav'),
          ...((): { lastMessageId?: MessageId } => {
            const last = (recent.get(groupKey) ?? []).at(-1)?.messageId;
            return last !== undefined ? { lastMessageId: last } : {};
          })(),
          ...(event.replyToMessageId !== undefined
            ? { replyToMessageId: event.replyToMessageId }
            : {}),
        });
      }
      if (res !== undefined) {
        recordInbound();
        return receiptTurn(r, res, before);
      }
    }

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
          // A place in a combined sentence (T-082) must be a venue the ticket
          // inventory knows: the same inventory `search_events` searches.
          isKnownPlace: (hint) => isKnownPlace(bundledVenueIndex(), hint),
        });
        if (roster !== undefined) {
          recordInbound();
          return rosterTurn(r, roster, event, me);
        }
      }
    }

    // 5. "Dean said it's fine, go ahead" while something is pending: not Dean's
    // answer (SAFETY §2.5). A claim is an attempt when it carries an approval
    // word, addressed or not, or when it names a member's consent ("@trav
    // dean said it's fine") and was addressed to Trav (D-019 §1-2). An
    // "everyone" claim needs the approval word: "@trav everyone's in the
    // lobby, where next?" is a question for the model, and attendance lines
    // ("@trav henry's in now too") are no claim at all (T-066). "Chase is in
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
      // 5a. T-182: a short answer to the card that isn't exactly one ("yes but
      // not for me", "i don't approve", "oh yeah sure"), said to Trav (quote-
      // reply, reply window, @trav): never an approval, one question back. The
      // gate binds it like a "yes" and the whitelist then refuses it.
      const nearMiss = addressed
        ? nearMissKind(
            text,
            r.members.map((m) => m.displayName),
          )
        : undefined;
      if (nearMiss !== undefined && pending.some((p) => delivered(p.proposalId))) {
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
          nearMiss,
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

    // 5c. balance asks ("@trav settle now", "who owes who", "what do i owe",
    // "how much have we spent so far"; T-091, T-085, T-101): rules, never a
    // scripted turn keyed on the sender, so any member in any group gets the
    // same answer in the group thread or a DM. Anything longer is the model's.
    // A quote-reply to a proposal or receipt card, or a proposal still open
    // inside the reply window, is about that booking's price (the ticket
    // share), not the ledger: the model's, with the proposal in context.
    const aboutBooking =
      boundRef?.proposalId !== undefined ||
      boundRef?.card.type === 'booking_proposal' ||
      boundRef?.card.type === 'receipt' ||
      askedRef?.proposalId !== undefined ||
      pendingFor(r).some((p) => parseIso(r.now) - parseIso(p.requestedAt) <= REPLY_WINDOW_MS);
    const balanceAsk = canRequest(r.identity) && !aboutBooking ? parseBalanceAsk(text) : undefined;
    if (balanceAsk !== undefined && r.trip === null) {
      const sent = await send(r, [message(r, NO_TRIP_BALANCE_TEXT)]);
      return withResumed({
        outbound: sent,
        toolCalls: [],
        auditEventIds: [],
        silent: sent.length === 0,
        modelSources: [],
        note: 'balances:no_trip',
      });
    }
    if (balanceAsk !== undefined) return withResumed(await balanceTurn(r, me, event, balanceAsk));

    // 5d. place suggestions and Trav's one "fancy or casual tonight?" (T-167,
    // `tiers/suggest.ts`): rules, never the model, and never a booking. The
    // answer to an open question first, then a fresh ask. A city with no
    // catalog falls through to the model.
    // Only a message that binds to a booking (a quote-reply to its card or
    // receipt, or an answer to its question) skips this; a proposal merely
    // open in the reply window does not (T-167 r1 #6).
    const boundToBooking =
      boundRef?.proposalId !== undefined ||
      boundRef?.card.type === 'booking_proposal' ||
      boundRef?.card.type === 'receipt' ||
      askedRef?.proposalId !== undefined;
    if (r.trip !== null && canRequest(r.identity) && !boundToBooking) {
      const sin: SuggestTurnInput = {
        group: r.group,
        trip: r.trip,
        members: r.members,
        me,
        lane: r.lane,
        messageId: event.messageId,
        now: r.now,
        groupLines: groupLinesFor(r),
      };
      const answered = await suggestions.answer(sin, text, {
        addressed: true,
        ...(event.replyToMessageId !== undefined
          ? { replyToMessageId: event.replyToMessageId }
          : {}),
      });
      if (answered !== undefined) return withResumed(await suggestTurn(r, sin, answered));
      const ask = parseSuggestAsk(text);
      if (ask !== undefined) {
        const out = await suggestions.ask(sin, ask);
        if (out !== undefined) return withResumed(await suggestTurn(r, sin, out));
      }
    }

    const expense = await expenseTurn(false);
    if (expense !== undefined) return withResumed(expense);

    // 6. the model.
    return withResumed(await modelTurn(r, event, text, mention.reason));
  }

  /** Members' own group-thread lines from the last 6 hours (stated wants, T-167). */
  function groupLinesFor(r: Resolved): GroupLine[] {
    const cutoff = parseIso(r.now) - 6 * 60 * 60_000;
    return (recent.get(laneKey(r.group.groupId, 'group', null)) ?? [])
      .filter((m) => !m.fromTrav && m.senderMemberId !== null && parseIso(m.at) >= cutoff)
      .map((m) => ({
        memberId: m.senderMemberId!,
        text: m.text,
        at: m.at,
        messageId: m.messageId,
      }));
  }

  /** One suggestion or question line in the lane it was asked in (T-167). */
  async function suggestTurn(
    r: Resolved,
    sin: SuggestTurnInput,
    out: SuggestOutcome,
  ): Promise<TurnResult> {
    const before = snapshotAudit(r.group.groupId);
    const sent = await send(r, [message(r, out.text)]);
    if (out.note === 'suggest:question') {
      const first = sent.find((o) => !isReaction(o));
      if (first !== undefined) suggestions.noteQuestionSent(sin, first.id);
    }
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: out.note,
    };
  }

  /**
   * A balance ask, from the group ledger only (`get_balances`' own read; no
   * private lane is consulted). Group "settle now" is the settle_up card
   * (VOICE §4.6); "who's paid for what so far" is the running settle_up card
   * with the total (T-085); "what do i owe", and every balance ask in a DM,
   * is the asker's own position (T-101). A minor only ever hears their own
   * line (VOICE §8: never a debtor or creditor).
   */
  async function balanceTurn(
    r: Resolved,
    me: Member,
    event: InboundMessage,
    ask: BalanceAskKind,
  ): Promise<TurnResult> {
    const trip = r.trip!;
    const before = snapshotAudit(r.group.groupId);
    const ctx = {
      groupId: r.group.groupId,
      tripId: trip.tripId,
      senderMemberId: me.memberId,
      senderId: event.sender,
      lane: r.lane,
      now: r.now,
      clock,
      ids,
      stores,
    };
    const rctx = {
      groupId: r.group.groupId,
      members: r.members,
      timeZone: trip.timeZone,
      now: r.now,
      ids,
    };
    let draft: OutboundMessage;
    let note: string;
    // T-166: the final card goes out with one DM per payer on how to pay.
    let payerDms: OutboundMessage[] = [];
    if (r.lane === 'group' && ask === 'settle') {
      const [card, ...dms] = await settleFlow.finalSettle({ ctx, rctx, trip });
      draft = card!;
      payerDms = dms;
      note = 'balances:settle_up';
    } else if (r.lane === 'group' && ask === 'tab') {
      // "who's paid for what so far" (T-085): the running tab with the total.
      draft = renderSettleUpFor(ctx, 'running', rctx, { showTotal: true });
      note = 'balances:tab';
    } else {
      // "what do i owe" anywhere, and every balance ask in a DM: the asker's
      // own position (T-101). A DM is personal; the group list stays in the
      // group, one "@trav settle now" away.
      const meIsMinor = safety.isMinor(me, r.now);
      const members = stores.group.members.listByGroup(r.group.groupId);
      const text = myPositionText({
        balances: balancesFor(ctx),
        me,
        members,
        meIsMinor,
        groupListHint: r.lane === 'dm' && ask !== 'mine',
        lane: r.lane,
      });
      draft = message(r, text);
      note = 'balances:mine';
    }
    const sent = await send(r, [draft, ...payerDms]);
    return {
      outbound: sent,
      toolCalls: ['get_balances'],
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note,
    };
  }

  /**
   * One roster turn: the roll call or the attendance line, unless the change
   * made the approval handler re-propose (or offer a late joiner a ticket), in
   * which case that card is the turn's one group message (VOICE §3.7) and
   * its "who" line carries the change.
   */
  async function rosterTurn(
    r: Resolved,
    result: RosterTurn,
    event: InboundMessage,
    me: Member,
  ): Promise<TurnResult> {
    const before = snapshotAudit(r.group.groupId);
    // A kept-off minor's stale in/maybe set to out (T-153) is a roster change too.
    const change = 'notice' in result ? result.notice : undefined;
    let text = result.text;
    const toolCalls: string[] = [];
    // "all 6, henry's back. razzmatazz" with Razzmatazz not on tonight's plan
    // (T-082): one read-only search, one more line on the same message.
    if (result.kind === 'party' && result.venue !== undefined && r.trip !== null) {
      const v = result.venue;
      let found: VenueSearchResult | undefined;
      if (tools.get('search_events') !== undefined) {
        toolCalls.push('search_events');
        try {
          found = (await tools.run(
            'search_events',
            { query: v.query, quantity: v.quantity },
            {
              groupId: r.group.groupId,
              tripId: r.trip.tripId,
              senderMemberId: me.memberId,
              senderId: event.sender,
              lane: r.lane,
              now: r.now,
              clock,
              ids,
              stores,
            },
          )) as VenueSearchResult;
        } catch {
          found = undefined;
        }
      }
      const tz = r.trip.timeZone;
      text = `${text}\n${renderVenueCheck(v.query, v.night, found, (at) => nightOf(at, tz))}`;
    }
    let drafts: Outbound[] = [message(r, text)];
    if (change !== undefined && deps.approval !== undefined) {
      const follow = await deps.approval.handler.rosterChanged(change);
      const hasGroup = follow.some((o) => !isReaction(o) && o.to.kind === 'group');
      drafts = hasGroup ? [...follow] : [...drafts, ...follow];
    }
    const sent = await send(r, drafts);
    // After a roster change, the family-mode notice is its own turn (VOICE §8, idempotent).
    const notice = change !== undefined && r.lane === 'group' ? await familyNotice(r) : [];
    const all = [...sent, ...notice];
    return {
      outbound: all,
      toolCalls,
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: all.length === 0,
      modelSources: [],
      note: `roster:${result.kind}`,
    };
  }

  /**
   * VOICE §8 "shown once in the group when it kicks in" after a roster change
   * (a join, a member's age updated by the host): `announceFamilyMode` is
   * idempotent (audited), so calling it on every roster change is safe.
   */
  async function familyNotice(r: Resolved): Promise<Outbound[]> {
    return [
      ...(await announceFamilyMode(
        { stores, clock, ids, sendTurn: deps.sendTurn },
        r.group.groupId,
      )),
    ];
  }

  // ---------- settings, consent, roast requests (T-017) ----------

  function settingsCtx(r: Resolved, me: Member, event: InboundMessage): SettingsTurnContext {
    return {
      group: r.group,
      members: r.members,
      trip: r.trip,
      me,
      lane: r.lane,
      now: r.now,
      messageId: event.messageId,
    };
  }

  async function settingsTurn(
    r: Resolved,
    out: SettingsOutcome,
    before: ReadonlySet<string>,
  ): Promise<TurnResult> {
    const roastLines = out.roastLines;
    const ownIds = new Set(out.drafts.map((d) => d.id));
    const sent = await send(
      r,
      out.drafts,
      roastLines === undefined ? undefined : (o) => (ownIds.has(o.id) ? { roastLines } : undefined),
    );
    out.afterSend?.(sent);
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: out.note,
    };
  }

  function isTravMessage(messageId: MessageId): boolean {
    for (const list of recent.values()) {
      if (list.some((m) => m.messageId === messageId && m.fromTrav)) return true;
    }
    return false;
  }

  // ---------- receipt photos (T-011) ----------

  async function receiptTurn(
    r: Resolved,
    res: ReceiptOutcome,
    before: ReadonlySet<string>,
  ): Promise<TurnResult> {
    const sent = await send(r, res.drafts);
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: sent.length === 0,
      modelSources: res.modelSources,
      note: res.note,
    };
  }

  /** 👍 / 👎 / a button on a receipt card: only the poster's counts (SAFETY §2.4). */
  async function receiptAnswerTurn(
    r: Resolved,
    cardMessageId: MessageId,
    intent: 'confirm' | 'drop' | undefined,
  ): Promise<TurnResult> {
    if (intent === undefined) return silent('receipt:not_an_answer');
    const before = snapshotAudit(r.group.groupId);
    const res = receipts.answer({
      group: r.group,
      members: r.members,
      trip: r.trip,
      me: canRequest(r.identity) ? r.me : null,
      cardMessageId,
      intent,
    });
    if (res === undefined) return silent('receipt:not_ours');
    return receiptTurn(r, res, before);
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

  // ---------- "@trav drop that one" (T-015) ----------

  /** The latest recap card with photos Trav posted in this group. */
  /**
   * The latest recap with photos, or only if it is Trav's most recent card in
   * the thread when `onlyIfLatestCard` (T-015 review #3: an unreplied "delete
   * that one" after a logged expense is about the expense).
   */
  function latestRecapWithPhotos(
    groupId: GroupId,
    onlyIfLatestCard: boolean,
  ): RecapCard | undefined {
    if (onlyIfLatestCard) {
      // Trav's most recent card in the group thread (the lane transcript, not DMs).
      const thread = recent.get(laneKey(groupId, 'group', null)) ?? [];
      for (let i = thread.length - 1; i >= 0; i--) {
        const m = thread[i]!;
        if (!m.fromTrav) continue;
        const ref = cards.get(m.messageId);
        if (ref === undefined) continue;
        return ref.card.type === 'recap' && ref.card.photos.length > 0 ? ref.card : undefined;
      }
      return undefined;
    }
    let best: PendingCardRef | undefined;
    for (const [id, ref] of cards) {
      if (ref.card.type !== 'recap' || ref.card.photos.length === 0) continue;
      if (cardGroup.get(id) !== groupId) continue;
      if (best === undefined || parseIso(ref.sentAt) >= parseIso(best.sentAt)) best = ref;
    }
    return best?.card.type === 'recap' ? best.card : undefined;
  }

  /**
   * Undefined ⇒ not a photo command after all (not addressed, or "that one"
   * with no recap photo in reach): the message goes on through the loop.
   */
  async function dropPhotoTurn(
    r: Resolved,
    me: Member,
    event: InboundMessage,
    boundRef: PendingCardRef | undefined,
    request: DropPhotoRequest,
  ): Promise<TurnResult | undefined> {
    const repliedRecap = boundRef?.card.type === 'recap' ? boundRef.card : undefined;
    const addressed =
      repliedRecap !== undefined ||
      hasAtTrav(event.text) ||
      /^\s*(?:hey\s+|ok\s+)?trav\b/i.test(event.text);
    if (!addressed) return undefined;
    // A reply to some other Trav card is about that card.
    if (
      event.replyToMessageId !== undefined &&
      boundRef !== undefined &&
      repliedRecap === undefined
    )
      return undefined;
    const mentionsPhoto = /\b(?:photo|pic|picture|shot)\b/i.test(event.text);
    const card = repliedRecap ?? latestRecapWithPhotos(r.group.groupId, !mentionsPhoto);
    if (card === undefined && !mentionsPhoto) return undefined;
    const before = snapshotAudit(r.group.groupId);
    const out = await dropRecapPhoto({
      stores,
      ...(deps.album !== undefined ? { album: deps.album } : {}),
      group: r.group,
      tripId: r.trip?.tripId ?? null,
      me,
      card,
      request,
      now: r.now,
    });
    const sent = await send(r, [message(r, out.text)]);
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: `drop_photo:${out.kind}`,
    };
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
    // VOICE §3.4: a converted expense shows what was paid, then the trip amount (T-084 review).
    const item = (e: Expense): string => {
      const original = foreignOriginal(e);
      const what = sanitizeInline(e.description, 40).toLowerCase();
      return original === undefined
        ? `${formatMoney(e.amount)} ${what}`
        : `${formatMoney(original)} ${what} (≈${formatMoney(e.amount)})`;
    };
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

  // ---------- "i've paid" on the final settle card (T-141) ----------

  /** (card message, member) pairs already sent the current card for a stale 👍. */
  const settleStaleReplied = new Set<string>();

  /** A final settle_up card Trav posted in this group's thread. */
  function isFinalSettleCard(r: Resolved, ref: PendingCardRef): boolean {
    return (
      ref.card.type === 'settle_up' &&
      ref.card.mode === 'final' &&
      cardGroup.get(ref.messageId) === r.group.groupId
    );
  }

  /**
   * What a 👍 on the final settle card means for this sender (T-166): Got it
   * when someone said they sent them money, else Sent when they still owe on
   * an unsent row, else Got it when they are owed (a payee with no Sent yet),
   * else Sent (which then finds nothing of theirs and stays silent).
   */
  function thumbsUpAction(r: Resolved, ref: PendingCardRef): SettleAction {
    if (ref.card.type !== 'settle_up' || r.me === null || r.trip === null) return 'sent';
    const me = r.me.memberId;
    const open = ref.card.transfers.filter((t) => t.paid !== true);
    const pendingToMe = stores.group.settlements
      .listByTrip(r.trip.tripId)
      .some(
        (p) =>
          p.to === me &&
          isSettlementPending(p) &&
          open.some((t) => t.from === p.from && t.to === me),
      );
    if (pendingToMe) return 'got_it';
    if (open.some((t) => t.from === me && t.pending !== true)) return 'sent';
    if (open.some((t) => t.to === me)) return 'got_it';
    return 'sent';
  }

  /**
   * Sent / Got it / Undo on the final settle card (T-166, D-043;
   * `settle/actions.ts`): the payer's Sent marks their rows pending, only the
   * payee's Got it clears them, and either takes back their own step. Each
   * change is audited (no money moves) and the card goes out again with what
   * is still owed. Someone with nothing to do on the card, a guest, a minor or
   * a second tap is silent. On a card the tab has moved past, rows are still
   * recorded at the card's amounts (lead "tab changed since that card"),
   * unless that pair was confirmed since: then they get the current card once.
   */
  async function settleTurn(
    r: Resolved,
    ref: PendingCardRef,
    action: SettleAction,
    via: 'reaction' | 'button' | 'text',
    messageId: MessageId,
    value?: string,
  ): Promise<TurnResult> {
    if (ref.card.type !== 'settle_up') return silent('settle:not_settle_card');
    const trip = r.trip;
    if (r.lane !== 'group' || trip === null) return silent('settle:no_trip');
    if (r.me === null || !canRequest(r.identity)) return silent('settle:guest');
    // A tap may carry `from:to`: that row only, and only if the tapper is on it.
    let only: { from: MemberId; to: MemberId } | undefined;
    if (value !== undefined && value.length > 0) {
      const [from, to] = value.split(':');
      if (
        from === undefined ||
        to === undefined ||
        to.length === 0 ||
        (from !== r.me.memberId && to !== r.me.memberId)
      )
        return silent('settle:not_party');
      only = { from, to };
    }
    const ctx = {
      groupId: r.group.groupId,
      tripId: trip.tripId,
      senderMemberId: r.me.memberId,
      senderId: r.me.senderId,
      lane: r.lane,
      now: r.now,
      clock,
      ids,
      stores,
    };
    const before = snapshotAudit(r.group.groupId);
    const outcome = settleFlow.act(ctx, {
      card: ref.card,
      cardMessageId: ref.messageId,
      cardSentAt: ref.sentAt,
      action,
      via,
      messageId,
      ...(only !== undefined ? { only } : {}),
    });
    if (
      outcome.kind === 'not_applicable' ||
      outcome.kind === 'not_party' ||
      outcome.kind === 'already'
    )
      return silent(`settle:${action}:${outcome.kind}`);
    // A card behind them gets the current one at most once per (card, member).
    const staleKey = `${ref.messageId}|${r.me.memberId}`;
    if (outcome.kind === 'stale') {
      if (settleStaleReplied.has(staleKey)) return silent('settle:stale_repeat');
      settleStaleReplied.add(staleKey);
    }
    const rctx = {
      groupId: r.group.groupId,
      members: r.members,
      timeZone: trip.timeZone,
      now: r.now,
      ids,
    };
    let drafts: OutboundMessage[];
    if (outcome.kind === 'which_row') {
      // A bare Got it with several rows and nobody said sent: never guess (D-043).
      drafts = [message(r, WHICH_ROW_TEXT)];
    } else if (outcome.kind === 'payee_confirmed') {
      // Only the payee takes back their own Got it (D-043).
      const names = outcome.payees.map((id) =>
        sanitizeInline(r.members.find((m) => m.memberId === id)?.displayName ?? 'they', 40),
      );
      const who = names.join(' and ');
      drafts = [
        message(
          r,
          `${who} already said got it on that one, so only ${names.length > 1 ? 'they' : who} can undo it`,
        ),
      ];
    } else {
      // One group message per turn (VOICE §3.7): any lead goes on the card's first line.
      let lead: string | undefined;
      if (outcome.kind === 'stale' || outcome.tabMoved) {
        lead = "tab changed since that card, here's where it stands now";
      } else if (outcome.action === 'sent') {
        // The payee has something to do now (VOICE §3.5): name them.
        const payees = [...new Set(outcome.changed.map((p) => p.to))].map((id) =>
          sanitizeInline(r.members.find((m) => m.memberId === id)?.displayName ?? '', 40),
        );
        lead = `${payees.join(' and ')}, tap Got it or 👍 once it lands`;
      }
      drafts = await settleFlow.finalSettle({
        ctx,
        rctx,
        trip,
        ...(lead !== undefined ? { lead } : {}),
      });
    }
    const sent = await send(r, drafts);
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(r.group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note:
        outcome.kind === 'done'
          ? `settle:${outcome.action}`
          : outcome.kind === 'stale'
            ? 'settle:stale'
            : outcome.kind === 'which_row'
              ? 'settle:got_it:which_row'
              : 'settle:undo:payee_confirmed',
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
      case 'member_left': {
        // A roster change can start (or end) family mode: VOICE §8 notice, at most once.
        const before = snapshotAudit(r.group.groupId);
        const notice = r.lane === 'group' ? await familyNotice(r) : [];
        return silent(`membership:${event.type}`, {
          outbound: notice,
          silent: notice.length === 0,
          auditEventIds: auditIdsSince(r.group.groupId, before),
        });
      }
      case 'reaction': {
        if (event.removed) return silent('reaction:removed');
        const intent = reactionIntent(event.reaction);
        if (receipts.owns(event.targetMessageId)) {
          const answer =
            intent === 'approve' ? 'confirm' : intent === 'decline' ? 'drop' : undefined;
          return receiptAnswerTurn(r, event.targetMessageId, answer);
        }
        const ref = cards.get(event.targetMessageId);
        if (intent === 'decline' && ref !== undefined && isLoggedExpenseCard(ref))
          return undoExpense(r, ref, 'reaction', event.messageId);
        // On the final settle card (VOICE §4.6, T-166): a payee's 👍 is Got it,
        // a payer's 👍 is Sent, 👎 takes back the reactor's own last step.
        if (
          (intent === 'approve' || intent === 'decline') &&
          ref !== undefined &&
          isFinalSettleCard(r, ref)
        ) {
          const action: SettleAction = intent === 'decline' ? 'undo' : thumbsUpAction(r, ref);
          return settleTurn(r, ref, action, 'reaction', event.messageId);
        }
        if (intent === undefined || ref?.proposalId === undefined)
          return silent('reaction:not_approval');
        return routeApproval(r, event, intent, '', 'reaction', ref.proposalId, event.messageId);
      }
      case 'button_tap': {
        if (receipts.owns(event.cardMessageId)) {
          const answer =
            event.actionId === 'confirm'
              ? 'confirm'
              : event.actionId === 'decline'
                ? 'drop'
                : undefined;
          return receiptAnswerTurn(r, event.cardMessageId, answer);
        }
        const ref = cards.get(event.cardMessageId);
        if (event.actionId === 'undo' && ref !== undefined && isLoggedExpenseCard(ref))
          return undoExpense(r, ref, 'button', event.messageId);
        // [Sent] / [Got it] / [Undo] on the final settle card (T-166); [Paid] on
        // a card from before T-166 is a Sent. A value is `from:to`.
        if (ref !== undefined && isFinalSettleCard(r, ref)) {
          const action: SettleAction | undefined =
            event.actionId === 'sent' || event.actionId === 'paid'
              ? 'sent'
              : event.actionId === 'got_it'
                ? 'got_it'
                : event.actionId === 'undo'
                  ? 'undo'
                  : undefined;
          if (action !== undefined)
            return settleTurn(r, ref, action, 'button', event.messageId, event.value);
        }
        // A tap on a group flight option (T-074) is "book option N" from the
        // tapper: a proposal through the approval policy, never a purchase.
        if (event.actionId === 'pick' && ref?.card.type === 'options') {
          // T-168 (b): a ticket options card's pick is the asker's approval.
          if (deps.proposals.ticketChoice(ref.cardId) !== undefined)
            return pickTicketTurn(
              r,
              ref.cardId,
              optionIndexOf(event.value, ref.cardId),
              event.messageId,
            );
          return pickFlightOption(r, ref, event.value, event.messageId);
        }
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

  /**
   * T-166: the one "which apps do you use?" DM, after the turn: to a member
   * who just joined (sign-up), and to anyone who now owes or is owed money and
   * was never asked. Never twice, never to a guest or a minor
   * (`settle/profiles.ts`). A failure here never undoes the turn.
   */
  async function withProfileAsks(
    r: Resolved,
    event: InboundEvent,
    res: TurnResult,
  ): Promise<TurnResult> {
    if (event.type === 'member_left') return res;
    try {
      const now = clock.now();
      const groupId = r.group.groupId;
      const before = snapshotAudit(groupId);
      const trip = stores.group.trips.current(groupId, now) ?? null;
      const asks: PendingAsk[] = [];
      if (event.type === 'member_joined' && r.me !== null)
        asks.push(...settleFlow.askOnJoin({ groupId, trip, member: r.me, now }));
      const members = stores.group.members.listByGroup(groupId);
      for (const a of settleFlow.asksForBalances({ groupId, trip, members, now }))
        if (!asks.some((x) => x.memberId === a.memberId)) asks.push(a);
      if (asks.length === 0) return res;
      const sent = await send(
        r,
        asks.map((a) => a.message),
      );
      // Recorded as asked only once the DM really went out: never twice, never lost.
      const sentIds = new Set(sent.filter((o) => !isReaction(o)).map((o) => o.id));
      for (const a of asks) if (sentIds.has(a.message.id)) a.commit();
      return {
        ...res,
        outbound: [...res.outbound, ...sent],
        auditEventIds: [...new Set([...res.auditEventIds, ...auditIdsSince(groupId, before)])],
        silent: res.silent && sent.length === 0,
      };
    } catch {
      return res;
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
      return await withProfileAsks(r, event, await dispatch(r, event));
    } catch (e) {
      return failTurn(r, e, 'messageId' in event ? event.messageId : undefined, before);
    } finally {
      // "card import on" in this turn ⇒ the owner's next digest-slot import is queued.
      scheduleCardImports();
    }
  }

  /**
   * T-067: one owner's scheduled card sync at a digest slot. Consent and
   * eligibility are checked by the import itself (consent off or a minor ⇒
   * the provider is never called); every run writes an owner-only
   * `card_import.ran` row (status and counts, never amounts or merchants).
   * The job queues the owner's next slot unless consent is off or the owner
   * can no longer be imported (turning consent back on re-queues it). A job
   * drained after a clock jump that did not land on a slot waits for the next
   * one, so the DMs keep to 10:00 and 20:00 (VOICE §2).
   */
  async function runCardImportJob(job: ScheduledJob): Promise<TurnResult> {
    const owner =
      typeof job.payload['ownerMemberId'] === 'string' ? job.payload['ownerMemberId'] : undefined;
    const group = stores.group.groups.get(job.groupId);
    const trip = job.tripId === null ? undefined : stores.group.trips.get(job.tripId);
    if (owner === undefined || group === undefined || trip === undefined)
      return silent('scheduled:card_import:no_trip');
    if (deps.transactions === undefined) return silent('scheduled:card_import:no_provider');
    const now = clock.now();
    const member = stores.group.members
      .listByGroup(group.groupId)
      .find((m) => m.memberId === owner);
    if (member === undefined) return silent('scheduled:card_import:no_member');
    // A job queued while another trip was current ends here, not requeued (T-067 r2 #2).
    if (stores.group.trips.current(group.groupId, now)?.tripId !== trip.tripId) {
      return silent('scheduled:card_import:not_current_trip');
    }
    const before = snapshotAudit(group.groupId);
    const ran = (status: string, counts: Record<string, number> = {}): void => {
      stores.group.audit.append({
        groupId: group.groupId,
        tripId: trip.tripId,
        type: 'card_import.ran',
        actor: { kind: 'system', id: 'scheduler' },
        visibility: 'owner',
        ownerId: owner,
        payload: { jobId: job.jobId, slot: job.runAt, status, ...counts },
      });
    };
    const requeue = (): void => {
      const next = nextCardImportJob(trip, owner, now);
      if (next !== undefined) scheduler.schedule(next);
    };
    if (!atCardImportSlot(trip, now)) {
      ran('stale');
      requeue();
      return silent('scheduled:card_import:stale', {
        auditEventIds: auditIdsSince(group.groupId, before),
      });
    }
    let result: CardImportResult;
    try {
      result = await runCardImport(group, trip, {
        groupId: group.groupId,
        ownerMemberId: owner,
        delivery: 'now',
        atSlot: true,
      });
    } catch (e) {
      // A private-lane background job: never the group's failure line. Try again next slot.
      ran('failed', {});
      requeue();
      return silent(`scheduled:card_import:failed:${e instanceof TravError ? e.code : 'error'}`, {
        auditEventIds: auditIdsSince(group.groupId, before),
      });
    }
    ran(result.status, {
      stored: result.stored,
      prompted: result.prompted.length,
      updated: result.updated.length,
      ledgerUpdated: result.ledgerUpdated.length,
      expired: result.expired,
      dropped: result.dropped,
      messages: result.outbound.length,
    });
    if (
      result.status !== 'consent_off' &&
      result.status !== 'minor' &&
      result.status !== 'not_eligible'
    ) {
      requeue();
    }
    return {
      ...result,
      auditEventIds: auditIdsSince(group.groupId, before),
      note: `scheduled:card_import:${result.status}`,
    };
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

  /** End-of-trip Wrapped (T-016): compose from the stores, send with its roast lines declared. */
  async function runWrappedJob(job: ScheduledJob): Promise<TurnResult> {
    const group = stores.group.groups.get(job.groupId);
    const trip = job.tripId === null ? undefined : stores.group.trips.get(job.tripId);
    if (group === undefined || trip === undefined) return silent('scheduled:wrapped:no_trip');
    const before = snapshotAudit(group.groupId);
    const composed = await composeWrapped(
      { stores, clock, ids, ...(deps.album !== undefined ? { album: deps.album } : {}) },
      group.groupId,
      trip.tripId,
    );
    if (composed.kind === 'no_trip') return silent('scheduled:wrapped:no_trip');
    const r: Resolved = {
      group,
      members: stores.group.members.listByGroup(group.groupId),
      trip,
      identity: { kind: 'guest', senderId: 'scheduler' },
      me: null,
      lane: 'group',
      now: clock.now(),
    };
    const draft = composed.kind === 'ok' ? composed.render.message : composed.message;
    const roastLines = composed.kind === 'ok' ? composed.render.roastLines : [];
    const sent = await send(r, [draft], (o) => (o.id === draft.id ? { roastLines } : undefined));
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: composed.kind === 'ok' ? 'scheduled:wrapped' : 'scheduled:wrapped:needs_guardian',
    };
  }

  /**
   * Morning After / daily settle-up (T-015): full recap, quiet settle-up or
   * silence, from the stores. A job drained long after its time (a clock jump
   * past it) is skipped, never posted stale.
   */
  async function runMorningAfterJob(job: ScheduledJob): Promise<TurnResult> {
    const group = stores.group.groups.get(job.groupId);
    const trip = job.tripId === null ? undefined : stores.group.trips.get(job.tripId);
    const date = typeof job.payload['date'] === 'string' ? job.payload['date'] : undefined;
    if (group === undefined || trip === undefined || date === undefined)
      return silent('scheduled:morning_after:no_trip');
    const now = clock.now();
    // ARCHITECTURE Flow 3: the job reschedules the next morning itself (same
    // jobId ⇒ idempotent; never one that is already due, so a drain never loops).
    const next = nextMorningAfterJob(trip, date);
    if (next !== undefined && parseIso(next.runAt) > parseIso(now)) scheduler.schedule(next);
    if (parseIso(now) - parseIso(job.runAt) > RECAP_STALE_MS)
      return silent('scheduled:morning_after:stale');
    const before = snapshotAudit(group.groupId);
    const composed = await composeMorningAfter(
      {
        stores,
        clock,
        ids,
        ...(deps.album !== undefined ? { album: deps.album } : {}),
        chatTimes: (groupId) => chatTimes.get(groupId) ?? [],
      },
      group.groupId,
      trip.tripId,
      date,
    );
    if (composed.kind === 'no_trip') return silent('scheduled:morning_after:no_trip');
    if (composed.kind === 'silent') return silent('scheduled:morning_after:silent');
    const r: Resolved = {
      group,
      members: stores.group.members.listByGroup(group.groupId),
      trip,
      identity: { kind: 'guest', senderId: 'scheduler' },
      me: null,
      lane: 'group',
      now,
    };
    const draft = composed.message;
    const roastLines = composed.kind === 'ok' ? composed.roastLines : [];
    // SAFETY §2.8: a candidate roast line the gates dropped is audited (cause only, never the line).
    for (const s of composed.kind === 'ok' ? composed.suppressedRoast : []) {
      audit(r, {
        type: 'roast.suppressed',
        actor: { kind: 'system', id: 'trav' },
        visibility: 'group',
        payload: {
          cause: s.cause,
          messageDraftId: draft.id,
          ...(s.topicCategory !== undefined ? { topicCategory: s.topicCategory } : {}),
        },
      });
    }
    const sent = await send(r, [draft], (o) => (o.id === draft.id ? { roastLines } : undefined));
    return {
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note:
        composed.kind === 'ok'
          ? `scheduled:morning_after:${composed.mode}`
          : 'scheduled:morning_after:needs_guardian',
    };
  }

  async function runScheduledJob(job: ScheduledJob): Promise<TurnResult> {
    if (job.kind === 'wrapped') return runWrappedJob(job);
    if (job.kind === 'morning_after') return runMorningAfterJob(job);
    if (job.kind === 'card_import') return runCardImportJob(job);
    if (job.kind === 'expense_notice') {
      // T-165 r2: a held ledger notice's window ended; it goes out when this operation ends.
      notices.release(job);
      return silent('scheduled:expense_notice');
    }
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
        `${bookingHeadline(proposal)} proposal expired, no charge. @ me if you still want it`,
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
      // The group thread (members' own words, markers for pasted/guest text): a ride's
      // rider count leaves out who said they had left that night (T-135).
      groupMessages: rideLines.get(group.groupId) ?? [],
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
      note:
        outcome.consentMissing !== undefined
          ? 'document:consent_missing'
          : outcome.matches.length > 0
            ? 'document:injection_detected'
            : 'document:clean',
      injectionPatterns: outcome.matches.map((m) => m.pattern),
      lowConfidence: outcome.lowConfidence,
      ...(outcome.pendingItemId !== undefined ? { pendingItemId: outcome.pendingItemId } : {}),
      ...(outcome.consentMissing !== undefined ? { consentMissing: outcome.consentMissing } : {}),
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

  /**
   * T-067: the saved Plaid cursor per (group, owner, trip) for the runtime's
   * own provider, so a sync for one trip never skips rows another trip's sync
   * consumed (r1 #6). In memory: a restart re-syncs from the start, which the
   * import absorbs (rows upsert by provider id, items are found again, nothing
   * is re-asked, purged descriptors stay purged).
   */
  const cardCursors = new Map<string, string>();
  const cursorKey = (groupId: GroupId, memberId: MemberId, trip: Trip | null): string =>
    `${groupId}|${memberId}|${trip?.tripId ?? '-'}`;

  /**
   * T-067: queue each consenting owner's next `card_import` slot (idempotent
   * by jobId; the job reschedules itself after it runs). Called when the
   * runtime starts and after every inbound turn (consent is turned on in chat).
   */
  function scheduleCardImports(): void {
    if (deps.transactions === undefined) return;
    const queued = new Set(scheduler.list().map((j) => j.jobId));
    for (const job of cardImportJobsFor(stores, clock.now(), queued)) scheduler.schedule(job);
  }

  async function importCardTransactions(input: CardImportRequest): Promise<CardImportResult> {
    const group = stores.group.groups.get(input.groupId);
    if (group === undefined) throw new TravError('not_found', `group ${input.groupId} not found`);
    const now = clock.now();
    const trip = stores.group.trips.current(group.groupId, now) ?? null;
    const result = await runCardImport(group, trip, input);
    // Held for the next digest slot: make sure that slot's import is queued.
    if (result.held.length > 0 && trip !== null) {
      const next = nextCardImportJob(trip, input.ownerMemberId, now);
      if (next !== undefined) scheduler.schedule(next);
    }
    scheduleCardImports();
    return result;
  }

  async function runCardImport(
    group: Group,
    trip: Trip | null,
    input: CardImportRequest,
  ): Promise<CardImportResult> {
    const now = clock.now();
    const members = stores.group.members.listByGroup(group.groupId);
    const owner = members.find((m) => m.memberId === input.ownerMemberId);
    if (owner === undefined) {
      throw new TravError(
        'not_found',
        `member ${input.ownerMemberId} is not in group ${input.groupId}`,
      );
    }
    const own = input.adapter === undefined;
    const adapter = input.adapter ?? deps.transactions;
    if (adapter === undefined) {
      throw new TravError('not_implemented', 'card import: no transactions provider configured');
    }
    const key = cursorKey(group.groupId, owner.memberId, trip);
    const cursor = input.cursor ?? (own ? cardCursors.get(key) : undefined);
    const before = snapshotAudit(group.groupId);
    const outcome = await importCards(
      { ...input, adapter, ...(cursor !== undefined ? { cursor } : {}) },
      { stores, clock, ids, model, group, members, trip },
    );
    if (own && outcome.nextCursor !== undefined) cardCursors.set(key, outcome.nextCursor);
    // T-090: an owner-initiated sync with import off gets one DM line on how to
    // turn it on (the provider was never called; scheduled jobs never ask for this).
    const drafts =
      input.consentHint === true && outcome.status === 'consent_off'
        ? [
            {
              id: ids.next('msg'),
              groupId: group.groupId,
              to: { kind: 'member' as const, memberId: owner.memberId },
              text: importOffText('cardImport'),
            },
          ]
        : outcome.drafts;
    const r: Resolved = {
      group,
      members,
      trip,
      identity: { kind: 'member', member: owner },
      me: owner,
      lane: 'dm',
      now,
    };
    const sent = await send(r, drafts);
    return {
      ...outcome,
      drafts,
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
    const outcome = await importEmails(input, {
      stores,
      clock,
      ids,
      model,
      group,
      members,
      trip,
      groupMessages: rideLines.get(group.groupId) ?? [],
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
      ...outcome,
      outbound: sent,
      toolCalls: [],
      auditEventIds: auditIdsSince(group.groupId, before),
      silent: sent.length === 0,
      modelSources: [],
      note: `emails:${outcome.status}`,
    };
  }

  scheduleCardImports();

  // T-165: each public entry point is one operation; the notices it caused go
  // out after its own messages and are appended to its `outbound`.
  return {
    handleInbound: notices.around(handleInbound),
    runScheduled: notices.around(runScheduled),
    intakeDocument: notices.around(intakeDocument),
    importCardTransactions: notices.around(importCardTransactions),
    importEmailReceipts: notices.around(importEmailReceipts),
    pendingCards,
  };
}
