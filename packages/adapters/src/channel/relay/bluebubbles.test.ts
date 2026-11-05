/**
 * T-187: the BlueBubbles vendor module, "@trav" detection for every relay
 * vendor, persisted dedupe, and the live wire path against a fake
 * BlueBubbles HTTP server (a fake `fetch` that serializes each request the
 * way the network would and decodes it the way the server would, so the
 * multipart upload is real; no socket, no real send).
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundEvent, InboundMessage } from '../../interfaces/channel.js';
import { createMockRelay } from '../../mock/relay/index.js';
import type { MockRelay } from '../../mock/relay/index.js';
import { mockQrDataUrl } from '../../mock/tickets/qr.js';
import {
  DEFAULT_CRITICAL_RESERVE,
  DEFAULT_MAX_SENDS_PER_DAY,
  withOutboundPacing,
} from '../pacing.js';
import { dmMsg, groupMsg, manualClock, ticketCard } from '../testing.js';
import type { RelayEnv } from './config.js';
import {
  MOCK_RELAY_KEY,
  MOCK_RELAY_LINE,
  MOCK_RELAY_SECRET,
  createLiveRelayTransport,
  createRelayFromEnv,
  describeRelayConfig,
  relayPacingDefaults,
  relayWireSends,
  resolveRelayConfig,
} from './config.js';
import type { RelayChannelOptions, RelayDiagnostic, RelaySeenStore } from './core.js';
import { RELAY_PART_TRIES, createMemorySeenStore, createRelayChannel } from './core.js';
import { DEFAULT_WEBHOOK_PATH, createRelayWebhookHandler } from './http.js';
import { prepareOutboundImages, createMemoryMediaHost } from './media.js';
import {
  REQUEST_WORDS,
  extraContactNames,
  mentionsContactName,
  parseContactNames,
} from './mention.js';
import type {
  RelayHttpRequest,
  RelayHttpResponse,
  RelayTransport,
  RelayVendorId,
} from './types.js';
import {
  BLUEBUBBLES_MAX_SENDS_PER_DAY,
  BLUEBUBBLES_MOCK_SERVER_URL,
  blueBubblesChatGuid,
  blueBubblesDmAddress,
  blueBubblesServerOrigin,
  bluebubblesVendor,
  createBlueBubblesVendor,
  relayVendor,
} from './vendors/index.js';

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
const group = { kind: 'group' as const, chatId: CHAT };

function setup(
  vendorId: RelayVendorId,
  extra: Partial<RelayChannelOptions> = {},
  mockExtra: { privateApi?: boolean; wrap?: (t: RelayTransport) => RelayTransport } = {},
) {
  const clock = manualClock(NOW);
  const media = createMemoryMediaHost();
  const chats = [{ chatId: CHAT, participants: [DEAN, CHASE, HENRY] }];
  const { wrap, ...mockOpts } = mockExtra;
  const mock = createMockRelay({ vendor: vendorId, clock, media, chats, ...mockOpts });
  const events: InboundEvent[] = [];
  const diags: RelayDiagnostic[] = [];
  const relay = createRelayChannel({
    vendor:
      vendorId === 'bluebubbles' && mockExtra.privateApi === false
        ? createBlueBubblesVendor({ serverUrl: BLUEBUBBLES_MOCK_SERVER_URL, privateApi: false })
        : relayVendor(vendorId),
    transport: wrap ? wrap(mock.transport) : mock.transport,
    auth: { apiKey: MOCK_RELAY_KEY, apiSecret: MOCK_RELAY_KEY },
    webhookSecret: MOCK_RELAY_SECRET,
    line: MOCK_RELAY_LINE,
    clock,
    contacts: CONTACTS,
    chats,
    media,
    sleep: async () => undefined,
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
    async deliver(hook: Parameters<typeof relay.handleWebhook>[0] | undefined): Promise<number> {
      if (hook === undefined) return 0;
      const out = await relay.handleWebhook(hook);
      await out.delivered;
      return out.status;
    },
  };
}

const lastMessage = (events: readonly InboundEvent[]): InboundMessage =>
  events.filter((e): e is InboundMessage => e.type === 'message').at(-1)!;

// ------------------------------------------------------------------ mention

describe('"@trav" on an iMessage line: contact names (mention.ts)', () => {
  it('parses TRAV_RELAY_CONTACT_NAME: trims, drops "trav" (the agent reads it), dedupes, caps length', () => {
    expect(parseContactNames(' Trav Bot, Travvy ,trav, ,@Trav Bot,TRAV')).toEqual([
      'Trav Bot',
      'Travvy',
    ]);
    expect(parseContactNames(undefined)).toEqual([]);
    expect(parseContactNames('x'.repeat(41))).toEqual([]);
    // A pasted name with a zero-width space and a bidi mark is the same name.
    expect(extraContactNames(['Trav​ Bot‏'])).toEqual(['Trav Bot']);
  });

  it.each([
    ['@Trav Bot split dinner', true],
    ['@trav bot split dinner', true],
    ['split dinner @Trav Bot', true],
    ['@Trav   Bot, split dinner', true],
    ['Trav Bot, split dinner', true],
    ['trav bot: what do I owe', true],
    ['Trav Bot!', true],
    ['Trav Bot?', true],
    ['Trav Bot', true],
    // r2: a quoted name is someone being quoted, not Trav being addressed.
    ['"Trav Bot, are we in?"', false],
    ['"Trav Bot," she said', false],
    ["'Trav Bot: hi'", false],
    // r2: the mention picker's usual output, name then a request (as "trav can you").
    ['Travvy can you book it', true],
    ['Trav Bot can you split dinner', true],
    ['Trav Bot pls log the taxi', true],
    ['Trav Bot what do I owe', true],
    ['Trav Bot is it booked', true],
    ['Trav Bot booked it already', false],
    ['Travvy, book it', true],
    ['ask Trav Bot later', false],
    ['Trav Bots are cool', false],
    ['@Trav Botany', false],
    ['me@Trav Bot', false],
    ['Trav Bot is asleep', false],
    ['', false],
  ])('%j → %s', (text, want) => {
    expect(mentionsContactName(text, ['Trav Bot', 'Travvy'])).toBe(want);
  });

  it('treats regex characters in a name literally, and no names means no extra mentions', () => {
    expect(mentionsContactName('@T.r+v (bot) hi', ['T.r+v (bot)'])).toBe(true);
    expect(mentionsContactName('@Tzrrv (bot) hi', ['T.r+v (bot)'])).toBe(false);
    expect(mentionsContactName('@Trav Bot hi', [])).toBe(false);
    expect(mentionsContactName('@trav hi', ['trav'])).toBe(false);
  });

  it("keeps REQUEST_WORDS in step with the agent's own mention rules", () => {
    const agentSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../agent/src/mention.ts'),
      'utf8',
    );
    const m = /const REQUEST_WORDS = String\.raw`([^`]*)`;/.exec(agentSrc);
    expect(m?.[1]).toBe(REQUEST_WORDS);
  });
});

describe.each(['photon', 'sendblue', 'bluebubbles'] as const)(
  '"@trav" detection over the %s relay',
  (vendorId) => {
    it('the saved contact name sets platformMention; plain "@trav" text passes through for the agent', async () => {
      const t = setup(vendorId, { travNames: ['Trav Bot'] });
      await t.deliver(
        await t.mock.memberMessage({ chat: group, from: DEAN, text: 'Trav Bot, split dinner' }),
      );
      expect(lastMessage(t.events)).toMatchObject({
        text: 'Trav Bot, split dinner',
        platformMention: true,
      });
      await t.deliver(
        await t.mock.memberMessage({ chat: group, from: DEAN, text: 'ask Trav Bot later' }),
      );
      expect(lastMessage(t.events).platformMention).toBeUndefined();
      await t.deliver(
        await t.mock.memberMessage({
          chat: group,
          from: CHASE,
          text: '@trav get the 5 of us tickets',
        }),
      );
      // The agent's mention rules read "@trav" and "trav," themselves (packages/agent/src/mention.ts).
      expect(lastMessage(t.events)).toMatchObject({ text: '@trav get the 5 of us tickets' });
      expect(lastMessage(t.events).platformMention).toBeUndefined();
    });

    it('without configured names, a contact name is just text', async () => {
      const t = setup(vendorId);
      await t.deliver(
        await t.mock.memberMessage({ chat: group, from: DEAN, text: 'Trav Bot, hi' }),
      );
      expect(lastMessage(t.events).platformMention).toBeUndefined();
    });
  },
);

// ---------------------------------------------------------- the BB module

describe('BlueBubbles module (T-187)', () => {
  it('accepts an https origin, or http on loopback only; never credentials, a path, or junk', () => {
    expect(blueBubblesServerOrigin('https://bb.example.test')).toBe('https://bb.example.test');
    expect(blueBubblesServerOrigin(' https://bb.example.test/ ')).toBe('https://bb.example.test');
    expect(blueBubblesServerOrigin('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
    expect(blueBubblesServerOrigin('http://localhost:1234')).toBe('http://localhost:1234');
    for (const bad of [
      'http://bb.example.test',
      'http://127.0.0.1.evil.test:1234',
      'https://user:pw@bb.example.test',
      'https://bb.example.test/api',
      'ftp://bb.example.test',
      'not a url',
    ]) {
      expect(() => blueBubblesServerOrigin(bad), bad).toThrow(/TRAV_BLUEBUBBLES_URL/);
      // The message never echoes the value (it may hold a password).
      try {
        blueBubblesServerOrigin(bad);
      } catch (e) {
        expect((e as Error).message).not.toContain('pw');
        expect((e as Error).message).not.toContain('evil');
      }
    }
  });

  it('addresses groups by chat GUID and DMs as iMessage;-;<address>', () => {
    expect(blueBubblesChatGuid(group)).toBe(CHAT);
    expect(blueBubblesChatGuid({ kind: 'dm', address: DEAN })).toBe(`iMessage;-;${DEAN}`);
    expect(blueBubblesDmAddress(`iMessage;-;${DEAN}`)).toBe(DEAN);
    expect(blueBubblesDmAddress(`SMS;-;${DEAN}`)).toBe(DEAN);
    expect(blueBubblesDmAddress(CHAT)).toBeUndefined();
  });

  it('without the Private API helper: AppleScript sends, no tapbacks out, no threads', async () => {
    const plain = createBlueBubblesVendor({ serverUrl: BLUEBUBBLES_MOCK_SERVER_URL });
    expect(plain.support).toMatchObject({ reactionsOut: false, inlineReplies: false });
    const req = plain.buildSend(
      {
        kind: 'message',
        chat: group,
        text: 'hi',
        media: [],
        replyToVendorId: 'X',
        idempotencyKey: 'k',
      },
      { apiKey: 'pw' },
      MOCK_RELAY_LINE,
    );
    expect(req.body).toEqual({
      chatGuid: CHAT,
      tempGuid: 'temp-k',
      message: 'hi',
      method: 'apple-script',
    });

    const t = setup('bluebubbles', {}, { privateApi: false });
    expect(t.relay.capabilities).toMatchObject({ reactions: false, threadedReplies: false });
    const card = groupMsg('2 options for flights');
    expect((await t.relay.sendGroup(CHAT, card)).ok).toBe(true);
    const r = await t.relay.react(CHAT, {
      id: 'rx1',
      targetMessageId: card.id,
      emoji: '👍',
    } as Parameters<typeof t.relay.react>[1]);
    expect(r).toMatchObject({ ok: false, error: { code: 'not_supported' } });
    // The mirror refuses a react call outright without the helper.
    expect(t.mock.sends().every((s) => s.kind === 'message')).toBe(true);
  });

  it('refuses an attachment send that carries text, two files, or no bytes (the core never builds one)', () => {
    const base = {
      kind: 'message' as const,
      chat: group,
      idempotencyKey: 'k',
    };
    const file = { url: 'upload:a.png', mimeType: 'image/png', fileName: 'a.png', base64: 'AA==' };
    const auth = { apiKey: 'pw' };
    expect(() =>
      bluebubblesVendor.buildSend({ ...base, text: 'hi', media: [file] }, auth, MOCK_RELAY_LINE),
    ).toThrow(/one uploaded file and no text/);
    expect(() =>
      bluebubblesVendor.buildSend(
        { ...base, text: '', media: [file, file] },
        auth,
        MOCK_RELAY_LINE,
      ),
    ).toThrow(/one uploaded file/);
    expect(() =>
      bluebubblesVendor.buildSend(
        { ...base, text: '', media: [{ url: 'https://x.test/a.png', mimeType: 'image/png' }] },
        auth,
        MOCK_RELAY_LINE,
      ),
    ).toThrow(/one uploaded file/);
  });

  it('a structured mention of the line sets platformMention; a mention of someone else does not', async () => {
    const t = setup('bluebubbles');
    await t.deliver(
      await t.mock.memberMessage({
        chat: group,
        from: CHASE,
        text: 'Trav Bot what do I owe',
        mentions: [MOCK_RELAY_LINE],
      }),
    );
    expect(lastMessage(t.events)).toMatchObject({
      text: 'Trav Bot what do I owe',
      platformMention: true,
    });
    await t.deliver(
      await t.mock.memberMessage({
        chat: group,
        from: CHASE,
        text: 'Dean pay up',
        mentions: [DEAN],
      }),
    );
    expect(lastMessage(t.events).platformMention).toBeUndefined();
  });

  it('the webhook token is the only way in: wrong, missing, doubled or header-borne tokens get 401', async () => {
    const t = setup('bluebubbles');
    const hook = await t.mock.memberMessage({ chat: group, from: DEAN, text: 'yes' });
    expect(hook.query).toBe(`?token=${MOCK_RELAY_SECRET}`);
    for (const query of [undefined, '', '?token=nope', `?token=${MOCK_RELAY_SECRET}&token=x`]) {
      const { query: _q, ...rest } = hook;
      expect(await t.deliver({ ...rest, ...(query !== undefined ? { query } : {}) })).toBe(401);
    }
    expect(await t.deliver({ rawBody: hook.rawBody, headers: { token: MOCK_RELAY_SECRET } })).toBe(
      401,
    );
    expect(t.events).toEqual([]);
    expect(await t.deliver(hook)).toBe(200);
    expect(t.events).toHaveLength(1);
  });

  it('a member added shows up on the next group message (the server sends only a row id); a leaver at once', async () => {
    const t = setup('bluebubbles');
    expect(await t.deliver(t.mock.memberJoined({ chatId: CHAT, address: SAM }))).toBe(200);
    expect(t.events).toEqual([]);
    expect(t.diags.map((d) => d.detail)).toContain(
      'bluebubbles participant-added without an address',
    );
    await t.deliver(await t.mock.memberMessage({ chat: group, from: DEAN, text: 'welcome sam' }));
    expect(t.events.map((e) => e.type)).toEqual(['member_joined', 'message']);
    expect(t.events[0]).toMatchObject({ participant: { handle: SAM } });
    t.events.length = 0;
    await t.deliver(t.mock.memberLeft({ chatId: CHAT, address: HENRY }));
    expect(t.events).toMatchObject([{ type: 'member_left', participant: { handle: 'h_henry' } }]);
    t.events.length = 0;
    // No double leave from the next roster.
    await t.deliver(await t.mock.memberMessage({ chat: group, from: DEAN, text: 'bye henry' }));
    expect(t.events.map((e) => e.type)).toEqual(['message']);
    const r = await t.relay.listParticipants(CHAT);
    expect(r.ok && r.value.map((p) => p.handle).sort()).toEqual(
      [SAM, 'h_chase', 'h_dean', 'trav'].sort(),
    );
  });

  it('an https image is never fetched to upload it: skipped with a diagnostic, the text still goes', async () => {
    const t = setup('bluebubbles');
    const msg = groupMsg('the map', {
      images: [{ url: 'https://cdn.example.test/map.png', alt: 'map' }],
    });
    expect((await t.relay.sendGroup(CHAT, msg)).ok).toBe(true);
    expect(t.mock.sends()).toHaveLength(1);
    expect(t.mock.sends()[0]!.media).toEqual([]);
    expect(t.diags).toContainEqual({ type: 'image_skipped', detail: 'needs_upload' });
    const prepared = await prepareOutboundImages(
      [{ url: mockQrDataUrl('TRAV-MOCK-TICKET|y'), alt: 'QR' }],
      createMemoryMediaHost(),
      { upload: true },
    );
    expect(prepared.media[0]).toMatchObject({
      url: expect.stringMatching(/^upload:trav-[0-9a-f]{24}\.png$/),
      mimeType: 'image/png',
      base64: expect.any(String),
    });
  });
});

describe('BlueBubbles pacing (T-071)', () => {
  it('a self-hosted line gets a lower daily cap than a paid line; past it sends queue, never drop', async () => {
    expect(relayPacingDefaults('bluebubbles')).toMatchObject({
      maxSendsPerDay: BLUEBUBBLES_MAX_SENDS_PER_DAY,
    });
    expect(BLUEBUBBLES_MAX_SENDS_PER_DAY).toBeLessThan(DEFAULT_MAX_SENDS_PER_DAY);
    expect(relayPacingDefaults('photon').maxSendsPerDay).toBeUndefined();
    expect(relayPacingDefaults('sendblue').maxSendsPerDay).toBeUndefined();
    // r2 review #2: pacing's tries match the core's, so a split send ends degraded, never "never sent".
    for (const v of ['bluebubbles', 'photon', 'sendblue'] as const)
      expect(relayPacingDefaults(v).maxAttempts).toBe(RELAY_PART_TRIES);
    const t = setup('bluebubbles');
    const paced = withOutboundPacing(t.relay, {
      clock: t.clock,
      ...relayPacingDefaults('bluebubbles'),
      ratioAllowance: 10_000,
    });
    const open = BLUEBUBBLES_MAX_SENDS_PER_DAY - DEFAULT_CRITICAL_RESERVE;
    for (let i = 0; i < open; i += 1) {
      const r = await paced.sendGroup(CHAT, groupMsg(`update ${String(i)}`));
      expect(r.ok && !('queued' in r.value && r.value.queued === true)).toBe(true);
    }
    expect(t.mock.sends()).toHaveLength(open);
    const over = await paced.sendGroup(CHAT, groupMsg('one too many'));
    expect(over).toMatchObject({ ok: true, value: { queued: true } });
    expect(t.mock.sends()).toHaveLength(open);
  });

  it('r2: the cap counts wire sends: a BlueBubbles ticket DM (text, then its QR) costs 2', async () => {
    const qr = { url: mockQrDataUrl('TRAV-MOCK-TICKET|w'), alt: 'QR code' };
    const ticketDm = (id: string) =>
      dmMsg('mem_dean', 'your razzmatazz ticket 🎟️', {
        id,
        card: ticketCard('mem_dean'),
        images: [qr],
      });
    const bb = relayVendor('bluebubbles').support;
    expect(relayWireSends(bb, ticketDm('a'))).toBe(2);
    expect(relayWireSends(bb, groupMsg('hi'))).toBe(1);
    expect(relayWireSends(bb, groupMsg('', { images: [qr, qr] }))).toBe(2);
    expect(relayWireSends(relayVendor('photon').support, ticketDm('a'))).toBe(1);
    expect(
      relayWireSends(relayVendor('sendblue').support, groupMsg('x', { images: [qr, qr] })),
    ).toBe(2);

    const t = setup('bluebubbles');
    const paced = withOutboundPacing(t.relay, {
      clock: t.clock,
      ...relayPacingDefaults('bluebubbles'),
      maxSendsPerDay: 3,
      criticalReserve: 0,
      ratioAllowance: 100,
    });
    expect((await paced.sendDirect('h_dean', ticketDm('t1'))).ok).toBe(true);
    expect(t.mock.sends()).toHaveLength(2);
    expect(paced.stats().sentInDay).toBe(2);
    // A second ticket (2 more) would pass 3: it waits; one plain text still fits.
    const second = await paced.sendDirect('h_dean', ticketDm('t2'));
    expect(second).toMatchObject({ ok: true, value: { queued: true } });
    expect(t.mock.sends()).toHaveLength(2);
  });
});

// ------------------------------------------- r2: a QR upload that fails

describe('QR upload fails after the text (BlueBubbles sends them separately)', () => {
  const ticketDm = () =>
    dmMsg('mem_dean', 'your razzmatazz ticket for tonight 🎟️', {
      card: ticketCard('mem_dean'),
      images: [{ url: mockQrDataUrl('TRAV-MOCK-TICKET|dean'), alt: 'QR code' }],
    });
  /** Uploads answer `status` for the first `times` tries; texts always go through. */
  const failingUploads = (status: number, times: number) => {
    let left = times;
    const calls = { uploads: 0, texts: 0 };
    const wrap =
      (inner: RelayTransport): RelayTransport =>
      async (req) => {
        if (req.form !== undefined) {
          calls.uploads += 1;
          if (left > 0) {
            left -= 1;
            return { status, body: { status, message: 'Server Error' } };
          }
        } else {
          calls.texts += 1;
        }
        return inner(req);
      };
    return { wrap, calls };
  };

  it('is a retryable failure, not a silent success; a resend sends only the QR, never the text again', async () => {
    const f = failingUploads(500, 3);
    const t = setup('bluebubbles', {}, { wrap: f.wrap });
    const msg = ticketDm();
    const first = await t.relay.sendDirect('h_dean', msg);
    expect(first).toMatchObject({ ok: false, error: { retryable: true } });
    expect(t.mock.sends().map((s) => s.media.length)).toEqual([0]); // the text only
    // A duplicate QR is harmless, so the core retried the upload itself (3 tries).
    expect(f.calls.uploads).toBe(3);
    const second = await t.relay.sendDirect('h_dean', msg);
    expect(second.ok).toBe(true);
    expect(f.calls.texts).toBe(1);
    expect(t.mock.sends().map((s) => s.media.length)).toEqual([0, 1]);
    if (second.ok) expect(second.value.missingImages).toBeUndefined();
    expect(t.relay.vendorIdsOf(msg.id)).toHaveLength(2);
  });

  it('through T-071 pacing: the caller hears "queued" and the QR follows on the retry', async () => {
    const f = failingUploads(500, 3);
    const t = setup('bluebubbles', {}, { wrap: f.wrap });
    const paced = withOutboundPacing(t.relay, {
      clock: t.clock,
      ...relayPacingDefaults('bluebubbles'),
      ratioAllowance: 100,
    });
    const msg = ticketDm();
    const r = await paced.sendDirect('h_dean', msg);
    expect(r).toMatchObject({ ok: true, value: { queued: true } });
    expect(t.mock.sends()).toHaveLength(1);
    t.clock.advanceMinutes(1);
    await paced.tick();
    expect(t.mock.sends().map((s) => s.media.length)).toEqual([0, 1]);
    expect(f.calls.texts).toBe(1);
    expect(paced.failures()).toEqual([]);
    expect(paced.queue()).toEqual([]);
  });

  it(`after ${String(RELAY_PART_TRIES)} tries, or on a permanent refusal, it is sent but degraded with the missing count`, async () => {
    const f = failingUploads(500, 99);
    const t = setup('bluebubbles', {}, { wrap: f.wrap });
    const msg = ticketDm();
    for (let i = 1; i < RELAY_PART_TRIES; i += 1) {
      expect((await t.relay.sendDirect('h_dean', msg)).ok).toBe(false);
    }
    const last = await t.relay.sendDirect('h_dean', msg);
    expect(last).toMatchObject({ ok: true, value: { degraded: true, missingImages: 1 } });
    expect(f.calls.texts).toBe(1);
    expect(t.diags).toContainEqual({ type: 'image_skipped', detail: 'send_failed' });

    const p = failingUploads(400, 99);
    const u = setup('bluebubbles', {}, { wrap: p.wrap });
    const once = await u.relay.sendDirect('h_dean', ticketDm());
    expect(once).toMatchObject({ ok: true, value: { degraded: true, missingImages: 1 } });
    expect(p.calls.uploads).toBe(1); // a 400 is final at once
  });
});

// --------------------------------------- r2: chat GUIDs, attachment guids, tokens

describe('BlueBubbles payload hardening (r2)', () => {
  const row = (o: Record<string, unknown>) => ({
    type: 'new-message',
    data: {
      guid: 'B10EB0B5-6F1A-4A00-8000-00000000F001',
      text: 'hi',
      handle: { address: DEAN },
      isFromMe: false,
      itemType: 0,
      chats: [{ guid: CHAT, style: 43 }],
      ...o,
    },
  });

  it("trusts the GUID's own marker over style: a ;-; chat is a DM even with style 43, a ;+; chat a group", () => {
    const dm = bluebubblesVendor.parseWebhook(
      row({ chats: [{ guid: `iMessage;-;${DEAN}`, style: 43 }] }),
    );
    expect(dm[0]).toMatchObject({ kind: 'message', chat: { kind: 'dm', address: DEAN } });
    const grp = bluebubblesVendor.parseWebhook(row({ chats: [{ guid: CHAT, style: 45 }] }));
    expect(grp[0]).toMatchObject({ kind: 'message', chat: { kind: 'group', chatId: CHAT } });
    expect(() =>
      bluebubblesVendor.parseWebhook(row({ chats: [{ guid: 'weird-guid', style: 45 }] })),
    ).toThrow(/neither a group nor a one-to-one/);
  });

  it("drops a DM row whose sender isn't that chat's member (no answering one person's thread on another's word)", () => {
    const spoofed = bluebubblesVendor.parseWebhook(
      row({ handle: { address: CHASE }, chats: [{ guid: `iMessage;-;${DEAN}`, style: 45 }] }),
    );
    expect(spoofed).toEqual([
      { kind: 'ignored', reason: 'bluebubbles dm sender does not match the chat' },
    ]);
    const tapback = bluebubblesVendor.parseWebhook(
      row({
        handle: { address: CHASE },
        chats: [{ guid: `iMessage;-;${DEAN}`, style: 45 }],
        associatedMessageGuid: 'p:0/X',
        associatedMessageType: 'like',
      }),
    );
    expect(tapback[0]).toMatchObject({ kind: 'ignored' });
    // An Apple ID email matches case-insensitively.
    const email = bluebubblesVendor.parseWebhook(
      row({
        handle: { address: 'Sam@Example.test' },
        chats: [{ guid: 'iMessage;-;sam@example.test' }],
      }),
    );
    expect(email[0]).toMatchObject({ kind: 'message' });
  });

  it('ignores an attachment whose guid could walk the download URL', () => {
    const att = (guid: string) => ({
      guid,
      mimeType: 'image/jpeg',
      transferName: 'x.jpeg',
      hideAttachment: false,
    });
    const parsed = bluebubblesVendor.parseWebhook(
      row({
        attachments: [
          att('..'),
          att('../../api/v1/server/restart'),
          att('a/b'),
          att('%2e%2e'),
          att('at_0_B10EB0B5-6F1A-4A00-8000-0000000000F1'),
        ],
      }),
    );
    expect(parsed[0]).toMatchObject({
      kind: 'message',
      media: [
        {
          url: `${BLUEBUBBLES_MOCK_SERVER_URL}/api/v1/attachment/at_0_B10EB0B5-6F1A-4A00-8000-0000000000F1/download`,
        },
      ],
    });
  });

  it('a "+" in the token stays a "+" (form decoding would make it a space)', () => {
    const base = { rawBody: '{}', headers: {}, nowMs: 0 };
    expect(bluebubblesVendor.verifyWebhook({ ...base, secret: 'a+b', query: '?token=a+b' })).toBe(
      true,
    );
    expect(bluebubblesVendor.verifyWebhook({ ...base, secret: 'a+b', query: '?token=a%2Bb' })).toBe(
      true,
    );
    expect(bluebubblesVendor.verifyWebhook({ ...base, secret: 'a b', query: '?token=a+b' })).toBe(
      false,
    );
  });

  it('live BlueBubbles refuses a webhook secret that would not survive the URL (and never echoes it)', () => {
    const env = {
      TRAV_CHANNEL: 'imessage_relay',
      TRAV_RELAY_VENDOR: 'bluebubbles',
      TRAV_RELAY_LIVE: '1',
      TRAV_RELAY_API_KEY: 'pw-not-real',
      TRAV_RELAY_LINE: MOCK_RELAY_LINE,
      TRAV_BLUEBUBBLES_URL: 'http://127.0.0.1:1234',
    };
    for (const secret of ['abc+def', 'a&token=b', 'x#y', '50%off']) {
      const c = resolveRelayConfig({ ...env, TRAV_RELAY_WEBHOOK_SECRET: secret });
      expect(c.live, secret).toBe(false);
      expect(c.reason).toMatch(/URL-safe/);
      expect(c.reason).not.toContain(secret);
    }
    const hex = 'a3f9'.repeat(16);
    expect(resolveRelayConfig({ ...env, TRAV_RELAY_WEBHOOK_SECRET: hex }).live).toBe(true);
  });
});

// ------------------------------------------------------------------ dedupe

describe.each(['photon', 'sendblue', 'bluebubbles'] as const)(
  'dedupe by provider id over %s',
  (vendorId) => {
    it('a redelivered webhook is acked and dropped, across a restart when the store persists', async () => {
      const store = createMemorySeenStore();
      const added: string[] = [];
      const spy: RelaySeenStore = {
        has: (k) => store.has(k),
        add: (k) => {
          added.push(k);
          store.add(k);
        },
      };
      const first = setup(vendorId, { seen: spy });
      const hook = await first.mock.memberMessage({
        chat: group,
        from: DEAN,
        text: 'dinner was €84',
        vendorMessageId: 'PROVIDER-ID-1',
      });
      expect(await first.deliver(hook)).toBe(200);
      expect(await first.deliver(hook)).toBe(200);
      expect(first.events).toHaveLength(1);
      expect(first.relay.stats().duplicatesDropped).toBe(1);
      // "Restart": a new channel over the same store drops the vendor's retry.
      const second = setup(vendorId, { seen: spy });
      expect(await second.deliver(hook)).toBe(200);
      expect(second.events).toEqual([]);
      // Keys are the vendor and the provider id only: no text, no addresses.
      expect(added).toEqual([`${vendorId}:m:PROVIDER-ID-1`]);
      // A fresh store (no persistence) would deliver it again.
      const third = setup(vendorId);
      await third.deliver(hook);
      expect(third.events).toHaveLength(1);
    });
  },
);

// ---------------------------------------------- the fake BlueBubbles server

const SERVER = 'http://127.0.0.1:1234';
const PASSWORD = 'bb-test-password-not-real';
const WEBHOOK_SECRET = 'bb-webhook-secret-not-real';

/**
 * A fake `fetch` standing in for the BlueBubbles server on the same Mac: the
 * request is serialized by undici exactly as it would go on the wire
 * (`new Request`), decoded the way the server's router would (JSON or
 * multipart), and answered by the mock relay's mirror of the REST API.
 */
function fakeBlueBubblesServer(mock: MockRelay) {
  const seen: { url: string; contentType: string }[] = [];
  const fetchImpl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string | FormData },
  ) => {
    const wire = new Request(url, init);
    const contentType = wire.headers.get('content-type') ?? '';
    if (wire.method !== 'POST') throw new Error('the fake server takes POST only');
    seen.push({ url, contentType });
    let request: RelayHttpRequest;
    if (contentType.startsWith('multipart/form-data')) {
      const form = await wire.formData();
      const fields: Record<string, string> = {};
      const files: { field: string; fileName: string; mimeType: string; base64: string }[] = [];
      for (const [k, v] of form.entries()) {
        if (typeof v === 'string') fields[k] = v;
        else
          files.push({
            field: k,
            fileName: v.name,
            mimeType: v.type,
            base64: Buffer.from(await v.arrayBuffer()).toString('base64'),
          });
      }
      request = { method: 'POST', url, headers: {}, form: { fields, files } };
    } else {
      request = {
        method: 'POST',
        url,
        headers: { 'content-type': contentType },
        body: JSON.parse(await wire.text()) as unknown,
      };
    }
    const res: RelayHttpResponse = await mock.transport(request);
    const body = JSON.stringify(res.body ?? null);
    return new Response(body, { status: res.status, headers: res.headers ?? {} });
  };
  return { fetchImpl, seen };
}

function fakeReq(url: string, body: string): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  Object.assign(stream, {
    method: 'POST',
    url,
    headers: { host: '127.0.0.1:5181', 'content-type': 'application/json' },
  });
  return stream;
}

function fakeRes(): ServerResponse & { status(): number } {
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    end() {
      res.headersSent = true;
    },
    status: () => res.statusCode,
  };
  return res as unknown as ServerResponse & { status(): number };
}

describe('live wire path against a fake BlueBubbles server (no socket, no real send)', () => {
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

  const ENV: RelayEnv = {
    TRAV_CHANNEL: 'imessage_relay',
    TRAV_RELAY_VENDOR: 'bluebubbles',
    TRAV_RELAY_LIVE: '1',
    TRAV_RELAY_API_KEY: PASSWORD,
    TRAV_RELAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TRAV_RELAY_LINE: MOCK_RELAY_LINE,
    TRAV_BLUEBUBBLES_URL: SERVER,
    TRAV_BLUEBUBBLES_PRIVATE_API: '1',
    TRAV_RELAY_CONTACT_NAME: 'Trav Bot',
  };

  it('the live gate needs the server URL too, and the status line never prints a value', () => {
    const { TRAV_BLUEBUBBLES_URL: _u, ...noUrl } = ENV;
    expect(resolveRelayConfig(noUrl)).toMatchObject({ live: false, line: MOCK_RELAY_LINE });
    expect(resolveRelayConfig(noUrl).reason).toMatch(/TRAV_BLUEBUBBLES_URL is not set/);
    const badUrl = { ...ENV, TRAV_BLUEBUBBLES_URL: 'http://bb.secret-host.test' };
    expect(resolveRelayConfig(badUrl).live).toBe(false);
    expect(resolveRelayConfig(badUrl).reason).not.toContain('secret-host');
    const live = resolveRelayConfig(ENV);
    expect(live).toMatchObject({
      live: true,
      serverUrl: SERVER,
      privateApi: true,
      contactNames: ['Trav Bot'],
    });
    const line = describeRelayConfig(live, ENV);
    expect(line).toContain('TRAV_BLUEBUBBLES_URL=set');
    for (const v of [PASSWORD, WEBHOOK_SECRET, SERVER, MOCK_RELAY_LINE])
      expect(line).not.toContain(v);
    // The Private API flag means nothing for another vendor.
    expect(resolveRelayConfig({ ...ENV, TRAV_RELAY_VENDOR: 'photon' }).privateApi).toBe(false);
  });

  it('plain http only to loopback, and never outside the configured origin', async () => {
    const f = vi.fn();
    expect(() =>
      createLiveRelayTransport({
        origin: 'http://bb.example.test',
        fetch: f,
        allowLoopbackHttp: true,
      }),
    ).toThrow(/https/);
    expect(() => createLiveRelayTransport({ origin: SERVER, fetch: f })).toThrow(/https/);
    const transport = createLiveRelayTransport({
      origin: SERVER,
      fetch: f,
      allowLoopbackHttp: true,
    });
    await expect(
      transport({ method: 'POST', url: 'http://127.0.0.1:9999/api/v1/message/text', headers: {} }),
    ).rejects.toThrow(/outside/);
    await expect(
      transport({
        method: 'POST',
        url: `${SERVER}/x`,
        headers: {},
        body: {},
        form: { fields: {}, files: [] },
      }),
    ).rejects.toThrow(/either a JSON body or a form/);
    expect(f).not.toHaveBeenCalled();
  });

  it('messages in over the webhook URL, text, QR upload and tapback out over HTTP, redelivery dropped', async () => {
    const clock = manualClock(NOW);
    const mock = createMockRelay({
      vendor: 'bluebubbles',
      clock,
      serverUrl: SERVER,
      apiKey: PASSWORD,
      webhookSecret: WEBHOOK_SECRET,
      chats: [{ chatId: CHAT, participants: [DEAN, CHASE, HENRY] }],
    });
    const server = fakeBlueBubblesServer(mock);
    const built = createRelayFromEnv({
      env: ENV,
      clock,
      mockTransport: async () => {
        throw new Error('the mock transport must not be used when live');
      },
      fetch: server.fetchImpl,
      contacts: CONTACTS,
      chats: [{ chatId: CHAT, participants: [DEAN, CHASE, HENRY] }],
      sleep: async () => undefined,
      resolveInboundMedia: async (a) => mock.uploadedOriginal(a.uri) ?? a,
    })!;
    expect(built.config.live).toBe(true);
    const { channel } = built;
    expect(channel.info.mode).toBe('live');
    expect(channel.vendor.baseUrl).toBe(SERVER);
    const events: InboundEvent[] = [];
    channel.onEvent((e) => {
      events.push(e);
    });
    const handler = createRelayWebhookHandler({ target: channel });
    const post = async (hook: { rawBody: string; query?: string }) => {
      const res = fakeRes();
      await handler(fakeReq(`${DEFAULT_WEBHOOK_PATH}${hook.query ?? ''}`, hook.rawBody), res);
      await new Promise((r) => setImmediate(r));
      return res.status();
    };

    // In: the Razzmatazz ask, the contact name, and a receipt photo from the server.
    const ask = await mock.memberMessage({
      chat: group,
      from: DEAN,
      text: "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
    });
    expect(await post(ask)).toBe(200);
    expect(await post({ rawBody: ask.rawBody, query: '?token=wrong' })).toBe(401);
    expect(await post(ask)).toBe(200); // the server's retry: acked, dropped
    const named = await mock.memberMessage({
      chat: group,
      from: CHASE,
      text: 'Trav Bot, receipt',
      attachments: [
        {
          kind: 'image',
          mimeType: 'image/jpeg',
          uri: 'fixtures/receipts/r1.jpg',
          fileName: 'r1.jpg',
        },
      ],
    });
    expect(await post(named)).toBe(200);
    const messages = events.filter((e): e is InboundMessage => e.type === 'message');
    expect(messages.map((m) => m.text)).toEqual([
      "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
      'Trav Bot, receipt',
    ]);
    expect(messages[1]).toMatchObject({
      platformMention: true,
      attachments: [{ uri: 'fixtures/receipts/r1.jpg' }],
    });
    expect(channel.stats().duplicatesDropped).toBe(1);

    // Out: a threaded receipt, a DM ticket with its QR, a 👍.
    const receipt = groupMsg('booked ✅ razzmatazz, 5 tickets, €90', {
      replyTo: messages[0]!.messageId,
    });
    expect((await channel.sendGroup(CHAT, receipt)).ok).toBe(true);
    const ticket = dmMsg('mem_dean', 'your razzmatazz ticket for tonight 🎟️', {
      card: ticketCard('mem_dean'),
      images: [{ url: mockQrDataUrl('TRAV-MOCK-TICKET|dean'), alt: 'QR code' }],
    });
    expect((await channel.sendDirect('h_dean', ticket)).ok).toBe(true);
    const rx = await channel.react(CHAT, {
      id: 'rx_ack',
      targetMessageId: messages[1]!.messageId,
      emoji: '👍',
    } as Parameters<typeof channel.react>[1]);
    expect(rx.ok).toBe(true);

    expect(server.seen.map((s) => new URL(s.url).pathname)).toEqual([
      '/api/v1/message/text',
      '/api/v1/message/text',
      '/api/v1/message/attachment',
      '/api/v1/message/react',
    ]);
    expect(server.seen.every((s) => new URL(s.url).searchParams.get('password') === PASSWORD)).toBe(
      true,
    );
    expect(server.seen[0]!.contentType).toBe('application/json');
    expect(server.seen[2]!.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const sends = mock.sends();
    expect(sends[0]).toMatchObject({ chat: group, replyToVendorId: messages[0]!.messageId });
    expect(sends[1]).toMatchObject({ chat: { kind: 'dm', address: DEAN }, media: [] });
    expect(sends[2]!.media).toHaveLength(1);
    const png = mock.media.resolve(sends[2]!.media[0]!.url)!.bytes;
    expect(Buffer.from(png).subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(sends[3]).toMatchObject({ kind: 'reaction', tapback: 'like', remove: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
