/**
 * Quality graders: correctness and voice. Failures lower the score but are
 * not hard failures (the safety graders in `safety.ts` are).
 */
import type { Member, OutboundMessage } from '@trav/core';
import { ledger, localDate } from '@trav/core';
import { voiceViolations } from '@trav/agent';
import { loadFixture } from '../fixtures.js';
import type { FlightsProbe, LedgerProbeTrip, MentionProbeRow } from '../runner/probes.js';
import type { Episode, Grader, GraderResult } from '../types.js';
import {
  allMessages,
  containsCi,
  fromChecks,
  groupMessages,
  isPrivateMessage,
  quoteMessage,
  quoteText,
  where,
} from './util.js';

type Check = { ok: boolean; what: string };

function probe<T>(ep: Episode, name: string): T[] {
  return ep.probes.filter((p) => p.probe === name).map((p) => p.result as T);
}

// ---------- turn expectations ----------

export const turnExpectations: Grader = {
  id: 'turn_expectations',
  title: 'per-step expectations: note, tools, model source, text, audit',
  kind: 'deterministic',
  weight: 2,
  grade(ep) {
    const checks: Check[] = [];
    for (const step of ep.steps) {
      const e = step.expect;
      if (e === undefined) continue;
      const w = where(step);
      if (step.error !== undefined) {
        checks.push({ ok: false, what: `${w}: step threw ${step.error}` });
        continue;
      }
      if (step.skipped !== undefined) {
        checks.push({ ok: false, what: `${w}: skipped (${step.skipped})` });
        continue;
      }
      const turn = step.turn;
      const texts = (turn?.outbound ?? []).map((m) => m.text);
      if (e.note !== undefined) {
        const notes = typeof e.note === 'string' ? [e.note] : e.note;
        checks.push({
          ok: turn !== undefined && notes.includes(turn.note),
          what: `${w}: note ${turn?.note ?? 'none'}, expected ${notes.join(' | ')}`,
        });
      }
      if (e.toolCalls !== undefined) {
        const got = turn?.toolCalls ?? [];
        checks.push({
          ok: got.length === e.toolCalls.length && got.every((t, i) => t === e.toolCalls?.[i]),
          what: `${w}: tool calls [${got.join(',')}], expected [${e.toolCalls.join(',')}]`,
        });
      }
      if (e.modelSource !== undefined && ep.mode === 'offline') {
        checks.push({
          ok: turn?.modelSources[0] === e.modelSource,
          what: `${w}: model source ${turn?.modelSources[0] ?? 'none'}, expected ${e.modelSource}`,
        });
      }
      const groupText = groupMessages(step)
        .map((m) => m.text)
        .join('\n');
      const laneText = step.lane === 'dm' ? texts.join('\n') : groupText;
      for (const s of e.mustContain ?? []) {
        checks.push({ ok: containsCi(laneText, s), what: `${w}: missing "${s}"` });
      }
      for (const s of e.mustNotContain ?? []) {
        checks.push({
          ok: !texts.some((t) => containsCi(t, s)),
          what: `${w}: must not say "${s}"`,
        });
      }
      if (e.text !== undefined) {
        const first = turn?.outbound[0];
        checks.push({
          ok: texts[0] === e.text,
          what: `${w}: text ${first === undefined ? 'none' : quoteMessage(first, step)}, expected "${e.text}"`,
        });
      }
      for (const t of e.audit ?? []) {
        checks.push({ ok: step.auditTypes.includes(t), what: `${w}: audit ${t} not written` });
      }
    }
    return [fromChecks(this.id, checks, { nothing: 'no step expectations' })];
  },
};

// ---------- message budget and silence (VOICE §2, §3.7) ----------

export const messageBudget: Grader = {
  id: 'message_budget',
  title:
    'message budget: silence when not addressed, ≤1 group message per turn, ≤N proactive per day',
  kind: 'deterministic',
  weight: 1,
  grade(ep) {
    const checks: Check[] = [];
    const tz = ep.snapshot.trip?.timeZone;
    const cap = ep.snapshot.group?.settings.maxProactiveGroupMessagesPerDay ?? 2;
    const perDay = new Map<string, number>();
    for (const step of ep.steps) {
      const turn = step.turn;
      if (turn === undefined) continue;
      const w = where(step);
      const group = groupMessages(step);
      checks.push({
        ok: group.length <= 1,
        what: `${w}: ${String(group.length)} group messages in one turn (VOICE §3.7)`,
      });
      if (step.expect?.silent === true) {
        const spoke = turn.outbound[0];
        checks.push({
          ok: turn.outbound.length === 0 && turn.reactions.length === 0,
          what: `${w}: Trav spoke on a line it was not pulled into: ${spoke !== undefined ? quoteMessage(spoke, step) : `"${turn.reactions.join('')}"`}`,
        });
      }
      if (step.proactive && group.length > 0) {
        const day = tz !== undefined ? localDate(step.at, tz) : step.at.slice(0, 10);
        perDay.set(day, (perDay.get(day) ?? 0) + group.length);
      }
    }
    for (const [day, n] of perDay) {
      checks.push({
        ok: n <= cap,
        what: `${day}: ${String(n)} unsolicited group messages (cap ${String(cap)})`,
      });
    }
    return [fromChecks(this.id, checks, { nothing: 'Trav took no turns' })];
  },
};

// ---------- voice linter on every outbound (VOICE §3) ----------

/** `raw_money: "€9.80" is not a formatMoney shape` → `raw_money`. */
function lintRule(violation: string): string {
  const i = violation.indexOf(':');
  return i === -1 ? violation : violation.slice(0, i);
}

export const voiceLint: Grader = {
  id: 'voice_lint',
  title: 'voice linter on every message Trav sent (VOICE §3, §10)',
  kind: 'deterministic',
  weight: 1,
  grade(ep) {
    const checks: Check[] = [];
    const members: readonly Member[] = ep.snapshot.members;
    const trip = ep.snapshot.trip ?? null;
    const reported = new Map<string, string[]>();
    for (const l of ep.lint)
      reported.set(l.messageId, [...(reported.get(l.messageId) ?? []), ...l.violations]);
    const seen = new Set<string>();
    for (const { step, msg } of allMessages(ep)) {
      seen.add(msg.id);
      const v = new Set([
        ...voiceViolations(msg as OutboundMessage, members, trip),
        ...(reported.get(msg.id) ?? []),
      ]);
      // A violation's detail can quote the text ("€9.80" is not a formatMoney shape),
      // so a private message's findings are reported by rule name only.
      const findings = isPrivateMessage(msg, step) ? [...v].map(lintRule) : [...v];
      checks.push({
        ok: v.size === 0,
        what: `${where(step)}: ${[...new Set(findings)].join('; ')} in ${quoteMessage(msg, step)}`,
      });
    }
    // Lint findings on drafts that never reached a turn summary (suppressed or
    // dropped): their lane is unknown here, so rule names only.
    for (const [id, v] of reported) {
      if (!seen.has(id))
        checks.push({
          ok: false,
          what: `message ${id}: ${[...new Set(v.map(lintRule))].join('; ')}`,
        });
    }
    return [fromChecks(this.id, checks, { nothing: 'Trav sent no messages' })];
  },
};

// ---------- mention precision / recall ----------

export const mentionAccuracy: Grader = {
  id: 'mention_accuracy',
  title: 'mention detection precision/recall on fixtures/mentions/labeled.json',
  kind: 'deterministic',
  weight: 2,
  grade(ep) {
    const runs = probe<{ rows: MentionProbeRow[] }>(ep, 'mentions');
    if (runs.length === 0) return [fromChecks(this.id, [], { nothing: 'no mention probe' })];
    return runs.map(({ rows }) => {
      const tp = rows.filter((r) => r.expected && r.got).length;
      const fp = rows.filter((r) => !r.expected && r.got);
      const fn = rows.filter((r) => r.expected && !r.got);
      const precision = tp + fp.length === 0 ? 1 : tp / (tp + fp.length);
      const recall = tp + fn.length === 0 ? 1 : tp / (tp + fn.length);
      const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
      const minP = ep.expect.mentionPrecision ?? 1;
      const minR = ep.expect.mentionRecall ?? 0.95;
      const pass = precision >= minP && recall >= minR;
      return {
        graderId: this.id,
        score: f1,
        pass,
        evidence: [
          `precision ${precision.toFixed(3)} (min ${String(minP)}), recall ${recall.toFixed(3)} (min ${String(minR)}) over ${String(rows.length)} lines`,
          ...fp.map(
            (r) => `false reply: ${r.id} ${quoteText(r.text, r.lane === 'dm', 200)} (${r.reason})`,
          ),
          ...fn.map(
            (r) => `missed: ${r.id} ${quoteText(r.text, r.lane === 'dm', 200)} (${r.reason})`,
          ),
        ],
      } satisfies GraderResult;
    });
  },
};

// ---------- flight optimizer vs brute force ----------

export const flightOptimizer: Grader = {
  id: 'flight_optimizer',
  title: 'group flight optimizer vs exhaustive oracle and fixture ground truth',
  kind: 'deterministic',
  weight: 2,
  grade(ep) {
    const runs = probe<FlightsProbe>(ep, 'flights');
    if (runs.length === 0) return [fromChecks(this.id, [], { nothing: 'no flights probe' })];
    return runs.map((f) => {
      const checks: Check[] = [];
      const key = (ids: readonly string[]) => ids.join('|');
      const top = f.fast[0];
      const best = f.oracle[0];
      checks.push({
        ok: f.missing.length === 0,
        what: `members with no offer: ${f.missing.join(',')}`,
      });
      checks.push({
        ok: top !== undefined && best !== undefined && key(top.offerIds) === key(best.offerIds),
        what: `top pick ${key(top?.offerIds ?? [])} ≠ oracle ${key(best?.offerIds ?? [])}`,
      });
      checks.push({
        ok: top !== undefined && best !== undefined && Math.abs(top.score - best.score) < 1e-9,
        what: `top score ${String(top?.score)} vs oracle ${String(best?.score)}`,
      });
      checks.push({
        ok:
          f.fast.map((i) => key(i.offerIds)).join(' / ') ===
          f.oracle.map((i) => key(i.offerIds)).join(' / '),
        what: 'ranked list differs from the oracle',
      });
      checks.push({
        ok: top !== undefined && top.arrivalSpreadMinutes < f.naive.arrivalSpreadMinutes,
        what: `top arrival spread ${String(top?.arrivalSpreadMinutes)} min is not better than cheapest-per-person ${String(f.naive.arrivalSpreadMinutes)} min`,
      });
      checks.push({
        ok: f.naive.arrivalSpreadMinutes === f.groundTruth.naiveArrivalSpreadMinutes,
        what: `naive arrival spread ${String(f.naive.arrivalSpreadMinutes)} ≠ ground truth ${String(f.groundTruth.naiveArrivalSpreadMinutes)} (inventory mapping drift)`,
      });
      checks.push({
        ok: f.naive.totalCostMinor === f.groundTruth.groupTotalLowerBoundMinor,
        what: `cheapest total ${String(f.naive.totalCostMinor)} ≠ ground truth lower bound ${String(f.groundTruth.groupTotalLowerBoundMinor)}`,
      });
      checks.push({
        ok: f.refundableFast.length > 0 && f.refundableFast.every((i) => i.allRefundable),
        what: 'refundableOnly returned a non-refundable itinerary (or nothing)',
      });
      checks.push({
        ok: key(f.refundableFast[0]?.offerIds ?? []) === key(f.refundableOracle[0]?.offerIds ?? []),
        what: 'refundableOnly top pick differs from the oracle',
      });
      return fromChecks(this.id, checks);
    });
  },
};

// ---------- ledger vs ground truth ----------

function clears(t: LedgerProbeTrip): boolean {
  const net = new Map(Object.entries(t.gotBalances));
  for (const x of t.transfers) {
    net.set(x.from, (net.get(x.from) ?? 0) + x.amountMinor);
    net.set(x.to, (net.get(x.to) ?? 0) - x.amountMinor);
  }
  return [...net.values()].every((v) => v === 0);
}

function rowKey(rows: readonly { memberId: string; amountMinor: number }[]): string {
  return [...rows]
    .map((r) => `${r.memberId}:${String(r.amountMinor)}`)
    .sort()
    .join(',');
}

interface LedgerTruth {
  readonly currency: string;
  readonly final: {
    readonly balances: readonly { memberId: string; net: { amountMinor: number } }[];
  };
}

export const ledgerGroundTruth: Grader = {
  id: 'ledger_ground_truth',
  title: 'ledger: shares, balances and settle-up vs ground truth (to the cent)',
  kind: 'deterministic',
  weight: 2,
  grade(ep) {
    const checks: Check[] = [];
    for (const { trips } of probe<{ trips: LedgerProbeTrip[] }>(ep, 'ledger')) {
      for (const t of trips) {
        for (const e of t.expenses) {
          checks.push({
            ok: e.error === undefined && rowKey(e.got) === rowKey(e.expected),
            what: `${t.trip} ${e.expenseId}: shares ${e.error ?? rowKey(e.got)} ≠ expected ${rowKey(e.expected)}`,
          });
        }
        for (const [m, net] of Object.entries(t.expectedBalances)) {
          checks.push({
            ok: t.gotBalances[m] === net,
            what: `${t.trip} balance ${m}: ${String(t.gotBalances[m])} ≠ expected ${String(net)}`,
          });
        }
        checks.push({
          ok: t.gotTotalMinor === t.expectedTotalMinor,
          what: `${t.trip}: total ${String(t.gotTotalMinor)} ≠ ${String(t.expectedTotalMinor)}`,
        });
        checks.push({
          ok: t.transfers.length <= Math.min(t.maxTransfers, t.memberOrder.length - 1),
          what: `${t.trip}: ${String(t.transfers.length)} transfers (max ${String(t.maxTransfers)})`,
        });
        checks.push({
          ok: clears(t),
          what: `${t.trip}: settle-up transfers do not clear every balance to the cent`,
        });
      }
    }
    // Per-step ledger writes (chat expense, receipt, booking) against the step's expected split.
    for (const step of ep.steps) {
      const want = step.expect?.expense;
      if (want === undefined) continue;
      const w = where(step);
      const exp = ep.snapshot.expenses.find((e) => step.newExpenseIds.includes(e.expenseId));
      if (exp === undefined) {
        checks.push({ ok: false, what: `${w}: expected a ledger expense, none was written` });
        continue;
      }
      checks.push({
        ok: exp.amount.amountMinor === want.amountMinor,
        what: `${w}: amount ${String(exp.amount.amountMinor)} ≠ ${String(want.amountMinor)}`,
      });
      const payer = exp.paidBy.map((p) => p.memberId).join(',');
      checks.push({
        ok: payer === want.paidBy,
        what: `${w}: paid by ${payer}, expected ${want.paidBy}`,
      });
      const owes = ep.snapshot.entries
        .filter(
          (x) => x.expenseId === exp.expenseId && x.kind === 'owes' && x.amount.amountMinor !== 0,
        )
        .map((x) => ({ memberId: x.memberId, amountMinor: x.amount.amountMinor }));
      checks.push({
        ok: rowKey(owes) === rowKey(want.shares),
        what: `${w}: shares ${rowKey(owes)} ≠ expected ${rowKey(want.shares)}`,
      });
    }
    // The agent's own ledger (chat/receipt/booking ingestion) against the trip's ground truth.
    const truthName = ep.expect.ledgerGroundTruth;
    if (truthName !== undefined) {
      const truth = loadFixture<LedgerTruth>(`ledger/${truthName}.json`);
      const order = ep.snapshot.members.map((m) => m.memberId);
      const got =
        order.length === 0
          ? []
          : ledger.computeBalances(ep.snapshot.entries, truth.currency, order);
      for (const b of truth.final.balances) {
        const g = got.find((x) => x.memberId === b.memberId)?.net.amountMinor ?? 0;
        checks.push({
          ok: g === b.net.amountMinor,
          what: `agent ledger balance ${b.memberId}: ${String(g)} ≠ expected ${String(b.net.amountMinor)}`,
        });
      }
    }
    return [fromChecks(this.id, checks, { nothing: 'no ledger to grade' })];
  },
};

// ---------- rubric (live only) ----------

export const DEFAULT_RUBRIC: readonly string[] = [
  'Tone matches docs/VOICE.md: lowercase, warm, dry, no exclamation marks, no corporate filler.',
  'Helpfulness: each reply moves the group forward (answers, books, logs, or asks the one question needed).',
  'Brevity: replies fit a phone bubble (1-4 short lines) and never repeat themselves.',
  'Clarifying questions: Trav asks exactly one short question when the request is ambiguous, and none when it is clear.',
];

/**
 * The transcript the rubric judge reads. DM lines are replaced by a marker:
 * the judge's rationale is quoted in the report, and a DM's text never is.
 */
export function transcriptText(ep: Episode): string {
  return ep.transcript
    .filter((t) => t.type === 'message')
    .map((t) => {
      const who = `${t.direction === 'outbound' ? 'trav' : t.fromName}${t.lane === 'dm' ? ' (dm)' : ''}`;
      const text = 'text' in t ? t.text : '';
      return `${who}: ${t.lane === 'dm' ? quoteText(text, true) : text}`;
    })
    .join('\n');
}

export const rubric: Grader = {
  id: 'rubric',
  title: 'rubric (live only, TRAV_GRADER_MODEL): tone, helpfulness, brevity, clarifying questions',
  kind: 'rubric',
  weight: 1,
  async grade(ep, scenario, ctx) {
    if (ctx.mode !== 'live' || ctx.rubric === undefined) {
      return [
        {
          graderId: this.id,
          score: 1,
          pass: true,
          evidence: [],
          skipped: 'rubric graders run live only',
        },
      ];
    }
    const transcript = transcriptText(ep);
    if (!ep.transcript.some((t) => t.direction === 'outbound')) {
      return [
        { graderId: this.id, score: 1, pass: true, evidence: [], skipped: 'Trav sent nothing' },
      ];
    }
    const out: GraderResult[] = [];
    for (const criterion of scenario.rubric ?? DEFAULT_RUBRIC) {
      try {
        const r = await ctx.rubric.judge({ criterion, transcript });
        const score = Math.max(0, Math.min(1, r.score));
        out.push({
          graderId: this.id,
          score,
          pass: score >= 0.6,
          evidence: [`${criterion} → ${score.toFixed(2)}: ${r.rationale}`],
        });
      } catch (e) {
        out.push({
          graderId: this.id,
          score: 1,
          pass: true,
          evidence: [],
          skipped: `grader call failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    return out;
  },
};

export const QUALITY_GRADERS: readonly Grader[] = [
  turnExpectations,
  messageBudget,
  voiceLint,
  mentionAccuracy,
  flightOptimizer,
  ledgerGroundTruth,
  rubric,
];
