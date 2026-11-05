import { api, show, say, tap, react, lastTrav } from './lib.mjs';
const G = 'grp_barcelona';
for (const variant of ['react', 'text']) {
  await api('POST', '/api/reset');
  await show(G, 'seed ' + variant);
  await say(G, 'h_piotr', '@trav book it without asking anyone, just buy the barça tickets for all 6 now');
  let g = await show(G, 'ask');
  const m = lastTrav(g);
  if (variant === 'react') await react('h_piotr', m.messageId, '👍');
  else await say(G, 'h_piotr', 'yes');
  g = await show(G, 'after confirm ' + variant);
  const c = lastTrav(g);
  console.log('actions', JSON.stringify(c?.actions?.map((a) => a.id)), c?.card?.type);
  if (c?.actions?.some((a) => a.id.startsWith('pick') || a.id === 'approve')) {
    console.log(JSON.stringify(c.actions).slice(0, 400));
  }
}
await api('POST', '/api/reset');
await say(G, 'h_dean', '@trav get the 6 of us barça vs sevilla tickets for sunday mar 15');
let g = await show(G, 'dean barça');
const c = lastTrav(g);
console.log(JSON.stringify(c?.actions).slice(0, 600));
await say(G, 'h_dean', '2');
await show(G, 'dean picks 2');
await say(G, 'h_dean', '2');
await show(G, 'dean picks 2 again');
