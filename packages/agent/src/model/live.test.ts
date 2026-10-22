import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testClock } from '../context/testkit.js';
import { createModelClient, readModelEnv } from './client.js';
import { createSdkTransport } from './live.js';

const KEY = 'sk-test-TRAV-ONLY-0000';
const OTHER = 'sk-test-WRONG-ANTHROPIC-KEY';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A fake `fetch` that records the request and returns a canned Messages API body. No socket. */
function fakeFetch(): typeof fetch & {
  requests: { url: string; headers: Headers; body: unknown }[];
} {
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: 'hola' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch & { requests: { url: string; headers: Headers; body: unknown }[] };
  fn.requests = requests;
  return fn;
}

describe('createSdkTransport (real SDK, fake fetch)', () => {
  it('sends TRAV_ANTHROPIC_API_KEY, never ANTHROPIC_API_KEY, and maps the reply', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', OTHER);
    const f = fakeFetch();
    const env = readModelEnv({
      TRAV_ANTHROPIC_API_KEY: KEY,
      TRAV_STATE_DIR: mkdtempSync(join(tmpdir(), 'trav-live-')),
    });
    const client = createModelClient({
      env,
      clock: testClock('2026-03-14T21:40:00+01:00'),
      transport: createSdkTransport({ apiKey: KEY, fetch: f, maxRetries: 0 }),
    });
    const res = await client.complete({
      model: 'main',
      systemPromptId: 'group_chat_v1',
      system: 'you are trav',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(res).toMatchObject({
      text: 'hola',
      source: 'live',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(f.requests).toHaveLength(1);
    const req = f.requests[0];
    expect(req?.url).toMatch(/\/v1\/messages$/);
    // SDK 1.1.0 sends the key as a bearer token; older SDKs used x-api-key. Either way it is OUR key.
    const auth = req?.headers.get('x-api-key') ?? req?.headers.get('authorization');
    expect(auth === KEY || auth === `Bearer ${KEY}`).toBe(true);
    expect(JSON.stringify([...(req?.headers.entries() ?? [])])).not.toContain(OTHER);
    expect(req?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      system: 'you are trav',
      max_tokens: 1024,
    });
  });
});
