import { describe, expect, it } from 'vitest';
import { loadAllTicketInventories } from '@trav/adapters';
import {
  askedMinutes,
  askedTime,
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

describe('T-158: the flagship ask in other words', () => {
  it('the three asks from the eval: intent, a named list with "me", "minus X", "not X, <reason>"', () => {
    expect(
      parse('we need razzmatazz entry tonight for dean maya jordan sam and me', 'Priya'),
    ).toMatchObject({
      query: 'razzmatazz tickets',
      attendeeNames: ['Priya', 'Dean', 'Maya', 'Jordan', 'Sam'],
      excludedNames: [],
      day: 'tonight',
    });
    expect(parse('pick up razzmatazz passes for us tonight minus henry', 'Jordan')).toMatchObject({
      query: 'razzmatazz tickets',
      excludedNames: ['Henry'],
      day: 'tonight',
    });
    const r = parse(
      'can you sort razzmatazz for 5 of us tonight? not henry, he is feeling rough',
      'Sam',
    )!;
    expect(r).toMatchObject({ quantity: 5, excludedNames: ['Henry'], day: 'tonight' });
    expect(JSON.stringify(r).replace(r.requestText, '')).not.toMatch(/rough|feeling/i);
  });

  it.each([
    'we need razz tickets for tonight',
    'need razzmatazz tix asap',
    'we really need razz passes tonight',
    'can you pick up razz passes?',
    'could you line up razzmatazz tickets for tonight',
    'sort us out with razz tickets',
    'sort out razz entry for tonight pls',
    'set us up with razz tickets tonight',
    'hook us up with razzmatazz entry',
    "we'd like razzmatazz entry for us tonight",
    'we want 5 razz tickets tonight',
    'i want razz tickets for maya and me please',
    'purchase razz tickets for tonight',
    'secure razz tix for tonight',
    // A soft verb with the venue and the whole party, no ticket word.
    'sort razzmatazz for us tonight',
    'can you sort razz for everyone tonight',
    'line up razz for all 6 of us',
  ])('a softer or other verb with a ticket word is an ask: %s', (text) => {
    expect(parse(text)?.query, text).toMatch(/^razz(?:matazz)? tickets$/);
  });

  it.each([
    ['get razz tix for everyone excluding henry', ['Henry']],
    ['get razz tix for everyone except for henry', ['Henry']],
    ['grab razz tickets for all of us other than henry', ['Henry']],
    ['book razz for us tonight. not henry though', ['Henry']],
    ['book razz for all of us; not henry or sam', ['Henry', 'Sam']],
    ['we need 5 razz tickets, henry is sitting this one out', ['Henry']],
    ['can you line up razzmatazz tickets tonight, henry is under the weather', ['Henry']],
    ["get the 5 of us razz tickets, henry's feeling rough", ['Henry']],
    ["we'd like razzmatazz entry for all of us tonight, henry's not coming", ['Henry']],
    ['get razz tickets for all of us, and henry is hungover', ['Henry']],
    ['sort us out with razz tickets, leave out henry', ['Henry']],
    ['set us up with razz tickets for tonight minus henry and sam', ['Henry', 'Sam']],
    ['get razz tickets for everyone without me', ['Dean']],
    ["we need razz entry for five tonight, henry's out sick", ['Henry']],
    ["sort razzmatazz for us tonight, not henry - he's wiped", ['Henry']],
    ['henry is under the weather so we need 5 razz tickets', ['Henry']],
    ['maya and henry are sick so get razz tickets for the rest', ['Maya', 'Henry']],
    ['get razz tickets for us, me and henry are out', ['Dean', 'Henry']],
    ["could you sort out razzmatazz passes for the five of us? henry's bailing", ['Henry']],
  ] as const)('an exclusion, name only: %s', (text, out) => {
    const r = parse(text, 'Dean');
    expect(r?.excludedNames, text).toEqual(out);
    expect(JSON.stringify(r).replace(r!.requestText, '')).not.toMatch(
      /rough|weather|hungover|sitting|coming/i,
    );
  });

  it('"i\'m feeling rough" is the sender; "not sure" / "not really" are never names', () => {
    expect(parse('get razz tickets for everyone, im feeling rough', 'Sam')?.excludedNames).toEqual([
      'Sam',
    ]);
    for (const tail of ['not sure', 'not really', 'not again', 'not bad', 'not too late']) {
      expect(
        parse(`get razz tickets for all of us tonight. ${tail}`)?.excludedNames ?? [],
        tail,
      ).toEqual([]);
    }
  });

  it('a pronoun, a venue word or a reason is never the excluded name', () => {
    expect(parse('get razz tickets for 5 of us, he is feeling rough')?.excludedNames).toEqual([]);
    expect(parse('get razz tickets for all of us, it is sold out')?.excludedNames ?? []).toEqual(
      [],
    );
    expect(parse('get razz tickets for all of us, razz is out tonight')?.excludedNames).toEqual([]);
    expect(parse('get razz tickets for 5, but not vip')?.excludedNames).toEqual([]);
  });

  it.each([
    [
      'grab razzmatazz entry for maya, jordan, sam, dean and me',
      'Priya',
      ['Priya', 'Maya', 'Jordan', 'Sam', 'Dean'],
    ],
    ['get razz tickets for maya and sam', 'Priya', ['Maya', 'Sam']],
    ['get razz tickets for maya & sam tonight', 'Priya', ['Maya', 'Sam']],
    ['get razz tickets for maya', 'Priya', ['Maya']],
    ['get razz tickets for henry and maya too', 'Priya', ['Henry', 'Maya']],
  ] as const)('a "for <names>" list names exactly them: %s', (text, sender, names) => {
    expect(parse(text, sender)?.attendeeNames).toEqual(names);
  });

  it('a "for …" that is not people is never a list', () => {
    for (const text of [
      'get razz tickets for real this time',
      'get razz tickets for later',
      'get barça tickets for may 15',
      'get barça tickets for march 15',
      'get razz tickets for march',
      'get razz tickets for tonight',
      'get razz tickets for the group',
      'get razz tickets for the 5 of us',
      'get razz tickets for everyone but henry',
      'book the razz vip mezzanine for all 6 tonight',
    ]) {
      expect(parse(text)?.attendeeNames, text).toBeUndefined();
    }
    // A later "for" outside the party is not the party; the first one settles it.
    expect(parse('get razz tickets for us, save one for henry')?.attendeeNames).toBeUndefined();
    expect(
      parse('get razz tickets for all 6, a spot for henry too')?.attendeeNames,
    ).toBeUndefined();
    // A night or the venue before the list is skipped.
    expect(parse('get tickets for razz for maya and me', 'Priya')?.attendeeNames).toEqual([
      'Priya',
      'Maya',
    ]);
    expect(parse('get razz tickets for tonight for maya and sam')?.attendeeNames).toEqual([
      'Maya',
      'Sam',
    ]);
    // A list whose "and" leads to a non-name is not guessed at.
    expect(parse('we need razz tickets for maya and the kids')).toBeUndefined();
  });

  it.each([
    // "need"
    'we need a nap before razz',
    'we need to talk about razz',
    'i need my razz ticket, who has it?',
    'i need a razz ticket',
    'we need the razz tickets back from henry',
    'we need razz entry info',
    'we need razz tickets?',
    'we need groceries before razz',
    'we need to leave for razz at 11',
    'we need henry to feel better before razz',
    'honestly razz tickets are a need',
    'razz was too loud for us',
    'sort out the uber to razz for us',
    'sort the razz pics for everyone',
    'pick up some snacks on the way to razz',
    'can someone pick up the razz passes from reception',
    'do we need razz tickets',
    'so what do we need for razz tonight',
    'what time do we need to be at razz',
    'you need razz tickets to get in',
    'they need razz passes',
    'if we need razz tickets lmk',
    'honestly we need more sleep than razz tickets',
    'we need razzmatazz tickets sorted',
    'henry needs razz tickets',
    // "sort"
    'sort razz',
    'sort the razz photos',
    'can someone sort out the razz pics',
    'can someone sort razz tix',
    'need to sort out who owes what for razz',
    'we might need to sort razz later',
    "i'll sort razz tickets myself",
    // "pick up" and other objects
    'pick up henry from razz',
    'can you pick up the razz tickets from the box office',
    'get us a taxi to razz',
    'grab drinks at razz tonight',
    "i'll get razz tickets",
    'let me grab razz tix',
    // T-158 r1 #2: a soft verb whose clause has words that aren't the ask.
    'we need razz passes printed',
    'we need 5 razz passes printed',
    'need razz passes from sam, he has them',
    'need razz passes from sam',
    'we need razz tickets lol jk',
    'we need razz tickets lol',
    'get razz tickets lol jk',
    'jk we need razz tickets for all of us',
    'we need razz tickets, sam has them',
    "we need razz tickets for everyone, henry's got them",
    'get razz passes printed',
    'grab the razz tix from sam',
    'get razz tickets off henry',
    'we need razz tickets sent to everyone',
    'we need razz tickets forwarded to maya',
    'need razz entry back from henry',
    'we need razz tickets more than sleep',
    'we need razz tickets badly lol',
    'we need razz tickets and a miracle',
    // T-158 r1 #3: "want" is a wish without the party, a count or a please;
    // and two venues are never one query.
    'we want razz tickets but henry wants apolo',
    'we want razz tickets',
    'i want razz tickets so bad',
    "we'd like razzmatazz entry tonight",
    'get razz tickets for us but henry wants apolo',
    'book razz or apolo for all of us tonight',
    'we need razz tickets for all of us, or apolo',
    // Hedges and held tickets, whatever the verb (precision first for T-168).
    'we want razz tickets for us, but maybe later',
    'maybe get razz tickets for all of us',
    'we should probably get razz tickets for everyone',
    'pick up razz passes for 5 of us later maybe',
    'idk get razz tickets for the 5 of us?',
    'we need razz tickets for us, maya has them',
    'sort razzmatazz for us tonight, henry has them',
    'get razz tickets for us. sam already bought them',
    'we need razz tickets for everyone who is coming',
  ])('ordinary chat is never a booking: %s', (text) => {
    expect(parse(text)).toBeUndefined();
    expect(parseBookingRequest(text, INDEX, 'Dean', { roster: BCN })).toBeUndefined();
  });
});

/** The Barcelona six, as the offline responder reads them off the prompt. */
const BCN = ['Dean', 'Henry', 'Maya', 'Jordan', 'Priya', 'Sam'] as const;
/** Anything that says why someone is out, or a verb: never a name. */
const REASON_WORD =
  /^(?:sick|ill|unwell|rough|hungover|tired|feeling|is|are|was|has|have|out|home|coming|going|staying|lol|jk|he|she|they)$/i;

describe('T-158 r1 #1: a "for …" list ends where the names end', () => {
  it.each([
    ['get razz tickets for maya and sam, henry is sick', ['Maya', 'Sam']],
    ['get razz tickets for maya and sam henry is sick', ['Maya', 'Sam']],
    ["get razz tickets for maya and sam, henry's sick", ['Maya', 'Sam']],
    ['get razz tickets for maya and sam, and henry is sick', ['Maya', 'Sam']],
    ['get razz tickets for maya, sam, henry is feeling rough', ['Maya', 'Sam']],
    ['get razz tickets for maya, sam, henry stays home', ['Maya', 'Sam']],
    ['get razz tickets for maya and sam - henry is out', ['Maya', 'Sam']],
    ['we need razz entry for maya and jordan, henry is hungover', ['Maya', 'Jordan']],
    ['get razz tickets for me, henry is sick', ['Dean']],
    ['get razz tickets for me and maya, henry is sick', ['Dean', 'Maya']],
    ['get razz tickets for maya and sam, he is sick', ['Maya', 'Sam']],
    ['get razz tickets for maya and sam tonight, henry is sick', ['Maya', 'Sam']],
  ] as const)('%s', (text, names) => {
    for (const r of [parse(text), parseBookingRequest(text, INDEX, 'Dean', { roster: BCN })]) {
      expect(r?.attendeeNames, text).toEqual(names);
      for (const n of r!.attendeeNames!) expect(n, text).not.toMatch(REASON_WORD);
    }
  });

  it('no reason word or verb ever lands in attendeeNames, with or without the roster', () => {
    const asks = [
      'get razz tickets for maya and sam, henry is sick',
      'get razz tickets for maya and sam henry is sick',
      'get razz tickets for maya sam henry is sick lol',
      'grab razzmatazz entry for maya, jordan, sam, dean and me, henry has been sick',
      'we need razzmatazz entry tonight for dean maya jordan sam and me, henry is feeling rough',
      'pick up razz passes for jordan and priya, henry is out, sam is tired',
      'get razz tickets for dean maya and jordan they are going',
      'get razz tickets for maya and sam since henry is sick',
      'get razz tickets for maya and sam because henry is unwell',
    ];
    for (const text of asks) {
      for (const r of [parse(text), parseBookingRequest(text, INDEX, 'Priya', { roster: BCN })]) {
        for (const n of r?.attendeeNames ?? []) {
          expect(n, text).not.toMatch(REASON_WORD);
          expect(BCN as readonly string[], `${text}: ${n}`).toContain(n);
        }
      }
    }
  });

  it('with the roster known, only members are listed and a non-member ends the list', () => {
    const r = (text: string, sender = 'Priya') =>
      parseBookingRequest(text, INDEX, sender, { roster: BCN });
    expect(
      r('we need razzmatazz entry tonight for dean maya jordan sam and me')?.attendeeNames,
    ).toEqual(['Priya', 'Dean', 'Maya', 'Jordan', 'Sam']);
    // "tickets" for a non-member after a list: the list stops at the members.
    expect(r('get razz tickets for maya sam henry stays in')?.attendeeNames).toEqual([
      'Maya',
      'Sam',
    ]);
    // A non-member joined by "and" is never guessed at.
    expect(r('get razz tickets for maya and zed')).toBeUndefined();
    // Roster spelling wins ("MAYA" ⇒ "Maya").
    expect(r('get razz tickets for MAYA and SAM')?.attendeeNames).toEqual(['Maya', 'Sam']);
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

describe('the asked time (T-143 r1 #3)', () => {
  it('askedTime reads "3pm", "at 10:30am", "at 3"; never a headcount or a price', () => {
    expect(askedTime('sagrada tickets friday at 3')).toBe('3');
    expect(askedTime('park guell friday 10am for 6')).toBe('10am');
    expect(askedTime('razz at 11:30 pm')).toBe('11:30pm');
    expect(askedTime('sagrada at 3 of us')).toBeUndefined();
    expect(askedTime('razz tickets for 5')).toBeUndefined();
    expect(askedTime('at 13')).toBeUndefined();
    // T-143 r2 #2: prices, per-person phrases and dates after "at N" are not times.
    for (const text of [
      'tickets at 3€ each',
      'tickets at 3 euros each',
      'at 3 per person',
      'at 2 a head',
      'tix at 4 bucks',
      'at 3 of them',
      '6 at 3/14',
    ]) {
      expect(askedTime(text)).toBeUndefined();
    }
    expect(askedTime('sagrada at 10.30')).toBe('10:30');
  });

  it('askedMinutes: am/pm is one reading, a bare hour is both', () => {
    expect(askedMinutes('3pm')).toEqual([900]);
    expect(askedMinutes('12am')).toEqual([0]);
    expect(askedMinutes('12pm')).toEqual([720]);
    expect(askedMinutes('10:30am')).toEqual([630]);
    expect(askedMinutes('3')).toEqual([180, 900]);
    expect(askedMinutes('teatime')).toEqual([]);
  });

  it('parseBookingRequest carries it', () => {
    expect(parse('@trav sagrada familia tickets for all of us saturday at 3')).toMatchObject({
      day: 'saturday',
      time: '3',
    });
    expect(parse("@trav get the 5 of us Razzmatazz tickets, Henry's sick")?.time).toBeUndefined();
  });
});
