/**
 * Timers for channel decorators (T-071). The decorators never read the wall
 * clock: "now" is always the injected `Clock`. Whether anything fires on its
 * own is up to the host:
 *
 * - tests and the simulator pass no timers and call `tick()` after moving the
 *   simulated clock (deterministic);
 * - a real server (T-188) passes `systemChannelTimers()`.
 */
export interface ChannelTimers {
  /** Run `fn` after `delayMs`; returns a cancel function. */
  setTimer(delayMs: number, fn: () => void): () => void;
}

/** Node's `setTimeout`, unref'd so a pending flush never keeps the process alive. */
export function systemChannelTimers(): ChannelTimers {
  return {
    setTimer(delayMs, fn) {
      const handle = setTimeout(fn, Math.max(0, delayMs));
      handle.unref?.();
      return () => clearTimeout(handle);
    },
  };
}

/** Run `step` strictly one after another (a turn never interleaves with a flush). */
export function createSerialQueue(): <T>(step: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(step: () => Promise<T>): Promise<T> => {
    const run = tail.then(step, step);
    tail = run.catch(() => undefined);
    return run;
  };
}
