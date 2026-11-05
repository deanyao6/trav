import { api, state } from './lib.mjs';
await api('POST', '/api/reset');
const t0 = performance.now();
let steps = 0;
let slow = 0;
let errors = 0;
let last;
for (;;) {
  const r = await api('POST', '/api/replay/step');
  steps++;
  if (r.status !== 200) { errors++; console.log('step', steps, r.status, JSON.stringify(r.json).slice(0, 200)); break; }
  if (r.ms > 1000) slow++;
  last = r.json.replay;
  if (steps === 1) console.log('replay view keys', Object.keys(last ?? {}), JSON.stringify(last).slice(0, 300));
  if (last?.done || last?.remaining === 0 || steps > 400) break;
}
console.log({ steps, slow, errors, totalMs: Math.round(performance.now() - t0), last: JSON.stringify(last).slice(0, 300) });
const s = await state();
const g = s.groups.find((x) => x.group.groupId === 'grp_barcelona');
const trav = g.thread.filter((m) => m.isTrav);
const types = {};
for (const m of trav) types[m.card?.type ?? 'text'] = (types[m.card?.type ?? 'text'] ?? 0) + 1;
console.log('trav messages', trav.length, types);
const fallbacks = trav.filter((m) => (m.text ?? '').includes("i'm not sure what you mean"));
console.log('fallbacks', fallbacks.length);
const degraded = g.thread.filter((m) => m.degraded);
console.log('degraded', degraded.length);
const leaks = g.thread.filter((m) => /venmo:\/\/|card import on|email import on|zelle dean@/.test(m.text ?? '') && m.isTrav);
console.log('private-looking text in group', leaks.map((m) => m.text.slice(0, 80)));
const stack = JSON.stringify(s).match(/at [A-Za-z.]+ \(.*\.ts:\d+/g);
console.log('stack traces in state', stack?.length ?? 0);
for (const m of trav.slice(-12)) console.log('  trav:', `[${m.card?.type ?? 'text'}]`, (m.text ?? '').split('\n')[0]);
