import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_MAX_SPEND_USD,
  liveArgv,
  liveMain,
  mainCheckoutOf,
  planLive,
} from './live.js';

const KEY = 'sk-ant-test-not-a-real-key-000';
const DOTENV = `TRAV_OFFLINE=1\nTRAV_ANTHROPIC_API_KEY=${KEY}\nTRAV_LIVE_BUDGET_USD=45\n`;

/** A main checkout (`.git` dir, `.env`) and a linked worktree inside it (`.git` file). */
function checkouts() {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'trav-live-main-')));
  mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  writeFileSync(join(main, '.env'), DOTENV);
  const wt = join(main, '.cache', 'wt');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
  return { main, wt };
}

async function preflight(shell: Record<string, string>, repo: string) {
  const lines: string[] = [];
  const errs: string[] = [];
  const code = await liveMain(['--preflight'], shell, {
    repo,
    log: (l) => lines.push(l),
    logError: (l) => errs.push(l),
  });
  return { code, text: lines.join('\n'), errs };
}

describe('T-184 eval:live: main checkout and spend file', () => {
  it('finds the main checkout from itself and from a linked worktree', () => {
    const { main, wt } = checkouts();
    expect(mainCheckoutOf(main)).toBe(main);
    expect(mainCheckoutOf(wt)).toBe(main);
    expect(mainCheckoutOf(join(main, 'nowhere'))).toBeUndefined();
  });

  it('a worktree using the main .env spends against the main .trav by default', async () => {
    const { main, wt } = checkouts();
    const { code, text } = await preflight({ TRAV_ENV_FILE: join(main, '.env') }, wt);
    expect(code).toBe(0);
    expect(text).toContain(`spend file ${join(main, '.trav', 'spend.json')} (default`);
    expect(text).toMatch(/would run LIVE/);
    expect(text).not.toContain(KEY);
    expect(readdirSync(main)).not.toContain('.trav'); // preflight wrote nothing
  });

  it('refuses live when the spend file would be the worktree’s own (a fresh budget)', async () => {
    const { main, wt } = checkouts();
    // A worktree .env of its own → default state dir <wt>/.trav.
    writeFileSync(join(wt, '.env'), DOTENV);
    const own = await preflight({}, wt);
    expect(own.code).toBe(0);
    expect(own.text).toMatch(
      /would REFUSE live: spend file .*wt\/\.trav\/spend\.json is not the main/,
    );
    expect(own.text).not.toMatch(/would run LIVE/);
    // Explicit TRAV_STATE_DIR elsewhere is refused too, and a real run exits 2 without starting.
    const errs: string[] = [];
    const code = await liveMain(
      ['--filter', 'x'],
      { TRAV_ENV_FILE: join(main, '.env'), TRAV_STATE_DIR: join(wt, 'state') },
      { repo: wt, log: () => undefined, logError: (l) => errs.push(l) },
    );
    expect(code).toBe(2);
    expect(errs.join('\n')).toMatch(/refusing to go live: spend file/);
    // Pointing TRAV_STATE_DIR at the main .trav is accepted.
    const ok = await preflight(
      { TRAV_ENV_FILE: join(main, '.env'), TRAV_STATE_DIR: join(main, '.trav') },
      wt,
    );
    expect(ok.text).toMatch(/would run LIVE/);
  });

  it('refuses when there is no git checkout at all', () => {
    const plan = planLive({
      shell: {},
      envFile: '/x/.env',
      dotenv: DOTENV,
      mainCheckout: undefined,
    });
    expect(plan.refusal).toMatch(/main git checkout/);
  });
});

describe('T-184 eval:live: TRAV_OFFLINE', () => {
  it('drops only the env file’s TRAV_OFFLINE', () => {
    const plan = planLive({
      shell: { PATH: '/bin' },
      envFile: '/repo/.env',
      dotenv: DOTENV,
      mainCheckout: '/repo',
    });
    expect('TRAV_OFFLINE' in plan.env).toBe(false);
    expect(plan.env['TRAV_ANTHROPIC_API_KEY']).toBe(KEY);
    expect(plan.env['PATH']).toBe('/bin');
    expect(plan.env['TRAV_STATE_DIR']).toBe('/repo/.trav');
    expect(plan.refusal).toBeUndefined();
  });

  it('a shell TRAV_OFFLINE keeps the run offline, and preflight says why', async () => {
    const { main } = checkouts();
    const plan = planLive({
      shell: { TRAV_OFFLINE: '0' },
      envFile: join(main, '.env'),
      dotenv: DOTENV,
      mainCheckout: main,
    });
    expect(plan.env['TRAV_OFFLINE']).toBe('0');
    const { text } = await preflight({ TRAV_OFFLINE: '1' }, main);
    expect(text).toMatch(/TRAV_OFFLINE is set in the shell, so this run stays offline/);
    expect(text).toMatch(/would run OFFLINE \(--live requested but TRAV_OFFLINE is set/);
  });

  it('lets shell variables win over the env file', () => {
    const plan = planLive({
      shell: { TRAV_LIVE_BUDGET_USD: '5' },
      envFile: '/repo/.env',
      dotenv: 'TRAV_LIVE_BUDGET_USD=45\n',
      mainCheckout: '/repo',
    });
    expect(plan.env['TRAV_LIVE_BUDGET_USD']).toBe('5');
  });

  it('without a key still decides offline', async () => {
    const { main } = checkouts();
    writeFileSync(join(main, '.env'), 'TRAV_OFFLINE=1\n');
    const { text } = await preflight({}, main);
    expect(text).toMatch(/would run OFFLINE .*no TRAV_ANTHROPIC_API_KEY/);
  });
});

describe('T-184 eval:live arguments', () => {
  it('always passes --live and a default run cap', () => {
    expect(liveArgv(['--tag', 'paraphrase'])).toEqual([
      '--live',
      '--tag',
      'paraphrase',
      '--max-spend',
      String(DEFAULT_LIVE_MAX_SPEND_USD),
    ]);
  });

  it('keeps a caller cap and does not repeat --live', () => {
    expect(liveArgv(['--live', '--max-spend', '3'])).toEqual(['--live', '--max-spend', '3']);
  });
});
