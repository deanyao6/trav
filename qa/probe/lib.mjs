// QA probe helper: drives the simulator's HTTP API (the same calls the UI makes) and
// prints what a user would see. Temporary QA tooling; lives under qa/ only.
const BASE = process.env.SIM_URL ?? 'http://127.0.0.1:5191';
const seen = new Map(); // key -> last seq printed

export async function api(method, path, body) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ms = Math.round(performance.now() - t0);
  if (method === 'POST' && path === '/api/reset') seen.clear();
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (res.status !== 200) console.log(`  !! ${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  if (ms > 1500) console.log(`  !! slow: ${method} ${path} took ${ms}ms`);
  return { status: res.status, json, ms };
}

export const state = async () => (await api('GET', '/api/state')).json;

function fmt(m) {
  const who = m.isTrav ? 'trav' : (m.fromName ?? m.from);
  const card = m.card ? ` [card:${m.card.type}]` : '';
  const acts = m.actions?.length ? ` {${m.actions.map((a) => a.label ?? a.id).join('|')}}` : '';
  const kind = m.kind !== 'message' ? `(${m.kind}) ` : '';
  const body = (m.text ?? m.notice ?? m.body ?? '').replace(/\n/g, '\n        ');
  return `${kind}${who}:${card}${acts} ${body}`;
}

export async function show(groupId, label = '') {
  const s = await state();
  const g = s.groups.find((x) => x.group.groupId === groupId);
  if (label) console.log(`\n=== ${label} (${g.now ?? s.now})`);
  const key = `g:${groupId}`;
  const last = seen.get(key) ?? -1;
  for (const m of g.thread) if (m.seq > last) console.log('  ' + fmt(m));
  seen.set(key, Math.max(last, ...g.thread.map((m) => m.seq)));
  for (const [mid, dm] of Object.entries(g.dms ?? {})) {
    const thread = Array.isArray(dm) ? dm : (dm.thread ?? []);
    const k = `dm:${groupId}:${mid}`;
    const l = seen.get(k) ?? -1;
    for (const m of thread) if (m.seq > l) console.log(`  [DM ${mid}] ` + fmt(m));
    if (thread.length) seen.set(k, Math.max(l, ...thread.map((m) => m.seq)));
  }
  return g;
}

export async function say(groupId, from, text, lane) {
  const r = await api('POST', '/api/messages', { from, text, groupId, ...(lane ? { lane } : {}) });
  console.log(`> ${from}${lane ? ` (${lane})` : ''}: ${text}   [${r.ms}ms]`);
  return r;
}
export async function tap(from, cardMessageId, actionId, value) {
  const r = await api('POST', '/api/button-taps', { from, cardMessageId, actionId, ...(value ? { value } : {}) });
  console.log(`> ${from} taps ${actionId} on ${cardMessageId}   [${r.ms}ms] -> ${r.status}`);
  return r;
}
export async function react(from, targetMessageId, reaction) {
  const r = await api('POST', '/api/reactions', { from, targetMessageId, reaction });
  console.log(`> ${from} reacts ${reaction} on ${targetMessageId}   [${r.ms}ms] -> ${r.status}`);
  return r;
}
export async function clock(step, groupId) {
  const r = await api('POST', '/api/clock', { step, groupId });
  console.log(`> clock ${step} ${groupId ?? ''}   [${r.ms}ms] -> ${r.status}`);
  return r;
}
export function lastTrav(g, type) {
  return [...g.thread].reverse().find((m) => m.isTrav && (!type || m.card?.type === type));
}
