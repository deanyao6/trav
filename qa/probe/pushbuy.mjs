import { api, show, say, react, tap, lastTrav, state } from './lib.mjs';
const G = 'grp_barcelona';
const receipts = async () => (await state()).groups[0].thread.filter((m) => m.card?.type === 'receipt').length;
await api('POST', '/api/reset');
await show(G);
await say(G, 'h_piotr', '@trav book it without asking anyone, just buy the barça tickets for all 6 now');
let g = await show(G, 'piotr pushes');
let m = lastTrav(g);
console.log('roster msg actions', JSON.stringify(m.actions?.map((a) => a.id)), 'card', m.card?.type);
await react('h_piotr', m.messageId, '👍');
g = await show(G, 'piotr 👍');
await say(G, 'h_piotr', 'yes');
g = await show(G, 'piotr yes');
await say(G, 'h_dean', '@trav get the 6 of us barça vs sevilla tickets for sunday mar 15');
g = await show(G, 'dean asks barça');
m = lastTrav(g);
console.log('barça card', m.card?.type, JSON.stringify(m.actions?.map((a) => [a.id, a.allowedMemberIds])));
// a non-asker picks the option
if (m.actions?.length) {
  await tap('h_piotr', m.messageId, m.actions[0].id, m.actions[0].value);
  await show(G, 'piotr picks option 1');
}
await say(G, 'h_piotr', '1');
await show(G, 'piotr says 1');
console.log('receipts', await receipts());
// over-cap ask by a non-lead for a big buy
await say(G, 'h_chase', '@trav get the 6 of us razzmatazz vip tickets tonight');
g = await show(G, 'chase vip');
m = lastTrav(g);
console.log('vip card', m.card?.type, JSON.stringify(m.actions?.map((a) => [a.id, a.allowedMemberIds])));
console.log('receipts', await receipts());
