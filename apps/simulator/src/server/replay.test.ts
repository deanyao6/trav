import { describe, expect, it } from 'vitest';
import { TravError } from '@trav/core';
import type { RichCard } from '@trav/core';
import type { SimState, ThreadEntry, ThreadMessage } from '../shared/types.js';
import { BARCELONA } from './groups.js';
import {
  clip,
  describeLine,
  findTargetCard,
  loadBarcelonaScript,
  parseScript,
  withReplay,
} from './replay.js';
import type { ReplayLine } from './replay.js';
import { handleApi } from './routes.js';
import { loadAgentBackend } from './runtime.js';
import { demoBackend } from './testkit.js';

const SCRIPT = loadBarcelonaScript();

function messages(entries: readonly ThreadEntry[]): ThreadMessage[] {
  return entries.filter((e): e is ThreadMessage => e.kind === 'message');
}

function expectGroupClean(state: SimState): void {
  for (const g of state.groups) {
    for (const m of messages(g.thread)) {
      expect(m.lane).toBe('group');
      expect(m.card?.type).not.toBe('ticket');
      if (m.card?.type === 'expense_confirm') expect(m.card.visibility).not.toBe('private');
    }
  }
}

describe('parseScript', () => {
  it('reads every line of fixtures/chats/barcelona.jsonl', () => {
    expect(SCRIPT).toHaveLength(199);
    const kinds = new Set(SCRIPT.map((l) => l.kind));
    expect(kinds).toEqual(
      new Set(['message', 'reaction', 'button_tap', 'clock', 'system', 'member_joined']),
    );
    expect(SCRIPT[0]).toMatchObject({ id: 'msg_bcn_0001', kind: 'message', senderId: 'h_dean' });
    const flagship = SCRIPT.find((l) => l.id === 'msg_bcn_0132')!;
    expect(flagship).toMatchObject({ kind: 'reaction', reaction: '👍', cardRef: 'razz_proposal' });
    const join = SCRIPT.find((l) => l.kind === 'member_joined')!;
    expect(join.participant).toEqual({ handle: 'h_ava', displayName: 'Ava' });
    // Clock lines carry the job they exist to show; nothing else does.
    const clocks = SCRIPT.filter((l) => l.kind === 'clock');
    expect(clocks.at(-1)).toMatchObject({ id: 'clk_bcn_2026031810', scheduledJob: 'wrapped' });
    expect(SCRIPT.find((l) => l.id === 'clk_bcn_2026031510')?.scheduledJob).toBe('morning_after');
    expect(SCRIPT.filter((l) => l.kind !== 'clock' && l.scheduledJob !== undefined)).toEqual([]);
    // An unknown job kind in `expect` is ignored, not trusted.
    const odd = parseScript(
      '{"id":"c","ts":"2026-03-15T10:00:00+01:00","kind":"clock","expect":{"scheduledJob":"rm -rf"}}',
    );
    expect(odd[0]?.scheduledJob).toBeUndefined();
  });

  it('rejects a line that is not JSON or lacks id/ts/kind, naming the line', () => {
    expect(() => parseScript('{"id":"a","ts":"2026-03-14T21:40:00+01:00","kind":"message"}\nnope')).toThrow(
      /line 2/,
    );
    expect(() => parseScript('{"id":"a","kind":"message"}')).toThrow(TravError);
    expect(parseScript('\n\n')).toEqual([]);
  });
});

describe('describeLine', () => {
  const line = (over: Partial<ReplayLine>): ReplayLine => ({
    id: 'x',
    ts: '2026-03-14T21:40:00+01:00',
    kind: 'message',
    lane: 'group',
    senderId: 'h_dean',
    text: '',
    ...over,
  });
  it('labels each kind for the replay button', () => {
    expect(describeLine(line({ text: "@trav get the 5 of us Razzmatazz tickets, Henry's sick" }), BARCELONA)).toBe(
      'Dean: @trav get the 5 of us Razzmatazz tickets…',
    );
    expect(describeLine(line({ lane: 'direct', senderId: 'h_priya', text: 'photos on' }), BARCELONA)).toBe(
      'Priya (dm): photos on',
    );
    expect(describeLine(line({ kind: 'reaction', reaction: '👍', cardRef: 'razz_proposal' }), BARCELONA)).toBe(
      'Dean 👍 on razz_proposal',
    );
    expect(
      describeLine(line({ kind: 'clock', senderId: null, advanceTo: '2026-03-15T10:00:00+01:00' }), BARCELONA),
    ).toBe('clock → sun mar 15 · 10am · day 4');
    expect(
      describeLine(line({ kind: 'system', senderId: null, event: 'card_sync', memberId: 'mem_sam' }), BARCELONA),
    ).toBe('card_sync for Sam');
  });
});

describe('clip (replay label)', () => {
  it('keeps short lines whole and collapses whitespace', () => {
    expect(clip('  photos   on \n')).toBe('photos on');
    expect(clip('x'.repeat(48))).toBe('x'.repeat(48));
    expect(clip('')).toBe('');
  });

  it('cuts at a word boundary and drops trailing punctuation', () => {
    expect(clip("@trav get the 5 of us Razzmatazz tickets, Henry's sick")).toBe(
      '@trav get the 5 of us Razzmatazz tickets…',
    );
  });

  it('never splits an emoji (counts code points, not UTF-16 units)', () => {
    const out = clip('ok its official. BARCELONA mar 12-17 🇪🇸 everyone lock it in');
    expect(out).toBe('ok its official. BARCELONA mar 12-17 🇪🇸…');
    // A flag right at the cut: either whole or gone, never half a surrogate pair.
    const atCut = clip(`${'a'.repeat(46)}🇪🇸🇪🇸 tail`);
    expect(atCut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(Array.from(atCut).length).toBeLessThanOrEqual(48);
  });

  it('a single long word is hard-cut at the limit', () => {
    const out = clip('a'.repeat(100));
    expect(out).toBe(`${'a'.repeat(47)}…`);
  });
});

describe('findTargetCard', () => {
  const base = {
    kind: 'message' as const,
    at: '2026-03-14T21:40:00+01:00',
    lane: 'group' as const,
    direction: 'outbound' as const,
    from: 'trav',
    fromName: 'Trav',
    isTrav: true,
    attachments: [],
    renderedAsCard: false,
    degraded: false,
    reactions: [],
  };
  const proposal = (seq: number): ThreadMessage => ({
    ...base,
    seq,
    messageId: `m${seq}`,
    text: 'p',
    card: { type: 'booking_proposal' } as unknown as RichCard,
    actions: [{ id: 'approve', label: 'Approve', style: 'primary', textAliases: [] }],
  });
  const settle: ThreadMessage = {
    ...base,
    seq: 3,
    messageId: 'm3',
    text: 's',
    card: { type: 'settle_up' } as unknown as RichCard,
    actions: [],
  };
  it('picks the newest card of the type the cardRef names; taps need the action on it', () => {
    const entries = [proposal(1), proposal(2), settle];
    expect(findTargetCard(entries, { kind: 'reaction', cardRef: 'razz_proposal' })?.messageId).toBe('m2');
    expect(findTargetCard(entries, { kind: 'reaction', cardRef: 'final_settle' })?.messageId).toBe('m3');
    expect(
      findTargetCard(entries, { kind: 'button_tap', cardRef: 'razz_proposal', actionId: 'approve' })?.messageId,
    ).toBe('m2');
    expect(
      findTargetCard(entries, { kind: 'button_tap', cardRef: 'razz_proposal', actionId: 'confirm' }),
    ).toBeUndefined();
    expect(findTargetCard(entries, { kind: 'reaction', cardRef: 'sam_uber_prompt' })).toBeUndefined();
    expect(findTargetCard([], { kind: 'reaction', cardRef: 'razz_proposal' })).toBeUndefined();
  });
});

describe('withReplay (real runtime, opened on the seeded chat)', () => {
  it('step 1 starts over on a clean slate at the first line; each line runs as its sender', async () => {
    const b = withReplay(await demoBackend(), SCRIPT);
    const before = b.state();
    expect(before.controls.replay).toBe(true);
    expect(before.replay).toMatchObject({ cursor: 0, total: 199, running: false });
    expect(before.replay?.next).toBe('Dean: ok its official. BARCELONA mar 12-17 🇪🇸…');

    const v1 = await b.replay.step();
    expect(v1).toMatchObject({ cursor: 1, next: 'Maya: AHHHH' });
    const s1 = b.state();
    // The session restarted at the script's first moment.
    expect(s1.now).toBe(SCRIPT[0]!.ts);
    const thread = messages(s1.groups[0]!.thread);
    // The seeded demo lines are gone: only the script's first line.
    expect(thread.map((m) => [m.from, m.text])).toEqual([
      ['h_dean', 'ok its official. BARCELONA mar 12-17 🇪🇸 everyone lock it in'],
    ]);

    for (let i = 0; i < 12; i++) await b.replay.step();
    const lines = SCRIPT.slice(0, 13).filter((l) => l.kind === 'message' && l.lane === 'group');
    const inbound = messages(b.state().groups[0]!.thread).filter((m) => m.direction === 'inbound');
    expect(inbound.map((m) => [m.from, m.text])).toEqual(lines.map((l) => [l.senderId, l.text]));
  });

  it('the clock follows the script forward and never rewinds', async () => {
    const b = withReplay(await demoBackend(), SCRIPT);
    let prev = 0;
    for (let i = 0; i < 60; i++) {
      await b.replay.step();
      const now = Date.parse(b.state().now);
      expect(now).toBeGreaterThanOrEqual(prev);
      prev = now;
    }
  });

  it('play all runs every line exactly once, terminates, and the group thread stays clean', async () => {
    const b = withReplay(await demoBackend(), SCRIPT);
    const v = await b.replay.all();
    expect(v).toMatchObject({ cursor: 199, total: 199, running: false });
    expect(v.next).toBeUndefined();
    const s = b.state();
    expect(s.now).toBe('2026-03-18T10:00:00+01:00');
    expectGroupClean(s);
    // DM-only text never reaches the group (msg_bcn_d_0001 mustNotAppearInGroup).
    expect(JSON.stringify(s.groups.map((g) => g.thread))).not.toContain('vegetarian');
    // The card syncs and emails were fed for the members who opted in, privately.
    const g = s.groups[0]!;
    expect(Object.values(g.intake).flat()).toEqual([]);
    for (const id of ['mem_sam', 'mem_dean', 'mem_priya', 'mem_maya']) {
      expect(messages(g.dms[id]!).some((m) => m.card?.type === 'expense_confirm')).toBe(true);
    }
    expect(messages(g.dms['mem_jordan']!).some((m) => m.card?.type === 'expense_confirm')).toBe(false);
    // Nothing left to run.
    expect(await b.replay.step()).toMatchObject({ cursor: 199 });
  });

  it('a line that cannot run is skipped with a reason, and the replay goes on', async () => {
    const b = withReplay(await demoBackend(), SCRIPT);
    const until = SCRIPT.findIndex((l) => l.id === 'msg_bcn_0020');
    for (let i = 0; i <= until; i++) await b.replay.step();
    expect(b.replay.view().last).toBe('skipped msg_bcn_0020: no flights_proposal on screen to react to');
    expect(b.replay.view().cursor).toBe(until + 1);
  });

  it('refuses a second run while one is in flight; reset rewinds the cursor', async () => {
    const b = withReplay(await demoBackend(), SCRIPT);
    const running = b.replay.all();
    await expect(b.replay.step()).rejects.toThrow(/already running/);
    await running;
    await b.reset!();
    expect(b.replay.view()).toMatchObject({ cursor: 0, running: false });
    expect(messages(b.state().groups[0]!.thread).length).toBeGreaterThan(1); // demo state 1 again
  });

  it('routes: /api/replay/step and /all; 409 without a script; 405 on GET', async () => {
    const plain = await demoBackend();
    expect((await handleApi(plain, { method: 'POST', path: '/api/replay/step' })).status).toBe(409);
    const b = withReplay(plain, SCRIPT.slice(0, 3));
    expect((await handleApi(b, { method: 'GET', path: '/api/replay/step' })).status).toBe(405);
    const step = await handleApi(b, { method: 'POST', path: '/api/replay/step' });
    expect(step.status).toBe(200);
    expect((step.body as { replay: { cursor: number } }).replay.cursor).toBe(1);
    const all = await handleApi(b, { method: 'POST', path: '/api/replay/all' });
    expect((all.body as { state: SimState }).state.replay).toMatchObject({ cursor: 3, total: 3 });
  });
});

describe('withReplay (agent backend, real offline runtime)', () => {
  it('plays the whole script: terminates, flagship ask gets a proposal, group never holds private cards', async () => {
    const b = withReplay(await loadAgentBackend({}), SCRIPT);
    const v = await b.replay.all();
    expect(v.cursor).toBe(199);
    const s = b.state();
    expect(s.lastError).toBeUndefined();
    expectGroupClean(s);
    const g = s.groups[0]!;
    expect(messages(g.thread).some((m) => m.card?.type === 'booking_proposal')).toBe(true);
    expect(JSON.stringify(g.thread)).not.toContain('vegetarian');
    // Henry never gets a Razzmatazz ticket.
    expect(messages(g.dms['mem_henry']!).some((m) => m.card?.type === 'ticket')).toBe(false);
  });
});
