/**
 * T-092 ratchet: the simulator's "replay ▸" of the flagship chat must not show
 * Trav's generic offline "not sure" line. Every group or DM reply Trav sends
 * while the full Barcelona script plays (offline runtime, opened on demo
 * state 1 like the UI) is checked; the list of lines that still get the
 * fallback may only shrink.
 */
import { describe, expect, it } from 'vitest';
import { OFFLINE_NOT_SURE_TEXT } from '@trav/agent';
import type { SimState, ThreadEntry, ThreadMessage } from '../shared/types.js';
import { BARCELONA } from './groups.js';
import { loadBarcelonaScript, withReplay } from './replay.js';
import { loadAgentBackend } from './runtime.js';

const SCRIPT = loadBarcelonaScript();

function travTexts(state: SimState): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of state.groups) {
    if (g.group.groupId !== BARCELONA.groupId) continue;
    const lanes: (readonly ThreadEntry[])[] = [g.thread, ...Object.values(g.dms)];
    for (const entries of lanes) {
      for (const e of entries) {
        if (e.kind !== 'message' || !e.isTrav) continue;
        out.set(`${g.group.groupId}:${(e as ThreadMessage).messageId}`, e.text);
      }
    }
  }
  return out;
}

interface ReplayRun {
  readonly fallbacks: readonly string[];
  readonly skips: readonly string[];
  readonly replies: number;
  /** Trav's new texts after each script line, by line id. */
  readonly byLine: ReadonlyMap<string, readonly string[]>;
}

async function playAll(): Promise<ReplayRun> {
  const b = withReplay(await loadAgentBackend({ offline: true, seed: true }), SCRIPT);
  const fallbacks: string[] = [];
  const skips: string[] = [];
  const byLine = new Map<string, string[]>();
  let seen = new Map<string, string>();
  let replies = 0;
  for (let i = 0; i < SCRIPT.length; i++) {
    const line = SCRIPT[i]!;
    const view = await b.replay.step();
    if (i === 0) seen = new Map(); // step 1 resets the session; count from a clean slate
    const now = travTexts(b.state());
    for (const [id, text] of now) {
      if (seen.has(id)) continue;
      replies += 1;
      if (text.includes(OFFLINE_NOT_SURE_TEXT)) fallbacks.push(line.id);
      byLine.set(line.id, [...(byLine.get(line.id) ?? []), text]);
    }
    seen = now;
    if (view.last?.startsWith(`skipped ${line.id}`)) skips.push(line.id);
  }
  expect(b.state().lastError).toBeUndefined();
  return { fallbacks, skips, replies, byLine };
}

/**
 * The ratchet. Lines here still get the fallback; the list may only shrink
 * (a new entry fails the test, and so does an entry that got fixed, so it
 * gets removed). Was 20 before T-081/T-092; now 0.
 */
const KNOWN_FALLBACKS: readonly string[] = [];

/**
 * Taps that need a card v0 can't post yet. Since T-074 the six
 * `flights_proposal` 👍s/taps (0020-0026) land on the flight card (stays
 * since T-132). The payer's receipt 👍s (T-083) wait on a read-it card the
 * replay never posts (it sends no photos), so they skip rather than land on
 * some other expense or settle card.
 */
const KNOWN_SKIPS: readonly string[] = ['msg_bcn_0093a', 'msg_bcn_0161a'];

describe('Barcelona replay: generic fallback ratchet (T-092)', () => {
  it('only the known lines get the generic "not sure" fallback, and the Barça and VIP cards are tappable', async () => {
    const run = await playAll();
    expect(run.replies).toBeGreaterThan(60);
    expect(run.fallbacks).toEqual(KNOWN_FALLBACKS);
    // The Barça over-cap approvals (0044-0049) and Crowley's VIP 👍 (0123) now land on real cards.
    expect(run.skips.filter((id) => !id.startsWith('sys_'))).toEqual(KNOWN_SKIPS);
    const said = (id: string): string => (run.byLine.get(id) ?? []).join('\n');
    // Friday's "it's the 5 of us tonight, henry's out": the seed plans nothing
    // that night, so Trav says so and never marks Henry out of Saturday's club.
    expect(said('msg_bcn_0100')).toBe('nothing on the plan for tonight yet');
    // So Saturday's "razz vip mezzanine for all 6" is a 6-ticket VIP card, not a headcount question.
    expect(said('msg_bcn_0122')).toMatch(/^razzmatazz tonight, 6 tickets · VIP/);
    // ...which Dean's "cancel the vip thing" then finds and drops.
    expect(said('msg_bcn_0125')).not.toMatch(/nothing's waiting/);
    expect(said('msg_bcn_0125').length).toBeGreaterThan(0);
    // Barça (T-081): a proposal over the cap that everyone charged 👍s, then a receipt.
    expect(said('msg_bcn_0040')).toMatch(/6 tickets · Tribuna lateral/);
    expect(said('msg_bcn_0049')).toMatch(/^booked ✅ fc barcelona vs sevilla fc, 6 tickets/);
    // Group flights (T-074): the optimizer's options, "book option 1" (no
    // fallback) through the approval policy, nothing booked until the sixth
    // payer's 👍, Arjun's bare "yes" counting for nothing.
    expect(said('msg_bcn_0014')).toMatch(/^flights for 6 into BCN thu mar 12, home tue mar 17/);
    expect(said('msg_bcn_0019')).toMatch(/^option 1, flights for 6: into BCN/);
    expect(said('msg_bcn_0019')).toMatch(/all 6 of you have to 👍/);
    expect(said('msg_bcn_0022')).toBe('');
    expect(said('msg_bcn_0025')).toMatch(/still need 👍 from Henry$/);
    expect(said('msg_bcn_0026')).toMatch(/^booked ✅ flights to BCN, €2,956/);
    expect(said('msg_bcn_0026')).toMatch(/each on your own card, nothing to split/);
    // The stay (T-132): the refundable Eixample rate for all 6, booked on Henry's 👍, not Piotr's relay.
    expect(said('msg_bcn_0027')).toMatch(
      /€1,380 for 5 nights · €230 each · free cancel until mar 7/,
    );
    expect(said('msg_bcn_0036')).toBe('');
    expect(said('msg_bcn_0037')).toMatch(/^booked ✅ eixample 3br with balcony, €1,380/);
    // No reply anywhere repeats why Henry is out.
    for (const texts of run.byLine.values()) {
      for (const t of texts)
        expect(t).not.toMatch(/\b(?:sick|hungover|feel(?:s|ing)? (?:off|worse))\b/i);
    }
  }, 60_000);
});
