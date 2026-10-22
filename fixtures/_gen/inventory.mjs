// Mock provider inventory. Shapes follow packages/adapters/src/interfaces/{tickets,lodging,flights,context}.ts.
// Mock-only behaviour hints live in `mockHints` keyed by id so the arrays stay exact interface types.
import { addMinutes, assert, createRng, eur, isoAt, isoDuration, local, minutesBetween, usd } from './lib.mjs';
import { BCN, LIS, TCI } from './trips.mjs';

const MAD = '+01:00';
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

// ------------------------------------------------------------------ tickets: Barcelona

export function barcelonaTickets() {
  const razz = place('Razzmatazz', 'Carrer dels Almogàvers 122, 08018 Barcelona', 'Barcelona', 'ES', 41.3976, 2.1911, BCN.tz);
  const apolo = place('Sala Apolo', 'Carrer Nou de la Rambla 113, 08004 Barcelona', 'Barcelona', 'ES', 41.3743, 2.1696, BCN.tz);
  const mirador = place('Sala Mirador (fictional)', 'Passeig Marítim 99, Barcelona', 'Barcelona', 'ES', 41.3851, 2.1990, BCN.tz);
  const campNou = place('Spotify Camp Nou', "Carrer d'Arístides Maillol 12, 08028 Barcelona", 'Barcelona', 'ES', 41.3809, 2.1228, BCN.tz);
  const rcde = place('RCDE Stadium', 'Av. del Baix Llobregat 100, Cornellà de Llobregat', 'Cornellà de Llobregat', 'ES', 41.3479, 2.0756, BCN.tz);
  const sagrada = place('Basílica de la Sagrada Família', 'Carrer de Mallorca 401, 08013 Barcelona', 'Barcelona', 'ES', 41.4036, 2.1744, BCN.tz);
  const guell = place('Park Güell', "Carrer d'Olot, 08024 Barcelona", 'Barcelona', 'ES', 41.4145, 2.1527, BCN.tz);
  const flamenco = place('Tablao Lluna Plena (fictional)', 'Carrer Ample 20, Barcelona', 'Barcelona', 'ES', 41.3808, 2.1797, BCN.tz);
  const cable = place('Telefèric de Montjuïc', 'Av. Miramar, Barcelona', 'Barcelona', 'ES', 41.3717, 2.1652, BCN.tz);

  const club = ['nightlife', 'club', '18+', 'alcohol', 'late_night'];
  const events = [
    event({ id: 'evt_bcn_razz_0313', name: 'Razzmatazz: Friday', category: 'nightlife', venue: razz, startsAt: `2026-03-13T23:30:00${MAD}`, doorsAt: `2026-03-13T23:30:00${MAD}`, endsAt: `2026-03-14T05:30:00${MAD}`, minimumAge: 18, flags: club }),
    event({ id: 'evt_bcn_razz_0314', name: 'Razzmatazz: Saturday', category: 'nightlife', venue: razz, startsAt: `2026-03-14T23:30:00${MAD}`, doorsAt: `2026-03-14T23:30:00${MAD}`, endsAt: `2026-03-15T05:30:00${MAD}`, minimumAge: 18, flags: club }),
    event({ id: 'evt_bcn_razz_0316', name: 'Razzmatazz: Monday', category: 'nightlife', venue: razz, startsAt: `2026-03-16T23:59:00${MAD}`, endsAt: `2026-03-17T05:00:00${MAD}`, minimumAge: 18, flags: club }),
    event({ id: 'evt_bcn_apolo_0316', name: 'Apolo: Monday night', category: 'nightlife', venue: apolo, startsAt: `2026-03-16T23:59:00${MAD}`, doorsAt: `2026-03-17T00:30:00${MAD}`, endsAt: `2026-03-17T05:00:00${MAD}`, minimumAge: 18, flags: club }),
    event({ id: 'evt_bcn_mirador_vip_0315', name: 'Sala Mirador VIP table (fictional)', category: 'nightlife', venue: mirador, startsAt: `2026-03-15T23:59:00${MAD}`, minimumAge: 21, flags: [...club, '21+'] }),
    event({ id: 'evt_bcn_barca_sevilla', name: 'FC Barcelona vs Sevilla FC', category: 'sports', venue: campNou, startsAt: `2026-03-15T21:00:00${MAD}`, endsAt: `2026-03-15T23:00:00${MAD}`, flags: [] }),
    event({ id: 'evt_bcn_espanyol_getafe', name: 'RCD Espanyol vs Getafe CF', category: 'sports', venue: rcde, startsAt: `2026-03-14T18:30:00${MAD}`, endsAt: `2026-03-14T20:30:00${MAD}`, flags: [] }),
    event({ id: 'evt_bcn_sagrada_0314_1400', name: 'Sagrada Família timed entry 2:00pm', category: 'attraction', venue: sagrada, startsAt: `2026-03-14T14:00:00${MAD}`, flags: ['family'] }),
    event({ id: 'evt_bcn_sagrada_0314_1500', name: 'Sagrada Família timed entry 3:00pm', category: 'attraction', venue: sagrada, startsAt: `2026-03-14T15:00:00${MAD}`, endsAt: `2026-03-14T16:30:00${MAD}`, flags: ['family'] }),
    event({ id: 'evt_bcn_parkguell_0313_1000', name: 'Park Güell timed entry 10:00am', category: 'attraction', venue: guell, startsAt: `2026-03-13T10:00:00${MAD}`, flags: ['family'] }),
    event({ id: 'evt_bcn_flamenco_0313', name: 'flamenco show + one drink', category: 'theatre', venue: flamenco, startsAt: `2026-03-13T19:00:00${MAD}`, endsAt: `2026-03-13T20:15:00${MAD}`, flags: ['alcohol'] }),
    event({ id: 'evt_bcn_cablecar_0316', name: 'Montjuïc cable car', category: 'tour', venue: cable, startsAt: `2026-03-16T11:00:00${MAD}`, flags: ['family'] }),
  ];
  const offers = [
    { id: 'off_bcn_razz_0313_ga', eventId: 'evt_bcn_razz_0313', tier: 'General admission', price: 1350, fees: 150, available: 220, refundableUntil: `2026-03-13T22:00:00${MAD}` },
    { id: 'off_bcn_razz_0314_ga', eventId: 'evt_bcn_razz_0314', tier: 'General admission', price: 1650, fees: 150, available: 140, refundableUntil: `2026-03-14T22:00:00${MAD}` },
    { id: 'off_bcn_razz_0314_fastline', eventId: 'evt_bcn_razz_0314', tier: 'Fast-line presale', price: 2500, fees: 200, available: 30 },
    { id: 'off_bcn_razz_0316_ga', eventId: 'evt_bcn_razz_0316', tier: 'General admission', price: 1650, fees: 150, available: 0, refundableUntil: `2026-03-16T22:00:00${MAD}` },
    { id: 'off_bcn_apolo_0316_ga', eventId: 'evt_bcn_apolo_0316', tier: 'General admission', price: 1380, fees: 120, available: 80 },
    { id: 'off_bcn_mirador_vip_table', eventId: 'evt_bcn_mirador_vip_0315', tier: 'VIP table for 6 (minimum spend)', price: 600000, fees: 0, available: 2, maxPerOrder: 1, delivery: 'single_group_qr' },
    { id: 'off_bcn_barca_upper_corner', eventId: 'evt_bcn_barca_sevilla', tier: 'Upper corner, 3rd tier', price: 6600, fees: 600, available: 12, refundableUntil: `2026-03-13T21:00:00${MAD}`, holderNames: true },
    { id: 'off_bcn_barca_behind_goal', eventId: 'evt_bcn_barca_sevilla', tier: 'Gol Nord, behind the goal', price: 6200, fees: 600, available: 20, holderNames: true },
    { id: 'off_bcn_barca_tribuna_vip', eventId: 'evt_bcn_barca_sevilla', tier: 'Tribuna VIP with lounge', price: 29500, fees: 1500, available: 8, refundableUntil: `2026-03-13T21:00:00${MAD}`, holderNames: true },
    { id: 'off_bcn_espanyol_getafe', eventId: 'evt_bcn_espanyol_getafe', tier: 'Lateral', price: 5000, fees: 500, available: 60, refundableUntil: `2026-03-13T18:30:00${MAD}` },
    { id: 'off_bcn_sagrada_1400', eventId: 'evt_bcn_sagrada_0314_1400', tier: 'Basic entry', price: 2600, available: 0, holderNames: true },
    { id: 'off_bcn_sagrada_1500', eventId: 'evt_bcn_sagrada_0314_1500', tier: 'Basic entry + audio guide', price: 2600, available: 18, holderNames: true },
    { id: 'off_bcn_sagrada_1500_towers', eventId: 'evt_bcn_sagrada_0314_1500', tier: 'Entry with towers', price: 3600, available: 4, holderNames: true },
    { id: 'off_bcn_parkguell_1000', eventId: 'evt_bcn_parkguell_0313_1000', tier: 'General entry', price: 1800, available: 300, delivery: 'redirect', redirect: 'https://tickets.parkguell.example.test/buy?date=2026-03-13&time=10:00' },
    { id: 'off_bcn_flamenco_0313', eventId: 'evt_bcn_flamenco_0313', tier: 'Show + one drink', price: 3800, fees: 200, available: 40, refundableUntil: `2026-03-12T20:00:00${MAD}` },
    { id: 'off_bcn_cablecar_0316', eventId: 'evt_bcn_cablecar_0316', tier: 'Return ticket', price: 1650, available: 100, refundableUntil: `2026-03-16T09:00:00${MAD}` },
  ].map((o) => offer(o, 'EUR'));

  const mockHints = {
    off_bcn_razz_0314_ga: { holdMinutes: 15, orderRefPrefix: 'RZ', note: 'flagship: 5 × €18 = €90; matches VOICE §4.1 A / §4.2 A' },
    off_bcn_razz_0313_ga: { holdMinutes: 15, orderRefPrefix: 'RZ' },
    off_bcn_razz_0316_ga: { holdMinutes: 15, expect: 'sold_out', alternatives: ['off_bcn_apolo_0316_ga'] },
    off_bcn_apolo_0316_ga: { holdMinutes: 15, orderRefPrefix: 'AP' },
    off_bcn_mirador_vip_table: { holdMinutes: 10, note: '€6,000 > hardMaxPerBookingMinor 500000: policy D7 over_hard_max; never one-tap buyable' },
    off_bcn_barca_upper_corner: {
      holdMinutes: 15,
      orderRefPrefix: 'FCB',
      seats: [
        { gate: '14', section: '534', row: '8', seat: '11' },
        { gate: '14', section: '534', row: '8', seat: '12' },
        { gate: '14', section: '534', row: '8', seat: '13' },
        { gate: '14', section: '534', row: '8', seat: '14' },
        { gate: '14', section: '534', row: '8', seat: '15' },
        { gate: '14', section: '534', row: '8', seat: '16' },
      ],
    },
    off_bcn_sagrada_1400: { expect: 'sold_out', alternatives: ['off_bcn_sagrada_1500'] },
    off_bcn_sagrada_1500: { holdMinutes: 20, orderRefPrefix: 'SF' },
    off_bcn_sagrada_1500_towers: { note: 'only 4 left: getOffers(event, 6) must not return it' },
    off_bcn_parkguell_1000: { expect: 'redirect_only', note: 'hold() returns not_supported; Trav posts the checkout link instead of buying' },
    off_bcn_flamenco_0313: { holdMinutes: 15, priceChangeOnPurchase: { unitPrice: eur(4400) }, note: 'purchase returns price_changed with newAmount; Trav re-proposes' },
    off_bcn_cablecar_0316: { providerUnavailable: true, note: 'every call returns provider_unavailable (retryable): VOICE §4.10 A, no money moved' },
  };

  return {
    fixtureVersion: 1,
    city: 'Barcelona',
    currency: 'EUR',
    provider: 'mock-tickets',
    events,
    offers,
    mockHints,
    labels: [
      { case: 'flagship', request: '@trav get the 5 of us Razzmatazz tickets, Henry\'s sick (Sat 2026-03-14 21:40)', expectEventId: 'evt_bcn_razz_0314', expectOfferId: 'off_bcn_razz_0314_ga', quantity: 5, expectHold: { subtotal: eur(8250), fees: eur(750), taxes: eur(0), total: eur(9000) }, perPerson: eur(1800), refundable: true, refundDeadline: `2026-03-14T22:00:00${MAD}`, holdExpiresAt: `2026-03-14T21:55:00${MAD}`, refundableFirst: 'GA (refundable) is preferred over fast-line (non-refundable)' },
      { case: 'sold_out_with_alternative', request: 'razzmatazz monday for 6', expectError: 'sold_out', offerId: 'off_bcn_razz_0316_ga', alternative: 'off_bcn_apolo_0316_ga', alternativeTotalFor6: eur(9000) },
      { case: 'over_per_person_cap', request: 'barça vs sevilla for 6', expectOfferId: 'off_bcn_barca_upper_corner', perPerson: eur(7200), total: eur(43200), refundable: true, policyReasons: ['over_auto_cap', 'over_per_person_cap'], approvalMode: 'each_payer' },
      { case: 'nothing_under_cap', request: 'barça under €60 a head', expect: 'none under €60; closest three', closest: ['off_bcn_barca_upper_corner', 'off_bcn_barca_behind_goal', 'off_bcn_espanyol_getafe'], tradeoffs: ['€72 refundable', '€68 non-refundable', '€55 not barça'] },
      { case: 'over_budget', request: 'best seats for barça', offerId: 'off_bcn_barca_tribuna_vip', perPerson: eur(31000), total: eur(186000), note: 'allowed by policy (< hard max) but needs each_payer approval; Trav should mention the cheaper refundable option' },
      { case: 'over_hard_max', request: 'VIP table, whatever it costs', offerId: 'off_bcn_mirador_vip_table', total: eur(600000), policyOutcome: 'deny', policyReasons: ['over_hard_max'] },
      { case: 'timed_slot_sold_out', request: 'sagrada familia saturday 2pm for 6', expectError: 'sold_out', alternative: 'off_bcn_sagrada_1500', alternativeTotalFor6: eur(15600), refundable: false },
      { case: 'redirect_only', request: 'park güell friday 10am for 6', offerId: 'off_bcn_parkguell_1000', expect: 'reply with checkout link; no proposal' },
      { case: 'price_changed', offerId: 'off_bcn_flamenco_0313', expectError: 'price_changed', newUnitTotal: eur(4600) },
      { case: 'provider_down', offerId: 'off_bcn_cablecar_0316', expectError: 'provider_unavailable' },
    ],
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
    { id: 'off_lis_sporting_braga', eventId: 'evt_lis_sporting_braga', tier: 'Central', price: 3200, fees: 300, available: 50, refundableUntil: `2026-04-18T18:00:00${LISO}` },
    { id: 'off_lis_porto_vitoria', eventId: 'evt_lis_porto_vitoria', tier: 'Lateral', price: 3700, fees: 300, available: 30 },
    { id: 'off_lis_fado_0416', eventId: 'evt_lis_fado_0416', tier: 'Dinner + fado', price: 4500, available: 12, refundableUntil: `2026-04-16T12:00:00${LISO}` },
    { id: 'off_lis_club_0417', eventId: 'evt_lis_club_0417', tier: 'Entry', price: 2000, available: 200 },
    { id: 'off_lis_pena_0417', eventId: 'evt_lis_pena_0417', tier: 'Palace + park', price: 2000, available: 30, refundableUntil: `2026-04-16T23:59:00${LISO}` },
    { id: 'off_lis_tiles_0416', eventId: 'evt_lis_tiles_0416', tier: 'Workshop seat', price: 3500, available: 4, refundableUntil: `2026-04-15T18:00:00${LISO}` },
  ].map((o) => offer(o, 'EUR'));
  return {
    fixtureVersion: 1,
    city: 'Lisbon',
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
    city: 'Providenciales',
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

// ------------------------------------------------------------------ lodging: Barcelona

export function barcelonaLodging() {
  const prop = (id, name, kind, address, lat, lon, extra) => ({
    propertyId: id,
    provider: 'mock-lodging',
    name,
    kind,
    place: place(name, address, 'Barcelona', 'ES', lat, lon, BCN.tz),
    amenities: extra.amenities,
    photoUrls: [1, 2, 3].map((n) => `https://img.example.test/lodging/${id}_${n}.jpg`),
    ...(extra.bedrooms ? { bedrooms: extra.bedrooms } : {}),
    maxOccupancy: extra.maxOccupancy,
    ...(extra.reviewScore ? { reviewScore: extra.reviewScore } : {}),
    ...(extra.starRating ? { starRating: extra.starRating } : {}),
    url: `https://stays.example.test/${id}`,
  });
  const rate = (rateId, propertyId, roomName, sleeps, total, refundableUntil, extra = {}) => ({
    rateId,
    propertyId,
    roomName,
    sleeps,
    totalAmount: eur(total),
    ...(extra.payAtProperty ? { payAtProperty: eur(extra.payAtProperty) } : {}),
    refundPolicy: refundableUntil
      ? { refundable: true, refundableUntil, summary: 'free cancellation until the deadline' }
      : { refundable: false, summary: 'non-refundable' },
    boardBasis: 'room_only',
    needsRecheck: true,
  });
  const cityTax = 10500; // €3.50 × 6 people × 5 nights, paid at the property
  const results = [
    {
      property: prop('prop_bcn_eixample_3br', 'Eixample 3BR with balcony', 'vacation_rental', "Carrer d'Aragó 255, Eixample", 41.3925, 2.1625, { amenities: ['wifi', 'kitchen', 'washer', 'balcony', 'self check-in'], bedrooms: 3, maxOccupancy: 6, reviewScore: 9.8 }),
      rates: [
        rate('rate_bcn_eixample_3br_flex', 'prop_bcn_eixample_3br', 'whole apartment', 6, 138000, '2026-03-07T23:59:00+01:00', { payAtProperty: cityTax }),
        rate('rate_bcn_eixample_3br_nonref', 'prop_bcn_eixample_3br', 'whole apartment', 6, 125000, null, { payAtProperty: cityTax }),
      ],
    },
    {
      property: prop('prop_bcn_poblenou_loft', 'Poblenou loft, 3 bedrooms', 'vacation_rental', 'Carrer de Pujades 140, Poblenou', 41.4005, 2.1980, { amenities: ['wifi', 'kitchen', 'rooftop'], bedrooms: 3, maxOccupancy: 6, reviewScore: 9.1 }),
      rates: [rate('rate_bcn_poblenou_nonref', 'prop_bcn_poblenou_loft', 'whole loft', 6, 119000, null, { payAtProperty: cityTax })],
    },
    {
      property: prop('prop_bcn_gracia_house', 'Gràcia townhouse with patio', 'vacation_rental', 'Carrer de Verdi 30, Gràcia', 41.4031, 2.1569, { amenities: ['wifi', 'kitchen', 'patio', 'washer'], bedrooms: 3, maxOccupancy: 7, reviewScore: 9.5 }),
      rates: [rate('rate_bcn_gracia_flex', 'prop_bcn_gracia_house', 'whole house', 7, 164000, '2026-03-05T23:59:00+01:00', { payAtProperty: cityTax })],
    },
    {
      property: prop('prop_bcn_barceloneta_flat', 'Barceloneta flat by the beach', 'vacation_rental', 'Carrer de Sant Carles 18, Barceloneta', 41.3797, 2.1893, { amenities: ['wifi', 'kitchen', 'sea view'], bedrooms: 3, maxOccupancy: 6, reviewScore: 8.9 }),
      rates: [rate('rate_bcn_barceloneta_flex', 'prop_bcn_barceloneta_flat', 'whole flat', 6, 142000, '2026-03-08T23:59:00+01:00', { payAtProperty: cityTax })],
    },
    {
      property: prop('prop_bcn_gothic_hostel', 'Gothic Quarter hostel, private 6-bed room', 'hostel', 'Carrer de la Boqueria 10, Barri Gòtic', 41.3818, 2.1747, { amenities: ['wifi', 'lockers', 'shared kitchen'], bedrooms: 1, maxOccupancy: 6, reviewScore: 8.2 }),
      rates: [rate('rate_bcn_hostel_flex', 'prop_bcn_gothic_hostel', 'private 6-bed dorm', 6, 54000, '2026-03-10T23:59:00+01:00', { payAtProperty: cityTax })],
    },
    {
      property: prop('prop_bcn_rambla_hotel', 'Hotel Rambla Fictícia', 'hotel', 'La Rambla 70, Barcelona', 41.3810, 2.1730, { amenities: ['wifi', 'breakfast', 'gym', 'front desk'], maxOccupancy: 3, starRating: 4, reviewScore: 8.7 }),
      rates: [rate('rate_bcn_hotel_2triples', 'prop_bcn_rambla_hotel', '2 × triple room', 6, 231000, '2026-03-10T23:59:00+01:00')],
    },
  ];
  return {
    fixtureVersion: 1,
    city: 'Barcelona',
    provider: 'mock-lodging',
    checkIn: '2026-03-12',
    checkOut: '2026-03-17',
    results,
    mockHints: {
      rate_bcn_eixample_3br_flex: { confirmationPrefix: 'EIX', checkInInstructions: 'check-in from 3pm; the host sends the door code the morning of arrival' },
      rate_bcn_gracia_flex: { recheck: { expect: 'price_changed', newAmount: eur(172000) } },
      rate_bcn_barceloneta_flex: { recheck: { expect: 'sold_out' } },
      prop_bcn_eixample_3br: { messageProperty: 'not_supported', note: 'vacation-rental host messaging has no API (connectors.md)' },
    },
    labels: [
      {
        case: 'group_ask',
        request: '6 person airbnb in eixample or gracia, under €1500 total, refundable pls',
        query: { near: { city: 'Barcelona' }, checkIn: '2026-03-12', checkOut: '2026-03-17', adults: 6, wholeUnitForGroup: true, maxTotal: eur(150000), refundableOnly: true },
        expectRateId: 'rate_bcn_eixample_3br_flex',
        total: eur(138000),
        perPerson: eur(23000),
        rejected: {
          rate_bcn_eixample_3br_nonref: 'non-refundable (refundable-first)',
          rate_bcn_poblenou_nonref: 'non-refundable and not in Eixample/Gràcia; mention it as the cheaper non-refundable alternative (VOICE §4.1 C)',
          rate_bcn_gracia_flex: 'over €1,500',
          rate_bcn_barceloneta_flex: 'not in Eixample/Gràcia',
          rate_bcn_hostel_flex: 'hostel, not a whole unit',
          rate_bcn_hotel_2triples: 'over €1,500 and not a whole unit',
        },
        policy: { outcome: 'needs_confirmation', reasons: ['over_auto_cap', 'kind_requires_each_payer', 'over_per_person_cap', 'over_daily_cap'], ruleIds: ['C1', 'C2', 'C3', 'C6'], approvalMode: 'each_payer', requiredApprovers: BCN.all },
      },
    ],
  };
}

// ------------------------------------------------------------------ flights: Barcelona

const AIRPORT_OFFSET = {
  BOS: '-04:00', IAD: '-04:00', ATL: '-04:00', MIA: '-04:00', JFK: '-04:00', CLT: '-04:00',
  ORD: '-05:00', DFW: '-05:00', AUS: '-05:00',
  SFO: '-07:00', LAX: '-07:00',
  BCN: '+01:00', MAD: '+01:00', CDG: '+01:00', FRA: '+01:00',
  LHR: '+00:00', LIS: '+00:00', DUB: '+00:00',
};
const AIRPORT_TZ = {
  BOS: 'America/New_York', IAD: 'America/New_York', ATL: 'America/New_York', MIA: 'America/New_York', JFK: 'America/New_York', CLT: 'America/New_York',
  ORD: 'America/Chicago', DFW: 'America/Chicago', AUS: 'America/Chicago',
  SFO: 'America/Los_Angeles', LAX: 'America/Los_Angeles',
  BCN: 'Europe/Madrid', MAD: 'Europe/Madrid', CDG: 'Europe/Paris', FRA: 'Europe/Berlin',
  LHR: 'Europe/London', LIS: 'Europe/Lisbon', DUB: 'Europe/Dublin',
};
const CARRIERS = {
  GV: { iataCode: 'GV', name: 'Gaviota Airways' },
  NS: { iataCode: 'NS', name: 'Northstar Atlantic' },
  IX: { iataCode: 'IX', name: 'Iberolux' },
  CL: { iataCode: 'CL', name: 'Coastline Air' },
  MC: { iataCode: 'MC', name: 'Mistral Connect' },
};

function seg(from, to, depWall, durMin, carrier, num) {
  const departingAt = local(depWall, AIRPORT_OFFSET[from]);
  const arrivingAt = addMinutes(departingAt, durMin, AIRPORT_OFFSET[to]);
  return {
    origin: from,
    destination: to,
    departingAt,
    departureTimeZone: AIRPORT_TZ[from],
    arrivingAt,
    arrivalTimeZone: AIRPORT_TZ[to],
    marketingCarrier: CARRIERS[carrier],
    flightNumber: `${carrier}${num}`,
    duration: isoDuration(durMin),
  };
}

function slice(segments) {
  const first = segments[0];
  const last = segments[segments.length - 1];
  return {
    origin: first.origin,
    destination: last.destination,
    duration: isoDuration(minutesBetween(first.departingAt, last.arrivingAt)),
    segments,
  };
}

function layovers(sl) {
  const out = [];
  for (let i = 1; i < sl.segments.length; i += 1) {
    out.push(minutesBetween(sl.segments[i - 1].arrivingAt, sl.segments[i].departingAt));
  }
  return out;
}

export function barcelonaFlights() {
  const searchedAt = '2026-02-03T20:12:30-05:00';
  const T = (memberId, letter, priceEur, refundable, owner, out, ret) => ({ memberId, letter, priceEur, refundable, owner, out, ret });
  const D = '2026-03-11T';
  const R = '2026-03-17T';
  const table = [
    // Dean BOS → BCN, BCN → JFK
    T(BCN.dean, 'a', 41200, false, 'GV', [seg('BOS', 'BCN', `${D}19:10`, 445, 'GV', '211')], [seg('BCN', 'JFK', `${R}11:05`, 530, 'GV', '212')]),
    T(BCN.dean, 'b', 35600, false, 'IX', [seg('BOS', 'LIS', `${D}21:30`, 385, 'IX', '402'), seg('LIS', 'BCN', '2026-03-12T09:20', 125, 'IX', '1310')], [seg('BCN', 'LIS', `${R}08:00`, 135, 'IX', '1311'), seg('LIS', 'JFK', `${R}11:00`, 475, 'IX', '407')]),
    T(BCN.dean, 'c', 54800, true, 'GV', [seg('BOS', 'BCN', `${D}18:00`, 445, 'GV', '215')], [seg('BCN', 'JFK', `${R}11:05`, 530, 'GV', '212')]),
    T(BCN.dean, 'd', 29800, false, 'MC', [seg('BOS', 'DUB', '2026-03-12T07:10', 380, 'MC', '88'), seg('DUB', 'BCN', '2026-03-12T18:45', 160, 'MC', '624')], [seg('BCN', 'JFK', `${R}17:20`, 530, 'NS', '31')]),
    // Henry ORD → BCN → ORD
    T(BCN.henry, 'a', 49800, false, 'NS', [seg('ORD', 'BCN', `${D}17:20`, 545, 'NS', '61')], [seg('BCN', 'ORD', `${R}12:15`, 605, 'NS', '62')]),
    T(BCN.henry, 'b', 43100, false, 'NS', [seg('ORD', 'JFK', `${D}15:00`, 135, 'NS', '1180'), seg('JFK', 'BCN', `${D}20:05`, 475, 'NS', '33')], [seg('BCN', 'JFK', `${R}10:20`, 530, 'NS', '34'), seg('JFK', 'ORD', `${R}16:10`, 160, 'NS', '1185')]),
    T(BCN.henry, 'c', 38900, false, 'CL', [seg('ORD', 'LHR', `${D}18:30`, 465, 'CL', '930'), seg('LHR', 'BCN', '2026-03-12T12:50', 130, 'CL', '478')], [seg('BCN', 'LHR', `${R}09:05`, 140, 'CL', '479'), seg('LHR', 'ORD', `${R}12:00`, 545, 'CL', '931')]),
    T(BCN.henry, 'd', 64000, true, 'NS', [seg('ORD', 'BCN', `${D}17:20`, 545, 'NS', '61')], [seg('BCN', 'ORD', `${R}12:15`, 605, 'NS', '62')]),
    // Maya SFO → BCN, BCN → LAX
    T(BCN.maya, 'a', 53800, false, 'GV', [seg('SFO', 'BCN', `${D}13:40`, 710, 'GV', '701')], [seg('BCN', 'LAX', `${R}11:40`, 775, 'GV', '708')]),
    T(BCN.maya, 'b', 47200, false, 'NS', [seg('SFO', 'JFK', `${D}06:00`, 335, 'NS', '1402'), seg('JFK', 'BCN', `${D}18:20`, 460, 'NS', '37')], [seg('BCN', 'JFK', `${R}10:20`, 530, 'NS', '34'), seg('JFK', 'LAX', `${R}16:30`, 365, 'NS', '1409')]),
    T(BCN.maya, 'c', 44500, false, 'MC', [seg('SFO', 'FRA', `${D}15:55`, 660, 'MC', '455'), seg('FRA', 'BCN', '2026-03-12T12:30', 125, 'MC', '1120')], [seg('BCN', 'FRA', `${R}07:00`, 120, 'MC', '1121'), seg('FRA', 'LAX', `${R}10:50`, 715, 'MC', '452')]),
    T(BCN.maya, 'd', 72000, true, 'GV', [seg('SFO', 'BCN', `${D}13:40`, 710, 'GV', '701')], [seg('BCN', 'LAX', `${R}11:40`, 775, 'GV', '708')]),
    // Jordan ATL → BCN → ATL
    T(BCN.jordan, 'a', 46500, false, 'CL', [seg('ATL', 'BCN', `${D}17:35`, 520, 'CL', '160')], [seg('BCN', 'ATL', `${R}11:25`, 610, 'CL', '161')]),
    T(BCN.jordan, 'b', 48900, true, 'CL', [seg('ATL', 'BCN', `${D}20:10`, 515, 'CL', '164')], [seg('BCN', 'ATL', `${R}11:25`, 610, 'CL', '161')]),
    T(BCN.jordan, 'c', 40200, false, 'MC', [seg('ATL', 'CDG', `${D}16:00`, 500, 'MC', '301'), seg('CDG', 'BCN', '2026-03-12T08:10', 105, 'MC', '1840')], [seg('BCN', 'CDG', `${R}06:30`, 110, 'MC', '1841'), seg('CDG', 'ATL', `${R}10:30`, 555, 'MC', '302')]),
    T(BCN.jordan, 'd', 41800, false, 'CL', [seg('ATL', 'BCN', '2026-03-12T10:00', 515, 'CL', '168')], [seg('BCN', 'ATL', `${R}11:25`, 610, 'CL', '161')]),
    // Priya IAD → BCN → IAD
    T(BCN.priya, 'a', 44700, false, 'GV', [seg('IAD', 'BCN', `${D}18:15`, 485, 'GV', '511')], [seg('BCN', 'IAD', `${R}12:00`, 565, 'GV', '512')]),
    T(BCN.priya, 'b', 46800, true, 'GV', [seg('IAD', 'BCN', `${D}21:55`, 480, 'GV', '515')], [seg('BCN', 'IAD', `${R}12:00`, 565, 'GV', '512')]),
    T(BCN.priya, 'c', 37100, false, 'IX', [seg('IAD', 'LIS', `${D}17:00`, 410, 'IX', '420'), seg('LIS', 'BCN', '2026-03-12T08:00', 125, 'IX', '1302')], [seg('BCN', 'LIS', `${R}14:10`, 135, 'IX', '1307'), seg('LIS', 'IAD', `${R}17:00`, 500, 'IX', '421')]),
    T(BCN.priya, 'd', 40900, false, 'IX', [seg('IAD', 'MAD', `${D}19:30`, 455, 'IX', '424'), seg('MAD', 'BCN', '2026-03-12T09:30', 80, 'IX', '3010')], [seg('BCN', 'IAD', `${R}12:00`, 565, 'GV', '512')]),
    // Sam MIA → BCN, BCN → AUS
    T(BCN.sam, 'a', 45500, false, 'NS', [seg('MIA', 'BCN', `${D}19:00`, 530, 'NS', '81')], [seg('BCN', 'DFW', `${R}10:15`, 650, 'NS', '84'), seg('DFW', 'AUS', `${R}16:55`, 65, 'NS', '2210')]),
    T(BCN.sam, 'b', 39800, false, 'IX', [seg('MIA', 'MAD', `${D}16:30`, 500, 'IX', '612'), seg('MAD', 'BCN', '2026-03-12T08:10', 80, 'IX', '3002')], [seg('BCN', 'MAD', `${R}08:00`, 85, 'IX', '3005'), seg('MAD', 'DFW', `${R}11:45`, 635, 'IX', '617'), seg('DFW', 'AUS', `${R}17:45`, 65, 'NS', '2214')]),
    T(BCN.sam, 'c', 37600, false, 'NS', [seg('MIA', 'BCN', `${D}22:45`, 525, 'NS', '85')], [seg('BCN', 'JFK', `${R}16:00`, 535, 'NS', '38'), seg('JFK', 'AUS', `${R}21:50`, 265, 'NS', '1530')]),
    T(BCN.sam, 'd', 61000, true, 'NS', [seg('MIA', 'BCN', `${D}19:00`, 530, 'NS', '81')], [seg('BCN', 'DFW', `${R}10:15`, 650, 'NS', '84'), seg('DFW', 'AUS', `${R}16:55`, 65, 'NS', '2214')]),
  ];

  const name = (m) => m.replace('mem_', '');
  const offers = table.map((t) => {
    const offerId = `off_fl_${name(t.memberId)}_${t.letter}`;
    const total = t.priceEur;
    const tax = Math.round(total * 0.18);
    const short = offerId === 'off_fl_sam_d';
    const expiresAt = addMinutes(searchedAt, short ? 3 : 30);
    return {
      offerId,
      provider: 'mock-flights',
      totalAmount: eur(total),
      baseAmount: eur(total - tax),
      taxAmount: eur(tax),
      owner: CARRIERS[t.owner],
      slices: [slice(t.out), slice(t.ret)],
      passengerIds: [t.memberId],
      conditions: {
        refundBeforeDeparture: t.refundable ? { allowed: true, penalty: eur(0) } : { allowed: false },
        changeBeforeDeparture: t.refundable ? { allowed: true, penalty: eur(0) } : { allowed: true, penalty: eur(7500) },
      },
      paymentRequirements: { requiresInstantPayment: true, priceGuaranteeExpiresAt: expiresAt },
      expiresAt,
    };
  });

  // ---- ground truth (brute force over all 4^6 assignments) ----
  const byMember = BCN.all.map((m) => offers.filter((o) => o.passengerIds[0] === m));
  const facts = (o) => {
    const outS = o.slices[0];
    const retS = o.slices[1];
    return {
      offerId: o.offerId,
      memberId: o.passengerIds[0],
      price: o.totalAmount.amountMinor,
      arrive: Date.parse(outS.segments[outS.segments.length - 1].arrivingAt),
      returnDepart: Date.parse(retS.segments[0].departingAt),
      worstLayover: Math.max(0, ...layovers(outS), ...layovers(retS)),
      refundable: o.conditions.refundBeforeDeparture.allowed,
    };
  };
  const F = byMember.map((list) => list.map(facts));
  const describe = (picks) => {
    const arr = picks.map((p) => p.arrive);
    const dep = picks.map((p) => p.returnDepart);
    return {
      offerIds: picks.map((p) => p.offerId),
      totalCost: eur(picks.reduce((s, p) => s + p.price, 0)),
      arrivalSpreadMinutes: (Math.max(...arr) - Math.min(...arr)) / 60000,
      returnDepartureSpreadMinutes: (Math.max(...dep) - Math.min(...dep)) / 60000,
      worstLayoverMinutes: Math.max(...picks.map((p) => p.worstLayover)),
      allRefundable: picks.every((p) => p.refundable),
      firstArrival: isoAt(Math.min(...arr), '+01:00'),
      lastArrival: isoAt(Math.max(...arr), '+01:00'),
    };
  };
  const naive = describe(F.map((list) => [...list].sort((a, b) => a.price - b.price)[0]));
  let bestSpread = null;
  let combos = 0;
  const walk = (i, acc) => {
    if (i === F.length) {
      combos += 1;
      const d = describe(acc);
      if (!bestSpread || d.arrivalSpreadMinutes < bestSpread.arrivalSpreadMinutes || (d.arrivalSpreadMinutes === bestSpread.arrivalSpreadMinutes && d.totalCost.amountMinor < bestSpread.totalCost.amountMinor)) bestSpread = d;
      return;
    }
    for (const f of F[i]) walk(i + 1, [...acc, f]);
  };
  walk(0, []);
  const refundableOnly = describe(F.map((list) => list.filter((f) => f.refundable).sort((a, b) => a.price - b.price)[0]));
  assert(combos === 4096, 'expected 4^6 combos');
  assert(bestSpread.arrivalSpreadMinutes < naive.arrivalSpreadMinutes, 'best spread must beat naive');
  const minPrice = Object.fromEntries(F.map((list) => [list[0].memberId, Math.min(...list.map((f) => f.price))]));

  const mockHints = {
    off_fl_sam_d: { expiresInMinutes: 3, note: 'expires before the group could approve: createOrder ⇒ offer_expired' },
    off_fl_maya_c: { priceOnRecheck: eur(46900), note: 'getOffer re-price returns price_changed (+€24)' },
  };
  for (const o of offers) {
    mockHints[o.offerId] = { expiresInMinutes: 30, pnrPrefix: o.owner.iataCode, ...(mockHints[o.offerId] ?? {}) };
  }

  return {
    fixtureVersion: 1,
    destination: 'BCN',
    currency: 'EUR',
    provider: 'mock-flights',
    searchedAt,
    note: 'Open-jaw offers: slice 0 = origin → BCN (arrive Thu 2026-03-12), slice 1 = BCN → returnTo (Tue 2026-03-17). Priced in EUR (provider account currency) so proposals pass SAFETY D6. Each member pays their own fare (paidBy per_person_cards).',
    members: [
      { memberId: BCN.dean, origin: 'BOS', returnTo: 'JFK' },
      { memberId: BCN.henry, origin: 'ORD', returnTo: 'ORD' },
      { memberId: BCN.maya, origin: 'SFO', returnTo: 'LAX' },
      { memberId: BCN.jordan, origin: 'ATL', returnTo: 'ATL' },
      { memberId: BCN.priya, origin: 'IAD', returnTo: 'IAD' },
      { memberId: BCN.sam, origin: 'MIA', returnTo: 'AUS' },
    ],
    offers,
    mockHints,
    groundTruth: {
      combinations: combos,
      naiveCheapestPerPerson: naive,
      minArrivalSpread: bestSpread,
      cheapestAllRefundable: refundableOnly,
      minPricePerMember: Object.fromEntries(Object.entries(minPrice).map(([k, v]) => [k, eur(v)])),
      expectations: [
        'optimizer top pick has arrivalSpreadMinutes < naiveCheapestPerPerson.arrivalSpreadMinutes',
        'refundableOnly: true ⇒ every pick is refundable (one refundable offer exists per member); cheapest such set is cheapestAllRefundable',
        `perPersonCap €400 ⇒ no offer under the cap for ${Object.entries(minPrice).filter(([, v]) => v > 40000).map(([k]) => k).join(', ')}: the optimizer must relax perPersonCap with a reason (RelaxedConstraint) rather than return nothing`,
        'with off_fl_sam_d expired (clock past searchedAt + 3 min) the optimizer must not rely on it at order time',
        'BOS 7:10am → DUB → BCN 10:25pm (off_fl_dean_d) is the cheapest for Dean but lands ~15h after everyone else',
        "maya said no 6am flights: off_fl_maya_b departs SFO 6:00am (group memory gm_bcn_3); a ranked option containing it should say so or avoid it",
      ],
    },
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

