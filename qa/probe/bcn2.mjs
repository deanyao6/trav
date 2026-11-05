import { api, show, say, tap, react, clock, lastTrav, state } from './lib.mjs';
const G = 'grp_barcelona';
await api('POST', '/api/reset');
await show(G, 'seed');
await say(G, 'h_dean', "@trav i paid €84 for dinner, split with everyone but Henry");
await say(G, 'h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
await show(G, 'razz');
// intake: Arjun email (Uber), Chase email (no consent?), Dean card
for (const doc of ['doc_bcn_arjun_email_1', 'doc_bcn_chase_email_1', 'doc_bcn_dean_card_1']) {
  const r = await api('POST', '/api/intake', { docId: doc });
  console.log(`> intake ${doc} -> ${r.status} [${r.ms}ms]`);
  await show(G, `after intake ${doc}`);
}
// feed same doc twice
const dup = await api('POST', '/api/intake', { docId: 'doc_bcn_arjun_email_1' });
console.log('> intake dup ->', dup.status, JSON.stringify(dup.json).slice(0, 200));
// Arjun shares
let arj = (await api('GET', '/api/dms/mem_arjun')).json.thread;
let prompt = [...arj].reverse().find((m) => m.actions?.length);
console.log('arjun prompt actions', JSON.stringify(prompt?.actions));
if (prompt) {
  // someone else tries to tap Arjun's private prompt
  await tap('h_henry', prompt.messageId, prompt.actions[0].id);
  await tap('h_arjun', prompt.messageId, prompt.actions[0].id);
  await tap('h_arjun', prompt.messageId, prompt.actions[0].id); // double tap
  await show(G, 'arjun shared');
}
let dean = (await api('GET', '/api/dms/mem_dean')).json.thread;
prompt = [...dean].reverse().find((m) => m.actions?.length);
console.log('dean prompt', prompt?.text, JSON.stringify(prompt?.actions));
if (prompt) { await tap('h_dean', prompt.messageId, prompt.actions[0].id); await show(G, 'dean shared card'); }
await clock('morning', G);
await show(G, 'morning after');
await say(G, 'h_dean', '@trav settle now');
let g = await show(G, 'settle');
const su = lastTrav(g, 'settle_up');
console.log('settle actions', JSON.stringify(su?.actions));
if (su) {
  await tap('h_chase', su.messageId, 'sent');
  await tap('h_chase', su.messageId, 'sent');
  await show(G, 'chase sent');
  await tap('h_henry', su.messageId, 'got_it');
  await show(G, 'henry (not payee) got it');
  await react('h_dean', su.messageId, '👍');
  await show(G, 'dean 👍');
}
await clock('end_of_trip', G);
g = await show(G, 'wrapped');
const w = lastTrav(g, 'wrapped');
console.log('wrapped card', JSON.stringify(w?.card).slice(0, 1500));
