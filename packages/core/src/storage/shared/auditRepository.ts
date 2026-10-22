/**
 * The append-only audit repository (docs/SAFETY.md §2.2, checklist B2/B3).
 *
 * This file must only ever APPEND and READ: `storage.test.ts` greps it for any
 * write verb other than `insert`, and asserts the returned object exposes
 * exactly the `AuditRepository` methods. Payload tombstoning for "forget this
 * trip" (§2.9) lives in the store facade (`./stores.ts`), never here.
 */
import type { Clock } from '../../clock.js';
import { parseIso } from '../../clock.js';
import type { IdGenerator } from '../../ids.js';
import type { AuditEvent, AuditEventInput } from '../../domain/audit.js';
import { AUDIT_GENESIS_HASH } from '../../domain/audit.js';
import type { AuditRepository } from '../../repositories.js';
import { sealAuditEvent } from '../../audit/index.js';
import { TravError } from '../../errors.js';
import type { Backend } from './backend.js';
import { auditEventsSpec } from './schema.js';
import { jsonClone, requireId } from './util.js';

export function createAuditRepository(
  backend: Backend,
  clock: Clock,
  ids: IdGenerator,
): AuditRepository {
  const events = backend.table(auditEventsSpec);

  const lastHash = (groupId: string): string =>
    events.last({ group_id: groupId })?.hash ?? AUDIT_GENESIS_HASH;

  return {
    append(input: AuditEventInput): AuditEvent {
      requireId(input.groupId, 'groupId');
      if (
        input.payload === null ||
        typeof input.payload !== 'object' ||
        Array.isArray(input.payload)
      ) {
        throw new TravError('invalid_argument', 'audit payload must be an object', {
          type: input.type,
        });
      }
      // Round-trip first so the hashed object is exactly what is stored and read back.
      const clean = jsonClone(input);
      return backend.transaction(() => {
        // sealAuditEvent rejects PRIVATE_PAYLOAD_KEYS (any depth) and owner events
        // without ownerId, then hashes via audit.computeAuditHash.
        const event = sealAuditEvent(clean, ids.next('aud'), clock.now(), lastHash(clean.groupId));
        events.insert(event);
        return jsonClone(event);
      });
    },

    get: (id) => events.get(id),

    listByGroup(groupId, opts) {
      const types = opts?.types === undefined ? undefined : new Set(opts.types);
      const sinceMs = opts?.since === undefined ? undefined : parseIso(opts.since);
      return events
        .find({ group_id: groupId })
        .filter(
          (e) =>
            (types === undefined || types.has(e.type)) &&
            (sinceMs === undefined || parseIso(e.ts) >= sinceMs),
        );
    },

    listByProposal: (proposalId) => events.find({ proposal_id: proposalId }),

    listByBooking: (bookingId) => events.find({ booking_id: bookingId }),

    listGroupVisible: (groupId) => events.find({ group_id: groupId, visibility: 'group' }),

    lastHash,
  };
}
