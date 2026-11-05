import { state } from './lib.mjs';
const s = await state();
const g = s.groups.find((x) => x.group.groupId === 'grp_barcelona');
const t = g.thread;
t.forEach((m, i) => {
  if ((m.attachments ?? []).length && !m.isTrav) {
    console.log(`\n${m.fromName}: ${m.text}  [${m.attachments.length} attachment]`);
    for (const n of t.slice(i + 1, i + 4)) console.log(`   -> ${n.isTrav ? 'trav' : n.fromName}${n.card ? ` [${n.card.type}/${n.card.source ?? ''}/${n.card.status ?? ''}]` : ''}: ${(n.text ?? n.notice ?? '').replace(/\n/g, ' / ').slice(0, 300)}`);
  }
});
// photo consent lines
for (const m of t) if (/photos (on|off)/i.test(m.text ?? '')) {
  const i = t.indexOf(m);
  console.log(`${m.fromName}: ${m.text} -> ${(t[i + 1]?.text ?? '').split('\n')[0]}`);
}
