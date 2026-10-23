/**
 * The Morning After / Wrapped hooks (VOICE §9.5 states 5 and 6): a clock step
 * drains the scheduler, `agent.runScheduled` sends a `recap` / `wrapped` card
 * on the group lane, and the UI renders it in the group thread. The runtime
 * here is a stand-in (`recapRuntime`) that sends the agent's real renderer
 * output from fixture numbers, which is what T-015 / T-016 will emit.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SimState, ThreadMessage } from '../shared/types.js';
import { BARCELONA } from '../server/groups.js';
import { handleApi } from '../server/routes.js';
import { loadAgentBackend } from '../server/runtime.js';
import { recapRuntime } from '../server/testkit.js';
import { AppView } from './App.js';

const noop = () => {};

function threadHtml(state: SimState): string {
  const html = renderToStaticMarkup(
    <AppView
      state={state}
      groupId={BARCELONA.groupId}
      meHandle="h_dean"
      dmMemberId="mem_dean"
      highlightDms={[]}
      draft=""
      onSelectGroup={noop}
      onSelectMe={noop}
      onSelectDm={noop}
      onDraft={noop}
      onSend={noop}
      onClock={noop}
      handlers={{ onAction: noop, onReact: noop }}
    />,
  );
  return html.slice(html.indexOf('data-testid="thread"'), html.indexOf('class="right-rail"'));
}

async function clock(step: string): Promise<{ state: SimState; ran: string[] }> {
  const { create, ran } = recapRuntime();
  const b = await loadAgentBackend({ offline: true, createTravRuntime: create });
  const res = await handleApi(b, {
    method: 'POST',
    path: '/api/clock',
    body: { step, groupId: BARCELONA.groupId },
  });
  expect(res.status).toBe(200);
  return { state: (res.body as { state: SimState }).state, ran };
}

function cards(state: SimState): ThreadMessage[] {
  return state.groups[0]!.thread.filter(
    (e): e is ThreadMessage => e.kind === 'message' && e.card !== undefined,
  );
}

describe('scheduled cards in the group thread', () => {
  it('next morning → morning_after job → the recap card renders (state 5)', async () => {
    const { state, ran } = await clock('morning');
    expect(ran).toEqual(['morning_after']);
    expect(state.now).toBe('2026-03-15T10:00:00+01:00');
    const [recap] = cards(state);
    expect(recap?.card?.type).toBe('recap');
    expect(recap?.text.split('\n')[0]).toBe('morning after, day 4 ☀️');
    expect(state.groups[0]!.status).toBeUndefined();
    const html = threadHtml(state);
    expect(html).toContain('data-testid="card-recap"');
    expect(html).toContain('the 3am kebab place');
    expect(html).not.toContain('card-wrapped');
  });

  it('end of trip → every due job in order, ending with Wrapped (state 6)', async () => {
    const { state, ran } = await clock('end_of_trip');
    expect(ran).toEqual(['morning_after', 'wrapped']);
    expect(state.now).toBe('2026-03-18T10:00:00+01:00');
    expect(cards(state).map((m) => m.card?.type)).toEqual(['recap', 'wrapped']);
    const html = threadHtml(state);
    expect(html).toContain('data-testid="card-wrapped"');
    expect(html).toContain('MVP Spender');
    // The top bar says where the clock is.
    const full = renderToStaticMarkup(
      <AppView
        state={state}
        groupId={BARCELONA.groupId}
        meHandle="h_dean"
        dmMemberId="mem_dean"
        highlightDms={[]}
        draft=""
        onSelectGroup={noop}
        onSelectMe={noop}
        onSelectDm={noop}
        onDraft={noop}
        onSend={noop}
        handlers={{ onAction: noop, onReact: noop }}
      />,
    );
    expect(full).toContain('wed mar 18 · 10am · trip over');
  });

  it('+1 hour runs nothing here: no card, a muted status line instead', async () => {
    const { state, ran } = await clock('hour');
    expect(ran).toEqual([]);
    expect(cards(state)).toEqual([]);
    expect(state.groups[0]!.status).toContain('nothing was scheduled');
  });
});
