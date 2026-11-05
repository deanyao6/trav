/**
 * T-199 (QA-07): receipt photos in the simulator. The composer attaches a
 * fixture receipt by id, the server turns the id into the attachment, and
 * Trav posts the pending "read it" card (nothing on the tab until the payer
 * 👍s it, SAFETY D5). A client can never name a path.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { SimState, ThreadMessage } from '../shared/types.js';
import { createSimRequestHandler } from './http.js';
import {
  attachmentSrc,
  receiptAttachment,
  receiptFixtures,
  receiptImage,
  receiptsForGroup,
} from './receipts.js';
import { handleApi, parseInbound } from './routes.js';
import { demoBackend } from './testkit.js';

function bcnThread(state: SimState): ThreadMessage[] {
  return state.groups[0]!.thread.filter((e): e is ThreadMessage => e.kind === 'message');
}

describe('fixture receipt photos', () => {
  it('lists every PNG with a labeled JSON, per trip', () => {
    const ids = receiptFixtures().map((r) => r.receiptId);
    expect(ids).toContain('rcpt_bcn_gatblau');
    expect(ids).toContain('rcpt_bcn_lunch_service');
    // The groceries fixture has no image: not offered.
    expect(ids).not.toContain('rcpt_bcn_groceries');
    const bcn = receiptsForGroup('grp_barcelona');
    expect(bcn).toContainEqual({ receiptId: 'rcpt_bcn_gatblau', label: 'gatblau' });
    expect(bcn).toContainEqual({ receiptId: 'rcpt_bcn_lunch_service', label: 'lunch service' });
    expect(bcn.every((r) => r.receiptId.startsWith('rcpt_bcn_'))).toBe(true);
    expect(receiptsForGroup('grp_lisbon').map((r) => r.receiptId)).toEqual(['rcpt_lis_tasca']);
    expect(receiptsForGroup('grp_nope')).toEqual([]);
  });

  it('maps an id to the repo-relative attachment, and only a listed id', () => {
    expect(receiptAttachment('rcpt_bcn_gatblau')).toEqual({
      kind: 'image',
      mimeType: 'image/png',
      uri: 'fixtures/receipts/rcpt_bcn_gatblau.png',
      fileName: 'rcpt_bcn_gatblau.png',
    });
    for (const bad of ['rcpt_bcn_groceries', '../../.env', 'rcpt_bcn_gatblau.png', '']) {
      expect(receiptAttachment(bad), bad).toBeUndefined();
      expect(receiptImage(bad), bad).toBeUndefined();
    }
    expect(receiptImage('rcpt_bcn_gatblau')?.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('only a listed fixture receipt gets a browser src; anything else none (never fetched)', () => {
    expect(attachmentSrc('fixtures/receipts/rcpt_bcn_gatblau.png')).toBe(
      '/api/receipts/rcpt_bcn_gatblau.png',
    );
    expect(attachmentSrc('./fixtures/receipts/rcpt_bcn_kebab.png')).toBe(
      '/api/receipts/rcpt_bcn_kebab.png',
    );
    for (const uri of [
      'https://evil.example/x.png',
      'fixtures/receipts/rcpt_bcn_nope.png',
      'fixtures/receipts/../../.env',
      '/etc/passwd',
    ]) {
      expect(attachmentSrc(uri), uri).toBeUndefined();
    }
  });
});

describe('POST /api/messages with a receiptId', () => {
  it('parseInbound resolves the id; an unknown id is a 400; a client path is never taken', () => {
    expect(
      parseInbound('message', {
        from: 'h_piotr',
        text: '@trav dinner, i paid',
        receiptId: 'rcpt_bcn_gatblau',
      }),
    ).toEqual({
      type: 'message',
      from: 'h_piotr',
      text: '@trav dinner, i paid',
      attachments: [receiptAttachment('rcpt_bcn_gatblau')],
    });
    expect(() =>
      parseInbound('message', { from: 'h_piotr', text: 'x', receiptId: 'rcpt_nope' }),
    ).toThrow(/no receipt photo/);
    const sneaky = parseInbound('message', {
      from: 'h_piotr',
      text: 'x',
      attachments: [{ kind: 'image', mimeType: 'image/png', uri: '/Users/someone/.ssh/id_rsa' }],
    });
    expect(sneaky).not.toHaveProperty('attachments');
  });

  it("Piotr's Gat Blau photo gets the pending read-it card; nothing is logged until his 👍", async () => {
    const b = await demoBackend();
    const bad = await handleApi(b, {
      method: 'POST',
      path: '/api/messages',
      body: { from: 'h_piotr', text: '@trav dinner', groupId: 'grp_barcelona', receiptId: 'x' },
    });
    expect(bad.status).toBe(400);
    const otherTrip = await handleApi(b, {
      method: 'POST',
      path: '/api/messages',
      body: {
        from: 'h_piotr',
        text: '@trav dinner',
        groupId: 'grp_barcelona',
        receiptId: 'rcpt_lis_tasca',
      },
    });
    expect(otherTrip.status).toBe(400);

    const before = bcnThread(b.state()).length;
    const res = await handleApi(b, {
      method: 'POST',
      path: '/api/messages',
      body: {
        from: 'h_piotr',
        text: "@trav dinner, i paid, Arjun didn't drink",
        groupId: 'grp_barcelona',
        receiptId: 'rcpt_bcn_gatblau',
      },
    });
    expect(res.status).toBe(200);
    const s = (res.body as { state: SimState }).state;
    expect(s.groups[0]!.receipts?.map((r) => r.receiptId)).toContain('rcpt_bcn_gatblau');
    const fresh = bcnThread(s).slice(before);
    const photo = fresh.find((m) => m.from === 'h_piotr')!;
    expect(photo.attachments).toEqual([
      expect.objectContaining({ kind: 'image', src: '/api/receipts/rcpt_bcn_gatblau.png' }),
    ]);
    const card = fresh.find((m) => m.isTrav && m.card?.type === 'expense_confirm');
    expect(card?.card).toMatchObject({ source: 'receipt_photo', status: 'pending' });
    expect(card?.text).toContain('€184');
    // No logged expense yet.
    expect(
      bcnThread(s).some(
        (m) =>
          m.card?.type === 'expense_confirm' &&
          m.card.source === 'receipt_photo' &&
          m.card.status === 'logged',
      ),
    ).toBe(false);

    await b.inject({
      type: 'reaction',
      from: 'h_piotr',
      targetMessageId: card!.messageId,
      reaction: '👍',
    });
    expect(
      bcnThread(b.state()).some(
        (m) =>
          m.card?.type === 'expense_confirm' &&
          m.card.source === 'receipt_photo' &&
          m.card.status === 'logged',
      ),
    ).toBe(true);
  });
});

// ---------- GET /api/receipts/:id.png ----------

function fakeReq(url: string, method = 'GET'): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method,
    url,
    headers: { host: '127.0.0.1:5179' },
  }) as unknown as IncomingMessage;
}

function fakeRes() {
  const out = { status: 0, headers: {} as Record<string, string>, body: [] as unknown[] };
  const emitter = new EventEmitter();
  const res = {
    get headersSent() {
      return out.status !== 0;
    },
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
      return res;
    },
    write: () => true,
    end(chunk?: unknown) {
      if (chunk !== undefined) out.body.push(chunk);
    },
    on: (e: string, fn: () => void) => emitter.on(e, fn),
    once: (e: string, fn: () => void) => emitter.once(e, fn),
  };
  return { res: res as unknown as ServerResponse, out };
}

describe('GET /api/receipts/:id.png', () => {
  it('serves a listed fixture image as PNG, 404 for anything else', async () => {
    const handler = createSimRequestHandler({ backend: await demoBackend() });
    const ok = fakeRes();
    await handler(fakeReq('/api/receipts/rcpt_bcn_gatblau.png'), ok.res);
    expect(ok.out.status).toBe(200);
    expect(ok.out.headers['content-type']).toBe('image/png');
    expect(Buffer.isBuffer(ok.out.body[0])).toBe(true);
    expect((ok.out.body[0] as Buffer).subarray(1, 4).toString('latin1')).toBe('PNG');

    for (const url of [
      '/api/receipts/rcpt_bcn_nope.png',
      '/api/receipts/rcpt_bcn_groceries.png',
      '/api/receipts/..%2F..%2F.env',
      '/api/receipts/rcpt_bcn_gatblau.json',
    ]) {
      const r = fakeRes();
      await handler(fakeReq(url), r.res);
      expect(r.out.status, url).toBe(404);
    }
  });
});
