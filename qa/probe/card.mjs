import { api, show, say, tap, clock } from './lib.mjs';
const G = 'grp_barcelona';
await api('POST', '/api/reset');
await show(G);
await say(G, 'h_dean', 'card import on', 'dm');
const r = await api('POST', '/api/intake', { docId: 'doc_bcn_dean_card_1' });
console.log('intake', r.status);
await show(G, 'after intake');
await clock('hour', G);
await show(G, '+1h');
await clock('morning', G);
await show(G, 'morning');
const t = (await api('GET', '/api/dms/mem_dean')).json.thread;
const p = [...t].reverse().find((m) => m.actions?.length);
console.log('dean prompt', p?.card?.type, JSON.stringify(p?.actions?.map((a) => a.id)), JSON.stringify(p?.card)?.slice(0, 600));
if (p) {
  await tap('h_dean', p.messageId, p.actions[0].id);
  await show(G, 'dean taps ' + p.actions[0].id);
}
