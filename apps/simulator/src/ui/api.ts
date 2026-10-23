/**
 * Browser client for the simulator server (same origin, `/api`). The UI never
 * talks to anything else.
 */
import type { ClockStep, SimInbound, SimState } from '../shared/types.js';

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

type UiInbound = Exclude<SimInbound, { type: 'member_joined' }>;

const PATHS: Readonly<Record<UiInbound['type'], string>> = {
  message: '/api/messages',
  reaction: '/api/reactions',
  button_tap: '/api/button-taps',
};

export async function inject(input: UiInbound): Promise<SimState | undefined> {
  const { type: _type, ...body } = input;
  return (await post(PATHS[input.type], body)).state;
}

export async function resetDemo(): Promise<SimState | undefined> {
  return (await post('/api/reset', {})).state;
}

/** Top-bar clock buttons: move the simulated clock and run what came due. */
export async function advanceClock(step: ClockStep, groupId: string): Promise<SimState | undefined> {
  return (await post('/api/clock', { step, groupId })).state;
}

/** DM rail: feed one of the selected member's own demo documents through Trav's intake. */
export async function feedDocument(docId: string): Promise<SimState | undefined> {
  return (await post('/api/intake', { docId })).state;
}

export async function replay(mode: 'step' | 'all'): Promise<SimState | undefined> {
  return (await post(`/api/replay/${mode}`, {})).state;
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
