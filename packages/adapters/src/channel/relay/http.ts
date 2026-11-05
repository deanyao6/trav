/**
 * The relay's inbound HTTP receiver (T-169): `POST <path>` with the vendor's
 * webhook JSON. The handler reads the raw body (capped), passes it with the
 * headers to `RelayChannel.handleWebhook`, and answers with the outcome's
 * status as soon as the delivery is accepted, so a slow agent turn never makes
 * the vendor time out and redeliver (redeliveries are deduped anyway).
 *
 * Dev binds 127.0.0.1 only (`listenRelayWebhook` refuses any other host),
 * and requests whose Host header is not loopback are refused, so a page in a
 * browser can't post into it via DNS rebinding. Reaching it from a vendor
 * needs a tunnel you start yourself (docs/RELAY.md); nothing here opens one.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { RelayWebhookOutcome } from './core.js';
import { MAX_WEBHOOK_BYTES } from './core.js';
import type { RelayHeaders } from './types.js';

export const RELAY_HOST = '127.0.0.1';
export const DEFAULT_RELAY_PORT = 5181;
export const DEFAULT_WEBHOOK_PATH = '/relay/webhook';

/** Anything with a `handleWebhook` (the channel, or a forwarder to the current session's one). */
export interface WebhookTarget {
  handleWebhook(input: {
    rawBody: string;
    headers: RelayHeaders;
    query?: string;
  }): Promise<RelayWebhookOutcome>;
}

export interface RelayWebhookHandlerOptions {
  readonly target: WebhookTarget;
  readonly path?: string;
  /** Default true in dev: refuse requests whose Host is not loopback. Off behind a tunnel. */
  readonly loopbackHostOnly?: boolean;
  readonly onError?: (why: string) => void;
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** Reads the request body as UTF-8, refusing past `limit` bytes. */
export function readBody(
  req: IncomingMessage,
  limit = MAX_WEBHOOK_BYTES,
): Promise<string | 'too_large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer | string) => {
      if (over) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > limit) {
        over = true;
        resolve('too_large');
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export function createRelayWebhookHandler(
  options: RelayWebhookHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const path = options.path ?? DEFAULT_WEBHOOK_PATH;
  const loopbackOnly = options.loopbackHostOnly ?? true;
  return async (req, res) => {
    try {
      if (loopbackOnly && !isLoopbackHost(req.headers.host)) {
        send(res, 403, { error: 'loopback only' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/healthz' && req.method === 'GET') {
        send(res, 200, { ok: true });
        return;
      }
      if (url.pathname !== path) {
        send(res, 404, { error: 'not found' });
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        send(res, 405, { error: 'POST only' });
        return;
      }
      const raw = await readBody(req);
      if (raw === 'too_large') {
        send(res, 413, { error: 'too large' });
        return;
      }
      // The query goes to the channel as is: BlueBubbles carries its shared
      // secret there (`?token=…`), so it is never logged.
      const outcome = await options.target.handleWebhook({
        rawBody: raw,
        headers: req.headers,
        query: url.search,
      });
      // The agent turn runs after the ack; its errors are the channel's to report.
      void outcome.delivered.catch(() => undefined);
      send(res, outcome.status, {
        ok: outcome.status === 200,
        accepted: outcome.accepted,
        duplicates: outcome.duplicates,
      });
    } catch (e) {
      options.onError?.(e instanceof Error ? e.name : 'error');
      send(res, 500, { error: 'internal' });
    }
  };
}

/** A server for the handler (not yet listening). */
export function createRelayWebhookServer(options: RelayWebhookHandlerOptions): Server {
  const handler = createRelayWebhookHandler(options);
  return createServer((req, res) => {
    void handler(req, res);
  });
}

/** Listens on 127.0.0.1 only. Resolves with the bound port. */
export function listenRelayWebhook(
  server: Server,
  port: number,
  host: string = RELAY_HOST,
): Promise<number> {
  if (host !== RELAY_HOST) {
    return Promise.reject(new Error(`the relay webhook binds ${RELAY_HOST} only, not ${host}`));
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, RELAY_HOST, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
    });
  });
}
