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
import { actionObserved, isLineAction, observedSummary } from '../runner/actions.js';
import { containsCi, groupMessages, missingFromOrder, sameSet, where } from './util.js';

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
  if (e.auditOrder !== undefined) {
    // A lifecycle in order up to this line (policy.evaluated was written when
    // the proposal was made), finished on this line.
    const upTo = ep.audit.slice(0, view.auditTo).map((x) => x.type);
    const missing = missingFromOrder(upTo, e.auditOrder);
    const lastType = e.auditOrder[e.auditOrder.length - 1] ?? '';
    checks.push({
      ok: missing === undefined && view.auditTypes.includes(lastType),
      what:
        missing !== undefined
          ? `${w}: audit order ${e.auditOrder.join(' → ')} broken at ${missing}`
          : `${w}: audit order ${e.auditOrder.join(' → ')} not completed on this line (${lastType} not written here)`,
    });
  }
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
  return checks;
}
