/**
 * T-200 (QA-08): the simulator runtime gets the consent-filtered mock album
 * (`createMockAlbum`, `fixtures/album/barcelona.json`). After "photos on",
 * the Morning Afters and Wrapped carry opted-in members' photos; Henry and
 * Piotr never turned photos on, so theirs never show; Arjun's stop after his
 * "photos off", including on recaps already in the thread (SAFETY §2.6, G2).
 */
import { describe, expect, it } from 'vitest';
import type { RecapCard, WrappedCard } from '@trav/core';
import type { SimState, ThreadEntry, ThreadMessage } from '../shared/types.js';
import { BARCELONA } from './groups.js';
import { loadBarcelonaScript, withReplay } from './replay.js';
import { loadAgentBackend, photoConsentOf } from './runtime.js';
import { withConsentedPhotos } from './state.js';

const SCRIPT = loadBarcelonaScript();

type PhotoCard = RecapCard | WrappedCard;

function photoCards(entries: readonly ThreadEntry[]): { msg: ThreadMessage; card: PhotoCard }[] {
  return entries.flatMap((e) =>
    e.kind === 'message' && (e.card?.type === 'recap' || e.card?.type === 'wrapped')
      ? [{ msg: e, card: e.card }]
      : [],
  );
}

function everyPhotoCard(s: SimState): { msg: ThreadMessage; card: PhotoCard }[] {
  const g = s.groups.find((x) => x.group.groupId === BARCELONA.groupId)!;
  return [g.thread, ...Object.values(g.dms)].flatMap(photoCards);
}

const owners = (cards: readonly { card: PhotoCard }[]): Set<string> =>
  new Set(cards.flatMap((c) => c.card.photos.map((p) => p.byMemberId)));

describe('shared album in the simulator (T-200, QA-08)', () => {
  it('replay: recaps and Wrapped show opted-in photos only; never Henry or Piotr; no Arjun after "photos off"', async () => {
    const b = withReplay(await loadAgentBackend({ offline: true, seed: true }), SCRIPT);
    const offAt = SCRIPT.findIndex((l) => l.id === 'msg_bcn_0159'); // Arjun: "@trav photos off for me"
    expect(offAt).toBeGreaterThan(0);

    // Up to Arjun's "photos off": the Morning Afters so far.
    while (b.replay.view().cursor < offAt) await b.replay.step();
    const before = everyPhotoCard(b.state());
    const recaps = before.filter((c) => c.card.type === 'recap');
    expect(recaps.length).toBeGreaterThan(0);
    expect(recaps.some((c) => c.card.photos.length > 0)).toBe(true);
    for (const c of recaps) expect(c.card.photos.length).toBeLessThanOrEqual(3); // VOICE §3.8
    const ownersBefore = owners(before);
    expect(ownersBefore.has('mem_henry')).toBe(false);
    expect(ownersBefore.has('mem_piotr')).toBe(false);
    // Arjun was opted in then, so an earlier recap carries his photos...
    expect(ownersBefore.has('mem_arjun')).toBe(true);
    for (const o of ownersBefore) {
      expect(['mem_dean', 'mem_chase', 'mem_arjun', 'mem_crowley']).toContain(o);
    }

    await b.replay.all();
    const s = b.state();
    expect(s.lastError).toBeUndefined();
    const after = everyPhotoCard(s);
    const wrapped = after.filter((c) => c.card.type === 'wrapped');
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]!.card.photos.length).toBeGreaterThan(0);
    const ownersAfter = owners(after);
    expect(ownersAfter.has('mem_henry')).toBe(false);
    expect(ownersAfter.has('mem_piotr')).toBe(false);
    // Arjun said "photos off": none of his anywhere, old recaps included.
    expect(ownersAfter.has('mem_arjun')).toBe(false);
    // ...and no image attachment of his rides along either.
    const arjunUrls = new Set(
      before.flatMap((c) =>
        c.card.photos.filter((p) => p.byMemberId === 'mem_arjun').map((p) => p.url),
      ),
    );
    for (const c of after) {
      for (const a of c.msg.attachments) expect(arjunUrls.has(a.uri)).toBe(false);
    }
  }, 60_000);

  it('photos off hides a member from a card already sent; photos on (or no filter) leaves it as sent', () => {
    const card = {
      type: 'recap',
      photos: [
        { url: 'u1', byMemberId: 'mem_dean', alt: 'a' },
        { url: 'u2', byMemberId: 'mem_arjun', alt: 'b' },
      ],
    } as unknown as RecapCard;
    const msg = {
      card,
      attachments: [
        { kind: 'image' as const, mimeType: 'image/jpeg', uri: 'u1' },
        { kind: 'image' as const, mimeType: 'image/jpeg', uri: 'u2' },
      ],
    };
    const out = withConsentedPhotos(msg, (id) => id !== 'mem_arjun');
    expect((out.card as RecapCard).photos.map((p) => p.byMemberId)).toEqual(['mem_dean']);
    expect(out.attachments.map((a) => a.uri)).toEqual(['u1']);
    expect(withConsentedPhotos(msg, () => true)).toBe(msg);
    expect(withConsentedPhotos(msg, undefined)).toBe(msg);
  });

  it('photoConsentOf reads the owner flag for that group only', () => {
    const flags: Record<string, { memberId: string; groupId: string; photos: boolean }> = {
      'mem_dean|grp_barcelona': { memberId: 'mem_dean', groupId: 'grp_barcelona', photos: true },
      'mem_arjun|grp_barcelona': { memberId: 'mem_arjun', groupId: 'grp_barcelona', photos: false },
    };
    const { photoVisible } = photoConsentOf({
      stores: {
        group: { members: { get: () => undefined } } as never,
        private: {
          getConsent: (memberId: string, groupId: string) => flags[`${memberId}|${groupId}`],
        } as never,
      },
    });
    expect(photoVisible!('grp_barcelona', 'mem_dean')).toBe(true);
    expect(photoVisible!('grp_barcelona', 'mem_arjun')).toBe(false);
    expect(photoVisible!('grp_lisbon', 'mem_dean')).toBe(false);
    expect(photoVisible!('grp_barcelona', 'mem_henry')).toBe(false);
    expect(photoConsentOf({}).photoVisible).toBeUndefined();
  });

  it("a minor's photo also needs the guardian's flag on", () => {
    const flags: Record<string, boolean> = { 'mem_lily|grp_tci': true, 'mem_dad|grp_tci': true };
    const members: Record<string, { guardianMemberId?: string }> = {
      mem_lily: { guardianMemberId: 'mem_dad' },
      mem_dad: {},
    };
    const { photoVisible } = photoConsentOf({
      stores: {
        group: { members: { get: (id: string) => members[id] } } as never,
        private: {
          getConsent: (memberId: string, groupId: string) =>
            flags[`${memberId}|${groupId}`] === undefined
              ? undefined
              : { memberId, groupId, photos: flags[`${memberId}|${groupId}`] },
        } as never,
      },
    });
    expect(photoVisible!('grp_tci', 'mem_lily')).toBe(true);
    flags['mem_dad|grp_tci'] = false;
    expect(photoVisible!('grp_tci', 'mem_lily')).toBe(false);
    expect(photoVisible!('grp_tci', 'mem_dad')).toBe(false);
  });
});
