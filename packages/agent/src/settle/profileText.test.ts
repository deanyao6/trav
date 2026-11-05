/** T-166: payment-profile words in a DM. Pure parsers, never the model. */
import { describe, expect, it } from 'vitest';
import { parseAppsAnswer, parseHandleStatements } from './profileText.js';
import { settleReplyAction } from './actions.js';

describe('parseHandleStatements', () => {
  it.each([
    ['my venmo is @chase-w', [{ rail: 'venmo', handle: 'chase-w' }]],
    ['@trav my venmo is @chase-w', [{ rail: 'venmo', handle: 'chase-w' }]],
    ['venmo: chase-w', [{ rail: 'venmo', handle: 'chase-w' }]],
    ['my cashtag is $chasew', [{ rail: 'cashapp', handle: 'chasew' }]],
    ['my cash app is $chasew', [{ rail: 'cashapp', handle: 'chasew' }]],
    ['paypal.me/chasew', [{ rail: 'paypal', handle: 'chasew' }]],
    ['my zelle is 617 555 0142', [{ rail: 'zelle', handle: '+16175550142' }]],
    ['my zelle email is Chase@Example.com', [{ rail: 'zelle', handle: 'chase@example.com' }]],
    [
      'my venmo is @chase-w and my zelle is chase@example.com',
      [
        { rail: 'venmo', handle: 'chase-w' },
        { rail: 'zelle', handle: 'chase@example.com' },
      ],
    ],
  ] as const)('"%s"', (text, want) => {
    expect(parseHandleStatements(text)).toEqual(want);
  });

  it('a bad try is flagged, chat about an app is not a try', () => {
    expect(parseHandleStatements('my venmo is @x')).toEqual([{ rail: 'venmo' }]);
    expect(parseHandleStatements('venmo is down again')).toEqual([]);
    expect(parseHandleStatements('my venmo is down')).toEqual([{ rail: 'venmo', soft: true }]);
    expect(parseHandleStatements('i paid cash for the taxi')).toEqual([]);
    expect(parseHandleStatements('apple cash works')).toEqual([]);
  });

  it('r1 #2: a plain word, or one followed by more words, is never a handle', () => {
    expect(parseHandleStatements('my venmo is broken, can you use zelle')).toEqual([]);
    expect(parseHandleStatements('my venmo is acting up')).toEqual([]);
    expect(parseHandleStatements('my paypal is chase w')).toEqual([]);
    expect(parseHandleStatements('my venmo is chasew so')).toEqual([]);
    // Alone at the end it reads as a try: refused with a hint, never saved.
    for (const t of ['my venmo is frozen', 'my venmo is chasew', 'my paypal is chasew']) {
      expect(
        parseHandleStatements(t).every((s) => s.handle === undefined),
        t,
      ).toBe(true);
    }
    // An explicit try followed by words is refused too.
    expect(parseHandleStatements('venmo: chase w')).toEqual([{ rail: 'venmo' }]);
    expect(parseHandleStatements('my venmo is @chase w')).toEqual([{ rail: 'venmo' }]);
    // A hyphen alone is ordinary English (r2 #1): hint, never saved.
    expect(parseHandleStatements('my venmo is chase-w')).toEqual([{ rail: 'venmo', soft: true }]);
    // Handle-shaped, a sigil or a colon still works, and a clause or thanks may follow.
    expect(parseHandleStatements('my venmo is @chasew, thanks!')).toEqual([
      { rail: 'venmo', handle: 'chasew' },
    ]);
    expect(parseHandleStatements('my paypal is chase22 thanks')).toEqual([
      { rail: 'paypal', handle: 'chase22' },
    ]);
    // A zelle email or phone can't be a sentence word: words may follow it.
    expect(parseHandleStatements('my zelle is 617-555-0142 if that helps')).toEqual([
      { rail: 'zelle', handle: '+16175550142' },
    ]);
    expect(parseHandleStatements('my zelle is broken, use venmo')).toEqual([]);
  });

  it('r2 #1: hyphenated English words are never saved', () => {
    for (const t of [
      'my venmo is maxed-out, can i zelle you',
      'my venmo is locked-out lol',
      'my venmo is on-hold.',
      'my venmo is re-linked',
      'my venmo is co-signed',
    ]) {
      expect(
        parseHandleStatements(t).every((s) => s.handle === undefined),
        t,
      ).toBe(true);
    }
  });

  it('r2 #2-4: a sigil handle saves whatever follows; "handle is", "still", "now"', () => {
    for (const t of [
      'my venmo is @chase-w btw',
      'my venmo is @chase-w if you need it',
      'my venmo is @chase-w :)',
      'my venmo is @chase-w (new one)',
      'my venmo is @chase-w thank you',
      'my venmo is still @chase-w',
      'my venmo is @chase-w now',
    ]) {
      expect(parseHandleStatements(t), t).toEqual([{ rail: 'venmo', handle: 'chase-w' }]);
    }
    expect(parseHandleStatements('my cashtag is $chasew btw')).toEqual([
      { rail: 'cashapp', handle: 'chasew' },
    ]);
    expect(parseHandleStatements('my venmo handle is chasew')).toEqual([
      { rail: 'venmo', handle: 'chasew' },
    ]);
    expect(parseHandleStatements('my venmo username is chasew')).toEqual([
      { rail: 'venmo', handle: 'chasew' },
    ]);
  });
});

describe('parseAppsAnswer', () => {
  it('apps in order, the favourite from its clause', () => {
    expect(parseAppsAnswer("venmo and zelle, venmo's my fave")).toEqual({
      apps: ['venmo', 'zelle'],
      favourite: 'venmo',
      explicit: true,
      bare: true,
    });
    expect(parseAppsAnswer('i use zelle, mostly cash app though')).toMatchObject({
      apps: ['zelle', 'cashapp'],
      favourite: 'cashapp',
      explicit: true,
    });
    expect(parseAppsAnswer('apple cash')).toEqual({
      apps: ['apple_cash'],
      onlyApp: 'apple_cash',
      explicit: false,
      bare: true,
    });
  });

  it('r1 #3: a negated app is dropped, in its own clause only', () => {
    expect(parseAppsAnswer('i have no venmo, zelle')?.apps).toEqual(['zelle']);
    expect(parseAppsAnswer('i use zelle, never venmo')?.apps).toEqual(['zelle']);
    expect(parseAppsAnswer('i use venmo not paypal')?.apps).toEqual(['venmo']);
    expect(parseAppsAnswer("i don't have venmo or zelle, just cash app")?.apps).toEqual([
      'cashapp',
    ]);
    expect(parseAppsAnswer('i don’t use paypal')).toBeUndefined();
    expect(parseAppsAnswer('no venmo, zelle')).toMatchObject({ apps: ['zelle'], bare: true });
    expect(parseAppsAnswer("i use venmo not paypal, venmo's my fave")).toMatchObject({
      apps: ['venmo'],
      favourite: 'venmo',
      explicit: true,
    });
  });

  it('r1 #5: one app with no favourite word is `onlyApp`, never `favourite`', () => {
    expect(parseAppsAnswer('i use venmo for dinner')).toMatchObject({
      apps: ['venmo'],
      onlyApp: 'venmo',
    });
    expect(parseAppsAnswer('i use venmo for dinner')?.favourite).toBeUndefined();
    expect(parseAppsAnswer('mostly venmo')?.favourite).toBe('venmo');
  });

  it('"cash app" and "apple cash" are never read as cash', () => {
    expect(parseAppsAnswer('cash app or apple cash')?.apps).toEqual(['cashapp', 'apple_cash']);
    expect(parseAppsAnswer('cash app, cash')?.apps).toEqual(['cashapp', 'cash']);
  });

  it('a sentence that only mentions an app is neither explicit nor bare', () => {
    expect(parseAppsAnswer('i have cash for the taxi tonight')).toMatchObject({
      explicit: false,
      bare: false,
    });
    expect(parseAppsAnswer('i paid cash for the taxi')).toMatchObject({
      explicit: false,
      bare: false,
    });
    expect(parseAppsAnswer('no apps here')).toBeUndefined();
  });
});

describe('settleReplyAction (a text reply quoting the final card)', () => {
  it.each([
    ['sent', 'sent'],
    ['Sent it!', 'sent'],
    ['@trav paid', 'sent'],
    ['got it', 'got_it'],
    ['received', 'got_it'],
    ['got it thanks', 'got_it'],
    ['undo', 'undo'],
    ['undo that', 'undo'],
  ] as const)('"%s" → %s', (text, want) => {
    expect(settleReplyAction(text)).toBe(want);
  });

  it.each(['sent it to the wrong person lol', 'got it, but who owes piotr?', 'ok'])(
    '"%s" is not a settle reply',
    (text) => {
      expect(settleReplyAction(text)).toBeUndefined();
    },
  );
});
