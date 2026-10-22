import { describe, expect, it } from 'vitest';
import type { AuditEvent, AuditEventInput, AuditEventType } from '../domain/audit.js';
import { AUDIT_GENESIS_HASH } from '../domain/audit.js';
import {
  computePayloadHash,
  findPrivatePayloadKeys,
  redactedPayloadHash,
  sealAuditEvent,
  verifyAuditChain,
} from './index.js';

// Redacted tombstones (SAFETY §2.9): the storage layer's retention/deletion jobs
// replace a payload with `{ redacted: true }` (optionally keeping `payloadHash`)
// while id/ts/prevHash/hash stay exactly as stored.

const T0 = '2026-03-14T21:40:00+01:00';
const TOMBSTONE = { redacted: true } as const;

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
const granted = () =>
  input('approval.granted', {
    payload: { memberId: 'mem_dean', via: 'button', messageId: 'msg_1', complete: true },
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

// What the storage layer does: swap the payload, keep everything else as stored.
const redact = (events: readonly AuditEvent[], index: number, keepDigest = false): AuditEvent[] =>
  events.map((e, i) =>
    i === index
      ? {
          ...e,
          payload: keepDigest
            ? { redacted: true, payloadHash: computePayloadHash(e.payload) }
            : TOMBSTONE,
        }
      : e,
  );

describe('redactedPayloadHash', () => {
  it('recognises the two tombstone forms and nothing else', () => {
    expect(redactedPayloadHash(TOMBSTONE)).toBeNull();
    expect(redactedPayloadHash({ redacted: true, payloadHash: 'a'.repeat(64) })).toBe(
      'a'.repeat(64),
    );
    for (const notTombstone of [
      {},
      { redacted: false },
      { redacted: 'true' },
      { redacted: true, note: 'x' },
      { redacted: true, payloadHash: 'short' },
      { redacted: true, payloadHash: 'A'.repeat(64) },
      { redacted: true, payloadHash: 'a'.repeat(64), extra: 1 },
    ]) {
      expect(redactedPayloadHash(notTombstone)).toBeUndefined();
    }
  });
});

describe('verifyAuditChain with redacted events', () => {
  it('a redacted chain verifies: tombstone in the middle, at the head, all at once, with digests', () => {
    const h = happy();
    expect(verifyAuditChain(redact(h, 0))).toEqual({ ok: true, count: 5, problems: [] });
    expect(verifyAuditChain(redact(h, 4), { expectedHeadHash: h[4]?.hash ?? '' }).ok).toBe(true);
    const all = h.map((e) => ({ ...e, payload: TOMBSTONE }));
    expect(verifyAuditChain(all, { expectedHeadHash: h[4]?.hash ?? '' }).ok).toBe(true);
    expect(verifyAuditChain(redact(redact(h, 0, true), 2, true)).ok).toBe(true);
    expect(verifyAuditChain(redact(h, 1, true)).ok).toBe(true);
  });

  it('a tombstoned policy.evaluated has an unknown outcome, so a grant is still required', () => {
    const autoChain = chain([evaluated('auto_approve'), completed()]);
    expect(verifyAuditChain(autoChain).ok).toBe(true);
    expect(verifyAuditChain(redact(autoChain, 0)).problems.map((p) => p.problem)).toEqual([
      'completed_without_grant',
    ]);
    expect(verifyAuditChain(redact(happy(), 1)).ok).toBe(true);
  });

  it('a redacted event with a broken link fails: prevHash altered, hash altered, hash malformed', () => {
    const h = happy();
    const badPrev = redact(h, 2).map((e, i) => (i === 2 ? { ...e, prevHash: 'f'.repeat(64) } : e));
    expect(verifyAuditChain(badPrev).problems).toEqual([
      { index: 2, eventId: 'aud_003', problem: 'prev_hash_mismatch' },
    ]);

    const badHash = redact(h, 2).map((e, i) => (i === 2 ? { ...e, hash: 'e'.repeat(64) } : e));
    expect(verifyAuditChain(badHash).problems).toEqual([
      { index: 3, eventId: 'aud_004', problem: 'prev_hash_mismatch' },
    ]);

    const badHead = redact(h, 4).map((e, i) => (i === 4 ? { ...e, hash: 'e'.repeat(64) } : e));
    expect(verifyAuditChain(badHead).ok).toBe(true);
    expect(verifyAuditChain(badHead, { expectedHeadHash: h[4]?.hash ?? '' }).problems).toEqual([
      { index: 4, eventId: 'aud_005', problem: 'head_mismatch' },
    ]);

    const malformed = redact(h, 2).map((e, i) => (i === 2 ? { ...e, hash: 'not-a-hash' } : e));
    expect(verifyAuditChain(malformed).problems.map((p) => p.problem)).toEqual([
      'hash_mismatch',
      'prev_hash_mismatch',
    ]);
  });

  it('a tombstone that kept payloadHash detects any altered non-payload field', () => {
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
    ];
    for (const v of variants) {
      const tampered = redact(h, 2, true).map((e, i) => (i === 2 ? { ...e, ...v } : e));
      // Changing type/proposalId on the grant also breaks the booking lifecycle check,
      // so some variants report a second (correct) problem; the hash one is always first.
      expect(verifyAuditChain(tampered).problems[0]).toMatchObject({
        index: 2,
        problem: 'hash_mismatch',
      });
    }
    const wrongDigest = redact(h, 2, true).map((e, i) =>
      i === 2 ? { ...e, payload: { redacted: true, payloadHash: 'b'.repeat(64) } } : e,
    );
    expect(verifyAuditChain(wrongDigest).problems.map((p) => p.problem)).toEqual(['hash_mismatch']);
  });

  it('a bare tombstone cannot vouch for its header (documented limit of link-only verification)', () => {
    const h = happy();
    const tampered = redact(h, 2).map((e, i) =>
      i === 2 ? { ...e, actor: { kind: 'member' as const, id: 'mem_henry' } } : e,
    );
    expect(verifyAuditChain(tampered).ok).toBe(true);
  });

  it('a payload altered to anything other than the exact tombstone fails', () => {
    const h = happy();
    for (const payload of [
      {},
      { redacted: false },
      { redacted: 'true' },
      { redacted: true, note: 'see ticket' },
      { redacted: true, payloadHash: 'short' },
      { outcome: 'auto_approve' },
      { outcome: 'needs_confirmation', reasons: ['default_confirm'], extra: 1 },
    ]) {
      const forged = h.map((e, i) => (i === 1 ? { ...e, payload } : e));
      expect(verifyAuditChain(forged).problems.map((p) => p.problem)).toContain('hash_mismatch');
    }
  });

  it('a tombstone carries no private keys; sealing a fresh tombstone-shaped payload is allowed', () => {
    expect(findPrivatePayloadKeys(TOMBSTONE)).toEqual([]);
    const [e] = chain([input('data.deleted', { payload: { redacted: true } })]);
    expect(e !== undefined && verifyAuditChain([e]).ok).toBe(true);
  });
});
