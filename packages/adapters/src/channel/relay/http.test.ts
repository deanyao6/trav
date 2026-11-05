/**
 * T-169: the webhook receiver, driven with fake requests (the build sandbox
 * refuses listen(), and tests must not leave servers running).
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createMockRelay } from '../../mock/relay/index.js';
import { manualClock } from '../testing.js';
import { MOCK_RELAY_KEY, MOCK_RELAY_LINE, MOCK_RELAY_SECRET } from './config.js';
import { createRelayChannel } from './core.js';
import type { InboundEvent } from '../../interfaces/channel.js';
import {
  DEFAULT_WEBHOOK_PATH,
  RELAY_HOST,
  createRelayWebhookHandler,
  listenRelayWebhook,
} from './http.js';
import { relayVendor } from './vendors/index.js';

const CHAT = 'iMessage;+;chat1';

function fakeReq(opts: {
  method?: string;
  url?: string;
  host?: string;
  body?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const stream = Readable.from(
    opts.body !== undefined ? [Buffer.from(opts.body)] : [],
  ) as unknown as IncomingMessage;
  Object.assign(stream, {
    method: opts.method ?? 'POST',
    url: opts.url ?? DEFAULT_WEBHOOK_PATH,
    headers: { host: opts.host ?? '127.0.0.1:5181', ...(opts.headers ?? {}) },
  });
  return stream;
}

function fakeRes(): ServerResponse & { status(): number; json(): Record<string, unknown> } {
  let body = '';
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      res.headersSent = true;
    },
    status: () => res.statusCode,
    json: () => JSON.parse(body) as Record<string, unknown>,
  };
  return res as unknown as ServerResponse & { status(): number; json(): Record<string, unknown> };
}

function setup() {
  const clock = manualClock('2026-03-14T21:40:00+01:00');
  const mock = createMockRelay({
    vendor: 'photon',
    clock,
    chats: [{ chatId: CHAT, participants: ['+16175550101'] }],
  });
  const relay = createRelayChannel({
    vendor: relayVendor('photon'),
    transport: mock.transport,
    auth: { apiKey: MOCK_RELAY_KEY },
    webhookSecret: MOCK_RELAY_SECRET,
    line: MOCK_RELAY_LINE,
    clock,
    chats: [{ chatId: CHAT, participants: ['+16175550101'] }],
  });
  const events: InboundEvent[] = [];
  relay.onEvent((e) => {
    events.push(e);
  });
  return { mock, relay, events, handler: createRelayWebhookHandler({ target: relay }) };
}

describe('relay webhook receiver (T-169)', () => {
  it('accepts a signed POST, answers 200, and the event reaches the channel', async () => {
    const t = setup();
    const hook = await t.mock.memberMessage({
      chat: { kind: 'group', chatId: CHAT },
      from: '+16175550101',
      text: 'hi',
    });
    const res = fakeRes();
    await t.handler(fakeReq({ body: hook.rawBody, headers: hook.headers }), res);
    expect(res.status()).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, accepted: 1, duplicates: 0 });
    await new Promise((r) => setImmediate(r));
    expect(t.events).toHaveLength(1);
  });

  it('401 on a bad signature, 404 on another path, 405 on GET, 403 on a non-loopback Host, 413 when too big', async () => {
    const t = setup();
    const hook = await t.mock.memberMessage({
      chat: { kind: 'group', chatId: CHAT },
      from: '+16175550101',
      text: 'hi',
    });
    const cases: [Parameters<typeof fakeReq>[0], number][] = [
      [{ body: hook.rawBody, headers: { 'x-photon-signature': 't=1,v1=' + '0'.repeat(64) } }, 401],
      [{ url: '/other', body: hook.rawBody, headers: hook.headers }, 404],
      [{ method: 'GET' }, 405],
      [{ host: 'evil.example.test', body: hook.rawBody, headers: hook.headers }, 403],
      [{ host: '127.0.0.1.evil.example.test', body: hook.rawBody, headers: hook.headers }, 403],
      [{ body: 'x'.repeat(1_000_001), headers: hook.headers }, 413],
    ];
    for (const [req, status] of cases) {
      const res = fakeRes();
      await t.handler(fakeReq(req), res);
      expect(res.status(), JSON.stringify(req).slice(0, 80)).toBe(status);
    }
    const health = fakeRes();
    await t.handler(fakeReq({ method: 'GET', url: '/healthz' }), health);
    expect(health.status()).toBe(200);
    expect(t.events).toEqual([]);
  });

  it('binds 127.0.0.1 only', async () => {
    const calls: unknown[][] = [];
    const server = {
      once() {
        return server;
      },
      listen(...args: unknown[]) {
        calls.push(args);
        (args[2] as () => void)();
        return server;
      },
      address: () => ({ port: 5181, address: RELAY_HOST, family: 'IPv4' }),
    } as unknown as Server;
    expect(await listenRelayWebhook(server, 5181)).toBe(5181);
    expect(calls[0]!.slice(0, 2)).toEqual([5181, '127.0.0.1']);
    await expect(listenRelayWebhook(server, 5181, '0.0.0.0')).rejects.toThrow(/127\.0\.0\.1 only/);
    expect(calls).toHaveLength(1);
  });
});
