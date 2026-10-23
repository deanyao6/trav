/**
 * Replay of a fixture chat (`fixtures/chats/barcelona.jsonl`) into a
 * simulator backend, one line at a time (VOICE §9.1 "replay" button) or all
 * the way through ("play all").
 *
 * Each line runs as its own sender through the same backend calls the UI
 * makes, so identity, mention gating, approvals and lanes are exactly what a
 * clicking human gets:
 *
 *   message      → inject as `senderId` (lane `direct` ⇒ that member's DM)
 *   reaction /   → the newest Trav card in that lane that matches the line's
 *   button_tap     `cardRef` (proposal / prompt / digest / settle), as `senderId`
 *   clock        → move the clock to `advanceTo` and drain the scheduler
 *   system       → `email_arrived` / `card_sync`: feed that member's demo
 *                  documents of that kind (`documents.ts`); none ⇒ skipped
 *                  (they never turned the import on)
 *   member_joined→ the participant is added to the group chat
 *
 * Before every line the clock moves forward to the line's `ts` (draining
 * whatever came due, e.g. a proposal's hold expiring). The first step starts
 * the backend over (fresh session, no seed lines, clock at the first line) so
 * the script runs on a clean slate. A line that cannot run is skipped with a
 * reason (`ReplayView.last`); the replay never stops on one, and "play all"
 * is capped at the number of lines.
 *
 * The `expect` blocks are eval ground truth and are ignored here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RichCard, ScheduledJobKind } from '@trav/core';
import { TravError, parseIso } from '@trav/core';
import type {
  ReplayView,
  SimGroup,
  SimInbound,
  SimState,
  ThreadEntry,
  ThreadMessage,
} from '../shared/types.js';
import type { SimulatorBackend } from './backend.js';
import { clockLabel } from './clock.js';
import { documentsFor } from './documents.js';
import { BARCELONA } from './groups.js';

export interface ReplayLine {
  readonly id: string;
  readonly ts: string;
  readonly kind: string;
  readonly lane: 'group' | 'direct';
  readonly senderId: string | null;
  readonly text: string;
  readonly reaction?: string;
  readonly actionId?: string;
  readonly value?: string;
  readonly cardRef?: string;
  readonly advanceTo?: string;
  readonly event?: string;
  readonly memberId?: string;
  readonly participant?: { readonly handle: string; readonly displayName: string };
  /** Clock lines: the scheduled job the line exists to show (fixture `expect.scheduledJob`). */
  readonly scheduledJob?: ScheduledJobKind;
}

const JOB_KINDS: readonly ScheduledJobKind[] = [
  'morning_after',
  'daily_settle',
  'wrapped',
  'proposal_expiry',
  'hold_expiry',
  'private_digest',
  'day_of_reminder',
  'budget_check',
];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const BARCELONA_SCRIPT_PATH = join(REPO_ROOT, 'fixtures', 'chats', 'barcelona.jsonl');

function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}

/** Parses a fixture chat (JSON lines). Throws `TravError` naming the bad line. */
export function parseScript(text: string): ReplayLine[] {
  const out: ReplayLine[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new TravError('invalid_argument', `chat script line ${String(i + 1)} is not JSON`);
    }
    const id = str(o, 'id');
    const ts = str(o, 'ts');
    const kind = str(o, 'kind');
    const lane = str(o, 'lane');
    if (id === undefined || ts === undefined || kind === undefined) {
      throw new TravError('invalid_argument', `chat script line ${String(i + 1)} needs id, ts, kind`);
    }
    parseIso(ts); // throws on a bad timestamp
    const target = o['target'];
    const cardRef =
      typeof target === 'object' && target !== null
        ? str(target as Record<string, unknown>, 'cardRef')
        : undefined;
    const p = o['participant'];
    const participant =
      typeof p === 'object' && p !== null
        ? {
            handle: str(p as Record<string, unknown>, 'handle') ?? '',
            displayName: str(p as Record<string, unknown>, 'displayName') ?? '',
          }
        : undefined;
    const ex = o['expect'];
    const job =
      typeof ex === 'object' && ex !== null
        ? str(ex as Record<string, unknown>, 'scheduledJob')
        : undefined;
    const scheduledJob = JOB_KINDS.find((k) => k === job);
    const pick = (key: string): Record<string, string> => {
      const v = str(o, key);
      return v !== undefined ? { [key]: v } : {};
    };
    out.push({
      id,
      ts,
      kind,
      lane: lane === 'direct' ? 'direct' : 'group',
      senderId: str(o, 'senderId') ?? null,
      text: str(o, 'text') ?? '',
      ...pick('reaction'),
      ...pick('actionId'),
      ...pick('value'),
      ...pick('advanceTo'),
      ...pick('event'),
      ...pick('memberId'),
      ...(cardRef !== undefined ? { cardRef } : {}),
      ...(participant !== undefined ? { participant } : {}),
      ...(scheduledJob !== undefined ? { scheduledJob } : {}),
    });
  });
  return out;
}

export function loadBarcelonaScript(path = BARCELONA_SCRIPT_PATH): ReplayLine[] {
  return parseScript(readFileSync(path, 'utf8'));
}

function nameOf(group: SimGroup, handleOrId: string | null | undefined): string {
  if (handleOrId === null || handleOrId === undefined) return 'someone';
  const m = group.members.find((x) => x.handle === handleOrId || x.memberId === handleOrId);
  return m?.name ?? handleOrId;
}

/**
 * Shortens a chat line for the replay label: at most `max` code points
 * (never splits an emoji's surrogate pair), cut back to the last word
 * boundary when one is in the last third, trailing punctuation dropped.
 * Exported for tests.
 */
export function clip(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  let kept = chars.slice(0, max - 1);
  if (chars[max - 1] !== ' ') {
    const space = kept.lastIndexOf(' ');
    if (space >= Math.floor(((max - 1) * 2) / 3)) kept = kept.slice(0, space);
  }
  return `${kept.join('').replace(/[\s,;:.\-–—]+$/u, '')}…`;
}

/** One short line for the replay button's "next" label. */
export function describeLine(line: ReplayLine, group: SimGroup): string {
  const who = nameOf(group, line.senderId);
  const dm = line.lane === 'direct' ? ' (dm)' : '';
  switch (line.kind) {
    case 'message':
      return `${who}${dm}: ${clip(line.text)}`;
    case 'reaction':
      return `${who}${dm} ${line.reaction ?? ''} on ${line.cardRef ?? 'a card'}`;
    case 'button_tap':
      return `${who}${dm} taps ${line.actionId ?? '?'} on ${line.cardRef ?? 'a card'}`;
    case 'clock':
      return `clock → ${clockLabel(line.advanceTo ?? line.ts, group)}`;
    case 'system':
      return `${line.event ?? 'system'} for ${nameOf(group, line.memberId)}`;
    case 'member_joined':
      return `${line.participant?.displayName ?? 'someone'} joins the chat`;
    default:
      return line.kind;
  }
}

/** Card types a `cardRef` names (`razz_proposal`, `sam_uber_prompt`, `dean_digest`, `final_settle`). */
function refTypes(cardRef: string | undefined): readonly RichCard['type'][] | undefined {
  if (cardRef === undefined) return undefined;
  if (/proposal$/.test(cardRef)) return ['booking_proposal'];
  if (/(prompt|digest)$/.test(cardRef)) return ['expense_confirm'];
  if (/settle/.test(cardRef)) return ['settle_up'];
  if (/options$/.test(cardRef)) return ['options'];
  return undefined;
}

/** The newest Trav card in `entries` this reaction or tap is aimed at, if any. */
export function findTargetCard(
  entries: readonly ThreadEntry[],
  line: Pick<ReplayLine, 'kind' | 'cardRef' | 'actionId'>,
): ThreadMessage | undefined {
  const types = refTypes(line.cardRef);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind !== 'message' || !e.isTrav || e.card === undefined) continue;
    if (types !== undefined && !types.includes(e.card.type)) continue;
    if (line.kind === 'button_tap') {
      const ids = new Set<string>(e.actions.map((a) => a.id));
      if (e.card.type === 'options') ids.add(e.card.pickAction.id);
      if (line.actionId === undefined || !ids.has(line.actionId)) continue;
    }
    return e;
  }
  return undefined;
}

export interface ReplayController {
  view(): ReplayView;
  /** Run the next line. Resolves with the new view. */
  step(): Promise<ReplayView>;
  /** Run every remaining line (capped at the script length). */
  all(): Promise<ReplayView>;
}

class Skip extends Error {}

/**
 * Adds replay to a backend. The returned backend is the same backend (every
 * call forwards) with `replay` merged into `state()`.
 */
export function withReplay(
  backend: SimulatorBackend,
  lines: readonly ReplayLine[],
  group: SimGroup = BARCELONA,
): SimulatorBackend & { readonly replay: ReplayController } {
  let cursor = 0;
  let running = false;
  let last: string | undefined;
  const notify = new Set<() => void>();

  const view = (): ReplayView => {
    const next = lines[cursor];
    return {
      cursor,
      total: lines.length,
      running,
      ...(next !== undefined ? { next: describeLine(next, group) } : {}),
      ...(last !== undefined ? { last } : {}),
    };
  };

  function stateNow(): SimState {
    return backend.state();
  }

  function memberIdOf(handle: string | null): string | undefined {
    return group.members.find((m) => m.handle === handle)?.memberId;
  }

  async function runLine(line: ReplayLine): Promise<string> {
    // The clock follows the script (forward only), and anything due fires first.
    // A clock line moves it itself (below), with the job it expects.
    if (
      line.kind !== 'clock' &&
      backend.advanceClock &&
      parseIso(line.ts) > parseIso(backend.now())
    ) {
      await backend.advanceClock({ to: line.ts, groupId: group.groupId });
    }
    const label = describeLine(line, group);
    switch (line.kind) {
      case 'message': {
        if (line.senderId === null || line.text.trim() === '') throw new Skip('empty message');
        const input: SimInbound = {
          type: 'message',
          from: line.senderId,
          text: line.text,
          ...(line.lane === 'direct' ? { lane: 'dm' as const } : { groupId: group.groupId }),
        };
        await backend.inject(input);
        return label;
      }
      case 'reaction':
      case 'button_tap': {
        if (line.senderId === null) throw new Skip('no sender');
        const view = stateNow().groups.find((g) => g.group.groupId === group.groupId);
        const memberId = memberIdOf(line.senderId);
        const entries =
          line.lane === 'direct'
            ? memberId !== undefined
              ? (view?.dms[memberId] ?? [])
              : []
            : (view?.thread ?? []);
        const target = findTargetCard(entries, line);
        if (target === undefined) {
          throw new Skip(`no ${line.cardRef ?? 'card'} on screen to ${line.kind === 'reaction' ? 'react to' : 'tap'}`);
        }
        if (line.kind === 'reaction') {
          await backend.inject({
            type: 'reaction',
            from: line.senderId,
            targetMessageId: target.messageId,
            reaction: line.reaction ?? '👍',
          });
        } else {
          await backend.inject({
            type: 'button_tap',
            from: line.senderId,
            cardMessageId: target.messageId,
            actionId: line.actionId!,
            ...(line.value !== undefined ? { value: line.value } : {}),
          });
        }
        return label;
      }
      case 'clock': {
        if (!backend.advanceClock) throw new Skip('this backend has no clock');
        const to = line.advanceTo ?? line.ts;
        if (parseIso(to) <= parseIso(backend.now())) {
          return `${label} (clock already past it)`;
        }
        await backend.advanceClock({
          to,
          groupId: group.groupId,
          ...(line.scheduledJob !== undefined ? { expectJob: line.scheduledJob } : {}),
        });
        return label;
      }
      case 'system': {
        const kind = line.event === 'email_arrived' ? 'email' : line.event === 'card_sync' ? 'card' : undefined;
        if (kind === undefined || line.memberId === undefined) throw new Skip(`unknown system event ${line.event ?? ''}`);
        if (!backend.intake) throw new Skip('this backend cannot ingest documents');
        const offers = (stateNow().groups.find((g) => g.group.groupId === group.groupId)?.intake[line.memberId] ?? []).filter(
          (o) => o.kind === kind,
        );
        if (offers.length === 0) {
          const known = documentsFor(group.groupId).some(
            (d) => d.ownerMemberId === line.memberId && d.kind === kind,
          );
          throw new Skip(
            known
              ? `${nameOf(group, line.memberId)}'s ${kind} document was already fed`
              : `${nameOf(group, line.memberId)} never turned on ${kind} import, nothing read`,
          );
        }
        for (const o of offers) await backend.intake(o.docId);
        return label;
      }
      case 'member_joined': {
        const p = line.participant;
        if (p === undefined || p.handle === '') throw new Skip('no participant');
        await backend.inject({
          type: 'member_joined',
          handle: p.handle,
          displayName: p.displayName || p.handle,
          groupId: group.groupId,
        });
        return label;
      }
      default:
        throw new Skip(`unknown line kind ${line.kind}`);
    }
  }

  async function stepOnce(): Promise<void> {
    const line = lines[cursor];
    if (line === undefined) return;
    if (cursor === 0 && backend.reset) {
      // A clean slate at the script's first moment.
      await backend.reset({ seed: false, startAt: line.ts });
    }
    try {
      last = await runLine(line);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      last = `skipped ${line.id}: ${why}`;
    }
    cursor += 1;
  }

  function guard(): void {
    if (running) throw new TravError('duplicate', 'the replay is already running');
  }

  const ping = (): void => {
    for (const l of [...notify]) l();
  };

  const replay: ReplayController = {
    view,
    async step() {
      guard();
      running = true;
      try {
        await stepOnce();
      } finally {
        running = false;
        ping();
      }
      return view();
    },
    async all() {
      guard();
      running = true;
      ping();
      try {
        // Termination: at most one pass over the script.
        for (let n = 0; n < lines.length && cursor < lines.length; n++) await stepOnce();
      } finally {
        running = false;
        ping();
      }
      return view();
    },
  };

  const wrapped: SimulatorBackend & { readonly replay: ReplayController } = {
    kind: backend.kind,
    get groups() {
      return backend.groups;
    },
    get members() {
      return backend.members;
    },
    inject: (input) => backend.inject(input),
    transcript: (groupId) => backend.transcript(groupId),
    dms: (memberId) => backend.dms(memberId),
    now: () => backend.now(),
    state() {
      const s = backend.state();
      return { ...s, controls: { ...s.controls, replay: true }, replay: view() };
    },
    subscribe(listener) {
      notify.add(listener);
      const inner = backend.subscribe(listener);
      return () => {
        notify.delete(listener);
        inner();
      };
    },
    ...(backend.reset
      ? {
          reset: async (options?: Parameters<NonNullable<SimulatorBackend['reset']>>[0]) => {
            guard();
            cursor = 0;
            last = undefined;
            await backend.reset!(options);
          },
        }
      : {}),
    ...(backend.advanceClock ? { advanceClock: (r) => backend.advanceClock!(r) } : {}),
    ...(backend.intake ? { intake: (id: string) => backend.intake!(id) } : {}),
    replay,
  };
  return wrapped;
}
