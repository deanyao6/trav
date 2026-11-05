import { state } from './lib.mjs';
const n = Number(process.argv[2] ?? 40);
const gid = process.argv[3] ?? 'grp_barcelona';
const s = await state();
const g = s.groups.find((x) => x.group.groupId === gid);
for (const m of g.thread.slice(-n)) {
  const who = m.isTrav ? 'trav' : m.fromName;
  console.log(m.at.slice(5, 16), `${who}:`, (m.text ?? m.kind).split('\n').join(' / ').slice(0, 260));
}
