/**
 * SplitContext: the group-level facts every split needs. Pure data plus
 * validation helpers; no I/O, no clock.
 */
import type { MemberId } from '../primitives.js';
import { TravError } from '../errors.js';

export interface SplitContext {
  /** Group member order; shares and remainders are assigned deterministically in this order. */
  readonly memberOrder: readonly MemberId[];
  /** For `exclude`: the universe is the roster of the linked activity, else all active members. */
  readonly participantsUniverse: readonly MemberId[];
}

/** Build a context where the exclude-universe is the whole member order. */
export function contextFor(memberOrder: readonly MemberId[]): SplitContext {
  return { memberOrder, participantsUniverse: memberOrder };
}

function findDuplicate(ids: readonly MemberId[]): MemberId | undefined {
  const seen = new Set<MemberId>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

/** Throws `invalid_argument` when the context itself is malformed. */
export function assertContext(ctx: SplitContext): void {
  if (ctx.memberOrder.length === 0) {
    throw new TravError('invalid_argument', 'memberOrder must not be empty');
  }
  const dupMember = findDuplicate(ctx.memberOrder);
  if (dupMember !== undefined) {
    throw new TravError('invalid_argument', `memberOrder lists ${dupMember} twice`, {
      memberId: dupMember,
    });
  }
  const dupUniverse = findDuplicate(ctx.participantsUniverse);
  if (dupUniverse !== undefined) {
    throw new TravError('invalid_argument', `participantsUniverse lists ${dupUniverse} twice`, {
      memberId: dupUniverse,
    });
  }
  const known = new Set(ctx.memberOrder);
  for (const id of ctx.participantsUniverse) {
    if (!known.has(id)) {
      throw new TravError('invalid_argument', `participantsUniverse has unknown member ${id}`, {
        memberId: id,
      });
    }
  }
}

/** Throws `invalid_argument` if any id is not in `memberOrder`. */
export function assertKnownMembers(
  ids: readonly MemberId[],
  ctx: SplitContext,
  what: string,
): void {
  const known = new Set(ctx.memberOrder);
  for (const id of ids) {
    if (!known.has(id)) {
      throw new TravError('invalid_argument', `${what}: unknown member ${id}`, {
        memberId: id,
        what,
      });
    }
  }
}

/** Throws `invalid_argument` if any id appears twice. */
export function assertUniqueMembers(ids: readonly MemberId[], what: string): void {
  const dup = findDuplicate(ids);
  if (dup !== undefined) {
    throw new TravError('invalid_argument', `${what}: member ${dup} listed twice`, {
      memberId: dup,
      what,
    });
  }
}

/** Stable sort of a set of member ids into group member order. */
export function inMemberOrder(
  ids: Iterable<MemberId>,
  memberOrder: readonly MemberId[],
): MemberId[] {
  const wanted = new Set(ids);
  return memberOrder.filter((id) => wanted.has(id));
}
