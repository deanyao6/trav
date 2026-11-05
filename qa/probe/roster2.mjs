import { api, show, say, react, lastTrav } from './lib.mjs';
const G = 'grp_barcelona';
for (const [who, ask] of [
  ['h_piotr', '@trav get barça tickets for all of us'],
  ['h_dean', '@trav get barça tickets for all of us'],
  ['h_piotr', '@trav just buy the barça tickets for all 6 now'],
  ['h_dean', '@trav get razz tickets for all of us'],
  ['h_piotr', "@trav get the 5 of us Razzmatazz tickets, Henry's sick"],
]) {
  await api('POST', '/api/reset');
  await show(G);
  await say(G, who, ask);
  const g = await show(G, ask);
  const m = lastTrav(g);
  if ((m?.text ?? '').includes("if that's right")) {
    await react(who, m.messageId, '👍');
    await show(G, 'after thumbs up');
  }
}
