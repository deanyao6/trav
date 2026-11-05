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
    expect(parseHandleStatements('my venmo is down')).toEqual([]);
    expect(parseHandleStatements('i paid cash for the taxi')).toEqual([]);
    expect(parseHandleStatements('apple cash works')).toEqual([]);
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
      favourite: 'apple_cash',
      explicit: false,
      bare: true,
    });
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
