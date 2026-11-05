import { describe, expect, it } from 'vitest';
import { OFFLINE_FALLBACK, inOrder, runBarcelonaDemo } from './barcelona.js';

describe('pnpm demo:barcelona (T-021)', () => {
  it('runs the whole Barcelona trip offline through the real runtime with every check passing', async () => {
    const result = await runBarcelonaDemo();
    const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.step}: ${c.name}`);
    expect(failed).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks.length).toBeGreaterThanOrEqual(30);

    // The Razzmatazz moment: proposal for the 5, one purchase, receipt, 5 DMs, ledger among the 5.
    const razz = result.checks.filter((c) => c.step.startsWith('7.')).map((c) => c.name);
    expect(razz).toEqual(
      expect.arrayContaining([
        'Trav bought the 5 Razzmatazz tickets on the ask, no card (explicit ask under the €500 auto-buy cap)',
        'exactly one purchase, even asked twice',
        'Henry got nothing from the booking',
        'ledger: the €90 is split among exactly the 5, Henry not charged',
      ]),
    );
    expect(result.transcript).toContain('5 tickets');
    expect(result.transcript).toContain('Result: **PASS**');
    // Trav never repeats why Henry is out: "sick" appears only in Dean's own ask.
    const chat = result.transcript.split('## Transcript')[1]?.split('## Checks')[0] ?? '';
    const notHuman = chat
      .split('\n')
      .filter((l) => !/\*\*(Dean|Henry|Chase|Piotr|Arjun|Crowley)\*\*:/.test(l));
    expect(chat).toContain("Henry's sick");
    expect(notHuman.filter((l) => /sick/i.test(l))).toEqual([]);

    // Step 2 (T-074): the optimizer's options in chat, "book option 1" through
    // the approval policy, every payer's 👍, one booking. The demo no longer
    // calls the optimizer itself.
    const tc = (prefix: string) =>
      chat
        .split('\n### ')
        .find((s) => s.startsWith(prefix))
        ?.split('\n')
        .filter((l) => l.startsWith('- **trav**') || l.startsWith('      ')) ?? [];
    const step2 = tc('2.').join('\n');
    expect(step2).toMatch(/flights for 6 into BCN thu mar 12, home tue mar 17\. best 3:/);
    expect(step2).toMatch(/say "@trav book option 1"/);
    expect(step2).toMatch(/each pays their own fare on their own card, nothing to split/);
    expect(step2).toMatch(/booked ✅ flights to BCN/);
    expect(step2).not.toContain(OFFLINE_FALLBACK);
    expect(chat).not.toContain(OFFLINE_FALLBACK);
    expect(chat).not.toMatch(/can't line up or book group flights/);
    expect(result.transcript).not.toMatch(/planner step, no chat flow yet/);
    const step2Checks = result.checks.filter((c) => c.step.startsWith('2.'));
    expect(step2Checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/posts the optimizer's group options in chat/),
        expect.stringMatching(/"book option 1" proposes those 6 flights/),
        expect.stringMatching(/the last 👍 books all 6/),
      ]),
    );
    expect(step2Checks.every((c) => c.ok)).toBe(true);

    // Step 6 (T-135 / T-075): the Uber goes to the email's 4 riders, card and ledger both.
    const step6 = result.checks.filter((c) => c.step.startsWith('6.'));
    expect(step6.find((c) => /proposes the email's 4 riders/.test(c.name))?.ok).toBe(true);
    expect(step6.find((c) => /4 riders at €4\.65 each/.test(c.name))?.ok).toBe(true);
    expect(step6.some((c) => /^KNOWN GAP/.test(c.name))).toBe(false);
    expect(result.notes.some((n) => /T-075/.test(n))).toBe(false);
    // Arjun's DM lines ("- 🔒 dm → Arjun · **trav**: ...") and their continuations.
    const step6Text = chat.split('\n### ').find((s) => s.startsWith('6.')) ?? '';
    expect(step6Text).toMatch(/El Born → Eixample, 4 riders/);
    expect(step6Text).toMatch(/split with Dean, Piotr,? (?:and )?Crowley\?/);
    expect(result.notes.some((n) => /\[Paid\]/.test(n) && /T-141/.test(n))).toBe(true);
    // Step 10 (T-141): Chase's 👍 on the final settle card ticks Chase's row, audited.
    const step10 = result.checks.filter((c) => c.step.startsWith('10.'));
    expect(step10.find((c) => /Chase's 👍 ticks Chase's transfer paid/.test(c.name))?.ok).toBe(
      true,
    );
    expect(step10.find((c) => /marking paid is audited/.test(c.name))?.ok).toBe(true);
  }, 60_000);

  it('is deterministic: two runs give the same transcript', async () => {
    const a = await runBarcelonaDemo();
    const b = await runBarcelonaDemo();
    expect(b.transcript).toBe(a.transcript);
  }, 60_000);

  it('inOrder finds the audit sequence as a subsequence, not a contiguous run', () => {
    expect(inOrder(['a', 'x', 'b', 'c'], ['a', 'b', 'c'])).toBe(true);
    expect(inOrder(['b', 'a', 'c'], ['a', 'b', 'c'])).toBe(false);
    expect(inOrder([], ['a'])).toBe(false);
  });
});
