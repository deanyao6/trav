import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { loadScenarios } from './scenarios.js';
import { evaluateScenario } from './scoring.js';

it('scratch', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'ev-'));
  for (const s of loadScenarios()) {
    const t0 = performance.now();
    const o = await evaluateScenario(s, { mode: 'offline', stateDir, grade: { mode: 'offline' } });
    const bad = o.results.filter((r) => !r.pass && r.skipped === undefined);
    console.log(
      `${s.id} ${o.status} ${o.score?.toFixed(3) ?? 'n/a'} ${Math.round(performance.now() - t0)}ms`,
      bad.map((r) => `\n   ${r.graderId}[${r.safetyId ?? ''}] ${r.evidence.slice(0, 4).join(' || ')}`).join(''),
    );
  }
}, 120_000);
