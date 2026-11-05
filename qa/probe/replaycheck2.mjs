import { state } from './lib.mjs';
// run after replaycheck.mjs (state already replayed)
const s = await state();
const g = s.groups.find((x) => x.group.groupId === 'grp_barcelona');
const dms = Object.entries(g.dms ?? {}).flatMap(([k, d]) => (Array.isArray(d) ? d : d.thread ?? []).map((m) => ({ ...m, _dm: k })));
const all = [...g.thread, ...dms];
for (const m of all.filter((m) => (m.attachments ?? []).length)) console.log('ATTACH', m._dm ?? 'group', m.fromName, (m.text ?? '').slice(0, 60), JSON.stringify(m.attachments).slice(0, 200));
for (const m of all.filter((m) => m.card && /receipt|read/i.test(JSON.stringify(m.card.source ?? '') + (m.text ?? '')) && m.card.type === 'expense_confirm')) console.log('RCPT', m._dm ?? 'group', m.card.source, m.card.status, (m.text ?? '').replace(/\n/g, ' / ').slice(0, 220));
const recap = g.thread.find((m) => m.card?.type === 'recap');
console.log('recap card keys', Object.keys(recap.card));
const w = g.thread.find((m) => m.card?.type === 'wrapped');
console.log('wrapped photos', JSON.stringify(w.card.photos), 'highlights', JSON.stringify(w.card.highlights ?? null));
const src = new Set(all.map((m) => m.card?.source).filter(Boolean));
console.log('card sources seen', [...src]);
