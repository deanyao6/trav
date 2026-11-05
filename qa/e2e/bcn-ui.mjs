// Barcelona flagship through the browser UI (headless Chromium), offline backend.
import { open, shot, send, waitTravCount, lastTravText, noStackTrace, check, results } from './ui-lib.mjs';

const { browser, page, consoleErrors } = await open();
const thread = page.getByTestId('thread');
try {
  await thread.locator('[data-testid="bubble"]').nth(6).waitFor();
  check('seed: 7 member bubbles, Trav silent', (await thread.getByTestId('bubble-trav').count()) === 0);
  await shot(page, 'bcn-ui-01-seed');

  // dinner from chat
  let { before, t0 } = await send(page, 'h_dean', '@trav i paid €84 for dinner, split with everyone but Henry');
  await thread.getByTestId('card-expense_confirm').waitFor({ timeout: 8000 });
  const dinnerMs = Date.now() - t0;
  const dinner = await thread.getByTestId('card-expense_confirm').last().innerText();
  check('dinner card: €84, 5 ways, €16.80, not Henry', /€84/.test(dinner) && /16\.80/.test(dinner) && /not:? Henry/i.test(dinner), dinner.replace(/\n/g, ' / '));
  check('dinner latency < 2s', dinnerMs < 2000, `${dinnerMs}ms`);
  await shot(page, 'bcn-ui-02-dinner');

  // Razzmatazz via the hint chip
  await page.getByTestId('sendas-h_dean').click();
  const hintCount = await page.getByTestId('hint').count();
  if (hintCount) await page.getByTestId('hint').click();
  else await page.getByTestId('composer-input').fill("@trav get the 5 of us Razzmatazz tickets, Henry's sick");
  check('hint chip offered after dinner card', hintCount > 0, hintCount ? '' : 'hint hidden once Trav answered with any card (dinner)');
  t0 = Date.now();
  await page.getByTestId('composer-send').click();
  const receipt = thread.getByTestId('card-receipt').last();
  await receipt.waitFor({ timeout: 8000 });
  const razzMs = Date.now() - t0;
  const rtext = await receipt.innerText();
  check('razz receipt: 5 tickets, €90', /5 tickets?/i.test(rtext) && /€90/.test(rtext), rtext.replace(/\n/g, ' / '));
  check('razz receipt: Henry not on split', !/Henry/.test(rtext) || /not Henry/.test(rtext));
  check('razz latency < 2s', razzMs < 2000, `${razzMs}ms`);
  check('no booking_proposal for razz (auto-buy on ask)', (await thread.getByTestId('card-booking_proposal').count()) === 0);
  await receipt.scrollIntoViewIfNeeded();
  await shot(page, 'bcn-ui-03-razz-receipt');
  for (const id of ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley']) {
    check(`ticket DM count ${id} = 1`, (await page.getByTestId(`dm-tab-${id}`).getAttribute('data-count')) === '1');
  }
  check('Henry DM empty', (await page.getByTestId('dm-tab-mem_henry').getAttribute('data-count')) === '0');
  // Arjun's ticket with a QR
  await page.getByTestId('sendas-h_arjun').click();
  await page.getByTestId('dm-tab-mem_arjun').click();
  const ticket = page.getByTestId('dm-thread').getByTestId('card-ticket');
  await ticket.waitFor();
  const qr = await ticket.locator('svg, img, canvas').count();
  check('Arjun ticket card renders a QR (svg/img/canvas)', qr > 0, `${qr} graphic(s)`);
  await shot(page, 'bcn-ui-04-arjun-ticket');
  // receipt "tickets" link
  const link = await receipt.getByTestId('receipt-tickets-link').count();
  check('receipt has tickets link', link > 0);

  // repeat ask (double ask) must not double-buy
  await send(page, 'h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
  await page.waitForTimeout(800);
  check('repeat ask: still 1 receipt for razz', (await thread.getByTestId('card-receipt').count()) === 1, (await lastTravText(page)).replace(/\n/g, ' / '));

  // night goes on, Morning After
  for (let i = 0; i < 4; i++) {
    await page.getByTestId('clock-hour').click();
    await page.waitForTimeout(150);
  }
  await send(page, 'h_crowley', 'this place is insane');
  await page.waitForTimeout(300);
  await page.getByTestId('clock-morning').click();
  const recap = thread.getByTestId('card-recap').last();
  await recap.waitFor({ timeout: 8000 });
  const rc = await recap.innerText();
  check('morning after recap card renders', /morning after/i.test(rc), rc.replace(/\n/g, ' / '));
  check('recap mentions 5 of you not Henry, not "sick"', /not:? Henry/.test(rc) && !/sick/i.test(rc));
  await recap.scrollIntoViewIfNeeded();
  await shot(page, 'bcn-ui-05-morning-after');

  // settle now
  await send(page, 'h_dean', '@trav settle now');
  const settle = thread.getByTestId('card-settle_up').last();
  await settle.waitFor({ timeout: 8000 });
  const st = await settle.innerText();
  check('settle card: 4 transfers to Dean', /4 transfers/.test(st) && (st.match(/→ Dean/g) ?? []).length === 4, st.replace(/\n/g, ' / '));
  await settle.scrollIntoViewIfNeeded();
  await shot(page, 'bcn-ui-06-settle');
  // Chase taps Sent, Dean taps Got it
  await page.getByTestId('sendas-h_chase').click();
  await settle.getByTestId('action-sent').click();
  await page.waitForTimeout(400);
  await page.getByTestId('sendas-h_dean').click();
  const gotIt = thread.getByTestId('card-settle_up').last().getByTestId('action-got_it');
  check('Dean sees Got it', (await gotIt.count()) > 0);
  if (await gotIt.count()) await gotIt.click();
  await page.waitForTimeout(400);
  const st2 = await thread.getByTestId('card-settle_up').last().innerText();
  check('after Sent + Got it: 1 of 4 paid', /1 of 4 paid/.test(st2), st2.split('\n')[0]);
  await shot(page, 'bcn-ui-07-settle-paid');

  // Wrapped
  await page.getByTestId('clock-end_of_trip').click();
  const wrapped = thread.getByTestId('card-wrapped').last();
  await wrapped.waitFor({ timeout: 8000 });
  const wt = await wrapped.innerText();
  check('wrapped card renders with total', /wrapped/i.test(wt) && /€/.test(wt), wt.replace(/\n/g, ' / ').slice(0, 400));
  await wrapped.scrollIntoViewIfNeeded();
  await shot(page, 'bcn-ui-08-wrapped');

  const ns = await noStackTrace(page);
  check('no stack traces / error banner / undefined / NaN on page', ns.ok, ns.detail);
  check('no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  // Replay (play all) the scripted flagship from a fresh reset
  await page.getByTestId('reset').click();
  await page.waitForTimeout(500);
  const t1 = Date.now();
  await page.getByTestId('replay-all').click();
  await page.waitForFunction(() => /\b(\d+)\/\1\b/.test(document.querySelector('[data-testid="replay-step"]')?.textContent ?? ''), null, { timeout: 60000 }).catch(() => {});
  const label = await page.getByTestId('replay-step').innerText();
  check('replay play-all completes', /(\d+)\/\1/.test(label), `${label} in ${Date.now() - t1}ms`);
  const ns2 = await noStackTrace(page);
  check('replay: no error banner / stack trace', ns2.ok, ns2.detail);
  const cards = {};
  for (const el of await thread.locator('[data-testid^="card-"]').all()) {
    const id = await el.getAttribute('data-testid');
    cards[id] = (cards[id] ?? 0) + 1;
  }
  console.log('replay cards:', JSON.stringify(cards));
  check('replay produced receipt, recap, settle_up, wrapped cards', ['card-receipt', 'card-recap', 'card-settle_up', 'card-wrapped'].every((c) => cards[c] > 0), JSON.stringify(cards));
  check('replay: no card-fallback (unrendered card)', !cards['card-fallback'], `fallbacks: ${cards['card-fallback'] ?? 0}`);
  await shot(page, 'bcn-ui-09-replay-end');
} catch (e) {
  check('journey ran without exception', false, String(e).slice(0, 300));
  await shot(page, 'bcn-ui-XX-failure');
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
}
