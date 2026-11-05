import { api, show, say, tap, lastTrav, clock, state } from './lib.mjs';
const G = 'grp_turks_caicos';
const MOM = 'h_tci_mom', DAD = 'h_tci_dad', DEAN = 'h_tci_dean', LILY = 'h_tci_lily';
await api('POST', '/api/reset');
await show(G, 'seed');
const steps = [
  [MOM, '@trav roast mode on'],
  [DEAN, '@trav roast mode on'],
  [DEAN, '@trav roast lily for taking 40 min in the bathroom'],
  [DEAN, '@trav roast dad for his sunburn'],
  [DEAN, '@trav roast dad for spending $200 on souvenirs'],
  [DEAN, '@trav any good clubs or bars tonight? lily can come lol'],
  [LILY, '@trav where can i get a drink tonight'],
  [DEAN, "@trav what's good for tonight for the four of us"],
  [DAD, '@trav snorkel tour for all 4 on monday morning'],
  [MOM, '@trav add $142 dinner at conch corner last night'],
  [LILY, '@trav i got everyone smoothies, $24'],
  [LILY, '@trav book me a jet ski for tomorrow'],
  [DAD, "@trav dad and i want a quiet bar for a nightcap after lily's asleep. dean you in?"],
  [MOM, "@trav casino night tonight for me and dad? we're both 21+"],
  [DEAN, '@trav get rum punch for everyone at the beach bar'],
  [LILY, '@trav lily is actually 18 now'],
  [LILY, '@trav roast mode on'],
];
for (const [who, text] of steps) {
  await say(G, who, text);
  const g = await show(G, text.slice(0, 50));
  const t = lastTrav(g);
  if (t?.card?.type === 'booking_proposal') {
    console.log('  proposal actions', JSON.stringify(t.actions?.map((a) => [a.id, a.allowedMemberIds])));
  }
}
await clock('morning', G);
await show(G, 'morning');
await clock('end_of_trip', G);
const g = await show(G, 'wrapped');
console.log(JSON.stringify(lastTrav(g, 'wrapped')?.card?.awards));
