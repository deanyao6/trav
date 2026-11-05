import { describe, expect, it } from 'vitest';
import { preflightLines } from './cli.js';
import { DEFAULT_LIVE_MAX_SPEND_USD, liveArgv, liveEnv } from './live.js';

const KEY = 'sk-ant-test-not-a-real-key-000';

describe('T-184 eval:live environment', () => {
  it('drops TRAV_OFFLINE from the env file and the shell', () => {
    const env = liveEnv(
      { TRAV_OFFLINE: '1', PATH: '/bin' },
      `TRAV_OFFLINE=1\nTRAV_ANTHROPIC_API_KEY=${KEY}\nTRAV_LIVE_BUDGET_USD=45\n`,
    );
    expect('TRAV_OFFLINE' in env).toBe(false);
    expect(env['TRAV_ANTHROPIC_API_KEY']).toBe(KEY);
    expect(env['PATH']).toBe('/bin');
  });

  it('lets shell variables win over the env file', () => {
    const env = liveEnv({ TRAV_LIVE_BUDGET_USD: '5' }, 'TRAV_LIVE_BUDGET_USD=45\n');
    expect(env['TRAV_LIVE_BUDGET_USD']).toBe('5');
  });

  it('without an env file and without a key still decides offline (no key)', () => {
    const env = liveEnv({ TRAV_OFFLINE: '1' }, undefined);
    const [first] = preflightLines(
      { live: true },
      env,
      () => 0,
      () => true,
    );
    expect(first).toMatch(/would run OFFLINE .*no TRAV_ANTHROPIC_API_KEY/);
  });

  it('with a key decides live, and an exhausted guard still blocks', () => {
    const env = liveEnv({}, `TRAV_OFFLINE=1\nTRAV_ANTHROPIC_API_KEY=${KEY}\n`);
    expect(
      preflightLines(
        { live: true },
        env,
        () => 0,
        () => true,
      )[0],
    ).toMatch(/would run LIVE/);
    expect(
      preflightLines(
        { live: true },
        env,
        () => 45,
        () => false,
      )[0],
    ).toMatch(/OFFLINE .*budget/);
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
