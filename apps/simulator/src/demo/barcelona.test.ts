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
        'receipt posted in the group',
        'exactly one purchase after two 👍',
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
      .filter((l) => !/\*\*(Dean|Henry|Maya|Jordan|Priya|Sam)\*\*:/.test(l));
    expect(chat).toContain("Henry's sick");
    expect(notHuman.filter((l) => /sick/i.test(l))).toEqual([]);

    // Step 2: Trav's flights reply is the honest scripted line, never the offline fallback.
    const tc = (prefix: string) =>
      chat
        .split('\n### ')
        .find((s) => s.startsWith(prefix))
        ?.split('\n')
        .filter((l) => l.startsWith('- **trav**') || l.startsWith('      ')) ?? [];
    const step2 = tc('2.').join('\n');
    expect(step2).toMatch(/can't line up or book group flights in chat yet/);
    expect(step2).not.toContain(OFFLINE_FALLBACK);
    expect(chat).not.toContain(OFFLINE_FALLBACK);
    expect(result.checks.find((c) => c.step.startsWith('2.'))?.name).toMatch(
      /not the offline fallback/,
    );

    // Step 6 (T-135 / T-075): the Uber goes to the email's 4 riders, card and ledger both.
    const step6 = result.checks.filter((c) => c.step.startsWith('6.'));
    expect(step6.find((c) => /proposes the email's 4 riders/.test(c.name))?.ok).toBe(true);
    expect(step6.find((c) => /4 riders at €4\.65 each/.test(c.name))?.ok).toBe(true);
    expect(step6.some((c) => /^KNOWN GAP/.test(c.name))).toBe(false);
    expect(result.notes.some((n) => /T-075/.test(n))).toBe(false);
    // Priya's DM lines ("- 🔒 dm → Priya · **trav**: ...") and their continuations.
    const step6Text = chat.split('\n### ').find((s) => s.startsWith('6.')) ?? '';
    expect(step6Text).toMatch(/El Born → Eixample, 4 riders/);
    expect(step6Text).toMatch(/split with Dean, Jordan,? (?:and )?Sam\?/);
    expect(result.notes.some((n) => /\[Paid\]/.test(n) && /T-141/.test(n))).toBe(true);
    // Step 10 (T-141): Maya's 👍 on the final settle card ticks her row, audited.
    const step10 = result.checks.filter((c) => c.step.startsWith('10.'));
    expect(step10.find((c) => /Maya's 👍 ticks her transfer paid/.test(c.name))?.ok).toBe(true);
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
