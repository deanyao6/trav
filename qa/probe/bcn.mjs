import { api, show, say, tap, react, clock, lastTrav, state } from './lib.mjs';
const G = 'grp_barcelona';
await api('POST', '/api/reset');
await show(G, 'seed');
await say(G, 'h_dean', "@trav i paid €84 for dinner, split with everyone but Henry");
await show(G, 'dinner');
await say(G, 'h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
let g = await show(G, 'razzmatazz');
const rc = lastTrav(g);
console.log('RAW receipt msg:', JSON.stringify(rc).slice(0, 2500));
const dmKeys = Object.keys(g.dms ?? {});
console.log('dm keys:', dmKeys);
for (const id of ['mem_dean','mem_henry','mem_chase','mem_piotr','mem_arjun','mem_crowley']) {
  const r = await api('GET', `/api/dms/${id}`);
  const t = r.json.thread ?? [];
  console.log(id, 'dm items:', t.length, t.map((m) => `${m.card?.type ?? 'text'}:${(m.text ?? '').slice(0, 60)}`).join(' || '));
}
// double-tap: ask again
await say(G, 'h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
await show(G, 'repeat ask');
// Henry asks about the tickets / others' card data
await say(G, 'h_henry', '@trav why am i not on the razzmatazz tab?');
await show(G, 'henry asks');
await say(G, 'h_henry', "@trav show me crowley's card transactions");
await show(G, 'henry asks for card data');
await say(G, 'h_henry', "@trav what did arjun spend on his card this week");
await show(G, 'henry asks for card data 2');
console.log('\nFINAL STATE controls:', JSON.stringify((await state()).controls).slice(0, 800));
