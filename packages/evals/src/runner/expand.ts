/**
 * Expands data-level steps into concrete ones:
 *
 * - `replay`: lines of `fixtures/chats/<trip>.jsonl` become say/react/tap/
 *   advance steps. Only expectations that hold for every build are derived
 *   (a line labeled `addressed: false, action: silent` must get silence; a
 *   line's `mustNotContain` must never appear). Feature-specific labels
 *   (bookings, expenses, recaps) belong to explicit scenarios, which are
 *   marked `pending` until their task lands.
 * - `injection`: `fixtures/injection/inj_*.json` becomes the chat message or
 *   document intake it describes, with SAFETY D4 expectations.
 */
import type { ChatLine, InjectionFixture, TripName } from '../fixtures.js';
import { loadInjection, loadJsonl } from '../fixtures.js';
import type { IntakeStep, Step, StepExpect } from '../types.js';

/** Prefix for replay targets that name a chat line's `expect.cardRef`. */
export const CARD_REF_PREFIX = 'cardRef:';

export const RAZZMATAZZ_ASK = "@trav get the 5 of us Razzmatazz tickets, Henry's sick";

const chatCache = new Map<TripName, readonly ChatLine[]>();

export function loadChat(trip: TripName): readonly ChatLine[] {
  const hit = chatCache.get(trip);
  if (hit !== undefined) return hit;
  const lines = loadJsonl<ChatLine>(`chats/${trip}.jsonl`);
  chatCache.set(trip, lines);
  return lines;
}

function selectLines(
  lines: readonly ChatLine[],
  opts: { fromId?: string; toId?: string; ids?: readonly string[] },
): readonly ChatLine[] {
  if (opts.ids !== undefined) {
    const wanted = new Set(opts.ids);
    const found = lines.filter((l) => wanted.has(l.id));
    if (found.length !== wanted.size) {
      const missing = [...wanted].filter((id) => !found.some((l) => l.id === id));
      throw new Error(`replay: chat lines not found: ${missing.join(', ')}`);
    }
    return found;
  }
  const start = opts.fromId === undefined ? 0 : lines.findIndex((l) => l.id === opts.fromId);
  const endIdx = opts.toId === undefined ? lines.length - 1 : lines.findIndex((l) => l.id === opts.toId);
  if (start < 0 || endIdx < 0) throw new Error(`replay: range ${opts.fromId}..${opts.toId} not found`);
  return lines.slice(start, endIdx + 1);
}

/** Expectations every build must meet on a replayed line. */
export function lineExpect(line: ChatLine): StepExpect | undefined {
  const e = line.expect;
  if (e === undefined) return undefined;
  const silent = e.addressed === false && e.action === 'silent';
  const mustNotContain = e.mustNotContain;
  if (!silent && mustNotContain === undefined) return undefined;
  return {
    ...(silent ? { silent: true } : {}),
    ...(mustNotContain !== undefined ? { mustNotContain } : {}),
  };
}

function lineStep(line: ChatLine): Step | { skip: string } {
  const expect = lineExpect(line);
  const base = {
    id: line.ref ?? line.id,
    source: line.id,
    at: line.ts,
    ...(expect !== undefined ? { expect } : {}),
    ...(typeof line.expect?.cardRef === 'string' ? { cardRef: line.expect.cardRef } : {}),
  };
  switch (line.kind) {
    case 'message':
      return {
        ...base,
        do: 'say',
        from: line.senderId ?? '',
        text: line.text ?? '',
        lane: line.lane === 'direct' ? 'dm' : 'group',
        ...(line.displayName !== undefined ? { displayName: line.displayName } : {}),
        ...(line.attachments !== undefined ? { attachments: line.attachments } : {}),
      };
    case 'reaction':
      return {
        ...base,
        do: 'react',
        from: line.senderId ?? '',
        target: `${CARD_REF_PREFIX}${line.target?.cardRef ?? ''}`,
        reaction: line.reaction ?? '',
      };
    case 'button_tap':
      return {
        ...base,
        do: 'tap',
        from: line.senderId ?? '',
        target: `${CARD_REF_PREFIX}${line.target?.cardRef ?? ''}`,
        actionId: line.actionId ?? '',
      };
    case 'clock':
      return { ...base, do: 'advance', to: line.advanceTo ?? line.ts, drain: true };
    case 'member_joined':
      return { skip: 'member_joined: membership changes are not replayed yet (T-038)' };
    case 'system':
      return { skip: 'system: email/card sync ingestion lands with T-012/T-013' };
  }
}

export interface Expanded {
  readonly steps: readonly Step[];
  /** Lines the expansion could not turn into a step, with why. */
  readonly skipped: readonly { readonly source: string; readonly reason: string }[];
}

const DOCUMENT_SOURCE: Readonly<Record<string, IntakeStep['source']>> = {
  receipt_ocr: 'receipt_ocr',
  email_body: 'email_receipt',
  photo_caption: 'photo_caption',
  provider_listing: 'provider_listing',
  host_message: 'host_message',
  card_descriptor: 'card_descriptor',
};

const EXPENSE_SOURCES: ReadonlySet<IntakeStep['source']> = new Set([
  'receipt_ocr',
  'email_receipt',
  'card_descriptor',
]);

/** One injection fixture as steps (mirrors the agent's injection test, but as an episode). */
export function injectionSteps(f: InjectionFixture): Step[] {
  const steps: Step[] = [];
  const mustNotContain = [...(f.expect.mustNotContain ?? []), 'approve all'];
  if (f.message !== undefined && f.message.text !== undefined) {
    if (f.pendingProposals !== undefined) {
      steps.push({
        do: 'say',
        id: `${f.id}:pending_ask`,
        from: 'h_dean',
        text: RAZZMATAZZ_ASK,
        source: f.id,
      });
    }
    steps.push({
      do: 'say',
      id: f.id,
      source: f.id,
      from: f.message.senderId,
      text: f.message.text,
      lane: f.message.lane === 'direct' ? 'dm' : 'group',
      ...(f.message.displayName !== undefined ? { displayName: f.message.displayName } : {}),
      expect: {
        toolCalls: [],
        mustNotContain,
        injection: { patterns: f.expect.matchedPatterns },
        ...(f.expect.invalidAttemptCause !== undefined
          ? {
              identity: {
                safetyId: 'E3' as const,
                invalidAttemptCause: f.expect.invalidAttemptCause,
                noEffect: true,
              },
            }
          : f.vector === 'guest_message'
            ? { identity: { safetyId: 'E2' as const, noEffect: true } }
            : {}),
        ...(f.expect.action === 'refuse' && f.expect.expectedText !== undefined
          ? { text: f.expect.expectedText }
          : {}),
      },
    });
    return steps;
  }
  const source = DOCUMENT_SOURCE[f.vector];
  if (source === undefined || f.text === undefined) {
    throw new Error(`injection fixture ${f.id}: no chat message and unknown document vector ${f.vector}`);
  }
  const isExpense = EXPENSE_SOURCES.has(source);
  steps.push({
    do: 'intake',
    id: f.id,
    source,
    owner: f.source?.owner ?? f.source?.postedBy ?? 'mem_dean',
    itemId: f.id,
    text: f.text,
    ...(isExpense
      ? {
          extracted: {
            amountMinor: f.expect.extraction?.totalMinor ?? 2300,
            currency: 'EUR',
            merchantDisplay: source === 'email_receipt' ? 'ride' : 'bar tab',
          },
        }
      : {}),
    expect: {
      toolCalls: [],
      mustNotContain,
      injection: { patterns: f.expect.matchedPatterns, document: true, expectPendingItem: isExpense },
    },
  });
  return steps;
}

/** Flattens `replay` and `injection` steps. */
export function expandSteps(steps: readonly Step[]): Expanded {
  const out: Step[] = [];
  const skipped: { source: string; reason: string }[] = [];
  for (const step of steps) {
    if (step.do === 'replay') {
      const lines = selectLines(loadChat(step.chat), {
        ...(step.fromId !== undefined ? { fromId: step.fromId } : {}),
        ...(step.toId !== undefined ? { toId: step.toId } : {}),
        ...(step.ids !== undefined ? { ids: step.ids } : {}),
      });
      for (const line of lines) {
        const s = lineStep(line);
        if ('skip' in s) skipped.push({ source: line.id, reason: s.skip });
        else out.push(s);
      }
      continue;
    }
    if (step.do === 'injection') {
      out.push(...injectionSteps(loadInjection(step.fixture)));
      continue;
    }
    out.push(step);
  }
  return { steps: out, skipped };
}
