import { api, say, clock, state } from './lib.mjs';
const G = 'grp_barcelona';
const now = async () => (await state()).groups.find((x) => x.group.groupId === G).now;
const lastTrav = async () => {
  const t = (await state()).groups.find((x) => x.group.groupId === G).thread.filter((m) => m.isTrav);
  return (t.at(-1)?.text ?? '').split('\n')[0];
};
console.log('before reset', await now());
await api('POST', '/api/reset');
console.log('after reset', await now());
await say(G, 'h_dean', '@trav i paid €84 for dinner, split with everyone but Henry');
console.log('after dinner', await now());
await say(G, 'h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
console.log('after razz', await now(), await lastTrav());
await new Promise((r) => setTimeout(r, 1500));
console.log('1.5s later', await now());
await say(G, 'h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
console.log('repeat', await now(), await lastTrav());
for (let i = 0; i < 4; i++) {
  await clock('hour', G);
  console.log('hour', i + 1, await now());
}
await clock('morning', G);
console.log('morning', await now());
