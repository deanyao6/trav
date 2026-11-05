import { api, show, say } from './lib.mjs';
const G = 'grp_barcelona';
const s = await api('GET', '/api/state');
const g = s.json.groups[0];
console.log('thread kinds tail:', g.thread.slice(-4).map((m) => [m.kind, m.lane, m.isTrav, (m.text ?? '').slice(0, 40)]));
await show(G);
await say(G, 'h_dean', '@trav how much have we spent so far');
await show(G, 'spent so far');
