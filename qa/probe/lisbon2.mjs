import { api, show, say, lastTrav, tap } from './lib.mjs';
const G = 'grp_lisbon';
await api('POST', '/api/reset');
await show(G);
for (const [who, text] of [
  ['h_lis_dad', '@trav remember my conference is thursday 9-5 and friday 9-1'],
  ['h_lis_dean', '@trav get 2 tickets for benfica vs porto'],
  ['h_lis_dean', '@trav any matches this week?'],
  ['h_lis_dean', '@trav what can i do today on my own'],
  ['h_lis_dean', '@trav suggest something for me while dad is busy'],
  ['h_lis_dean', '@trav things to do this afternoon'],
  ['h_lis_dad', '@trav book us a sunset sail at 3pm thursday'],
  ['h_lis_dean', '@trav set a budget of €100 a day'],
  ['h_lis_dean', '@trav where are we on budget'],
  ['h_lis_dean', '@trav fado tonight for 2'],
]) {
  await say(G, who, text);
  const g = await show(G, text);
  const t = lastTrav(g);
  if (t?.card?.type === 'booking_proposal') console.log('  (proposal)');
}
