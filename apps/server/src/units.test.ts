// T-188 unit tests: config, logs, commands, provisioning, relay state, the shifted clock.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { InboundMessage } from '@trav/adapters';
import { voiceViolations } from '@trav/agent';
import type { OutboundMessage } from '@trav/core';
import { createDeterministicIdGenerator, createSimulatedClock, parseIso } from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import {
  ALREADY_DELETED_TEXT,
  DELETED_TEXT,
  NOTHING_TO_DELETE_TEXT,
  START_TEXT,
  STOP_DM_TEXT,
  STOP_GROUP_TEXT,
  createOptOutList,
  optOutKey,
  optOutSecret,
  parseCommand,
} from './commands.js';
import { createShiftedClock } from './clock.js';
import { describeServerConfig, resolveServerConfig } from './config.js';
import { REDACTED, createLogger, logRecord } from './log.js';
import { parseGroupsFile, provisionGroups, seedBarcelonaOnRelay } from './provision.js';
import { createRelayState } from './relayState.js';
import { hostName, isJsonContentType, serverRelayEnv } from './server.js';

const NOW = '2026-03-14T21:40:00+01:00';

function stores() {
  const clock = createSimulatedClock(NOW);
  return createMemoryStores({ clock, ids: createDeterministicIdGenerator('t') });
}

describe('config', () => {
  it('binds 127.0.0.1 by default and refuses anything else outside a deployment', () => {
    const c = resolveServerConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(5181);
    expect(c.webhookPath).toBe('/relay/webhook');
    expect(() => resolveServerConfig({ TRAV_SERVER_HOST: '0.0.0.0' })).toThrow(/DEPLOY/);
    expect(() => resolveServerConfig({ TRAV_SERVER_HOST: '192.168.1.5' })).toThrow();
    expect(resolveServerConfig({ TRAV_SERVER_HOST: '0.0.0.0', TRAV_SERVER_DEPLOY: '1' }).host).toBe(
      '0.0.0.0',
    );
  });

  it('validates the port, tick and public hosts; --demo is dev only', () => {
    expect(() => resolveServerConfig({ TRAV_RELAY_PORT: 'abc' })).toThrow();
    expect(() => resolveServerConfig({ TRAV_RELAY_PORT: '70000' })).toThrow();
    expect(resolveServerConfig({ TRAV_SERVER_TICK_MS: '5' }).tickMs).toBe(1000);
    expect(
      resolveServerConfig({ TRAV_SERVER_PUBLIC_HOSTS: 'A.example.com, b.example' }).publicHosts,
    ).toEqual(['a.example.com', 'b.example']);
    expect(() => resolveServerConfig({ TRAV_SERVER_PUBLIC_HOSTS: 'x.com:443' })).toThrow();
    expect(resolveServerConfig({}, ['--demo=barcelona']).demo).toBe('barcelona');
    expect(resolveServerConfig({}, ['--demo']).demo).toBe('barcelona');
    expect(() => resolveServerConfig({}, ['--demo=lisbon'])).toThrow();
    expect(() => resolveServerConfig({ TRAV_SERVER_DEPLOY: '1' }, ['--demo'])).toThrow();
  });

  it('describes what is set, never values', () => {
    const c = resolveServerConfig({
      TRAV_SERVER_DB: '/secret/.trav/x.sqlite',
      TRAV_SERVER_GROUPS: '/secret/groups.json',
    });
    const line = JSON.stringify(describeServerConfig(c));
    expect(line).not.toContain('secret');
    expect(describeServerConfig(c)).toMatchObject({ db: 'set', groups: 'set' });
  });

  it('the dev demo never runs live; the server always turns the relay on', () => {
    const env = serverRelayEnv({ TRAV_RELAY_LIVE: '1', TRAV_CHANNEL: 'whatsapp' }, true);
    expect(env['TRAV_RELAY_LIVE']).toBeUndefined();
    expect(env['TRAV_CHANNEL']).toBe('imessage_relay');
    expect(serverRelayEnv({ TRAV_RELAY_LIVE: '1' }, false)['TRAV_RELAY_LIVE']).toBe('1');
  });

  it('JSON content types only (r1 #4: no CORS simple request is JSON)', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    for (const v of [
      undefined,
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'application/jsonp',
    ]) {
      expect(isJsonContentType(v), String(v)).toBe(false);
    }
  });

  it('reads the Host name without its port', () => {
    expect(hostName('LOCALHOST:5181')).toBe('localhost');
    expect(hostName('trav.example.com')).toBe('trav.example.com');
    expect(hostName(undefined)).toBeUndefined();
  });
});

describe('structured logs', () => {
  it('keeps only known fields and id-like strings', () => {
    const r = logRecord(NOW, 'info', 'turn', {
      groupId: 'grp_barcelona',
      note: 'approval:handled',
      count: 3,
      text: 'hello',
      sender: '+16175550101',
    } as never);
    expect(r).toMatchObject({
      groupId: 'grp_barcelona',
      note: 'approval:handled',
      count: 3,
      droppedFields: 2,
    });
    expect(JSON.stringify(r)).not.toContain('hello');
  });

  it('redacts a value with a phone, an email, a quote or a newline, and caps length', () => {
    expect(logRecord(NOW, 'info', 'x', { detail: '+16175550101' })['detail']).toBe(REDACTED);
    expect(logRecord(NOW, 'info', 'x', { detail: 'bo@example.com' })['detail']).toBe(REDACTED);
    expect(logRecord(NOW, 'info', 'x', { detail: 'a\nb' })['detail']).toBe(REDACTED);
    expect(logRecord(NOW, 'info', 'x', { detail: '"hi"' })['detail']).toBe(REDACTED);
    expect(String(logRecord(NOW, 'info', 'x', { detail: 'a'.repeat(500) })['detail'])).toHaveLength(
      160,
    );
    expect(logRecord(NOW, 'info', 'x', { ms: Number.NaN })['ms']).toBeNull();
  });

  it('writes one JSON line per call with the clock time', () => {
    const lines: string[] = [];
    const log = createLogger({ clock: createSimulatedClock(NOW), write: (l) => lines.push(l) });
    log.warn('send.lost', { reason: 'rate_limited' });
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: NOW,
      level: 'warn',
      event: 'send.lost',
      reason: 'rate_limited',
    });
  });
});

describe('commands', () => {
  const msg = (text: string, lane: 'group' | 'dm' = 'dm'): InboundMessage => ({
    type: 'message',
    channel: 'imessage_relay',
    conversationId: lane === 'dm' ? 'dm:+16175550101' : 'chat',
    lane,
    receivedAt: NOW,
    messageId: 'm1',
    sender: '+16175550101',
    text,
    attachments: [],
  });

  it('every standard opt-out word in a DM; only unambiguous ones in the group', () => {
    for (const w of [
      'STOP',
      'stop.',
      'Unsubscribe',
      'cancel',
      'END',
      'quit',
      'opt out',
      'revoke',
      'STOPALL',
    ]) {
      expect(parseCommand(msg(w), false)).toEqual({ kind: 'stop' });
    }
    expect(parseCommand(msg('STOP', 'group'), false)).toEqual({ kind: 'stop' });
    expect(parseCommand(msg('@trav stop', 'group'), false)).toEqual({ kind: 'stop' });
    expect(parseCommand(msg('cancel', 'group'), false)).toBeUndefined();
    expect(parseCommand(msg('end', 'group'), false)).toBeUndefined();
    expect(parseCommand(msg('stop roasting', 'group'), false)).toBeUndefined();
    expect(parseCommand(msg('please stop it guys', 'group'), false)).toBeUndefined();
    expect(parseCommand(msg('stop me if you heard this'), false)).toBeUndefined();
  });

  it('START only while opted out; STOP while opted out is not a new command', () => {
    expect(parseCommand(msg('START'), true)).toEqual({ kind: 'start' });
    expect(parseCommand(msg('start'), false)).toBeUndefined();
    expect(parseCommand(msg('STOP'), true)).toBeUndefined();
  });

  it('"delete my data" needs an @trav in the group, not in a DM', () => {
    expect(parseCommand(msg('delete my data'), false)).toEqual({ kind: 'delete_my_data' });
    expect(parseCommand(msg('forget me'), false)).toEqual({ kind: 'delete_my_data' });
    expect(parseCommand(msg('@trav delete my data', 'group'), false)).toEqual({
      kind: 'delete_my_data',
    });
    expect(parseCommand(msg('trav, please delete my data', 'group'), false)).toEqual({
      kind: 'delete_my_data',
    });
    // r1 #2: politeness, "all", and the mention anywhere at the front.
    for (const ask of [
      'hey @trav delete all my data',
      '@trav can you delete my data?',
      '@trav could you please delete all of my data',
      'pls @trav wipe my info thanks',
      '@trav forget about me',
      'trav, clear all my data please',
    ]) {
      expect(parseCommand(msg(ask, 'group'), false), ask).toEqual({ kind: 'delete_my_data' });
    }
    expect(parseCommand(msg('can you delete my data?'), false)).toEqual({
      kind: 'delete_my_data',
    });
    expect(parseCommand(msg('hey can you delete my data', 'group'), false)).toBeUndefined();
    expect(parseCommand(msg('@trav can you delete my data from the dinner', 'group'), false)).toBe(
      undefined,
    );
    expect(parseCommand(msg('@trav why would you delete my data', 'group'), false)).toBe(undefined);
    expect(parseCommand(msg('delete my data', 'group'), false)).toBeUndefined();
    expect(parseCommand(msg('lol i should delete my data', 'group'), false)).toBeUndefined();
    expect(parseCommand(msg('@trav forget me after the trip', 'group'), false)).toBeUndefined();
  });

  it('the opt-out list is keyed by an HMAC of the address under a per-store secret', () => {
    const s = stores();
    const list = createOptOutList(s);
    list.add('BO@Example.com', NOW);
    expect(list.has('bo@example.com')).toBe(true);
    expect(list.has('+16175550101')).toBe(false);
    const rows = s.group.runtime.list('optout', { groupId: null });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('example');
    // r1 #5: not the unkeyed SHA-256 anyone could recompute from a number.
    const unkeyed = createHash('sha256').update('trav-optout:bo@example.com').digest('hex');
    expect(rows[0]!.key).not.toBe(unkeyed);
    const secret = optOutSecret(s);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.key).toBe(optOutKey('bo@example.com', secret));
    expect(list.keyOf('bo@example.com')).toBe(rows[0]!.key);
    // The secret is kept with the store: a second list (a restart) finds the same rows.
    expect(createOptOutList(s).has('bo@example.com')).toBe(true);
    // A different store has a different secret, so the same number has another key.
    expect(createOptOutList(stores()).keyOf('bo@example.com')).not.toBe(rows[0]!.key);
    list.remove('bo@example.com');
    expect(list.has('bo@example.com')).toBe(false);
  });

  it('every reply follows VOICE (lint clean as group and DM messages)', () => {
    for (const text of [
      STOP_DM_TEXT,
      STOP_GROUP_TEXT,
      START_TEXT,
      DELETED_TEXT,
      ALREADY_DELETED_TEXT,
      NOTHING_TO_DELETE_TEXT,
    ]) {
      for (const to of [
        { kind: 'group' as const },
        { kind: 'member' as const, memberId: 'mem_dean' },
      ]) {
        const m: OutboundMessage = { id: 'msg_1', groupId: 'grp_x', to, text };
        expect(voiceViolations(m, [], null)).toEqual([]);
      }
      expect(text.length).toBeLessThan(160);
    }
  });
});

describe('provisioning', () => {
  const file = {
    groups: [
      {
        groupId: 'grp_test',
        name: 'test',
        chatId: 'chat_test',
        currency: 'USD',
        perPersonAutoCapMinor: 2500,
        members: [
          { memberId: 'mem_a', name: 'Ana', address: '+12135550111', birthDate: '1990-01-01' },
          { memberId: 'mem_b', name: 'Bo', address: 'Bo@Example.com' },
          { memberId: 'mem_k', name: 'Kid', address: '+12135550112', birthDate: '2015-01-01' },
        ],
        trip: {
          tripId: 'trip_test',
          name: 'test trip',
          city: 'Austin',
          countryCode: 'US',
          timeZone: 'America/Chicago',
          startDate: '2026-03-20',
          endDate: '2026-03-22',
        },
      },
    ],
  };

  it('writes groups, members and the trip once; editing the file never rewrites history', () => {
    const s = stores();
    const groups = parseGroupsFile(file);
    expect(provisionGroups(s, groups, NOW)).toEqual(['grp_test']);
    const g = s.group.groups.get('grp_test')!;
    expect(g).toMatchObject({ conversationId: 'chat_test', channelKind: 'imessage_relay' });
    expect(g.spendingPolicy.perPersonAutoCapMinor).toBe(2500);
    const members = s.group.members.listByGroup('grp_test');
    expect(members.map((m) => [m.memberId, m.role, m.senderId, m.ageBand])).toEqual([
      ['mem_a', 'lead', '+12135550111', 'adult'],
      ['mem_b', 'member', 'bo@example.com', 'unknown'],
      ['mem_k', 'member', '+12135550112', 'under18'],
    ]);
    expect(s.group.trips.get('trip_test')).toMatchObject({ familyTab: true, createdBy: 'mem_a' });
    // Again, with a renamed member: nothing changes.
    const renamed = parseGroupsFile({
      groups: [{ ...file.groups[0]!, members: [{ ...file.groups[0]!.members[0]!, name: 'X' }] }],
    });
    expect(provisionGroups(s, renamed, NOW)).toEqual([]);
    expect(s.group.members.get('mem_a')?.displayName).toBe('Ana');
  });

  it('refuses a malformed file with the field path, never the value', () => {
    const bad = (patch: Record<string, unknown>, member?: Record<string, unknown>) => () =>
      parseGroupsFile({
        groups: [
          {
            ...file.groups[0]!,
            ...patch,
            ...(member ? { members: [{ ...file.groups[0]!.members[0]!, ...member }] } : {}),
          },
        ],
      });
    expect(bad({ groupId: 'Bad Id' })).toThrow(/groups\[0\]\.groupId is malformed/);
    expect(bad({ currency: 'usd' })).toThrow(/currency/);
    expect(bad({ members: [] })).toThrow(/members/);
    expect(bad({}, { address: '6175550101' })).toThrow(/address must be/);
    expect(bad({}, { address: '6175550101' })).not.toThrow(/6175550101/);
    expect(bad({}, { role: 'admin' })).toThrow(/role/);
    expect(bad({ perPersonAutoCapMinor: 1.5 })).toThrow(/perPersonAutoCapMinor/);
    expect(bad({ trip: { ...file.groups[0]!.trip, timeZone: 'Mars/Base' } })).toThrow(/timeZone/);
    expect(bad({ trip: { ...file.groups[0]!.trip, endDate: '2026-03-01' } })).toThrow(/endDate/);
    expect(() =>
      parseGroupsFile({ groups: [file.groups[0], { ...file.groups[0], groupId: 'grp_two' }] }),
    ).toThrow(/chatId is a duplicate|memberId is a duplicate/);
    expect(() => parseGroupsFile([])).toThrow();
  });

  it('a chat already owned by another group is refused', () => {
    const s = stores();
    provisionGroups(s, parseGroupsFile(file), NOW);
    const other = parseGroupsFile({
      groups: [
        {
          ...file.groups[0]!,
          groupId: 'grp_other',
          members: [{ memberId: 'mem_z', name: 'Z', address: '+12135550199' }],
          trip: undefined,
        },
      ],
    });
    expect(() => provisionGroups(s, other, NOW)).toThrow(/another group/);
  });

  it('the demo seeds Barcelona on the relay once, every member on a fictional 555 number', () => {
    const s = stores();
    const addresses = seedBarcelonaOnRelay(s);
    expect(s.group.groups.get('grp_barcelona')?.channelKind).toBe('imessage_relay');
    const ids = s.group.members.listByGroup('grp_barcelona').map((m) => m.senderId);
    expect(ids).toEqual([...addresses.values()]);
    expect(ids.every((a) => /^\+1\d{3}55501\d\d$/.test(a))).toBe(true);
    expect(() => seedBarcelonaOnRelay(s)).not.toThrow();
  });
});

describe('relay state', () => {
  it('remaps a vendor id from an earlier life to the Trav id, the latest send winning, bounded', () => {
    const s = stores();
    const state = createRelayState(s, 3);
    state.rememberSend('msg_a', ['v1', 'v2']);
    state.rememberSend('msg_b', ['v1']);
    expect(createRelayState(s).travIdOf('v1')).toBe('msg_b');
    expect(createRelayState(s).travIdOf('v2')).toBe('msg_a');
    state.rememberSend('msg_c', ['v3', 'v4']);
    expect(createRelayState(s).travIdOf('v1')).toBeUndefined();
    expect(s.group.runtime.list('relay_vendor_id', { groupId: null })).toHaveLength(3);
    const reaction = {
      type: 'reaction' as const,
      channel: 'imessage_relay' as const,
      conversationId: 'chat',
      lane: 'group' as const,
      receivedAt: NOW,
      sender: '+1',
      messageId: 'r1',
      targetMessageId: 'v4',
      reaction: '👍',
      removed: false,
    };
    expect(createRelayState(s).remap(reaction)).toMatchObject({ targetMessageId: 'msg_c' });
    expect(createRelayState(s).remap({ ...reaction, targetMessageId: 'zz' })).toMatchObject({
      targetMessageId: 'zz',
    });
  });

  it("knows provisioned chats and stored rosters; DMs only to a member's own active address", () => {
    const s = stores();
    seedBarcelonaOnRelay(s);
    const state = createRelayState(s);
    state.saveRoster('chat_other', ['+13125550150']);
    const chats = state.chats();
    expect(chats.map((c) => c.chatId).sort()).toEqual(['chat_other', 'conv_barcelona']);
    expect(chats.find((c) => c.chatId === 'conv_barcelona')!.participants).toHaveLength(6);
    const dean = s.group.members.get('mem_dean')!;
    expect(state.resolveContact(dean.senderId, 'mem_dean')).toMatchObject({ memberId: 'mem_dean' });
    expect(state.resolveContact(dean.senderId, 'mem_chase')).toBeUndefined();
    expect(state.resolveContact('h_dean', 'mem_dean')).toBeUndefined();
    s.group.members.upsert({ ...dean, active: false });
    expect(state.resolveContact(dean.senderId, 'mem_dean')).toBeUndefined();
  });
});

describe('shifted clock', () => {
  it('starts at the given time, keeps its offset, moves with the wall clock', () => {
    let wall = 1_000_000;
    const c = createShiftedClock(NOW, () => wall);
    expect(c.now()).toBe('2026-03-14T21:40:00+01:00');
    wall += 90_000;
    expect(c.nowMs()).toBe(parseIso(NOW) + 90_000);
    expect(c.now()).toMatch(/21:41:30.*\+01:00$/);
  });
});
