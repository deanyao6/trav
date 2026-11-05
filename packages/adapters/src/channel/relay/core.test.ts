/**
 * T-169: the vendor-neutral relay core over the mock relay, for both vendors:
 * webhook gatekeeping, dedupe, id mapping, rosters, untrusted media, the
 * text fallback, PNG QR codes, idempotent sends, retries with backoff.
 */
import { describe, expect, it, vi } from 'vitest';
import type { InboundEvent, InboundMessage, InboundReaction } from '../../interfaces/channel.js';
import { createMockRelay } from '../../mock/relay/index.js';
import type { MockRelay } from '../../mock/relay/index.js';
import { mockQrDataUrl } from '../../mock/tickets/qr.js';
import { textForChannel } from '../fallbackText.js';
import { withOutboundPacing } from '../pacing.js';
import {
  BCN_GROUP,
  PROPOSAL_ACTIONS,
  PROPOSAL_TEXT,
  dmMsg,
  groupMsg,
  manualClock,
  proposalCard,
  ticketCard,
} from '../testing.js';
import type { RelayChannel, RelayChannelOptions, RelayDiagnostic } from './core.js';
import { MAX_WEBHOOK_BYTES, createRelayChannel } from './core.js';
import { MOCK_RELAY_KEY, MOCK_RELAY_LINE, MOCK_RELAY_SECRET } from './config.js';
import { createMemoryMediaHost } from './media.js';
import type { RelayTransport, RelayVendorId } from './types.js';
import { relayVendor } from './vendors/index.js';

const NOW = '2026-03-14T21:40:00+01:00';
const CHAT = 'iMessage;+;chat640219872311';
const DEAN = '+16175550101';
const CHASE = '+16175550102';
const HENRY = '+16175550106';
const SAM = '+16175550107';
const CONTACTS = [
  { handle: 'h_dean', address: DEAN, displayName: 'Dean', memberId: 'mem_dean' },
  { handle: 'h_chase', address: CHASE, displayName: 'Chase', memberId: 'mem_chase' },
  { handle: 'h_henry', address: HENRY, displayName: 'Henry', memberId: 'mem_henry' },
];

interface Setup {
  readonly clock: ReturnType<typeof manualClock>;
  readonly mock: MockRelay;
  readonly relay: RelayChannel;
  readonly events: InboundEvent[];
  readonly diags: RelayDiagnostic[];
  readonly sleeps: number[];
  deliver(hook: { rawBody: string; headers: Readonly<Record<string, string>> }): Promise<number>;
}

function setup(vendorId: RelayVendorId, extra: Partial<RelayChannelOptions> = {}): Setup {
  const clock = manualClock(NOW);
  const media = createMemoryMediaHost();
  const mock = createMockRelay({
    vendor: vendorId,
    clock,
    media,
    chats: [{ chatId: CHAT, participants: [DEAN, CHASE, HENRY] }],
  });
  const events: InboundEvent[] = [];
  const diags: RelayDiagnostic[] = [];
  const sleeps: number[] = [];
  const relay = createRelayChannel({
    vendor: relayVendor(vendorId),
    transport: mock.transport,
    auth: { apiKey: MOCK_RELAY_KEY, apiSecret: MOCK_RELAY_KEY },
    webhookSecret: MOCK_RELAY_SECRET,
    line: MOCK_RELAY_LINE,
    clock,
    contacts: CONTACTS,
    chats: [{ chatId: CHAT, participants: [DEAN, CHASE, HENRY] }],
    media,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onDiagnostic: (d) => diags.push(d),
    ...extra,
  });
  relay.onEvent((e) => {
    events.push(e);
  });
  return {
    clock,
    mock,
    relay,
    events,
    diags,
    sleeps,
    async deliver(hook) {
      const out = await relay.handleWebhook(hook);
      await out.delivered;
      return out.status;
    },
  };
}

const group = { kind: 'group' as const, chatId: CHAT };

describe.each(['photon', 'sendblue'] as const)('relay core over the %s mock', (vendorId) => {
  it('maps a group message to an InboundMessage on the group lane, from the member handle', async () => {
    const t = setup(vendorId);
    const status = await t.deliver(
      await t.mock.memberMessage({
        chat: group,
        from: DEAN,
        text: '@trav hi',
        vendorMessageId: 'V1',
      }),
    );
    expect(status).toBe(200);
    expect(t.events).toEqual([
      {
        type: 'message',
        channel: 'imessage_relay',
        conversationId: CHAT,
        lane: 'group',
        receivedAt: t.clock.now(),
        messageId: 'V1',
        sender: 'h_dean',
        text: '@trav hi',
        attachments: [],
      },
    ]);
  });

  it('a DM arrives on the dm lane as dm:<handle>; an unknown number passes as its address', async () => {
    const t = setup(vendorId);
    await t.deliver(
      await t.mock.memberMessage({
        chat: { kind: 'dm', address: DEAN },
        from: DEAN,
        text: 'photos on',
      }),
    );
    await t.deliver(
      await t.mock.memberMessage({ chat: { kind: 'dm', address: SAM }, from: SAM, text: 'hello?' }),
    );
    const [a, b] = t.events as InboundMessage[];
    expect(a).toMatchObject({ lane: 'dm', conversationId: 'dm:h_dean', sender: 'h_dean' });
    expect(b).toMatchObject({ lane: 'dm', conversationId: `dm:${SAM}`, sender: SAM });
  });

  it('drops a redelivered webhook (same vendor id) and counts it', async () => {
    const t = setup(vendorId);
    const hook = await t.mock.memberMessage({
      chat: group,
      from: DEAN,
      text: 'yes',
      vendorMessageId: 'V2',
    });
    expect(await t.deliver(hook)).toBe(200);
    const again = await t.relay.handleWebhook(hook);
    await again.delivered;
    expect(again).toMatchObject({ status: 200, accepted: 0, duplicates: 1 });
    expect(t.events).toHaveLength(1);
    expect(t.relay.stats().duplicatesDropped).toBe(1);
  });

  it('refuses a bad signature (401), a non-JSON or foreign body (400) and an oversized one (413), delivering nothing', async () => {
    const t = setup(vendorId);
    const hook = await t.mock.memberMessage({ chat: group, from: DEAN, text: 'yes' });
    const forged = { rawBody: hook.rawBody.replace('yes', 'buy'), headers: hook.headers };
    const forgedOutcome = await t.relay.handleWebhook(forged);
    await forgedOutcome.delivered;
    const forgedStatus = forgedOutcome.status;
    // Sendblue's shared secret does not cover the body; Photon's HMAC does.
    expect(forgedStatus).toBe(vendorId === 'photon' ? 401 : 200);
    t.events.length = 0;
    expect((await t.relay.handleWebhook({ rawBody: hook.rawBody, headers: {} })).status).toBe(401);
    const signedJunk =
      vendorId === 'photon' ? undefined : { rawBody: 'not json', headers: hook.headers };
    if (signedJunk) expect((await t.relay.handleWebhook(signedJunk)).status).toBe(400);
    if (vendorId === 'sendblue') {
      expect(
        (await t.relay.handleWebhook({ rawBody: '{"x":1}', headers: hook.headers })).status,
      ).toBe(400);
    }
    const big = { rawBody: 'x'.repeat(MAX_WEBHOOK_BYTES + 1), headers: hook.headers };
    expect((await t.relay.handleWebhook(big)).status).toBe(413);
    expect(t.events).toEqual([]);
    expect(t.relay.stats().webhooksRejected).toBeGreaterThanOrEqual(2);
  });

  it('an empty webhook secret refuses every delivery (fail closed)', async () => {
    const t = setup(vendorId, { webhookSecret: '' });
    const hook = await t.mock.memberMessage({ chat: group, from: DEAN, text: 'yes' });
    expect((await t.relay.handleWebhook(hook)).status).toBe(401);
    expect(t.events).toEqual([]);
  });

  it('a 👍 tapback on a Trav message points at the Trav message id the agent sent', async () => {
    const t = setup(vendorId);
    const card = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    const sent = await t.relay.sendGroup(CHAT, card);
    expect(sent.ok).toBe(true);
    const vendorId0 = t.relay.vendorIdsOf(card.id)[0]!;
    expect(vendorId0).not.toBe(card.id);
    await t.deliver(
      t.mock.memberTapback({ chat: group, from: DEAN, targetVendorId: vendorId0, tapback: 'like' }),
    );
    const r = t.events[0] as InboundReaction;
    expect(r).toMatchObject({
      type: 'reaction',
      sender: 'h_dean',
      targetMessageId: card.id,
      reaction: '👍',
      removed: false,
      conversationId: CHAT,
    });
    // Removing it is a removal on the same target.
    await t.deliver(
      t.mock.memberTapback({
        chat: group,
        from: DEAN,
        targetVendorId: vendorId0,
        tapback: 'like',
        removed: true,
      }),
    );
    expect(t.events[1]).toMatchObject({
      type: 'reaction',
      targetMessageId: card.id,
      removed: true,
    });
  });

  it('wire text is the fallback text: no buttons, 👍 instructions kept (tapbacks exist), card left out', async () => {
    const t = setup(vendorId);
    const card = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    const sent = await t.relay.sendGroup(CHAT, card);
    expect(sent).toMatchObject({ ok: true, value: { messageId: card.id, degraded: true } });
    const wire = t.mock.sends()[0]!;
    expect(wire.text).toBe(textForChannel(card, t.relay.capabilities));
    expect(wire.text).toMatch(/👍/u);
    expect(JSON.stringify(t.mock.requests()[0]!.body)).not.toMatch(/approve|cardId|actions/);
  });

  it('a ticket QR (SVG) goes out as a PNG on an https URL the vendor can fetch', async () => {
    const t = setup(vendorId);
    const msg = dmMsg('mem_dean', 'your razzmatazz ticket for tonight 🎟️', {
      card: ticketCard('mem_dean'),
      images: [{ url: mockQrDataUrl('TRAV-MOCK-TICKET|x'), alt: 'QR code' }],
    });
    expect((await t.relay.sendDirect('h_dean', msg)).ok).toBe(true);
    const wire = t.mock.sends()[0]!;
    expect(wire.chat).toEqual({ kind: 'dm', address: DEAN });
    expect(wire.media).toHaveLength(1);
    expect(wire.media[0]!.url).toMatch(
      /^https:\/\/media\.mock-relay\.invalid\/m\/[0-9a-f]{24}\.png$/,
    );
    const bytes = t.mock.media.resolve(wire.media[0]!.url)!.bytes;
    expect(Buffer.from(bytes).subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('refuses what the simulator refuses: DM-only card in the group, a ticket to the wrong member, unknown chats and handles', async () => {
    const t = setup(vendorId);
    const ticket = groupMsg('ticket', { card: ticketCard('mem_dean') });
    expect(await t.relay.sendGroup(CHAT, ticket)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    const wrong = dmMsg('mem_chase', 'ticket', { card: ticketCard('mem_dean') });
    expect(await t.relay.sendDirect('h_chase', wrong)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    const astray = dmMsg('mem_chase', 'hi');
    expect(await t.relay.sendDirect('h_dean', astray)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await t.relay.sendGroup('iMessage;+;chat-unknown', groupMsg('hi'))).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await t.relay.sendDirect('h_nobody', dmMsg('mem_x', 'hi'))).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await t.relay.sendGroup(CHAT, dmMsg('mem_dean', 'hi'))).toMatchObject({ ok: false });
    expect(t.mock.requests()).toEqual([]);
  });

  it('sends each Trav message id once: a resend and a concurrent resend reuse the first send', async () => {
    const t = setup(vendorId);
    const m = groupMsg('done ✅');
    const [a, b] = await Promise.all([t.relay.sendGroup(CHAT, m), t.relay.sendGroup(CHAT, m)]);
    const c = await t.relay.sendGroup(CHAT, m);
    expect(a).toEqual(b);
    expect(c).toEqual(a);
    expect(t.mock.sends()).toHaveLength(1);
    expect(
      await t.relay.sendDirect('h_dean', { ...m, to: { kind: 'member', memberId: 'mem_dean' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'duplicate' },
    });
  });

  it('retries a 429 after its Retry-After (capped) and succeeds', async () => {
    const t = setup(vendorId);
    t.mock.failNext({ kind: 'status', status: 429, retryAfterSeconds: 2 });
    const r = await t.relay.sendGroup(CHAT, groupMsg('hi'));
    expect(r.ok).toBe(true);
    expect(t.mock.requests()).toHaveLength(2);
    expect(t.mock.sends()).toHaveLength(1);
    expect(t.sleeps).toEqual([2000]);
    expect(t.relay.stats()).toMatchObject({ retries: 1, sendFailures: 0 });
  });

  it('a 400 is never retried and comes back as invalid_request', async () => {
    const t = setup(vendorId);
    t.mock.failNext({ kind: 'status', status: 400 });
    const r = await t.relay.sendGroup(CHAT, groupMsg('hi'));
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_request', retryable: false } });
    expect(t.mock.requests()).toHaveLength(1);
  });

  it('three 503s fail as provider_unavailable, still retryable (the pacing queue tries later)', async () => {
    const t = setup(vendorId);
    t.mock.failNext(
      { kind: 'status', status: 503 },
      { kind: 'status', status: 503 },
      { kind: 'status', status: 503 },
    );
    const r = await t.relay.sendGroup(CHAT, groupMsg('hi'));
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'provider_unavailable', retryable: true },
    });
    expect(t.mock.requests()).toHaveLength(3);
    expect(t.sleeps).toEqual([500, 1000]);
    // Nothing was recorded as sent, so the same id can go out later.
    expect((await t.relay.sendGroup(CHAT, { ...groupMsg('x'), id: 'later' })).ok).toBe(true);
  });

  it('a Trav 👍 on a member message is a tapback request; unknown targets are not_found', async () => {
    const t = setup(vendorId);
    await t.deliver(
      await t.mock.memberMessage({
        chat: group,
        from: DEAN,
        text: 'got the tickets?',
        vendorMessageId: 'V9',
      }),
    );
    const ok = await t.relay.react(CHAT, {
      id: 'rx1',
      groupId: BCN_GROUP,
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: 'V9',
      emoji: '👍',
    });
    expect(ok.ok).toBe(true);
    expect(t.mock.sends()[0]).toMatchObject({
      kind: 'reaction',
      targetVendorId: 'V9',
      tapback: 'like',
    });
    const missing = await t.relay.react(CHAT, {
      id: 'rx2',
      groupId: BCN_GROUP,
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: 'nope',
      emoji: '❤️',
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('keeps only https attachments from a webhook, then hands them to the media resolver', async () => {
    const resolved: string[] = [];
    const t = setup(vendorId, {
      resolveInboundMedia: async (a) => {
        resolved.push(a.uri);
        return { ...a, uri: 'fixtures/receipts/r1.jpg' };
      },
    });
    await t.deliver(
      await t.mock.memberMessage({
        chat: group,
        from: CHASE,
        text: 'receipt',
        attachments: [
          { kind: 'image', mimeType: 'image/jpeg', uri: 'https://cdn.example.test/a.jpg' },
        ],
      }),
    );
    const m = t.events[0] as InboundMessage;
    expect(resolved).toEqual(['https://cdn.example.test/a.jpg']);
    expect(m.attachments).toEqual([
      { kind: 'image', mimeType: 'image/jpeg', uri: 'fixtures/receipts/r1.jpg' },
    ]);
  });

  it('lists the roster with Trav, mapped to handles', async () => {
    const t = setup(vendorId);
    const r = await t.relay.listParticipants(CHAT);
    expect(r.ok && r.value.map((p) => p.handle)).toEqual(['h_dean', 'h_chase', 'h_henry', 'trav']);
    expect(r.ok && r.value.at(-1)).toEqual({ handle: 'trav', displayName: 'Trav', isTrav: true });
  });

  it('composes with the T-071 pacing decorator', async () => {
    const t = setup(vendorId);
    const paced = withOutboundPacing(t.relay, {
      clock: t.clock,
      ratioAllowance: 1,
      maxSendToReceiveRatio: 0,
    });
    expect((await paced.sendGroup(CHAT, groupMsg('one'))).ok).toBe(true);
    const second = await paced.sendGroup(CHAT, groupMsg('two'));
    expect(second).toMatchObject({ ok: true, value: { queued: true } });
    expect(t.mock.sends()).toHaveLength(1);
  });
});

describe('vendor-specific behaviour', () => {
  it('photon: participant webhooks become joins and leaves; Trav itself being added is flagged', async () => {
    const t = setup('photon');
    await t.deliver(t.mock.memberJoined({ chatId: CHAT, address: SAM, displayName: 'Sam' })!);
    await t.deliver(t.mock.memberJoined({ chatId: CHAT, address: MOCK_RELAY_LINE })!);
    await t.deliver(t.mock.memberLeft({ chatId: CHAT, address: SAM })!);
    expect(t.events.map((e) => e.type)).toEqual(['member_joined', 'member_joined', 'member_left']);
    expect(t.events[0]).toMatchObject({
      participant: { handle: SAM, displayName: 'Sam', isTrav: false },
    });
    expect(t.events[1]).toMatchObject({ participant: { handle: 'trav', isTrav: true } });
  });

  it('photon: an inline reply to a Trav message carries the Trav id', async () => {
    const t = setup('photon');
    const m = groupMsg('want me to grab them?');
    await t.relay.sendGroup(CHAT, m);
    await t.deliver(
      await t.mock.memberMessage({
        chat: group,
        from: DEAN,
        text: 'yes',
        replyToVendorId: t.relay.vendorIdsOf(m.id)[0]!,
      }),
    );
    expect(t.events[0]).toMatchObject({ type: 'message', text: 'yes', replyToMessageId: m.id });
  });

  it('photon: a reply whose answer was lost is retried under the same idempotency key and sent once', async () => {
    const t = setup('photon');
    t.mock.failNext({ kind: 'lost_reply' });
    const r = await t.relay.sendGroup(CHAT, groupMsg('hi'));
    expect(r.ok).toBe(true);
    expect(t.mock.requests()).toHaveLength(2);
    expect(t.mock.sends()).toHaveLength(1);
  });

  it('sendblue: a lost reply is NOT retried (no idempotency keys), so it can never double-send', async () => {
    const t = setup('sendblue');
    t.mock.failNext({ kind: 'lost_reply' });
    const r = await t.relay.sendGroup(CHAT, groupMsg('hi'));
    expect(r).toMatchObject({ ok: false, error: { code: 'provider_unavailable' } });
    expect(t.mock.requests()).toHaveLength(1);
    expect(t.mock.sends()).toHaveLength(1);
  });

  it('sendblue: one media_url per send, so two images are two sends, both mapped to the one Trav message', async () => {
    const t = setup('sendblue');
    const m = groupMsg('photos from last night', {
      images: [
        { url: 'https://album.example.test/bcn/1.jpg', alt: 'one' },
        { url: 'https://album.example.test/bcn/2.jpg', alt: 'two' },
      ],
    });
    expect((await t.relay.sendGroup(CHAT, m)).ok).toBe(true);
    const sends = t.mock.sends();
    expect(sends.map((s) => [s.text, s.media.map((x) => x.url)])).toEqual([
      ['photos from last night', ['https://album.example.test/bcn/1.jpg']],
      ['', ['https://album.example.test/bcn/2.jpg']],
    ]);
    expect(t.relay.vendorIdsOf(m.id)).toHaveLength(2);
    expect(t.relay.travIdOf(sends[1]!.vendorMessageId)).toBe(m.id);
  });

  it('sendblue: a changed participants list becomes joins/leaves before the message', async () => {
    const t = setup('sendblue');
    t.mock.memberJoined({ chatId: CHAT, address: SAM });
    t.mock.memberLeft({ chatId: CHAT, address: HENRY });
    await t.deliver(await t.mock.memberMessage({ chat: group, from: SAM, text: 'hiii' }));
    expect(t.events.map((e) => e.type)).toEqual(['member_joined', 'member_left', 'message']);
    expect(t.events[0]).toMatchObject({ participant: { handle: SAM } });
    expect(t.events[1]).toMatchObject({ participant: { handle: 'h_henry', displayName: 'Henry' } });
  });

  it('sendblue: the iOS text form of a tapback is a reaction on the one Trav message it quotes', async () => {
    const t = setup('sendblue');
    const card = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    await t.relay.sendGroup(CHAT, card);
    const target = t.relay.vendorIdsOf(card.id)[0]!;
    await t.deliver(
      t.mock.memberTapback({ chat: group, from: DEAN, targetVendorId: target, tapback: 'like' }),
    );
    expect(t.events[0]).toMatchObject({
      type: 'reaction',
      targetMessageId: card.id,
      reaction: '👍',
      sender: 'h_dean',
    });
  });

  it('sendblue: a truncated quote that fits two Trav messages stays plain text (never guesses a card)', async () => {
    const t = setup('sendblue');
    const long = 'x'.repeat(130);
    const a = groupMsg(`${long} A`);
    const b = groupMsg(`${long} B`);
    await t.relay.sendGroup(CHAT, a);
    await t.relay.sendGroup(CHAT, b);
    await t.deliver(
      t.mock.memberTapback({
        chat: group,
        from: DEAN,
        targetVendorId: t.relay.vendorIdsOf(a.id)[0]!,
        tapback: 'like',
      }),
    );
    expect(t.events[0]).toMatchObject({ type: 'message' });
    expect((t.events[0] as InboundMessage).text).toMatch(/^Liked “x+…”$/u);
  });

  it('no channel code path reads the wall clock or opens a socket (timestamps from the clock)', async () => {
    const t = setup('photon');
    const spy = vi.spyOn(globalThis, 'fetch');
    await t.deliver(await t.mock.memberMessage({ chat: group, from: DEAN, text: 'hi' }));
    await t.relay.sendGroup(CHAT, groupMsg('hey'));
    expect(spy).not.toHaveBeenCalled();
    expect(t.events[0]!.receivedAt).toBe(NOW);
    spy.mockRestore();
  });
});

describe('review round 2', () => {
  it('flaw 1: a Sendblue 500 that was delivered is final above the core: a pacing queue never posts it twice', async () => {
    // The vendor processed the send, then answered 500 (Sendblue has no
    // idempotency keys, so a retry would be a second text).
    const wire: { inner?: RelayTransport } = {};
    let fiveHundredNext = false;
    const t = setup('sendblue', {
      transport: async (request) => {
        const res = await wire.inner!(request);
        if (!fiveHundredNext) return res;
        fiveHundredNext = false;
        return { status: 500, headers: {}, body: { status: 'ERROR' } };
      },
    });
    wire.inner = t.mock.transport;
    const paced = withOutboundPacing(t.relay, {
      clock: t.clock,
      maxSendsPerDay: 1,
      criticalReserve: 0,
      retryBackoffMs: 1_000,
    });
    expect((await paced.sendGroup(CHAT, groupMsg('one'))).ok).toBe(true);
    const two = groupMsg('two');
    expect(await paced.sendGroup(CHAT, two)).toMatchObject({ ok: true, value: { queued: true } });
    fiveHundredNext = true;
    t.clock.advanceHours(25);
    await paced.tick();
    t.clock.advanceHours(1);
    await paced.tick();
    t.clock.advanceHours(25);
    await paced.tick();
    expect(t.mock.sends().filter((s) => s.text === 'two')).toHaveLength(1);
    expect(paced.queue()).toEqual([]);
    expect(paced.failures()).toEqual([
      expect.objectContaining({ messageId: two.id, reason: 'send_failed' }),
    ]);
  });

  it('flaw 1: the core reports retryable only for retry-safe statuses', async () => {
    const sb = setup('sendblue');
    sb.mock.failNext({ kind: 'status', status: 500 });
    expect(await sb.relay.sendGroup(CHAT, groupMsg('a'))).toMatchObject({
      ok: false,
      error: { retryable: false },
    });
    sb.mock.failNext({ kind: 'network' });
    expect(await sb.relay.sendGroup(CHAT, groupMsg('b'))).toMatchObject({
      ok: false,
      error: { retryable: false },
    });
    sb.mock.failNext({ kind: 'lost_reply' });
    expect(await sb.relay.sendGroup(CHAT, groupMsg('c'))).toMatchObject({
      ok: false,
      error: { retryable: false },
    });
    // Photon carries idempotency keys, so a 500 stays safe to retry later.
    const ph = setup('photon', { retry: { maxAttempts: 1 } });
    ph.mock.failNext({ kind: 'status', status: 500 });
    expect(await ph.relay.sendGroup(CHAT, groupMsg('d'))).toMatchObject({
      ok: false,
      error: { retryable: true },
    });
  });

  for (const vendorId of ['photon', 'sendblue'] as const) {
    it(`flaw 2 (${vendorId}): a DM goes only to a known contact bound to that member`, async () => {
      const t = setup(vendorId, {
        contacts: [...CONTACTS, { handle: 'h_sam', address: SAM, displayName: 'Sam' }],
      });
      const ticket = (): ReturnType<typeof dmMsg> =>
        dmMsg('mem_dean', 'your razzmatazz ticket for tonight 🎟️', {
          card: ticketCard('mem_dean'),
        });
      // A phone-number-shaped handle with no contact entry.
      expect(await t.relay.sendDirect('+16175550199', ticket())).toMatchObject({
        ok: false,
        error: { code: 'not_found', message: 'unknown handle +16175550199' },
      });
      // Dean's raw address is not his handle either.
      expect(await t.relay.sendDirect(DEAN, ticket())).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      expect(await t.relay.sendDirect('dean@example.test', dmMsg('mem_dean', 'hi'))).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      // A contact with no member binding can't prove ownership.
      expect(await t.relay.sendDirect('h_sam', dmMsg('mem_sam', 'hi'))).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
      expect(t.mock.requests()).toEqual([]);
      // The bound contact still gets it.
      expect((await t.relay.sendDirect('h_dean', ticket())).ok).toBe(true);
      expect(t.mock.sends()).toHaveLength(1);
    });
  }

  it('flaw 4: a short truncated quote is never a tapback on a booking card (sendblue)', async () => {
    const t = setup('sendblue');
    const card = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    await t.relay.sendGroup(CHAT, card);
    const wire = t.mock.sends()[0]!.text;
    // "razzmatazz tonight, 5 tickets…": 1 and 19 characters are too short.
    expect(wire.slice(0, 19)).toBe('razzmatazz tonight,');
    for (const text of [`Liked “${wire.slice(0, 1)}…”`, `Liked “${wire.slice(0, 19)}…”`]) {
      await t.deliver(await t.mock.memberMessage({ chat: group, from: DEAN, text }));
    }
    expect(t.events.map((e) => e.type)).toEqual(['message', 'message']);
    // 20 characters or more still matches by prefix.
    await t.deliver(
      await t.mock.memberMessage({
        chat: group,
        from: DEAN,
        text: `Liked “${wire.slice(0, 21)}…”`,
      }),
    );
    expect(t.events[2]).toMatchObject({
      type: 'reaction',
      targetMessageId: card.id,
      reaction: '👍',
    });
  });

  it('flaw 4: photon has structured tapbacks, so `Liked “…”` text is a tapback only on SMS/MMS', async () => {
    const t = setup('photon');
    const card = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    await t.relay.sendGroup(CHAT, card);
    const text = `Liked “${t.mock.sends()[0]!.text}”`;
    await t.deliver(await t.mock.memberMessage({ chat: group, from: DEAN, text }));
    expect(t.events[0]).toMatchObject({ type: 'message', text });
    await t.deliver(await t.mock.memberMessage({ chat: group, from: DEAN, text, service: 'SMS' }));
    expect(t.events[1]).toMatchObject({
      type: 'reaction',
      targetMessageId: card.id,
      reaction: '👍',
    });
  });
});
