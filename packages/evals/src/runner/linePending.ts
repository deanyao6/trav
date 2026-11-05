/**
 * Per-line known gaps (T-077): replayed chat lines whose expected behaviour
 * waits on a task that is still open in `tasks/BACKLOG.md`. A line here is
 * still graded and its failures still count (scores drop, the scenario does
 * not pass); `annotateKnownGaps` names the task on each failing check of the
 * line, so the report separates "waiting on T-xxx" from an unexplained
 * failure, and the regression suite fails only on unexplained ones.
 *
 * `scenarios.test.ts` fails when an entry names a task checked `[x]` (T-086):
 * when the task lands, the line must pass or be re-attributed.
 */
import type { GraderResult, StepRecord } from '../types.js';

export interface LinePending {
  readonly task: string;
  readonly why: string;
}

const gap = (task: string, why: string, ids: readonly string[]): [string, LinePending][] =>
  ids.map((id) => [id, { task, why }]);

export const LINE_PENDING: Readonly<Record<string, LinePending>> = Object.fromEntries([
  // ---- Barcelona (fixtures/chats/barcelona.jsonl) ----
  // (msg_bcn_0014–0026, group flights: T-074 landed, graded as is.)
  // T-160 grades expense.description/category: a chat expense with no object in the
  // message is logged as "€156 expense" / "€108 total", category other.
  ...gap('T-087', 'chat expense logged with a filler description ("expense", "total")', [
    'msg_bcn_0054',
    'msg_bcn_0058',
    'msg_bcn_0166',
  ]),
  // T-160 r2: descriptions need a distinctive word, so a bare kind no longer
  // matches. "2 waters in here" drops the venue in context (T-087's "the
  // activity in context"); a promoted Uber email is logged as "Uber" though the
  // receipt names pickup and dropoff. T-087 is scoped to chat text, so the Uber
  // lines are parked on it until the Orchestrator files or widens a task.
  ...gap('T-087', 'chat expense description drops the venue in context ("in here")', [
    'msg_bcn_0139',
  ]),
  ...gap('T-087', 'promoted Uber email logged as "Uber", without the route on the receipt', [
    'msg_bcn_d_0009',
    'msg_bcn_d_0010',
  ]),
  ...gap('T-136', 'roast from group-ledger facts finds nothing to say', ['msg_bcn_0112']),
  ...gap('T-139', "a guest's second message: fixture expects a refusal, agent stays silent", [
    'msg_bcn_0147',
  ]),
  ...gap('T-140', 'low-confidence looks-shared DM wording', ['sys_bcn_0176']),
  ...gap('T-144', "Dean's two-row digest vs separate cards; digest confirm by row id", [
    'sys_bcn_0192',
    'msg_bcn_d_0012',
  ]),
  // T-160 grades expectedTransfers: the final settle's nets are off by exactly
  // Dean's €47.20 card groceries split six ways (+3933 Dean, -786/-787 each other).
  ...gap('T-144', "final settle misses Dean's €47.20 card groceries (never confirmed)", [
    'msg_bcn_0172',
  ]),
  // ---- Lisbon (fixtures/chats/lisbon.jsonl; held out: the ids attribute the gap,
  // the reasons stay generic so the build loop sees no held-out behaviour, T-160) ----
  ...gap('T-145', 'held-out Lisbon line', [
    'msg_lis_0001',
    'msg_lis_0007',
    'msg_lis_0008',
    'msg_lis_0009',
    'msg_lis_0010',
    'msg_lis_0035',
  ]),
  ...gap('T-096', 'held-out Lisbon line', ['msg_lis_0017', 'msg_lis_d_0003', 'msg_lis_0029']),
  ...gap('T-147', 'held-out Lisbon line', ['msg_lis_0021', 'msg_lis_0022', 'msg_lis_0023']),
  // ---- Turks and Caicos (fixtures/chats/turks-and-caicos.jsonl) ----
  ...gap('T-023', 'family mode replies, family recap, minor age-restricted denial', [
    'msg_tci_0001',
    'msg_tci_0014',
    'msg_tci_0019',
    'clk_tci_2026062510',
  ]),
  // msg_tci_0021 is T-113's F3 repro ("dad and i want a quiet bar after lily's
  // asleep" gets a reply naming the adults): the reply, its audience and the
  // explicit adult-only request all wait on that wiring.
  ...gap('T-113', 'adult-only request in a group with a minor gets the offline fallback', [
    'msg_tci_0021',
  ]),
  // msg_tci_0023 now proposes Dean + Dad (T-081 r2), but in a group with a minor
  // the send path withdraws the casino card the minor/alcohol screen suppresses
  // (SAFETY §2.7, until T-113 lets an explicit adult-only audience through), so
  // Dad's 👍 has no card to land on.
  ...gap('T-113', 'adult-only casino card is withdrawn in a group with a minor', [
    'msg_tci_0023',
    'msg_tci_0025',
  ]),
]);

/** Marker appended to a failing check that belongs to a per-line known gap. */
export const KNOWN_GAP = '[known gap: waits on';

/** Is this evidence line a failing check explained by a per-line known gap? */
export function isKnownGapEvidence(evidence: string): boolean {
  return evidence.includes(KNOWN_GAP);
}

/**
 * Appends `[known gap: waits on T-xxx (why)]` to every evidence line of a
 * failing quality result that names a step (`[<chat line id>]`, as `where()`
 * prints it) whose expectation carries a per-line `pending`. Safety results
 * are left as they are (hard). Scores and pass/fail are unchanged.
 */
export function annotateKnownGaps(
  results: readonly GraderResult[],
  steps: readonly StepRecord[],
  table: Readonly<Record<string, LinePending>> = LINE_PENDING,
): GraderResult[] {
  const gaps = new Map<string, LinePending>();
  for (const s of steps) {
    const task = s.expect?.pending;
    if (task === undefined || s.source === undefined) continue;
    gaps.set(s.source, { task, why: table[s.source]?.why ?? '' });
  }
  if (gaps.size === 0) return [...results];
  return results.map((r) => {
    // A safety failure is hard whatever the line waits on: never labelled a known gap.
    if (r.pass || r.skipped !== undefined || r.safetyId !== undefined) return r;
    const evidence = r.evidence.map((ev) => {
      if (isKnownGapEvidence(ev)) return ev;
      for (const [source, gap] of gaps) {
        if (ev.includes(`[${source}]`)) {
          return `${ev} ${KNOWN_GAP} ${gap.task}${gap.why !== '' ? ` (${gap.why})` : ''}]`;
        }
      }
      return ev;
    });
    return { ...r, evidence };
  });
}
