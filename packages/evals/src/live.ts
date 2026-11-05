/**
 * T-184: `pnpm eval:live`, the one-command live eval (D-049).
 *
 * `.env` ships `TRAV_OFFLINE=1` (tests and CI stay offline), and `pnpm eval
 * --live` correctly refuses to go live while that is set. This entry point is
 * the explicit opt-in:
 *
 * - it reads the env file (`TRAV_ENV_FILE`, else `<repo>/.env`); shell
 *   variables win over the file;
 * - it drops the **file's** `TRAV_OFFLINE` only. A `TRAV_OFFLINE` set in the
 *   shell keeps the run offline, and `--preflight` says so;
 * - `TRAV_STATE_DIR` defaults to `<dir of the env file>/.trav`, so a worktree
 *   pointing at the main checkout's `.env` spends against the main
 *   checkout's `.trav/spend.json`, never a fresh budget of its own;
 * - it refuses to go live (exit 2; `--preflight` explains and exits 0) when
 *   the resolved spend file is not the main checkout's `.trav/spend.json`;
 * - it always passes `--live`, and `--max-spend 10` unless the caller set a cap.
 *
 * Every other gate is unchanged: no key or an exhausted spend guard
 * (`TRAV_LIVE_BUDGET_USD`) still runs offline, and every live call still goes
 * through the spend-guarded client. Nothing here prints a value from the
 * environment or the env file (paths only). The script sets
 * `NODE_USE_ENV_PROXY=1` so Node's fetch honours `HTTPS_PROXY` when one is set.
 *
 *   pnpm eval:live --tag paraphrase            (any `pnpm eval` flags)
 *   pnpm eval:live --preflight                 (what it would do, no calls)
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { repoRoot } from './arch/repo.js';
import { main } from './cli.js';

export const DEFAULT_LIVE_MAX_SPEND_USD = 10;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The main checkout of the git repo at `root`: `root` itself when `.git` is a
 * directory; for a linked worktree (`.git` is a `gitdir: …` file), the parent
 * of the common git dir. Undefined when `root` is not a git checkout.
 */
export function mainCheckoutOf(root: string): string | undefined {
  const dotGit = join(root, '.git');
  if (!existsSync(dotGit)) return undefined;
  if (statSync(dotGit).isDirectory()) return resolve(root);
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  if (m?.[1] === undefined) return undefined;
  const gitDir = resolve(root, m[1].trim());
  const commonFile = join(gitDir, 'commondir');
  const common = existsSync(commonFile)
    ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim())
    : gitDir;
  return dirname(common);
}

function canonical(p: string): string {
  // Resolve symlinks on the longest existing prefix (/tmp → /private/tmp on macOS).
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(head.slice(dirname(head).length + 1));
    head = dirname(head);
  }
  return join(existsSync(head) ? realpathSync(head) : head, ...tail);
}

export interface LivePlan {
  /** The environment handed to the CLI. */
  readonly env: Record<string, string | undefined>;
  readonly envFile: string;
  /** `<stateDir>/spend.json` this run would spend against. */
  readonly spendFile: string;
  /** Set when the run must not go live; the CLI is not started (preflight still explains). */
  readonly refusal?: string;
  /** Lines `--preflight` adds before the CLI's own (paths and reasons, never values). */
  readonly notes: readonly string[];
}

/**
 * Pure: the environment and guard checks for a live run.
 * `dotenv` is the env file's text (undefined when there is none).
 */
export function planLive(opts: {
  readonly shell: Env;
  readonly envFile: string;
  readonly dotenv: string | undefined;
  /** The main checkout (from `mainCheckoutOf`); undefined refuses live. */
  readonly mainCheckout: string | undefined;
}): LivePlan {
  const { shell, envFile, dotenv, mainCheckout } = opts;
  const fromFile: Record<string, string | undefined> = dotenv === undefined ? {} : parseEnv(dotenv);
  delete fromFile['TRAV_OFFLINE'];
  const env: Record<string, string | undefined> = { ...fromFile };
  for (const [k, v] of Object.entries(shell)) if (v !== undefined) env[k] = v;
  const notes: string[] = [];
  const stateSet = (env['TRAV_STATE_DIR'] ?? '').trim() !== '';
  if (!stateSet) env['TRAV_STATE_DIR'] = join(dirname(resolve(envFile)), '.trav');
  // The client trims it; check (and pass on) the exact path it will use.
  const stateDir = (env['TRAV_STATE_DIR'] ?? '').trim();
  env['TRAV_STATE_DIR'] = stateDir;
  const spendFile = join(isAbsolute(stateDir) ? stateDir : resolve(stateDir), 'spend.json');
  notes.push(
    `eval:live: env file ${resolve(envFile)}${dotenv === undefined ? ' (not found)' : ''}; spend file ${spendFile}${stateSet ? ' (TRAV_STATE_DIR)' : ' (default: next to the env file)'}`,
  );
  if (shell['TRAV_OFFLINE'] !== undefined)
    notes.push(
      'eval:live: TRAV_OFFLINE is set in the shell, so this run stays offline (only the env file’s TRAV_OFFLINE is dropped); unset it to go live',
    );
  let refusal: string | undefined;
  if (mainCheckout === undefined) {
    refusal = 'cannot find the main git checkout, so the shared spend file is unknown';
  } else {
    const want = join(mainCheckout, '.trav', 'spend.json');
    if (canonical(spendFile) !== canonical(want))
      refusal = `spend file ${spendFile} is not the main checkout's ${want} (it would start a fresh budget); point TRAV_STATE_DIR or TRAV_ENV_FILE at the main checkout`;
  }
  return { env, envFile: resolve(envFile), spendFile, notes, ...(refusal ? { refusal } : {}) };
}

/** `--live` always, and a run cap unless one was given. */
export function liveArgv(argv: readonly string[]): string[] {
  const out = [...argv];
  if (!out.includes('--live')) out.unshift('--live');
  if (!out.includes('--max-spend')) out.push('--max-spend', String(DEFAULT_LIVE_MAX_SPEND_USD));
  return out;
}

export async function liveMain(
  argv: readonly string[],
  shell: Env,
  opts: {
    readonly repo?: string;
    readonly log?: (l: string) => void;
    readonly logError?: (l: string) => void;
  } = {},
): Promise<number> {
  const repo = opts.repo ?? repoRoot();
  const log = opts.log ?? ((l: string) => console.log(l));
  const logError = opts.logError ?? ((l: string) => console.error(l));
  const envFile = shell['TRAV_ENV_FILE'] ?? join(repo, '.env');
  const plan = planLive({
    shell,
    envFile,
    dotenv: existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined,
    mainCheckout: mainCheckoutOf(repo),
  });
  const preflight = argv.includes('--preflight');
  if (preflight) for (const n of plan.notes) log(n);
  if (plan.refusal !== undefined) {
    if (preflight) {
      log(`trav eval preflight: would REFUSE live: ${plan.refusal}`);
      return 0;
    }
    logError(`trav eval:live: refusing to go live: ${plan.refusal}`);
    return 2;
  }
  return main(liveArgv(argv), plan.env, log, logError);
}

if (process.argv[1] !== undefined && /live\.ts$/.test(process.argv[1])) {
  void liveMain(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
