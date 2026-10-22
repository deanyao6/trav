import { describe, expect, it } from 'vitest';
import type { AuditEvent, AuditEventInput, AuditEventType } from '../domain/audit.js';
import { AUDIT_GENESIS_HASH } from '../domain/audit.js';
import { TravError } from '../errors.js';
import {
  computeAuditHash,
  computePayloadHash,
  findPrivatePayloadKeys,
  isTombstone,
  redactedPayloadHash,
  sealAuditEvent,
  tombstonePayload,
  verifyAuditChain,
} from './index.js';

// Redacted tombstones (SAFETY §2.9, D-016): the storage layer's retention/deletion
// jobs replace a payload with `{ redacted: true, payloadHash }` while
// id/ts/prevHash/hash/lifecycle stay exactly as stored.

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

function chain(inputs: readonly AuditEventInput[]): AuditEvent[] {
  const out: AuditEvent[] = [];
  inputs.forEach((i, idx) => {
    const prev = out[idx - 1]?.hash ?? AUDIT_GENESIS_HASH;
    out.push(sealAuditEvent(i, `aud_${String(idx + 1).padStart(3, '0')}`, T0, prev));
  });
  return out;
}

const evaluated = (outcome: string) =>
  input('policy.evaluated', { payload: { outcome, reasons: ['default_confirm'] } });
const granted = (complete = true) =>
  input('approval.granted', {
    payload: { memberId: 'mem_dean', via: 'button', messageId: 'msg_1', complete },
  });
const completed = () =>
  input('booking.completed', {
    bookingId: 'bk_1',
    payload: { providerRef: 'ord_1', totalMinor: 9000, currency: 'EUR' },
  });

const happy = () =>
  chain([
    input('proposal.created', { payload: { kind: 'ticket', description: 'razzmatazz' } }),
    evaluated('needs_confirmation'),
    granted(),
    completed(),
    input('ledger.written'),
  ]);

/** What the storage layer does: swap the payload for its digest tombstone, keep everything else as stored. */
const redact = (events: readonly AuditEvent[], ...indexes: readonly number[]): AuditEvent[] =>
  events.map((e, i) => (indexes.includes(i) ? { ...e, payload: tombstonePayload(e.payload) } : e));

const problemsOf = (events: readonly AuditEvent[]) =>
  verifyAuditChain(events).problems.map((p) => p.problem);

describe('tombstonePayload / redactedPayloadHash', () => {
  it('builds the digest tombstone and recognises exactly that form', () => {
    const original = { kind: 'ticket', totalMinor: 9000 };
    const tomb = tombstonePayload(original);
    expect(tomb).toEqual({ redacted: true, payloadHash: computePayloadHash(original) });
    expect(redactedPayloadHash(tomb)).toBe(computePayloadHash(original));
    expect(isTombstone(tomb)).toBe(true);
    expect(redactedPayloadHash({ payloadHash: 'a'.repeat(64), redacted: true })).toBe(
      'a'.repeat(64),
    );
    for (const notTombstone of [
      {},
      { redacted: true },
      { redacted: false, payloadHash: 'a'.repeat(64) },
      { redacted: 'true', payloadHash: 'a'.repeat(64) },
      { redacted: true, note: 'x' },
      { redacted: true, payloadHash: 'short' },
      { redacted: true, payloadHash: 'A'.repeat(64) },
      { redacted: true, payloadHash: 'a'.repeat(64), extra: 1 },
    ]) {
      expect(redactedPayloadHash(notTombstone)).toBeUndefined();
      expect(isTombstone(notTombstone)).toBe(false);
    }
    expect(findPrivatePayloadKeys(tomb)).toEqual([]);
  });

  it('a fresh event cannot be sealed with a tombstone-shaped payload; a bare { redacted: true } is an ordinary payload', () => {
    expect(() =>
      sealAuditEvent(
        input('data.deleted', { payload: tombstonePayload({ scope: 'trip' }) }),
        'aud_1',
        T0,
        AUDIT_GENESIS_HASH,
      ),
    ).toThrow(TravError);
    const [e] = chain([input('data.deleted', { payload: { redacted: true } })]);
    expect(e !== undefined && verifyAuditChain([e]).ok).toBe(true);
  });
});

describe('verifyAuditChain with redacted events', () => {
  it('a redacted chain verifies in full: tombstone in the middle, at the head, every event at once', () => {
    const h = happy();
    expect(verifyAuditChain(redact(h, 0))).toEqual({
      ok: true,
      count: 5,
      headHash: h[4]?.hash,
      problems: [],
    });
    expect(verifyAuditChain(redact(h, 4), { expectedHeadHash: h[4]?.hash ?? '' }).ok).toBe(true);
    expect(
      verifyAuditChain(redact(h, 0, 1, 2, 3, 4), { expectedHeadHash: h[4]?.hash ?? '' }).ok,
    ).toBe(true);
    expect(verifyAuditChain(redact(h, 0, 2)).ok).toBe(true);
  });

  it('the bare { redacted: true } tombstone of the old design is a hash_mismatch (nothing vouches for it)', () => {
    const h = happy();
    const bare = h.map((e, i) => (i === 1 ? { ...e, payload: { redacted: true } } : e));
    expect(problemsOf(bare)).toEqual(['hash_mismatch']);
  });

  it('a tombstoned policy.evaluated keeps its outcome in the header, so auto_approve still needs no grant and deny still fails', () => {
    const autoChain = chain([evaluated('auto_approve'), completed()]);
    expect(verifyAuditChain(redact(autoChain, 0)).ok).toBe(true);
    const denyChain = chain([evaluated('deny'), granted(), completed()]);
    expect(problemsOf(redact(denyChain, 0, 1))).toEqual(['completed_after_deny']);
    expect(verifyAuditChain(redact(happy(), 1)).ok).toBe(true);
  });

  it('a tombstoned incomplete grant cannot launder a purchase; a tombstoned complete grant still counts', () => {
    const partial = chain([evaluated('needs_confirmation'), granted(false), completed()]);
    expect(problemsOf(partial)).toEqual(['completed_without_grant']);
    expect(problemsOf(redact(partial, 1))).toEqual(['completed_without_grant']);
    expect(problemsOf(redact(partial, 0, 1, 2))).toEqual(['completed_without_grant']);
    const full = chain([evaluated('needs_confirmation'), granted(true), completed()]);
    expect(verifyAuditChain(redact(full, 1)).ok).toBe(true);
    // Forging `complete: true` into the tombstoned grant's header breaks its hash.
    const forged = redact(full, 1).map((e, i) =>
      i === 1 ? ({ ...e, lifecycle: { complete: true } } as AuditEvent) : e,
    );
    expect(verifyAuditChain(forged).ok).toBe(true); // unchanged header: still true
    const laundered = redact(partial, 1).map((e, i) =>
      i === 1 ? ({ ...e, lifecycle: { complete: true } } as AuditEvent) : e,
    );
    expect(problemsOf(laundered)).toEqual(['hash_mismatch']);
  });

  it('a redacted event with a broken link fails: prevHash altered, hash altered, hash malformed', () => {
    const h = happy();
    const badPrev = redact(h, 2).map((e, i) => (i === 2 ? { ...e, prevHash: 'f'.repeat(64) } : e));
    expect(verifyAuditChain(badPrev).problems).toEqual([
      { index: 2, eventId: 'aud_003', problem: 'prev_hash_mismatch' },
      { index: 2, eventId: 'aud_003', problem: 'hash_mismatch' },
    ]);

    const badHash = redact(h, 2).map((e, i) => (i === 2 ? { ...e, hash: 'e'.repeat(64) } : e));
    expect(verifyAuditChain(badHash).problems).toEqual([
      { index: 2, eventId: 'aud_003', problem: 'hash_mismatch' },
      { index: 3, eventId: 'aud_004', problem: 'prev_hash_mismatch' },
    ]);

    const badHead = redact(h, 4).map((e, i) => (i === 4 ? { ...e, hash: 'e'.repeat(64) } : e));
    expect(problemsOf(badHead)).toEqual(['hash_mismatch']);
    expect(
      verifyAuditChain(badHead, { expectedHeadHash: h[4]?.hash ?? '' }).problems.map(
        (p) => p.problem,
      ),
    ).toEqual(['hash_mismatch', 'head_mismatch']);

    const malformed = redact(h, 2).map((e, i) => (i === 2 ? { ...e, hash: 'not-a-hash' } : e));
    expect(problemsOf(malformed)).toEqual(['hash_mismatch', 'prev_hash_mismatch']);
  });

  it('a tombstone detects any altered header field, including the lifecycle header', () => {
    const h = happy();
    const variants: Partial<AuditEvent>[] = [
      { ts: '2026-03-14T21:41:00+01:00' },
      { type: 'approval.rejected' },
      { actor: { kind: 'member', id: 'mem_henry' } },
      { proposalId: 'prop_other' },
      { id: 'aud_999' },
      { visibility: 'owner', ownerId: 'mem_dean' },
      { bookingId: 'bk_2' },
      { tripId: null },
      { groupId: 'grp_other' },
      { lifecycle: { complete: false } },
      { lifecycle: undefined } as unknown as Partial<AuditEvent>,
    ];
    for (const v of variants) {
      const tampered = redact(h, 2).map((e, i) => (i === 2 ? ({ ...e, ...v } as AuditEvent) : e));
      // Changing type/proposalId/lifecycle on the grant also breaks the booking lifecycle check,
      // so some variants report a second (correct) problem; the hash one is always first.
      expect(verifyAuditChain(tampered).problems[0], JSON.stringify(v)).toMatchObject({
        index: 2,
        problem: 'hash_mismatch',
      });
    }
    const wrongDigest = redact(h, 2).map((e, i) =>
      i === 2 ? { ...e, payload: { redacted: true, payloadHash: 'b'.repeat(64) } } : e,
    );
    expect(problemsOf(wrongDigest)).toEqual(['hash_mismatch']);
  });

  it('a payload altered to anything other than the exact digest tombstone fails', () => {
    const h = happy();
    for (const payload of [
      {},
      { redacted: true },
      { redacted: false },
      { redacted: 'true' },
      { redacted: true, note: 'see ticket' },
      { redacted: true, payloadHash: 'short' },
      { redacted: true, payloadHash: computePayloadHash(h[1]?.payload), extra: 1 },
      { outcome: 'auto_approve' },
      { outcome: 'needs_confirmation', reasons: ['default_confirm'], extra: 1 },
    ]) {
      const forged = h.map((e, i) => (i === 1 ? { ...e, payload } : e));
      expect(problemsOf(forged), JSON.stringify(payload)).toContain('hash_mismatch');
    }
  });

  it('redaction is idempotent for the verifier and does not change the recomputed header hash', () => {
    const h = happy();
    const once = redact(h, 1);
    const e = once[1];
    if (!e) throw new Error('unreachable');
    expect(isTombstone(e.payload)).toBe(true);
    // Recomputing from the tombstone as if it were an ordinary payload would differ: hashes must never be recomputed.
    expect(computeAuditHash(e)).not.toBe(e.hash);
    expect(verifyAuditChain(once).ok).toBe(true);
  });
});
