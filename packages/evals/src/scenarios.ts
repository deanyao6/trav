/**
 * Scenario files: `packages/evals/scenarios/*.json`, each holding one
 * scenario or an array of them. Validated on load so a typo in a tag or a
 * step kind fails loudly instead of silently grading nothing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './arch/repo.js';
import { TRIP_NAMES } from './fixtures.js';
import type { Scenario, ScenarioTag, Step } from './types.js';
import { SCENARIO_TAGS } from './types.js';

export function scenariosDir(): string {
  return join(repoRoot(), 'packages', 'evals', 'scenarios');
}

const STEP_KINDS: ReadonlySet<Step['do']> = new Set([
  'say',
  'react',
  'tap',
  'advance',
  'drain',
  'intake',
  'remember',
  'set_attendance',
  'patch_member',
  'replay',
  'injection',
  'probe',
]);

const SAFETY_ID = /^[A-H][0-9]{1,2}$/;
const TASK_ID = /^T-\d{3}(?:-[a-z])?$/;

function fail(where: string, msg: string): never {
  throw new Error(`scenario ${where}: ${msg}`);
}

export function validateScenario(raw: unknown, where: string): Scenario {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(where, 'not an object');
  const s = raw as Record<string, unknown>;
  const id = s['id'];
  if (typeof id !== 'string' || !/^[a-z0-9_.:-]+$/.test(id)) fail(where, `bad id ${String(id)}`);
  const at = `${where}#${id}`;
  if (typeof s['title'] !== 'string' || s['title'].length === 0) fail(at, 'missing title');
  const tags = s['tags'];
  if (!Array.isArray(tags) || tags.length === 0) fail(at, 'tags must be a non-empty array');
  for (const t of tags) {
    if (!SCENARIO_TAGS.includes(t as ScenarioTag)) fail(at, `unknown tag ${String(t)}`);
  }
  if (tags.includes('regression') && tags.includes('heldout')) {
    fail(at, 'a scenario cannot be both regression and heldout');
  }
  const checklist = s['checklist'];
  if (checklist !== undefined) {
    if (
      !Array.isArray(checklist) ||
      !checklist.every((c) => typeof c === 'string' && SAFETY_ID.test(c))
    ) {
      fail(at, 'checklist must list SAFETY §3 ids like "A9"');
    }
  }
  if (tags.includes('safety') && (checklist === undefined || checklist.length === 0)) {
    fail(at, 'safety scenarios must name their SAFETY §3 checklist ids');
  }
  const pending = s['pending'];
  if (pending !== undefined && (typeof pending !== 'string' || !TASK_ID.test(pending))) {
    fail(at, `pending must be a task id like T-030, got ${String(pending)}`);
  }
  if (pending !== undefined && tags.includes('regression')) {
    fail(
      at,
      'a pending (known-gap) scenario cannot be in the regression suite; drop pending once it passes',
    );
  }
  const setup = s['setup'] as Record<string, unknown> | undefined;
  if (setup?.['group'] !== undefined && !TRIP_NAMES.includes(setup['group'] as never)) {
    fail(at, `unknown group ${String(setup['group'])}`);
  }
  const steps = s['steps'];
  if (!Array.isArray(steps) || steps.length === 0) fail(at, 'steps must be a non-empty array');
  steps.forEach((step: unknown, i) => {
    const kind = (step as { do?: unknown } | null)?.do;
    if (!STEP_KINDS.has(kind as Step['do']))
      fail(at, `step ${String(i)}: unknown kind ${String(kind)}`);
  });
  return raw as Scenario;
}

/** Every scenario under `dir` (default `packages/evals/scenarios`), sorted by id; ids must be unique. */
export function loadScenarios(dir = scenariosDir()): Scenario[] {
  const out: Scenario[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const list = Array.isArray(raw) ? raw : [raw];
    list.forEach((r: unknown, i) => out.push(validateScenario(r, `${file}[${String(i)}]`)));
  }
  const seen = new Set<string>();
  for (const s of out) {
    if (seen.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`);
    seen.add(s.id);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
