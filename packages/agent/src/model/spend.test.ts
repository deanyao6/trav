import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testClock } from '../context/testkit.js';
import { repoRoot } from './paths.js';
import { createFileSpendGuard, DEFAULT_MODEL_PRICING, estimateCostUsd } from './spend.js';

describe('spend guard concurrency', () => {
  it('leaves no temp or lock files behind', () => {
    const file = tmpFile();
    const g = guardAt(file);
    for (let i = 0; i < 5; i += 1)
      g.record('claude-haiku-5-5', { inputTokens: 10, outputTokens: 1 });
    expect(readdirSync(dirname(file))).toEqual(['spend.json']);
  });

  it('fails closed when another live process holds the lock', () => {
    const file = tmpFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, String(process.pid)); // held by a live pid (us)
    const g = createFileSpendGuard({
      filePath: file,
      budgetUsd: 45,
      pricing: DEFAULT_MODEL_PRICING,
      clock,
      lockTimeoutMs: 50,
    });
    expect(() => g.record('claude-haiku-5-5', { inputTokens: 1, outputTokens: 1 })).toThrow(
      expect.objectContaining({ code: 'budget_exhausted' }) as Error,
    );
  });

  it('breaks a stale lock left by a dead process', () => {
    const file = tmpFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, '2147483646'); // no such pid
    const g = guardAt(file);
    expect(g.record('claude-haiku-5-5', { inputTokens: 1, outputTokens: 1 }).calls).toBe(1);
    expect(readdirSync(dirname(file))).toEqual(['spend.json']);
  });

  it('several processes recording at once never lose a cost record', async () => {
    const file = tmpFile();
    const spendModule = join(dirname(fileURLToPath(import.meta.url)), 'spend.ts');
    const script = join(dirname(dirname(file)), 'writer.mts');
    writeFileSync(
      script,
      [
        `import { createFileSpendGuard, DEFAULT_MODEL_PRICING } from ${JSON.stringify(spendModule)};`,
        `const clock = { now: () => '2026-03-14T21:40:00+01:00', nowMs: () => 0 };`,
        `const g = createFileSpendGuard({ filePath: ${JSON.stringify(file)}, budgetUsd: 1000, pricing: DEFAULT_MODEL_PRICING, clock, lockTimeoutMs: 20000 });`,
        `for (let i = 0; i < 25; i += 1) g.record('claude-haiku-5-5', { inputTokens: 1000, outputTokens: 0 });`,
      ].join('\n'),
    );
    const run = () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', script], {
          cwd: repoRoot(),
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve(code) : reject(new Error(err))));
      });
    await Promise.all([run(), run(), run(), run()]);
    const rec = guardAt(file).current();
    expect(rec.calls).toBe(100);
    expect(rec.inputTokens).toBe(100_000);
    expect(rec.estimatedUsd).toBeCloseTo(0.1, 9);
  }, 60_000);
});

const clock = testClock('2026-03-14T21:40:00+01:00');

function guardAt(filePath: string, budgetUsd = 45) {
  return createFileSpendGuard({ filePath, budgetUsd, pricing: DEFAULT_MODEL_PRICING, clock });
}

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'trav-spend-')), 'nested', 'spend.json');
}

describe('spend guard', () => {
  it('starts empty, creates the directory, accumulates per model', () => {
    const file = tmpFile();
    const g = guardAt(file);
    expect(g.current()).toMatchObject({ calls: 0, estimatedUsd: 0 });
    expect(g.canSpend()).toBe(true);
    g.record('claude-haiku-5-5', { inputTokens: 2_000_000, outputTokens: 0 });
    const r = g.record('claude-sonnet-5-5', { inputTokens: 0, outputTokens: 100_000 });
    expect(r).toMatchObject({
      calls: 2,
      inputTokens: 2_000_000,
      outputTokens: 100_000,
      estimatedUsd: 3.5,
    });
    expect(r.byModel['claude-haiku-5-5']).toMatchObject({ calls: 1, estimatedUsd: 2 });
    expect(r.byModel['claude-sonnet-5-5']).toMatchObject({ calls: 1, estimatedUsd: 1.5 });
    expect(r.updatedAt).toBe('2026-03-14T21:40:00+01:00');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(r);
  });

  it('prices unknown models with the conservative default row', () => {
    expect(
      estimateCostUsd(DEFAULT_MODEL_PRICING, 'mystery-model', {
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(15);
  });

  it('refuses exactly at the budget, allows one cent below', () => {
    const file = tmpFile();
    const g = guardAt(file, 3);
    g.record('claude-sonnet-5-5', { inputTokens: 996_666, outputTokens: 0 }); // $2.989998
    expect(g.canSpend()).toBe(true);
    g.record('claude-sonnet-5-5', { inputTokens: 3_334, outputTokens: 0 }); // total exactly $3
    expect(g.current().estimatedUsd).toBe(3);
    expect(g.canSpend()).toBe(false);
  });

  it('shares one running total between guards on the same file (two processes)', () => {
    const file = tmpFile();
    const a = guardAt(file, 10);
    const b = guardAt(file, 10);
    a.record('claude-opus-5-5', { inputTokens: 400_000, outputTokens: 0 }); // $6
    b.record('claude-opus-5-5', { inputTokens: 300_000, outputTokens: 0 }); // $4.5
    expect(a.current().calls).toBe(2);
    expect(a.canSpend()).toBe(false);
  });

  it('fails closed on a corrupt spend file', () => {
    const file = tmpFile();
    guardAt(file).record('claude-haiku-5-5', { inputTokens: 1, outputTokens: 1 });
    writeFileSync(file, '{ not json');
    const g = guardAt(file);
    expect(() => g.canSpend()).toThrow(/spend file/);
  });

  it('rejects negative or fractional usage and bad budgets', () => {
    const g = guardAt(tmpFile());
    expect(() => g.record('m', { inputTokens: -1, outputTokens: 0 })).toThrow();
    expect(() => g.record('m', { inputTokens: 1.5, outputTokens: 0 })).toThrow();
    expect(() => guardAt(tmpFile(), Number.NaN)).toThrow();
    expect(() =>
      createFileSpendGuard({ filePath: tmpFile(), budgetUsd: 1, pricing: {}, clock }),
    ).toThrow(/default/);
  });
});
