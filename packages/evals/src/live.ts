/**
 * T-184: `pnpm eval:live`, the one-command live eval.
 *
 * `.env` ships `TRAV_OFFLINE=1` (tests and CI stay offline), and `pnpm eval
 * --live` correctly refuses to go live while that is set. This entry point is
 * the explicit opt-in: it reads `<repo>/.env` (shell variables win), drops
 * `TRAV_OFFLINE` from the environment it hands the CLI, always passes `--live`,
 * and adds `--max-spend 10` unless the caller gave a cap. Every other gate is
 * unchanged: no key or an exhausted spend guard (`.trav/spend.json`,
 * `TRAV_LIVE_BUDGET_USD`) still runs offline, and every live call still goes
 * through the spend-guarded client. Nothing here prints or logs a value from
 * the environment. `TRAV_ENV_FILE` points at another env file (a git worktree
 * has no `.env` of its own). The script sets `NODE_USE_ENV_PROXY=1` so Node's
 * fetch honours `HTTPS_PROXY` when one is set (a no-op otherwise).
 *
 *   pnpm eval:live --tag paraphrase            (any `pnpm eval` flags)
 *   pnpm eval:live --preflight                 (what it would do, no calls)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { repoRoot } from './arch/repo.js';
import { main } from './cli.js';

export const DEFAULT_LIVE_MAX_SPEND_USD = 10;

type Env = Readonly<Record<string, string | undefined>>;

/** The environment for a live run: `.env` under the shell's variables, `TRAV_OFFLINE` removed. */
export function liveEnv(
  shell: Env,
  dotenv: string | undefined,
): Record<string, string | undefined> {
  const fromFile = dotenv === undefined ? {} : parseEnv(dotenv);
  const out: Record<string, string | undefined> = { ...fromFile };
  for (const [k, v] of Object.entries(shell)) if (v !== undefined) out[k] = v;
  delete out['TRAV_OFFLINE'];
  return out;
}

/** `--live` always, and a run cap unless one was given. */
export function liveArgv(argv: readonly string[]): string[] {
  const out = [...argv];
  if (!out.includes('--live')) out.unshift('--live');
  if (!out.includes('--max-spend')) out.push('--max-spend', String(DEFAULT_LIVE_MAX_SPEND_USD));
  return out;
}

if (process.argv[1] !== undefined && /live\.ts$/.test(process.argv[1])) {
  const file = process.env['TRAV_ENV_FILE'] ?? join(repoRoot(), '.env');
  const env = liveEnv(process.env, existsSync(file) ? readFileSync(file, 'utf8') : undefined);
  void main(liveArgv(process.argv.slice(2)), env).then((code) => {
    process.exitCode = code;
  });
}
