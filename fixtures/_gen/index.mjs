#!/usr/bin/env node
// Entry point: regenerates every synthetic fixture deterministically (no wall clock, no Math.random;
// all randomness is seeded in lib.mjs createRng). Usage:
//
//   pnpm fixtures:gen            write fixtures, print what changed
//   pnpm fixtures:gen --check    write nothing; exit 1 if any generator-owned file would change
//
// Ownership rule (so concurrent builders and hand-edited fixtures are never clobbered):
// a target file is written only if it is absent, already byte-identical, or still exactly what this
// generator last wrote (its sha256 matches fixtures/_gen/manifest.json). Anything else is reported
// as "preserved" and left alone. Files owned by adapter builders (tickets/barcelona.json,
// flights/barcelona.json, lodging/barcelona.json, fx/rates.json, ...) are read as inputs instead.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assert, FIXTURES_DIR, fmtMoney, sha256 } from './lib.mjs';
import { BCN, LIS, TCI, barcelonaTrip, lisbonTrip, turksCaicosTrip } from './trips.mjs';
import { barcelonaChat, lisbonChat, turksCaicosChat } from './chats.mjs';
import { buildEmails } from './emails.mjs';
import { buildTransactions } from './transactions.mjs';
import { barcelonaFlightGroundTruth, barcelonaTicketLabels, fxRates, lisbonTickets, turksCaicosTickets } from './inventory.mjs';
import { buildReceipts } from './receipts.mjs';
import { barcelonaAlbum, lisbonAlbum, turksCaicosAlbum } from './album.mjs';
import { buildFamilyLedger, buildLedger, buildRecapGroundTruth, buildWrappedAwards } from './ledger.mjs';
import { buildInjection } from './injection.mjs';
import { buildExpensePhrasings, buildMentions, buildRoastBlocklist, buildRoastRequests } from './misc.mjs';

const CHECK = process.argv.includes('--check');
const MANIFEST = join(FIXTURES_DIR, '_gen', 'manifest.json');
const json = (d) => `${JSON.stringify(d, null, 2)}\n`;
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const readJson = (rel) => JSON.parse(readFileSync(join(FIXTURES_DIR, rel), 'utf8'));

/** Planned outputs, in write order: { rel, bytes: Buffer, note? }. */
const plan = [];
const add = (rel, content, note) => plan.push({ rel, bytes: Buffer.isBuffer(content) ? content : Buffer.from(content), ...(note ? { note } : {}) });

// ---------------------------------------------------------------- inputs owned by other builders
const realTickets = readJson('tickets/barcelona.json');
const realFlightsText = readFileSync(join(FIXTURES_DIR, 'flights/barcelona.json'));
const realFlights = JSON.parse(realFlightsText.toString('utf8'));

// ---------------------------------------------------------------- trips / groups
const trips = { barcelona: barcelonaTrip(), lisbon: lisbonTrip(), 'turks-and-caicos': turksCaicosTrip() };
for (const [name, t] of Object.entries(trips)) add(`groups/${name}.json`, json(t));

// ---------------------------------------------------------------- inventory (new files + labels over preserved files)
const flightGt = barcelonaFlightGroundTruth(realFlights, sha256(realFlightsText));
add('flights/barcelona-groundtruth.json', json(flightGt));
add('tickets/barcelona-labels.json', json(barcelonaTicketLabels(realTickets)));
add('tickets/lisbon.json', json(lisbonTickets()));
add('tickets/turks-and-caicos.json', json(turksCaicosTickets()));

// ---------------------------------------------------------------- emails, transactions (byte-identical to the preserved files)
for (const e of buildEmails()) add(`emails/${e.email.emailId}.json`, json(e));
const { lookup: fxLookup } = fxRates();
for (const t of buildTransactions((b, q, on) => fxLookup(b, q, on))) add(t.file, json(t.data));

// ---------------------------------------------------------------- chats
const fxTable = readJson('fx/rates.json');
/** USD per 1 EUR on `date`, falling back to the previous business day (fixtures/fx/rates.json). */
const usdPerEur = (date) => {
  const days = Object.keys(fxTable.rates).filter((d) => d <= date).sort();
  const asOf = days[days.length - 1];
  assert(asOf && fxTable.rates[asOf].USD, `no USD rate on or before ${date}`);
  return { rate: fxTable.rates[asOf].USD, asOf };
};
const chats = {
  barcelona: barcelonaChat({ flightsTotalMinor: flightGt.groundTruth.groupTotalLowerBound.amountMinor, usdPerEur }),
  lisbon: lisbonChat(),
  'turks-and-caicos': turksCaicosChat(),
};

// ---------------------------------------------------------------- album (the files on disk win if someone else owns them)
const albumOut = {
  barcelona: { g: BCN, a: barcelonaAlbum() },
  lisbon: { g: LIS, a: lisbonAlbum() },
  'turks-and-caicos': { g: TCI, a: turksCaicosAlbum() },
};
const albums = {};
for (const [name, { g, a }] of Object.entries(albumOut)) {
  const { photos, labels, timeline, ...extra } = a;
  add(`album/${name}.json`, json({ fixtureVersion: 1, groupId: g.groupId, tripId: g.tripId, photos, labels, consentTimeline: timeline, ...extra }));
  albums[name] = { photos, labels, timeline };
}

// ---------------------------------------------------------------- ledgers, recaps, wrapped
const rowTs = (chat, text) => {
  const r = chat.rows.find((x) => x.text === text);
  assert(r, `no chat row "${text}"`);
  return r.ts;
};
const bcnLedger = buildLedger(chats.barcelona, BCN, 'bcn', 'EUR', {
  after_dinner_d1: rowTs(chats.barcelona, "@trav who's paid for what so far"),
  morning_day4: rowTs(chats.barcelona, '@trav how much have we spent so far'),
  before_settle: rowTs(chats.barcelona, '@trav settle now'),
}, BCN.all);
const lisLedger = buildLedger(chats.lisbon, LIS, 'lis', 'EUR', { before_settle: rowTs(chats.lisbon, '@trav who owes who') }, LIS.all);
const tciLedger = buildFamilyLedger(chats['turks-and-caicos'], trips['turks-and-caicos'], 'tci');
add('ledger/barcelona.json', json(bcnLedger));
add('ledger/lisbon.json', json(lisLedger));
add('ledger/turks-and-caicos.json', json(tciLedger));

const mornings = [
  ['2026-03-12', '2026-03-11T10:00:00+01:00'],
  ['2026-03-13', '2026-03-12T10:00:00+01:00'],
  ['2026-03-14', '2026-03-13T10:00:00+01:00'],
  ['2026-03-15', '2026-03-14T10:00:00+01:00'],
  ['2026-03-16', '2026-03-15T10:00:00+01:00'],
  ['2026-03-17', '2026-03-16T10:00:00+01:00'],
];
const nightlife = Object.fromEntries(trips.barcelona.activities.filter((a) => a.kind === 'nightlife').map((a) => [a.activityId, a.startsAt]));
const recaps = buildRecapGroundTruth(chats.barcelona, albums.barcelona, bcnLedger, BCN, mornings, nightlife);
add('recaps/barcelona.json', json({
  fixtureVersion: 1,
  groupId: BCN.groupId,
  tripId: BCN.tripId,
  rule: 'T-015: full recap if ≥2 of {nightlife booking or activity that night, group expense logged after 22:00, opted-in album photo after 23:00, member chat after 00:00}; else a quiet settle-up if balances changed since the last recap; else silence. Window: previous day 12:00 → recap day 06:00, local.',
  mornings: recaps,
}));
const wrapped = buildWrappedAwards(chats.barcelona, { ...trips.barcelona, handle: BCN.handle }, bcnLedger, albums.barcelona, trips.barcelona.labels.expectedFinalRosters, recaps);
add('wrapped/barcelona.json', json(wrapped));

// Fold computed ground truth back into the chat lines so transcripts and ledgers never disagree.
for (const row of chats.barcelona.rows) {
  if (row.kind === 'clock' && row.expect?.scheduledJob === 'morning_after') {
    const r = recaps[row.ts.slice(0, 10)];
    if (r) {
      row.expect.recapMode = r.expectedMode;
      row.expect.groupMessages = r.expectedMode === 'silent' ? 0 : 1;
    }
  }
  if (row.expect?.action === 'settle_up') row.expect.expectedTransfers = bcnLedger.final.transfers;
}
for (const row of chats.lisbon.rows) {
  if (row.expect?.action === 'settle_up') {
    row.expect.expectedTransfers = lisLedger.final.transfers;
    row.expect.mustContain = lisLedger.final.transfers.map((t) => `${LIS.name[t.from]} → ${LIS.name[t.to]} ${fmtMoney(t.amount)}`);
  }
}
for (const [name, c] of Object.entries(chats)) add(`chats/${name}.jsonl`, jsonl(c.rows));

// ---------------------------------------------------------------- receipts (JSON + PNG)
for (const { fixture, png } of buildReceipts()) {
  add(`receipts/${fixture.receiptId}.json`, json(fixture));
  if (png) add(`receipts/${fixture.receiptId}.png`, png);
}

// ---------------------------------------------------------------- mentions, phrasings, roast, injection
const mentions = buildMentions();
add('mentions/labeled.json', json({ fixtureVersion: 1, note: 'Mention detection labels (VOICE §2, T-007-b). expected.addressed is the ground truth; via = which layer should decide (rules or the mention_v1 classifier).', lines: mentions }));
add('expenses/phrasings.json', json({ fixtureVersion: 1, note: 'Chat-text expense phrasings (T-010). expected.shares follow README "Rounding"; clarify rows must produce exactly one question and no ledger write.', phrasings: buildExpensePhrasings() }));
add('roast/blocklist.json', json(buildRoastBlocklist()));
add('roast/requests.json', json({ fixtureVersion: 1, ...buildRoastRequests() }));
const inj = buildInjection();
for (const c of inj.cases) add(`injection/${c.id}.json`, json({ fixtureVersion: 1, ...c }));
add('injection/index.json', json({
  fixtureVersion: 1,
  note: 'Index of prompt-injection (category "injection", injected: true) and adversarial-request (category "adversarial") cases. detector-patterns.json is owned by the T-007-a builder and not generated here.',
  cases: inj.cases.map((c) => ({ id: c.id, category: c.category, vector: c.vector, title: c.title })),
  patternCoverage: inj.coverage,
  negatives: inj.negatives,
}));

// ---------------------------------------------------------------- write with the ownership rule
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { owned: {} };
const seen = new Set();
const report = { written: [], unchanged: [], preserved: [] };
const owned = {};
for (const item of plan) {
  assert(!seen.has(item.rel), `planned twice: ${item.rel}`);
  seen.add(item.rel);
  const path = join(FIXTURES_DIR, item.rel);
  const want = sha256(item.bytes);
  if (existsSync(path)) {
    const have = sha256(readFileSync(path));
    if (have === want) {
      report.unchanged.push(item.rel);
      owned[item.rel] = want;
      continue;
    }
    if (manifest.owned?.[item.rel] !== have) {
      report.preserved.push(item.rel);
      continue;
    }
  }
  report.written.push(item.rel);
  owned[item.rel] = want;
  if (!CHECK) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, item.bytes);
  }
}
const sortedOwned = Object.fromEntries(Object.entries(owned).sort(([a], [b]) => a.localeCompare(b)));
const manifestOut = json({
  note: 'sha256 of every file fixtures/_gen/index.mjs owns. A file whose bytes no longer match is treated as hand-edited and preserved on the next run.',
  owned: sortedOwned,
  preserved: [...report.preserved].sort(),
});
if (!CHECK) writeFileSync(MANIFEST, manifestOut);

const show = (label, list) => {
  console.log(`${label} (${list.length})`);
  for (const r of list) console.log(`  ${r}`);
};
show(CHECK ? 'would write' : 'written', report.written);
console.log(`unchanged (${report.unchanged.length})`);
show('preserved: exists, differs from generator output, not generator-owned', report.preserved);
if (CHECK && report.written.length > 0) process.exit(1);
