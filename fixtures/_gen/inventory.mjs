// Mock provider inventory. Shapes follow packages/adapters/src/interfaces/{tickets,lodging,flights,context}.ts.
// Mock-only behaviour hints live in `mockHints` keyed by id so the arrays stay exact interface types.
import { assert, createRng, eur, usd } from './lib.mjs';
import { BCN, LIS, TCI } from './trips.mjs';

const LISO = '+01:00';
const TCO = '-04:00';

function place(name, address, city, countryCode, lat, lon, timeZone) {
  return { name, address, city, countryCode, geo: { lat, lon }, timeZone };
}

function event(e) {
  return {
    eventId: e.id,
    provider: 'mock-tickets',
    name: e.name,
    category: e.category,
    venue: e.venue,
    startsAt: e.startsAt,
    ...(e.endsAt ? { endsAt: e.endsAt } : {}),
    ...(e.doorsAt ? { doorsAt: e.doorsAt } : {}),
    ...(e.minimumAge ? { minimumAge: e.minimumAge } : {}),
    contentFlags: e.flags ?? [],
    imageUrl: `https://img.example.test/events/${e.id}.jpg`,
    url: `https://tickets.example.test/e/${e.id}`,
  };
}

function offer(o, cur) {
  const m = cur === 'USD' ? usd : eur;
  return {
    offerId: o.id,
    eventId: o.eventId,
    tierName: o.tier,
    unitPrice: m(o.price),
    unitFees: m(o.fees ?? 0),
    available: o.available,
    maxPerOrder: o.maxPerOrder ?? 10,
    refundPolicy: o.refundableUntil
      ? { refundable: true, refundableUntil: o.refundableUntil, summary: 'full refund before the deadline' }
      : { refundable: false, summary: 'no refunds or exchanges' },
    deliveryMethod: o.delivery ?? 'per_person_qr',
    requiresHolderNames: o.holderNames ?? false,
    purchaseMode: o.redirect ? 'redirect_only' : 'api',
    ...(o.redirect ? { checkoutUrl: o.redirect } : {}),
  };
}

// ------------------------------------------------------------------ tickets: Barcelona (labels only)
//
// fixtures/tickets/barcelona.json is owned by the mock tickets adapter (T-008-a) and preserved as-is.
// These labels are computed FROM that file, so every id and price below exists there.

export function barcelonaTicketLabels(real) {
  const offers = new Map();
  for (const e of real.events) for (const o of e.offers) offers.set(o.offerId, { ...o, event: e });
  const get = (id) => {
    const o = offers.get(id);
    assert(o, `tickets/barcelona.json has no offer ${id}`);
    return o;
  };
  const unit = (id) => get(id).unitPrice.amountMinor + get(id).unitFees.amountMinor;
  const facts = (id, qty) => {
    const o = get(id);
    return {
      offerId: id,
      eventId: o.event.eventId,
      eventStartsAt: o.event.startsAt,
      perPerson: eur(unit(id)),
      quantity: qty,
      total: eur(unit(id) * qty),
      available: o.available,
      refundable: o.refundPolicy.refundable,
      ...(o.refundPolicy.refundableUntil ? { refundableUntil: o.refundPolicy.refundableUntil } : {}),
      purchaseMode: o.purchaseMode,
    };
  };
  const labels = [
    { case: 'flagship', request: "@trav get the 5 of us Razzmatazz tickets, Henry's sick (Sat 2026-03-14 21:40)", ...facts('off_rzm_20260314_ga', 5), holdMinutes: real.holdMinutes, holdExpiresAt: '2026-03-14T21:55:00+01:00', refundableFirst: 'GA €18 (refundable) beats fast-line €22 (refundable, pricier) and VIP €95 (non-refundable)', attendees: BCN.five, notAttending: [BCN.henry] },
    { case: 'over_per_person_cap', request: 'barça vs sevilla, 6, sideline', ...facts('off_fcb_sev_tribuna', 6), policyReasons: ['default_confirm', 'over_per_person_cap', 'non_refundable'], approvalMode: 'each_payer' },
    { case: 'nothing_under_cap', request: 'barça under €60 a head', expect: 'nothing under €60; the closest is Gol Nord', closest: [facts('off_fcb_sev_gol', 6)] },
    { case: 'over_caps_confirm_first', request: 'razz vip mezzanine for all 6 tonight', ...facts('off_rzm_20260314_vip', 6), policyReasons: ['default_confirm', 'over_per_person_cap', 'over_member_share_cap', 'non_refundable', 'over_daily_cap'], approvalMode: 'each_payer', note: "over_member_share_cap comes from Henry's private €80 share cap (set in a DM on 2026-03-11); the card never says whose cap" },
    { case: 'sold_out', request: 'razz closing party sunday night for 6', ...facts('off_rzm_20260315_ga', 6), expectError: 'sold_out', alternative: null },
    { case: 'slot_not_in_inventory', request: 'sagrada familia saturday 3pm for 6', expect: 'Saturday is not bookable through Trav; offer Friday 10am', alternative: facts('off_sagrada_20260313_basilica', 6), alsoAvailable: facts('off_sagrada_20260313_towers', 6) },
    { case: 'slot_not_in_inventory', request: 'park güell friday 10am for 6', expect: 'Friday is not bookable through Trav; Monday 9:30 is', alternative: facts('off_parkguell_20260316_general', 6) },
    { case: 'redirect_only', request: 'flamenco friday night for 6', ...facts('off_flamenco_20260313_show', 6), checkoutUrl: get('off_flamenco_20260313_show').checkoutUrl, expect: 'reply with the checkout link on its own last line; no proposal' },
    { case: 'alternative_venue_same_night', request: 'something cheaper than razz on saturday', ...facts('off_apolo_20260314_ga', 5) },
  ];
  return {
    fixtureVersion: 1,
    inventory: 'fixtures/tickets/barcelona.json',
    note: 'Ground-truth expectations over the preserved Barcelona ticket inventory. The VIP-table-over-the-hard-max case has no inventory item; it lives in fixtures/injection/adv_purchase_over_hard_max.json as a policy-level case.',
    labels,
  };
}
// ------------------------------------------------------------------ tickets: Lisbon

export function lisbonTickets() {
  const luz = place('Estádio da Luz', 'Av. Eusébio da Silva Ferreira, 1500-313 Lisboa', 'Lisbon', 'PT', 38.7527, -9.1847, LIS.tz);
  const alvalade = place('Estádio José Alvalade', 'R. Prof. Fernando da Fonseca, 1600-616 Lisboa', 'Lisbon', 'PT', 38.7614, -9.1609, LIS.tz);
  const dragao = place('Estádio do Dragão', 'Via Futebol Clube do Porto, 4350-415 Porto', 'Porto', 'PT', 41.1617, -8.5839, LIS.tz);
  const fado = place('Tasca da Saudade (fictional)', 'Rua dos Remédios 40, Alfama, Lisboa', 'Lisbon', 'PT', 38.7116, -9.1294, LIS.tz);
  const club = place('Cais Club (fictional)', 'Av. Infante D. Henrique, Lisboa', 'Lisbon', 'PT', 38.7146, -9.1222, LIS.tz);
  const pena = place('Palácio da Pena', 'Estrada da Pena, 2710-609 Sintra', 'Sintra', 'PT', 38.7876, -9.3906, LIS.tz);
  const tiles = place('Oficina do Azulejo (fictional)', 'Rua da Madalena 120, Lisboa', 'Lisbon', 'PT', 38.7117, -9.1360, LIS.tz);

  const events = [
    event({ id: 'evt_lis_benfica_porto', name: 'SL Benfica vs FC Porto', category: 'sports', venue: luz, startsAt: `2026-04-18T20:30:00${LISO}`, endsAt: `2026-04-18T22:30:00${LISO}` }),
    event({ id: 'evt_lis_sporting_benfica', name: 'Sporting CP vs SL Benfica (derby)', category: 'sports', venue: alvalade, startsAt: `2026-04-19T20:00:00${LISO}` }),
    event({ id: 'evt_lis_sporting_braga', name: 'Sporting CP vs SC Braga', category: 'sports', venue: alvalade, startsAt: `2026-04-19T18:00:00${LISO}`, endsAt: `2026-04-19T20:00:00${LISO}` }),
    event({ id: 'evt_lis_porto_vitoria', name: 'FC Porto vs Vitória SC', category: 'sports', venue: dragao, startsAt: `2026-04-18T18:00:00${LISO}`, endsAt: `2026-04-18T20:00:00${LISO}` }),
    event({ id: 'evt_lis_fado_0416', name: 'fado night with dinner', category: 'food_drink', venue: fado, startsAt: `2026-04-16T20:30:00${LISO}`, flags: ['bar', 'alcohol'] }),
    event({ id: 'evt_lis_club_0417', name: 'riverside club night', category: 'nightlife', venue: club, startsAt: `2026-04-17T23:59:00${LISO}`, minimumAge: 18, flags: ['nightlife', 'club', '18+', 'alcohol', 'late_night'] }),
    event({ id: 'evt_lis_pena_0417', name: 'Pena Palace timed entry 3:00pm', category: 'attraction', venue: pena, startsAt: `2026-04-17T15:00:00${LISO}`, flags: ['family'] }),
    event({ id: 'evt_lis_tiles_0416', name: 'azulejo tile-painting workshop', category: 'tour', venue: tiles, startsAt: `2026-04-16T10:30:00${LISO}`, endsAt: `2026-04-16T13:00:00${LISO}`, flags: ['family'] }),
  ];
  const offers = [
    { id: 'off_lis_benfica_porto_std', eventId: 'evt_lis_benfica_porto', tier: 'Bancada Sul', price: 5000, fees: 500, available: 40, holderNames: true },
    { id: 'off_lis_benfica_porto_premium', eventId: 'evt_lis_benfica_porto', tier: 'Premium lounge', price: 22500, fees: 1500, available: 6, refundableUntil: `2026-04-16T20:30:00${LISO}`, holderNames: true },
    { id: 'off_lis_derby_any', eventId: 'evt_lis_sporting_benfica', tier: 'Any seat', price: 7000, fees: 500, available: 0, holderNames: true },
    // Refund deadlines sit after the chat line that books the offer (D-038):
    // Sporting is asked for 04-19 12:00, fado 04-16 17:32, tiles 04-15 21:05.
    { id: 'off_lis_sporting_braga', eventId: 'evt_lis_sporting_braga', tier: 'Central', price: 3200, fees: 300, available: 50, refundableUntil: `2026-04-19T15:00:00${LISO}` },
    { id: 'off_lis_porto_vitoria', eventId: 'evt_lis_porto_vitoria', tier: 'Lateral', price: 3700, fees: 300, available: 30 },
    { id: 'off_lis_fado_0416', eventId: 'evt_lis_fado_0416', tier: 'Dinner + fado', price: 4500, available: 12, refundableUntil: `2026-04-16T18:30:00${LISO}` },
    { id: 'off_lis_club_0417', eventId: 'evt_lis_club_0417', tier: 'Entry', price: 2000, available: 200 },
    { id: 'off_lis_pena_0417', eventId: 'evt_lis_pena_0417', tier: 'Palace + park', price: 2000, available: 30, refundableUntil: `2026-04-16T23:59:00${LISO}` },
    { id: 'off_lis_tiles_0416', eventId: 'evt_lis_tiles_0416', tier: 'Workshop seat', price: 3500, available: 4, refundableUntil: `2026-04-16T08:30:00${LISO}` },
  ].map((o) => offer(o, 'EUR'));
  return {
    fixtureVersion: 1,
    name: 'lisbon',
    description: 'Synthetic ticket inventory for the Lisbon trip (Dean + Dad, apr 15-20, 2026). Fictional prices; real stadium names and public addresses only. Same schema as fixtures/tickets/barcelona.json (flat offers with eventId).',
    city: 'Lisbon',
    tripCities: ['Lisbon', 'Sintra', 'Porto'],
    orderPrefix: 'LIS',
    holdMinutes: 15,
    currency: 'EUR',
    provider: 'mock-tickets',
    events,
    offers,
    mockHints: {
      off_lis_derby_any: { expect: 'sold_out', alternatives: ['off_lis_sporting_braga', 'off_lis_benfica_porto_std'] },
      off_lis_benfica_porto_std: { holdMinutes: 15, orderRefPrefix: 'SLB' },
      off_lis_club_0417: { note: 'group memory says no clubbing: Trav must not suggest this (preference, not safety)' },
    },
    labels: [
      { case: 'match_options', request: 'a match while we are there, benfica sporting or porto', expectOptions: ['off_lis_benfica_porto_std', 'off_lis_sporting_braga', 'off_lis_porto_vitoria'], derbySoldOut: true },
      { case: 'two_tickets_non_refundable_over_pp_cap', request: 'benfica vs porto, 2 tickets, the normal ones', offerId: 'off_lis_benfica_porto_std', total: eur(11000), perPerson: eur(5500), policyReasons: ['over_auto_cap', 'over_per_person_cap', 'non_refundable'], approvalMode: 'each_payer' },
      { case: 'over_budget', offerId: 'off_lis_benfica_porto_premium', total: eur(48000), note: 'well over the €250/day budget; Trav warns (VOICE §4.9 B) before proposing' },
      { case: 'sold_out', offerId: 'off_lis_derby_any', expectError: 'sold_out' },
      { case: 'dean_only_during_conference', offerId: 'off_lis_tiles_0416', attendees: [LIS.dean], note: 'inside Dad\'s Thu 09:00–17:00 block' },
      { case: 'never_suggest', offerId: 'off_lis_club_0417', reason: 'group said no clubbing' },
    ],
  };
}

// ------------------------------------------------------------------ tickets: Turks and Caicos

export function turksCaicosTickets() {
  const grace = place('Grace Bay dock (fictional)', 'Grace Bay Rd, Providenciales', 'Providenciales', 'TC', 21.7962, -72.1767, TCI.tz);
  const bight = place('Bight Park', 'Lower Bight Rd, Providenciales', 'Providenciales', 'TC', 21.7966, -72.1878, TCI.tz);
  const leeward = place('Leeward marina (fictional)', 'Leeward Hwy, Providenciales', 'Providenciales', 'TC', 21.8072, -72.1352, TCI.tz);
  const bar = place('The Tipsy Pelican (fictional)', 'Grace Bay Rd, Providenciales', 'Providenciales', 'TC', 21.7950, -72.1700, TCI.tz);
  const casino = place('Palm Lights Casino (fictional)', 'Grace Bay Rd, Providenciales', 'Providenciales', 'TC', 21.7940, -72.1690, TCI.tz);

  const events = [
    event({ id: 'evt_tci_snorkel_0622', name: 'reef snorkel tour', category: 'tour', venue: grace, startsAt: `2026-06-22T09:00:00${TCO}`, endsAt: `2026-06-22T12:00:00${TCO}`, flags: ['family'] }),
    event({ id: 'evt_tci_cruise_0623', name: 'sunset cruise (family sailing)', category: 'tour', venue: leeward, startsAt: `2026-06-23T17:30:00${TCO}`, endsAt: `2026-06-23T19:30:00${TCO}`, flags: ['family'] }),
    event({ id: 'evt_tci_iguana_0624', name: 'Little Water Cay iguana trip', category: 'tour', venue: leeward, startsAt: `2026-06-24T10:00:00${TCO}`, flags: ['family'] }),
    event({ id: 'evt_tci_fishfry_0625', name: 'Thursday fish fry (free entry)', category: 'food_drink', venue: bight, startsAt: `2026-06-25T17:30:00${TCO}`, flags: ['family'] }),
    event({ id: 'evt_tci_jetski_0623', name: 'jet ski rental, 1 hour', category: 'tour', venue: leeward, startsAt: `2026-06-23T10:00:00${TCO}`, minimumAge: 16, flags: [] }),
    event({ id: 'evt_tci_trivia_0624', name: 'bar trivia night', category: 'nightlife', venue: bar, startsAt: `2026-06-24T21:00:00${TCO}`, minimumAge: 18, flags: ['nightlife', 'bar', 'alcohol', '18+'] }),
    event({ id: 'evt_tci_casino_0624', name: 'casino night + $40 play voucher', category: 'nightlife', venue: casino, startsAt: `2026-06-24T21:30:00${TCO}`, minimumAge: 21, flags: ['gambling', '21+', 'alcohol', 'late_night'] }),
  ];
  const offers = [
    { id: 'off_tci_snorkel_0622', eventId: 'evt_tci_snorkel_0622', tier: 'Shared boat, gear included', price: 6000, fees: 500, available: 12, refundableUntil: `2026-06-21T17:00:00${TCO}` },
    { id: 'off_tci_cruise_0623', eventId: 'evt_tci_cruise_0623', tier: 'Family sail, soft drinks', price: 9500, available: 10, refundableUntil: `2026-06-22T17:30:00${TCO}` },
    { id: 'off_tci_iguana_0624', eventId: 'evt_tci_iguana_0624', tier: 'Half day', price: 8500, available: 8 },
    { id: 'off_tci_jetski_0623', eventId: 'evt_tci_jetski_0623', tier: '1 hour, 1 rider', price: 12000, available: 4 },
    { id: 'off_tci_trivia_0624', eventId: 'evt_tci_trivia_0624', tier: 'Team entry', price: 1000, available: 20 },
    { id: 'off_tci_casino_0624', eventId: 'evt_tci_casino_0624', tier: 'Entry + $40 voucher', price: 5000, available: 50 },
  ].map((o) => offer(o, 'USD'));
  return {
    fixtureVersion: 1,
    name: 'turks-and-caicos',
    description: 'Synthetic ticket inventory for the Turks and Caicos family trip (jun 20-27, 2026). Fictional operators and prices. Same schema as fixtures/tickets/barcelona.json (flat offers with eventId).',
    city: 'Providenciales',
    orderPrefix: 'TCI',
    holdMinutes: 15,
    currency: 'USD',
    provider: 'mock-tickets',
    events,
    offers,
    mockHints: {
      evt_tci_fishfry_0625: { note: 'free event with no offers: Trav can suggest it, never propose a €0 booking' },
      off_tci_snorkel_0622: { holdMinutes: 15, orderRefPrefix: 'SN', note: "Lily's ticket is delivered to Dad (guardian)" },
    },
    labels: [
      { case: 'family_booking', request: 'snorkel tour for all 4 on monday', offerId: 'off_tci_snorkel_0622', total: usd(26000), perPerson: usd(6500), refundable: true, payers: [{ memberId: TCI.dad, shareMinor: 26000 }], attendees: TCI.all, policyReasons: ['over_auto_cap', 'over_per_person_cap'], approvalMode: 'each_payer', requiredApprovers: [TCI.dad] },
      { case: 'minor_age_restricted', request: 'lily: book me a jet ski', offerId: 'off_tci_jetski_0623', policyOutcome: 'deny', policyReasons: ['minor_age_restricted'] },
      { case: 'never_suggest_with_minor', offerIds: ['off_tci_trivia_0624', 'off_tci_casino_0624'] },
      { case: 'adults_only_explicit', request: 'casino night for me and dad', offerId: 'off_tci_casino_0624', attendees: [TCI.dean, TCI.dad], total: usd(10000), perPerson: usd(5000), policyReasons: ['over_auto_cap'], note: 'exactly at the $50 per-person cap is inside the cap (> not >=)' },
    ],
  };
}

// ------------------------------------------------------------------ flights: Barcelona (ground truth only)
//
// fixtures/flights/barcelona.json (Duffel-like, owned by the mock flights adapter, T-029-a) is preserved.
// This brute-forces all 4^6 group itineraries over it so graders have exact reference answers.

/** UTC offsets in effect 2026-03-11 … 2026-03-17 (US DST began 2026-03-08; EU DST begins 2026-03-29). */
const ZONE_OFFSET_MARCH_2026 = {
  'America/New_York': '-04:00',
  'America/Chicago': '-05:00',
  'America/Denver': '-06:00',
  'America/Los_Angeles': '-07:00',
  'Atlantic/Reykjavik': '+00:00',
  'Europe/Lisbon': '+00:00',
  'Europe/London': '+00:00',
  'Europe/Dublin': '+00:00',
  'Europe/Madrid': '+01:00',
  'Europe/Paris': '+01:00',
  'Europe/Amsterdam': '+01:00',
  'Europe/Berlin': '+01:00',
};

function zonedMs(wall, zone) {
  const off = ZONE_OFFSET_MARCH_2026[zone];
  assert(off, `no March 2026 offset for ${zone}`);
  return Date.parse(`${wall.length === 16 ? `${wall}:00` : wall}${off}`);
}

const decimalToMinor = (s) => {
  assert(/^\d+\.\d{2}$/.test(s), `bad decimal ${s}`);
  return Number(s.replace('.', ''));
};

export function barcelonaFlightGroundTruth(real, sourceSha256) {
  const facts = real.offers.map((o) => {
    const out = o.slices[0].segments;
    const ret = o.slices[1].segments;
    const lay = (segs) => segs.slice(1).map((sg, i) => (zonedMs(sg.departing_at, sg.departure_time_zone) - zonedMs(segs[i].arriving_at, segs[i].arrival_time_zone)) / 60000);
    return {
      offerId: o.id,
      origin: out[0].origin,
      returnTo: ret[ret.length - 1].destination,
      price: decimalToMinor(o.total_amount),
      departLocal: out[0].departing_at.slice(0, 16),
      arriveBcnLocal: out[out.length - 1].arriving_at.slice(0, 16),
      returnDepartBcnLocal: ret[0].departing_at.slice(0, 16),
      arrive: zonedMs(out[out.length - 1].arriving_at, out[out.length - 1].arrival_time_zone),
      returnDepart: zonedMs(ret[0].departing_at, ret[0].departure_time_zone),
      stops: out.length - 1 + (ret.length - 1),
      worstLayoverMinutes: Math.max(0, ...lay(out), ...lay(ret)),
      refundable: o.conditions.refund_before_departure.allowed === true,
      departsBefore7am: Number(out[0].departing_at.slice(11, 13)) < 7,
      ...(o.mock_reprice ? { mockReprice: o.mock_reprice } : {}),
      ...(o.expires_after_minutes !== undefined ? { expiresAfterMinutes: o.expires_after_minutes } : {}),
    };
  });
  const byTraveler = real.travelers.map((t) => {
    const list = facts.filter((f) => f.origin === t.origin && f.returnTo === t.return_to);
    assert(list.length > 0, `no offers for ${t.member_id}`);
    return { memberId: t.member_id, list };
  });
  const describe = (picks) => {
    const arr = picks.map((p) => p.arrive);
    const dep = picks.map((p) => p.returnDepart);
    return {
      offerIds: picks.map((p) => p.offerId),
      totalCost: eur(picks.reduce((s, p) => s + p.price, 0)),
      arrivalSpreadMinutes: (Math.max(...arr) - Math.min(...arr)) / 60000,
      returnDepartureSpreadMinutes: (Math.max(...dep) - Math.min(...dep)) / 60000,
      worstLayoverMinutes: Math.max(...picks.map((p) => p.worstLayoverMinutes)),
      allRefundable: picks.every((p) => p.refundable),
      anyDepartsBefore7am: picks.filter((p) => p.departsBefore7am).map((p) => p.offerId),
    };
  };
  const cheapest = (list) => [...list].sort((a, b) => a.price - b.price || a.offerId.localeCompare(b.offerId))[0];
  const naive = describe(byTraveler.map((t) => cheapest(t.list)));
  let combos = 0;
  let best = null;
  let bestNoEarlyJordan = null;
  const better = (d, cur) => !cur || d.arrivalSpreadMinutes < cur.arrivalSpreadMinutes || (d.arrivalSpreadMinutes === cur.arrivalSpreadMinutes && d.totalCost.amountMinor < cur.totalCost.amountMinor);
  const walk = (i, acc) => {
    if (i === byTraveler.length) {
      combos += 1;
      const d = describe(acc);
      if (better(d, best)) best = d;
      const jordanPick = acc[byTraveler.findIndex((t) => t.memberId === BCN.jordan)];
      if (!jordanPick.departsBefore7am && better(d, bestNoEarlyJordan)) bestNoEarlyJordan = d;
      return;
    }
    for (const f of byTraveler[i].list) walk(i + 1, [...acc, f]);
  };
  walk(0, []);
  assert(best.arrivalSpreadMinutes < naive.arrivalSpreadMinutes, 'min-spread must beat naive cheapest');
  const refundableSets = byTraveler.map((t) => t.list.filter((f) => f.refundable));
  const cheapestAllRefundable = refundableSets.every((l) => l.length > 0) ? describe(refundableSets.map(cheapest)) : null;
  const minPrice = byTraveler.map((t) => ({ memberId: t.memberId, min: eur(Math.min(...t.list.map((f) => f.price))) }));
  const strip = ({ arrive: _a, returnDepart: _r, ...rest }) => rest;
  return {
    fixtureVersion: 1,
    source: 'fixtures/flights/barcelona.json',
    sourceSha256,
    note: 'Brute force over every combination of one offer per traveler. Prices are per passenger in EUR. Times compared in UTC using the March 2026 offsets in ZONE_OFFSET_MARCH_2026 (fixtures/_gen/inventory.mjs).',
    travelers: real.travelers.map((t) => ({ memberId: t.member_id, origin: t.origin, returnTo: t.return_to, offerIds: byTraveler.find((b) => b.memberId === t.member_id).list.map((f) => f.offerId) })),
    offers: facts.map(strip),
    groundTruth: {
      combinations: combos,
      naiveCheapestPerPerson: naive,
      minArrivalSpread: best,
      minArrivalSpreadWithoutJordanBefore7am: bestNoEarlyJordan,
      cheapestAllRefundable,
      minPricePerMember: minPrice,
      groupTotalLowerBound: eur(minPrice.reduce((s, m) => s + m.min.amountMinor, 0)),
    },
    expectations: [
      'optimizer top pick has arrivalSpreadMinutes < naiveCheapestPerPerson.arrivalSpreadMinutes',
      'refundableOnly: true ⇒ every pick refundable; the cheapest such set is cheapestAllRefundable',
      'group memory gm_bcn_3 ("jordan does not want flights before 7am"): a ranked option that includes an ORD offer departing before 07:00 must say so, or the optimizer should prefer minArrivalSpreadWithoutJordanBefore7am',
      'offers with mockReprice must be re-priced before createOrder (price_changed); offers with expiresAfterMinutes expire on the injected clock (offer_expired)',
      'each member pays their own fare (paidBy per_person_cards): booking writes nothing to the group ledger',
    ],
  };
}
// ------------------------------------------------------------------ FX

export function fxRates() {
  const rng = createRng(20260314);
  const holidays = new Set(['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-25', '2026-12-26']);
  const rates = [];
  let r = 1.085;
  for (let t = Date.parse('2026-01-02T12:00:00Z'); t <= Date.parse('2026-07-03T12:00:00Z'); t += 86400000) {
    const d = new Date(t);
    const date = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6 || holidays.has(date)) continue;
    r = Math.min(1.12, Math.max(1.05, r + (rng.next() - 0.5) * 0.006));
    const eurUsd = r.toFixed(4);
    const usdEur = (1 / Number(eurUsd)).toFixed(4);
    rates.push({ base: 'EUR', quote: 'USD', rate: eurUsd, asOf: date, source: 'fixture-ecb-like' });
    rates.push({ base: 'USD', quote: 'EUR', rate: usdEur, asOf: date, source: 'fixture-ecb-like' });
  }
  const find = (base, quote, on) => {
    const cands = rates.filter((x) => x.base === base && x.quote === quote && x.asOf <= on);
    return cands[cands.length - 1];
  };
  return {
    fixtureVersion: 1,
    source: 'fixture-ecb-like',
    note: 'Fictional reference rates (seeded random walk). Business days only; weekends and ECB TARGET holidays have no row: the adapter falls back to the previous business day. Both directions are listed so the mock is a pure lookup.',
    rates,
    labels: [
      { query: { base: 'USD', quote: 'EUR', on: '2026-03-14' }, expectAsOf: '2026-03-13', expectRate: find('USD', 'EUR', '2026-03-14').rate, why: 'Saturday ⇒ Friday' },
      { query: { base: 'EUR', quote: 'USD', on: '2026-03-15' }, expectAsOf: '2026-03-13', expectRate: find('EUR', 'USD', '2026-03-15').rate, why: 'Sunday ⇒ Friday' },
      { query: { base: 'USD', quote: 'EUR', on: '2026-04-06' }, expectAsOf: '2026-04-02', expectRate: find('USD', 'EUR', '2026-04-06').rate, why: 'Easter Monday and Good Friday are TARGET holidays' },
      { query: { base: 'USD', quote: 'EUR', on: '2026-03-12' }, expectAsOf: '2026-03-12', expectRate: find('USD', 'EUR', '2026-03-12').rate, why: 'business day' },
      { query: { base: 'USD', quote: 'GBP', on: '2026-03-12' }, expectError: 'not_found' },
    ],
    lookup: find,
  };
}

