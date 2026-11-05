import { describe, expect, it } from 'vitest';
import { loadAllTicketInventories } from '@trav/adapters';
import {
  foldText,
  parseBookingRequest,
  parseDayWord,
  parseVenueQuestion,
  resolveNight,
  splitSender,
  venueIndexFrom,
} from './request.js';

const INDEX = venueIndexFrom(loadAllTicketInventories());
const parse = (text: string, sender = 'Dean') => parseBookingRequest(text, INDEX, sender);

describe('venueIndexFrom (T-081)', () => {
  it('terms come from names and keywords; shared and category words are generic; cities never name a venue', () => {
    const razz = INDEX.venues.find((v) => v.key === 'razzmatazz')!;
    expect(razz.terms).toEqual(expect.arrayContaining(['razzmatazz', 'razz', 'club']));
    expect(razz.tierWords).toEqual(expect.arrayContaining(['vip', 'mezzanine']));
    expect(razz.tierWords).not.toContain('general');
    expect(INDEX.generic.has('club')).toBe(true); // Razzmatazz, Apolo, Cais Club
    expect(INDEX.generic.has('gaudi')).toBe(true); // Sagrada Família and Park Güell
    expect(INDEX.venues.some((v) => v.terms.includes('barcelona'))).toBe(false);
    // "(fictional)" is fixture noise, not a name.
    expect(INDEX.venues.some((v) => v.key.includes('fictional'))).toBe(false);
  });

  it('folds accents', () => {
    expect(foldText('Barça Güell Família')).toBe('barca guell familia');
  });
});

describe('parseBookingRequest: the Barcelona asks', () => {
  it('the flagship: 5, Henry out, and the reason is never part of the result', () => {
    const r = parse("get the 5 of us Razzmatazz tickets, Henry's sick")!;
    expect(r).toMatchObject({ query: 'razzmatazz tickets', quantity: 5, excludedNames: ['Henry'] });
    expect(JSON.stringify(r).replace(r.requestText, '')).not.toMatch(/sick/i);
  });

  it('a flattened line break still finds the capitalized name ("…tickets Henry\'s sick")', () => {
    expect(parse("get the 5 of us Razzmatazz tickets Henry's sick")?.excludedNames).toEqual([
      'Henry',
    ]);
  });

  it('Barça: alias, a calendar date over a weekday, a headcount without "for", the sideline tier, no ruled-out seat', () => {
    const r = parse(
      'barça vs sevilla sunday mar 15, 6 tickets together, sideline not behind the goal',
    )!;
    expect(r.query).toMatch(/barca|sevilla/);
    expect(r.quantity).toBe(6);
    expect(r.day).toBe('03-15');
    expect(r.tier).toEqual(expect.arrayContaining(['lateral']));
    expect(r.tier).not.toContain('gol');
    expect(r.excludedNames).toEqual([]);
  });

  it('Sagrada Família, Park Güell, flamenco: venue, everyone or a count, and the named night', () => {
    expect(parse('can you get sagrada familia tickets for all of us saturday at 3')).toMatchObject({
      query: 'sagrada familia tickets',
      day: 'saturday',
    });
    expect(
      parse('can you get sagrada familia tickets for all of us saturday at 3')?.quantity,
    ).toBeUndefined();
    expect(parse('park güell friday 10am for 6')).toMatchObject({ quantity: 6, day: 'friday' });
    expect(parse('flamenco show friday night for the 6 of us?')).toMatchObject({
      quantity: 6,
      day: 'friday',
    });
  });

  it('Razz VIP: tier words from the tier name, "all 6", tonight', () => {
    const r = parse('book the razz vip mezzanine for all 6 tonight')!;
    expect(r).toMatchObject({ query: 'razz tickets', quantity: 6, day: 'tonight' });
    expect(r.tier).toEqual(expect.arrayContaining(['vip', 'mezzanine']));
  });

  it('a question with a headcount and a night is an ask ("razz closing party tonight, all 6 of us?")', () => {
    expect(parse('razz closing party tonight, all 6 of us?')).toMatchObject({
      quantity: 6,
      day: 'tonight',
    });
  });

  it('a generic word only counts next to "tickets"', () => {
    expect(parse('get us club tickets tonight')).toMatchObject({
      query: 'club tickets',
      day: 'tonight',
    });
    expect(parse('we should go to a club tonight')).toBeUndefined();
  });

  it('"for me" names the sender; "everyone but X" and "X\'s out" exclude by name', () => {
    expect(parse('razzmatazz for me', 'Henry')?.attendeeNames).toEqual(['Henry']);
    expect(parse('get razz tickets for everyone but Henry')?.excludedNames).toEqual(['Henry']);
    expect(parse("grab razz tix for us, maya's out")?.excludedNames).toEqual(['Maya']);
    expect(parse("get razz tickets for 5, i'm out", 'Sam')?.excludedNames).toEqual(['Sam']);
    // A pronoun is never a name.
    expect(parse("get razz tickets for everyone but Henry, he's sick")?.excludedNames).toEqual([
      'Henry',
    ]);
    expect(parse("get razz tickets for 5, she's out")?.excludedNames).toEqual([]);
  });
});

describe('T-081 r1 review repros', () => {
  it('#2 "for me and Maya" and friends name the sender plus those names; a headcount with words between', () => {
    expect(parse('get razz tickets for me and Maya')?.attendeeNames).toEqual(['Dean', 'Maya']);
    expect(parse('get razz tickets for just me and sam')?.attendeeNames).toEqual(['Dean', 'Sam']);
    expect(parse('get razz tickets for me, maya and sam')?.attendeeNames).toEqual([
      'Dean',
      'Maya',
      'Sam',
    ]);
    expect(parse('get me and maya razz tickets')?.attendeeNames).toEqual(['Dean', 'Maya']);
    expect(parse("casino night tonight for me and dad? we're both 21+")).toMatchObject({
      attendeeNames: ['Dean', 'Dad'],
      day: 'tonight',
    });
    expect(parse('snorkel tour for me and Mom', 'Dad')?.attendeeNames).toEqual(['Dad', 'Mom']);
    // A clause after a comma ends the list; a non-name after "and" is not guessed at.
    expect(parse("get razz tickets for me, henry's out")).toMatchObject({
      attendeeNames: ['Dean'],
      excludedNames: ['Henry'],
    });
    expect(parse('get razz tickets for me and the kids')).toBeUndefined();
    expect(parse('get 2 razz tickets')?.quantity).toBe(2);
    expect(parse('book 6 vip mezzanine tix at razz')?.quantity).toBe(6);
    // A date is never a headcount.
    expect(parse('get barça tickets for sunday mar 15')?.quantity).toBeUndefined();
  });

  it.each([
    'how much are razz tickets',
    'should we get razz tickets?',
    "don't get razz tickets",
    'did anyone get razz tickets',
    'who has the razz tickets',
    'razz tickets',
    'is razz any good tonight',
    'hold off on razz tickets for now',
  ])('#3 a question or negation is not an ask: %s', (text) => {
    expect(parse(text)).toBeUndefined();
  });

  it.each([
    ["get the 5 of us razz tickets, don't count henry", 5, ['Henry']],
    ["get the 5 of us razz tickets, henry doesn't want to come", 5, ['Henry']],
    ['get the 5 of us razz tickets, never been', 5, []],
    ['do it, get razz tickets for all of us', undefined, []],
    ['anyone else want in? get razz tickets for all of us', undefined, []],
    ['get razz tickets for all of us, leave henry out', undefined, ['Henry']],
  ] as const)(
    'T-148 #3 a negation or question outside the booking clause is still an ask: %s',
    (text, quantity, excluded) => {
      const r = parse(text);
      expect(r, text).toBeDefined();
      expect(r!.query).toBe('razz tickets');
      expect(r!.quantity).toBe(quantity);
      expect(r!.excludedNames).toEqual(excluded);
    },
  );

  it.each([
    "we don't need razz tickets",
    'no need to book razz',
    'not getting razz tickets tonight',
    "get razz tickets for all of us. actually don't",
    'ok, how much are razz tickets',
    'should we, like, get razz tickets for all of us',
    'do we get razz tickets for all of us?',
  ])('T-148 #3 a negation on the booking verb, a retraction or a question is not: %s', (text) => {
    expect(parse(text)).toBeUndefined();
  });

  it.each([
    "get razz tickets for all of us, but don't buy them yet",
    'get razz tickets for all of us but dont buy them yet',
    'get the 5 of us razz tickets, hold off till henry confirms',
    'get razz tickets for all of us, not yet though',
    'not yet, but get razz tickets for all of us',
    'get razz tickets for 5. no need to rush, wait on maya',
    'get razz tickets for all of us, dont count on it',
    "get razz tickets for all of us, he doesn't want to come",
  ])('T-148 r1 #1 a negation in any clause takes the ask back: %s', (text) => {
    expect(parse(text)).toBeUndefined();
  });

  it.each([
    ["henry doesn't want to come, get the 5 of us razz tickets", ['Henry']],
    ["get razz tickets for all of us, don't include henry or maya", ['Henry', 'Maya']],
    ['get razz tickets for all of us, not counting henry', ['Henry']],
  ] as const)('T-148 r1 #1 a negation that governs a name is an exclusion: %s', (text, out) => {
    expect(parse(text)?.excludedNames).toEqual(out);
  });

  it('T-148 r1 #2 day words and fillers are never names; "me" is the sender', () => {
    expect(parse('get razz tickets for us but not tonight')?.excludedNames).toEqual([]);
    expect(parse('get razz tickets for 5 but not friday')?.excludedNames).toEqual([]);
    expect(parse('get razz tickets for 5 but not fri')?.excludedNames).toEqual([]);
    expect(parse("get razz tickets for 5 but not henry, he's sick")?.excludedNames).toEqual([
      'Henry',
    ]);
    expect(parse('get razz tickets for everyone, dont count me', 'Sam')?.excludedNames).toEqual([
      'Sam',
    ]);
    expect(parse('get razz tickets for everyone, leave me out', 'Sam')?.excludedNames).toEqual([
      'Sam',
    ]);
  });

  it('T-148 r2 #1 "don\'t count X out" is an inclusion, not an exclusion', () => {
    expect(
      parse("get razz tickets for everyone, don't count me out", 'Dean')?.excludedNames,
    ).toEqual([]);
    expect(
      parse('get razz tickets for all of us, dont count henry out', 'Dean')?.excludedNames,
    ).toEqual([]);
  });

  it('T-148 r2 #2 a negation word is never a captured name, so the retraction stays', () => {
    expect(
      parse("get razz tickets for all of us, dont count henry and don't buy yet"),
    ).toBeUndefined();
  });

  it.each([
    "get razz tickets for all of us, we've never been",
    'get razz tickets for all of us, I have never been',
    "get razz tickets for all of us, i don't care which tier",
    'get razz tickets for all of us, dont care about vip',
    "get razz tickets for everyone, it doesn't matter which night",
    'get razz tickets for 5, no need for vip',
    "get razz tickets for all of us asap, don't wait",
    'get razz tickets for all of us, dont wait on henry',
  ])('T-148 r2 #3 a harmless negated phrase keeps the ask: %s', (text) => {
    expect(parse(text, 'Dean')).toBeDefined();
  });

  it('T-148 r2 #4 tier, add-on and day words are never names', () => {
    for (const tail of [
      'but not vip',
      'but not general',
      'dont count yesterday',
      'dont add tax',
      'dont include drinks',
      "don't add extras",
    ]) {
      expect(parse(`get razz tickets for all of us, ${tail}`, 'Dean')?.excludedNames ?? []).toEqual(
        [],
      );
    }
  });

  it('T-148 #6 not/my/our/his/her/their are never names; "but not X" excludes X', () => {
    expect(parse('get razz tickets for us but not henry')?.excludedNames).toEqual(['Henry']);
    expect(parse('get razz tickets for 5 but not henry or maya')?.excludedNames).toEqual([
      'Henry',
      'Maya',
    ]);
    // "my brother" isn't a member name: no guess, so not an ask (like "the kids").
    expect(parse('get razz tickets for me and my brother')).toBeUndefined();
    for (const w of ['not', 'my', 'our', 'his', 'her', 'their']) {
      const r = parse(`get razz tickets for everyone but ${w} henry`);
      expect(r?.excludedNames ?? []).not.toContain(w.charAt(0).toUpperCase() + w.slice(1));
    }
  });

  it('#8 a short two-word name finds its venue ("jet ski")', () => {
    expect(parse('get jet ski tickets for the 2 of us', 'Dad')).toMatchObject({
      query: 'jet ski tickets',
      quantity: 2,
    });
  });

  it('#9 "but" excludes only after a whole-group word', () => {
    expect(parse("get razz tickets, Henry's out but Maya might join")?.excludedNames).toEqual([
      'Henry',
    ]);
    expect(parse('get razz tickets for all of us but Maya')?.excludedNames).toEqual(['Maya']);
  });
});

describe('parseVenueQuestion (T-148 #8)', () => {
  it.each([
    ['how much is the snorkel tour', 'snorkel tickets'],
    ['should we get snorkel tickets for monday?', 'snorkel tickets'],
    ['how much are razz tickets', 'razz tickets'],
    ['is razz any good tonight', 'razz tickets'],
  ])('a price/info question about a named venue: %s', (text, query) => {
    expect(parseVenueQuestion(text, INDEX)?.query).toBe(query);
    expect(parse(text)).toBeUndefined(); // and never an ask
  });

  it.each([
    'who has the razz tickets',
    'did anyone get razz tickets',
    'get razz tickets for all of us',
    'how much did we spend at razz',
    'what should we do tonight',
    'cancel the razz tickets',
  ])('not a venue question: %s', (text) => {
    expect(parseVenueQuestion(text, INDEX)).toBeUndefined();
  });
});

describe('parseBookingRequest: what is not a ticket ask', () => {
  it.each([
    'bought 6 for sat 3pm on the official site, €156. everyone',
    'ok apolo then. got 6 on their site, €90. put it on the tab, all 6',
    'cancel the vip thing, way too much',
    "just book the barça ones now, i'm approving for everyone",
    'who is in for razzmatazz tonight',
    'dinner spot for 6 tonight, nothing touristy',
    'book us a table somewhere nice before the game, 7pm',
    'get barça tickets under €60 each', // a budget it can't honor yet
    'BARCELONA mar 12-17 everyone lock it in',
    '',
  ])('%s', (text) => {
    expect(parse(text)).toBeUndefined();
  });
});

describe('parseBookingRequest: Lisbon and TCI (no keywords in those inventories)', () => {
  it('distinctive name words find the venue', () => {
    expect(parse('get the 2 of us riverside club night tickets for friday apr 17')).toMatchObject({
      query: 'riverside club night tickets',
      quantity: 2,
      day: '04-17',
    });
    expect(parse('get the 2 of us tile workshop tickets')?.query).toBe('tile workshop tickets');
    expect(parse('snorkel tour for all 4 on monday morning')).toMatchObject({
      quantity: 4,
      day: 'monday',
    });
    expect(parse('2 tickets for the fado night')?.quantity).toBe(2);
  });
});

describe('days', () => {
  it('parseDayWord: date over weekday, abbreviations, tonight/tomorrow', () => {
    expect(parseDayWord('sunday mar 15')).toBe('03-15');
    expect(parseDayWord('the 15th of march')).toBe('03-15');
    expect(parseDayWord('sat at 3')).toBe('saturday');
    expect(parseDayWord('tn')).toBe('tonight');
    expect(parseDayWord('tmrw')).toBe('tomorrow');
    expect(parseDayWord('soon')).toBeUndefined();
  });

  it('resolveNight: weekdays from tonight, or from the trip start before the trip', () => {
    const trip = { startDate: '2026-03-12', endDate: '2026-03-17' };
    expect(resolveNight('saturday', '2026-03-10', trip)).toBe('2026-03-14');
    expect(resolveNight('friday', '2026-03-13', trip)).toBe('2026-03-13'); // today
    expect(resolveNight('friday', '2026-02-10', trip)).toBe('2026-03-13'); // weeks out
    expect(resolveNight('tonight', '2026-03-14', trip)).toBe('2026-03-14');
    expect(resolveNight('tomorrow', '2026-03-14', trip)).toBe('2026-03-15');
    expect(resolveNight('03-15', '2026-02-10', trip)).toBe('2026-03-15');
    expect(resolveNight('someday', '2026-03-14', trip)).toBeUndefined();
  });
});

describe('splitSender', () => {
  it('drops the loop prefix and the @trav token', () => {
    expect(splitSender('Dean: @trav get razz tix')).toEqual({
      sender: 'Dean',
      text: 'get razz tix',
    });
    expect(splitSender('trav, get razz tix')).toEqual({ text: 'get razz tix' });
  });
});
