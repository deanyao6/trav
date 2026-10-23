/** Small helpers shared by graders. Everything here is pure. */
import type { OutboundMessage } from '@trav/core';
import type { Episode, GraderResult, StepRecord } from '../types.js';

export function groupMessages(step: StepRecord): readonly OutboundMessage[] {
  return step.turn?.outbound.filter((m) => m.to.kind === 'group') ?? [];
}

export function dmMessages(step: StepRecord): readonly OutboundMessage[] {
  return step.turn?.outbound.filter((m) => m.to.kind === 'member') ?? [];
}

export function allMessages(ep: Episode): readonly { step: StepRecord; msg: OutboundMessage }[] {
  return ep.steps.flatMap((step) => (step.turn?.outbound ?? []).map((msg) => ({ step, msg })));
}

/** Case-insensitive substring. */
export function containsCi(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Text of a message including its card's fallback and any image alt text. */
export function fullText(m: OutboundMessage): string {
  return [m.text, ...(m.images ?? []).map((i) => i.alt)].join('\n');
}

/**
 * The one way grader evidence quotes text Trav (or a member) sent. Evidence
 * lands in committed reports, and the report's transcript already hides DM
 * lines; a DM can hold a private charge, a ticket or a card detail, so it is
 * never quoted here either: a DM (`to.kind === 'member'`), or anything sent
 * on a step whose lane is `dm`, renders as `[private message, N chars]`.
 * Group text is quoted, cut to `max` characters.
 */
export function quoteText(text: string, isPrivate: boolean, max = 80): string {
  if (isPrivate) return `[private message, ${String(text.length)} chars]`;
  return `"${text.length > max ? `${text.slice(0, max)}…` : text}"`;
}

/** Is this message private for evidence purposes (a DM, or sent on a DM-lane step)? */
export function isPrivateMessage(
  msg: Pick<OutboundMessage, 'to'>,
  step?: Pick<StepRecord, 'lane'>,
): boolean {
  return msg.to.kind === 'member' || step?.lane === 'dm';
}

/** `quoteText` for an outbound message (its `text` unless `text` is given, e.g. one roast line). */
export function quoteMessage(
  msg: Pick<OutboundMessage, 'to' | 'text'>,
  step?: Pick<StepRecord, 'lane'>,
  opts: { readonly text?: string; readonly max?: number } = {},
): string {
  return quoteText(opts.text ?? msg.text, isPrivateMessage(msg, step), opts.max);
}

export function where(step: StepRecord): string {
  return `step ${String(step.index)}${step.source !== undefined ? ` [${step.source}]` : ''} (${step.label})`;
}

/**
 * One result from a list of check outcomes: score = passed / total, pass
 * only when every check passed. `total === 0` ⇒ skipped (nothing to grade).
 *
 * `substantive: false` says the episode never exercised what the grader is
 * about (no proposal, no ticket, no audit event): if every check passed the
 * result is reported as skipped rather than as a pass, so an invariant like
 * "0 purchases ≤ 0 approvals" never counts as coverage. A failing check is
 * always reported, substantive or not.
 */
export function fromChecks(
  graderId: string,
  checks: readonly { readonly ok: boolean; readonly what: string }[],
  opts: {
    readonly safetyId?: string;
    readonly nothing?: string;
    readonly substantive?: boolean;
  } = {},
): GraderResult {
  const safety = opts.safetyId !== undefined ? { safetyId: opts.safetyId } : {};
  const vacuous = opts.substantive === false && checks.every((c) => c.ok);
  if (checks.length === 0 || vacuous) {
    return {
      graderId,
      ...safety,
      score: 1,
      pass: true,
      evidence: [],
      skipped: opts.nothing ?? 'nothing to grade in this episode',
    };
  }
  const failed = checks.filter((c) => !c.ok);
  return {
    graderId,
    ...safety,
    score: (checks.length - failed.length) / checks.length,
    pass: failed.length === 0,
    evidence:
      failed.length === 0 ? [`${String(checks.length)} checks passed`] : failed.map((c) => c.what),
  };
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/** Is `wanted` a subsequence of `types` (relative order, gaps allowed)? Returns the first missing item. */
export function missingFromOrder(
  types: readonly string[],
  wanted: readonly string[],
): string | undefined {
  let i = 0;
  for (const w of wanted) {
    while (i < types.length && types[i] !== w) i += 1;
    if (i >= types.length) return w;
    i += 1;
  }
  return undefined;
}
