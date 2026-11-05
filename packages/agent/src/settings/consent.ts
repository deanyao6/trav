/**
 * The one write path for a member's consent flags (SAFETY §2.6, G1). Every
 * flag defaults to false; the caller has already checked that the sender is
 * the owner (or, for a minor's photos only, the minor's guardian, VOICE §8).
 * Every change is a `consent.changed` audit event. Turning `cardImport` or
 * `emailImport` off drops that source's pending "looks shared?" items right
 * away (`dropPendingItems`), so off-then-on before a tap can never share a
 * stale charge (T-013 review note).
 */
import type {
  AuditEventId,
  Clock,
  ConsentFlag,
  ConsentFlags,
  GroupId,
  MemberId,
  Stores,
  TripId,
} from '@trav/core';
import { defaultConsent } from '@trav/core';
import { dropPendingItems } from '../ingest/pending.js';

/** Flags whose state is the owner's business only: their audit rows are owner-visible. */
const OWNER_ONLY_FLAGS: ReadonlySet<ConsentFlag> = new Set([
  'cardImport',
  'emailImport',
  'memoryAcrossTrips',
]);

export type ConsentVia = 'chat' | 'dm' | 'guardian' | 'simulator';

export interface ConsentChange {
  readonly groupId: GroupId;
  readonly tripId: TripId | null;
  /** Whose flag. */
  readonly ownerMemberId: MemberId;
  /** Who asked (the owner, or the minor's guardian for `photos`). */
  readonly actorMemberId: MemberId;
  readonly flag: ConsentFlag;
  readonly value: boolean;
  readonly via: ConsentVia;
}

export interface ConsentChangeResult {
  readonly changed: boolean;
  readonly before: boolean;
  /** Pending private items dropped because an import was turned off. */
  readonly dropped: number;
  readonly auditEventId?: AuditEventId;
}

export function readConsent(
  stores: Pick<Stores, 'private'>,
  memberId: MemberId,
  groupId: GroupId,
  now: string,
): ConsentFlags {
  return stores.private.getConsent(memberId, groupId) ?? defaultConsent(memberId, groupId, now);
}

export function changeConsent(
  deps: { readonly stores: Stores; readonly clock: Clock },
  change: ConsentChange,
): ConsentChangeResult {
  const { stores, clock } = deps;
  const now = clock.now();
  const current = readConsent(stores, change.ownerMemberId, change.groupId, now);
  const before = current[change.flag];
  // An import that is off has nothing pending by construction; dropping again is a no-op.
  const drop = (): number => {
    if (change.value) return 0;
    if (change.flag === 'cardImport') {
      return dropPendingItems({ stores, clock }, change.ownerMemberId, change.groupId, 'card');
    }
    if (change.flag === 'emailImport') {
      return dropPendingItems({ stores, clock }, change.ownerMemberId, change.groupId, 'email');
    }
    return 0;
  };
  if (before === change.value) return { changed: false, before, dropped: drop() };

  stores.private.putConsent(change.ownerMemberId, {
    ...current,
    [change.flag]: change.value,
    updatedAt: now,
  });
  const ownerOnly = OWNER_ONLY_FLAGS.has(change.flag);
  const event = stores.group.audit.append({
    groupId: change.groupId,
    tripId: change.tripId,
    type: 'consent.changed',
    actor: { kind: 'member', id: change.actorMemberId },
    visibility: ownerOnly ? 'owner' : 'group',
    ...(ownerOnly ? { ownerId: change.ownerMemberId } : {}),
    payload: {
      memberId: change.ownerMemberId,
      flag: change.flag,
      from: before,
      to: change.value,
      via: change.via,
      ...(change.actorMemberId !== change.ownerMemberId ? { by: change.actorMemberId } : {}),
    },
  });
  // After the write: `consentRevokedSince` and the drop agree on the new state.
  const dropped = drop();
  return { changed: true, before, dropped, auditEventId: event.id };
}

/**
 * Did this member explicitly turn roast consent off ("stop roasting me")?
 * Distinguishes "asked to be left out" from "never opted in" (both are
 * `roast: false`), from the audit log, the record of who said what.
 */
export function optedOutOfRoasts(
  stores: Pick<Stores, 'group'>,
  groupId: GroupId,
  memberId: MemberId,
): boolean {
  const events = stores.group.audit
    .listByGroup(groupId)
    .filter(
      (e) =>
        e.type === 'consent.changed' &&
        e.payload['memberId'] === memberId &&
        e.payload['flag'] === 'roast',
    );
  const last = events.at(-1);
  return last !== undefined && last.payload['to'] === false;
}
