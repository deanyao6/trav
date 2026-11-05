/**
 * T-169: the simulator over the iMessage relay (`pnpm relay:dev`,
 * `pnpm demo:barcelona -- --relay`). The whole Barcelona demo plays over the
 * relay adapter and each vendor's mock relay: every member action is a signed
 * vendor webhook, every Trav send a vendor-shaped request to the mock, and
 * nothing leaves the process.
 */
import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createRelayWebhookServer, listenRelayWebhook, relayVendor } from '@trav/adapters';
import { createSimulatedClock } from '@trav/core';
import { runBarcelonaDemo } from '../demo/barcelona.js';
import { BARCELONA, toConversations } from './groups.js';
import { createRelaySessions, relayArgs } from './relay.js';

describe('relayArgs', () => {
  it('is off without --relay, photon by default, a named vendor with --relay=', () => {
    expect(relayArgs(['node', 'main.ts', '--dev'], {})).toBeUndefined();
    expect(relayArgs(['--relay'], {})).toEqual({ vendor: 'photon', view: 'overlay' });
    expect(relayArgs(['--relay'], { TRAV_RELAY_VENDOR: 'Sendblue' })).toEqual({
      vendor: 'sendblue',
      view: 'overlay',
    });
    expect(relayArgs(['--relay=sendblue', '--relay-view=phone'], {})).toEqual({
      vendor: 'sendblue',
      view: 'phone',
    });
    // `pnpm relay:dev -- --relay=sendblue`: the script's own `--relay` comes first.
    expect(relayArgs(['--dev', '--relay', '--relay=sendblue'], {})?.vendor).toBe('sendblue');
    expect(() => relayArgs(['--relay=bluebubbles'], {})).toThrow(/photon or sendblue/);
    expect(() => relayArgs(['--relay', '--relay-view=cards'], {})).toThrow(/phone or overlay/);
  });
});

describe.each(['photon', 'sendblue'] as const)(
  'Barcelona demo over the mock %s relay',
  (vendor) => {
    it('passes every check, with all traffic on the relay wire and none of it live', async () => {
      const sessions = createRelaySessions({ vendor });
      const result = await runBarcelonaDemo({ relay: sessions });
      const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.step}: ${c.name}`);
      expect(failed).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.checks.length).toBeGreaterThanOrEqual(30);
      expect(result.transcript).toContain(`mock ${vendor} relay`);

      const lb = sessions.current()!;
      expect(lb.relay.info).toEqual({ provider: `relay-${vendor}`, mode: 'mock' });
      expect(lb.relay.capabilities.buttons).toBe(false);
      const stats = lb.relay.stats();
      // Every member line, tapback and tap arrived as a signed webhook.
      expect(stats.webhooksAccepted).toBeGreaterThan(40);
      expect(stats.webhooksRejected).toBe(0);
      expect(stats.sendFailures).toBe(0);
      // Every Trav send went out as this vendor's request, to its API origin, through the mock.
      const origin = new URL(relayVendor(vendor).baseUrl).origin;
      const requests = lb.mock.requests();
      expect(requests.length).toBeGreaterThan(40);
      expect(requests.every((r) => new URL(r.url).origin === origin)).toBe(true);
      // The Razzmatazz QR codes went out as PNGs, one DM each, to the 5 only (Henry's sick).
      const razzDms = lb.mock
        .sends()
        .filter((s) => s.chat.kind === 'dm' && /razzmatazz ticket/i.test(s.text));
      const to = razzDms.map((s) => (s.chat.kind === 'dm' ? s.chat.address : ''));
      const five = ['h_dean', 'h_chase', 'h_piotr', 'h_arjun', 'h_crowley'].map(lb.addressOf);
      expect([...to].sort()).toEqual([...five].sort());
      expect(
        razzDms.every((s) => s.media.length === 1 && s.media[0]!.mimeType === 'image/png'),
      ).toBe(true);
      // T-071 pacing sat in front and lost nothing.
      expect(lb.paced).toBeDefined();
      expect(lb.paced!.failures()).toEqual([]);
      expect(lb.paced!.queue()).toEqual([]);
    }, 120_000);
  },
);

describe('relay:dev webhook receiver', () => {
  it('forwards a signed webhook to the current session over 127.0.0.1, and refuses before one exists', async () => {
    const sessions = createRelaySessions({ vendor: 'photon' });
    const server = createRelayWebhookServer({ target: sessions.webhookTarget });
    const port = await listenRelayWebhook(server, 0);
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    try {
      const post = (rawBody: string, headers: Record<string, string>) =>
        fetch(`http://127.0.0.1:${String(port)}/relay/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: rawBody,
        });
      expect((await post('{}', {})).status).toBe(400);

      const clock = createSimulatedClock('2026-03-14T21:39:30+01:00');
      const channel = sessions.channelFactory({
        clock,
        conversations: toConversations([BARCELONA]),
      });
      const seen: string[] = [];
      channel.onEvent((e) => {
        if (e.type === 'message') seen.push(`${e.sender}: ${e.text}`);
      });
      const lb = sessions.current()!;
      const hook = await lb.mock.memberMessage({
        chat: { kind: 'group', chatId: BARCELONA.conversationId },
        from: lb.addressOf('h_dean'),
        text: '@trav hi',
      });
      const ok = await post(hook.rawBody, hook.headers);
      expect(ok.status).toBe(200);
      // A redelivery is acknowledged and dropped.
      const again = await post(hook.rawBody, hook.headers);
      expect(await again.json()).toMatchObject({ ok: true, accepted: 0, duplicates: 1 });
      // A tampered body fails the signature check.
      const forged = await post(hook.rawBody.replace('@trav hi', '@trav buy'), hook.headers);
      expect(forged.status).toBe(401);
      await new Promise((r) => setTimeout(r, 10));
      expect(seen).toEqual(['h_dean: @trav hi']);
    } finally {
      server.close();
    }
  });

  it('never builds a live transport, whatever the environment says', () => {
    const sessions = createRelaySessions({ vendor: 'sendblue' });
    const before = { ...process.env };
    process.env['TRAV_RELAY_LIVE'] = '1';
    process.env['TRAV_RELAY_API_KEY'] = 'not-a-real-key';
    process.env['TRAV_RELAY_API_SECRET'] = 'not-a-real-secret';
    try {
      sessions.channelFactory({
        clock: createSimulatedClock('2026-03-14T21:39:30+01:00'),
        conversations: toConversations([BARCELONA]),
      });
      expect(sessions.current()!.relay.info.mode).toBe('mock');
    } finally {
      for (const k of ['TRAV_RELAY_LIVE', 'TRAV_RELAY_API_KEY', 'TRAV_RELAY_API_SECRET']) {
        if (before[k] === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = before[k];
      }
    }
  });
});
