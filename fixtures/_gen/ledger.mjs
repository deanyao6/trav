// Ledger and recap ground truth, derived from the chat transcripts' `expect.expense` entries
// (so the chat, the ledger and the recaps can never disagree).
import { assert, eur, money } from './lib.mjs';

function handleToMember(trip) {
  return Object.fromEntries(Object.entries(trip.handle).map(([m, h]) => [h, m]));
}

export function ledgerFromChat(chat, trip, prefix, currency) {
  const byHandle = handleToMember(trip);
  const expenses = [];
  for (const row of chat.rows) {
    const e = row.expect?.expense;
    if (!e || !e.shares) continue;
    assert(e.amount.currency === currency, `${prefix}: ledger fixture is single-currency (${row.id})`);
    const n = expenses.length + 1;
    const src = e.source ?? 'chat';
    const sourceRef =
      src === 'booking'
        ? { kind: 'booking', id: `bk_${prefix}_${String(n).padStart(3, '0')}` }
        : src === 'card_transaction' || src === 'email_receipt'
          ? { kind: 'private_item', id: `priv_${prefix}_${String(n).padStart(3, '0')}` }
          : { kind: 'message', id: row.id };
    expenses.push({
      expenseId: `exp_${prefix}_${String(n).padStart(3, '0')}`,
      groupId: trip.groupId,
      tripId: trip.tripId,
      description: e.description,
      category: e.category,
      amount: e.amount,
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
