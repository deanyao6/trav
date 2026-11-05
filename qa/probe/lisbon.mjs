import { api, show, say, tap, lastTrav, clock } from './lib.mjs';
const G = 'grp_lisbon';
const D = 'h_lis_dean';
const P = 'h_lis_dad';
await api('POST', '/api/reset');
await show(G, 'seed');
const steps = [
  [D, "@trav dad and i are doing lisbon apr 15-20. we both want to see a match, benfica sporting or porto, whoever's playing"],
  [D, '@trav derby tickets? any price'],
  [D, '@trav ok benfica vs porto then, 2 tickets, the normal ones'],
  [P, '@trav remember my conference is thursday 9-5 and friday 9-1'],
  [D, "@trav what should i do thursday while dad's at the conference? something you can't find anywhere else"],
  [D, "@trav what should i do today while dad's at the conference? something you can't find anywhere else"],
  [D, '@trav book the tile thing for me'],
  [P, '@trav can we do dinner at 2pm thursday?'],
  [D, '@trav find us a fado place tonight, nothing clubby'],
  [P, '@trav I paid 46,50 € for the tasca after, half each'],
  [D, "@trav what's dad's daily budget"],
  [P, "@trav I paid €38 for lunch but the conference covers it, leave it off"],
  [D, '@trav the sintra driver is 180 euro for the afternoon, 50/50 with dad'],
  [D, '@trav roast dad about his conference lanyard'],
  [D, "@trav any chill bars near the hotel? dad's not a club guy"],
  [D, '@trav sporting vs braga tonight? 2 tickets'],
  [D, '@trav how are we doing on budget'],
  [D, '@trav who owes who'],
];
for (const [who, text] of steps) {
  await say(G, who, text);
  const g = await show(G, text.slice(0, 50));
  const t = lastTrav(g);
  // auto-approve any proposal card from the right member so the flow continues
  if (t?.card?.type === 'booking_proposal' && t.actions?.some((a) => a.id === 'approve')) {
    console.log('  (proposal; Dean approves)');
    await tap(D, t.messageId, 'approve');
    await show(G, 'approved');
  }
}
await clock('morning', G);
await show(G, 'morning');
await clock('end_of_trip', G);
await show(G, 'wrapped');
