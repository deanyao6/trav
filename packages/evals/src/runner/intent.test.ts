/** The eval's own reading of a member's gesture on a card (T-161 r2, SAFETY D5). */
import { describe, expect, it } from 'vitest';
import { isConfirmGesture, typedIntent } from './intent.js';

const NAMES = ['Dean', 'Henry', 'Maya', 'Jordan', 'Priya', 'Sam'];

describe('typedIntent', () => {
  it.each([
    ['yes', 'confirm'],
    ['Yep!', 'confirm'],
    ['@trav ok', 'confirm'],
    ['log it', 'confirm'],
    ['share it', 'confirm'],
    ['👍', 'confirm'],
    ['👍🏽', 'confirm'],
    ['no', 'decline'],
    ['nope.', 'decline'],
    ['keep it private', 'decline'],
    ['keep it', 'decline'],
    ['just me', 'decline'],
    ["don't log that", 'decline'],
    ['👎', 'decline'],
    // fails toward "not a confirmation": a no-word anywhere wins
    ['yes no wait', 'decline'],
    ['me, dean, sam and jordan', 'riders'],
    ['Priya and Sam', 'riders'],
    // a no-word that takes a named member out is still a names answer (T-161 final review)
    ['me dean jordan sam, no maya', 'riders'],
    ['everyone, no henry', 'riders'],
    ['all of us no henry', 'riders'],
    ['no jordan', 'riders'],
    ['nah just dean and sam', 'riders'],
    ['everyone except henry, no maya', 'riders'],
    // ...but a bare no-word still declines, even next to a yes or a name
    ['yes, no tip', 'decline'],
    ['no, keep it', 'decline'],
    ["sam didn't ride", 'decline'],
    ['no maya, keep it private', 'decline'],
    ['lol', 'other'],
    ['good', 'other'],
    ['', 'other'],
  ] as const)('%j ⇒ %s', (text, want) => {
    expect(typedIntent(text, NAMES)).toBe(want);
  });

  it('a name inside another word is not a name', () => {
    expect(typedIntent('samba tonight', NAMES)).toBe('other');
  });
});

describe('isConfirmGesture', () => {
  const ridersAnswer = false;
  it.each([
    [{ kind: 'reaction', reaction: '👍' }, true],
    [{ kind: 'reaction', reaction: '👍🏽' }, true],
    [{ kind: 'reaction', reaction: 'like' }, true],
    [{ kind: 'reaction', reaction: '👎' }, false],
    [{ kind: 'reaction', reaction: '❤️' }, false],
    [{ kind: 'tap', actionId: 'confirm' }, true],
    [{ kind: 'tap', actionId: 'keep_private' }, false],
    [{ kind: 'tap', actionId: 'decline' }, false],
    [{ kind: 'text', intent: 'confirm' }, true],
    [{ kind: 'text', intent: 'decline' }, false],
    [{ kind: 'text', intent: 'riders' }, false],
    [{ kind: 'text', intent: 'other' }, false],
  ] as const)('%j ⇒ %s', (action, want) => {
    expect(isConfirmGesture(action, { ridersAnswer })).toBe(want);
  });

  it('a names answer confirms only where the card asked who rode (a private item)', () => {
    expect(isConfirmGesture({ kind: 'text', intent: 'riders' }, { ridersAnswer: true })).toBe(true);
  });

  it('no recorded gesture never confirms', () => {
    expect(isConfirmGesture(undefined, { ridersAnswer: true })).toBe(false);
  });
});
