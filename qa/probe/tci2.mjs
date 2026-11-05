import { api, show, say, tap, react, lastTrav } from './lib.mjs';
const G = 'grp_turks_caicos';
await api('POST', '/api/reset');
await show(G);
await say(G, 'h_tci_dad', '@trav snorkel tour for all 4 on monday morning');
let g = await show(G, 'snorkel');
const p = lastTrav(g, 'booking_proposal');
await tap('h_tci_lily', p.messageId, 'approve');
await react('h_tci_lily', p.messageId, '👍');
await show(G, 'lily approves (minor)');
await tap('h_tci_mom', p.messageId, 'approve');
await show(G, 'mom approves (not payer)');
await tap('h_tci_dad', p.messageId, 'approve');
await tap('h_tci_dad', p.messageId, 'approve');
await show(G, 'dad approves x2');
for (const id of ['mem_tci_mom', 'mem_tci_dad', 'mem_tci_dean', 'mem_tci_lily']) {
  const t = (await api('GET', `/api/dms/${id}`)).json.thread;
  console.log(id, t.map((m) => `${m.card?.type ?? 'text'}:${(m.card?.holderName ?? m.text ?? '').slice(0, 70).replace(/\n/g, ' / ')}`).join(' || '));
}
await say(G, 'h_tci_lily', '@trav book me a jet ski for tomorrow');
await show(G, 'jet ski');
await say(G, 'h_tci_lily', '@trav ok book the tuesday jet ski for me');
g = await show(G, 'lily books tue jet ski');
const j = lastTrav(g);
console.log('actions', JSON.stringify(j?.actions?.map((a) => [a.id, a.allowedMemberIds])));
