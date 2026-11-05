/**
 * T-196 (QA-01) on the seeded click-through `pnpm sim` serves: reset (demo
 * state 1) → Dean logs dinner → Dean asks for Razzmatazz (bought on the ask)
 * → "next morning". Nobody chats after midnight, and the Morning After still
 * posts: the booked 5-person midnight club night is a night out on its own.
 */
import { describe, expect, it } from 'vitest';
import type { SimState, ThreadEntry, ThreadMessage } from '../shared/types.js';
import type { SimulatorBackend } from './backend.js';
import { BARCELONA } from './groups.js';
import { handleApi } from './routes.js';
import { demoBackend } from './testkit.js';

const G = BARCELONA.groupId;

async function post(b: SimulatorBackend, path: string, body: unknown): Promise<SimState> {
  const res = await handleApi(b, { method: 'POST', path, body });
  expect(res.status, path).toBe(200);
  const state = (res.body as { state: SimState }).state;
  expect(state.lastError, path).toBeUndefined();
  return state;
}

function travLines(state: SimState): ThreadMessage[] {
  const g = state.groups.find((x) => x.group.groupId === G)!;
  return g.thread.filter((e: ThreadEntry): e is ThreadMessage => e.kind === 'message' && e.isTrav);
}

describe('seeded click-through: dinner → Razzmatazz ask → next morning (T-196)', () => {
  it('posts the Morning After, not just the running tab', async () => {
    const b = await demoBackend();
    await post(b, '/api/messages', {
      from: 'h_dean',
      groupId: G,
      text: '@trav i paid €84 for dinner, split with everyone but Henry',
    });
    const booked = await post(b, '/api/messages', {
      from: 'h_dean',
      groupId: G,
      text: "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
    });
    expect(travLines(booked).at(-1)?.card?.type).toBe('receipt');

    const morning = await post(b, '/api/clock', { step: 'morning', groupId: G });
    const after = travLines(morning).slice(travLines(booked).length);
    const recap = after.find((m) => m.card?.type === 'recap');
    expect(recap, after.map((m) => m.text.split('\n')[0]).join(' | ')).toBeDefined();
    const [head, lastNight] = recap!.text.split('\n');
    expect(head).toBe('morning after, day 4 ☀️');
    expect(lastNight).toMatch(
      /^last night: dinner \(5 of you, not Henry\) €84 · Razzmatazz[^(]* €90$/,
    );
    expect(recap!.text).not.toMatch(/sick/i);
    expect(after.some((m) => m.card?.type === 'settle_up')).toBe(false);
  });
});
