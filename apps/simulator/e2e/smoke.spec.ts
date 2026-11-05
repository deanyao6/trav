/**
 * Headless-browser smoke test for VOICE §9.5 demo states 1–3, clicked through
 * in Chromium against the real Trav runtime, offline (no model calls), opened
 * on the seeded chat exactly as `pnpm sim` serves it.
 *
 * Run:  pnpm --filter @trav/simulator qa
 *   (builds the UI, starts the simulator on 127.0.0.1 with a free port,
 *   drives it with Playwright, writes screenshots to qa/screenshots/).
 *
 * Needs a Chromium for Playwright, installed once with the cache in the repo:
 *   cd apps/simulator && PLAYWRIGHT_BROWSERS_PATH=$PWD/../../.cache/ms-playwright pnpm exec playwright install chromium
 * and local port binding (the overnight sandbox blocks both; see the T-019-a report).
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { createSimServer, listenLocal, staticUi } from '../src/server/http.js';
import { RAZZMATAZZ_ASK } from '../src/server/groups.js';
import { loadAgentBackend } from '../src/server/runtime.js';
import { bookingCount } from '../src/server/testkit.js';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(APP_ROOT, '..', '..');
const SHOTS = join(REPO_ROOT, 'qa', 'screenshots');
process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= join(REPO_ROOT, '.cache', 'ms-playwright');

async function count(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count();
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const backend = await loadAgentBackend({ offline: true, seed: true });
  const server = createSimServer({ backend, ui: staticUi(join(APP_ROOT, 'dist', 'ui')) });
  const port = await listenLocal(server, 0);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/`);

    // State 1: six members chatting, Trav silent, offline badge.
    const thread = page.getByTestId('thread');
    await thread.locator('[data-testid="bubble"]').nth(6).waitFor();
    assert.equal(await count(page, '[data-testid="thread"] [data-testid="bubble"]'), 7);
    assert.equal(await count(page, '[data-testid="thread"] [data-testid="bubble-trav"]'), 0);
    await page.getByTestId('offline-badge').waitFor();
    await page.screenshot({ path: join(SHOTS, 't019a-1-chat.png') });

    // State 2: the ask ⇒ proposal card (the offline runtime answers too fast to
    // catch the typing indicator reliably; App.test.tsx renders it).
    await page.getByTestId('sendas-h_dean').click();
    await page.getByTestId('hint').click();
    assert.equal(await page.getByTestId('composer-input').inputValue(), RAZZMATAZZ_ASK);
    await page.getByTestId('composer-send').click();
    const proposal = thread.getByTestId('card-booking_proposal');
    await proposal.waitFor();
    await assertGone(page, 'typing');
    assert.match(await proposal.innerText(), /€18 each · €90 total/);
    await page.screenshot({ path: join(SHOTS, 't019a-2-proposal.png') });

    // Henry is not charged: no buttons, "waiting on".
    await page.getByTestId('sendas-h_henry').click();
    await proposal.getByTestId('card-waiting').waitFor();
    assert.equal(await proposal.getByTestId('action-approve').count(), 0);

    // State 3: switch to Dean ⇒ Approve ⇒ receipt, 5 ticket DMs, Henry's DM empty.
    await page.getByTestId('sendas-h_dean').click();
    await proposal.getByTestId('action-approve').click();
    await thread.getByTestId('card-receipt').waitFor();
    await proposal.getByText(/Approved by Dean/).waitFor();
    assert.equal(await count(page, '[data-testid="thread"] [data-testid="card-ticket"]'), 0);
    for (const id of ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley']) {
      assert.equal(await page.getByTestId(`dm-tab-${id}`).getAttribute('data-count'), '1', id);
    }
    assert.equal(await page.getByTestId('dm-tab-mem_henry').getAttribute('data-count'), '0');
    await page.getByTestId('dm-tab-mem_arjun').click();
    await page.getByTestId('dm-thread').getByTestId('card-ticket').waitFor();
    await page.screenshot({ path: join(SHOTS, 't019a-3-receipt.png') });
    await page.getByTestId('dm-tab-mem_henry').click();
    assert.equal(await page.getByTestId('dm-thread').getByTestId('card-ticket').count(), 0);
    assert.equal(bookingCount(backend), 1);
    console.log('[qa] T-019-a smoke: demo states 1–3 passed');
  } finally {
    await browser.close();
    server.close();
  }
}

async function assertGone(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).waitFor({ state: 'detached' });
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    console.error(
      '[qa] Chromium for Playwright is not installed. See the header of e2e/smoke.spec.ts.',
    );
  } else if (/EPERM|EACCES/.test(message)) {
    console.error(
      `[qa] could not bind 127.0.0.1 (${message}); local port binding is blocked here.`,
    );
  }
  console.error(e);
  process.exit(1);
});
