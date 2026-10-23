/**
 * Strict scenario validation: every committed scenario loads, and each kind
 * of typo (unknown key at any level, missing required field, bad enum, bad
 * probe, bad SAFETY id) is rejected instead of grading nothing.
 */
import { describe, expect, it } from 'vitest';
import { runProbe } from './runner/probes.js';
import { loadScenarios, validateScenario } from './scenarios.js';
import type { ProbeName } from './types.js';

const base = {
  id: 'typo_case',
  title: 'typo case',
  tags: ['voice'],
  steps: [{ do: 'say', from: 'h_dean', text: '@trav hi' }],
};

function withStep(step: Record<string, unknown>): Record<string, unknown> {
  return { ...base, steps: [step] };
}

const say = { do: 'say', from: 'h_dean', text: '@trav hi' };

describe('validateScenario', () => {
  it('every committed scenario validates', () => {
    const all = loadScenarios();
    expect(all.length).toBeGreaterThanOrEqual(52);
  });

  it('accepts a minimal scenario', () => {
    expect(validateScenario(base, 'x').id).toBe('typo_case');
  });

  const rejects: readonly [string, Record<string, unknown>, RegExp][] = [
    // the reviewer's repro: misspelled expectation keys
    [
      'unknown step expect key',
      withStep({ ...say, expect: { mustNotContian: ['razzmatazz'] } }),
      /unknown key "mustNotContian"/,
    ],
    ['unknown step expect key (silnet)', withStep({ ...say, expect: { silnet: true } }), /silnet/],
    ['unknown step key', withStep({ ...say, lnae: 'dm' }), /unknown key "lnae"/],
    ['unknown scenario key', { ...base, chekclist: ['A9'] }, /unknown key "chekclist"/],
    ['unknown setup key', { ...base, setup: { grop: 'lisbon' } }, /unknown key "grop"/],
    [
      'unknown scenario expect key',
      { ...base, expect: { maxPurchase: 0 } },
      /unknown key "maxPurchase"/,
    ],
    [
      'unknown nested expect key (proposal)',
      withStep({ ...say, expect: { proposal: { attendees: [], payers: [], exclude: [] } } }),
      /unknown key "exclude"/,
    ],
    [
      'unknown consent flag',
      { ...base, setup: { consent: { mem_sam: { photo: true } } } },
      /unknown key "photo"/,
    ],
    ['unknown tickets key', { ...base, expect: { tickets: { to: [], nTo: [] } } }, /nTo/],
    // per-kind required fields
    ['say without from', withStep({ do: 'say', text: 'hi' }), /missing required "from"/],
    ['say without text', withStep({ do: 'say', from: 'h_dean' }), /missing required "text"/],
    ['react without target', withStep({ do: 'react', from: 'h_dean', reaction: '👍' }), /"target"/],
    ['tap without actionId', withStep({ do: 'tap', from: 'h_dean', target: 'x' }), /"actionId"/],
    [
      'intake without text',
      withStep({ do: 'intake', owner: 'mem_sam', source: 'email_receipt', itemId: 'i' }),
      /"text"/,
    ],
    [
      'remember without lane',
      withStep({ do: 'remember', memberId: 'm', text: 't', category: 'other' }),
      /"lane"/,
    ],
    ['patch_member without patch', withStep({ do: 'patch_member', memberId: 'm' }), /"patch"/],
    ['injection without fixture', withStep({ do: 'injection' }), /"fixture"/],
    ['advance with neither minutes nor to', withStep({ do: 'advance' }), /minutes" or "to"/],
    [
      'proposal without payers',
      withStep({ ...say, expect: { proposal: { attendees: [] } } }),
      /"payers"/,
    ],
    [
      'identity without safetyId',
      withStep({ ...say, expect: { identity: { noEffect: true } } }),
      /"safetyId"/,
    ],
    // enums and types
    ['bad lane', withStep({ ...say, lane: 'direct' }), /lane: must be one of group, dm/],
    [
      'bad intake source',
      withStep({ do: 'intake', owner: 'm', source: 'fax', itemId: 'i', text: 't' }),
      /fax/,
    ],
    ['bad model source', withStep({ ...say, expect: { modelSource: 'scripted' } }), /scripted/],
    ['bad silent type', withStep({ ...say, expect: { silent: 'yes' } }), /true or false/],
    ['bad purchases', withStep({ ...say, expect: { purchases: -1 } }), /≥ 0/],
    ['bad group', { ...base, setup: { group: 'paris' } }, /paris/],
    ['bad ledgerGroundTruth', { ...base, expect: { ledgerGroundTruth: 'paris' } }, /paris/],
    ['bad mention precision', { ...base, expect: { mentionPrecision: 2 } }, /between 0 and 1/],
    ['unknown kind', withStep({ do: 'sing' }), /unknown kind "sing"/],
    ['bad tag', { ...base, tags: ['vibes'] }, /vibes/],
    // probes
    ['unknown probe', withStep({ do: 'probe', probe: 'bogus_probe' }), /bogus_probe/],
    [
      'unknown probe arg',
      withStep({ do: 'probe', probe: 'flights', args: { fast: true } }),
      /unknown key "fast"/,
    ],
    ['ledger probe without trips', withStep({ do: 'probe', probe: 'ledger', args: {} }), /"trips"/],
    [
      'album probe with a bad trip',
      withStep({ do: 'probe', probe: 'album_consent', args: { trip: 'paris' } }),
      /paris/,
    ],
    // SAFETY ids
    [
      'identity.safetyId outside E2/E3/E5',
      withStep({ ...say, expect: { identity: { safetyId: 'A9' } } }),
      /must be one of E2, E3, E5/,
    ],
    ['checklist id not in SAFETY §3', { ...base, checklist: ['H9'] }, /checklist id/],
    ['checklist id malformed', { ...base, checklist: ['a9'] }, /checklist id/],
    // weights
    ['weight for an unknown grader', { ...base, weights: { voice_lnit: 2 } }, /unknown grader/],
    ['pendingNote without pending', { ...base, pendingNote: 'x' }, /pendingNote without pending/],
  ];

  for (const [name, raw, msg] of rejects) {
    it(`rejects: ${name}`, () => {
      expect(() => validateScenario(raw, 'test.json[0]')).toThrow(msg);
    });
  }

  it('names the file, scenario and step in the error', () => {
    expect(() =>
      validateScenario(withStep({ ...say, expect: { silnet: true } }), 'booking.json[3]'),
    ).toThrow(/scenario booking\.json\[3\]#typo_case step 0\.expect: unknown key "silnet"/);
  });
});

describe('runProbe', () => {
  it('throws on an unknown probe instead of returning nothing', async () => {
    await expect(
      runProbe('bogus_probe' as ProbeName, undefined, { model: undefined as never }),
    ).rejects.toThrow(/unknown probe bogus_probe/);
  });
});
