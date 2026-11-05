// Shared Playwright helpers for QA browser journeys (qa/ only; candidates for apps/simulator/e2e).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/Users/deanyao/trav/.cache/ms-playwright';
const { chromium } = await import('/Users/deanyao/trav/apps/simulator/node_modules/playwright/index.mjs');

export const BASE = process.env.SIM_URL ?? 'http://127.0.0.1:5193';
export const SHOTS = '/Users/deanyao/trav/qa/screenshots/2026-11-05-post-p0';
mkdirSync(SHOTS, { recursive: true });

export const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
}

export async function open() {
  const browser = await chromium.launch({ headless: true, args: ['--single-process'] }); // OS sandbox blocks Chromium's mach-port rendezvous otherwise
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  const rr = await fetch(BASE + '/api/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (rr.status !== 200) throw new Error(`reset failed: ${rr.status} ${(await rr.text()).slice(0, 200)}`);
  await page.goto(BASE + '/');
  await page.getByTestId('thread').waitFor();
  return { browser, page, consoleErrors };
}

export async function shot(page, name) {
  const p = join(SHOTS, name + '.png');
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

export async function send(page, handle, text) {
  await page.getByTestId(`sendas-${handle}`).click();
  const before = await page.locator('[data-testid="thread"] [data-testid="bubble-trav"]').count();
  await page.getByTestId('composer-input').fill(text);
  const t0 = Date.now();
  await page.getByTestId('composer-send').click();
  return { before, t0 };
}

export async function waitTravCount(page, n, timeout = 8000) {
  await page.waitForFunction(
    (k) => document.querySelectorAll('[data-testid="thread"] [data-testid="bubble-trav"]').length >= k,
    n,
    { timeout },
  );
}

export async function lastTravText(page) {
  const rows = page.locator('[data-testid="thread"] .msg-row');
  const n = await rows.count();
  return n ? rows.nth(n - 1).innerText() : '';
}

export async function noStackTrace(page) {
  const body = await page.locator('body').innerText();
  const bad = /(TypeError|ReferenceError|at [\w.<>]+ \(|\.ts:\d+|undefined|NaN|\[object Object\])/.exec(body);
  const err = await page.getByTestId('error').count();
  return { ok: !bad && err === 0, detail: bad ? `found "${bad[0]}"` : err ? await page.getByTestId('error').innerText() : '' };
}
