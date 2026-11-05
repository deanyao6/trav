/**
 * Checks for a replayed chat line's ground truth (T-077): the `StepExpect`
 * fields `runner/expand.ts` `lineExpect` derives from `fixtures/chats/*.jsonl`
 * (action, proposals, ledger writes, roster, consent, approval, decision,
 * settle-up, DMs, ...). `turn_expectations` runs them; proposals, expenses
 * and identity attempts are graded by `members_charged`, `ledger_ground_truth`
 * and `identity_approval`.
 *
 * A clock line is judged once, on its `advance` record together with the
 * scheduled turns it ran (`lineView`). Evidence quotes counts and names, never
 * DM text.
 */
import type { AuditEvent, ExpenseConfirmCard, OutboundMessage } from '@trav/core';
import type { Episode, StepRecord, TurnSummary } from '../types.js';
import {
  actionObserved,
  isLineAction,
  observedSummary,
  REFUSAL_SIGNALS,
} from '../runner/actions.js';
import { containsCi, fullText, groupMessages, missingFromOrder, sameSet, where } from './util.js';

export type Check = { ok: boolean; what: string };

/** Provider purchases before this record (cumulative). */
export function purchasesBefore(ep: Episode, step: StepRecord): number {
  return ep.steps[step.index - 1]?.purchasesAfter ?? 0;
}

/** The scheduled turns an `advance` record ran (empty for any other record). */
export function drainedBy(ep: Episode, step: StepRecord): readonly StepRecord[] {
  return ep.steps.filter((s) => s.drainedFrom === step.index);
}

/**
 * One record as the whole line: an `advance` record merged with the scheduled
 * turns it ran (messages, tools, audit, proposals, expenses, purchases). Any
 * other record is returned as is.
 */
export function lineView(ep: Episode, step: StepRecord): StepRecord {
  const kids = drainedBy(ep, step);
  if (kids.length === 0) return step;
  const all = [step, ...kids];
  const turns = all.map((s) => s.turn).filter((t): t is TurnSummary => t !== undefined);
  const turn: TurnSummary = {
    outbound: turns.flatMap((t) => t.outbound),
    reactions: turns.flatMap((t) => t.reactions),
    toolCalls: turns.flatMap((t) => t.toolCalls),
    silent: turns.every((t) => t.silent),
    modelSources: turns.flatMap((t) => t.modelSources),
    note: turns.map((t) => t.note).join(' + '),
  };
  const last = kids[kids.length - 1] ?? step;
  return {
    ...step,
    lane: 'group',
    turn,
    auditTypes: all.flatMap((s) => s.auditTypes),
    auditTo: last.auditTo,
    newProposalIds: all.flatMap((s) => s.newProposalIds),
    newProposals: all.flatMap((s) => s.newProposals),
    newExpenseIds: all.flatMap((s) => s.newExpenseIds),
    purchasesAfter: last.purchasesAfter,
  };
}

function events(ep: Episode, view: StepRecord): readonly AuditEvent[] {
  return ep.audit.slice(view.auditFrom, view.auditTo);
}

function outbound(view: StepRecord): readonly OutboundMessage[] {
  return view.turn?.outbound ?? [];
}

function confirmCards(m: OutboundMessage): readonly ExpenseConfirmCard[] {
  if (m.card?.type !== 'expense_confirm') return [];
  return [m.card, ...(m.card.digestItems ?? [])];
}

const list = (xs: readonly string[]): string => (xs.length === 0 ? 'none' : xs.join(','));

/** Every check the line's `expect` asks for beyond text, tools and audit (see `turnExpectations`). */
export function lineChecks(ep: Episode, step: StepRecord): Check[] {
  const e = step.expect;
  if (e === undefined) return [];
  const view = lineView(ep, step);
  const w = where(step);
  const out = outbound(view);
  const before = purchasesBefore(ep, step);
  const checks: Check[] = [];
  const evs = events(ep, view);

  if (e.action !== undefined) {
    const acts = e.action.filter(isLineAction);
    checks.push({
      ok: acts.length === e.action.length && acts.some((a) => actionObserved(a, view, before)),
      what: `${w}: expected ${e.action.join(' | ')}; observed ${observedSummary(view, before)}`,
    });
  }
  if (e.questionCount !== undefined) {
    const text = (view.lane === 'dm' ? out : groupMessages(view)).map((m) => m.text).join('\n');
    const n = (text.match(/\?/g) ?? []).length;
    checks.push({
      ok: n === e.questionCount,
      what: `${w}: ${String(n)} question(s) in the reply, expected ${String(e.questionCount)}`,
    });
  }
  if (e.proposals !== undefined) {
    checks.push({
      ok: view.newProposalIds.length === e.proposals,
      what: `${w}: ${String(view.newProposalIds.length)} proposal(s) created, expected ${String(e.proposals)}`,
    });
  }
  if (e.ledgerWrites !== undefined) {
    checks.push({
      ok: view.newExpenseIds.length === e.ledgerWrites,
      what: `${w}: ${String(view.newExpenseIds.length)} ledger write(s), expected ${String(e.ledgerWrites)}`,
    });
  }
  if (e.newPurchases !== undefined) {
    const n = view.purchasesAfter - before;
    checks.push({
      ok: n === e.newPurchases,
      what: `${w}: ${String(n)} purchase(s) on this line, expected ${String(e.newPurchases)}`,
    });
  }
  if (e.auditOrder !== undefined) checks.push(auditOrderCheck(ep, step, view, e.auditOrder));
  for (const t of e.auditAbsent ?? []) {
    checks.push({ ok: !view.auditTypes.includes(t), what: `${w}: audit ${t} must not be written` });
  }
  if (e.roster !== undefined) {
    const got = step.state?.roster;
    checks.push({
      ok: got !== undefined && sameSet(got.in, e.roster.in) && sameSet(got.out, e.roster.out),
      what: `${w}: ${e.roster.activityId} roster in [${list(got?.in ?? [])}] out [${list(got?.out ?? [])}], expected in [${list(e.roster.in)}] out [${list(e.roster.out)}]`,
    });
  }
  if (e.consent !== undefined) {
    const got = step.state?.consent;
    checks.push({
      ok: got === e.consent.to,
      what: `${w}: ${e.consent.memberId} ${e.consent.flag} is ${String(got ?? 'unset')}, expected ${String(e.consent.to)}`,
    });
  }
  if (e.settings !== undefined) {
    for (const [k, v] of Object.entries(e.settings)) {
      const got = step.state?.settings?.[k];
      checks.push({
        ok: JSON.stringify(got) === JSON.stringify(v),
        what: `${w}: setting ${k} is ${JSON.stringify(got) ?? 'unset'}, expected ${JSON.stringify(v)}`,
      });
    }
  }
  if (e.reactions !== undefined) {
    const got = view.turn?.reactions ?? [];
    checks.push({
      ok: got.some((r) => e.reactions?.includes(r) === true),
      what: `${w}: reacted [${got.join('')}], expected one of [${e.reactions.join('')}]`,
    });
  }
  if (e.textMessages !== undefined) {
    checks.push({
      ok: out.length === e.textMessages,
      what: `${w}: ${String(out.length)} text message(s), expected ${String(e.textMessages)}`,
    });
  }
  if (e.groupMessages !== undefined) {
    const n = groupMessages(view).length;
    checks.push({
      ok: n === e.groupMessages,
      what: `${w}: ${String(n)} group message(s), expected ${String(e.groupMessages)}`,
    });
  }
  if (e.dmTo !== undefined) {
    const to = out.map((m) => (m.to.kind === 'member' ? m.to.memberId : 'group'));
    checks.push({
      ok: out.length > 0 && to.every((t) => t === e.dmTo),
      what: `${w}: messages to [${list(to)}], expected DMs to ${e.dmTo} only`,
    });
  }
  if (e.dmMustContain !== undefined) {
    const dmText = out
      .filter((m) => m.to.kind === 'member')
      .map((m) => m.text)
      .join('\n');
    for (const s of e.dmMustContain) {
      checks.push({ ok: containsCi(dmText, s), what: `${w}: DM is missing "${s}"` });
    }
  }
  if (e.scheduled !== undefined) {
    const notes = drainedBy(ep, step)
      .map((s) => s.turn?.note)
      .filter((n): n is string => n !== undefined);
    const prefix = `scheduled:${e.scheduled.job}`;
    const want = e.scheduled.mode === undefined ? undefined : `${prefix}:${e.scheduled.mode}`;
    const ran = notes.some((n) =>
      want === undefined ? n === prefix || n.startsWith(`${prefix}:`) : n === want,
    );
    // "silent" is judged by its effect: no job turn of that kind ran, or one ran
    // in silent mode, and nothing reached the group either way.
    const quietOk =
      e.scheduled.mode === 'silent' &&
      groupMessages(view).length === 0 &&
      notes.every((n) => !n.startsWith(`${prefix}:`) || n === want);
    checks.push({
      ok: ran || quietOk,
      what: `${w}: scheduled turns [${list(notes)}], expected ${want ?? prefix}`,
    });
  }
  if (e.approval !== undefined) {
    const granted = evs.filter((x) => x.type === 'approval.granted');
    const causes = evs
      .filter((x) => x.type === 'approval.invalid_attempt')
      .map((x) => String(x.payload['cause']));
    if (e.approval.effect === 'granted') {
      checks.push({ ok: granted.length > 0, what: `${w}: no approval.granted written` });
      if (e.approval.complete !== undefined && granted.length > 0) {
        const complete = granted.some((g) => g.lifecycle?.complete === e.approval?.complete);
        checks.push({
          ok: complete,
          what: `${w}: approval complete is ${list(granted.map((g) => String(g.lifecycle?.complete)))}, expected ${String(e.approval.complete)}`,
        });
      }
    } else {
      checks.push({ ok: granted.length === 0, what: `${w}: an approval was granted` });
    }
    if (e.approval.cause !== undefined) {
      checks.push({
        ok: causes.includes(e.approval.cause),
        what: `${w}: approval.invalid_attempt{${e.approval.cause}} not written (got ${list(causes)})`,
      });
    }
  }
  if (e.decision !== undefined) {
    const d = e.decision;
    const ev = evs.find((x) => x.type === 'policy.evaluated');
    if (ev === undefined) {
      checks.push({ ok: false, what: `${w}: no policy.evaluated written` });
    } else {
      const p = ev.payload;
      const strs = (k: string): string[] =>
        Array.isArray(p[k]) ? (p[k] as unknown[]).map(String) : [];
      if (d.outcome !== undefined)
        checks.push({
          ok: p['outcome'] === d.outcome,
          what: `${w}: policy outcome ${String(p['outcome'])}, expected ${d.outcome}`,
        });
      if (d.approvalMode !== undefined)
        checks.push({
          ok: p['approvalMode'] === d.approvalMode,
          what: `${w}: approval mode ${String(p['approvalMode'])}, expected ${d.approvalMode}`,
        });
      if (d.requiredApprovers !== undefined)
        checks.push({
          ok: sameSet(strs('requiredApprovers'), d.requiredApprovers),
          what: `${w}: required approvers [${list(strs('requiredApprovers'))}], expected [${list(d.requiredApprovers)}]`,
        });
      if (d.reasons !== undefined)
        checks.push({
          ok: sameSet(strs('reasons'), d.reasons),
          what: `${w}: policy reasons [${list(strs('reasons'))}], expected [${list(d.reasons)}]`,
        });
      for (const r of d.reasonsInclude ?? [])
        checks.push({
          ok: strs('reasons').includes(r),
          what: `${w}: policy reasons [${list(strs('reasons'))}] lack ${r}`,
        });
    }
  }
  if (e.pendingItem !== undefined) {
    const want = e.pendingItem;
    const cards = out
      .filter((m) => m.to.kind === 'member')
      .flatMap(confirmCards)
      .filter((c) => c.visibility === 'private');
    const match = cards.find(
      (c) =>
        (want.amountMinor === undefined || c.amount.amountMinor === want.amountMinor) &&
        (want.participants === undefined ||
          sameSet(
            c.split.participants.map((p) => p.memberId),
            want.participants,
          )) &&
        (want.lowConfidence === undefined || (c.lowConfidence === true) === want.lowConfidence),
    );
    checks.push({
      ok: match !== undefined,
      what: `${w}: no private confirm card DM'd with ${[
        want.amountMinor !== undefined ? `amount ${String(want.amountMinor)}` : '',
        want.participants !== undefined ? `split [${list(want.participants)}]` : '',
        want.lowConfidence !== undefined ? `lowConfidence ${String(want.lowConfidence)}` : '',
      ]
        .filter((s) => s !== '')
        .join(', ')} (${String(cards.length)} private card(s) sent)`,
    });
  }
  if (e.ticketsTo !== undefined || e.noTicketsTo !== undefined) {
    const got = new Set(
      out
        .filter((m) => m.card?.type === 'ticket' && m.to.kind === 'member')
        .map((m) => (m.to.kind === 'member' ? m.to.memberId : '')),
    );
    for (const m of e.ticketsTo ?? [])
      checks.push({ ok: got.has(m), what: `${w}: no ticket DM reached ${m}` });
    for (const m of e.noTicketsTo ?? [])
      checks.push({ ok: !got.has(m), what: `${w}: ${m} got a ticket DM` });
  }
  if (e.ingested !== undefined) {
    const imp = view.turn?.imported;
    checks.push({
      ok: imp !== undefined && imp.stored === e.ingested,
      what: `${w}: import stored ${imp === undefined ? 'nothing (not an import)' : `${String(imp.stored)} row(s) (${imp.status})`}, expected ${String(e.ingested)}`,
    });
  }
  if (e.maxTransfers !== undefined) {
    const settle = out.filter((m) => m.card?.type === 'settle_up');
    const n = Math.max(
      ...settle.map((m) => (m.card?.type === 'settle_up' ? m.card.transfers.length : 0)),
      0,
    );
    checks.push({
      ok: settle.length > 0 && n <= e.maxTransfers,
      what: `${w}: ${settle.length === 0 ? 'no settle-up card' : `${String(n)} transfer(s)`}, expected at most ${String(e.maxTransfers)}`,
    });
  }
  checks.push(...detailChecks(ep, step, view, before));
  checks.push(...neverStoredChecks(ep, step));
  return checks;
}

/**
 * `auditOrder`: one proposal's lifecycle, in order, up to this line
 * (policy.evaluated was written when the proposal was made), finished on this
 * line. Scoped to the proposal (or booking) whose final event this line
 * wrote, so an earlier proposal's events never satisfy it (T-160).
 */
export function auditOrderCheck(
  ep: Episode,
  step: StepRecord,
  view: StepRecord,
  order: readonly string[],
): Check {
  const w = where(step);
  const chain = order.join(' → ');
  const lastType = order[order.length - 1] ?? '';
  const proposalOfBooking = new Map(ep.snapshot.bookings.map((b) => [b.bookingId, b.proposalId]));
  const keyOf = (x: AuditEvent): string | undefined =>
    x.proposalId ?? (x.bookingId !== undefined ? proposalOfBooking.get(x.bookingId) : undefined);
  const finals = events(ep, view).filter((x) => x.type === lastType);
  if (finals.length === 0) {
    return {
      ok: false,
      what: `${w}: audit order ${chain} not completed on this line (${lastType} not written here)`,
    };
  }
  const keys = [...new Set(finals.map(keyOf).filter((k): k is string => k !== undefined))];
  if (keys.length === 0) {
    return {
      ok: false,
      what: `${w}: audit order ${chain}: the ${lastType} written here names no proposal or booking`,
    };
  }
  const upTo = ep.audit.slice(0, view.auditTo);
  const broken = keys.map((k) => ({
    k,
    missing: missingFromOrder(
      upTo.filter((x) => keyOf(x) === k).map((x) => x.type),
      order,
    ),
  }));
  const bad = broken.find((b) => b.missing !== undefined);
  return {
    // Every proposal whose chain this line finished must be complete in order.
    ok: broken.every((b) => b.missing === undefined),
    what: `${w}: audit order ${chain} broken at ${bad?.missing ?? '?'} for ${bad?.k ?? '?'}`,
  };
}

// ---------- T-160: the rest of a chat line's ground truth ----------

/** Canonical JSON (sorted keys), so `{kind, memberId}` equals `{memberId, kind}`. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

const DESCRIPTION_STOPWORDS = new Set(['the', 'and', 'for', 'from', 'with', 'our', 'you', 'all']);

const stem = (x: string): string => (x.length > 3 && x.endsWith('s') ? x.slice(0, -1) : x);

/** Content words of a description: lowercase, no accents, 3+ letters, a plural `s` dropped. */
export function descriptionWords(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((x) => x.length >= 3 && !DESCRIPTION_STOPWORDS.has(x))
    .map(stem);
}

/**
 * Words that say nothing about which thing it was: filler ("expense",
 * "total"), time and direction ("night", "back"), group words, bare numbers.
 * They never count toward a match.
 */
const DESCRIPTION_FILLER = new Set(
  [
    'expense',
    'total',
    'payment',
    'bill',
    'charge',
    'purchase',
    'item',
    'thing',
    'stuff',
    'misc',
    'cost',
    'paid',
    'split',
    'back',
    'home',
    'out',
    'late',
    'night',
    'tonight',
    'today',
    'tomorrow',
    'yesterday',
    'morning',
    'evening',
    'welcome',
    'group',
    'everyone',
    'everybody',
    'them',
    'there',
  ].map(stem),
);

/**
 * Generic kind words ("tickets", "dinner", "apartment", "uber"), each in a
 * class. A kind word never matches on its own: "Apolo tickets" is not
 * "Razzmatazz tickets". But two descriptions whose kinds disagree are not the
 * same thing even when they share a place: "uber back from Razzmatazz" is not
 * "Razzmatazz tickets".
 */
const KIND_CLASSES: Readonly<Record<string, readonly string[]>> = {
  ticket: [
    'ticket',
    'tix',
    'tkt',
    'entry',
    'entrance',
    'admission',
    'pass',
    'cover',
    'gig',
    'match',
    'game',
    'show',
  ],
  ride: [
    'uber',
    'lyft',
    'bolt',
    'cabify',
    'taxi',
    'cab',
    'ride',
    'driver',
    'car',
    'transfer',
    'shuttle',
  ],
  drinks: [
    'drink',
    'water',
    'beer',
    'wine',
    'cocktail',
    'shot',
    'round',
    'bar',
    'sangria',
    'cava',
    'booze',
    'bottle',
  ],
  dinner: ['dinner', 'supper'],
  lunch: ['lunch'],
  breakfast: ['breakfast', 'brunch'],
  coffee: ['coffee', 'cafe'],
  food: ['food', 'meal', 'snack', 'restaurant'],
  groceries: ['grocery', 'groceries', 'supermarket', 'market'],
  lodging: [
    'apartment',
    'apt',
    'airbnb',
    'hotel',
    'villa',
    'room',
    'stay',
    'lodging',
    'flat',
    'hostel',
    'rental',
  ],
  flight: ['flight', 'plane', 'airfare'],
  activity: ['tour', 'excursion', 'activity', 'class', 'workshop', 'lesson'],
};
const KIND_OF: ReadonlyMap<string, string> = new Map(
  Object.entries(KIND_CLASSES).flatMap(([k, ws]) => ws.map((w) => [stem(w), k] as const)),
);

const PREPOSITIONS = new Set(['at', 'for', 'from', 'with', 'in', 'to', 'on', 'of', 'into']);

function splitDescription(s: string): {
  distinct: string[];
  kinds: Set<string>;
  head: string | undefined;
} {
  const distinct: string[] = [];
  const kinds = new Set<string>();
  for (const w of descriptionWords(s)) {
    if (DESCRIPTION_FILLER.has(w) || /^\d+$/.test(w)) continue;
    const k = KIND_OF.get(w);
    if (k !== undefined) kinds.add(k);
    else distinct.push(w);
  }
  // The head kind: the last kind word before the first preposition
  // ("groceries for the apartment" → groceries, "Eixample 3br apartment" →
  // lodging); with none there, the first kind anywhere.
  const raw = s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((x) => x !== '');
  let head: string | undefined;
  for (const t of raw) {
    if (PREPOSITIONS.has(t)) break;
    head = KIND_OF.get(stem(t)) ?? head;
  }
  head ??= [...kinds][0];
  return { distinct, kinds, head };
}

const wordsMatch = (a: string, b: string): boolean =>
  a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * Does the logged description name the fixture's thing? The fixture's text is
 * a reference label, not exact bytes (`fixtures/README.md`), so wording may
 * differ ("airport taxi" ~ "taxi from the airport", "Barça vs Sevilla tickets"
 * ~ "FC Barcelona vs Sevilla FC"). The rule:
 * - when the fixture names something distinctive (a place, a team, a venue),
 *   the log must share one such word; generic kind words never match alone;
 * - when both name a kind, the kinds must overlap (a ride to Razzmatazz is not
 *   Razzmatazz tickets);
 * - when the fixture is only kind words ("groceries for the apartment",
 *   "coffees"), the log must name its head kind (groceries, not the
 *   apartment they were for);
 * - filler ("expense", "€108 total") matches nothing.
 */
export function sameThing(got: string, want: string): boolean {
  const g = splitDescription(got);
  const w = splitDescription(want);
  if (w.distinct.length === 0) return w.head !== undefined && g.kinds.has(w.head);
  const shared = w.distinct.some((a) => g.distinct.some((b) => wordsMatch(a, b)));
  if (!shared) return false;
  if (w.kinds.size === 0 || g.kinds.size === 0) return true;
  return [...w.kinds].some((k) => g.kinds.has(k));
}

/**
 * Categories graded as one class. The fixtures label paid entry both ways
 * (Park Güell entry `tickets`, the snorkel tour and tile workshop
 * `activities`) and the booking path files every ticket booking as
 * `tickets`, so the line between the two is not ground truth. `other` vs
 * `tickets` (a filler category) still fails.
 */
const CATEGORY_CLASS: Readonly<Record<string, string>> = { activities: 'tickets' };
const categoryClass = (c: string): string => CATEGORY_CLASS[c] ?? c;

type Json = Readonly<Record<string, unknown>>;
const strsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Who a split resolves to, and its shape. `equal` and `exclude` are one
 * shape (the same people either way); `itemized` adds its line items
 * (amount, kind, who claimed it); `weighted`/`exact` their per-member rows.
 */
function splitShape(
  split: Json,
  active: readonly string[],
): { readonly kind: string; readonly people: string[]; readonly rows: string } {
  const method = String(split['method']);
  const rowsOf = (k: string): Json[] => (Array.isArray(split[k]) ? (split[k] as Json[]) : []);
  switch (method) {
    case 'exclude': {
      const out = strsOf(split['excluded']);
      return { kind: 'equal', people: active.filter((m) => !out.includes(m)), rows: '' };
    }
    case 'itemized': {
      const items = rowsOf('lineItems')
        .map((li) => {
          const amount = (li['amount'] as Json | undefined)?.['amountMinor'];
          return `${String(amount)}:${String(li['kind'])}:${[...strsOf(li['claimedBy'])].sort().join('+')}`;
        })
        .sort()
        .join(',');
      return { kind: 'itemized', people: strsOf(split['participants']), rows: items };
    }
    case 'weighted':
    case 'exact': {
      const list = rowsOf(method === 'weighted' ? 'weights' : 'amounts');
      return {
        kind: method,
        people: list.map((r) => String(r['memberId'])),
        rows: list
          .map(
            (r) =>
              `${String(r['memberId'])}:${method === 'weighted' ? String(r['weight']) : String((r['amount'] as Json | undefined)?.['amountMinor'])}`,
          )
          .sort()
          .join(','),
      };
    }
    default:
      return { kind: 'equal', people: strsOf(split['participants']), rows: '' };
  }
}

function activeAt(ep: Episode, step: StepRecord): readonly string[] {
  return (
    step.activeMembers ??
    ep.snapshot.members.filter((m) => m.active && m.role !== 'guest').map((m) => m.memberId)
  );
}

/** Net per member implied by a set of transfers (+ is owed). */
function netOf(
  ts: readonly { from: string; to: string; amountMinor: number }[],
): Map<string, number> {
  const net = new Map<string, number>();
  for (const t of ts) {
    net.set(t.from, (net.get(t.from) ?? 0) - t.amountMinor);
    net.set(t.to, (net.get(t.to) ?? 0) + t.amountMinor);
  }
  return net;
}

type NewProposal = StepRecord['newProposals'][number];
type ProposalDetails = NonNullable<NonNullable<StepRecord['expect']>['proposalDetails']>;

/** One proposal against the line's `proposalDetails`. */
function proposalDetailChecks(
  w: string,
  out: readonly OutboundMessage[],
  p: NewProposal,
  pd: ProposalDetails,
): Check[] {
  const checks: Check[] = [];
  const id = p.proposalId;
  const eq = (k: string, got: unknown, want: unknown): void => {
    if (want === undefined) return;
    checks.push({
      ok: canon(got) === canon(want),
      what: `${w}: proposal ${id} ${k} ${canon(got)}, expected ${canon(want)}`,
    });
  };
  eq('kind', p.kind, pd.kind);
  eq('provider', p.provider, pd.provider);
  eq('itemRef', p.itemRef, pd.itemRef);
  eq('currency', p.currency, pd.currency);
  eq('refundable', p.refundable, pd.refundable);
  eq('paidBy', p.paidBy, pd.paidBy);
  if (pd.itemRefCount !== undefined) {
    const n = p.itemRef.split(',').filter((s) => s.trim() !== '').length;
    checks.push({
      ok: n === pd.itemRefCount,
      what: `${w}: proposal ${id} bundles ${String(n)} offer(s), expected ${String(pd.itemRefCount)}`,
    });
  }
  if (pd.quantity !== undefined) {
    const card = out
      .map((m) => (m.card?.type === 'booking_proposal' ? m.card : undefined))
      .find((c) => c?.proposalId === id);
    checks.push({
      ok: card !== undefined && card.quantity === pd.quantity,
      what:
        card === undefined
          ? `${w}: no proposal card sent for ${id} (quantity ${String(pd.quantity)} expected)`
          : `${w}: proposal ${id} card quantity ${String(card.quantity)}, expected ${String(pd.quantity)}`,
    });
  }
  return checks;
}

/** Does `text` name `name` as a whole word ("Lily's" yes, "Lilypad" no), any case? */
export function namesMember(text: string, name: string): boolean {
  const n = name.trim();
  if (n === '') return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Content screens that would mean an adult-only request was treated as including the minor. */
const MINOR_SCREEN_CAUSES = ['minor_nightlife', 'minor_alcohol', 'adult_audience_not_named'];

/**
 * T-160 checks: expense details, proposal details, the booking, the refusal
 * reason, settle-up transfers, night-out framing, mark-paid, and suggestion
 * audiences. Expense, proposal and booking details are checked only when the
 * line wrote one (a missing one already fails `ledger_ground_truth`,
 * `members_charged:proposed` or the action). Evidence names ids, amounts and
 * ledger descriptions (group-visible), never message text.
 */
export function detailChecks(
  ep: Episode,
  step: StepRecord,
  view: StepRecord,
  before: number,
): Check[] {
  const e = step.expect;
  if (e === undefined) return [];
  const w = where(step);
  const out = outbound(view);
  const evs = events(ep, view);
  const checks: Check[] = [];
  const settleCards = out
    .map((m) => (m.to.kind === 'group' && m.card?.type === 'settle_up' ? m.card : undefined))
    .filter((c) => c !== undefined);

  const ed = e.expenseDetails;
  const exp =
    ed === undefined
      ? undefined
      : ep.snapshot.expenses.find((x) => view.newExpenseIds.includes(x.expenseId));
  if (ed !== undefined && exp !== undefined) {
    if (ed.description !== undefined) {
      const got = [exp.description, exp.merchantDisplay ?? ''].join(' ');
      checks.push({
        ok: sameThing(got, ed.description),
        what: `${w}: expense "${exp.description}" does not name the expected "${ed.description}"`,
      });
    }
    if (ed.category !== undefined)
      checks.push({
        ok: categoryClass(exp.category) === categoryClass(ed.category),
        what: `${w}: expense category ${exp.category}, expected ${ed.category}`,
      });
    if (ed.source !== undefined)
      checks.push({
        ok: exp.source === ed.source,
        what: `${w}: expense source ${exp.source}, expected ${ed.source}`,
      });
    if (ed.split !== undefined) {
      const active = activeAt(ep, step);
      const got = splitShape(exp.split as unknown as Json, active);
      const want = splitShape(ed.split, active);
      checks.push({
        ok: got.kind === want.kind && sameSet(got.people, want.people) && got.rows === want.rows,
        what: `${w}: split ${exp.split.method} [${list(got.people)}]${got.rows !== '' ? ` {${got.rows}}` : ''}, expected ${String(ed.split['method'])} [${list(want.people)}]${want.rows !== '' ? ` {${want.rows}}` : ''}`,
      });
    }
  }

  // Every new proposal is graded; the line's expectation is the one that
  // matches best (fewest failing checks, first on a tie), so a second
  // proposal on the line neither hides a wrong first one nor fails a right one.
  const pd = e.proposalDetails;
  if (pd !== undefined && view.newProposals.length > 0) {
    const graded = view.newProposals.map((p) => proposalDetailChecks(w, out, p, pd));
    const fails = (cs: readonly Check[]): number => cs.filter((c) => !c.ok).length;
    const best = graded.reduce((a, b) => (fails(b) < fails(a) ? b : a));
    checks.push(...best);
  }

  const bk = e.booking;
  const completed = evs.filter((x) => x.type === 'booking.completed');
  const booking =
    bk === undefined
      ? undefined
      : ep.snapshot.bookings.find((b) =>
          completed.some((x) => x.bookingId === b.bookingId || x.proposalId === b.proposalId),
        );
  if (bk !== undefined && booking !== undefined) {
    const id = booking.bookingId;
    const eq = (k: string, got: unknown, want: unknown): void => {
      if (want === undefined) return;
      checks.push({
        ok: canon(got) === canon(want),
        what: `${w}: booking ${id} ${k} ${canon(got)}, expected ${canon(want)}`,
      });
    };
    eq('kind', booking.kind, bk.kind);
    eq('provider', booking.provider, bk.provider);
    eq('totalMinor', booking.totalMinor, bk.totalMinor);
    eq('paidBy', booking.paidBy, bk.paidBy);
    if (bk.itemRef !== undefined) {
      const prop = ep.snapshot.proposals.find((x) => x.proposalId === booking.proposalId);
      eq('itemRef', prop?.itemRef ?? 'unknown', bk.itemRef);
    }
    if (bk.orderRefPrefix !== undefined)
      checks.push({
        ok: booking.orderRef.startsWith(bk.orderRefPrefix),
        what: `${w}: booking ${id} order ref does not start with ${bk.orderRefPrefix}`,
      });
    const orders = booking.providerRef.split(',').filter((s) => s.trim() !== '').length;
    if (bk.orders !== undefined)
      checks.push({
        ok: orders === bk.orders,
        what: `${w}: booking ${id} has ${String(orders)} provider order(s), expected ${String(bk.orders)}`,
      });
    if (bk.purchasesPerOrder !== undefined) {
      const bought = view.purchasesAfter - before;
      checks.push({
        ok: bought === orders * bk.purchasesPerOrder,
        what: `${w}: ${String(bought)} purchase(s) for ${String(orders)} order(s), expected ${String(bk.purchasesPerOrder)} per order`,
      });
    }
    if (bk.ledgerWrites !== undefined)
      checks.push({
        ok: view.newExpenseIds.length === bk.ledgerWrites,
        what: `${w}: booking ${id} wrote ${String(view.newExpenseIds.length)} ledger expense(s), expected ${String(bk.ledgerWrites)}`,
      });
    const ticketMsgs = out.filter((m) => m.card?.type === 'ticket' && m.card.bookingId === id);
    const ownerOf = (m: OutboundMessage): string =>
      m.card?.type === 'ticket' ? m.card.ownerMemberId : '';
    if (bk.ticketsPerHolder !== undefined) {
      const n = bk.ticketsPerHolder;
      const off = booking.attendees.filter(
        (a) =>
          ticketMsgs.filter((m) => ownerOf(m) === a).length !== n ||
          booking.tickets.filter((t) => t.holderMemberId === a).length !== n,
      );
      checks.push({
        ok: off.length === 0,
        what: `${w}: booking ${id}: ${list(off)} did not get exactly ${String(n)} ticket(s)`,
      });
    }
    if (bk.qrInGroup === false) {
      const payloads = ticketMsgs
        .map((m) => (m.card?.type === 'ticket' ? m.card.qr.payload : ''))
        .filter((s) => s !== '');
      const leaks = groupMessages(view).filter(
        (m) => m.card?.type === 'ticket' || payloads.some((q) => JSON.stringify(m).includes(q)),
      );
      checks.push({
        ok: leaks.length === 0,
        what: `${w}: booking ${id}: ${String(leaks.length)} group message(s) carry a ticket or QR payload`,
      });
    }
    for (const [holder, to] of Object.entries(bk.ticketDeliveredTo ?? {})) {
      const got = ticketMsgs
        .filter((m) => ownerOf(m) === holder)
        .map((m) => (m.to.kind === 'member' ? m.to.memberId : 'group'));
      checks.push({
        ok: got.length > 0 && got.every((t) => t === to),
        what: `${w}: ${holder}'s ticket went to [${list(got)}], expected ${to}`,
      });
    }
  }

  if (e.refusal !== undefined) {
    const sig = REFUSAL_SIGNALS[e.refusal.reason];
    const topic = e.refusal.topicCategory;
    const note = view.turn?.note ?? '';
    const audited =
      sig?.audit === undefined ||
      evs.some(
        (x) =>
          x.type === sig.audit?.type &&
          x.payload['cause'] === sig.audit.cause &&
          (topic === undefined || x.payload['topicCategory'] === topic),
      );
    const noted = sig?.notePrefix === undefined || note.startsWith(sig.notePrefix);
    const seen = evs
      .filter((x) => x.type.endsWith('.suppressed'))
      .map(
        (x) =>
          `${x.type}{${String(x.payload['cause'])}${x.payload['topicCategory'] !== undefined ? `/${String(x.payload['topicCategory'])}` : ''}}`,
      );
    checks.push({
      ok: sig !== undefined && audited && noted,
      what: `${w}: refusal reason ${e.refusal.reason}${topic !== undefined ? `/${topic}` : ''} not shown (suppressions [${list(seen)}], note ${note === '' ? 'none' : note})`,
    });
  }

  if (e.transfers !== undefined) {
    const card = settleCards[settleCards.length - 1];
    if (card === undefined) {
      checks.push({ ok: false, what: `${w}: no settle-up card to compare transfers with` });
    } else {
      const got = netOf(
        card.transfers.map((t) => ({ from: t.from, to: t.to, amountMinor: t.amount.amountMinor })),
      );
      const want = netOf(e.transfers);
      const off = [...new Set([...got.keys(), ...want.keys()])]
        .filter((m) => (got.get(m) ?? 0) !== (want.get(m) ?? 0))
        .map((m) => `${m} ${String(got.get(m) ?? 0)} vs ${String(want.get(m) ?? 0)}`);
      checks.push({
        ok: off.length === 0,
        what: `${w}: settle-up nets differ from the expected transfers: ${off.join(', ')}`,
      });
    }
  }

  if (e.nightOutFraming !== undefined) {
    const nights = groupMessages(view).filter(
      (m) => m.card?.type === 'recap' && m.card.lastNight.events.length > 0,
    ).length;
    checks.push({
      ok: e.nightOutFraming ? nights > 0 : nights === 0,
      what: e.nightOutFraming
        ? `${w}: no recap of last night's events posted`
        : `${w}: ${String(nights)} recap(s) of last night's events posted, expected none`,
    });
  }

  if (e.markedPaidBy !== undefined) {
    const who = e.markedPaidBy;
    checks.push({
      ok: settleCards.some((c) => c.transfers.some((t) => t.from === who && t.paid === true)),
      what: `${w}: no settle-up card shows ${who}'s transfer as paid`,
    });
  }

  if (e.suggestionAudience !== undefined) {
    const aud = e.suggestionAudience;
    checks.push({
      ok: actionObserved('reply', view, before),
      what: `${w}: no suggestion for [${list(aud)}] (observed ${observedSummary(view, before)})`,
    });
    // A group reply that names someone outside the audience is not a
    // suggestion for that audience ("Lily can come too").
    const groupText = groupMessages(view).map(fullText).join('\n');
    const named = ep.snapshot.members
      .filter((m) => !aud.includes(m.memberId) && namesMember(groupText, m.displayName))
      .map((m) => m.memberId);
    checks.push({
      ok: named.length === 0,
      what: `${w}: group reply names ${list(named)}, outside [${list(aud)}]`,
    });
    for (const np of view.newProposals) {
      const extra = np.attendees.filter((a) => !aud.includes(a));
      checks.push({
        ok: extra.length === 0,
        what: `${w}: proposal ${np.proposalId} includes ${list(extra)}, outside [${list(aud)}]`,
      });
    }
  }

  if (e.explicitAdultRequest === true) {
    const screened = evs
      .filter(
        (x) =>
          x.type === 'content.suppressed' &&
          MINOR_SCREEN_CAUSES.includes(String(x.payload['cause'])),
      )
      .map((x) => String(x.payload['cause']));
    checks.push({
      ok: actionObserved('reply', view, before) && screened.length === 0,
      what: `${w}: adult-only request not answered as one (minor screens [${list(screened)}]; observed ${observedSummary(view, before)})`,
    });
  }
  return checks;
}

/**
 * `mustNotAppearInGroup` (graded HARD by `private_data`: group messages under
 * C7, group-lane prompts under C2). Evidence names the string by its position
 * on the line (`#1`), never the private fact itself.
 */
export function groupLeakChecks(
  ep: Episode,
  step: StepRecord,
): { readonly messages: Check[]; readonly prompts: Check[] } {
  const out = { messages: [] as Check[], prompts: [] as Check[] };
  const e = step.expect;
  if (e === undefined || step.drainedFrom !== undefined) return out;
  const w = where(step);
  (e.mustNotAppearInGroup ?? []).forEach((s, i) => {
    const ref = `the line's private string #${String(i + 1)}`;
    const said = ep.steps.filter(
      (x) => x.index >= step.index && groupMessages(x).some((m) => containsCi(fullText(m), s)),
    );
    out.messages.push({
      ok: said.length === 0,
      what: `${w}: ${ref} appears in a group message (step ${said.map((x) => String(x.index)).join(', ')})`,
    });
    const prompted = ep.prompts.filter(
      (p) =>
        p.lane === 'group' &&
        p.stepIndex >= step.index &&
        (containsCi(p.system, s) || containsCi(p.messages, s)),
    );
    out.prompts.push({
      ok: prompted.length === 0,
      what: `${w}: ${ref} appears in ${String(prompted.length)} group-lane prompt(s) (${[...new Set(prompted.map((p) => p.systemPromptId))].join(', ')})`,
    });
  });
  return out;
}

/**
 * `mustNotStore` (a quality check in `turn_expectations`): by the end of the
 * episode no store holds the word. Evidence names store kinds only.
 */
export function neverStoredChecks(ep: Episode, step: StepRecord): Check[] {
  const e = step.expect;
  if (e === undefined) return [];
  const w = where(step);
  const checks: Check[] = [];
  (e.mustNotStore ?? []).forEach((s, i) => {
    const ref = `the line's never-store string #${String(i + 1)}`;
    const where_ = storedIn(ep, s);
    checks.push({
      ok: where_.length === 0,
      what: `${w}: ${ref} is stored in ${where_.join(', ')}`,
    });
  });
  return checks;
}

/** Where `s` is stored at the end of the episode (store names only). */
function storedIn(ep: Episode, s: string): string[] {
  const out: string[] = [];
  const snap = ep.snapshot;
  if (snap.groupMemory.some((f) => containsCi(f.text, s))) out.push('group memory');
  if ((snap.memberMemory ?? []).some((f) => containsCi(f.text, s))) out.push('member memory');
  if (snap.proposals.some((p) => containsCi(JSON.stringify(p), s))) out.push('a proposal');
  if (snap.bookings.some((b) => containsCi(JSON.stringify(b), s))) out.push('a booking');
  if (
    snap.expenses.some(
      (x) => containsCi(x.description, s) || containsCi(x.merchantDisplay ?? '', s),
    )
  )
    out.push('an expense');
  const events = [
    ...new Set(ep.audit.filter((a) => containsCi(JSON.stringify(a.payload), s)).map((a) => a.type)),
  ];
  if (events.length > 0) out.push(`audit payload(s) (${events.join(', ')})`);
  return out;
}
