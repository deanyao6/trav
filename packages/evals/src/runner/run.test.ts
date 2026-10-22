/**
 * Runner: one fresh runtime per scenario, deterministic offline, no network,
 * steps recorded with their audit windows, and private DM text kept out of
 * step labels (which reach grader evidence and reports).
 */
import { describe, expect, it } from 'vitest';
import { scenario } from '../testing.js';
import { scenarioById } from '../testing.js';
import { runScenario } from './run.js';

describe('runScenario', () => {
  it('is deterministic offline: same scenario ⇒ same transcript, audit chain and ledger', async () => {
    const s = scenarioById('razzmatazz_proposal');
    const a = await runScenario(s, { mode: 'offline' });
    const b = await runScenario(s, { mode: 'offline' });
    expect(a.mode).toBe('offline');
    expect(b.transcript).toEqual(a.transcript);
    expect(b.audit.map((e) => [e.type, e.hash])).toEqual(a.audit.map((e) => [e.type, e.hash]));
    expect(b.snapshot.proposals).toEqual(a.snapshot.proposals);
    expect(b.steps.map((x) => x.turn?.note)).toEqual(a.steps.map((x) => x.turn?.note));
  });

  it('records the flagship proposal step: audit window, new proposal, no purchase, scripted model', async () => {
    const ep = await runScenario(scenarioById('razzmatazz_proposal'), { mode: 'offline' });
    const ask = ep.steps[0]!;
    expect(ask.turn?.modelSources[0]).toBe('script');
    expect(ask.auditTypes).toEqual(
      expect.arrayContaining(['proposal.created', 'policy.evaluated', 'approval.requested']),
    );
    expect(ep.audit.slice(ask.auditFrom, ask.auditTo).map((e) => e.type)).toEqual(ask.auditTypes);
    expect(ask.newProposals).toHaveLength(1);
    expect(ep.purchases).toBe(0);
    expect(ep.charges).toBe(0);
    // Every model call was recorded and none was live.
    expect(ep.prompts.length).toBeGreaterThan(0);
    expect(ep.prompts.every((p) => p.source !== 'live')).toBe(true);
  });

  it('runs the known-gap flagship end to end without a step error (booking stops at the proposal for now)', async () => {
    const ep = await runScenario(scenarioById('razzmatazz_flagship_full'), { mode: 'offline' });
    expect(ep.error).toBeUndefined();
    expect(ep.steps.filter((s) => s.error !== undefined)).toEqual([]);
    expect(ep.steps.some((s) => s.newProposalIds.length > 0)).toBe(true);
    expect(ep.purchases).toBeLessThanOrEqual(1);
  });

  it('records a step that throws as a step error and keeps going', async () => {
    const ep = await runScenario(
      scenario({
        steps: [
          { do: 'patch_member', memberId: 'mem_nobody', patch: {} },
          { do: 'say', at: '2026-03-14T21:40:00+01:00', from: 'h_maya', text: 'dinner at 9?' },
        ],
      }),
      { mode: 'offline' },
    );
    expect(ep.steps[0]?.error).toMatch(/unknown member mem_nobody/);
    expect(ep.steps[1]?.turn).toBeDefined();
  });

  it('never puts DM text into step labels', async () => {
    const ep = await runScenario(
      scenario({
        steps: [
          {
            do: 'say',
            lane: 'dm',
            from: 'h_sam',
            text: 'my card ending 4821 is maxed',
            at: '2026-03-14T21:40:00+01:00',
          },
        ],
      }),
      { mode: 'offline' },
    );
    expect(ep.steps[0]?.label).toBe('h_sam (dm): [private message]');
    expect(JSON.stringify(ep.steps.map((s) => s.label))).not.toContain('4821');
  });
});
