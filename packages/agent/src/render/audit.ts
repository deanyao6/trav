/**
 * Reading the booking lifecycle back out of the audit log (SAFETY §2.2;
 * ARCHITECTURE Flow 2 step 4). The receipt and "@trav what did you just do?"
 * are rendered from these facts, never from model text, and rendering
 * refuses (throws `invariant_violation`) when the log does not prove the
 * purchase went through the approval policy.
 */
import type { AuditEvent, MemberId, ProposalId, ReasonCode } from '@trav/core';
import { TravError, approval } from '@trav/core';

export interface AuditPayer {
  readonly memberId: MemberId;
  readonly shareMinor: number;
}

/** Facts from `booking.completed` (SAFETY §2.2: providerRef, totalMinor, currency, payers, attendees, refundable). */
export interface CompletedFacts {
  readonly event: AuditEvent;
  readonly providerRef: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly payers: readonly AuditPayer[];
  readonly attendees: readonly MemberId[];
  readonly refundable: boolean;
}

/** Facts from `policy.evaluated` + the approval that let the booking run. */
export interface PolicyFacts {
  readonly event: AuditEvent;
  readonly outcome: string;
  readonly reasons: readonly string[];
  /** Deciding rule id (`ruleIds[0]`, or derived from the first reason via `approval.POLICY_RULES`). */
  readonly ruleId: string;
  /** `approval.granted` events for the proposal, in log order. */
  readonly grants: readonly AuditEvent[];
  /** T-168: the ask the policy auto-approved on (`explicit` ask, `pick`), if any. */
  readonly ask?: 'explicit' | 'pick';
  /** T-168: the group's auto-buy cap when the policy ran (minor units). */
  readonly autoCapMinor?: number;
}

function fail(message: string, details?: Record<string, unknown>): never {
  throw new TravError('invariant_violation', `audit trail: ${message}`, details);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined;
}

function strings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

/** `payers` is `{ memberId, shareMinor }[]` (the proposal's payers). */
export function parsePayers(v: unknown): AuditPayer[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AuditPayer[] = [];
  for (const item of v) {
    if (item === null || typeof item !== 'object') return undefined;
    const rec = item as Record<string, unknown>;
    const memberId = str(rec['memberId']);
    const shareMinor = int(rec['shareMinor']);
    if (memberId === undefined || shareMinor === undefined) return undefined;
    out.push({ memberId, shareMinor });
  }
  return out;
}

/** Deciding rule for a `policy.evaluated` payload. */
export function ruleIdFromPolicyPayload(payload: Readonly<Record<string, unknown>>): string {
  const ids = strings(payload['ruleIds']);
  if (ids !== undefined && ids[0] !== undefined) return ids[0];
  const reasons = strings(payload['reasons']) ?? [];
  const first = reasons[0];
  if (first !== undefined) {
    const rule = approval.POLICY_RULES.find((r) => r.reasons.includes(first as ReasonCode));
    if (rule !== undefined) return rule.id;
  }
  return fail('policy.evaluated has no deciding rule');
}

export function completedFacts(event: AuditEvent): CompletedFacts {
  if (event.type !== 'booking.completed') fail(`expected booking.completed, got ${event.type}`);
  const p = event.payload;
  const providerRef = str(p['providerRef']);
  const totalMinor = int(p['totalMinor']);
  const currency = str(p['currency']);
  const payers = parsePayers(p['payers']);
  const attendees = strings(p['attendees']);
  const refundable = p['refundable'];
  if (
    providerRef === undefined ||
    totalMinor === undefined ||
    currency === undefined ||
    payers === undefined ||
    attendees === undefined ||
    typeof refundable !== 'boolean'
  ) {
    fail('booking.completed payload is missing required fields', { eventId: event.id });
  }
  return { event, providerRef, totalMinor, currency, payers, attendees, refundable };
}

/**
 * The policy decision and approvals that precede `before` (a `booking.completed`
 * event) for `proposalId`, in log order. Throws unless `policy.evaluated` exists,
 * its outcome was not `deny`, and (unless `auto_approve`) a complete
 * `approval.granted` came after it, all before the booking (SAFETY §2.2 rule).
 */
export function policyFactsBefore(
  events: readonly AuditEvent[],
  proposalId: ProposalId,
  before: AuditEvent,
): PolicyFacts {
  const idx = events.findIndex((e) => e.id === before.id);
  if (idx < 0) fail('booking.completed is not in the supplied events');
  const prior = events.slice(0, idx).filter((e) => e.proposalId === proposalId);
  const policyIdx = prior.map((e) => e.type).lastIndexOf('policy.evaluated');
  if (policyIdx < 0) fail('no policy.evaluated before booking.completed', { proposalId });
  const policy = prior[policyIdx]!;
  const outcome = str(policy.payload['outcome']) ?? fail('policy.evaluated has no outcome');
  if (outcome === 'deny') fail('policy denied this proposal', { proposalId });
  const grants = prior.slice(policyIdx + 1).filter((e) => e.type === 'approval.granted');
  if (outcome !== 'auto_approve' && !grants.some((g) => g.payload['complete'] === true)) {
    fail('no complete approval.granted before booking.completed', { proposalId });
  }
  const ask = policy.payload['ask'];
  const snapshot = policy.payload['policySnapshot'];
  const cap =
    typeof snapshot === 'object' && snapshot !== null
      ? (snapshot as Record<string, unknown>)['autoApproveCapMinor']
      : undefined;
  return {
    event: policy,
    outcome,
    reasons: strings(policy.payload['reasons']) ?? [],
    ruleId: ruleIdFromPolicyPayload(policy.payload),
    grants,
    ...(ask === 'explicit' || ask === 'pick' ? { ask } : {}),
    ...(typeof cap === 'number' ? { autoCapMinor: cap } : {}),
  };
}

/** Members who approved, from `approval.granted.memberId`, deduped, in log order. */
export function approverIds(grants: readonly AuditEvent[]): MemberId[] {
  const out: MemberId[] = [];
  for (const g of grants) {
    const id = str(g.payload['memberId']);
    if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Human line for the deciding rule (VOICE §6.3; used by "what did you just do?"). */
export function ruleExplanation(ruleId: string): string {
  switch (ruleId) {
    case 'C1':
      return 'it needed one tap'; // default_confirm (no clear ask) / over_auto_cap
    case 'C2':
      return 'flights and lodging need everyone paying';
    case 'C3':
      return 'it was over the per-person cap';
    case 'C4':
      return "it was over someone's personal cap";
    case 'C5':
      return 'non-refundable needs a lead';
    case 'C6':
      return 'it was over the daily cap';
    case 'C7':
      return 'it was over the trip cap';
    case 'C8':
      return 'a guardian okays for under-18s';
    case 'C9':
      return "it was on someone else's card";
    case 'C11':
      return 'flights and stays always need a tap';
    case 'A1':
      return 'it was asked for and under every cap';
    default:
      return 'policy check';
  }
}
