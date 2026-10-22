/**
 * The checklist module stays in sync with docs/SAFETY.md and the graders.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './arch/repo.js';
import {
  GRADED_IDS,
  HARD_IDS,
  STATIC_IDS,
  UNGRADED_HARD,
  checklistTitle,
  coverageOf,
  parseChecklistTitles,
  scenarioCoverage,
} from './checklist.js';
import { loadScenarios } from './scenarios.js';
import { scenario } from './testing.js';

const here = dirname(fileURLToPath(import.meta.url));
const safetyDoc = readFileSync(join(repoRoot(), 'docs', 'SAFETY.md'), 'utf8');

describe('SAFETY §3 ids', () => {
  it('parses every checklist item title from docs/SAFETY.md', () => {
    const titles = parseChecklistTitles(safetyDoc);
    for (const id of ['A1', 'A3', 'A9', 'B1', 'C2', 'D4', 'E3', 'F5', 'G2', 'H5']) {
      expect(titles.get(id), id).toBeTruthy();
    }
    expect(checklistTitle('A9')).toMatch(/^Payers equal the named subset/);
    expect(checklistTitle('Z9')).toBe('');
  });

  it('HARD_IDS is exactly the §3.I list of hard deterministic graders', () => {
    const line = safetyDoc
      .split('\n')
      .find((l) => l.startsWith('Deterministic graders, all **hard failures**'));
    expect(line).toBeDefined();
    const ids = [...(line ?? '').matchAll(/\b([A-H][0-9]{1,2})\b/g)].map((m) => m[1]);
    expect([...HARD_IDS].sort()).toEqual([...ids].sort());
  });

  it('every hard id has a grader, a static check, or a written reason', () => {
    for (const id of HARD_IDS) {
      expect(coverageOf(id) !== 'none' || UNGRADED_HARD[id] !== undefined, id).toBe(true);
    }
  });

  it('GRADED_IDS matches the ids graders/safety.ts can emit', () => {
    const src = readFileSync(join(here, 'graders', 'safety.ts'), 'utf8');
    const literal = [...src.matchAll(/safetyId: '([A-H][0-9]{1,2})'/g)].map((m) => m[1]!);
    // identity_approval emits the step's own id (StepExpect.identity.safetyId: E2 | E3 | E5).
    const emitted = new Set([...literal, 'E2', 'E3', 'E5']);
    expect([...GRADED_IDS].sort()).toEqual([...emitted].sort());
    for (const id of STATIC_IDS) expect(GRADED_IDS).not.toContain(id);
  });

  it('every id a scenario declares is a real SAFETY §3 item', () => {
    const titles = parseChecklistTitles(safetyDoc);
    for (const s of loadScenarios()) {
      for (const id of s.checklist ?? []) expect(titles.has(id), `${s.id}: ${id}`).toBe(true);
    }
  });
});

describe('scenarioCoverage', () => {
  it('pass / fail from graded results; not exercised when only skipped; static and no-grader kinds', () => {
    const s = scenario({ checklist: ['A3', 'A9', 'C5', 'A1', 'C1'] });
    const cov = scenarioCoverage(s, [
      { graderId: 'policy_respected', safetyId: 'A3', score: 1, pass: true, evidence: [] },
      { graderId: 'members_charged', safetyId: 'A9', score: 0, pass: false, evidence: [] },
      {
        graderId: 'qr_delivery',
        safetyId: 'C5',
        score: 1,
        pass: true,
        evidence: [],
        skipped: 'no tickets',
      },
    ]);
    expect(cov).toEqual([
      { id: 'A3', status: 'pass' },
      { id: 'A9', status: 'fail' },
      { id: 'C5', status: 'not_exercised' },
      { id: 'A1', status: 'static' },
      { id: 'C1', status: 'no_grader' },
    ]);
  });
});
