import { api, say, clock, state } from './lib.mjs';
const G = 'grp_barcelona';
const trav = async () =>
  (await state()).groups
    .find((x) => x.group.groupId === G)
    .thread.filter((m) => m.isTrav)
    .map((m) => `${m.card?.type}@${m.at}: ${(m.text ?? '').split('\n')[0]}`);
// A: dinner + razz, straight to morning
await api('POST', '/api/reset');
await say(G, 'h_dean', '@trav i paid €84 for dinner, split with everyone but Henry');
await say(G, 'h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
await clock('morning', G);
console.log('A (straight to morning):', await trav());
// B: razz only, straight to morning
await api('POST', '/api/reset');
await say(G, 'h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
await clock('morning', G);
console.log('B (razz only):', await trav());
// C: dinner + razz + intake notice, morning
await api('POST', '/api/reset');
await say(G, 'h_dean', '@trav i paid €84 for dinner, split with everyone but Henry');
await say(G, 'h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
await api('POST', '/api/intake', { docId: 'doc_bcn_arjun_email_1' });
await clock('morning', G);
console.log('C (with intake notice):', await trav());
// D: 4 hours then morning, no chat
await api('POST', '/api/reset');
await say(G, 'h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
for (let i = 0; i < 4; i++) await clock('hour', G);
await clock('morning', G);
console.log('D (4h then morning, no chat):', await trav());
await clock('morning', G);
console.log('E (next morning):', (await trav()).slice(-3));
