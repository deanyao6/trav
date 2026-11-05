/**
 * Runner: one fresh runtime per scenario, deterministic offline, no network,
 * steps recorded with their audit windows, and private DM text kept out of
 * step labels (which reach grader evidence and reports).
 */
import { describe, expect, it } from 'vitest';
import { lineView } from '../graders/lineChecks.js';
import { turnExpectations } from '../graders/quality.js';
import { evaluateScenario, scenarioPassed } from '../scoring.js';
import { OFFLINE, scenario, scenarioById } from '../testing.js';
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
          { do: 'say', at: '2026-03-14T21:40:00+01:00', from: 'h_chase', text: 'dinner at 9?' },
        ],
      }),
      { mode: 'offline' },
    );
    expect(ep.steps[0]?.error).toMatch(/unknown member mem_nobody/);
    expect(ep.steps[1]?.turn).toBeDefined();
  });

  it("loads the scenario's own trip inventory (T-079): TCI finds the snorkel tour, Lisbon the Benfica match", async () => {
    const tci = await runScenario(
      scenario({
        setup: { group: 'turks-and-caicos' },
        steps: [
          {
            do: 'say',
            at: '2026-06-20T18:05:00-04:00',
            from: 'h_dad',
            text: '@trav get the 4 of us snorkel tour tickets',
          },
        ],
      }),
      { mode: 'offline' },
    );
    expect(tci.snapshot.proposals).toHaveLength(1);
    expect(tci.snapshot.proposals[0]).toMatchObject({
      itemRef: expect.stringContaining('tci_snorkel_0622'),
      city: 'Providenciales',
      currency: 'USD',
      totalMinor: 26000,
    });
    expect(tci.snapshot.proposals[0]?.attendees).toHaveLength(4);
    expect(tci.purchases).toBe(0);

    const lis = await runScenario(
      scenario({
        setup: { group: 'lisbon' },
        steps: [
          {
            do: 'say',
            at: '2026-04-16T10:00:00+01:00',
            from: 'h_dean',
            text: '@trav get the 2 of us benfica vs porto tickets for saturday apr 18',
          },
        ],
      }),
      { mode: 'offline' },
    );
    expect(lis.snapshot.proposals).toHaveLength(1);
    expect(lis.snapshot.proposals[0]).toMatchObject({
      itemRef: expect.stringContaining('benfica_porto'),
      currency: 'EUR',
    });
    expect(lis.purchases).toBe(0);
  });

  it('grades replayed chat-line ground truth (T-077): a propose_booking line with no proposal fails turn_expectations', async () => {
    // "@trav book option 1" with no options before it: nothing can be proposed.
    const s = scenario({ steps: [{ do: 'replay', chat: 'barcelona', ids: ['msg_bcn_0019'] }] });
    const ep = await runScenario(s, { mode: 'offline' });
    const line = ep.steps.find((x) => x.source === 'msg_bcn_0019')!;
    expect(line.expect?.action).toEqual(['propose_booking']);
    expect(line.newProposalIds).toEqual([]);
    const [r] = await turnExpectations.grade(ep, s, OFFLINE);
    expect(r?.pass).toBe(false);
    expect(r?.skipped).toBeUndefined();
    expect(r?.evidence.join('\n')).toMatch(/\[msg_bcn_0019\].*expected propose_booking; observed/);
    // Trav says there are no flight options to book (T-074), nothing is proposed.
    expect((line.turn?.outbound ?? []).map((m) => m.text).join('\n')).toMatch(
      /^there are no flight options up right now, so nothing's booked/,
    );
    // Graded end to end: still a failure. Flights are built (T-074), so it is
    // no known gap: the line only fails because it is replayed without its options.
    const o = await evaluateScenario(s, { mode: 'offline', grade: OFFLINE });
    expect(scenarioPassed(o)).toBe(false);
    const evidence = o.results.find((x) => x.graderId === 'turn_expectations')?.evidence ?? [];
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.some((ev) => ev.includes('[known gap: waits on'))).toBe(false);
    // Fields no grader checks are reported as skipped, never as passes.
    const ungraded = o.results.find((x) => x.graderId === 'turn_expectations:ungraded');
    expect(ungraded?.skipped).toMatch(/toolCalls \(1\)/);
    // proposal.kind/provider/currency/paidBy/itemRefFrom are graded since T-160.
    expect(ungraded?.skipped).not.toMatch(/proposal\./);
    expect(ungraded?.pass).toBe(true);
  });

  it('replays card and email system lines as owner imports (T-078); consent is what the chat set', async () => {
    const ep = await runScenario(
      scenario({
        steps: [
          {
            do: 'replay',
            chat: 'barcelona',
            ids: [
              'msg_bcn_d_0005',
              'sys_bcn_0155',
              'sys_bcn_0191',
              'msg_bcn_d_0007',
              'sys_bcn_0113',
            ],
          },
        ],
      }),
      { mode: 'offline' },
    );
    expect(ep.skippedLines).toEqual([]);
    const at = (id: string) => ep.steps.find((x) => x.source === id)!;
    const crowley = at('sys_bcn_0155');
    expect(crowley.lane).toBe('dm');
    expect(crowley.turn?.imported?.status).toBe('imported');
    expect(crowley.turn?.outbound.length).toBeGreaterThan(0);
    expect(
      crowley.turn?.outbound.every(
        (m) => m.to.kind === 'member' && m.to.memberId === 'mem_crowley',
      ),
    ).toBe(true);
    // Piotr never opted in: nothing read, stored or sent.
    const piotr = at('sys_bcn_0191');
    expect(piotr.turn?.imported).toEqual({ status: 'consent_off', stored: 0, prompted: 0 });
    expect(piotr.turn?.outbound).toEqual([]);
    const arjun = at('sys_bcn_0113');
    expect(arjun.turn?.imported?.status).toBe('imported');
    expect(
      arjun.turn?.outbound.every((m) => m.to.kind === 'member' && m.to.memberId === 'mem_arjun'),
    ).toBe(true);
    // Nothing reached the group, and the sunglasses / card digits never did.
    const group = ep.transcript.filter((t) => t.lane === 'group' && t.direction === 'outbound');
    expect(group).toEqual([]);
    expect(JSON.stringify(ep.steps.map((x) => x.label))).not.toMatch(/sunglasses|4821/);
  });

  it('judges a clock line on its advance record together with the scheduled turns it ran', async () => {
    const ep = await runScenario(
      scenario({ steps: [{ do: 'replay', chat: 'barcelona', toId: 'clk_bcn_2026031310' }] }),
      { mode: 'offline' },
    );
    const clk = ep.steps.find((x) => x.source === 'clk_bcn_2026031310')!;
    const ran = ep.steps.filter((x) => x.drainedFrom === clk.index);
    expect(ran.map((x) => x.turn?.note)).toContain('scheduled:morning_after:full');
    expect(lineView(ep, clk).turn?.outbound.length).toBe(
      ran.reduce((n, x) => n + (x.turn?.outbound.length ?? 0), 0),
    );
  });

  it('never puts DM text into step labels', async () => {
    const ep = await runScenario(
      scenario({
        steps: [
          {
            do: 'say',
            lane: 'dm',
            from: 'h_crowley',
            text: 'my card ending 4821 is maxed',
            at: '2026-03-14T21:40:00+01:00',
          },
        ],
      }),
      { mode: 'offline' },
    );
    expect(ep.steps[0]?.label).toBe('h_crowley (dm): [private message]');
    expect(JSON.stringify(ep.steps.map((s) => s.label))).not.toContain('4821');
  });
});
