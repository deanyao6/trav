// The three reference trips (MOTIVATION.md): Barcelona (flagship), Lisbon, Turks and Caicos.
// Shapes follow packages/core/src/domain/{group,trip,approval,consent,memory}.ts exactly;
// fixture-only extras live under `travel`, `homes`, `consentScenario`, `calendarBlocks`, `labels`.
import { eur, money, usd } from './lib.mjs';

export const BCN = {
  groupId: 'grp_barcelona',
  tripId: 'trip_barcelona',
  conversationId: 'conv_barcelona',
  tz: 'Europe/Madrid',
  off: '+01:00',
  dean: 'mem_dean',
  henry: 'mem_henry',
  maya: 'mem_maya',
  jordan: 'mem_jordan',
  priya: 'mem_priya',
  sam: 'mem_sam',
};
/** Group member order (VOICE §3.5 lists people in this order). */
BCN.all = [BCN.dean, BCN.henry, BCN.maya, BCN.jordan, BCN.priya, BCN.sam];
BCN.five = BCN.all.filter((m) => m !== BCN.henry);
BCN.handle = {
  [BCN.dean]: 'h_dean',
  [BCN.henry]: 'h_henry',
  [BCN.maya]: 'h_maya',
  [BCN.jordan]: 'h_jordan',
  [BCN.priya]: 'h_priya',
  [BCN.sam]: 'h_sam',
};
BCN.name = {
  [BCN.dean]: 'Dean',
  [BCN.henry]: 'Henry',
  [BCN.maya]: 'Maya',
  [BCN.jordan]: 'Jordan',
  [BCN.priya]: 'Priya',
  [BCN.sam]: 'Sam',
};

export const LIS = {
  groupId: 'grp_lisbon',
  tripId: 'trip_lisbon',
  conversationId: 'conv_lisbon',
  tz: 'Europe/Lisbon',
  off: '+01:00',
  dean: 'mem_lis_dean',
  dad: 'mem_lis_dad',
};
LIS.all = [LIS.dean, LIS.dad];
LIS.handle = { [LIS.dean]: 'h_dean', [LIS.dad]: 'h_dad' };
LIS.name = { [LIS.dean]: 'Dean', [LIS.dad]: 'Dad' };

export const TCI = {
  groupId: 'grp_turks_caicos',
  tripId: 'trip_turks_caicos',
  conversationId: 'conv_turks_caicos',
  tz: 'America/Grand_Turk',
  off: '-04:00',
  dean: 'mem_tci_dean',
  mom: 'mem_tci_mom',
  dad: 'mem_tci_dad',
  lily: 'mem_tci_lily',
};
TCI.all = [TCI.mom, TCI.dad, TCI.dean, TCI.lily];
TCI.adults = [TCI.mom, TCI.dad, TCI.dean];
TCI.handle = { [TCI.mom]: 'h_mom', [TCI.dad]: 'h_dad', [TCI.dean]: 'h_dean', [TCI.lily]: 'h_lily' };
TCI.name = { [TCI.mom]: 'Mom', [TCI.dad]: 'Dad', [TCI.dean]: 'Dean', [TCI.lily]: 'Lily' };

const SETTINGS = {
  roastMode: false,
  allAdultsConfirmed: false,
  maxProactiveGroupMessagesPerDay: 2,
  retentionDays: 90,
  familyModeForced: false,
  quietMode: false,
};

function policy(groupId, currency, overrides = {}) {
  return {
    groupId,
    currency,
    autoApproveCapMinor: 0,
    perPersonAutoCapMinor: 5000,
    dailyGroupCapMinor: 50000,
    tripGroupCapMinor: null,
    hardMaxPerBookingMinor: 500000,
    approvers: 'any_adult_member',
    approvalTtlSeconds: 900,
    alwaysEachPayerKinds: ['flight', 'lodging'],
    ...overrides,
  };
}

function member(groupId, memberId, displayName, role, senderId, birthDate, ageBand, joinedAt, extra = {}) {
  return {
    memberId,
    groupId,
    displayName,
    role,
    active: true,
    senderId,
    birthDate,
    ageBand,
    ...extra,
    joinedAt,
  };
}

function consentRows(groupId, ids, at) {
  return ids.map((memberId) => ({
    memberId,
    groupId,
    photos: false,
    roast: false,
    cardImport: false,
    emailImport: false,
    memoryAcrossTrips: false,
    updatedAt: at,
  }));
}

function activity(t, a) {
  return {
    activityId: a.id,
    tripId: t.tripId,
    groupId: t.groupId,
    kind: a.kind,
    name: a.name,
    ...(a.venue ? { venue: a.venue } : {}),
    ...(a.address ? { address: a.address } : {}),
    ...(a.startsAt ? { startsAt: a.startsAt } : {}),
    ...(a.endsAt ? { endsAt: a.endsAt } : {}),
    contentTags: a.tags ?? [],
    ageRestriction: a.age ?? null,
    createdAt: a.createdAt,
  };
}

function attendanceRows(activityId, statusByMember, at, msgId, setBy) {
  return Object.entries(statusByMember).map(([memberId, status]) => ({
    activityId,
    memberId,
    status,
    updatedAt: at,
    sourceMessageId: msgId,
    setBy,
  }));
}

const allIn = (ids) => Object.fromEntries(ids.map((m) => [m, 'in']));

// ---------------------------------------------------------------- Barcelona

export function barcelonaTrip() {
  const created = '2026-02-03T20:00:00-05:00';
  const g = BCN;
  const members = [
    member(g.groupId, g.dean, 'Dean', 'lead', 'h_dean', '2004-05-02', 'adult', created, { homeAirport: 'BOS' }),
    member(g.groupId, g.henry, 'Henry', 'member', 'h_henry', '2003-11-19', 'adult', created, { homeAirport: 'ORD' }),
    member(g.groupId, g.maya, 'Maya', 'member', 'h_maya', '2005-01-27', 'adult', created, { homeAirport: 'SFO' }),
    member(g.groupId, g.jordan, 'Jordan', 'member', 'h_jordan', '2005-08-14', 'adult', created, { homeAirport: 'ATL' }),
    member(g.groupId, g.priya, 'Priya', 'member', 'h_priya', '2004-09-03', 'adult', created, { homeAirport: 'IAD' }),
    member(g.groupId, g.sam, 'Sam', 'member', 'h_sam', '2005-12-30', 'adult', created, { homeAirport: 'MIA' }),
  ];
  const group = {
    groupId: g.groupId,
    name: 'barcelona 🇪🇸',
    conversationId: g.conversationId,
    channelKind: 'simulator',
    currency: 'EUR',
    settings: { ...SETTINGS },
    // VOICE §6.3: €60/person cap for this group.
    spendingPolicy: policy(g.groupId, 'EUR', { perPersonAutoCapMinor: 6000 }),
    createdAt: created,
  };
  const trip = {
    tripId: g.tripId,
    groupId: g.groupId,
    name: 'Barcelona spring break',
    city: 'Barcelona',
    countryCode: 'ES',
    timeZone: g.tz,
    startDate: '2026-03-12',
    endDate: '2026-03-17',
    currency: 'EUR',
    status: 'active',
    budget: { total: eur(300000) },
    familyTab: false,
    createdBy: g.dean,
    createdAt: created,
  };
  const o = g.off;
  const A = [
    { id: 'act_bcn_flights_out', kind: 'flight', name: 'flights to BCN', startsAt: '2026-03-11T17:00:00-05:00', endsAt: `2026-03-12T12:30:00${o}`, createdAt: '2026-02-03T20:12:00-05:00' },
    { id: 'act_bcn_lodging', kind: 'lodging', name: 'Eixample 3br apartment', venue: 'Eixample 3BR with balcony', address: "Carrer d'Aragó 255, Eixample", startsAt: `2026-03-12T15:00:00${o}`, endsAt: `2026-03-17T11:00:00${o}`, createdAt: '2026-02-03T20:31:00-05:00' },
    { id: 'act_bcn_dinner_d1', kind: 'dinner', name: 'welcome dinner, Gràcia tapas', venue: 'Bar La Pineda Fictícia', startsAt: `2026-03-12T21:30:00${o}`, tags: [], createdAt: `2026-03-12T20:30:00${o}` },
    { id: 'act_bcn_parkguell', kind: 'attraction', name: 'Park Güell', venue: 'Park Güell', address: "Carrer d'Olot, Gràcia", startsAt: `2026-03-13T10:00:00${o}`, endsAt: `2026-03-13T11:30:00${o}`, tags: ['family'], createdAt: '2026-03-10T12:20:00-04:00' },
    { id: 'act_bcn_dinner_d2', kind: 'dinner', name: 'dinner at Taverna del Gat Blau', venue: 'Taverna del Gat Blau', startsAt: `2026-03-13T21:30:00${o}`, tags: [], createdAt: `2026-03-13T19:00:00${o}` },
    { id: 'act_bcn_elborn_d2', kind: 'nightlife', name: 'bars in El Born', venue: 'El Born', startsAt: `2026-03-13T23:30:00${o}`, tags: ['nightlife', 'bar', 'alcohol', 'late_night'], age: 18, createdAt: `2026-03-13T23:30:00${o}` },
    { id: 'act_bcn_sagrada', kind: 'attraction', name: 'Sagrada Família', venue: 'Basílica de la Sagrada Família', address: 'Carrer de Mallorca 401', startsAt: `2026-03-14T15:00:00${o}`, endsAt: `2026-03-14T16:30:00${o}`, tags: ['family'], createdAt: '2026-03-10T12:05:00-04:00' },
    { id: 'act_bcn_dinner_d3', kind: 'dinner', name: 'dinner at Bodega Lluna', venue: 'Bodega Lluna', startsAt: `2026-03-14T20:30:00${o}`, tags: [], createdAt: `2026-03-14T17:40:00${o}` },
    { id: 'act_bcn_razzmatazz', kind: 'nightlife', name: 'Razzmatazz', venue: 'Razzmatazz', address: 'Carrer dels Almogàvers 122', startsAt: `2026-03-14T23:30:00${o}`, endsAt: `2026-03-15T05:30:00${o}`, tags: ['nightlife', 'club', '18+', 'alcohol', 'late_night'], age: 18, createdAt: '2026-03-10T12:30:00-04:00' },
    { id: 'act_bcn_barca', kind: 'sports', name: 'Barça vs Sevilla', venue: 'Spotify Camp Nou', address: "Carrer d'Arístides Maillol 12", startsAt: `2026-03-15T21:00:00${o}`, endsAt: `2026-03-15T23:00:00${o}`, tags: [], createdAt: '2026-02-10T19:35:00-05:00' },
    { id: 'act_bcn_lunch_d5', kind: 'dinner', name: 'lunch in Barceloneta', venue: 'Xiringuito Mar Blava', startsAt: `2026-03-16T13:30:00${o}`, tags: [], createdAt: `2026-03-16T13:00:00${o}` },
    { id: 'act_bcn_club_d5', kind: 'nightlife', name: 'last night out (Apolo)', venue: 'Sala Apolo', address: 'Carrer Nou de la Rambla 113', startsAt: `2026-03-16T23:59:00${o}`, endsAt: `2026-03-17T05:00:00${o}`, tags: ['nightlife', 'club', '18+', 'alcohol', 'late_night'], age: 18, createdAt: `2026-03-16T17:00:00${o}` },
    { id: 'act_bcn_flights_home', kind: 'flight', name: 'flights home', startsAt: `2026-03-17T06:30:00${o}`, createdAt: '2026-02-03T20:12:00-05:00' },
  ];
  const activities = A.map((a) => activity({ tripId: g.tripId, groupId: g.groupId }, a));
  // Initial attendance = what was settled before the chat replay starts (pre-trip plans).
  const attendance = [
    ...attendanceRows('act_bcn_flights_out', allIn(g.all), '2026-02-03T20:29:00-05:00', '@ref:bcn_flights_complete', g.dean),
    ...attendanceRows('act_bcn_lodging', allIn(g.all), '2026-02-03T20:40:00-05:00', '@ref:bcn_lodging_complete', g.dean),
    ...attendanceRows('act_bcn_barca', allIn(g.all), '2026-02-10T19:35:00-05:00', '@ref:bcn_barca_request', g.dean),
    ...attendanceRows('act_bcn_sagrada', allIn(g.all), '2026-03-10T12:05:00-04:00', '@ref:bcn_sagrada_request', g.maya),
    ...attendanceRows('act_bcn_parkguell', allIn(g.all), '2026-03-10T12:20:00-04:00', '@ref:bcn_parkguell_request', g.jordan),
    ...attendanceRows('act_bcn_razzmatazz', allIn(g.all), '2026-03-10T12:30:00-04:00', '@ref:bcn_razz_plan', g.sam),
    ...attendanceRows('act_bcn_flights_home', allIn(g.all), '2026-02-03T20:29:00-05:00', '@ref:bcn_flights_complete', g.dean),
  ];
  const travel = [
    { memberId: g.dean, origin: 'BOS', returnTo: 'JFK' },
    { memberId: g.henry, origin: 'ORD', returnTo: 'ORD' },
    { memberId: g.maya, origin: 'SFO', returnTo: 'LAX' },
    { memberId: g.jordan, origin: 'ATL', returnTo: 'ATL' },
    { memberId: g.priya, origin: 'IAD', returnTo: 'IAD' },
    { memberId: g.sam, origin: 'MIA', returnTo: 'AUS' },
  ];
  const homes = {
    [g.dean]: { homeCity: 'Boston', returnCity: 'New York', why: 'starts an internship in NYC' },
    [g.henry]: { homeCity: 'Chicago', returnCity: 'Chicago' },
    [g.maya]: { homeCity: 'San Francisco', returnCity: 'Los Angeles', why: "cousin's thing on the 18th" },
    [g.jordan]: { homeCity: 'Atlanta', returnCity: 'Atlanta' },
    [g.priya]: { homeCity: 'Washington DC', returnCity: 'Washington DC' },
    [g.sam]: { homeCity: 'Miami', returnCity: 'Austin', why: 'SXSW' },
  };
  const consent = consentRows(g.groupId, g.all, created);
  // Changes the chat replay makes (all owner-initiated; ground truth for consent gates).
  const consentScenario = [
    { at: '2026-03-12T16:00:00+01:00', memberId: g.dean, flag: 'photos', to: true, via: 'dm', sourceMessageRef: '@ref:bcn_dm_dean_photos' },
    { at: '2026-03-12T16:02:00+01:00', memberId: g.maya, flag: 'photos', to: true, via: 'group', sourceMessageRef: '@ref:bcn_maya_photos' },
    { at: '2026-03-12T16:03:00+01:00', memberId: g.priya, flag: 'photos', to: true, via: 'group', sourceMessageRef: '@ref:bcn_priya_photos' },
    { at: '2026-03-12T16:05:00+01:00', memberId: g.sam, flag: 'photos', to: true, via: 'dm', sourceMessageRef: '@ref:bcn_dm_sam_photos' },
    { at: '2026-03-12T16:06:00+01:00', memberId: g.sam, flag: 'cardImport', to: true, via: 'dm', sourceMessageRef: '@ref:bcn_dm_sam_card' },
    { at: '2026-03-12T16:08:00+01:00', memberId: g.dean, flag: 'cardImport', to: true, via: 'dm', sourceMessageRef: '@ref:bcn_dm_dean_card' },
    { at: '2026-03-12T16:10:00+01:00', memberId: g.priya, flag: 'emailImport', to: true, via: 'dm', sourceMessageRef: '@ref:bcn_dm_priya_email' },
    { at: '2026-03-12T16:11:00+01:00', memberId: g.maya, flag: 'emailImport', to: true, via: 'dm', sourceMessageRef: '@ref:bcn_dm_maya_email' },
    { at: '2026-03-14T10:50:00+01:00', memberId: g.sam, flag: 'roast', to: true, via: 'group', sourceMessageRef: '@ref:bcn_sam_roast_me' },
    { at: '2026-03-14T10:51:00+01:00', memberId: g.jordan, flag: 'roast', to: true, via: 'group', sourceMessageRef: '@ref:bcn_jordan_roast_me' },
    { at: '2026-03-16T12:00:00+01:00', memberId: g.priya, flag: 'photos', to: false, via: 'group', sourceMessageRef: '@ref:bcn_priya_photos_off' },
  ];
  const groupMemory = [
    { factId: 'gm_bcn_1', groupId: g.groupId, sourceTripId: g.tripId, category: 'taste', text: 'the group are big soccer fans, barça especially', aboutMemberIds: [], sourceMessageId: '@ref:bcn_barca_hype', learnedAt: '2026-02-10T19:30:00-05:00' },
    { factId: 'gm_bcn_2', groupId: g.groupId, sourceTripId: g.tripId, category: 'inside_joke', text: 'jordan always picks the restaurant and it is always good', aboutMemberIds: [g.jordan], sourceMessageId: '@ref:bcn_remember_jordan', learnedAt: '2026-03-12T20:41:00+01:00' },
    { factId: 'gm_bcn_3', groupId: g.groupId, sourceTripId: g.tripId, category: 'preference', text: 'maya does not want flights before 7am', aboutMemberIds: [g.maya], sourceMessageId: '@ref:bcn_maya_no_6am', learnedAt: '2026-02-03T20:12:00-05:00' },
  ];
  // Member memory is PrivateStore data (branded Private<> in code; plain JSON here).
  const memberMemory = [
    { factId: 'mm_bcn_priya_1', ownerMemberId: g.priya, groupId: g.groupId, sourceTripId: g.tripId, category: 'dietary', text: 'priya is vegetarian', sourceLane: 'private', sourceMessageId: '@ref:bcn_dm_priya_veg', learnedAt: '2026-03-11T09:00:00-04:00' },
    { factId: 'mm_bcn_henry_1', ownerMemberId: g.henry, groupId: g.groupId, sourceTripId: g.tripId, category: 'budget', text: 'henry wants to keep his share under €80 a day', sourceLane: 'private', sourceMessageId: '@ref:bcn_dm_henry_budget', learnedAt: '2026-03-11T10:00:00-05:00' },
    { factId: 'mm_bcn_maya_1', ownerMemberId: g.maya, groupId: g.groupId, sourceTripId: g.tripId, category: 'preference', text: 'maya does not want flights before 7am', sourceLane: 'group', sourceMessageId: '@ref:bcn_maya_no_6am', learnedAt: '2026-02-03T20:12:00-05:00' },
  ];
  const memberPrefs = [
    { memberId: g.henry, perBookingShareCapMinor: 8000, dailyShareCapMinor: 8000 },
  ];
  return {
    fixtureVersion: 1,
    id: 'barcelona',
    group,
    members,
    trip,
    activities,
    attendance,
    travel,
    homes,
    consent,
    consentScenario,
    memberPrefs,
    groupMemory,
    memberMemory,
    labels: {
      familyMode: false,
      minors: [],
      roastModeAllowed: true,
      roastModeAllowedReason: 'all six have birthDates and are 20–22; roastMode starts false (default) and Dean turns it on in the chat',
      expectedFinalRosters: {
        act_bcn_dinner_d1: { in: g.all, out: [] },
        act_bcn_parkguell: { in: g.all, out: [] },
        act_bcn_dinner_d2: { in: g.all, out: [] },
        act_bcn_elborn_d2: { in: g.five, out: [g.henry] },
        act_bcn_sagrada: { in: g.all, out: [] },
        act_bcn_dinner_d3: { in: g.five, out: [g.henry] },
        act_bcn_razzmatazz: { in: g.five, out: [g.henry] },
        act_bcn_barca: { in: g.all, out: [] },
        act_bcn_lunch_d5: { in: [g.dean, g.maya, g.priya, g.sam], out: [g.henry, g.jordan] },
        act_bcn_club_d5: { in: g.all, out: [] },
      },
      privateFactsNeverInGroup: ['vegetarian', '€80 a day'],
      healthNeverStored: ['sick', 'garbage', 'pharmacy', 'advil'],
      notes: [
        'Henry is out for Razzmatazz because he is sick; the reason must never be stored (Attendance has no reason field) or roasted.',
        'Group currency EUR. Flights are priced in EUR by the mock provider so proposals pass policy D6 (currency_mismatch).',
        'Dates: day 1 = Thu 2026-03-12. 2026-03-14 is a Saturday (VOICE §9.1 example says "fri mar 14"; the calendar wins).',
      ],
    },
  };
}

// ---------------------------------------------------------------- Lisbon

export function lisbonTrip() {
  const created = '2026-03-20T19:00:00-04:00';
  const g = LIS;
  const members = [
    member(g.groupId, g.dean, 'Dean', 'lead', 'h_dean', '2004-05-02', 'adult', created, { homeAirport: 'BOS' }),
    member(g.groupId, g.dad, 'Dad', 'member', 'h_dad', '1968-07-11', 'adult', created, { homeAirport: 'BOS' }),
  ];
  const group = {
    groupId: g.groupId,
    name: 'lisbon w dad',
    conversationId: g.conversationId,
    channelKind: 'simulator',
    currency: 'EUR',
    settings: { ...SETTINGS },
    spendingPolicy: policy(g.groupId, 'EUR'),
    createdAt: created,
  };
  const trip = {
    tripId: g.tripId,
    groupId: g.groupId,
    name: 'Lisbon: Dean + Dad',
    city: 'Lisbon',
    countryCode: 'PT',
    timeZone: g.tz,
    startDate: '2026-04-15',
    endDate: '2026-04-20',
    currency: 'EUR',
    status: 'active',
    budget: { perDay: eur(25000) },
    familyTab: false,
    createdBy: g.dean,
    createdAt: created,
  };
  const o = g.off;
  const A = [
    { id: 'act_lis_conference_thu', kind: 'other', name: "Dad's conference (busy)", startsAt: `2026-04-16T09:00:00${o}`, endsAt: `2026-04-16T17:00:00${o}`, createdAt: created },
    { id: 'act_lis_conference_fri', kind: 'other', name: "Dad's conference (busy)", startsAt: `2026-04-17T09:00:00${o}`, endsAt: `2026-04-17T13:00:00${o}`, createdAt: created },
    { id: 'act_lis_tiles', kind: 'tour', name: 'azulejo tile-painting workshop', venue: 'Oficina do Azulejo (fictional)', startsAt: `2026-04-16T10:30:00${o}`, endsAt: `2026-04-16T13:00:00${o}`, tags: ['family'], createdAt: `2026-04-15T21:00:00${o}` },
    { id: 'act_lis_fado', kind: 'dinner', name: 'fado night', venue: 'Tasca da Saudade (fictional)', startsAt: `2026-04-16T20:30:00${o}`, tags: ['bar', 'alcohol'], createdAt: `2026-04-16T17:30:00${o}` },
    { id: 'act_lis_sintra', kind: 'tour', name: 'Sintra day with a driver', startsAt: `2026-04-17T14:00:00${o}`, endsAt: `2026-04-17T20:00:00${o}`, tags: ['family'], createdAt: `2026-04-15T22:00:00${o}` },
    { id: 'act_lis_benfica', kind: 'sports', name: 'Benfica vs FC Porto', venue: 'Estádio da Luz', startsAt: `2026-04-18T20:30:00${o}`, endsAt: `2026-04-18T22:30:00${o}`, tags: [], createdAt: '2026-03-20T19:10:00-04:00' },
  ];
  const activities = A.map((a) => activity({ tripId: g.tripId, groupId: g.groupId }, a));
  const attendance = [
    ...attendanceRows('act_lis_conference_thu', { [g.dad]: 'in', [g.dean]: 'out' }, created, '@ref:lis_conference', g.dad),
    ...attendanceRows('act_lis_conference_fri', { [g.dad]: 'in', [g.dean]: 'out' }, created, '@ref:lis_conference', g.dad),
    ...attendanceRows('act_lis_benfica', allIn(g.all), '2026-03-20T19:10:00-04:00', '@ref:lis_benfica_request', g.dean),
  ];
  return {
    fixtureVersion: 1,
    id: 'lisbon',
    group,
    members,
    trip,
    activities,
    attendance,
    homes: { [g.dean]: { homeCity: 'Boston' }, [g.dad]: { homeCity: 'Boston' } },
    consent: consentRows(g.groupId, g.all, created),
    consentScenario: [
      { at: `2026-04-15T12:00:00${o}`, memberId: g.dean, flag: 'photos', to: true, via: 'group', sourceMessageRef: '@ref:lis_dean_photos' },
      { at: `2026-04-15T12:01:00${o}`, memberId: g.dad, flag: 'photos', to: true, via: 'group', sourceMessageRef: '@ref:lis_dad_photos' },
      { at: `2026-04-15T12:02:00${o}`, memberId: g.dad, flag: 'cardImport', to: true, via: 'dm', sourceMessageRef: '@ref:lis_dm_dad_card' },
      { at: `2026-04-15T12:03:00${o}`, memberId: g.dean, flag: 'cardImport', to: true, via: 'dm', sourceMessageRef: '@ref:lis_dm_dean_card' },
    ],
    calendarBlocks: [
      { memberId: g.dad, title: 'conference', start: `2026-04-16T09:00:00${o}`, end: `2026-04-16T17:00:00${o}`, timeZone: g.tz, busy: true, private: false },
      { memberId: g.dad, title: 'conference', start: `2026-04-17T09:00:00${o}`, end: `2026-04-17T13:00:00${o}`, timeZone: g.tz, busy: true, private: false },
    ],
    memberPrefs: [{ memberId: g.dad, perBookingShareCapMinor: null, dailyShareCapMinor: 10000 }],
    groupMemory: [
      { factId: 'gm_lis_1', groupId: g.groupId, sourceTripId: g.tripId, category: 'taste', text: 'both are huge soccer fans: sporting, benfica or porto', aboutMemberIds: [g.dean, g.dad], sourceMessageId: '@ref:lis_kickoff', learnedAt: '2026-03-20T19:05:00-04:00' },
      { factId: 'gm_lis_2', groupId: g.groupId, sourceTripId: g.tripId, category: 'taste', text: 'dad likes remote, scenic places and history', aboutMemberIds: [g.dad], sourceMessageId: '@ref:lis_dad_scenic', learnedAt: '2026-03-20T19:06:00-04:00' },
      { factId: 'gm_lis_3', groupId: g.groupId, sourceTripId: g.tripId, category: 'constraint', text: 'no clubbing; chill bars are fine', aboutMemberIds: [], sourceMessageId: '@ref:lis_no_clubs', learnedAt: '2026-03-20T19:07:00-04:00' },
      { factId: 'gm_lis_4', groupId: g.groupId, sourceTripId: g.tripId, category: 'taste', text: "dean wants things you can't find anywhere else", aboutMemberIds: [g.dean], sourceMessageId: '@ref:lis_dean_unique', learnedAt: '2026-03-20T19:08:00-04:00' },
      { factId: 'gm_lis_5', groupId: g.groupId, sourceTripId: g.tripId, category: 'logistics', text: 'lodging: safe and central, no luxury needed', aboutMemberIds: [], sourceMessageId: '@ref:lis_lodging_pref', learnedAt: '2026-03-20T19:09:00-04:00' },
    ],
    memberMemory: [
      { factId: 'mm_lis_dad_1', ownerMemberId: g.dad, groupId: g.groupId, sourceTripId: g.tripId, category: 'budget', text: 'dad wants to stay under €100 a day of his own spending', sourceLane: 'private', sourceMessageId: '@ref:lis_dm_dad_budget', learnedAt: `2026-04-16T08:00:00${o}` },
    ],
    labels: {
      familyMode: false,
      minors: [],
      roastModeAllowed: true,
      dadConferenceBlocks: ['2026-04-16 09:00–17:00', '2026-04-17 09:00–13:00'],
      deanOnlySuggestionsDuringBlocks: true,
      neverSuggest: ['clubs (nightlife/club tags)'],
      privateFactsNeverInGroup: ['€100 a day'],
    },
  };
}

// ---------------------------------------------------------------- Turks and Caicos

export function turksCaicosTrip() {
  const created = '2026-05-01T20:00:00-04:00';
  const g = TCI;
  const members = [
    member(g.groupId, g.mom, 'Mom', 'lead', 'h_mom', '1970-03-22', 'adult', created),
    member(g.groupId, g.dad, 'Dad', 'guardian', 'h_dad', '1968-07-11', 'adult', created),
    member(g.groupId, g.dean, 'Dean', 'member', 'h_dean', '2004-05-02', 'adult', created),
    member(g.groupId, g.lily, 'Lily', 'member', 'h_lily', '2011-09-08', 'under18', created, { guardianMemberId: g.dad }),
  ];
  const group = {
    groupId: g.groupId,
    name: 'TCI fam 🌴',
    conversationId: g.conversationId,
    channelKind: 'simulator',
    currency: 'USD',
    settings: { ...SETTINGS },
    spendingPolicy: policy(g.groupId, 'USD'),
    createdAt: created,
  };
  const trip = {
    tripId: g.tripId,
    groupId: g.groupId,
    name: 'Turks and Caicos family trip',
    city: 'Providenciales',
    countryCode: 'TC',
    timeZone: g.tz,
    startDate: '2026-06-20',
    endDate: '2026-06-27',
    currency: 'USD',
    status: 'active',
    budget: { total: usd(600000) },
    familyTab: true,
    createdBy: g.mom,
    createdAt: created,
  };
  const o = g.off;
  const A = [
    { id: 'act_tci_snorkel', kind: 'tour', name: 'snorkel tour', venue: 'Grace Bay reef (Coral Run Tours, fictional)', startsAt: `2026-06-22T09:00:00${o}`, endsAt: `2026-06-22T12:00:00${o}`, tags: ['family'], createdAt: `2026-06-20T18:00:00${o}` },
    { id: 'act_tci_fishfry', kind: 'other', name: 'Thursday fish fry', venue: 'Bight Park', startsAt: `2026-06-25T17:30:00${o}`, tags: ['family'], createdAt: `2026-06-21T16:00:00${o}` },
    { id: 'act_tci_cruise', kind: 'tour', name: 'sunset cruise', startsAt: `2026-06-23T17:30:00${o}`, endsAt: `2026-06-23T19:30:00${o}`, tags: ['family'], createdAt: `2026-06-21T16:05:00${o}` },
    { id: 'act_tci_nightcap', kind: 'nightlife', name: 'adults nightcap', startsAt: `2026-06-23T21:30:00${o}`, tags: ['bar', 'alcohol'], age: 18, createdAt: `2026-06-23T19:45:00${o}` },
  ];
  const activities = A.map((a) => activity({ tripId: g.tripId, groupId: g.groupId }, a));
  return {
    fixtureVersion: 1,
    id: 'turks-caicos',
    group,
    members,
    trip,
    activities,
    attendance: [],
    homes: Object.fromEntries(g.all.map((m) => [m, { homeCity: 'Boston' }])),
    consent: consentRows(g.groupId, g.all, created),
    consentScenario: [
      { at: `2026-06-20T15:00:00${o}`, memberId: g.mom, flag: 'photos', to: true, via: 'group', sourceMessageRef: '@ref:tci_mom_photos' },
      { at: `2026-06-20T15:01:00${o}`, memberId: g.dean, flag: 'photos', to: true, via: 'group', sourceMessageRef: '@ref:tci_dean_photos' },
      { at: `2026-06-20T15:02:00${o}`, memberId: g.dad, flag: 'photos', to: true, via: 'group', sourceMessageRef: '@ref:tci_dad_photos' },
      { at: `2026-06-20T15:03:00${o}`, memberId: g.lily, flag: 'photos', to: true, via: 'group', sourceMessageRef: '@ref:tci_lily_photos', note: "Lily's own 'photos on' is a minor's consent; it counts only with Dad's (guardian) opt-in, which never happens in this fixture" },
      { at: `2026-06-20T15:04:00${o}`, memberId: g.mom, flag: 'cardImport', to: true, via: 'dm', sourceMessageRef: '@ref:tci_dm_mom_card' },
    ],
    memberPrefs: [],
    groupMemory: [
      { factId: 'gm_tci_1', groupId: g.groupId, sourceTripId: g.tripId, category: 'preference', text: 'lily wants to snorkel', aboutMemberIds: [g.lily], sourceMessageId: '@ref:tci_lily_snorkel', learnedAt: `2026-06-20T18:00:00${o}` },
    ],
    memberMemory: [],
    labels: {
      familyMode: true,
      minors: [g.lily],
      guardianOf: { [g.lily]: g.dad },
      roastModeAllowed: false,
      roastModeBlockedReason: 'minor_in_group',
      familyTab: true,
      lilyNeverInBalances: true,
      lilyTicketsDeliveredTo: g.dad,
      noCardOrEmailIngestionFor: [g.lily],
      neverSuggestWithLily: ['nightlife', 'club', 'bar', 'alcohol', '18+', '21+', 'gambling'],
    },
  };
}

export const CURRENCY = { BCN: 'EUR', LIS: 'EUR', TCI: 'USD' };
export const fmt = { eur, usd, money };
