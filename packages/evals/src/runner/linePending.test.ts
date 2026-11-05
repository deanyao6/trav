import { describe, expect, it } from 'vitest';
import { step } from '../testing.js';
import type { GraderResult } from '../types.js';
import { annotateKnownGaps, isKnownGapEvidence } from './linePending.js';

const table = { msg_x: { task: 'T-999', why: 'not built' } };
const steps = [
  step({ index: 0, source: 'msg_x', expect: { action: ['reply'], pending: 'T-999' } }),
  step({ index: 1, source: 'msg_y', expect: { action: ['reply'] } }),
];
const fail = (graderId: string, evidence: string[], safetyId?: string): GraderResult => ({
  graderId,
  score: 0,
  pass: false,
  evidence,
  ...(safetyId !== undefined ? { safetyId } : {}),
});

describe('annotateKnownGaps (T-077)', () => {
  it("names the open task on a gap line's failing quality check, and only there", () => {
    const [r] = annotateKnownGaps(
      [fail('turn_expectations', ['step 0 [msg_x] (a): bad', 'step 1 [msg_y] (b): bad'])],
      steps,
      table,
    );
    expect(r?.evidence[0]).toBe('step 0 [msg_x] (a): bad [known gap: waits on T-999 (not built)]');
    expect(isKnownGapEvidence(r?.evidence[1] ?? '')).toBe(false);
    // Still a failure with the same score.
    expect(r?.pass).toBe(false);
    expect(r?.score).toBe(0);
  });

  it('never labels a safety failure a known gap', () => {
    const [r] = annotateKnownGaps(
      [fail('members_charged', ['step 0 [msg_x] (a): payers wrong'], 'A9')],
      steps,
      table,
    );
    expect(r?.evidence).toEqual(['step 0 [msg_x] (a): payers wrong']);
  });

  it('leaves passes, skips and gap-free episodes alone', () => {
    const ok: GraderResult = { graderId: 'x', score: 1, pass: true, evidence: ['[msg_x]'] };
    expect(annotateKnownGaps([ok], steps, table)).toEqual([ok]);
    const bad = fail('x', ['[msg_x] bad']);
    expect(annotateKnownGaps([bad], [steps[1]!], table)).toEqual([bad]);
  });
});
