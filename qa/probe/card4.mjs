import { show, clock } from './lib.mjs';
const G = 'grp_barcelona';
await show(G);
await clock('hour', G);
await show(G, 'after +1 hour');
