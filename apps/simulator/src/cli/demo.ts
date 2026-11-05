/**
 * `pnpm demo:barcelona`: runs the Barcelona flagship journey offline through
 * the real Trav runtime (`demo/barcelona.ts`), prints the transcript as it
 * goes, writes it to `docs/DEMO_TRANSCRIPT.md`, and exits 1 if any check
 * failed.
 *
 *   --no-write   print only, leave docs/DEMO_TRANSCRIPT.md alone
 *   --quiet      print only the summary line (and failures)
 *   --relay[=photon|sendblue|bluebubbles]
 *                play it over the iMessage relay adapter and that vendor's
 *                mock relay (T-169, T-187: bluebubbles is the fake
 *                self-hosted server; docs/RELAY.md); implies --no-write so the
 *                saved transcript stays the simulator one
 *
 * Always offline: no API key is read and no model call leaves the machine
 * (the runtime is forced offline; `TRAV_OFFLINE` is set to 1 for this process).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBarcelonaDemo } from '../demo/barcelona.js';
import { relayArgs } from '../server/relay.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const TRANSCRIPT_PATH = join(REPO_ROOT, 'docs', 'DEMO_TRANSCRIPT.md');

async function main(): Promise<number> {
  process.env['TRAV_OFFLINE'] = '1';
  const relay = relayArgs(process.argv, process.env);
  const write = !process.argv.includes('--no-write') && relay === undefined;
  const quiet = process.argv.includes('--quiet');
  const result = await runBarcelonaDemo({
    ...(quiet ? {} : { onChunk: (text: string) => process.stdout.write(text) }),
    ...(relay !== undefined ? { relay: relay.vendor } : {}),
  });
  const failed = result.checks.filter((c) => !c.ok);
  if (write) writeFileSync(TRANSCRIPT_PATH, result.transcript);
  for (const c of failed) {
    console.error(`✗ ${c.step}: ${c.name}${c.detail !== undefined ? ` (${c.detail})` : ''}`);
  }
  const passed = result.checks.length - failed.length;
  console.log(
    `\n${result.ok ? 'PASS' : 'FAIL'}: ${String(passed)}/${String(result.checks.length)} checks` +
      (relay !== undefined ? ` · over the mock ${relay.vendor} relay` : '') +
      (write ? ` · transcript saved to docs/DEMO_TRANSCRIPT.md` : ''),
  );
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error('demo failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
