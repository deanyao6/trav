/**
 * Demo state 1 (VOICE §9.5): the chat the simulator opens on. All six in the
 * Barcelona chat talking about tonight (nobody @'s Trav), plus a few lines in
 * the Lisbon and Turks and Caicos chats so those threads aren't empty.
 *
 * The lines go through the simulator channel into the real runtime like any
 * other message (`seedChat`), on the simulated clock, so Trav hears them
 * exactly as it would live: no mention, so it stays quiet, but the context is
 * there when Dean asks for Razzmatazz tickets a minute later.
 *
 * The runtime only seeds Barcelona itself (`seedBarcelona` in compose.ts), so
 * `seedFixtureGroups` writes the Lisbon and Turks and Caicos groups (members
 * with birth dates, trip, activities, attendance) from `fixtures/groups/` into
 * the runtime's stores. That makes those chats real too: Trav answers there,
 * and Turks and Caicos is in family mode because Lily is under 18.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SimulatorChannel } from '@trav/adapters';
import type {
  Activity,
  Attendance,
  Group,
  IsoDateTime,
  Member,
  SimulatedClock,
  Stores,
  Trip,
} from '@trav/core';
import type { SimGroup } from '../shared/types.js';
import { BARCELONA } from './groups.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The non-Barcelona sim groups and their `fixtures/groups/` file. */
export const FIXTURE_GROUP_FILES: Readonly<Record<string, string>> = {
  grp_lisbon: 'lisbon.json',
  grp_turks_caicos: 'turks-and-caicos.json',
};

interface GroupFixtureFile {
  readonly group: Group;
  readonly members: readonly (Member & { readonly homeAirport?: unknown })[];
  readonly trip: Trip;
  readonly activities?: readonly Activity[];
  readonly attendance?: readonly Attendance[];
}

/**
 * Writes each sim group that has a fixture (and is not in the stores yet)
 * into `stores`: group, members, trip, activities, attendance. Member
 * `senderId`s become the simulator's handles (matched by `memberId`), since
 * the simulator keeps every handle unique across chats. Private data
 * (consent, prefs, member memory) is never seeded. Returns the seeded ids.
 */
export function seedFixtureGroups(
  stores: Pick<Stores, 'group'>,
  groups: readonly SimGroup[],
): readonly string[] {
  const seeded: string[] = [];
  for (const sim of groups) {
    const file = FIXTURE_GROUP_FILES[sim.groupId];
    if (file === undefined || stores.group.groups.get(sim.groupId) !== undefined) continue;
    const f = JSON.parse(
      readFileSync(join(REPO_ROOT, 'fixtures', 'groups', file), 'utf8'),
    ) as GroupFixtureFile;
    stores.group.groups.create({ ...f.group, conversationId: sim.conversationId });
    for (const m of f.members) {
      const { homeAirport: _home, ...member } = m;
      const handle = sim.members.find((s) => s.memberId === m.memberId)?.handle;
      stores.group.members.upsert({
        ...member,
        ...(handle !== undefined ? { senderId: handle } : {}),
      });
    }
    stores.group.trips.create(f.trip);
    for (const a of f.activities ?? []) stores.group.trips.upsertActivity(a);
    for (const a of f.attendance ?? []) stores.group.trips.setAttendance(a);
    seeded.push(sim.groupId);
  }
  return seeded;
}

export interface SeedLine {
  readonly at: IsoDateTime;
  readonly from: string;
  readonly text: string;
  readonly conversationId: string;
}

const OFFSET = '+01:00';

/** Barcelona, sat mar 14, 5:30pm: the first seeded line. */
export const SEED_START: IsoDateTime = `2026-03-14T17:30:00${OFFSET}`;

/** Demo state 1 in the Barcelona chat: all six talking about tonight, nobody @'s Trav. */
export const BARCELONA_SEED: readonly SeedLine[] = [
  ['17:30', 'h_sam', 'pregame at the apartment at 11, razz after?'],
  ['17:31', 'h_jordan', 'razz tonight yesss'],
  ['17:33', 'h_henry', 'i might be out tonight, feel worse again'],
  ['20:30', 'h_henry', 'yeah im out tonight, sorry guys. have fun'],
  ['20:31', 'h_priya', 'feel better henry!!'],
  ['21:36', 'h_maya', 'someone get tickets before it sells out'],
  ['21:37', 'h_dean', 'on it'],
].map(([time, from, text]) => ({
  at: `2026-03-14T${time}:00${OFFSET}`,
  from: from!,
  text: text!,
  conversationId: BARCELONA.conversationId,
}));

/** A few lines in the other two reference trips' chats. */
export const OTHER_SEED: readonly SeedLine[] = [
  {
    at: '2026-04-16T12:10:00+01:00',
    from: 'h_lis_dad',
    text: 'conference runs till 5, dinner after?',
    conversationId: 'conv_lisbon',
  },
  {
    at: '2026-04-16T12:12:00+01:00',
    from: 'h_lis_dean',
    text: "fado place at 8:30, i'll grab a table",
    conversationId: 'conv_lisbon',
  },
  {
    at: '2026-06-21T18:02:00-04:00',
    from: 'h_tci_mom',
    text: 'snorkel tour is tomorrow 9am, everyone up by 8',
    conversationId: 'conv_turks_caicos',
  },
  {
    at: '2026-06-21T18:04:00-04:00',
    from: 'h_tci_lily',
    text: 'can i bring my goggles',
    conversationId: 'conv_turks_caicos',
  },
  {
    at: '2026-06-21T18:05:00-04:00',
    from: 'h_tci_dad',
    text: 'yes bring them',
    conversationId: 'conv_turks_caicos',
  },
];

/** Every seed line, in the order they are injected. */
export const DEMO_SEED: readonly SeedLine[] = [...OTHER_SEED, ...BARCELONA_SEED];

/**
 * Injects the seed lines through the channel (each one is a real inbound
 * event the channel's handler, Trav, answers or ignores), setting the clock
 * to each line's time, then leaves the clock at `endAt`. Only lines whose
 * conversation the channel knows are sent. `beforeConversation` runs once
 * per conversation, at its first line's time, before that line is sent (the
 * simulator posts the family-mode notice there).
 */
export async function seedChat(
  channel: Pick<SimulatorChannel, 'injectMessage'>,
  clock: SimulatedClock,
  conversations: ReadonlySet<string>,
  endAt: IsoDateTime,
  beforeConversation?: (conversationId: string) => Promise<void>,
): Promise<void> {
  const started = new Set<string>();
  for (const line of DEMO_SEED) {
    if (!conversations.has(line.conversationId)) continue;
    clock.set(line.at);
    if (!started.has(line.conversationId)) {
      started.add(line.conversationId);
      await beforeConversation?.(line.conversationId);
    }
    await channel.injectMessage({
      from: line.from,
      text: line.text,
      conversationId: line.conversationId,
    });
  }
  clock.set(endAt);
}
