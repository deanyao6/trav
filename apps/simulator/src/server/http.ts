/**
 * `node:http` adapter for the simulator API plus a Server-Sent Events stream
 * (`GET /api/events`, one `state` event per change). Binds 127.0.0.1 only.
 *
 * Local-only hardening (the simulator runs on a laptop next to a browser):
 * - requests whose Host header is not 127.0.0.1/localhost are refused (blocks
 *   DNS-rebinding pages from driving the simulator);
 * - POST bodies must be `application/json` (a cross-site HTML form cannot send
 *   that without a CORS preflight, which this server never answers) and at
 *   most 64 KB;
 * - no CORS headers are ever sent.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { SimulatorBackend } from './backend.js';
import { receiptImage } from './receipts.js';
import { handleApi } from './routes.js';

export const SIM_HOST = '127.0.0.1';
export const DEFAULT_SIM_PORT = 5179;
const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 25_000;

/** Express-style fallthrough for non-API requests (Vite's dev middleware, or static files). */
export type UiHandler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export interface SimRequestHandlerOptions {
  readonly backend: SimulatorBackend;
  readonly ui?: UiHandler;
  /** Heartbeat interval for SSE (tests use a small one or none). */
  readonly heartbeatMs?: number;
}

export function isLocalHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new RangeError('body too large');
    chunks.push(buf);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function openEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  backend: SimulatorBackend,
  heartbeatMs: number,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const push = (): void => {
    res.write(`event: state\ndata: ${JSON.stringify(backend.state())}\n\n`);
  };
  push();
  const unsubscribe = backend.subscribe(push);
  const heartbeat =
    heartbeatMs > 0 ? setInterval(() => res.write(': ping\n\n'), heartbeatMs) : undefined;
  const close = (): void => {
    unsubscribe();
    if (heartbeat) clearInterval(heartbeat);
  };
  req.on('close', close);
  res.on('close', close);
}

/** The request handler, usable without `listen()` (tests dispatch fake requests into it). */
export function createSimRequestHandler(
  options: SimRequestHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { backend, ui } = options;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  return async (req, res) => {
    try {
      if (!isLocalHost(req.headers.host)) {
        sendJson(res, 403, { error: 'the simulator only answers on 127.0.0.1' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      if (!path.startsWith('/api/')) {
        if (ui) {
          ui(req, res, () => sendJson(res, 404, { error: 'not found' }));
        } else {
          sendJson(res, 404, { error: 'no UI mounted; run `pnpm sim` or build the UI first' });
        }
        return;
      }
      const method = req.method ?? 'GET';
      if (method === 'GET' && path === '/api/events') {
        openEventStream(req, res, backend, heartbeatMs);
        return;
      }
      // T-199: a posted fixture receipt photo, by listed id only.
      const receipt = /^\/api\/receipts\/(rcpt_[a-z0-9_]+)\.png$/.exec(path);
      if (receipt !== null && (method === 'GET' || method === 'HEAD')) {
        const bytes = receiptImage(receipt[1]!);
        if (bytes === undefined) {
          sendJson(res, 404, { error: 'no such receipt photo' });
          return;
        }
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(bytes.length),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(method === 'HEAD' ? undefined : bytes);
        return;
      }
      let body: unknown;
      if (method === 'POST') {
        const type = req.headers['content-type'] ?? '';
        if (!type.toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { error: 'send application/json' });
          return;
        }
        try {
          body = await readJson(req);
        } catch (e) {
          const tooLarge = e instanceof RangeError;
          sendJson(res, tooLarge ? 413 : 400, {
            error: tooLarge ? 'body too large' : 'invalid JSON',
          });
          return;
        }
      }
      const result = await handleApi(backend, { method, path, body });
      sendJson(res, result.status, result.body);
    } catch (e) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : 'internal error' });
      } else {
        res.end();
      }
    }
  };
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** Serves a built UI (`dist/ui`) with an SPA fallback to index.html. Refuses paths outside `root`. */
export function staticUi(root: string): UiHandler {
  const base = normalize(root + sep);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    let file = normalize(join(base, pathname));
    if (!file.startsWith(base)) return next();
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(base, 'index.html');
    if (!existsSync(file)) return next();
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(file).pipe(res);
  };
}

/** Creates the server (not yet listening). `server.listen(port, SIM_HOST)` is done by `startSimServer`. */
export function createSimServer(options: SimRequestHandlerOptions): Server {
  const handler = createSimRequestHandler(options);
  return createServer((req, res) => {
    void handler(req, res);
  });
}

/** Starts the server on 127.0.0.1 (never 0.0.0.0). Resolves with the bound port. */
export function listenLocal(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, SIM_HOST, () => {
      server.off('error', reject);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
    });
  });
}

export function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_SIM_PORT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new RangeError(`TRAV_SIM_PORT must be a port number, got "${value}"`);
  }
  return n;
}
