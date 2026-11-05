/**
 * T-169 acceptance: nothing calls a real relay vendor unless
 * `TRAV_CHANNEL=imessage_relay`, `TRAV_RELAY_LIVE=1`, the key and
 * `TRAV_RELAY_LINE` are all set. `globalThis.fetch` is replaced by a spy for the whole file, so a
 * network call anywhere in these paths would be caught (and never leave the
 * machine).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockRelay } from '../../mock/relay/index.js';
import { groupMsg, manualClock } from '../testing.js';
import type { RelayEnv } from './config.js';
import {
  MOCK_RELAY_LINE,
  createLiveRelayTransport,
  createRelayFromEnv,
  describeRelayConfig,
  resolveRelayConfig,
} from './config.js';

const CHAT = 'iMessage;+;chat1';
const FAKE_KEY = 'test-key-not-real-0000';
const FAKE_SECRET = 'test-secret-not-real-0000';

let fetchSpy: ReturnType<typeof vi.fn>;
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  fetchSpy = vi.fn(async () => {
    throw new Error('network is off in tests');
  });
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function roundTrip(env: RelayEnv) {
  const clock = manualClock('2026-03-14T21:40:00+01:00');
  const mock = createMockRelay({
    vendor: (env['TRAV_RELAY_VENDOR'] as 'photon' | 'sendblue') ?? 'photon',
    clock,
    chats: [{ chatId: CHAT, participants: ['+16175550101'] }],
  });
  const built = createRelayFromEnv({
    env,
    clock,
    mockTransport: mock.transport,
    chats: [{ chatId: CHAT, participants: ['+16175550101'] }],
    sleep: async () => undefined,
  });
  if (!built) return { built, mock };
  const sent = await built.channel.sendGroup(CHAT, groupMsg('hi'));
  const hook = await mock.memberMessage({
    chat: { kind: 'group', chatId: CHAT },
    from: '+16175550101',
    text: 'yes',
  });
  const status = (await built.channel.handleWebhook(hook)).status;
  return { built, mock, sent, status };
}

describe('no live relay call unless TRAV_RELAY_LIVE=1 and a key are both set', () => {
  const offCases: [string, RelayEnv][] = [
    ['nothing set', {}],
    ['a key but no TRAV_CHANNEL', { TRAV_RELAY_LIVE: '1', TRAV_RELAY_API_KEY: FAKE_KEY }],
    [
      'TRAV_CHANNEL=simulator',
      { TRAV_CHANNEL: 'simulator', TRAV_RELAY_LIVE: '1', TRAV_RELAY_API_KEY: FAKE_KEY },
    ],
  ];
  for (const [name, env] of offCases) {
    it(`relay off: ${name}`, async () => {
      expect(resolveRelayConfig(env)).toMatchObject({ enabled: false, live: false });
      const { built } = await roundTrip(env);
      expect(built).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  const mockCases: [string, RelayEnv][] = [
    ['relay on, no key, live unset', { TRAV_CHANNEL: 'imessage_relay' }],
    ['live=1 but no key', { TRAV_CHANNEL: 'imessage_relay', TRAV_RELAY_LIVE: '1' }],
    [
      'live=1 and an empty key',
      { TRAV_CHANNEL: 'imessage_relay', TRAV_RELAY_LIVE: '1', TRAV_RELAY_API_KEY: '  ' },
    ],
    ['a key but live unset', { TRAV_CHANNEL: 'imessage_relay', TRAV_RELAY_API_KEY: FAKE_KEY }],
    [
      'a key and live=true (only "1" counts)',
      { TRAV_CHANNEL: 'imessage_relay', TRAV_RELAY_LIVE: 'true', TRAV_RELAY_API_KEY: FAKE_KEY },
    ],
    [
      'sendblue live=1 with a key id but no secret',
      {
        TRAV_CHANNEL: 'imessage_relay',
        TRAV_RELAY_VENDOR: 'sendblue',
        TRAV_RELAY_LIVE: '1',
        TRAV_RELAY_API_KEY: FAKE_KEY,
      },
    ],
    // Round 2, flaw 3: the line is a live gate too (never send as the mock line).
    [
      'live=1 and a key but no TRAV_RELAY_LINE',
      { TRAV_CHANNEL: 'imessage_relay', TRAV_RELAY_LIVE: '1', TRAV_RELAY_API_KEY: FAKE_KEY },
    ],
    [
      'sendblue live=1 with key and secret but a blank TRAV_RELAY_LINE',
      {
        TRAV_CHANNEL: 'imessage_relay',
        TRAV_RELAY_VENDOR: 'sendblue',
        TRAV_RELAY_LIVE: '1',
        TRAV_RELAY_API_KEY: FAKE_KEY,
        TRAV_RELAY_API_SECRET: FAKE_SECRET,
        TRAV_RELAY_LINE: ' ',
      },
    ],
  ];
  it('says why live is off when only the line is missing', () => {
    const env = {
      TRAV_CHANNEL: 'imessage_relay',
      TRAV_RELAY_LIVE: '1',
      TRAV_RELAY_API_KEY: FAKE_KEY,
    };
    const config = resolveRelayConfig(env);
    expect(config).toMatchObject({ live: false, line: MOCK_RELAY_LINE });
    expect(config.reason).toBe('mock relay: TRAV_RELAY_LIVE=1 but TRAV_RELAY_LINE is not set');
    expect(describeRelayConfig(config, env)).toContain('TRAV_RELAY_LINE=unset');
  });
  for (const [name, env] of mockCases) {
    it(`mock relay: ${name}`, async () => {
      const { built, mock, sent, status } = await roundTrip(env);
      expect(built!.config).toMatchObject({ enabled: true, live: false, line: MOCK_RELAY_LINE });
      expect(built!.channel.info).toEqual({
        provider: `relay-${built!.config.vendor}`,
        mode: 'mock',
      });
      expect(sent!.ok).toBe(true);
      expect(status).toBe(200);
      expect(mock.sends()).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('live only with relay on, live=1, the key and the line: then (and only then) fetch is called, on the vendor origin', async () => {
    const env = {
      TRAV_CHANNEL: 'imessage_relay',
      TRAV_RELAY_LIVE: '1',
      TRAV_RELAY_API_KEY: FAKE_KEY,
      TRAV_RELAY_LINE: '+16175550199',
    };
    const clock = manualClock('2026-03-14T21:40:00+01:00');
    const mock = createMockRelay({ vendor: 'photon', clock });
    const built = createRelayFromEnv({
      env,
      clock,
      mockTransport: mock.transport,
      chats: [{ chatId: CHAT, participants: ['+16175550101'] }],
      sleep: async () => undefined,
      retry: { maxAttempts: 1 },
    })!;
    expect(built.config).toMatchObject({ live: true, line: '+16175550199' });
    expect(built.channel.info.mode).toBe('live');
    // The spy refuses, so this proves the call path without any network.
    const r = await built.channel.sendGroup(CHAT, groupMsg('hi'));
    expect(r.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.photon.codes/v1/messages');
    expect(init.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);
    expect(mock.requests()).toEqual([]);
    // Live with no webhook secret refuses every delivery.
    const hook = await mock.memberMessage({
      chat: { kind: 'group', chatId: CHAT },
      from: '+16175550101',
      text: 'x',
    });
    expect((await built.channel.handleWebhook(hook)).status).toBe(401);
  });

  it('the live transport refuses any URL off the vendor origin, and http origins', async () => {
    const f = vi.fn();
    const t = createLiveRelayTransport({ origin: 'https://api.sendblue.co', fetch: f });
    await expect(
      t({ method: 'POST', url: 'https://evil.example.test/api/send-message', headers: {} }),
    ).rejects.toThrow(/outside/);
    await expect(
      t({ method: 'POST', url: 'https://api.sendblue.co.evil.example.test/x', headers: {} }),
    ).rejects.toThrow(/outside/);
    expect(f).not.toHaveBeenCalled();
    expect(() => createLiveRelayTransport({ origin: 'http://api.sendblue.co', fetch: f })).toThrow(
      /https/,
    );
  });

  it('describes the config without printing any value', () => {
    const env = {
      TRAV_CHANNEL: 'imessage_relay',
      TRAV_RELAY_VENDOR: 'sendblue',
      TRAV_RELAY_API_KEY: FAKE_KEY,
      TRAV_RELAY_API_SECRET: FAKE_SECRET,
      TRAV_RELAY_WEBHOOK_SECRET: 'whsec-test',
    };
    const line = describeRelayConfig(resolveRelayConfig(env), env);
    expect(line).toContain('TRAV_RELAY_API_KEY=set');
    expect(line).toContain('TRAV_RELAY_API_SECRET=set');
    expect(line).not.toContain(FAKE_KEY);
    expect(line).not.toContain(FAKE_SECRET);
    expect(line).not.toContain('whsec-test');
    expect(() => resolveRelayConfig({ TRAV_RELAY_VENDOR: 'beeper' })).toThrow(
      /photon, sendblue or bluebubbles/,
    );
  });

  it('only config.ts may reference fetch in the relay channel and the mock relay', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const roots = [here, join(here, '..', '..', 'mock', 'relay')];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && name !== 'config.ts') {
          const src = readFileSync(p, 'utf8');
          if (
            /\bfetch\s*\(|globalThis\.fetch|node:https?['"]\s*;?\s*$|from 'node:https'|\bundici\b/m.test(
              src.replace(/^\s*(\*|\/\/).*$/gm, ''),
            )
          ) {
            offenders.push(p);
          }
        }
      }
    };
    for (const r of roots) walk(r);
    // http.ts imports node:http for the local receiver only (it never makes requests).
    expect(offenders.filter((p) => !p.endsWith('http.ts'))).toEqual([]);
    const httpSrc = readFileSync(join(here, 'http.ts'), 'utf8');
    expect(httpSrc).not.toMatch(/\brequest\s*\(|\bget\s*\(|fetch\s*\(/);
  });
});
