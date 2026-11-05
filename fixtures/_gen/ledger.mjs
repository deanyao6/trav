// Ledger and recap ground truth, derived from the chat transcripts' `expect.expense` entries
// (so the chat, the ledger and the recaps can never disagree).
import { assert, eur, money } from './lib.mjs';

function handleToMember(trip) {
  return Object.fromEntries(Object.entries(trip.handle).map(([m, h]) => [h, m]));
}

export function ledgerFromChat(chat, trip, prefix, currency) {
  const byHandle = handleToMember(trip);
  const expenses = [];
  for (const [i, row] of chat.rows.entries()) {
    const e = row.expect?.expense;
    if (!e || !e.shares) continue;
    assert(e.amount.currency === currency, `${prefix}: ledger fixture is single-currency (${row.id})`);
    const n = expenses.length + 1;
    const src = e.source ?? 'chat';
    // A receipt photo is logged by its payer's 👍 on the read-it card (SAFETY D5, D-039), but the
    // expense points at the photo message, as the agent writes it (`sourceRef: message:<photo id>`).
    const photoRow =
      src === 'receipt_photo' && row.kind !== 'message'
        ? chat.rows.slice(0, i).findLast((r) => r.expect?.flow === 'receipt_photo' && r.senderId === row.senderId)
        : undefined;
    assert(src !== 'receipt_photo' || row.kind === 'message' || photoRow, `${row.id}: receipt 👍 without a photo line`);
    const sourceRef =
      src === 'booking'
        ? { kind: 'booking', id: `bk_${prefix}_${String(n).padStart(3, '0')}` }
        : src === 'card_transaction' || src === 'email_receipt'
          ? { kind: 'private_item', id: `priv_${prefix}_${String(n).padStart(3, '0')}` }
          : { kind: 'message', id: (photoRow ?? row).id };
    expenses.push({
      expenseId: `exp_${prefix}_${String(n).padStart(3, '0')}`,
      groupId: trip.groupId,
      tripId: trip.tripId,
      description: e.description,
      category: e.category,
      amount: e.amount,
      ...(e.original ? { original: { amount: e.original.amount, rate: e.original.rate, rateDate: e.original.rateDate } } : {}),
      paidBy: [{ memberId: e.paidBy, amount: e.amount }],
      split: e.split,
      source: src,
      sourceRef,
      ...(e.activityId ? { activityId: e.activityId } : {}),
      occurredAt: e.occurredAt ?? row.ts,
      createdAt: row.ts,
      createdBy: byHandle[row.senderId] ?? e.paidBy,
      status: 'logged',
      expectedShares: e.shares,
      fromChatLine: row.id,
    });
  }
  return expenses;
}

function balancesOf(expenses, members, currency) {
  const net = Object.fromEntries(members.map((m) => [m, 0]));
  const paid = Object.fromEntries(members.map((m) => [m, 0]));
  const owed = Object.fromEntries(members.map((m) => [m, 0]));
  for (const e of expenses) {
    for (const p of e.paidBy) {
      net[p.memberId] += p.amount.amountMinor;
      paid[p.memberId] += p.amount.amountMinor;
    }
    for (const s of e.expectedShares) {
      net[s.memberId] -= s.amount.amountMinor;
      owed[s.memberId] += s.amount.amountMinor;
    }
  }
  assert(Object.values(net).reduce((a, b) => a + b, 0) === 0, 'balances must sum to zero');
  return members.map((m) => ({ memberId: m, net: money(net[m], currency), paid: money(paid[m], currency), share: money(owed[m], currency) }));
}

/** Reference settlement: repeatedly match the largest debtor with the largest creditor. Any set with ≤ n−1 transfers that clears all balances is correct. */
function settle(balances, currency) {
  const debt = balances.map((b) => ({ id: b.memberId, v: b.net.amountMinor }));
  const out = [];
  for (let guard = 0; guard < 50; guard += 1) {
    debt.sort((a, b) => a.v - b.v);
    const lo = debt[0];
    const hi = debt[debt.length - 1];
    if (lo.v === 0 && hi.v === 0) break;
    const amt = Math.min(-lo.v, hi.v);
    if (amt <= 0) break;
    out.push({ from: lo.id, to: hi.id, amount: money(amt, currency) });
    lo.v += amt;
    hi.v -= amt;
  }
  assert(debt.every((d) => d.v === 0), 'settlement must clear');
  assert(out.length <= balances.length - 1, 'settlement ≤ n-1 transfers');
  return out;
}

function total(expenses, currency) {
  return money(expenses.reduce((s, e) => s + e.amount.amountMinor, 0), currency);
}

export function buildLedger(chat, trip, prefix, currency, checkpoints, members) {
  const expenses = ledgerFromChat(chat, trip, prefix, currency);
  const cp = {};
  for (const [name, beforeTs] of Object.entries(checkpoints)) {
    const sub = expenses.filter((e) => Date.parse(e.createdAt) < Date.parse(beforeTs));
    cp[name] = { before: beforeTs, expenseIds: sub.map((e) => e.expenseId), totalSpent: total(sub, currency), balances: balancesOf(sub, members, currency).map(({ memberId, net }) => ({ memberId, net })) };
  }
  const balances = balancesOf(expenses, members, currency);
  const transfers = settle(balances, currency);
  const byCategory = {};
  for (const e of expenses) byCategory[e.category] = (byCategory[e.category] ?? 0) + e.amount.amountMinor;
  const biggest = [...expenses].sort((a, b) => b.amount.amountMinor - a.amount.amountMinor)[0];
  const mostFronted = [...balances].sort((a, b) => b.paid.amountMinor - a.paid.amountMinor)[0];
  const latest = [...expenses].sort((a, b) => {
    const t = (e) => {
      const h = Number(e.occurredAt.slice(11, 13));
      return h < 6 ? h + 24 : h;
    };
    return t(b) - t(a);
  })[0];
  const totalSpent = total(expenses, currency);
  return {
    fixtureVersion: 1,
    groupId: trip.groupId,
    tripId: trip.tripId,
    currency,
    note: 'Expected ledger after replaying the chat with every expect honored. Shares follow README "Rounding". `final.transfers` is one valid minimal settlement (greedy reference); graders should accept any transfer set with ≤ n−1 transfers that clears every balance to the cent.',
    expenses,
    checkpoints: cp,
    final: {
      totalSpent,
      balances,
      transfers,
      maxTransfers: members.length - 1,
    },
    wrappedFacts: {
      totalSpent,
      people: members.length,
      perPersonAverage: money(Math.round(totalSpent.amountMinor / members.length), currency),
      byCategory: Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([category, amt]) => ({ category, amount: money(amt, currency) })),
      expenseCount: expenses.length,
      bookingCount: expenses.filter((e) => e.source === 'booking').length,
      biggestExpense: { expenseId: biggest.expenseId, description: biggest.description, amount: biggest.amount },
      mostFronted: { memberId: mostFronted.memberId, paid: mostFronted.paid, basis: 'ledger' },
      latestNightExpense: { expenseId: latest.expenseId, description: latest.description, occurredAt: latest.occurredAt },
    },
  };
}

// ------------------------------------------------------------------ family tab (Turks and Caicos)

/** Family tab: one pot, no split, no transfers; a minor's spend folds into the guardian (T-058). */
export function buildFamilyLedger(chat, trip, prefix) {
  const guardianOf = Object.fromEntries(trip.members.filter((m) => m.guardianMemberId).map((m) => [m.memberId, m.guardianMemberId]));
  const expenses = [];
  for (const row of chat.rows) {
    const e = row.expect?.expense;
    if (!e || !e.familyTab) continue;
    const n = expenses.length + 1;
    const fronted = guardianOf[e.paidBy] ?? e.paidBy;
    expenses.push({
      expenseId: `exp_${prefix}_${String(n).padStart(3, '0')}`,
      description: e.description ?? null,
      category: e.category ?? null,
      amount: e.amount,
      paidBy: e.paidBy,
      creditedTo: fronted,
      ...(fronted !== e.paidBy ? { minorFoldedInto: fronted } : {}),
      source: e.source ?? 'chat',
      occurredAt: e.occurredAt ?? row.ts,
      fromChatLine: row.id,
    });
  }
  const currency = trip.group.currency;
  const fronted = {};
  for (const e of expenses) fronted[e.creditedTo] = (fronted[e.creditedTo] ?? 0) + e.amount.amountMinor;
  const minors = trip.members.filter((m) => m.ageBand === 'under18').map((m) => m.memberId);
  for (const m of minors) assert(!(m in fronted), 'a minor never appears as a creditor');
  return {
    fixtureVersion: 1,
    groupId: trip.group.groupId,
    tripId: trip.trip.tripId,
    currency,
    familyTab: true,
    note: 'Family tab (trip.familyTab = true): expenses go into one pot with no split and no settle-up transfers. Lily (14) is never a debtor or creditor; anything she pays is credited to her guardian (Dad).',
    expenses,
    final: {
      totalSpent: money(expenses.reduce((s, e) => s + e.amount.amountMinor, 0), currency),
      frontedBy: Object.entries(fronted).map(([memberId, v]) => ({ memberId, amount: money(v, currency) })),
      transfers: [],
      neverInBalances: minors,
    },
  };
}

// ------------------------------------------------------------------ Wrapped awards (Barcelona)

const RIDE_RE = /\b(uber|lyft|taxi|cab)\b/i;
const localHour = (iso) => Number(iso.slice(11, 13)) + Number(iso.slice(14, 16)) / 60;

/** Nightly window key: an instant before 06:00 belongs to the previous date's night. */
function nightOf(iso) {
  const d = iso.slice(0, 10);
  if (localHour(iso) >= 6) return d;
  return new Date(Date.parse(`${d}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function award(name, stats, { higherIsBetter = true, basis, members, eligible = () => true }) {
  const rows = members.map((m) => ({ memberId: m, value: stats[m] ?? 0 })).filter((r) => eligible(r.memberId));
  const vals = rows.map((r) => r.value).filter((v) => v !== null);
  const top = higherIsBetter ? Math.max(...vals) : Math.min(...vals);
  const topHolders = rows.filter((r) => r.value === top && (higherIsBetter ? top > 0 : true)).map((r) => r.memberId);
  return { award: name, basis, stats: rows, topHolders };
}

/**
 * Award ground truth per IDEAS.md "Trip Wrapped". Every stat comes from the group ledger,
 * rosters, bookings and the album with final consent; nothing private (card/email rows that
 * were never confirmed) and nothing about health, drinking volume, bodies or romance.
 */
export function buildWrappedAwards(chat, trip, ledger, album, rosters, recaps) {
  const members = trip.members.map((m) => m.memberId);
  const byHandle = handleToMember(trip);
  const currency = ledger.currency;
  // only nights that start on a trip day count (pre-trip bookings made at 20:40 are not "a night")
  const onTrip = (night) => night >= trip.trip.startDate && night < trip.trip.endDate;
  const paid = {};
  const share = {};
  for (const b of ledger.final.balances) {
    paid[b.memberId] = b.paid.amountMinor;
    share[b.memberId] = b.share.amountMinor;
  }
  // rides fronted for the group (group-visible expenses only)
  const rides = {};
  const rideTotal = {};
  for (const e of ledger.expenses) {
    if (e.category !== 'transport' || !RIDE_RE.test(e.description)) continue;
    const p = e.paidBy[0].memberId;
    rides[p] = (rides[p] ?? 0) + 1;
    rideTotal[p] = (rideTotal[p] ?? 0) + e.amount.amountMinor;
  }
  // night owl: per night, who logged/fronted the latest expense (18:00–06:00)
  const lateByNight = {};
  for (const e of ledger.expenses) {
    const h = localHour(e.occurredAt);
    if (!(h >= 18 || h < 6)) continue;
    const key = nightOf(e.occurredAt);
    if (!onTrip(key)) continue;
    const t = h < 6 ? h + 24 : h;
    if (!lateByNight[key] || t > lateByNight[key].t) lateByNight[key] = { t, memberId: e.paidBy[0].memberId, expenseId: e.expenseId, at: e.occurredAt };
  }
  const owl = {};
  // tie-break: how far past that night's 18:00 the latest expense landed (later wins; T-016 review #4)
  const owlLate = {};
  for (const [night, v] of Object.entries(lateByNight)) {
    owl[v.memberId] = (owl[v.memberId] ?? 0) + 1;
    const late = Math.max(0, Date.parse(v.at) - Date.parse(`${night}T18:00:00Z`));
    owlLate[v.memberId] = (owlLate[v.memberId] ?? 0) + Math.round(late / 60000);
  }
  // early bird: per trip day, who fronted the first expense between 06:00 and 14:00
  const firstByDay = {};
  for (const e of ledger.expenses) {
    const h = localHour(e.occurredAt);
    const day = e.occurredAt.slice(0, 10);
    if (h < 6 || h >= 14 || day < trip.trip.startDate || day > trip.trip.endDate) continue;
    if (!firstByDay[day] || Date.parse(e.occurredAt) < Date.parse(firstByDay[day].at)) firstByDay[day] = { at: e.occurredAt, memberId: e.paidBy[0].memberId, expenseId: e.expenseId };
  }
  const bird = {};
  for (const v of Object.values(firstByDay)) bird[v.memberId] = (bird[v.memberId] ?? 0) + 1;
  // photographer: photos visible with final consent (what Wrapped can show)
  const photos = {};
  for (const p of album.photos) if (album.labels[p.photoId]?.visibleWithFinalConsent && !p.hidden && p.qualityTag !== 'screenshot' && p.qualityTag !== 'receipt') photos[p.ownerMemberId] = (photos[p.ownerMemberId] ?? 0) + 1;
  // always in: final rosters across every activity with a roster
  const inCount = {};
  for (const r of Object.values(rosters)) for (const m of r.in) inCount[m] = (inCount[m] ?? 0) + 1;
  // the planner: @trav requests that became a completed booking
  const proposalBy = {};
  for (const row of chat.rows) if (row.expect?.cardRef && row.expect?.proposal) proposalBy[row.expect.cardRef] = byHandle[row.senderId];
  const planner = {};
  for (const row of chat.rows) {
    if (row.expect?.action !== 'booking_completed') continue;
    const who = proposalBy[row.target?.cardRef];
    if (who) planner[who] = (planner[who] ?? 0) + 1;
  }
  const consenting = new Set(album.timeline.filter((t) => t.photos).map((t) => t.memberId));
  for (const t of album.timeline) if (!t.photos) consenting.delete(t.memberId);
  const awards = [
    award('MVP Spender', paid, { members, basis: 'total fronted for the group on the ledger (paidBy), minor units; an honor, never a roast' }),
    award('The Planner', planner, { members, basis: 'completed bookings whose proposal this member requested in the group chat' }),
    award('Uber Captain', rides, { members, basis: 'ride expenses (uber/lyft/taxi/cab) this member fronted on the group ledger; tie-break: larger ride total, then member order' }),
    award('Night Owl', owl, { members, basis: 'nights (18:00–06:00) on which this member fronted the latest expense; tie-break: later latest expense, then member order' }),
    award('Early Bird', bird, { members, basis: 'trip days on which this member fronted the first expense between 06:00 and 14:00' }),
    award('The Photographer', photos, { members, basis: 'album photos/videos still visible with final consent (screenshots and receipts excluded)', eligible: (m) => consenting.has(m) }),
    award('Always In', inCount, { members, basis: 'activities on which this member is "in" on the final roster (groups/barcelona.json labels.expectedFinalRosters)' }),
  ];
  // Reference one-award-per-person assignment, greedy in the order listed: the best-ranked member
  // (stat desc, then tie-break) who has no award yet and a stat > 0; if nobody qualifies, the top
  // holder repeats. acceptableWinners = everyone tied at the top plus the reference winner.
  const order = (m) => members.indexOf(m);
  const given = new Set();
  for (const a of awards) {
    const val = Object.fromEntries(a.stats.map((s) => [s.memberId, s.value]));
    const tie = a.award === 'Uber Captain' ? rideTotal : a.award === 'Night Owl' ? owlLate : {};
    const rank = (x, y) => val[y] - val[x] || (tie[y] ?? 0) - (tie[x] ?? 0) || order(x) - order(y);
    const ranked = a.stats.map((s) => s.memberId).filter((m) => val[m] > 0).sort(rank);
    const fresh = ranked.find((m) => !given.has(m));
    a.referenceWinner = fresh ?? ranked[0] ?? null;
    a.runnerUpBecauseTopAlreadyAwarded = fresh !== undefined && !a.topHolders.includes(fresh);
    a.repeatWinner = fresh === undefined && ranked.length > 0;
    a.acceptableWinners = [...new Set([...[...a.topHolders].sort(rank), ...(a.referenceWinner ? [a.referenceWinner] : [])])];
    if (a.referenceWinner) given.add(a.referenceWinner);
  }
  // group awards (no name on them)
  const nights = {};
  for (const e of ledger.expenses) {
    const h = localHour(e.occurredAt);
    if (!(h >= 18 || h < 6)) continue;
    const k = nightOf(e.occurredAt);
    if (!onTrip(k)) continue;
    nights[k] = (nights[k] ?? 0) + e.amount.amountMinor;
  }
  const bigNight = Object.entries(nights).sort((x, y) => y[1] - x[1])[0];
  const chatPerNight = {};
  for (const row of chat.rows) {
    if (row.kind !== 'message' || row.lane !== 'group' || !byHandle[row.senderId]) continue;
    const h = localHour(row.ts);
    if (!(h >= 18 || h < 6) || !row.ts.endsWith('+01:00') || row.ts.slice(0, 10) < trip.trip.startDate) continue;
    const k = nightOf(row.ts);
    chatPerNight[k] = (chatPerNight[k] ?? 0) + 1;
  }
  const valueRows = Object.entries(nights).map(([night, amt]) => ({ night, spent: money(amt, currency), groupMessages: chatPerNight[night] ?? 0, messagesPerTenEuro: Number((((chatPerNight[night] ?? 0) * 1000) / amt).toFixed(3)) }));
  const bestValue = [...valueRows].sort((x, y) => y.messagesPerTenEuro - x.messagesPerTenEuro)[0];
  return {
    fixtureVersion: 1,
    groupId: trip.group.groupId,
    tripId: trip.trip.tripId,
    renderAt: '2026-03-18T10:00:00+01:00',
    wrappedFacts: ledger.wrappedFacts,
    awards,
    groupAwards: {
      bigNight: { night: bigNight[0], spent: money(bigNight[1], currency), basis: 'night (18:00–06:00) with the highest group-ledger total' },
      bestValueNight: { ...bestValue, basis: 'IDEAS says reactions per euro; v0 has no reaction counts, so this uses group chat messages per €10 spent that night', allNights: valueRows },
    },
    nightOwlDetail: lateByNight,
    earlyBirdDetail: firstByDay,
    photos: {
      onlyFromOwners: [...consenting].sort((a, b) => order(a) - order(b)),
      highlightCandidates: album.photos.filter((p) => album.labels[p.photoId]?.highlightCandidate && !p.hidden).map((p) => p.photoId),
      neverShow: album.photos.filter((p) => !album.labels[p.photoId]?.visibleWithFinalConsent || p.hidden).map((p) => p.photoId),
    },
    recapModes: Object.fromEntries(Object.entries(recaps).map(([d, r]) => [d, r.expectedMode])),
    rules: [
      'one award per person where possible (referenceWinner applies that greedily in the order listed; acceptableWinners = everyone tied at the top)',
      'no award or stat references drinking volume, health, bodies, romance or anyone outside the chat',
      'stats come only from group-visible data: never from unconfirmed card or email items',
      'photos only from members whose photos consent is on at render time (Dean, Chase, Crowley); Arjun revoked on 2026-03-16',
    ],
    mustNotContain: ['sick', 'hungover', 'broke', 'girl', 'pharmacy', '9.80', 'vegetarian', '80 a day'],
  };
}

// ------------------------------------------------------------------ Morning After signals

export function buildRecapGroundTruth(chat, album, ledger, trip, mornings, nightlifeActivities) {
  const byHandle = handleToMember(trip);
  const out = {};
  const bookingsDone = chat.rows.filter((r) => r.expect?.action === 'booking_completed' && r.expect?.expense?.activityId);
  for (const [date, prevRecapAt] of mornings) {
    const recapAt = `${date}T10:00:00+01:00`;
    const prevDate = new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const from = `${prevDate}T12:00:00+01:00`;
    const to = `${date}T06:00:00+01:00`;
    const after22 = `${prevDate}T22:00:00+01:00`;
    const after23 = `${prevDate}T23:00:00+01:00`;
    const midnight = `${date}T00:00:00+01:00`;
    const inRange = (ts, a, b) => Date.parse(ts) >= Date.parse(a) && Date.parse(ts) < Date.parse(b);
    const nightlifeBooking = bookingsDone.some((r) => nightlifeActivities[r.expect.expense.activityId] && inRange(nightlifeActivities[r.expect.expense.activityId], from, to));
    const windowExpenses = ledger.expenses.filter((e) => inRange(e.createdAt, from, to) || (e.source === 'booking' && e.activityId && nightlifeActivities[e.activityId] && inRange(nightlifeActivities[e.activityId], from, to)));
    const expenseAfter22 = ledger.expenses.some((e) => inRange(e.createdAt, after22, to));
    const consenting = (owner, ts) => {
      let v = false;
      for (const c of album.timeline) if (c.memberId === owner && Date.parse(c.at) <= Date.parse(ts)) v = c.photos;
      return v;
    };
    const photosAfter23 = album.photos.filter((p) => p.takenAt && inRange(p.takenAt, after23, to) && consenting(p.ownerMemberId, recapAt));
    const photoAfter23 = photosAfter23.length > 0;
    const chatAfterMidnight = chat.rows.some((r) => r.kind === 'message' && r.lane === 'group' && byHandle[r.senderId] && inRange(r.ts, midnight, to));
    const balancesChanged = ledger.expenses.some((e) => inRange(e.createdAt, prevRecapAt, recapAt));
    const signalCount = [nightlifeBooking, expenseAfter22, photoAfter23, chatAfterMidnight].filter(Boolean).length;
    const mode = signalCount >= 2 ? 'full' : balancesChanged ? 'quiet' : 'silent';
    const eligiblePhotos = album.photos
      .filter((p) => p.takenAt && inRange(p.takenAt, from, to) && !p.hidden && consenting(p.ownerMemberId, recapAt))
      .map((p) => p.photoId);
    out[date] = {
      recapAt,
      window: { from, to },
      signals: { nightlifeBooking, expenseAfter22, photoAfter23, chatAfterMidnight, balancesChanged },
      expectedMode: mode,
      lastNightExpenses: windowExpenses.map((e) => ({ expenseId: e.expenseId, description: e.description, amount: e.amount })),
      lastNightTotal: eur(windowExpenses.reduce((s, e) => s + e.amount.amountMinor, 0)),
      eligiblePhotoIds: eligiblePhotos,
      maxPhotos: 3,
    };
  }
  return out;
}
