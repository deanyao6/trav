/**
 * The `pnpm eval` entry point: flags, mode decision (live is opt-in and
 * gated), selection, exit codes, and a real subprocess run of the CLI.
 * Everything runs offline with a temp state dir: no network, no `.trav/`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CompletionRequest, ModelClient } from '@trav/agent';
import {
  HELP,
  createRubricJudge,
  decideMode,
  main,
  parseArgs,
  runAll,
  selectScenarios,
} from './cli.js';
import { rubric } from './graders/quality.js';
import { loadScenarios } from './scenarios.js';
import { episode, scenario } from './testing.js';
import type { Scenario } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `trav-evals-${name}-`));
}

/** A scenario dir with the given scenarios, an output dir and an offline env. */
function workspace(scenarios: readonly Scenario[]) {
  const root = tmp('cli');
  const dir = join(root, 'scenarios');
  const out = join(root, 'reports');
  mkdirSync(dir);
  writeFileSync(join(dir, 'test.json'), JSON.stringify(scenarios));
  return { dir, out, env: { TRAV_OFFLINE: '1', TRAV_STATE_DIR: join(root, 'state') } };
}

const CLEAN: Scenario = {
  id: 'clean_silence',
  title: 'side chatter gets silence',
  tags: ['mention'],
  steps: [
    {
      do: 'say',
      at: '2026-03-14T21:40:00+01:00',
      from: 'h_maya',
      text: 'dinner at 9?',
      expect: { silent: true },
    },
  ],
};

/** A safety scenario that cannot run (unknown member) — a hard failure on its checklist id. */
const BROKEN_SAFETY: Scenario = {
  id: 'broken_safety',
  title: 'safety scenario that crashes',
  tags: ['safety', 'privacy'],
  checklist: ['C2'],
  steps: [{ do: 'patch_member', memberId: 'mem_nobody', patch: {} }],
};

describe('parseArgs', () => {
  it('defaults: all scenarios, offline, report on, static checks on', () => {
    expect(parseArgs([])).toEqual({
      tags: [],
      report: true,
      split: 'all',
      static: true,
      live: false,
      help: false,
    });
  });

  it('parses every flag', () => {
    expect(
      parseArgs([
        '--filter',
        'razz',
        '--tag',
        'safety',
        '--tag',
        'booking',
        '--out',
        'o',
        '--scenarios',
        's',
        '--no-report',
        '--no-static',
        '--live',
        '--split',
        'dev',
        '--',
      ]),
    ).toEqual({
      filter: 'razz',
      tags: ['safety', 'booking'],
      out: 'o',
      scenariosDir: 's',
      report: false,
      split: 'dev',
      static: false,
      live: true,
      help: false,
    });
    expect(parseArgs(['--heldout']).split).toBe('heldout');
    expect(parseArgs(['--regression']).split).toBe('regression');
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('rejects unknown flags, unknown tags, bad splits, missing values and conflicting splits', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument --nope/);
    expect(() => parseArgs(['--tag', 'sparkles'])).toThrow(/unknown tag sparkles/);
    expect(() => parseArgs(['--split', 'train'])).toThrow(/--split must be one of/);
    expect(() => parseArgs(['--filter'])).toThrow(/--filter needs a value/);
    expect(() => parseArgs(['--out', '--live'])).toThrow(/--out needs a value/);
    expect(() => parseArgs(['--heldout', '--regression'])).toThrow(/conflicting splits/);
  });
});

describe('--help', () => {
  it('documents the filter, split/held-out, live and output flags and the exit codes', async () => {
    for (const flag of [
      '--filter',
      '--tag',
      '--heldout',
      '--regression',
      '--split',
      '--live',
      '--out',
      '--no-report',
      '--scenarios',
    ]) {
      expect(HELP).toContain(flag);
    }
    expect(HELP).toMatch(/exit code: 0 no safety failure · 1 any safety failure/);
    const lines: string[] = [];
    expect(await main(['--help'], {}, (l) => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toBe(HELP);
  });
});

describe('decideMode', () => {
  const KEY = { TRAV_ANTHROPIC_API_KEY: 'test-not-a-key' };
  const never = () => {
    throw new Error('the spend guard must not be consulted');
  };

  it('is offline unless --live is passed, even with a key', () => {
    expect(decideMode(KEY, never, false)).toEqual({
      mode: 'offline',
      note: 'default offline; pass --live for live models',
    });
    expect(decideMode({ TRAV_OFFLINE: '1' }, never, false).note).toBe('TRAV_OFFLINE is set');
  });

  it('--live still runs offline (labelled) without a key, with TRAV_OFFLINE, or with the budget spent', () => {
    expect(decideMode({}, never, true)).toEqual({
      mode: 'offline',
      note: '--live requested but no TRAV_ANTHROPIC_API_KEY; ran offline',
    });
    expect(decideMode({ ...KEY, TRAV_OFFLINE: '1' }, never, true).mode).toBe('offline');
    expect(decideMode(KEY, () => false, true)).toEqual({
      mode: 'offline',
      note: '--live requested but the live budget is exhausted (spend guard); ran offline',
    });
  });

  it('is live only with --live, a key and spend headroom; the note never contains the key', () => {
    const d = decideMode(KEY, () => true, true);
    expect(d.mode).toBe('live');
    expect(d.note).not.toContain('test-not-a-key');
  });
});

describe('selectScenarios', () => {
  const all = loadScenarios();

  it('dev excludes held-out, heldout and regression select only theirs', () => {
    const dev = selectScenarios(all, { split: 'dev', tags: [] }).scenarios;
    const held = selectScenarios(all, { split: 'heldout', tags: [] }).scenarios;
    const reg = selectScenarios(all, { split: 'regression', tags: [] }).scenarios;
    expect(held.length).toBeGreaterThan(0);
    expect(reg.length).toBeGreaterThan(0);
    expect(dev.length + held.length).toBe(all.length);
    expect(dev.some((s) => s.tags.includes('heldout'))).toBe(false);
    expect(held.every((s) => s.tags.includes('heldout'))).toBe(true);
    expect(reg.every((s) => s.tags.includes('regression') && s.pending === undefined)).toBe(true);
  });

  it('filters by id substring and by every tag', () => {
    const { scenarios, selection } = selectScenarios(all, {
      split: 'all',
      filter: 'razz',
      tags: ['booking'],
    });
    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios.every((s) => s.id.includes('razz') && s.tags.includes('booking'))).toBe(true);
    expect(selection).toMatch(
      /split all, ids containing "razz", tags booking: \d+ of \d+ scenarios/,
    );
  });
});

describe('runAll / main', () => {
  it('a clean run exits 0 and writes the markdown report plus its JSON', async () => {
    const w = workspace([CLEAN]);
    const lines: string[] = [];
    const r = await runAll(
      { ...parseArgs(['--no-static']), scenariosDir: w.dir, out: w.out },
      w.env,
      (l) => lines.push(l),
    );
    expect(r.exitCode).toBe(0);
    expect(r.reportPath).toBeDefined();
    const files = readdirSync(w.out).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.json$/);
    expect(files[1]).toMatch(/\.md$/);
    const md = readFileSync(r.reportPath!, 'utf8');
    expect(md).toContain('PASS (no safety failures), exit 0');
    expect(md).toContain('**Mode:** `offline`');
    expect(lines[0]).toMatch(/mode OFFLINE/);
  });

  it('a safety failure exits 1 and the report lists its SAFETY §3 id', async () => {
    const w = workspace([CLEAN, BROKEN_SAFETY]);
    const r = await runAll(
      { ...parseArgs(['--no-static']), scenariosDir: w.dir, out: w.out },
      w.env,
      () => {},
    );
    expect(r.exitCode).toBe(1);
    const md = readFileSync(r.reportPath!, 'utf8');
    expect(md).toMatch(/^\| \*\*C2\*\* \| .* \| broken_safety \| runner \|/m);
    const json = JSON.parse(readFileSync(r.reportPath!.replace(/\.md$/, '.json'), 'utf8')) as {
      exitCode: number;
      safetyFailures: { safetyId: string }[];
    };
    expect(json.exitCode).toBe(1);
    expect(json.safetyFailures.map((f) => f.safetyId)).toEqual(['C2']);
  });

  it('--live without a key runs offline, labelled, and rubric graders stay skipped', async () => {
    const w = workspace([CLEAN]);
    const r = await runAll(
      { ...parseArgs(['--no-static', '--live']), scenariosDir: w.dir, out: w.out },
      w.env,
      () => {},
    );
    expect(r.outcomes[0]?.episode?.mode).toBe('offline');
    expect(r.outcomes[0]?.results.find((x) => x.graderId === 'rubric')?.skipped).toBe(
      'rubric graders run live only',
    );
    expect(readFileSync(r.reportPath!, 'utf8')).toContain(
      '--live requested but TRAV_OFFLINE is set; ran offline',
    );
  });

  it('exits 2 on a bad flag, a selection that matches nothing, or a broken scenario file', async () => {
    const errs: string[] = [];
    expect(
      await main(
        ['--bogus'],
        {},
        () => {},
        (l) => errs.push(l),
      ),
    ).toBe(2);
    const w = workspace([CLEAN]);
    expect(
      await main(
        ['--scenarios', w.dir, '--filter', 'zzz', '--no-report'],
        w.env,
        () => {},
        (l) => errs.push(l),
      ),
    ).toBe(2);
    writeFileSync(
      join(w.dir, 'broken.json'),
      JSON.stringify([{ id: 'x', title: 't', tags: ['nope'], steps: [] }]),
    );
    expect(
      await main(
        ['--scenarios', w.dir, '--no-report'],
        w.env,
        () => {},
        (l) => errs.push(l),
      ),
    ).toBe(2);
    expect(errs.join('\n')).toMatch(
      /unknown argument --bogus[\s\S]*no scenarios match[\s\S]*unknown tag nope/,
    );
  });

  it('--no-report writes nothing', async () => {
    const w = workspace([CLEAN]);
    const r = await runAll(
      { ...parseArgs(['--no-static', '--no-report']), scenariosDir: w.dir, out: w.out },
      w.env,
      () => {},
    );
    expect(r.reportPath).toBeUndefined();
    expect(() => readdirSync(w.out)).toThrow();
  });
});

describe('the real CLI process', () => {
  const cli = join(here, 'cli.ts');
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: join(here, '..'),
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        TMPDIR: tmpdir(),
        ...env,
      },
      encoding: 'utf8',
      timeout: 120_000,
    });

  it('exits 0 on a clean run and 1 on a safety failure, writing a report each time', () => {
    const clean = workspace([CLEAN]);
    const a = run(['--scenarios', clean.dir, '--out', clean.out, '--no-static'], clean.env);
    expect(a.stderr).toBe('');
    expect(a.status).toBe(0);
    expect(a.stdout).toMatch(/exit 0/);
    expect(readdirSync(clean.out).filter((f) => f.endsWith('.md'))).toHaveLength(1);

    const broken = workspace([BROKEN_SAFETY]);
    const b = run(['--scenarios', broken.dir, '--out', broken.out, '--no-static'], broken.env);
    expect(b.status).toBe(1);
    expect(b.stdout).toMatch(/SAFETY FAIL broken_safety/);
    expect(b.stdout).toMatch(/\[C2\] runner/);
    expect(readdirSync(broken.out).filter((f) => f.endsWith('.md'))).toHaveLength(1);
  }, 240_000);

  it('prints help and exits 0', () => {
    const r = run(['--help'], { TRAV_OFFLINE: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage: pnpm eval');
  }, 120_000);
});

describe('rubric judge (live only)', () => {
  /** A fake model client: never touches the network. */
  function fakeModel(json: unknown): { model: ModelClient; seen: CompletionRequest[] } {
    const seen: CompletionRequest[] = [];
    const model: ModelClient = {
      mode: 'live',
      complete(req) {
        seen.push(req);
        return Promise.resolve({
          text: '',
          toolCalls: [],
          json,
          usage: { inputTokens: 1, outputTokens: 1 },
          source: 'live',
          scriptKey: '',
        } as never);
      },
      classify() {
        return Promise.reject(new Error('unused'));
      },
    };
    return { model, seen };
  }

  it('asks the grader model with no tools and wraps the transcript as untrusted', async () => {
    const { model, seen } = fakeModel({ score: 0.8, rationale: 'warm and short' });
    const judge = createRubricJudge(model);
    expect(await judge.judge({ criterion: 'tone', transcript: 'trav: hi' })).toEqual({
      score: 0.8,
      rationale: 'warm and short',
    });
    expect(seen[0]?.model).toBe('grader');
    expect(seen[0]?.tools).toEqual([]);
    expect(JSON.stringify(seen[0]?.messages)).toContain('untrusted');
  });

  it('rubric grader: skipped offline; scored live; a failing grader call is skipped, never a pass', async () => {
    const ep = episode({
      transcript: [
        {
          seq: 1,
          type: 'message',
          direction: 'outbound',
          lane: 'group',
          fromName: 'Trav',
          text: 'booked',
        },
      ] as never,
    });
    const s = scenario({ rubric: ['tone'] });
    const off = await rubric.grade(ep, s, { mode: 'offline' });
    expect(off[0]?.skipped).toBe('rubric graders run live only');

    const live = await rubric.grade(ep, s, {
      mode: 'live',
      rubric: createRubricJudge(fakeModel({ score: 0.4, rationale: 'curt' }).model),
    });
    expect(live[0]).toMatchObject({ graderId: 'rubric', score: 0.4, pass: false });

    const broken = await rubric.grade(ep, s, {
      mode: 'live',
      rubric: createRubricJudge(fakeModel({}).model),
    });
    expect(broken[0]?.skipped).toMatch(/grader call failed: grader returned no numeric score/);
  });
});
