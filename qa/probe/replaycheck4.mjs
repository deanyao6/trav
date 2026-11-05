import { state } from './lib.mjs';
const s = await state();
const g = s.groups.find((x) => x.group.groupId === 'grp_barcelona');
const t = g.thread;
for (const needle of ["Arjun didn't drink", "Crowley's paying his own"]) {
  const i = t.findIndex((m) => (m.text ?? '').includes(needle));
  console.log(`\n"${needle}" at index ${i}`, i >= 0 ? JSON.stringify({ att: t[i].attachments, from: t[i].fromName }) : '');
  if (i >= 0) for (const n of t.slice(i + 1, i + 4)) console.log(`   -> ${n.isTrav ? 'trav' : n.fromName}${n.card ? ` [${n.card.type}/${n.card.source ?? ''}/${n.card.status ?? ''}]` : ''}: ${(n.text ?? n.notice ?? '').replace(/\n/g, ' / ').slice(0, 300)}`);
}
