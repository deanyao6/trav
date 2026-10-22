/**
 * Test support for the grader, scoring and report tests (not exported from
 * the package). Two kinds of fixture:
 *
 * - real episodes: a scenario from `scenarios/*.json` run offline once and
 *   cached, used as the "should pass" fixture;
 * - synthetic episodes / mutations of real ones, used as the "should be
 *   caught" fixture (a realistic defect injected into a real episode).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent, AuditEventInput, OutboundMessage } from '@trav/core';
import { AUDIT_GENESIS_HASH, audit } from '@trav/core';
import { runScenario } from './runner/run.js';
import { loadGroupFixture } from './runner/seed.js';
import { loadScenarios } from './scenarios.js';
import type { Episode, GradeContext, Scenario, StepRecord } from './types.js';

export const OFFLINE: GradeContext = { mode: 'offline' };

let scenarios: Scenario[] | undefined;

export function scenarioById(id: string): Scenario {
  scenarios ??= loadScenarios();
  const s = scenarios.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return s;
}

const realCache = new Map<string, Promise<Episode>>();
let stateDir: string | undefined;

/** The scenario run offline (cached per test file). Returns a deep copy so tests can mutate it. */
export async function realEpisode(id: string): Promise<Episode> {
  stateDir ??= mkdtempSync(join(tmpdir(), 'trav-evals-test-'));
  const dir = stateDir;
  let hit = realCache.get(id);
  if (hit === undefined) {
    hit = runScenario(scenarioById(id), { mode: 'offline', stateDir: dir });
    realCache.set(id, hit);
  }
  return structuredClone(await hit);
}

/** A minimal scenario for synthetic episodes. */
export function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'synthetic',
    title: 'synthetic',
    tags: ['safety'],
    checklist: ['A3'],
    steps: [{ do: 'drain' }],
    ...over,
  };
}

export function step(over: Partial<StepRecord> = {}): StepRecord {
  return {
    index: 0,
    kind: 'say',
    label: 'h_dean: test',
    lane: 'group',
    at: '2026-03-14T21:40:00+01:00',
    auditTypes: [],
    auditFrom: 0,
    auditTo: 0,
    newProposalIds: [],
    newProposals: [],
    newExpenseIds: [],
    purchasesAfter: 0,
    proactive: false,
    minors: [],
    ...over,
  };
}

/** A synthetic Barcelona episode: roster from the fixture, nothing happened. */
export function episode(over: Partial<Episode> = {}): Episode {
  const f = loadGroupFixture('barcelona');
  return {
    scenarioId: 'synthetic',
    mode: 'offline',
    steps: [],
    transcript: [],
    audit: [],
    snapshot: {
      group: f.group,
      members: f.members,
      trip: f.trip,
      proposals: [],
      bookings: [],
      expenses: [],
      entries: [],
      groupMemory: [],
      consent: {},
      ticketsByHolder: {},
    },
    prompts: [],
    lint: [],
    probes: [],
    purchases: 0,
    charges: 0,
    skippedLines: [],
    privateStrings: [],
    expect: {},
    ...over,
  };
}

type ChainInput = Omit<AuditEventInput, 'groupId' | 'tripId' | 'actor' | 'visibility'> &
  Partial<Pick<AuditEventInput, 'actor' | 'visibility'>>;

/** A valid, sealed audit chain for `grp_barcelona` (hashes link from genesis). */
export function chain(inputs: readonly ChainInput[]): AuditEvent[] {
  const out: AuditEvent[] = [];
  inputs.forEach((input, i) => {
    out.push(
      audit.sealAuditEvent(
        {
          groupId: 'grp_barcelona',
          tripId: 'trip_barcelona',
          actor: { kind: 'trav', id: 'trav' },
          visibility: 'group',
          ...input,
        },
        `aud_test_${String(i)}`,
        `2026-03-14T21:${String(40 + i).padStart(2, '0')}:00+01:00`,
        out[i - 1]?.hash ?? AUDIT_GENESIS_HASH,
      ),
    );
  });
  return out;
}

/** A group or DM message (only the fields graders read are required). */
export function message(over: Partial<OutboundMessage> & { text: string }): OutboundMessage {
  return {
    id: `msg_test_${over.text.length.toString(36)}`,
    groupId: 'grp_barcelona',
    to: { kind: 'group' },
    ...over,
  };
}

/** A ticket card for `owner`, delivered to `deliveredTo` (default owner). */
export function ticketCard(
  owner: string,
  deliveredTo = owner,
): NonNullable<OutboundMessage['card']> {
  return {
    type: 'ticket',
    bookingId: 'bkg_test',
    ownerMemberId: owner,
    deliveredTo,
    event: { name: 'Razzmatazz', venue: 'Razzmatazz', startsAt: '2026-03-14T23:30:00+01:00' },
    qr: { dataUrl: 'data:image/png;base64,AAAA', payload: `RZZ-${owner}-0001` },
    holderName: owner,
  } as unknown as NonNullable<OutboundMessage['card']>;
}
