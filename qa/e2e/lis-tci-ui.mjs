// Lisbon + Turks and Caicos through the browser UI (headless Chromium), offline backend.
import { open, shot, send, lastTravText, noStackTrace, check, results } from './ui-lib.mjs';
const { browser, page, consoleErrors } = await open();
const thread = page.getByTestId('thread');
try {
  // Lisbon
  await page.getByTestId('trip-grp_lisbon').click();
  await page.getByTestId('group-name').filter({ hasText: /lisbon/i }).waitFor();
  const clk = await page.getByTestId('clock').innerText();
  check('Lisbon opens on its own trip day (apr)', /apr/i.test(clk), clk);
  await shot(page, 'lis-ui-01-open');
  await send(page, 'h_lis_dad', '@trav remember my conference is thursday 9-5 and friday 9-1');
  await page.waitForTimeout(400);
  check('Dad conference noted', /noted/.test(await lastTravText(page)), (await lastTravText(page)).replace(/\n/g, ' / '));
  await send(page, 'h_lis_dean', '@trav book the tile thing for me');
  const prop = thread.getByTestId('card-booking_proposal').last();
  await prop.waitFor({ timeout: 8000 });
  const pt = await prop.innerText();
  check('tile proposal is Dean-only (not Dad)', /Dean/.test(pt) && !/Dad\s+€/.test(pt), pt.replace(/\n/g, ' / '));
  await prop.scrollIntoViewIfNeeded();
  await shot(page, 'lis-ui-02-tile-proposal');
  await page.getByTestId('sendas-h_lis_dad').click();
  check('Dad has no Approve on Dean-only proposal', (await prop.getByTestId('action-approve').count()) === 0);
  await page.getByTestId('sendas-h_lis_dean').click();
  await prop.getByTestId('action-approve').click();
  await thread.getByTestId('card-receipt').last().waitFor({ timeout: 8000 });
  check('tile receipt renders', true);
  await send(page, 'h_lis_dean', '@trav how are we doing on budget');
  await page.waitForTimeout(400);
  const bud = await lastTravText(page);
  check('budget pacing answer', !/not sure what you mean/.test(bud), bud.replace(/\n/g, ' / '));
  await send(page, 'h_lis_dean', "@trav what should i do today while dad's at the conference?");
  await page.waitForTimeout(400);
  const sug = await lastTravText(page);
  check('Dean-only suggestion during Dad conference', !/not sure what you mean/.test(sug), sug.replace(/\n/g, ' / '));
  await send(page, 'h_lis_dean', '@trav get 2 tickets for benfica vs porto');
  await page.waitForTimeout(400);
  const match = await lastTravText(page);
  check('soccer match ask answered', !/not sure what you mean/.test(match), match.replace(/\n/g, ' / '));
  await shot(page, 'lis-ui-03-asks');
  await page.getByTestId('clock-end_of_trip').click();
  await thread.getByTestId('card-wrapped').last().waitFor({ timeout: 8000 });
  await thread.getByTestId('card-wrapped').last().scrollIntoViewIfNeeded();
  await shot(page, 'lis-ui-04-wrapped');
  check('Lisbon Wrapped renders', true);

  // TCI
  await page.getByTestId('trip-grp_turks_caicos').click();
  await page.getByTestId('group-name').filter({ hasText: /TCI/i }).waitFor();
  await shot(page, 'tci-ui-01-open');
  await send(page, 'h_tci_dean', '@trav roast mode on');
  await page.waitForTimeout(400);
  const rm = await lastTravText(page);
  check('roast mode blocked (minor)', /under 18/.test(rm), rm.replace(/\n/g, ' / '));
  await send(page, 'h_tci_dean', '@trav any good clubs or bars tonight? lily can come lol');
  await page.waitForTimeout(400);
  const nl = await lastTravText(page);
  check('nightlife redirected to all-ages', !/club|bar\b/i.test(nl.replace(/clubs or bars tonight/i, '')) && /four of you/.test(nl), nl.replace(/\n/g, ' / '));
  await shot(page, 'tci-ui-02-nightlife');
  await send(page, 'h_tci_dad', '@trav snorkel tour for all 4 on monday morning');
  const sp = thread.getByTestId('card-booking_proposal').last();
  await sp.waitFor({ timeout: 8000 });
  await page.getByTestId('sendas-h_tci_lily').click();
  check('Lily (minor) has no Approve button', (await sp.getByTestId('action-approve').count()) === 0);
  await page.getByTestId('sendas-h_tci_dad').click();
  await sp.getByTestId('action-approve').click();
  await thread.getByTestId('card-receipt').last().waitFor({ timeout: 8000 });
  check('Dad DM holds 2 tickets (his + Lily)', (await page.getByTestId('dm-tab-mem_tci_dad').getAttribute('data-count')) === '2');
  check('Lily DM has no ticket', (await page.getByTestId('dm-tab-mem_tci_lily').getAttribute('data-count')) === '0');
  await thread.getByTestId('card-receipt').last().scrollIntoViewIfNeeded();
  await shot(page, 'tci-ui-03-snorkel-receipt');
  const ns = await noStackTrace(page);
  check('no stack traces / error banner', ns.ok, ns.detail);
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('journey ran without exception', false, String(e).slice(0, 300));
  await shot(page, 'lis-tci-ui-XX-failure');
} finally {
  await browser.close();
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
