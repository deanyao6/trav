/**
 * T-169 contract tests: each vendor module against the recorded payloads in
 * `fixtures/relay/<vendor>/` (webhook bodies, send requests, send replies),
 * the signature schemes computed independently here, and the mock relay
 * accepting exactly the requests the client builds.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../mock/fixtures.js';
import { createMockRelay } from '../../mock/relay/index.js';
import { manualClock } from '../testing.js';
import type { RelayAuth, RelayHttpResponse, RelaySend, RelayVendorId } from './types.js';
import { RelayPayloadError } from './types.js';
import { relayVendor } from './vendors/index.js';

interface WebhookFixture {
  readonly line: string;
  readonly cases: readonly { name: string; body: unknown; expect: unknown[] }[];
  readonly malformed: readonly { name: string; body: unknown }[];
}
interface SendsFixture {
  readonly line: string;
  readonly auth: RelayAuth;
  readonly requests: readonly { name: string; send: RelaySend; request: unknown }[];
  readonly responses: readonly { name: string; response: RelayHttpResponse; expect: unknown }[];
}

const VENDORS: readonly RelayVendorId[] = ['photon', 'sendblue'];
const SECRET = 'whsec_fixture_not_a_real_secret';
const NOW = '2026-03-14T21:40:05+01:00';

function signed(vendor: RelayVendorId, rawBody: string, nowMs: number, secret = SECRET) {
  if (vendor === 'photon') {
    const t = Math.floor(nowMs / 1000);
    const v1 = createHmac('sha256', secret)
      .update(`${String(t)}.${rawBody}`)
      .digest('hex');
    return { 'x-photon-signature': `t=${String(t)},v1=${v1}` };
  }
  return { 'sb-signing-secret': secret };
}

describe.each(VENDORS)('%s contract (recorded fixtures)', (vendorId) => {
  const vendor = relayVendor(vendorId);
  const hooks = loadFixture(['relay', vendorId], 'webhooks') as WebhookFixture;
  const sends = loadFixture(['relay', vendorId], 'sends') as SendsFixture;

  it('has fixtures for messages, images, DMs, echoes, untrusted content and malformed bodies', () => {
    expect(hooks.cases.length).toBeGreaterThanOrEqual(6);
    expect(hooks.malformed.length).toBeGreaterThanOrEqual(2);
    expect(sends.requests.length).toBeGreaterThanOrEqual(3);
  });

  for (const c of hooks.cases) {
    it(`parses webhook: ${c.name}`, () => {
      expect(vendor.parseWebhook(c.body)).toEqual(c.expect);
    });
  }

  for (const c of hooks.malformed) {
    it(`refuses malformed webhook: ${c.name}`, () => {
      expect(() => vendor.parseWebhook(c.body)).toThrow(RelayPayloadError);
    });
  }

  for (const c of sends.requests) {
    it(`builds the recorded request: ${c.name}`, () => {
      expect(vendor.buildSend(c.send, sends.auth, sends.line)).toEqual(c.request);
    });
  }

  for (const c of sends.responses) {
    it(`reads the recorded reply: ${c.name}`, () => {
      expect(vendor.parseSendResponse(c.response)).toEqual(c.expect);
    });
  }

  it('verifies its signature scheme on the raw bytes, and nothing else', () => {
    const clock = manualClock(NOW);
    const raw = JSON.stringify(hooks.cases[0]!.body);
    const ok = { rawBody: raw, secret: SECRET, nowMs: clock.nowMs() };
    expect(vendor.verifyWebhook({ ...ok, headers: signed(vendorId, raw, clock.nowMs()) })).toBe(
      true,
    );
    // Wrong secret, missing header, empty configured secret.
    expect(
      vendor.verifyWebhook({ ...ok, headers: signed(vendorId, raw, clock.nowMs(), 'nope') }),
    ).toBe(false);
    expect(vendor.verifyWebhook({ ...ok, headers: {} })).toBe(false);
    expect(
      vendor.verifyWebhook({
        ...ok,
        secret: '',
        headers: signed(vendorId, raw, clock.nowMs(), ''),
      }),
    ).toBe(false);
    if (vendorId === 'photon') {
      // The HMAC covers the body: one changed byte fails.
      const headers = signed(vendorId, raw, clock.nowMs());
      expect(vendor.verifyWebhook({ ...ok, rawBody: raw.replace('5', '6'), headers })).toBe(false);
      // A delivery replayed 6 minutes later fails; 4 minutes passes.
      expect(vendor.verifyWebhook({ ...ok, nowMs: clock.nowMs() + 6 * 60_000, headers })).toBe(
        false,
      );
      expect(vendor.verifyWebhook({ ...ok, nowMs: clock.nowMs() + 4 * 60_000, headers })).toBe(
        true,
      );
      // Garbage in the header never throws.
      expect(
        vendor.verifyWebhook({ ...ok, headers: { 'x-photon-signature': 't=abc,v1=zz' } }),
      ).toBe(false);
    }
  });

  it('the mock relay accepts every request the client builds, and its webhooks parse', async () => {
    const clock = manualClock(NOW);
    const groupChat = (
      sends.requests.find((r) => r.send.chat.kind === 'group')!.send.chat as {
        chatId: string;
      }
    ).chatId;
    const mock = createMockRelay({
      vendor: vendorId,
      clock,
      line: sends.line,
      apiKey: sends.auth.apiKey,
      ...(sends.auth.apiSecret !== undefined ? { apiSecret: sends.auth.apiSecret } : {}),
      webhookSecret: SECRET,
      chats: [{ chatId: groupChat, participants: ['+16175550101', '+16175550102'] }],
    });
    // Reply and tapback targets must be messages the line saw.
    for (const r of sends.requests) {
      const target = r.send.kind === 'reaction' ? r.send.targetVendorId : r.send.replyToVendorId;
      if (target !== undefined) {
        await mock.memberMessage({
          chat: r.send.chat,
          from: '+16175550101',
          text: 'hi',
          vendorMessageId: target,
        });
      }
    }
    for (const r of sends.requests) {
      const res = await mock.transport(vendor.buildSend(r.send, sends.auth, sends.line));
      const outcome = vendor.parseSendResponse(res);
      expect(outcome.ok, `${r.name}: ${JSON.stringify(res.body)}`).toBe(true);
    }
    expect(mock.sends()).toHaveLength(sends.requests.length);
    // Wrong key: refused with 401 by the mirror.
    const wrong = await mock.transport(
      vendor.buildSend(
        sends.requests[0]!.send,
        { apiKey: 'wrong', apiSecret: 'wrong' },
        sends.line,
      ),
    );
    expect(wrong.status).toBe(401);
    // The mirror's member webhook verifies and parses with the client module.
    const hook = await mock.memberMessage({
      chat: { kind: 'group', chatId: groupChat },
      from: '+16175550102',
      text: 'yes',
    });
    expect(
      vendor.verifyWebhook({
        rawBody: hook.rawBody,
        headers: hook.headers,
        secret: SECRET,
        nowMs: clock.nowMs(),
      }),
    ).toBe(true);
    const parsed = vendor.parseWebhook(JSON.parse(hook.rawBody));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ kind: 'message', from: '+16175550102', text: 'yes' });
  });
});
