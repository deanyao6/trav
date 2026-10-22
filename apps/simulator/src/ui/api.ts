/**
 * Browser client for the simulator server (same origin, `/api`). The UI never
 * talks to anything else.
 */
import type { SimInbound, SimState } from '../shared/types.js';

async function post(path: string, body: unknown): Promise<{ state?: SimState }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { error?: string; state?: SimState };
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json;
}

const PATHS: Readonly<Record<SimInbound['type'], string>> = {
  message: '/api/messages',
  reaction: '/api/reactions',
  button_tap: '/api/button-taps',
};

export async function inject(input: SimInbound): Promise<SimState | undefined> {
  const { type: _type, ...body } = input;
  return (await post(PATHS[input.type], body)).state;
}

export async function resetDemo(): Promise<SimState | undefined> {
  return (await post('/api/reset', {})).state;
}

export async function fetchState(): Promise<SimState> {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(`state request failed (${res.status})`);
  return (await res.json()) as SimState;
}

/** Live state over SSE; reconnects automatically (EventSource does). */
export function subscribeState(onState: (s: SimState) => void, onError: () => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) =>
    onState(JSON.parse((e as MessageEvent<string>).data) as SimState),
  );
  es.onerror = onError;
  return () => es.close();
}
