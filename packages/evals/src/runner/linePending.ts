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
  ...gap('T-074', 'flights in chat: no offline flight search or flight proposal', [
    'msg_bcn_0014',
    'msg_bcn_0019',
    'msg_bcn_0020',
    'msg_bcn_0021',
    'msg_bcn_0022',
    'msg_bcn_0023',
    'msg_bcn_0024',
    'msg_bcn_0025',
    'msg_bcn_0026',
  ]),
  ...gap('T-132', 'offline lodging ask searches but never proposes the rate', [
    'msg_bcn_0027',
    'msg_bcn_0031',
    'msg_bcn_0032',
    'msg_bcn_0033',
    'msg_bcn_0034',
    'msg_bcn_0035',
    'msg_bcn_0036',
    'msg_bcn_0037',
  ]),
  ...gap('T-133', '"anything cheaper" does not re-search the pending event', ['msg_bcn_0042']),
  ...gap('T-143', 'a sold-out slot or an unnamed venue gets no alternatives or question', [
    'msg_bcn_0052',
    'msg_bcn_0056',
    'msg_bcn_0163',
  ]),
  // The combined roster sentence itself is handled (T-082, roster/combined.ts),
  // but this line is addressed only by the 2-minute reply window after Trav's
  // question on msg_bcn_0163, which offline asks none until T-143.
  ...gap('T-143', 'reply to msg_bcn_0163: no Trav question, so no reply window', ['msg_bcn_0164']),
  ...gap('T-084', 'no FX for chat expenses', ['msg_bcn_0063']),
  ...gap('T-134', 'private budget DM is not remembered offline', ['msg_bcn_d_0002']),
  ...gap('T-083', 'receipt photo waits for the payer 👍 (SAFETY D5) the fixture lacks', [
    'msg_bcn_0093',
    'msg_bcn_0161',
  ]),
  ...gap('T-136', 'roast from group-ledger facts finds nothing to say', ['msg_bcn_0112']),
  ...gap('T-137', 'late joiner "can i get one too" and its cancel', [
    'msg_bcn_0135',
    'msg_bcn_0136',
  ]),
  ...gap('T-139', "a guest's second message: fixture expects a refusal, agent stays silent", [
    'msg_bcn_0147',
  ]),
  ...gap('T-140', 'low-confidence looks-shared DM wording', ['sys_bcn_0176']),
  ...gap('T-067', 'card sync returns later-dated rows, so Sam gets a digest, not one card', [
    'sys_bcn_0155',
    'msg_bcn_d_0010',
  ]),
  ...gap('T-144', "Dean's two-row digest vs separate cards; digest confirm by row id", [
    'sys_bcn_0192',
    'msg_bcn_d_0012',
  ]),
  ...gap('T-141', '👍 on the final settle card does not mark a transfer paid', ['msg_bcn_0173']),
  // ---- Lisbon (fixtures/chats/lisbon.jsonl; held out: these name the gap, nothing is tuned on them) ----
  ...gap('T-145', 'Lisbon match asks: sold-out derby, Benfica vs Porto proposal and its ledger', [
    'msg_lis_0001',
    'msg_lis_0007',
    'msg_lis_0008',
    'msg_lis_0009',
    'msg_lis_0010',
    'msg_lis_0035',
  ]),
  ...gap('T-096', 'Lisbon journey asks hit the offline fallback', [
    'msg_lis_0017',
    'msg_lis_d_0003',
    'msg_lis_0029',
  ]),
  ...gap('T-146', 'Lisbon inventory vs chat fixture refundability', [
    'msg_lis_0018',
    'msg_lis_0032',
  ]),
  ...gap('T-147', 'Lisbon fado ask, its ambiguous "Yes" and the booking', [
    'msg_lis_0021',
    'msg_lis_0022',
    'msg_lis_0023',
  ]),
  // ---- Turks and Caicos (fixtures/chats/turks-and-caicos.jsonl) ----
  ...gap('T-023', 'family mode replies, family recap, minor age-restricted denial', [
    'msg_tci_0001',
    'msg_tci_0014',
    'msg_tci_0019',
    'msg_tci_0021',
    'clk_tci_2026062510',
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
