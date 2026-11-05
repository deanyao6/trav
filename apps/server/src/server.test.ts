/**
 * T-188 acceptance: the server end to end over the fake relay.
 *
 * - A signed webhook posted over HTTP to 127.0.0.1 becomes Trav's reply on
 *   the wire (the Razzmatazz moment: receipt in the group, one ticket DM with a
 *   QR each, the ledger split among the five).
 * - A restart over the same SQLite file keeps state (T-185): a 👍 on a card
 *   posted before the restart books it exactly once, a redelivered webhook is
 *   a duplicate, an opt-out still holds.
 *
 * The fake relay and the mock ticket and payment providers are shared across
 * lives: they stand in for the vendor and the seller, which outlive Trav's
 * process. TRAV_OFFLINE=1 throughout; nothing leaves the machine.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { join } from 'node:path';
import type { MockBookingPayments, MockRelay, MockTickets, SignedWebhook } from '@trav/adapters';
import {
  createMemoryMediaHost,
  createMockBookingPayments,
  createMockRelay,
  createMockTickets,
  loadTicketInventory,
} from '@trav/adapters';
import { BARCELONA, BARCELONA_NOW, GUEST_REFUSAL_TEXT } from '@trav/agent';
import type { SimulatedClock } from '@trav/core';
import { createDeterministicIdGenerator, createSimulatedClock, ledger } from '@trav/core';
import { DELETED_TEXT, START_TEXT, STOP_DM_TEXT, STOP_GROUP_TEXT, optOutKey } from './commands.js';
import type { ServerConfig } from './config.js';
import { resolveServerConfig } from './config.js';
import { createLogger } from './log.js';
import { barcelonaAddresses } from './provision.js';
import type { ProvisionedGroup } from './provision.js';
import type { TravServer } from './server.js';
import { createTravServer } from './server.js';

const RAZZ_ASK = "@trav get the 5 of us Razzmatazz tickets, Henry's sick";
const FIVE = ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley'];
const ADDR = barcelonaAddresses();
const DEAN = ADDR.get('mem_dean')!;
const CHASE = ADDR.get('mem_chase')!;
const ARJUN = ADDR.get('mem_arjun')!;
const G = BARCELONA.groupId;
const CHAT = BARCELONA.conversationId;

interface World {
  readonly dir: string;
  readonly clock: SimulatedClock;
  readonly tickets: MockTickets;
  readonly payments: MockBookingPayments;
  mock?: MockRelay;
  readonly logs: string[];
}

const dirs: string[] = [];
const servers: TravServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'trav-t188-'));
  dirs.push(dir);
  const clock = createSimulatedClock(BARCELONA_NOW);
  return {
    dir,
    clock,
    tickets: createMockTickets({
      clock,
      ids: createDeterministicIdGenerator('prov'),
      inventory: loadTicketInventory('barcelona'),
    }),
    payments: createMockBookingPayments({ clock }),
    logs: [],
  };
}

function configFor(w: World, extra: Partial<ServerConfig> = {}): ServerConfig {
  return {
    ...resolveServerConfig({ TRAV_RELAY_PORT: '0' }),
    sqlitePath: join(w.dir, '.trav', 'trav.sqlite'),
    ...extra,
  };
}

/** One process lifetime over the world's SQLite file. */
function boot(
  w: World,
  life: string,
  opts: { demo?: boolean; groups?: readonly ProvisionedGroup[] } = {},
): TravServer {
  const server = createTravServer({
    config: configFor(w, opts.demo === false ? {} : { demo: 'barcelona' }),
    env: { TRAV_OFFLINE: '1', TRAV_STATE_DIR: join(w.dir, 'state') },
    clock: w.clock,
    ids: createDeterministicIdGenerator(life),
    log: createLogger({ clock: w.clock, write: (line) => w.logs.push(line) }),
    providers: { tickets: w.tickets, payments: w.payments },
    mockRelay: (chats) => {
      w.mock ??= createMockRelay({
        vendor: 'photon',
        clock: w.clock,
        chats,
        media: createMemoryMediaHost(),
      });
      return w.mock;
    },
    timers: false,
    sleep: async () => undefined,
    voice: 'strict',
    ...(opts.groups !== undefined ? { groups: opts.groups } : {}),
  });
  servers.push(server);
  return server;
}

// node:http, because fetch never lets a caller set `Host`.
function rawRequest(
  port: number,
  input: { method: string; path: string; host: string; body?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: input.method,
        path: input.path,
        headers: { host: input.host, 'content-type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(input.body ?? '');
  });
}

async function post(port: number, hook: SignedWebhook): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}/relay/webhook${hook.query ?? ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...hook.headers },
    body: hook.rawBody,
  });
}

function sendsSince(mock: MockRelay, n: number) {
  return mock.sends().slice(n);
}

const say = (mock: MockRelay, from: string, text: string, dm = false) =>
  mock.memberMessage({
    chat: dm ? { kind: 'dm', address: from } : { kind: 'group', chatId: CHAT },
    from,
    text,
  });

describe('T-188: webhook → reply round trip over the fake relay', () => {
  it('the Razzmatazz ask over HTTP: receipt in the group, a ticket DM with a QR for each of the five, split five ways', async () => {
    const w = world();
    const server = boot(w, 'a');
    const { host, port } = await server.listen();
    expect(host).toBe('127.0.0.1');
    expect(server.http.address()).toMatchObject({ address: '127.0.0.1' });
    const mock = w.mock!;

    const res = await post(port, await say(mock, DEAN, RAZZ_ASK));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accepted: 1, duplicates: 0 });
    await server.idle();

    const sends = mock.sends();
    const group = sends.filter((s) => s.chat.kind === 'group');
    expect(group.some((s) => /razzmatazz/i.test(s.text) && /€18/.test(s.text))).toBe(true);
    // One DM per ticket holder, each with its QR as an image, to the holder's own number.
    const dms = sends.filter((s) => s.chat.kind === 'dm');
    const to = dms.map((s) => (s.chat.kind === 'dm' ? s.chat.address : '')).sort();
    expect(to).toEqual(FIVE.map((id) => ADDR.get(id)!).sort());
    expect(dms.every((s) => s.media.length === 1)).toBe(true);
    expect(to).not.toContain(ADDR.get('mem_henry'));

    expect(w.tickets.purchaseCount()).toBe(1);
    expect(w.payments.chargeCount()).toBe(1);
    const expense = server.stores.group.expenses
      .listByTrip(BARCELONA.tripId)
      .find((e) => e.source === 'booking')!;
    const order = server.stores.group.members.listByGroup(G).map((m) => m.memberId);
    const shares = ledger.computeShares(expense, {
      memberOrder: order,
      participantsUniverse: order,
    });
    expect(shares.map((s) => [s.memberId, s.amount.amountMinor])).toEqual(
      FIVE.map((id) => [id, 1800]),
    );
    // Policy and audit ran as on any channel.
    const types = server.stores.group.audit.listByGroup(G).map((e) => e.type);
    expect(types).toContain('policy.evaluated');
    expect(types).toContain('booking.completed');

    // Logs: JSON lines, never a number, never message text.
    expect(w.logs.length).toBeGreaterThan(0);
    for (const line of w.logs) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect(line).not.toMatch(/\+1\d{10}/);
      expect(line.toLowerCase()).not.toContain('razzmatazz');
    }
    expect(w.logs.some((l) => (JSON.parse(l) as { event: string }).event === 'turn')).toBe(true);
  }, 30_000);

  it('a send retry or failure is logged by type only (the vendor error text never reaches a log)', async () => {
    const w = world();
    const server = boot(w, 'a');
    const mock = w.mock!;
    mock.failNext({ kind: 'status', status: 503 }, { kind: 'network' });
    await (
      await server.relay.handleWebhook(await say(mock, DEAN, '@trav hi'))
    ).delivered;
    await server.idle();
    const diags = w.logs
      .map((l) => JSON.parse(l) as { event: string; type?: string; detail?: string })
      .filter((r) => r.event === 'relay.diagnostic');
    const sendDiags = diags.filter((r) => r.type === 'send_retry' || r.type === 'send_failed');
    expect(sendDiags.length).toBeGreaterThan(0);
    expect(sendDiags.every((r) => r.detail === undefined)).toBe(true);
  }, 30_000);

  it('refuses a forged body, an unknown Host and a GET; answers the health check without personal data', async () => {
    const w = world();
    const server = boot(w, 'a');
    const { port } = await server.listen();
    const hook = await say(w.mock!, DEAN, '@trav hi');
    const forged = await post(port, { ...hook, rawBody: hook.rawBody.replace('hi', 'buy') });
    expect(forged.status).toBe(401);
    expect(
      await rawRequest(port, {
        method: 'POST',
        path: '/relay/webhook',
        host: 'evil.example',
        body: hook.rawBody,
      }),
    ).toBe(403);
    expect(await rawRequest(port, { method: 'GET', path: '/healthz', host: 'evil.example' })).toBe(
      403,
    );
    const get = await fetch(`http://127.0.0.1:${String(port)}/relay/webhook`);
    expect(get.status).toBe(405);
    const health = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      mode: 'mock',
      vendor: 'photon',
      model: 'offline',
      groups: 1,
    });
    expect(JSON.stringify(body)).not.toMatch(/\+1\d|@|Dean/);
    // The demo-only route is loopback only, and absent outside the demo.
    expect((await fetch(`http://127.0.0.1:${String(port)}/dev/say`)).status).toBe(405);
    await server.idle();
  }, 30_000);

  it('a public host is accepted only when configured; /dev/say is never served to it', async () => {
    const w = world();
    const server = createTravServer({
      config: { ...configFor(w), publicHosts: ['trav.example.com'], demo: 'barcelona' },
      env: { TRAV_OFFLINE: '1', TRAV_STATE_DIR: join(w.dir, 'state') },
      clock: w.clock,
      log: createLogger({ clock: w.clock, write: () => undefined }),
      timers: false,
    });
    servers.push(server);
    const { port } = await server.listen();
    const host = 'trav.example.com';
    expect(await rawRequest(port, { method: 'GET', path: '/healthz', host })).toBe(200);
    expect(await rawRequest(port, { method: 'GET', path: '/healthz', host: 'other.example' })).toBe(
      403,
    );
    const body = JSON.stringify({ from: 'mem_dean', text: '@trav hi' });
    expect(await rawRequest(port, { method: 'POST', path: '/dev/say', host, body })).toBe(404);
    expect(
      await rawRequest(port, { method: 'POST', path: '/dev/say', host: '127.0.0.1', body }),
    ).toBe(200);
  }, 30_000);

  it('/dev/say (demo, loopback) plays a member line through the signed path and returns what went out', async () => {
    const w = world();
    const server = boot(w, 'a');
    const { port } = await server.listen();
    const res = await fetch(`http://127.0.0.1:${String(port)}/dev/say`, {
      method: 'POST',
      body: JSON.stringify({ from: 'mem_dean', text: RAZZ_ASK }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: { chat: string; images: number }[] };
    expect(body.sent.filter((s) => s.chat === 'dm' && s.images === 1)).toHaveLength(5);
    const bad = await fetch(`http://127.0.0.1:${String(port)}/dev/say`, {
      method: 'POST',
      body: JSON.stringify({ from: 'nobody', text: 'x' }),
    });
    expect(bad.status).toBe(400);
  }, 30_000);
});

describe('T-188: restart keeps state (same SQLite file)', () => {
  it('a 👍 on a card posted before the restart books exactly once; a redelivered webhook is a duplicate', async () => {
    const w = world();
    // ---- life 1: auto-buy off, so the ask posts a card that waits for a 👍.
    const first = boot(w, 'a');
    const g = first.stores.group.groups.get(G)!;
    first.stores.group.groups.update({
      ...g,
      spendingPolicy: { ...g.spendingPolicy, autoApproveCapMinor: 0 },
    });
    const { port: p1 } = await first.listen();
    const mock = w.mock!;
    const askHook = await say(mock, DEAN, RAZZ_ASK);
    expect((await post(p1, askHook)).status).toBe(200);
    await first.idle();
    const card = mock
      .sends()
      .filter((s) => s.chat.kind === 'group')
      .at(-1)!;
    expect(card.text).toMatch(/👍/);
    expect(w.tickets.purchaseCount()).toBe(0);
    await first.close();

    // ---- life 2: a new process, new ids, the same file and the same vendor.
    const second = boot(w, 'b');
    const { port: p2 } = await second.listen();
    // The redelivered ask is a duplicate: the relay's dedupe keys were on disk.
    const again = await post(p2, askHook);
    expect(await again.json()).toMatchObject({ accepted: 0, duplicates: 1 });

    const before = mock.sends().length;
    const thumbs = mock.memberTapback({
      chat: { kind: 'group', chatId: CHAT },
      from: DEAN,
      targetVendorId: card.vendorMessageId,
      tapback: 'like',
    });
    expect((await post(p2, thumbs)).status).toBe(200);
    await second.idle();
    expect(w.tickets.purchaseCount()).toBe(1);
    expect(w.payments.chargeCount()).toBe(1);
    const after = sendsSince(mock, before);
    expect(after.filter((s) => s.chat.kind === 'dm' && s.media.length === 1)).toHaveLength(5);
    const audit = second.stores.group.audit.listByGroup(G).map((e) => e.type);
    expect(audit.filter((t) => t === 'booking.completed')).toHaveLength(1);

    // ---- life 3: the same 👍 redelivered after another restart buys nothing.
    await second.close();
    const third = boot(w, 'c');
    const { port: p3 } = await third.listen();
    expect(await (await post(p3, thumbs)).json()).toMatchObject({ duplicates: 1 });
    await third.idle();
    expect(w.tickets.purchaseCount()).toBe(1);
    expect(
      third.stores.group.expenses
        .listByTrip(BARCELONA.tripId)
        .filter((e) => e.source === 'booking'),
    ).toHaveLength(1);
  }, 45_000);

  it('a scheduled job queued before the restart runs after it on the clock', async () => {
    const w = world();
    const first = boot(w, 'a');
    // Saturday night: the tickets, so Sunday's Morning After has a night to recap.
    await (
      await first.relay.handleWebhook(await say(w.mock!, DEAN, RAZZ_ASK))
    ).delivered;
    await first.idle();
    const morning = first.runtime.scheduler
      .list()
      .filter((j) => j.kind === 'morning_after')
      .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))[0];
    expect(morning).toBeDefined();
    // Nothing is due yet: a tick runs nothing.
    expect(await first.tick()).toEqual([]);
    await first.close();

    const second = boot(w, 'b');
    expect(second.runtime.scheduler.list().map((j) => j.jobId)).toContain(morning!.jobId);
    w.clock.set(morning!.runAt);
    const before = w.mock!.sends().length;
    const ran = await second.tick();
    expect(ran.map((r) => r.note)).toContain('scheduled:morning_after:full');
    expect(second.runtime.scheduler.list().map((j) => j.jobId)).not.toContain(morning!.jobId);
    const posted = sendsSince(w.mock!, before);
    expect(posted.filter((s) => s.chat.kind === 'group').length).toBeGreaterThan(0);
    // The job is gone from the file too: a third life doesn't post it again.
    await second.close();
    const third = boot(w, 'c');
    const n = w.mock!.sends().length;
    await third.tick();
    expect(w.mock!.sends().length).toBe(n);
  }, 30_000);
});

describe('T-188: STOP, START and "delete my data"', () => {
  it('STOP in a DM: one confirmation, then no DM at all (a ticket included) and the number is ignored, also after a restart; START undoes it', async () => {
    const w = world();
    const server = boot(w, 'a');
    const mock = w.mock!;
    await server.relay.handleWebhook(await say(mock, CHASE, 'STOP', true)).then((o) => o.delivered);
    await server.idle();
    const confirm = mock.sends().at(-1)!;
    expect(confirm.chat).toEqual({ kind: 'dm', address: CHASE });
    expect(confirm.text).toBe(STOP_DM_TEXT);
    expect(server.optOuts.has(CHASE)).toBe(true);
    // Stored hashed: the number is not in the table in the clear.
    const row = server.stores.group.runtime.get('optout', null, optOutKey(CHASE));
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(CHASE);
    await server.close();

    const second = boot(w, 'b');
    expect(second.optOuts.has(CHASE)).toBe(true);
    // Chase's own messages are ignored.
    let n = mock.sends().length;
    await (
      await second.relay.handleWebhook(await say(mock, CHASE, '@trav hi'))
    ).delivered;
    await second.idle();
    expect(mock.sends().length).toBe(n);
    // Dean books for the five: Chase is still on the tab, but gets no DM.
    await (
      await second.relay.handleWebhook(await say(mock, DEAN, RAZZ_ASK))
    ).delivered;
    await second.idle();
    const dms = sendsSince(mock, n).filter((s) => s.chat.kind === 'dm');
    expect(dms).toHaveLength(4);
    expect(dms.some((s) => s.chat.kind === 'dm' && s.chat.address === CHASE)).toBe(false);
    expect(w.logs.some((l) => l.includes('"reason":"opted_out"'))).toBe(true);

    // START opts back in, with one line.
    n = mock.sends().length;
    await (
      await second.relay.handleWebhook(await say(mock, CHASE, 'start', true))
    ).delivered;
    await second.idle();
    expect(second.optOuts.has(CHASE)).toBe(false);
    expect(sendsSince(mock, n).map((s) => s.text)).toEqual([START_TEXT]);
  }, 45_000);

  it('STOP in the group is answered in the group; "stop roasting" and "cancel" there are not opt-outs', async () => {
    const w = world();
    const server = boot(w, 'a');
    const mock = w.mock!;
    await (
      await server.relay.handleWebhook(await say(mock, ARJUN, '@trav stop roasting'))
    ).delivered;
    await (
      await server.relay.handleWebhook(await say(mock, ARJUN, 'cancel'))
    ).delivered;
    await server.idle();
    expect(server.optOuts.has(ARJUN)).toBe(false);
    await (
      await server.relay.handleWebhook(await say(mock, ARJUN, 'STOP'))
    ).delivered;
    await server.idle();
    expect(server.optOuts.has(ARJUN)).toBe(true);
    const last = mock.sends().at(-1)!;
    expect(last.chat).toEqual({ kind: 'group', chatId: CHAT });
    expect(last.text).toBe(STOP_GROUP_TEXT);
  }, 30_000);

  it('"@trav delete my data" deletes the sender\'s private partition and runtime state, audits it, and keeps the group tab', async () => {
    const w = world();
    const server = boot(w, 'a');
    const mock = w.mock!;
    expect(server.stores.private.getPaymentProfile('mem_arjun')).toBeDefined();
    // Not addressed to Trav in the group: not a command.
    await (
      await server.relay.handleWebhook(await say(mock, ARJUN, 'delete my data'))
    ).delivered;
    await server.idle();
    expect(server.stores.private.getPaymentProfile('mem_arjun')).toBeDefined();

    const n = mock.sends().length;
    await (
      await server.relay.handleWebhook(await say(mock, ARJUN, '@trav delete my data'))
    ).delivered;
    await server.idle();
    expect(server.stores.private.getPaymentProfile('mem_arjun')).toBeUndefined();
    expect(server.stores.private.getPaymentProfile('mem_dean')).toBeDefined();
    const deleted = server.stores.group.audit
      .listByGroup(G)
      .filter((e) => e.type === 'data.deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({
      actor: { kind: 'member', id: 'mem_arjun' },
      ownerId: 'mem_arjun',
    });
    // Still a member: the tab still adds up.
    expect(server.stores.group.members.get('mem_arjun')).toBeDefined();
    expect(sendsSince(mock, n).map((s) => s.text)).toEqual([DELETED_TEXT]);
  }, 30_000);
});

describe('T-188: who the server answers', () => {
  const PROVISIONED: ProvisionedGroup = {
    groupId: 'grp_test',
    name: 'test trip',
    chatId: 'chat_test',
    currency: 'USD',
    members: [
      { memberId: 'mem_t_ana', name: 'Ana', address: '+12135550111', birthDate: '1990-01-01' },
      { memberId: 'mem_t_bo', name: 'Bo', address: 'bo@example.com', birthDate: '1991-02-02' },
    ],
  };

  it('an unprovisioned chat gets no answer; an unknown number in a provisioned chat is a guest who cannot book', async () => {
    const w = world();
    const server = boot(w, 'a', { demo: false, groups: [PROVISIONED] });
    const mock = w.mock!;
    expect(server.stores.group.groups.get('grp_test')?.channelKind).toBe('imessage_relay');
    await (
      await server.relay.handleWebhook(
        await mock.memberMessage({
          chat: { kind: 'group', chatId: 'chat_nobody' },
          from: '+13125550150',
          text: '@trav hi',
        }),
      )
    ).delivered;
    await server.idle();
    expect(mock.sends()).toHaveLength(0);
    expect(w.logs.some((l) => l.includes('"reason":"unknown_chat"'))).toBe(true);

    await (
      await server.relay.handleWebhook(
        await mock.memberMessage({
          chat: { kind: 'group', chatId: 'chat_test' },
          from: '+13125550150',
          text: '@trav book us 2 tickets to something tonight',
        }),
      )
    ).delivered;
    await server.idle();
    expect(server.stores.group.bookings.listPendingProposals('grp_test')).toHaveLength(0);
    const texts = mock.sends().map((s) => s.text);
    expect(texts).toEqual([GUEST_REFUSAL_TEXT]);
  }, 30_000);

  it('a provisioned member can be DMed by their own address only', async () => {
    const w = world();
    const server = boot(w, 'a', { demo: false, groups: [PROVISIONED] });
    const msg = (memberId: string) => ({
      id: 'msg_x' + memberId,
      groupId: 'grp_test',
      to: { kind: 'member' as const, memberId },
      text: 'hi',
    });
    expect((await server.relay.sendDirect('+12135550111', msg('mem_t_ana'))).ok).toBe(true);
    expect((await server.relay.sendDirect('+12135550111', msg('mem_t_bo'))).ok).toBe(false);
    expect((await server.relay.sendDirect('+13125550150', msg('mem_t_ana'))).ok).toBe(false);
  }, 30_000);
});
