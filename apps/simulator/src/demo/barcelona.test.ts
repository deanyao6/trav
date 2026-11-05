import { describe, expect, it } from 'vitest';
import { inOrder, runBarcelonaDemo } from './barcelona.js';

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
