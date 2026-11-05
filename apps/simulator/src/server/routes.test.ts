import { describe, expect, it } from 'vitest';
import type { SimState, ThreadMessage } from '../shared/types.js';
import { RAZZMATAZZ_ASK } from './groups.js';
import { MAX_TEXT_LENGTH, handleApi, parseInbound } from './routes.js';
import { bookingCount, demoBackend } from './testkit.js';

function bcnThread(state: SimState): ThreadMessage[] {
  return state.groups[0]!.thread.filter((e): e is ThreadMessage => e.kind === 'message');
}

describe('simulator API routes', () => {
  it('GET /api/state returns the payload', async () => {
    const b = await demoBackend();
    const res = await handleApi(b, { method: 'GET', path: '/api/state' });
    expect(res.status).toBe(200);
    expect((res.body as SimState).groups.map((g) => g.group.groupId)).toEqual([
      'grp_barcelona',
      'grp_lisbon',
      'grp_turks_caicos',
    ]);
  });

  it('drives demo states 1–3 through the HTTP-shaped API', async () => {
    const b = await demoBackend();
    const sent = await handleApi(b, {
      method: 'POST',
      path: '/api/messages',
      body: { from: 'h_dean', text: RAZZMATAZZ_ASK, groupId: 'grp_barcelona' },
    });
    expect(sent.status).toBe(200);
    const s1 = (sent.body as { state: SimState }).state;
    const proposal = bcnThread(s1).find((m) => m.card?.type === 'booking_proposal')!;
    expect(proposal).toBeDefined();

    const tap = await handleApi(b, {
      method: 'POST',
      path: '/api/button-taps',
      body: { from: 'h_dean', cardMessageId: proposal.messageId, actionId: 'approve' },
    });
    expect(tap.status).toBe(200);
    expect((tap.body as { type: string }).type).toBe('button_tap');
    const s2 = (tap.body as { state: SimState }).state;
    expect(bcnThread(s2).some((m) => m.card?.type === 'receipt')).toBe(true);

    const henry = await handleApi(b, { method: 'GET', path: '/api/dms/mem_henry' });
    expect(henry.status).toBe(200);
    expect((henry.body as { thread: unknown[] }).thread).toEqual([]);
    const arjun = await handleApi(b, { method: 'GET', path: '/api/dms/mem_arjun' });
    expect((arjun.body as { thread: ThreadMessage[] }).thread.map((m) => m.card?.type)).toEqual([
      'ticket',
    ]);
  });

  it('POST /api/reactions routes a tapback', async () => {
    const b = await demoBackend();
    await handleApi(b, {
      method: 'POST',
      path: '/api/messages',
      body: { from: 'h_dean', text: RAZZMATAZZ_ASK },
    });
    const proposal = bcnThread(b.state()).find((m) => m.card?.type === 'booking_proposal')!;
    const res = await handleApi(b, {
      method: 'POST',
      path: '/api/reactions',
      body: { from: 'h_dean', targetMessageId: proposal.messageId, reaction: '👍' },
    });
    expect(res.status).toBe(200);
    expect(bookingCount(b)).toBe(1);
  });

  it('400 on bad input and on channel identity errors, never a crash', async () => {
    const b = await demoBackend();
    const cases: [string, unknown][] = [
      ['/api/messages', { text: 'hi' }],
      ['/api/messages', { from: 'h_dean', text: '   ' }],
      ['/api/messages', { from: 'h_dean', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }],
      ['/api/messages', { from: 'h_dean', text: 'hi', lane: 'broadcast' }],
      ['/api/messages', 'not an object'],
      ['/api/messages', { from: 'h_nobody', text: 'hi' }],
      ['/api/button-taps', { from: 'h_dean', cardMessageId: 'msg_nope', actionId: 'approve' }],
      [
        '/api/reactions',
        { from: 'h_dean', targetMessageId: 'msg_nope', reaction: '👍', removed: 'yes' },
      ],
    ];
    for (const [path, body] of cases) {
      const res = await handleApi(b, { method: 'POST', path, body });
      expect(res.status, `${path} ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
      expect(typeof (res.body as { error: string }).error).toBe('string');
    }
  });

  it('404 / 405 for unknown routes and wrong methods', async () => {
    const b = await demoBackend();
    expect((await handleApi(b, { method: 'GET', path: '/api/nope' })).status).toBe(404);
    expect((await handleApi(b, { method: 'GET', path: '/api/messages' })).status).toBe(405);
    expect((await handleApi(b, { method: 'GET', path: '/api/reset' })).status).toBe(405);
    expect((await handleApi(b, { method: 'GET', path: '/api/dms/mem_nobody' })).status).toBe(404);
  });

  it('POST /api/reset goes back to state 1', async () => {
    const b = await demoBackend();
    await handleApi(b, {
      method: 'POST',
      path: '/api/messages',
      body: { from: 'h_dean', text: RAZZMATAZZ_ASK },
    });
    const res = await handleApi(b, { method: 'POST', path: '/api/reset' });
    expect(res.status).toBe(200);
    expect(bcnThread((res.body as { state: SimState }).state).some((m) => m.isTrav)).toBe(false);
  });

  it('parseInbound keeps only known fields', () => {
    expect(
      parseInbound('button_tap', {
        from: 'h_dean',
        cardMessageId: 'm1',
        actionId: 'pick',
        value: 'o2',
        extra: 1,
      }),
    ).toEqual({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: 'm1',
      actionId: 'pick',
      value: 'o2',
    });
  });
});
