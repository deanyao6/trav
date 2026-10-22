import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { AuditEvent, AuditEventInput, AuditEventType } from '../domain/audit.js';
import { AUDIT_GENESIS_HASH } from '../domain/audit.js';
import { TravError } from '../errors.js';
import {
  PRIVATE_PAYLOAD_KEYS,
  assertAuditPayloadSafe,
  canonicalJson,
  computeAuditHash,
  computePayloadHash,
  findPrivatePayloadKeys,
  sealAuditEvent,
  verifyAuditChain,
} from './index.js';

const T0 = '2026-03-14T21:40:00+01:00';

function input(type: AuditEventType, overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    groupId: 'grp_barcelona',
    tripId: 'trip_barcelona',
    type,
    actor: { kind: 'trav', id: 'trav' },
    visibility: 'group',
    proposalId: 'prop_razz',
    payload: {},
    ...overrides,
  };
}

/** Seal a list of inputs into a chain with deterministic ids and timestamps. */
function chain(inputs: readonly AuditEventInput[]): AuditEvent[] {
  const out: AuditEvent[] = [];
  inputs.forEach((i, idx) => {
    const prev = out[idx - 1]?.hash ?? AUDIT_GENESIS_HASH;
    out.push(sealAuditEvent(i, `aud_${String(idx + 1).padStart(3, '0')}`, T0, prev));
  });
  return out;
}

const evaluated = (outcome: string, proposalId = 'prop_razz') =>
  input('policy.evaluated', {
    proposalId,
    payload: { outcome, reasons: ['default_confirm'], approvalMode: 'any_one' },
  });
const granted = (complete = true, proposalId = 'prop_razz') =>
  input('approval.granted', {
    proposalId,
    payload: { memberId: 'mem_dean', via: 'button', messageId: 'msg_1', complete },
  });
const completed = (proposalId = 'prop_razz') =>
  input('booking.completed', {
    proposalId,
    bookingId: 'bk_1',
    payload: {
      providerRef: 'ord_1',
      totalMinor: 9000,
      currency: 'EUR',
      payers: [],
      attendees: [],
      refundable: true,
    },
  });

describe('canonicalJson', () => {
  it('sorts keys recursively, drops undefined, keeps array order, no whitespace', () => {
    const a = { b: 1, a: { z: [3, { y: 1, x: 2 }], u: undefined }, c: null, s: 'x' };
    const b = { s: 'x', c: null, a: { u: undefined, z: [3, { x: 2, y: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"z":[3,{"x":2,"y":1}]},"b":1,"c":null,"s":"x"}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('matches JSON.stringify for strings, numbers, booleans; non-finite numbers become null', () => {
    expect(canonicalJson('a"b\n')).toBe(JSON.stringify('a"b\n'));
    expect(canonicalJson([1.5, -0, true, false, null, undefined])).toBe(
      '[1.5,0,true,false,null,null]',
    );
    expect(canonicalJson(Number.NaN)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('honours toJSON and rejects bigint', () => {
    expect(canonicalJson({ d: new Date(0) })).toBe('{"d":"1970-01-01T00:00:00.000Z"}');
    expect(() => canonicalJson({ n: 1n })).toThrow(TravError);
  });
});

describe('computeAuditHash / sealAuditEvent', () => {
  it('is sha256(prevHash + canonical JSON of every field but hash, with payload committed as its digest)', () => {
    const [e] = chain([evaluated('needs_confirmation')]);
    if (!e) throw new Error('unreachable');
    const { hash: _h, payload, ...header } = e;
    const payloadHash = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    expect(computePayloadHash(payload)).toBe(payloadHash);
    const expected = createHash('sha256')
      .update(e.prevHash + canonicalJson({ ...header, payloadHash }))
      .digest('hex');
    expect(e.hash).toBe(expected);
    expect(computeAuditHash(e)).toBe(expected);
    expect(e.prevHash).toBe(AUDIT_GENESIS_HASH);
  });

  it('every field participates in the hash', () => {
    const [e] = chain([evaluated('needs_confirmation')]);
    if (!e) throw new Error('unreachable');
    const variants: Partial<AuditEvent>[] = [
      { id: 'aud_x' },
      { ts: '2026-03-14T21:41:00+01:00' },
      { groupId: 'grp_other' },
      { tripId: null },
      { type: 'approval.requested' },
      { actor: { kind: 'member', id: 'mem_dean' } },
      { visibility: 'owner' },
      { proposalId: 'prop_other' },
      { prevHash: 'f'.repeat(64) },
      { payload: { outcome: 'deny' } },
      { lifecycle: { outcome: 'deny' } },
      { lifecycle: undefined } as unknown as Partial<AuditEvent>,
    ];
    const hashes = new Set(variants.map((v) => computeAuditHash({ ...e, ...v })));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(e.hash)).toBe(false);
  });

  it('derives the lifecycle header from the payload, accepts an explicit one, and refuses disagreement', () => {
    const [fromPayload] = chain([evaluated('deny')]);
    expect(fromPayload?.lifecycle).toEqual({ outcome: 'deny' });
    const [explicit] = chain([
      input('policy.evaluated', {
        lifecycle: { outcome: 'auto_approve' },
        payload: { reasons: [] },
      }),
    ]);
    expect(explicit?.lifecycle).toEqual({ outcome: 'auto_approve' });
    const [grant] = chain([granted(false)]);
    expect(grant?.lifecycle).toEqual({ complete: false });
    const [explicitGrant] = chain([
      input('approval.granted', {
        lifecycle: { complete: true },
        payload: { memberId: 'mem_dean' },
      }),
    ]);
    expect(explicitGrant?.lifecycle).toEqual({ complete: true });
    const [plain] = chain([input('proposal.created')]);
    expect(plain !== undefined && 'lifecycle' in plain).toBe(false);

    const seal = (i: AuditEventInput) => () => sealAuditEvent(i, 'aud_1', T0, AUDIT_GENESIS_HASH);
    expect(seal(input('policy.evaluated', { payload: { reasons: [] } }))).toThrow(/outcome/);
    expect(seal(evaluated('require_approval'))).toThrow(/outcome/);
    expect(
      seal(
        input('policy.evaluated', {
          lifecycle: { outcome: 'deny' },
          payload: { outcome: 'auto_approve' },
        }),
      ),
    ).toThrow(/disagrees/);
    expect(
      seal(input('policy.evaluated', { lifecycle: { outcome: 'deny', complete: true } })),
    ).toThrow(/complete/);
    expect(seal(input('approval.granted', { payload: { memberId: 'mem_dean' } }))).toThrow(
      /complete/,
    );
    expect(seal(input('approval.granted', { payload: { complete: 'true' } }))).toThrow(/complete/);
    expect(
      seal(
        input('approval.granted', { lifecycle: { complete: true }, payload: { complete: false } }),
      ),
    ).toThrow(/disagrees/);
    expect(
      seal(input('approval.granted', { lifecycle: { complete: true, outcome: 'deny' } })),
    ).toThrow(/outcome/);
    expect(seal(input('proposal.created', { lifecycle: { outcome: 'deny' } }))).toThrow(
      /lifecycle/,
    );
    // An empty header object on another type is harmless.
    expect(seal(input('proposal.created', { lifecycle: {} }))).not.toThrow();
  });

  it('a redacted payload changes the recomputed hash (so stored hashes are never recomputed)', () => {
    const [e] = chain([
      input('proposal.created', { payload: { kind: 'ticket', description: 'x' } }),
    ]);
    if (!e) throw new Error('unreachable');
    expect(computeAuditHash({ ...e, payload: {} })).not.toBe(e.hash);
  });

  it('refuses private payload keys and owner events without ownerId; validates prevHash', () => {
    expect(() =>
      sealAuditEvent(
        input('private.item_ingested', { payload: { bodyText: 'x' } }),
        'aud_1',
        T0,
        AUDIT_GENESIS_HASH,
      ),
    ).toThrow(TravError);
    expect(() =>
      sealAuditEvent(
        input('private.item_ingested', { visibility: 'owner' }),
        'aud_1',
        T0,
        AUDIT_GENESIS_HASH,
      ),
    ).toThrow(/ownerId/);
    expect(() => sealAuditEvent(evaluated('deny'), 'aud_1', T0, 'nope')).toThrow(TravError);
    const ok = sealAuditEvent(
      input('private.item_ingested', {
        visibility: 'owner',
        ownerId: 'mem_dean',
        payload: { itemId: 'priv_1' },
      }),
      'aud_1',
      T0,
      AUDIT_GENESIS_HASH,
    );
    expect(ok.ownerId).toBe('mem_dean');
  });
});

describe('private payload scan', () => {
  it('finds forbidden keys at any depth, in arrays, and in snake/upper variants; names paths not values', () => {
    const payload = {
      ok: 1,
      receipt: { ocrText: 'secret', items: [{ name: 'x' }, { merchant_raw: 'y' }] },
      card: { Last4: '1234' },
      nested: [[{ qrPayload: 'z' }]],
      promptId: 'fine',
      subjects: 'fine too',
    };
    expect(findPrivatePayloadKeys(payload)).toEqual([
      'receipt.ocrText',
      'receipt.items[1].merchant_raw',
      'card.Last4',
      'nested[0][0].qrPayload',
    ]);
    try {
      assertAuditPayloadSafe(input('ledger.entry_created', { payload }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TravError);
      expect((e as TravError).message).not.toContain('secret');
      expect((e as TravError).message).toContain('receipt.ocrText');
    }
  });

  it('every documented key is caught (B3)', () => {
    expect(PRIVATE_PAYLOAD_KEYS).toEqual([
      'bodyText',
      'ocrText',
      'last4',
      'accountId',
      'merchantRaw',
      'subject',
      'imageRef',
      'qrPayload',
      'prompt',
    ]);
    for (const key of PRIVATE_PAYLOAD_KEYS) {
      expect(findPrivatePayloadKeys({ [key]: 'x' })).toEqual([key]);
    }
    expect(
      findPrivatePayloadKeys({ amountMinor: 1, classifierLabel: 'shared', excerpt: 'ok' }),
    ).toEqual([]);
  });
});

describe('verifyAuditChain', () => {
  const happy = () =>
    chain([
      input('proposal.created'),
      evaluated('needs_confirmation'),
      input('approval.requested'),
      granted(),
      input('booking.attempted'),
      completed(),
      input('ledger.written'),
    ]);

  it('accepts an empty chain and the happy Razzmatazz chain, reporting the head hash', () => {
    expect(verifyAuditChain([])).toEqual({
      ok: true,
      count: 0,
      headHash: AUDIT_GENESIS_HASH,
      problems: [],
    });
    const h = happy();
    expect(verifyAuditChain(h)).toEqual({ ok: true, count: 7, headHash: h[6]?.hash, problems: [] });
    expect(verifyAuditChain(h, { expectedHeadHash: h[6]?.hash ?? '' }).ok).toBe(true);
    expect(verifyAuditChain([], { expectedHeadHash: AUDIT_GENESIS_HASH }).ok).toBe(true);
    expect(verifyAuditChain([], { expectedHeadHash: 'a'.repeat(64) }).problems).toEqual([
      { index: -1, eventId: null, problem: 'head_mismatch' },
    ]);
  });

  it('detects a tampered payload (hash mismatch) and the broken link that follows nothing else', () => {
    const h = happy();
    const tampered = h.map((e, i) =>
      i === 5 ? { ...e, payload: { ...e.payload, totalMinor: 1 } } : e,
    );
    const r = verifyAuditChain(tampered);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ index: 5, eventId: 'aud_006', problem: 'hash_mismatch' }]);
  });

  it('detects a tampered event that was re-hashed (the next link breaks)', () => {
    const h = happy();
    const e5 = h[5];
    if (!e5) throw new Error('unreachable');
    const rehashed = { ...e5, payload: { ...e5.payload, totalMinor: 1 } };
    const forged = { ...rehashed, hash: computeAuditHash(rehashed) };
    const r = verifyAuditChain(h.map((e, i) => (i === 5 ? forged : e)));
    expect(r.problems).toEqual([{ index: 6, eventId: 'aud_007', problem: 'prev_hash_mismatch' }]);
  });

  it('detects a missing middle event, a reordered pair, and a wrong genesis', () => {
    const h = happy();
    expect(verifyAuditChain(h.filter((_, i) => i !== 2)).problems).toEqual([
      { index: 2, eventId: 'aud_004', problem: 'prev_hash_mismatch' },
    ]);
    const swapped = [...h];
    [swapped[3], swapped[4]] = [swapped[4] as AuditEvent, swapped[3] as AuditEvent];
    // Links break at the two swapped positions and at the event that followed them.
    expect(
      verifyAuditChain(swapped).problems.map((p) => `${String(p.index)}:${p.problem}`),
    ).toEqual(['3:prev_hash_mismatch', '4:prev_hash_mismatch', '5:prev_hash_mismatch']);
    expect(verifyAuditChain(h.slice(1)).problems).toEqual([
      { index: 0, eventId: 'aud_002', problem: 'genesis_mismatch' },
    ]);
  });

  it('detects a missing tail event only against the expected head hash', () => {
    const h = happy();
    const truncated = h.slice(0, 6);
    expect(verifyAuditChain(truncated).ok).toBe(true);
    expect(verifyAuditChain(truncated, { expectedHeadHash: h[6]?.hash ?? '' }).problems).toEqual([
      { index: 5, eventId: 'aud_006', problem: 'head_mismatch' },
    ]);
  });

  it('booking.completed without a preceding policy.evaluated for the same proposal (B1)', () => {
    const noEval = chain([input('proposal.created'), granted(), completed()]);
    expect(verifyAuditChain(noEval).problems).toEqual([
      { index: 2, eventId: 'aud_003', problem: 'completed_without_evaluation' },
    ]);
    const otherProposal = chain([
      evaluated('needs_confirmation', 'prop_other'),
      granted(true, 'prop_other'),
      completed('prop_razz'),
    ]);
    expect(verifyAuditChain(otherProposal).problems.map((p) => p.problem)).toEqual([
      'completed_without_evaluation',
    ]);
    const afterwards = chain([completed(), evaluated('needs_confirmation'), granted()]);
    expect(verifyAuditChain(afterwards).problems.map((p) => p.problem)).toEqual([
      'completed_without_evaluation',
    ]);
  });

  it('booking.completed without a preceding complete approval.granted (B1)', () => {
    const noGrant = chain([evaluated('needs_confirmation'), completed()]);
    expect(verifyAuditChain(noGrant).problems).toEqual([
      { index: 1, eventId: 'aud_002', problem: 'completed_without_grant' },
    ]);
    const partial = chain([evaluated('needs_confirmation'), granted(false), completed()]);
    expect(verifyAuditChain(partial).problems.map((p) => p.problem)).toEqual([
      'completed_without_grant',
    ]);
    const wrongProposal = chain([
      evaluated('needs_confirmation'),
      granted(true, 'prop_other'),
      completed(),
    ]);
    expect(verifyAuditChain(wrongProposal).problems.map((p) => p.problem)).toEqual([
      'completed_without_grant',
    ]);
    const grantedLater = chain([evaluated('needs_confirmation'), completed(), granted()]);
    expect(verifyAuditChain(grantedLater).problems.map((p) => p.problem)).toEqual([
      'completed_without_grant',
    ]);
  });

  it('auto_approve needs no approval.granted; a denied evaluation is never completable', () => {
    expect(verifyAuditChain(chain([evaluated('auto_approve'), completed()])).ok).toBe(true);
    expect(
      verifyAuditChain(chain([evaluated('deny'), completed()])).problems.map((p) => p.problem),
    ).toEqual(['completed_after_deny']);
    // A complete grant does not override a deny (the executor must refuse: decision_denied).
    expect(verifyAuditChain(chain([evaluated('deny'), granted(), completed()])).problems).toEqual([
      { index: 2, eventId: 'aud_003', problem: 'completed_after_deny' },
    ]);
    // deny after a grant: the re-evaluation is the latest word.
    expect(
      verifyAuditChain(
        chain([evaluated('needs_confirmation'), granted(), evaluated('deny'), completed()]),
      ).problems.map((p) => p.problem),
    ).toEqual(['completed_after_deny']);
  });

  it('a later re-evaluation supersedes the earlier outcome and drops the earlier grant', () => {
    const reEvaluated = chain([
      evaluated('auto_approve'),
      evaluated('needs_confirmation'),
      completed(),
    ]);
    expect(verifyAuditChain(reEvaluated).problems.map((p) => p.problem)).toEqual([
      'completed_without_grant',
    ]);
    // A grant for the old decision does not carry over to a new one (new price, new approvers).
    const staleGrant = chain([
      evaluated('needs_confirmation'),
      granted(),
      evaluated('needs_confirmation'),
      completed(),
    ]);
    expect(verifyAuditChain(staleGrant).problems).toEqual([
      { index: 3, eventId: 'aud_004', problem: 'completed_without_grant' },
    ]);
    // Re-approved after the re-evaluation: fine.
    expect(
      verifyAuditChain(
        chain([
          evaluated('needs_confirmation'),
          granted(),
          evaluated('needs_confirmation'),
          granted(),
          completed(),
        ]),
      ).ok,
    ).toBe(true);
  });

  it('approval.invalidated / rejected / expired revoke the grant (A8)', () => {
    const revocations: readonly [AuditEventType, Record<string, unknown>][] = [
      ['approval.invalidated', { cause: 'price_changed', grantId: 'grant_1' }],
      ['approval.rejected', { memberId: 'mem_sam', messageId: 'msg_2' }],
      ['approval.expired', { expiresAt: T0 }],
      ['proposal.superseded', { supersededBy: 'prop_2', cause: 'roster_changed' }],
    ];
    for (const [type, payload] of revocations) {
      const revoked = chain([
        evaluated('needs_confirmation'),
        granted(),
        input(type, { payload }),
        completed(),
      ]);
      expect(verifyAuditChain(revoked).problems, type).toEqual([
        { index: 3, eventId: 'aud_004', problem: 'completed_without_grant' },
      ]);
      // A revocation for another proposal leaves this grant standing.
      const other = chain([
        evaluated('needs_confirmation'),
        granted(),
        input(type, { proposalId: 'prop_other', payload }),
        completed(),
      ]);
      expect(verifyAuditChain(other).ok, type).toBe(true);
      // Re-granted after the revocation (new tap on a still-valid proposal): fine.
      const regranted = chain([
        evaluated('needs_confirmation'),
        granted(),
        input(type, { payload }),
        granted(),
        completed(),
      ]);
      expect(verifyAuditChain(regranted).ok, type).toBe(true);
    }
  });

  it('a second booking.completed for the same proposal is duplicate_completion (A5)', () => {
    const twice = chain([evaluated('needs_confirmation'), granted(), completed(), completed()]);
    expect(verifyAuditChain(twice).problems).toEqual([
      { index: 3, eventId: 'aud_004', problem: 'duplicate_completion' },
    ]);
    // Even with a fresh evaluation and grant in between: one proposal, one purchase.
    const reRun = chain([
      evaluated('needs_confirmation'),
      granted(),
      completed(),
      evaluated('needs_confirmation'),
      granted(),
      completed(),
    ]);
    expect(verifyAuditChain(reRun).problems.map((p) => p.problem)).toEqual([
      'duplicate_completion',
    ]);
    // Two different proposals each completing once is fine.
    const two = chain([
      evaluated('needs_confirmation'),
      granted(),
      completed(),
      evaluated('needs_confirmation', 'prop_other'),
      granted(true, 'prop_other'),
      completed('prop_other'),
    ]);
    expect(verifyAuditChain(two).ok).toBe(true);
  });

  it('rejects an unknown outcome or a non-boolean completion instead of guessing', () => {
    // Forge the header directly: sealAuditEvent refuses to build these.
    const [e1, e2] = chain([evaluated('needs_confirmation'), completed()]);
    if (!e1 || !e2) throw new Error('unreachable');
    const forged = { ...e1, lifecycle: { outcome: 'require_approval' } } as unknown as AuditEvent;
    const rehashed = { ...forged, hash: computeAuditHash(forged) };
    const next = { ...e2, prevHash: rehashed.hash };
    const r = verifyAuditChain([rehashed, { ...next, hash: computeAuditHash(next) }]);
    expect(r.problems.map((p) => p.problem)).toEqual([
      'unknown_outcome',
      'completed_without_grant',
    ]);
    const stripped = { ...e1, lifecycle: undefined } as unknown as AuditEvent;
    expect(
      verifyAuditChain([{ ...stripped, hash: computeAuditHash(stripped) }]).problems.map(
        (p) => p.problem,
      ),
    ).toEqual(['unknown_outcome']);

    const [g] = chain([granted()]);
    if (!g) throw new Error('unreachable');
    const badGrant = { ...g, lifecycle: { complete: 'yes' } } as unknown as AuditEvent;
    expect(
      verifyAuditChain([{ ...badGrant, hash: computeAuditHash(badGrant) }]).problems.map(
        (p) => p.problem,
      ),
    ).toEqual(['unknown_grant_completion']);
  });

  it('owner events must carry ownerId; private keys in any payload fail; mixed groups fail', () => {
    const [e] = chain([
      input('private.item_ingested', { visibility: 'owner', ownerId: 'mem_dean' }),
    ]);
    if (!e) throw new Error('unreachable');
    const stripped = { ...e, ownerId: undefined } as unknown as AuditEvent;
    expect(
      verifyAuditChain([{ ...stripped, hash: computeAuditHash(stripped) }]).problems.map(
        (p) => p.problem,
      ),
    ).toEqual(['owner_event_missing_owner']);

    const leaky = { ...e, payload: { last4: '1234' } };
    expect(
      verifyAuditChain([{ ...leaky, hash: computeAuditHash(leaky) }]).problems.map(
        (p) => p.problem,
      ),
    ).toEqual(['payload_contains_private_field']);

    const [a] = chain([input('message.sent')]);
    if (!a) throw new Error('unreachable');
    const bInput = input('message.sent', { groupId: 'grp_other' });
    const b = sealAuditEvent(bInput, 'aud_002', T0, a.hash);
    expect(verifyAuditChain([a, b]).problems).toEqual([
      { index: 1, eventId: 'aud_002', problem: 'group_mismatch' },
    ]);
  });

  it('reports multiple problems with indexes and ids', () => {
    const h = chain([evaluated('needs_confirmation'), completed()]);
    const broken = h.map((e, i) => (i === 0 ? { ...e, ts: '2026-03-14T21:41:00+01:00' } : e));
    const r = verifyAuditChain(broken);
    expect(r.count).toBe(2);
    expect(r.problems).toEqual([
      { index: 0, eventId: 'aud_001', problem: 'hash_mismatch' },
      { index: 1, eventId: 'aud_002', problem: 'completed_without_grant' },
    ]);
  });
});
