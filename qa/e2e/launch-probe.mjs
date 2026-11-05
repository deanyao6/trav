process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/Users/deanyao/trav/.cache/ms-playwright';
const { chromium } = await import('/Users/deanyao/trav/apps/simulator/node_modules/playwright/index.mjs');
for (const args of [['--single-process'], ['--single-process', '--no-zygote', '--disable-gpu']]) {
  try {
    const b = await chromium.launch({ headless: true, args });
    console.log('launched with', args);
    await b.close();
    process.exit(0);
  } catch (e) {
    console.log('failed with', args, String(e).split('\n').find((l) => /FATAL|Permission/.test(l)) ?? String(e).slice(0, 120));
  }
}
