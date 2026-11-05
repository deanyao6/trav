/**
 * T-154: in a family group, a roster reply about an adult-only plan reaches
 * the adults (the outbound screen would drop a line naming nightlife or
 * alcohol), and never names that plan or its venue where the minor reads it.
 * "the" in an activity hint names nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSimulatorChannel } from '@trav/adapters';
import type { Activity, Group, Member, OutboundMessage, Stores, Trip } from '@trav/core';
import {
  createDeterministicIdGenerator,
  createSimulatedClock,
  isReaction,
  safety,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import { BARCELONA, BARCELONA_NOW, createTravRuntime } from '../compose.js';
import type { TurnResult } from '../loop.js';
import { repoRoot } from '../model/paths.js';
import { harness, tempStateDir } from '../runtime.testkit.js';
import { ADULT_PLAN_LABEL, resolveActivity, rosterLabel } from './index.js';
import { withAlso } from './turn.js';

interface GroupFixture {
  readonly group: Group;
  readonly members: Member[];
  readonly trip: Trip;
  readonly activities: Activity[];
}
const TCI = JSON.parse(
  readFileSync(join(repoRoot(), 'fixtures', 'groups', 'turks-and-caicos.json'), 'utf8'),
) as GroupFixture;
/** The night of the nightcap, after the sunset cruise: the nightcap is tonight's plan. */
const TCI_NOW = '2026-06-23T20:00:00-04:00';
const NIGHTCAP = 'act_tci_nightcap';
const TZ = TCI.trip.timeZone;

function tciRuntime() {
  const clock = createSimulatedClock(TCI_NOW);
  const ids = createDeterministicIdGenerator('t154');
  const stores = createMemoryStores({ clock, ids });
  stores.group.groups.create(TCI.group);
  for (const m of TCI.members) stores.group.members.upsert(m);
  stores.group.trips.create(TCI.trip);
  for (const a of TCI.activities) stores.group.trips.upsertActivity(a);
  const channel = createSimulatorChannel({
    clock,
    conversations: [
      {
        conversationId: TCI.group.conversationId,
        participants: TCI.members.map((m) => ({
          handle: m.senderId,
          displayName: m.displayName,
          memberId: m.memberId,
        })),
      },
    ],
  });
  const runtime = createTravRuntime({
    channel,
    clock,
    ids,
    stores,
    offline: true,
    env: { TRAV_OFFLINE: '1', TRAV_STATE_DIR: tempStateDir() },
  });
  return {
    runtime,
    stores,
    async say(from: string, text: string): Promise<TurnResult> {
      const event = await channel.injectMessage({ from, text });
      return runtime.agent.handleInbound(event);
    },
    audit: () => stores.group.audit.listByGroup(TCI.group.groupId),
  };
}

function texts(r: TurnResult): string[] {
  return r.outbound
    .filter((o): o is OutboundMessage => !isReaction(o))
    .filter((o) => o.to.kind === 'group')
    .map((o) => o.text);
}

function status(stores: Stores, memberId: string): string | undefined {
  return stores.group.trips.listAttendance(NIGHTCAP).find((a) => a.memberId === memberId)?.status;
}

/** Nothing a minor must not read: no restricted term, not the plan's name, no age words. */
function safeForTheMinor(text: string): void {
  expect(safety.isRestrictedText(text), text).toBe(false);
  expect(text).not.toMatch(/nightcap/i);
  // An age ("14"), never a clock time ("10:30pm").
  expect(text).not.toMatch(/\b(?:1[0-7](?![:\d]|am|pm)|under|minor|kid|child)\b/i);
}

describe('"the" in an activity hint (T-154)', () => {
  const now = TCI_NOW;
  it('"the adults nightcap" and "adults nightcap" both find the nightcap', () => {
    for (const hint of ['the adults nightcap', 'adults nightcap', 'The Nightcap', 'the nightcap']) {
      expect(resolveActivity(TCI.activities, TZ, now, hint)?.activityId, hint).toBe(NIGHTCAP);
    }
  });
  it('a hint of only "the" is no hint (tonight\'s plan, r1 #3); other words still must all match', () => {
    for (const hint of ['the', ' The ', 'the the', 'the tickets']) {
      expect(resolveActivity(TCI.activities, TZ, now, hint)?.activityId, hint).toBe(NIGHTCAP);
    }
    expect(resolveActivity(TCI.activities, TZ, now, 'the karaoke')).toBeUndefined();
    expect(resolveActivity(TCI.activities, TZ, now, 'the theater')).toBeUndefined();
  });
});

describe('rosterLabel (T-154)', () => {
  function storesWith(minor: boolean, forced = false) {
    const clock = createSimulatedClock(TCI_NOW);
    const stores = createMemoryStores({ clock, ids: createDeterministicIdGenerator('l') });
    stores.group.groups.create({
      ...TCI.group,
      settings: { ...TCI.group.settings, familyModeForced: forced },
    });
    const members = TCI.members
      .filter((m) => minor || m.memberId !== 'mem_tci_lily')
      .map((m) => ({ ...m }));
    for (const m of members) stores.group.members.upsert(m);
    return { stores, members };
  }
  const nightcap = TCI.activities.find((a) => a.activityId === NIGHTCAP)!;
  const cruise = TCI.activities.find((a) => a.activityId === 'act_tci_cruise')!;

  it("an adult-only plan in a family group is the adults' plan; an all-ages plan keeps its name", () => {
    const { stores, members } = storesWith(true);
    expect(rosterLabel(stores.group, nightcap, members, TCI_NOW)).toBe(ADULT_PLAN_LABEL);
    expect(rosterLabel(stores.group, cruise, members, TCI_NOW)).toBe('sunset cruise');
  });
  it('forced family mode with no minor also hides the name; no family mode keeps it', () => {
    const forced = storesWith(false, true);
    expect(rosterLabel(forced.stores.group, nightcap, forced.members, TCI_NOW)).toBe(
      ADULT_PLAN_LABEL,
    );
    const adults = storesWith(false);
    expect(rosterLabel(adults.stores.group, nightcap, adults.members, TCI_NOW)).toBe(
      'adults nightcap',
    );
  });
  it('an unknown group fails closed when a minor is on the roster', () => {
    const { stores, members } = storesWith(true);
    const orphan = { ...nightcap, groupId: 'grp_nope' };
    expect(rosterLabel(stores.group, orphan, members, TCI_NOW)).toBe(ADULT_PLAN_LABEL);
  });
});

describe('Turks and Caicos: roster replies about the adults nightcap reach the adults (T-154)', () => {
  it('"@trav i\'m in for the adults nightcap" is written and the line is sent, not suppressed', async () => {
    const t = tciRuntime();
    const turn = await t.say('h_dad', "@trav i'm in for the adults nightcap");
    expect(turn.note).toBe('roster:changed');
    expect(status(t.stores, 'mem_tci_dad')).toBe('in');
    const [line] = texts(turn);
    expect(line).toBe("Dad is in for the adults' plan. that's 1 now");
    safeForTheMinor(line!);
    expect(t.audit().filter((e) => e.type === 'content.suppressed')).toEqual([]);
  });

  it('the roll call ("who\'s in for the adults nightcap") reaches the group, venue unnamed, Lily not asked', async () => {
    const t = tciRuntime();
    await t.say('h_mom', "@trav i'm in for the adults nightcap");
    await t.say('h_dad', '@trav count me in for adults nightcap');
    await t.say('h_dean', "@trav i'm out for the nightcap");
    for (const ask of [
      "@trav who's in for the adults nightcap",
      "@trav who's in for adults nightcap?",
      "@trav who's in tonight?",
    ]) {
      const turn = await t.say('h_dean', ask);
      expect(turn.note, ask).toBe('roster:roll_call');
      const out = texts(turn);
      expect(out, ask).toHaveLength(1);
      expect(out[0]!.split('\n')).toEqual([
        "the adults' plan tonight: 2 in · Mom, Dad",
        'out: Dean',
      ]);
      safeForTheMinor(out[0]!);
      expect(
        safety.lintVoice(out[0]!, { kind: 'reply', properNouns: ['Mom', 'Dad', 'Dean'] })
          .violations,
      ).toEqual([]);
    }
    expect(t.audit().filter((e) => e.type === 'content.suppressed')).toEqual([]);
  });

  it('the combined party line ("it\'s the 3 of us tonight, lily\'s out") reaches the group', async () => {
    const t = tciRuntime();
    const turn = await t.say('h_mom', "@trav it's the 3 of us tonight, lily's out");
    expect(turn.note).toBe('roster:party');
    const [line] = texts(turn);
    expect(line!.split('\n')).toEqual([
      "the adults' plan tonight: 3 in · Mom, Dad, Dean",
      'out: Lily',
    ]);
    safeForTheMinor(line!);
    expect(status(t.stores, 'mem_tci_lily')).toBe('out');
    expect(t.audit().filter((e) => e.type === 'content.suppressed')).toEqual([]);
  });

  it('a plan named with a screened word ("rooftop bar", "wine tasting") still gets its roll call', async () => {
    for (const name of ['rooftop bar', 'wine tasting', 'late club night']) {
      const t = tciRuntime();
      const act = t.stores.group.trips.getActivity(NIGHTCAP)!;
      t.stores.group.trips.upsertActivity({ ...act, name });
      // The old label is exactly what the screen drops in this group.
      expect(safety.isRestrictedText(`${name} tonight: 1 in · Dad`), name).toBe(true);
      const write = await t.say('h_dad', `@trav i'm in for the ${name}`);
      expect(texts(write)[0], name).toBe("Dad is in for the adults' plan. that's 1 now");
      // "who's in for the rooftop bar?" names a bar in front of Lily: the
      // family-options intercept answers that one (SAFETY §2.7), before the roster.
      const roll = await t.say('h_mom', "@trav who's in tonight?");
      expect(texts(roll), name).toEqual([
        "the adults' plan tonight: 1 in · Dad\nhaven't said: Mom, Dean",
      ]);
      for (const line of [...texts(write), ...texts(roll)]) {
        expect(line.toLowerCase()).not.toContain(name);
        expect(safety.isRestrictedText(line)).toBe(false);
      }
      expect(t.audit().filter((e) => e.type === 'content.suppressed')).toEqual([]);
    }
  });

  it('naming Lily in still keeps her off (T-153), and that line reaches the group too', async () => {
    const t = tciRuntime();
    await t.say('h_mom', "@trav i'm in for the adults nightcap");
    const turn = await t.say('h_dad', "@trav lily's in for the adults nightcap");
    expect(turn.note).toBe('roster:kept_off');
    expect(texts(turn)).toEqual(["Lily stays off this plan, it's not all-ages. that's 1 in"]);
    expect(status(t.stores, 'mem_tci_lily')).toBeUndefined();
  });

  it('an "already in" reply names the adults\' plan too', async () => {
    const t = tciRuntime();
    await t.say('h_dad', "@trav i'm in for the adults nightcap");
    const turn = await t.say('h_dad', "@trav i'm in for the adults nightcap");
    expect(turn.note).toBe('roster:unchanged');
    expect(texts(turn)).toEqual(["Dad is already in for the adults' plan. that's 1 in"]);
  });

  it('an all-ages plan in the same group keeps its own name', async () => {
    const t = tciRuntime();
    const turn = await t.say('h_dad', "@trav i'm in for the thursday fish fry");
    expect(turn.note).toBe('roster:changed');
    expect(texts(turn)[0]).toBe("Dad is in for thursday fish fry. that's 1 now");
  });
});

describe('two adult-only plans on one night carry their start times (T-154 r1 #1)', () => {
  function twoPlans(startsAt = '2026-06-23T22:30:00-04:00') {
    const t = tciRuntime();
    const cap = t.stores.group.trips.getActivity(NIGHTCAP)!;
    t.stores.group.trips.upsertActivity({
      ...cap,
      activityId: 'act_tci_lounge',
      name: 'late rooftop lounge',
      startsAt,
    });
    return t;
  }
  const lounge = (stores: Stores, memberId: string) =>
    stores.group.trips.listAttendance('act_tci_lounge').find((a) => a.memberId === memberId)
      ?.status;

  it('"i\'m in for the nightcap" and "... the rooftop lounge" say which plan, by time', async () => {
    const t = twoPlans();
    const a = await t.say('h_dad', "@trav i'm in for the nightcap");
    expect(texts(a)[0]).toBe("Dad is in for the adults' plan at 9:30pm. that's 1 now");
    const b = await t.say('h_mom', "@trav i'm in for the rooftop lounge");
    expect(texts(b)[0]).toBe("Mom is in for the adults' plan at 10:30pm. that's 1 now");
    expect(status(t.stores, 'mem_tci_dad')).toBe('in');
    expect(lounge(t.stores, 'mem_tci_mom')).toBe('in');
    for (const line of [...texts(a), ...texts(b)]) {
      safeForTheMinor(line);
      expect(line).not.toMatch(/lounge|rooftop/i);
    }
    expect(t.audit().filter((e) => e.type === 'content.suppressed')).toEqual([]);
  });

  it('"who\'s in tonight?" answers the first and says the second exists; naming one does not', async () => {
    const t = twoPlans();
    await t.say('h_dad', "@trav i'm in for the nightcap");
    await t.say('h_mom', "@trav i'm in for the rooftop lounge");
    const roll = await t.say('h_dean', "@trav who's in tonight?");
    expect(roll.note).toBe('roster:roll_call');
    expect(texts(roll)[0]!.split('\n')).toEqual([
      "the adults' plan at 9:30pm tonight: 1 in · Dad",
      "haven't said: Mom, Dean",
      "also tonight: the adults' plan at 10:30pm",
    ]);
    safeForTheMinor(texts(roll)[0]!);
    expect(
      safety.lintVoice(texts(roll)[0]!, { kind: 'reply', properNouns: ['Mom', 'Dad', 'Dean'] })
        .violations,
    ).toEqual([]);
    const named = await t.say('h_dean', "@trav who's in for the rooftop lounge?");
    expect(texts(named)[0]!.split('\n')).toEqual([
      "the adults' plan at 10:30pm tonight: 1 in · Mom",
      "haven't said: Dad, Dean",
    ]);
  });

  // T-154 r2 review #1: the maybe line gives way first, "haven't said" always stays.
  it('a full roll call keeps "haven\'t said" when the "also tonight" line is added', () => {
    const call = [
      "the adults' plan at 9:30pm tonight: 1 in · Dad",
      'out: Mom',
      'maybe: Dean (counts as out when i book)',
      "haven't said: Ava",
    ].join('\n');
    expect(withAlso(call, "also tonight: the adults' plan at 10:30pm").split('\n')).toEqual([
      "the adults' plan at 9:30pm tonight: 1 in · Dad",
      'out: Mom',
      "haven't said: Ava",
      "also tonight: the adults' plan at 10:30pm",
    ]);
  });

  // r2 review #2: "who's in for the tickets?" is no hint, so the second plan is mentioned too.
  it('"who\'s in for the tickets?" answers like "who\'s in tonight?"', async () => {
    const t = twoPlans();
    const roll = await t.say('h_dean', "@trav who's in for the tickets?");
    expect(texts(roll)[0]).toContain("also tonight: the adults' plan at 10:30pm");
  });

  it('two at the same time are numbered; one plan alone has no time', async () => {
    const t = twoPlans('2026-06-23T21:30:00-04:00');
    const a = await t.say('h_dad', "@trav i'm in for the nightcap");
    const b = await t.say('h_dad', "@trav i'm in for the rooftop lounge");
    // Ordered by start, then id: act_tci_lounge before act_tci_nightcap.
    expect(texts(a)[0]).toBe("Dad is in for the adults' plan at 9:30pm (2 of 2). that's 1 now");
    expect(texts(b)[0]).toBe("Dad is in for the adults' plan at 9:30pm (1 of 2). that's 1 now");
    const one = tciRuntime();
    const c = await one.say('h_dad', "@trav i'm in for the nightcap");
    expect(texts(c)[0]).toBe("Dad is in for the adults' plan. that's 1 now");
  });

  it('a timed label on another night gives the day once, not the time twice', async () => {
    const t = twoPlans();
    const cap = t.stores.group.trips.getActivity(NIGHTCAP)!;
    const lng = t.stores.group.trips.getActivity('act_tci_lounge')!;
    t.stores.group.trips.upsertActivity({ ...cap, startsAt: '2026-06-24T21:30:00-04:00' });
    t.stores.group.trips.upsertActivity({ ...lng, startsAt: '2026-06-24T22:30:00-04:00' });
    const roll = await t.say('h_dean', "@trav who's in for the nightcap");
    expect(texts(roll)[0]!.split('\n')[0]).toBe(
      "the adults' plan at 9:30pm tomorrow night: nobody marked in yet",
    );
  });
});

describe('"who\'s in for the?" is a plain roll call (T-154 r1 #3)', () => {
  it("resolves to tonight's plan, no model call", async () => {
    const t = tciRuntime();
    const turn = await t.say('h_dean', "@trav who's in for the?");
    expect(turn.note).toBe('roster:roll_call');
    expect(texts(turn)[0]).toBe(
      "the adults' plan tonight: nobody marked in yet\nhaven't said: Mom, Dad, Dean",
    );
  });
});

describe('Barcelona with a minor: the 18+ plan is not named on roster lines (T-154)', () => {
  it("with Sam under 18 the roll call says the adults' plan; with no minor it says razzmatazz", async () => {
    const plain = harness();
    const before = await plain.say('h_dean', "@trav who's in tonight?");
    expect(texts(before)[0]).toBe(
      'razzmatazz tonight: 6 in · Dean, Henry, Maya, Jordan, Priya, Sam',
    );

    const h = harness();
    const stores = h.runtime.stores;
    const sam = stores.group.members
      .listByGroup(BARCELONA.groupId)
      .find((m) => m.memberId === 'mem_sam')!;
    stores.group.members.upsert({ ...sam, birthDate: '2010-05-01', ageBand: 'under18' });
    // A restricted word in the plan's own name: before T-154 the line was dropped.
    const razz = stores.group.trips.getActivity(BARCELONA.razzmatazzActivityId)!;
    stores.group.trips.upsertActivity({ ...razz, name: 'Razzmatazz club night' });
    stores.group.trips.setAttendance({
      activityId: razz.activityId,
      memberId: 'mem_sam',
      status: 'out',
      updatedAt: BARCELONA_NOW,
      sourceMessageId: 'msg_seed',
      setBy: 'mem_dean',
    });
    const turn = await h.say('h_dean', "@trav who's in for the razzmatazz club night");
    expect(turn.note).toBe('roster:roll_call');
    const [line] = texts(turn);
    expect(line!.split('\n')).toEqual([
      "the adults' plan tonight: 5 in · Dean, Henry, Maya, Jordan, Priya",
      'out: Sam',
    ]);
    expect(line).not.toMatch(/razz/i);
    expect(safety.isRestrictedText(line!)).toBe(false);
    const out = await h.say('h_henry', "@trav henry's sick");
    expect(texts(out)[0]).toBe("Henry is out for the adults' plan. that leaves 4");
  });
});
