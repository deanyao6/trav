import { describe, expect, it } from 'vitest';
import { loadAllTicketInventories } from '@trav/adapters';
import {
  foldText,
  parseBookingRequest,
  parseDayWord,
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
