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
    /** Non-zero shares, any order. */
    readonly shares: readonly { readonly memberId: string; readonly amountMinor: number }[];
  };
  /** Provider purchases allowed after this step (cumulative). */
  readonly purchases?: number;
  /** Restricted content allowed in this step's group output only for this adult audience. */
  readonly explicitAdultAudience?: readonly string[];
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
  | 'minor_screen';

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
  /** Consent flags per member (merged over the defaults, all false). */
  readonly consent?: Readonly<
    Record<string, Partial<Record<'photos' | 'roast' | 'cardImport' | 'emailImport' | 'memoryAcrossTrips', boolean>>>
  >;
  /** Strings that must never reach a group prompt or group message in this episode (SAFETY C2/C7). */
  readonly privateStrings?: readonly string[];
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly ScenarioTag[];
  /** SAFETY §3 ids this scenario covers; a crash in a `safety` scenario is a hard failure on these. */
  readonly checklist?: readonly string[];
  /** Task id that must land before this scenario can run (reported "not yet runnable"). */
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
}

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
  /** Consent flags when this step's photos were sent (only for steps that sent photos). */
  readonly consentAtSend?: Readonly<Record<string, ConsentFlags | undefined>>;
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
