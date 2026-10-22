/**
 * The simulator's JSON API, as a plain function of (method, path, body) so it
 * is unit-testable without a socket. `http.ts` adapts it to `node:http` and
 * adds the SSE stream.
 *
 *   GET  /api/state                 SimState (group threads already filtered)
 *   GET  /api/dms/:memberId         one member's DM thread
 *   POST /api/messages              { from, text, groupId?, lane? }
 *   POST /api/reactions             { from, targetMessageId, reaction, removed? }
 *   POST /api/button-taps           { from, cardMessageId, actionId, value? }
 *   POST /api/reset                 back to demo state 1 (scripted backend only)
 *
 * Inbound endpoints go through `backend.inject`, i.e. the simulator channel,
 * which assigns ids and times and checks the sender is in the chat; a button
 * tap becomes an `InboundButtonTap`, the same event the agent normalizes into
 * an `ApprovalEvent` for a 👍 tapback.
 */
import type { SimInbound } from '../shared/types.js';
import type { SimulatorBackend } from './backend.js';

export interface ApiRequest {
  readonly method: string;
  /** Path without the query string. */
  readonly path: string;
  readonly body?: unknown;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Longest chat line the simulator accepts (a real phone would let you paste more; nobody types it). */
export const MAX_TEXT_LENGTH = 2000;
const MAX_ID_LENGTH = 200;

class BadRequest extends Error {}

function field(body: Record<string, unknown>, name: string, max = MAX_ID_LENGTH): string {
  const v = body[name];
  if (typeof v !== 'string' || v.length === 0) throw new BadRequest(`${name} is required`);
  if (v.length > max) throw new BadRequest(`${name} is too long`);
  return v;
}

function optionalField(body: Record<string, unknown>, name: string): string | undefined {
  const v = body[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > MAX_ID_LENGTH)
    throw new BadRequest(`${name} must be a short string`);
  return v;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequest('expected a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Validates a POST body into a `SimInbound`. Exported for tests. */
export function parseInbound(kind: SimInbound['type'], raw: unknown): SimInbound {
  const body = asObject(raw);
  const from = field(body, 'from');
  switch (kind) {
    case 'message': {
      const text = field(body, 'text', MAX_TEXT_LENGTH);
      if (text.trim().length === 0) throw new BadRequest('text is empty');
      const lane = body['lane'];
      if (lane !== undefined && lane !== 'group' && lane !== 'dm') {
        throw new BadRequest('lane must be group or dm');
      }
      const groupId = optionalField(body, 'groupId');
      return {
        type: 'message',
        from,
        text,
        ...(groupId !== undefined ? { groupId } : {}),
        ...(lane !== undefined ? { lane } : {}),
      };
    }
    case 'reaction': {
      const removed = body['removed'];
      if (removed !== undefined && typeof removed !== 'boolean') {
        throw new BadRequest('removed must be a boolean');
      }
      return {
        type: 'reaction',
        from,
        targetMessageId: field(body, 'targetMessageId'),
        reaction: field(body, 'reaction', 32),
        ...(removed !== undefined ? { removed } : {}),
      };
    }
    case 'button_tap': {
      const value = optionalField(body, 'value');
      return {
        type: 'button_tap',
        from,
        cardMessageId: field(body, 'cardMessageId'),
        actionId: field(body, 'actionId', 32),
        ...(value !== undefined ? { value } : {}),
      };
    }
  }
}

const INBOUND_ROUTES: Readonly<Record<string, SimInbound['type']>> = {
  '/api/messages': 'message',
  '/api/reactions': 'reaction',
  '/api/button-taps': 'button_tap',
};

export async function handleApi(backend: SimulatorBackend, req: ApiRequest): Promise<ApiResponse> {
  try {
    if (req.method === 'GET' && req.path === '/api/state') {
      return { status: 200, body: backend.state() };
    }
    const dm = /^\/api\/dms\/([A-Za-z0-9_-]+)$/.exec(req.path);
    if (req.method === 'GET' && dm) {
      const memberId = dm[1]!;
      if (!backend.members.some((m) => m.memberId === memberId)) {
        return { status: 404, body: { error: `unknown member ${memberId}` } };
      }
      return { status: 200, body: { memberId, thread: backend.dms(memberId) } };
    }
    const kind = INBOUND_ROUTES[req.path];
    if (kind !== undefined) {
      if (req.method !== 'POST') return { status: 405, body: { error: 'use POST' } };
      const input = parseInbound(kind, req.body);
      let event;
      try {
        event = await backend.inject(input);
      } catch (e) {
        // The channel's checks: unknown sender, not in this chat, no such button, someone else's DM.
        return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
      }
      const messageId = 'messageId' in event ? event.messageId : undefined;
      return {
        status: 200,
        body: { ok: true, type: event.type, messageId, state: backend.state() },
      };
    }
    if (req.path === '/api/reset') {
      if (req.method !== 'POST') return { status: 405, body: { error: 'use POST' } };
      if (!backend.reset) return { status: 409, body: { error: 'this backend cannot reset' } };
      await backend.reset();
      return { status: 200, body: { ok: true, state: backend.state() } };
    }
    return { status: 404, body: { error: `no route ${req.method} ${req.path}` } };
  } catch (e) {
    if (e instanceof BadRequest) return { status: 400, body: { error: e.message } };
    throw e;
  }
}
