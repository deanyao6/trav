import { api, show, say, tap, lastTrav } from './lib.mjs';
const G = 'grp_barcelona';
await api('POST', '/api/reset');
await show(G);
await say(G, 'h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
await show(G, 'razz');
await say(G, 'h_arjun', 'email receipts on', 'dm');
await say(G, 'h_dean', 'card import on', 'dm');
await show(G, 'consent');
for (const doc of ['doc_bcn_arjun_email_1', 'doc_bcn_dean_card_1', 'doc_bcn_chase_email_1']) {
  const r = await api('POST', '/api/intake', { docId: doc });
  console.log(`> intake ${doc} -> ${r.status} [${r.ms}ms]`);
  await show(G, 'after ' + doc);
}
const dm = async (id) => (await api('GET', `/api/dms/${id}`)).json.thread;
for (const [id, h] of [['mem_arjun', 'h_arjun'], ['mem_dean', 'h_dean']]) {
  const t = await dm(id);
  const p = [...t].reverse().find((m) => m.actions?.length);
  console.log(id, 'prompt card', p?.card?.type, JSON.stringify(p?.actions?.map((a) => a.id)));
  if (!p) continue;
  const share = p.actions.find((a) => /share|yes|confirm/i.test(a.id)) ?? p.actions[0];
  await tap('h_henry', p.messageId, share.id);
  await show(G, `henry taps ${id}'s private prompt`);
  await tap(h, p.messageId, share.id);
  await tap(h, p.messageId, share.id);
  await show(G, `${id} shares (x2)`);
}
const g = await show(G, 'group thread check');
const group = g.thread.filter((m) => m.isTrav).map((m) => (m.text ?? '').split('\n')[0]);
console.log('group trav lines:', group);
