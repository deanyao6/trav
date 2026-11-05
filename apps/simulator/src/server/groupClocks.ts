/**
 * One simulated clock per chat (T-095, D-035).
 *
 * The runtime and the simulator channel read a single `SimulatedClock`. Each
 * chat keeps its own time here; whichever chat Trav is working for is the
 * "active" one, and the shared clock shows its time. Switching chats saves
 * the active chat's time and puts the next one's on the shared clock, so
 * Barcelona can sit at sat mar 14 9:39pm while Lisbon is at thu apr 16 9am,
 * and moving one chat's clock never moves (or drains) another's.
 *
 * The backend switches inside its serialized turn queue (`enterTurn`), and
 * for the synchronous moment the channel stamps an inbound event (`within`),
 * so a turn in flight for one chat never sees another chat's time.
 *
 * Every chat's own time only moves forward (the backend's clock steps refuse
 * a backward move); the shared clock may be set back when switching to a
 * chat whose trip is earlier. The id generator and stores tolerate that
 * (ids stay unique and sortable, see `createUlidIdGenerator`).
 */
import type { IsoDateTime, SimulatedClock } from '@trav/core';

export interface GroupClocks {
  /** The one clock the runtime and the channel read: it shows the active chat's time. */
  readonly clock: SimulatedClock;
  /** This chat's time (unknown chat: the shared clock). */
  now(groupId: string): IsoDateTime;
  /** The chat whose time is on the shared clock. */
  active(): string | undefined;
  /**
   * Put `groupId`'s time on the shared clock. Only with exclusive access: in
   * a serialized turn, or while the session is being built.
   */
  activate(groupId: string): void;
  /** `activate` for a turn: does nothing while pinned (seeding). */
  enterTurn(groupId: string | undefined): void;
  /**
   * Runs `fn` synchronously with `groupId`'s time on the shared clock, then
   * puts the previously active chat back (also when `fn` throws). For the
   * channel's synchronous stamp of an inbound event: if `fn` returns a
   * promise, only its synchronous part sees `groupId`'s time.
   */
  within<T>(groupId: string | undefined, fn: () => T): T;
  /** While pinned, turns run on the shared clock as it is (the seed lines set it themselves). */
  pin(): void;
  unpin(): void;
}

/**
 * Per-chat clocks over `base`. `starts` gives each chat's opening time; the
 * first entry is active and its time is whatever `base` shows.
 */
export function createGroupClocks(
  base: SimulatedClock,
  starts: readonly (readonly [groupId: string, startAt: IsoDateTime])[],
): GroupClocks {
  const stored = new Map<string, IsoDateTime>(starts);
  let current: string | undefined = starts[0]?.[0];
  let pinned = false;

  const activate = (groupId: string): void => {
    if (groupId === current || !stored.has(groupId)) return;
    if (current !== undefined) stored.set(current, base.now());
    base.set(stored.get(groupId)!);
    current = groupId;
  };

  return {
    clock: base,
    now(groupId) {
      if (groupId === current) return base.now();
      return stored.get(groupId) ?? base.now();
    },
    active: () => current,
    activate,
    enterTurn(groupId) {
      if (!pinned && groupId !== undefined) activate(groupId);
    },
    within(groupId, fn) {
      if (groupId === undefined || groupId === current || !stored.has(groupId)) return fn();
      const previous = current;
      activate(groupId);
      try {
        return fn();
      } finally {
        if (previous !== undefined) activate(previous);
      }
    },
    pin() {
      pinned = true;
    },
    unpin() {
      pinned = false;
    },
  };
}

/** One clock for every chat (a backend without a settable clock). */
export function sharedClocks(clock: { now(): IsoDateTime }): Omit<GroupClocks, 'clock'> {
  return {
    now: () => clock.now(),
    active: () => undefined,
    activate: () => undefined,
    enterTurn: () => undefined,
    within: (_groupId, fn) => fn(),
    pin: () => undefined,
    unpin: () => undefined,
  };
}
