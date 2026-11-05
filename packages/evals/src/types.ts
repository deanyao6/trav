/**
 * Eval harness types (T-020). A scenario is data (JSON under
 * `packages/evals/scenarios/`); the runner replays it through a real
 * `createTravRuntime` and records an `Episode`; graders are pure functions
 * over the episode. See `docs/SAFETY.md` §3 for the checklist ids graders map to.
 */
import type {
  AuditEvent,
  Booking,
  BookingProposal,
  ConsentFlags,
  Expense,
  Group,
  GroupMemoryFact,
  LedgerEntry,
  Member,
  MemberMemoryFact,
  OutboundMessage,
  Trip,
} from '@trav/core';
import type { TranscriptEntry } from '@trav/adapters';
import type { TripName } from './fixtures.js';

// ---------- scenarios ----------

export type ScenarioTag =
  | 'safety'
  | 'regression'
  | 'heldout'
  | 'ledger'
  | 'voice'
  | 'booking'
  | 'injection'
  | 'identity'
  | 'privacy'
  | 'minors'
  | 'roast'
  | 'photos'
  | 'flights'
  | 'mention'
  | 'replay'
  | 'recap'
  | 'ingestion'
  | 'budget';

export const SCENARIO_TAGS: readonly ScenarioTag[] = [
  'safety',
  'regression',
  'heldout',
  'ledger',
  'voice',
  'booking',
  'injection',
  'identity',
  'privacy',
  'minors',
  'roast',
  'photos',
  'flights',
  'mention',
  'replay',
  'recap',
  'ingestion',
  'budget',
];

/** What a step's turn must look like. Every field is optional; graders pick the ones they own. */
export interface StepExpect {
  /** Trav says nothing (no message, no reaction). */
  readonly silent?: boolean;
  /** `TurnResult.note` must equal (one of) these. */
  readonly note?: string | readonly string[];
  /** Exact tool-call names, in order. */
  readonly toolCalls?: readonly string[];
  /** `TurnResult.modelSources[0]` (determinism: `'script'` for the Razzmatazz ask). */
  readonly modelSource?: 'script' | 'fallback' | 'live';
  /** Case-insensitive substrings of the turn's group-lane text. */
  readonly mustContain?: readonly string[];
  readonly mustNotContain?: readonly string[];
  /**
   * Private facts from this line (a DM): from this step on, no group message
   * and no group-lane prompt may contain them (case-insensitive).
   */
  readonly mustNotAppearInGroup?: readonly string[];
  /**
   * Words of this line that must never be stored (a health reason): by the end
   * of the episode no memory fact, proposal, booking, expense or audit payload
   * contains them (case-insensitive).
   */
  readonly mustNotStore?: readonly string[];
  /** Exact group-lane text (the first message). */
  readonly text?: string;
  /** Audit event types that must appear during this step. */
  readonly audit?: readonly string[];
  /** Untrusted content on this step (SAFETY D4). */
  readonly injection?: {
    readonly patterns: readonly string[];
    /** Document intake (expects a low-confidence pending item when `extracted` was given). */
    readonly document?: boolean;
    readonly expectPendingItem?: boolean;
  };
  /** Guest / impersonation / minor approval attempts (SAFETY E2, E3, E5). */
  readonly identity?: {
    readonly safetyId: 'E2' | 'E3' | 'E5';
    /** `approval.invalid_attempt.cause` that must be written on this step. */
    readonly invalidAttemptCause?: string;
    /** The sender must get no proposal, grant, ledger write or purchase from this step. */
    readonly noEffect?: boolean;
  };
  /** The booking proposal this step must create (SAFETY A9). */
  readonly proposal?: {
    readonly attendees: readonly string[];
    readonly payers: readonly string[];
    readonly excluded?: readonly string[];
    readonly totalMinor?: number;
    readonly status?: 'pending';
  };
  /** The ledger expense this step must write (chat text, receipt, booking). */
  readonly expense?: {
    readonly paidBy: string;
    readonly amountMinor: number;
    /** Non-zero shares, any order. Omitted ⇒ only payer and amount are graded (family tab). */
    readonly shares?: readonly { readonly memberId: string; readonly amountMinor: number }[];
    /** Allowed absolute difference per amount (FX rounding the fixture does not pin). */
    readonly toleranceMinor?: number;
  };
  /** Provider purchases allowed after this step (cumulative). */
  readonly purchases?: number;
  /** Restricted content allowed in this step's group output only for this adult audience. */
  readonly explicitAdultAudience?: readonly string[];

  // ---- replayed chat-line ground truth (T-077, `fixtures/README.md` "chat lines") ----

  /** What Trav must do (any one of them); see `LINE_ACTIONS` in `runner/actions.ts`. */
  readonly action?: readonly string[];
  /** Questions (`?`) in Trav's group reply on a clarify turn. */
  readonly questionCount?: number;
  /** Booking proposals created on this step. */
  readonly proposals?: number;
  /** Ledger expenses written on this step. */
  readonly ledgerWrites?: number;
  /** Provider purchases made on this step (not cumulative; compare `purchases`). */
  readonly newPurchases?: number;
  /** Audit types written in this relative order on this step. */
  readonly auditOrder?: readonly string[];
  /** Audit types that must NOT be written on this step (`roast: false` ⇒ no `roast.generated`). */
  readonly auditAbsent?: readonly string[];
  /** Attendance of one activity right after this step. */
  readonly roster?: {
    readonly activityId: string;
    readonly in: readonly string[];
    readonly out: readonly string[];
  };
  /** A member's consent flag right after this step. */
  readonly consent?: { readonly memberId: string; readonly flag: string; readonly to: boolean };
  /** Group settings right after this step (each key must equal). */
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Trav reacted with one of these. */
  readonly reactions?: readonly string[];
  /** Text (non-reaction) messages Trav sent on this step. */
  readonly textMessages?: number;
  /** Group messages Trav sent on this step (a clock line: across the scheduled turns it ran). */
  readonly groupMessages?: number;
  /** Every message on this step is a DM to this member (and at least one was sent). */
  readonly dmTo?: string;
  /** Case-insensitive substrings of the DMs on this step. */
  readonly dmMustContain?: readonly string[];
  /** A clock line: the scheduled job it must run, and the recap mode (`scheduled:<job>:<mode>`). */
  readonly scheduled?: { readonly job: string; readonly mode?: string };
  /** The approval event this tap/reaction/message must produce. */
  readonly approval?: {
    readonly effect: 'granted' | 'ignored';
    readonly complete?: boolean;
    /** `approval.invalid_attempt.cause` (non-identity causes such as `ambiguous`). */
    readonly cause?: string;
  };
  /** The policy decision (`policy.evaluated`) written on this step. */
  readonly decision?: {
    readonly outcome?: string;
    readonly approvalMode?: string;
    readonly requiredApprovers?: readonly string[];
    readonly reasons?: readonly string[];
    readonly reasonsInclude?: readonly string[];
  };
  /** The private "looks shared?" card a document import must DM its owner. */
  readonly pendingItem?: {
    readonly amountMinor?: number;
    readonly participants?: readonly string[];
    readonly lowConfidence?: boolean;
  };
  /** Members who must get a ticket DM on this step, and members who must not. */
  readonly ticketsTo?: readonly string[];
  readonly noTicketsTo?: readonly string[];
  /** Rows a document import stored for its owner (0 ⇒ consent off: nothing read). */
  readonly ingested?: number;
  /** A settle-up card on this step lists at most this many transfers. */
  readonly maxTransfers?: number;

  // ---- T-160: the rest of a chat line's ground truth (set by the replay expansion only) ----

  /** The written expense's other fields (amount, payer and shares are `expense`, graded by `ledger_ground_truth`). */
  readonly expenseDetails?: {
    /** Graded by shared words, not bytes (`fixtures/README.md`: structure, not exact text). */
    readonly description?: string;
    readonly category?: string;
    readonly source?: string;
    /** A core `SplitSpec`, compared by who it resolves to (and line items for `itemized`). */
    readonly split?: Readonly<Record<string, unknown>>;
  };
  /** The created proposal's other fields (attendees, payers and total are `proposal`, graded by `members_charged`). */
  readonly proposalDetails?: {
    readonly kind?: string;
    readonly provider?: string;
    readonly itemRef?: string;
    /** Offers bundled in the item (a group flight: one offer per traveller). */
    readonly itemRefCount?: number;
    readonly currency?: string;
    readonly refundable?: boolean;
    /** Tickets on the proposal card sent for it. */
    readonly quantity?: number;
    readonly paidBy?: Readonly<Record<string, unknown>>;
  };
  /** The booking completed on this line. */
  readonly booking?: {
    readonly kind?: string;
    readonly provider?: string;
    readonly itemRef?: string;
    readonly totalMinor?: number;
    readonly orderRefPrefix?: string;
    /** Provider orders behind the booking (six airline orders for a group flight). */
    readonly orders?: number;
    /** Provider purchases per order on this line. */
    readonly purchasesPerOrder?: number;
    readonly paidBy?: Readonly<Record<string, unknown>>;
    readonly ledgerWrites?: number;
    /** Ticket cards each attendee gets. */
    readonly ticketsPerHolder?: number;
    /** Whether a ticket card or QR payload may reach the group (always false in the fixtures). */
    readonly qrInGroup?: boolean;
    /** Holder → member whose DM gets the holder's ticket (a minor's goes to a guardian). */
    readonly ticketDeliveredTo?: Readonly<Record<string, string>>;
  };
  /** Why Trav refuses, as the observable signal for that reason (`REFUSAL_SIGNALS` in `graders/lineChecks.ts`). */
  readonly refusal?: { readonly reason: string; readonly topicCategory?: string };
  /** The settle-up on this line leaves every member with the net these transfers imply, to the cent. */
  readonly transfers?: readonly {
    readonly from: string;
    readonly to: string;
    readonly amountMinor: number;
  }[];
  /** A clock line: whether the job framed a night out (a recap with last night's events). */
  readonly nightOutFraming?: boolean;
  /** A mark-paid line: the settle-up card shows this member's transfer as paid. */
  readonly markedPaidBy?: string;
  /** T-166, a mark-sent line: the settle-up card shows this member's transfer as sent and still owed. */
  readonly markedSentBy?: string;
  /** Who a suggestion is for: Trav answers, and nothing proposed on the line includes anyone else. */
  readonly suggestionAudience?: readonly string[];
  /** An adult asked for an adult-only plan: Trav answers, and no minor screen suppresses the reply. */
  readonly explicitAdultRequest?: boolean;
  /**
   * Task id this line's behaviour waits on (a per-line known gap): its failures
   * are still scored and fail the scenario, and the evidence names the task.
   */
  readonly pending?: string;
  /** Fixture expectation fields on this line that no grader checks (reported as skipped, never passed). */
  readonly ungraded?: readonly string[];
}

interface StepBase {
  /** Name other steps use as `target` / `replyTo`. */
  readonly id?: string;
  readonly expect?: StepExpect;
  /** Where the step came from (chat line id, fixture id); filled by expansion. */
  readonly source?: string;
  /** Set the simulated clock (forward only) before the step. */
  readonly at?: string;
  /** Later steps may target this step's card as `cardRef:<name>` (chat fixtures' `expect.cardRef`). */
  readonly cardRef?: string;
}

export interface SayStep extends StepBase {
  readonly do: 'say';
  readonly from: string;
  readonly text: string;
  readonly lane?: 'group' | 'dm';
  /** Step id whose first outbound message this quote-replies. */
  readonly replyTo?: string;
  readonly displayName?: string;
  /** Photos/files on the message (repo-relative `uri`, e.g. a receipt PNG under fixtures/receipts). */
  readonly attachments?: readonly {
    readonly kind: 'image' | 'video' | 'file' | 'audio';
    readonly mimeType: string;
    readonly uri: string;
    readonly fileName?: string;
  }[];
}

export interface ReactStep extends StepBase {
  readonly do: 'react';
  readonly from: string;
  /** Step id whose card message is the target. */
  readonly target: string;
  readonly reaction: string;
}

export interface TapStep extends StepBase {
  readonly do: 'tap';
  readonly from: string;
  readonly target: string;
  readonly actionId: string;
  /** Button value (a digest row's provider id, an option id). */
  readonly value?: string;
}

export interface AdvanceStep extends StepBase {
  readonly do: 'advance';
  readonly minutes?: number;
  readonly to?: string;
  /** Run due scheduled jobs after moving the clock (default true). */
  readonly drain?: boolean;
}

export interface DrainStep extends StepBase {
  readonly do: 'drain';
}

export interface IntakeStep extends StepBase {
  readonly do: 'intake';
  readonly owner: string;
  readonly source:
    | 'email_receipt'
    | 'receipt_ocr'
    | 'provider_listing'
    | 'host_message'
    | 'photo_caption'
    | 'card_descriptor';
  readonly itemId: string;
  readonly text: string;
  readonly extracted?: {
    readonly amountMinor: number;
    readonly currency: string;
    readonly merchantDisplay: string;
  };
}

/**
 * A `system` chat line (T-078): a card sync or an arriving email, ingested
 * through `agent.importCardTransactions` / `agent.importEmailReceipts` for one
 * owner. Consent is whatever the chat set so far (no implicit opt-in).
 */
export interface ImportStep extends StepBase {
  readonly do: 'import';
  readonly event: 'card_sync' | 'email_arrived';
  readonly owner: string;
  /** Repo-relative fixture: `fixtures/transactions/<memberId>.json` or `fixtures/emails/<emailId>.json`. */
  readonly fixture: string;
}

export interface RememberStep extends StepBase {
  readonly do: 'remember';
  readonly memberId: string;
  readonly text: string;
  readonly category: 'preference' | 'dietary' | 'budget' | 'logistics' | 'constraint' | 'other';
  readonly lane: 'private' | 'group';
}

export interface AttendanceStep extends StepBase {
  readonly do: 'set_attendance';
  readonly activityId: string;
  readonly memberId: string;
  readonly status: 'in' | 'out' | 'maybe';
}

export interface PatchMemberStep extends StepBase {
  readonly do: 'patch_member';
  readonly memberId: string;
  readonly patch: Readonly<Record<string, unknown>>;
}

/** Replays lines of `fixtures/chats/<chat>.jsonl` (inclusive range, or explicit ids). */
export interface ReplayStep extends StepBase {
  readonly do: 'replay';
  readonly chat: TripName;
  readonly fromId?: string;
  readonly toId?: string;
  readonly ids?: readonly string[];
}

/** Expands `fixtures/injection/<fixture>.json` into a say/intake step with D4 expectations. */
export interface InjectionStep extends StepBase {
  readonly do: 'injection';
  readonly fixture: string;
}

export type ProbeName =
  | 'mentions'
  | 'flights'
  | 'ledger'
  | 'album_consent'
  | 'roast_screen'
  | 'minor_screen'
  | 'auto_buy'
  | 'spending_tier';

export const PROBE_NAMES: readonly ProbeName[] = [
  'mentions',
  'flights',
  'ledger',
  'album_consent',
  'roast_screen',
  'minor_screen',
  'auto_buy',
  'spending_tier',
];

/** A deterministic probe of a pure component (core function, mock adapter, the send path). */
export interface ProbeStep extends StepBase {
  readonly do: 'probe';
  readonly probe: ProbeName;
  readonly args?: Readonly<Record<string, unknown>>;
}

export type Step =
  | SayStep
  | ReactStep
  | TapStep
  | AdvanceStep
  | DrainStep
  | IntakeStep
  | ImportStep
  | RememberStep
  | AttendanceStep
  | PatchMemberStep
  | ReplayStep
  | InjectionStep
  | ProbeStep;

export type StepKind = Step['do'];

export interface ScenarioSetup {
  /** Which group to seed. Default `barcelona`. */
  readonly group?: TripName;
  /** Start of the simulated clock. Default: the first timed step, else the runtime default. */
  readonly startAt?: string;
  /** Load `consent`, `memberPrefs`, `groupMemory` and `memberMemory` from the group fixture. */
  readonly fixtureExtras?: boolean;
  /** Override group settings (e.g. `{ roastMode: true }`). */
  readonly settings?: Readonly<Record<string, unknown>>;
  /**
   * Override spending-policy numbers (T-168), e.g. `{ autoApproveCapMinor:
   * 50000 }` for the product default auto-buy cap. The trip fixtures keep it 0.
   */
  readonly spendingPolicy?: Readonly<Record<string, number>>;
  /** Consent flags per member (merged over the defaults, all false). */
  readonly consent?: Readonly<
    Record<
      string,
      Partial<
        Record<'photos' | 'roast' | 'cardImport' | 'emailImport' | 'memoryAcrossTrips', boolean>
      >
    >
  >;
  /** Strings that must never reach a group prompt or group message in this episode (SAFETY C2/C7). */
  readonly privateStrings?: readonly string[];
  /**
   * T-167: a `fixtures/tiers/<name>.json` trip variant whose flights and stays
   * are handed to the runtime as travel facts (the spending tier's signals).
   */
  readonly tierFixture?: string;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly ScenarioTag[];
  /** SAFETY §3 ids this scenario covers; a crash in a `safety` scenario is a hard failure on these. */
  readonly checklist?: readonly string[];
  /**
   * Task id whose feature this scenario drives but that has not landed. The
   * scenario still runs and is reported as a known gap: quality failures are
   * expected, safety graders stay hard. Drop it once the scenario passes.
   */
  readonly pending?: string;
  readonly pendingNote?: string;
  readonly setup?: ScenarioSetup;
  readonly steps: readonly Step[];
  /** Per-grader weight overrides. */
  readonly weights?: Readonly<Record<string, number>>;
  /** Scenario-level grader parameters. */
  readonly expect?: ScenarioExpect;
  /** Rubric criteria for live grading (skipped offline). */
  readonly rubric?: readonly string[];
}

export interface ScenarioExpect {
  /** Audit types that must appear in this relative order (B1). */
  readonly auditOrder?: readonly string[];
  /** Max provider purchases over the whole episode (A3/A5). Default 0 until approvals exist. */
  readonly maxPurchases?: number;
  /** Mention probe thresholds. */
  readonly mentionPrecision?: number;
  readonly mentionRecall?: number;
  /** Expected ledger ground truth file for the agent's ledger (`ledger/<trip>.json`). */
  readonly ledgerGroundTruth?: TripName;
  /** QR tickets: who must get a DM ticket, who must not (C5, VOICE §4.3). */
  readonly tickets?: { readonly to: readonly string[]; readonly notTo: readonly string[] };
}

// ---------- episodes ----------

export interface TurnSummary {
  readonly outbound: readonly OutboundMessage[];
  /** Reactions Trav sent (emoji only). */
  readonly reactions: readonly string[];
  readonly toolCalls: readonly string[];
  readonly silent: boolean;
  readonly modelSources: readonly string[];
  readonly note: string;
  readonly injectionPatterns?: readonly string[];
  readonly lowConfidence?: boolean;
  readonly pendingItemId?: string;
  /** Card/email import outcome (counts only; verdicts and rows stay private). */
  readonly imported?: {
    readonly status: string;
    readonly stored: number;
    readonly prompted: number;
  };
}

/** Facts read from the stores right after a step, only for the expectations that need them. */
export interface StepState {
  readonly roster?: { readonly in: readonly string[]; readonly out: readonly string[] };
  readonly consent?: boolean;
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Member-memory facts (all owners) and group-memory facts written on this step. */
  readonly memoryWrites?: { readonly private: number; readonly group: number };
}

/**
 * What a typed message says as an answer to a card, read by the eval (never
 * by the product's own regexes, so a product bug cannot hide itself):
 * `confirm` a yes, `decline` a no / keep private / drop it, `riders` a list
 * of who rode (T-135: the owner's names answer is the confirmation), `other`
 * anything else. The text itself is never recorded (a DM is private).
 */
export type TypedIntent = 'confirm' | 'decline' | 'riders' | 'other';

/** The member's gesture on a say/react/tap step (SAFETY D5 needs a confirming one). */
export type StepAction =
  | { readonly kind: 'reaction'; readonly reaction: string }
  | { readonly kind: 'tap'; readonly actionId: string }
  | { readonly kind: 'text'; readonly intent: TypedIntent };

export interface StepRecord {
  readonly index: number;
  readonly stepId?: string;
  readonly kind: StepKind | 'replay_line';
  /** Human label for reports ("h_dean: @trav get the 5 of us…"). */
  readonly label: string;
  readonly source?: string;
  readonly lane: 'group' | 'dm' | 'system';
  readonly from?: string;
  readonly at: string;
  readonly expect?: StepExpect;
  readonly turn?: TurnSummary;
  /** Audit events written during this step (types), and their range in `Episode.audit`. */
  readonly auditTypes: readonly string[];
  readonly auditFrom: number;
  readonly auditTo: number;
  readonly newProposalIds: readonly string[];
  /** Those proposals as they were right after this step (status may change later). */
  readonly newProposals: readonly BookingProposal[];
  readonly newExpenseIds: readonly string[];
  /** Provider purchases after this step (cumulative). */
  readonly purchasesAfter: number;
  /** Scheduled (proactive) turn rather than a reply. */
  readonly proactive: boolean;
  /** Active members who were minors at this step (roster can change mid-episode). */
  readonly minors: readonly string[];
  /**
   * Active, non-guest members who had not left at this step (the product's
   * `activeMembers`), so a later departure never rewrites who could act then.
   * Absent on synthetic records: graders fall back to the end-of-episode roster.
   */
  readonly activeMembers?: readonly string[];
  /** The member's gesture on a say/react/tap step (reaction, button id, or a typed message's intent). */
  readonly action?: StepAction;
  /** Consent flags when this step's photos were sent (only for steps that sent photos). */
  readonly consentAtSend?: Readonly<Record<string, ConsentFlags | undefined>>;
  /** Store facts after the step (see `StepState`). */
  readonly state?: StepState;
  /** A scheduled turn run by the `advance` record at this index (a clock line). */
  readonly drainedFrom?: number;
  readonly skipped?: string;
  readonly error?: string;
}

export interface PromptRecord {
  /** Step that issued the model call (-1 outside steps). */
  readonly stepIndex: number;
  readonly kind: 'complete' | 'classify';
  readonly systemPromptId: string;
  /** `group` for the group chat loop, `dm` for a member's private thread, `other` for classifiers/extraction. */
  readonly lane: 'group' | 'dm' | 'other';
  readonly system: string;
  /** Messages (or the classifier input) as JSON text. */
  readonly messages: string;
  readonly toolNames: readonly string[];
  readonly source?: string;
}

export interface LintRecord {
  readonly messageId: string;
  readonly text: string;
  readonly violations: readonly string[];
}

export interface ProbeRecord {
  readonly probe: ProbeName;
  readonly stepIndex: number;
  readonly result: unknown;
}

export interface EpisodeSnapshot {
  readonly group: Group | undefined;
  readonly members: readonly Member[];
  readonly trip: Trip | undefined;
  readonly proposals: readonly BookingProposal[];
  readonly bookings: readonly Booking[];
  readonly expenses: readonly Expense[];
  readonly entries: readonly LedgerEntry[];
  readonly groupMemory: readonly GroupMemoryFact[];
  /** Every member's private memory facts (owner-private: graders search it, reports never print it). */
  readonly memberMemory?: readonly MemberMemoryFact[];
  readonly consent: Readonly<Record<string, ConsentFlags | undefined>>;
  /** Ticket artifacts per holder (counts only; payloads stay private). */
  readonly ticketsByHolder: Readonly<Record<string, number>>;
}

export interface Episode {
  readonly scenarioId: string;
  readonly mode: EvalMode;
  readonly steps: readonly StepRecord[];
  readonly transcript: readonly TranscriptEntry[];
  readonly audit: readonly AuditEvent[];
  readonly snapshot: EpisodeSnapshot;
  readonly prompts: readonly PromptRecord[];
  readonly lint: readonly LintRecord[];
  readonly probes: readonly ProbeRecord[];
  /** Provider purchases (tickets + flights + lodging) at the end. */
  readonly purchases: number;
  /** Mock payment charges at the end. */
  readonly charges: number;
  /** Replay lines that could not be turned into steps. */
  readonly skippedLines: readonly { readonly source: string; readonly reason: string }[];
  /** Scenario-level setup facts graders need. */
  readonly privateStrings: readonly string[];
  readonly expect: ScenarioExpect;
  /** Set when the runner threw; graders still run on what was recorded. */
  readonly error?: string;
}

export type EvalMode = 'offline' | 'live';

// ---------- graders ----------

export interface GraderResult {
  readonly graderId: string;
  /** SAFETY §3 id; a failing result with one is a hard failure. */
  readonly safetyId?: string;
  readonly score: number;
  readonly pass: boolean;
  readonly evidence: readonly string[];
  /** Skipped results (rubric offline, nothing to grade) count neither for nor against. */
  readonly skipped?: string;
}

export interface GradeContext {
  readonly mode: EvalMode;
  /** Live grader model access; absent offline. */
  readonly rubric?: RubricJudge;
}

export interface RubricJudge {
  judge(input: {
    readonly criterion: string;
    readonly transcript: string;
  }): Promise<{ readonly score: number; readonly rationale: string }>;
}

export interface Grader {
  readonly id: string;
  readonly title: string;
  /** Default SAFETY id (results may override). */
  readonly safetyId?: string;
  readonly kind: 'deterministic' | 'rubric';
  readonly weight: number;
  grade(
    episode: Episode,
    scenario: Scenario,
    ctx: GradeContext,
  ): readonly GraderResult[] | Promise<readonly GraderResult[]>;
}
