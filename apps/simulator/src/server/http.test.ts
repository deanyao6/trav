/**
 * The sandbox this was built in refuses `listen()` (EPERM), so these tests
 * dispatch fake IncomingMessage/ServerResponse objects straight into the
 * request handler. The e2e smoke test (e2e/smoke.spec.ts) covers a real socket.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { SimState, ThreadMessage } from '../shared/types.js';
import { RAZZMATAZZ_ASK } from './groups.js';
import {
  SIM_HOST,
  createSimRequestHandler,
  isLocalHost,
  listenLocal,
  parsePort,
  staticUi,
} from './http.js';
import { bookingCount, demoBackend } from './testkit.js';

interface FakeRes {
  status: number;
  headers: Record<string, string>;
  chunks: string[];
  ended: boolean;
  emitter: EventEmitter;
}

function fakeReq(opts: {
  method?: string;
  url: string;
  host?: string;
  contentType?: string;
  body?: string;
}): IncomingMessage {
  const stream = Readable.from(opts.body !== undefined ? [Buffer.from(opts.body)] : []);
  return Object.assign(stream, {
    method: opts.method ?? 'GET',
    url: opts.url,
    headers: {
      host: opts.host ?? '127.0.0.1:5179',
      ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
    },
  }) as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; out: FakeRes } {
  const out: FakeRes = {
    status: 0,
    headers: {},
    chunks: [],
    ended: false,
    emitter: new EventEmitter(),
  };
  const res = {
    get headersSent() {
      return out.status !== 0;
    },
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
      return res;
    },
    write(chunk: string) {
      out.chunks.push(String(chunk));
      return true;
    },
    end(chunk?: string) {
      if (chunk !== undefined) out.chunks.push(String(chunk));
      out.ended = true;
    },
    on(event: string, fn: () => void) {
      out.emitter.on(event, fn);
      return res;
    },
    once(event: string, fn: () => void) {
      out.emitter.once(event, fn);
      return res;
    },
    emit(event: string) {
      return out.emitter.emit(event);
    },
  };
  return { res: res as unknown as ServerResponse, out };
}

async function call(
  handler: ReturnType<typeof createSimRequestHandler>,
  opts: Parameters<typeof fakeReq>[0],
): Promise<FakeRes & { json: () => unknown }> {
  const { res, out } = fakeRes();
  await handler(fakeReq(opts), res);
  return Object.assign(out, { json: () => JSON.parse(out.chunks.join('')) as unknown });
}

describe('simulator HTTP handler', () => {
  it('serves /api/state as JSON', async () => {
    const handler = createSimRequestHandler({ backend: await demoBackend() });
    const r = await call(handler, { url: '/api/state' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect((r.json() as SimState).backend).toBe('agent');
  });

  it('refuses non-local Host headers (DNS rebinding)', async () => {
    const handler = createSimRequestHandler({ backend: await demoBackend() });
    const r = await call(handler, { url: '/api/state', host: 'evil.example:5179' });
    expect(r.status).toBe(403);
    expect(isLocalHost('localhost:5179')).toBe(true);
    expect(isLocalHost('[::1]:5179')).toBe(true);
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('127.0.0.1.evil.example')).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
  });

  it('requires application/json on POST and rejects bad JSON', async () => {
    const handler = createSimRequestHandler({ backend: await demoBackend() });
    const form = await call(handler, {
      method: 'POST',
      url: '/api/messages',
      contentType: 'application/x-www-form-urlencoded',
      body: 'from=h_dean&text=hi',
    });
    expect(form.status).toBe(415);
    const bad = await call(handler, {
      method: 'POST',
      url: '/api/messages',
      contentType: 'application/json',
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    const big = await call(handler, {
      method: 'POST',
      url: '/api/messages',
      contentType: 'application/json',
      body: JSON.stringify({ from: 'h_dean', text: 'x'.repeat(70_000) }),
    });
    expect(big.status).toBe(413);
  });

  it('runs the Razzmatazz flow over POSTs', async () => {
    const backend = await demoBackend();
    const handler = createSimRequestHandler({ backend });
    const ask = await call(handler, {
      method: 'POST',
      url: '/api/messages',
      contentType: 'application/json',
      body: JSON.stringify({ from: 'h_dean', text: RAZZMATAZZ_ASK, groupId: 'grp_barcelona' }),
    });
    expect(ask.status).toBe(200);
    const state = (ask.json() as { state: SimState }).state;
    const proposal = state.groups[0]!.thread.find(
      (e): e is ThreadMessage => e.kind === 'message' && e.card?.type === 'booking_proposal',
    )!;
    const tap = await call(handler, {
      method: 'POST',
      url: '/api/button-taps?ignored=1',
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        from: 'h_dean',
        cardMessageId: proposal.messageId,
        actionId: 'approve',
      }),
    });
    expect(tap.status).toBe(200);
    expect(bookingCount(backend)).toBe(1);
  });

  it('streams state over SSE and stops on close', async () => {
    const backend = await demoBackend();
    const handler = createSimRequestHandler({ backend, heartbeatMs: 0 });
    const { res, out } = fakeRes();
    const req = fakeReq({ url: '/api/events' });
    await handler(req, res);
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toMatch(/text\/event-stream/);
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]).toMatch(/^event: state\ndata: \{/);
    await backend.inject({ type: 'message', from: 'h_maya', text: 'hi' });
    const afterOne = out.chunks.length;
    expect(afterOne).toBeGreaterThan(1);
    const last = out.chunks.at(-1)!;
    const payload = JSON.parse(last.replace(/^event: state\ndata: /, '').trim()) as SimState;
    expect(payload.groups[0]!.thread.at(-1)).toMatchObject({ kind: 'message', text: 'hi' });
    req.emit('close');
    await backend.inject({ type: 'message', from: 'h_maya', text: 'again' });
    expect(out.chunks.length).toBe(afterOne);
  });

  it('falls through to the UI handler for non-API paths, 404 without one', async () => {
    const backend = await demoBackend();
    const none = await call(createSimRequestHandler({ backend }), { url: '/' });
    expect(none.status).toBe(404);
    let hit = '';
    const withUi = createSimRequestHandler({
      backend,
      ui: (req, res) => {
        hit = req.url ?? '';
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html></html>');
      },
    });
    const r = await call(withUi, { url: '/index.html' });
    expect(hit).toBe('/index.html');
    expect(r.status).toBe(200);
  });

  it('staticUi serves files under root and never outside it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trav-sim-ui-'));
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<html>trav</html>');
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
    const handler = staticUi(root);
    const run = (url: string) =>
      new Promise<{ status: number; type: string; next: boolean; body: string }>((resolve) => {
        // Static files are piped, so the response must be a real writable stream.
        const sink = new PassThrough();
        let status = 0;
        let type = '';
        const chunks: Buffer[] = [];
        sink.on('data', (c: Buffer) => chunks.push(c));
        sink.on('end', () =>
          resolve({ status, type, next: false, body: Buffer.concat(chunks).toString() }),
        );
        Object.assign(sink, {
          writeHead(s: number, h: Record<string, string>) {
            status = s;
            type = h['content-type'] ?? '';
            return sink;
          },
        });
        handler(fakeReq({ url }), sink as unknown as ServerResponse, () =>
          resolve({ status: 0, type: '', next: true, body: '' }),
        );
      });
    expect(await run('/assets/app.js')).toMatchObject({
      status: 200,
      type: 'text/javascript; charset=utf-8',
      body: 'console.log(1)',
    });
    expect(await run('/some/spa/route')).toMatchObject({ status: 200, body: '<html>trav</html>' });
    // Encoded parent-directory segments: refused, or answered with index.html from inside root.
    const up = '%2e%2e';
    const escaped = await run(`/${up}/${up}/${up}/etc/hosts`);
    expect(escaped.next || escaped.body === '<html>trav</html>').toBe(true);
  });

  it('listenLocal binds 127.0.0.1 only (never 0.0.0.0)', async () => {
    const calls: unknown[][] = [];
    const fake = Object.assign(new EventEmitter(), {
      listen(...args: unknown[]) {
        calls.push(args);
        (args[2] as () => void)();
        return fake;
      },
      address: () => ({ port: 5179, address: '127.0.0.1', family: 'IPv4' }),
    });
    const port = await listenLocal(fake as unknown as Server, 5179);
    expect(port).toBe(5179);
    expect(calls[0]?.slice(0, 2)).toEqual([5179, '127.0.0.1']);
    expect(SIM_HOST).toBe('127.0.0.1');
  });

  it('parsePort defaults to 5179 and rejects junk', () => {
    expect(parsePort(undefined)).toBe(5179);
    expect(parsePort('')).toBe(5179);
    expect(parsePort('6000')).toBe(6000);
    expect(() => parsePort('http')).toThrow(/TRAV_SIM_PORT/);
    expect(() => parsePort('70000')).toThrow(/TRAV_SIM_PORT/);
  });
});
