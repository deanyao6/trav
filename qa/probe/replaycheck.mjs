import { api, state } from './lib.mjs';
await api('POST', '/api/reset');
const r = await api('POST', '/api/replay/all', {});
console.log('replay/all', r.status, r.ms + 'ms');
const s = await state();
const g = s.groups.find((x) => x.group.groupId === 'grp_barcelona');
const all = [...g.thread, ...Object.values(g.dms ?? {}).flatMap((d) => (Array.isArray(d) ? d : d.thread ?? []))];
const photo = all.filter((m) => m.card?.source === 'receipt_photo' || /receipt/i.test(m.card?.title ?? '') && m.card?.type === 'expense_confirm');
for (const m of photo) console.log(`[${m.lane}] ${m.card.type}/${m.card.source} status=${m.card.status}: ${(m.text ?? '').replace(/\n/g, ' / ')}`);
const fallbacks = g.thread.filter((m) => m.isTrav && /not sure what you mean/.test(m.text ?? ''));
console.log('fallback replies in group:', fallbacks.length);
for (const m of fallbacks) console.log('  FALLBACK after:', g.thread.filter((x) => x.seq < m.seq && !x.isTrav).at(-1)?.text);
const recaps = g.thread.filter((m) => m.card?.type === 'recap' || m.card?.type === 'wrapped');
for (const m of recaps) console.log(`${m.card.type} photos=${JSON.stringify((m.card.photos ?? []).map((p) => p.uploadedBy ?? p.memberId ?? p.photoId))}: ${(m.text ?? '').replace(/\n/g, ' / ')}`);
const statuses = g.thread.filter((m) => m.kind !== 'message').map((m) => m.notice ?? m.text).filter(Boolean);
console.log('notices sample:', statuses.slice(-8));
// any message text with suspicious tokens
const bad = all.filter((m) => /undefined|NaN|\[object|null\b/.test(m.text ?? ''));
console.log('suspicious texts:', bad.map((m) => m.text.slice(0, 120)));
