/**
 * Scenario files: `packages/evals/scenarios/*.json`, each holding one
 * scenario or an array of them. Validated strictly on load, so a typo fails
 * loudly instead of turning a check into a silent no-op that reports "ok":
 *
 * - every object (scenario, setup, scenario expect, step, step expect and
 *   its nested blocks, probe args) allows only the keys its type declares;
 * - each step kind's required fields are present with the right types;
 * - enums (tags, lanes, sources, categories, model sources, probe names,
 *   trip names, consent flags) are checked against their lists;
 * - SAFETY ids (`checklist`, `expect.identity.safetyId`) must exist in the
 *   `docs/SAFETY.md` §3 checklist; weight keys must name a grader.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './arch/repo.js';
import { checklistTitle } from './checklist.js';
import { TRIP_NAMES } from './fixtures.js';
import { GRADERS } from './graders/index.js';
import type { ProbeName, Scenario, ScenarioTag, Step } from './types.js';
import { PROBE_NAMES, SCENARIO_TAGS } from './types.js';

export function scenariosDir(): string {
  return join(repoRoot(), 'packages', 'evals', 'scenarios');
}

const SAFETY_ID = /^[A-H][0-9]{1,2}$/;
const TASK_ID = /^T-\d{3}(?:-[a-z])?$/;

class ScenarioError extends Error {}

function fail(where: string, msg: string): never {
  throw new ScenarioError(`scenario ${where}: ${msg}`);
}

// ---------- a tiny schema checker ----------

type Check = (v: unknown, at: string) => void;

interface Field {
  readonly check: Check;
  readonly required?: boolean;
}

type Shape = Readonly<Record<string, Field>>;

const req = (check: Check): Field => ({ check, required: true });
const opt = (check: Check): Field => ({ check });

function describe(v: unknown): string {
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

const str: Check = (v, at) => {
  if (typeof v !== 'string' || v.length === 0) fail(at, `must be a non-empty string, got ${describe(v)}`);
};
const bool: Check = (v, at) => {
  if (typeof v !== 'boolean') fail(at, `must be true or false, got ${describe(v)}`);
};
const num: Check = (v, at) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(at, `must be a number, got ${describe(v)}`);
};
const int: Check = (v, at) => {
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(at, `must be an integer, got ${describe(v)}`);
};
const nonNegInt: Check = (v, at) => {
  int(v, at);
  if ((v as number) < 0) fail(at, `must be ≥ 0, got ${describe(v)}`);
};
const unit: Check = (v, at) => {
  num(v, at);
  if ((v as number) < 0 || (v as number) > 1) fail(at, `must be between 0 and 1, got ${describe(v)}`);
};
function oneOf(values: readonly string[]): Check {
  return (v, at) => {
    if (typeof v !== 'string' || !values.includes(v))
      fail(at, `must be one of ${values.join(', ')}, got ${describe(v)}`);
  };
}
function arrayOf(item: Check, opts: { nonEmpty?: boolean } = {}): Check {
  return (v, at) => {
    if (!Array.isArray(v)) fail(at, `must be an array, got ${describe(v)}`);
    if (opts.nonEmpty === true && v.length === 0) fail(at, 'must not be empty');
    v.forEach((x: unknown, i) => item(x, `${at}[${String(i)}]`));
  };
}
const strs = arrayOf(str);
const strOrStrs: Check = (v, at) => (Array.isArray(v) ? strs(v, at) : str(v, at));
const record: Check = (v, at) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    fail(at, `must be an object, got ${describe(v)}`);
};
function recordOf(value: Check): Check {
  return (v, at) => {
    record(v, at);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) value(x, `${at}.${k}`);
  };
}
function object(shape: Shape): Check {
  return (v, at) => {
    record(v, at);
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!(k in shape))
        fail(at, `unknown key "${k}" (allowed: ${Object.keys(shape).sort().join(', ')})`);
    }
    for (const [k, f] of Object.entries(shape)) {
      if (o[k] === undefined) {
        if (f.required === true) fail(at, `missing required "${k}"`);
        continue;
      }
      f.check(o[k], `${at}.${k}`);
    }
  };
}
const safetyIdCheck: Check = (v, at) => {
  if (typeof v !== 'string' || !SAFETY_ID.test(v) || checklistTitle(v) === '')
    fail(at, `must be a docs/SAFETY.md §3 checklist id like "A9", got ${describe(v)}`);
};
const tripName = oneOf(TRIP_NAMES);

// ---------- scenario-level shapes ----------

const CONSENT_FLAGS = ['photos', 'roast', 'cardImport', 'emailImport', 'memoryAcrossTrips'];

const SETUP: Shape = {
  group: opt(tripName),
  startAt: opt(str),
  fixtureExtras: opt(bool),
  settings: opt(record),
  consent: opt(recordOf(object(Object.fromEntries(CONSENT_FLAGS.map((f) => [f, opt(bool)]))))),
  privateStrings: opt(strs),
};

const SCENARIO_EXPECT: Shape = {
  auditOrder: opt(arrayOf(str, { nonEmpty: true })),
  maxPurchases: opt(nonNegInt),
  mentionPrecision: opt(unit),
  mentionRecall: opt(unit),
  ledgerGroundTruth: opt(tripName),
  tickets: opt(object({ to: req(strs), notTo: req(strs) })),
};

// ---------- step shapes ----------

const STEP_EXPECT: Shape = {
  silent: opt(bool),
  note: opt(strOrStrs),
  toolCalls: opt(strs),
  modelSource: opt(oneOf(['script', 'fallback', 'live'])),
  mustContain: opt(strs),
  mustNotContain: opt(strs),
  text: opt(str),
  audit: opt(strs),
  injection: opt(
    object({
      patterns: req(arrayOf(str, { nonEmpty: true })),
      document: opt(bool),
      expectPendingItem: opt(bool),
    }),
  ),
  identity: opt(
    object({
      safetyId: req((v, at) => {
        oneOf(['E2', 'E3', 'E5'])(v, at);
        safetyIdCheck(v, at);
      }),
      invalidAttemptCause: opt(str),
      noEffect: opt(bool),
    }),
  ),
  proposal: opt(
    object({
      attendees: req(strs),
      payers: req(strs),
      excluded: opt(strs),
      totalMinor: opt(nonNegInt),
      status: opt(oneOf(['pending'])),
    }),
  ),
  expense: opt(
    object({
      paidBy: req(str),
      amountMinor: req(int),
      shares: req(arrayOf(object({ memberId: req(str), amountMinor: req(int) }))),
    }),
  ),
  purchases: opt(nonNegInt),
  explicitAdultAudience: opt(arrayOf(str, { nonEmpty: true })),
};

const BASE: Shape = {
  do: req(str),
  id: opt(str),
  expect: opt(object(STEP_EXPECT)),
  source: opt(str),
  at: opt(str),
  cardRef: opt(str),
};

const PROBE_ARGS: Readonly<Record<ProbeName, Shape>> = {
  mentions: {},
  flights: {},
  ledger: { trips: req(arrayOf(tripName, { nonEmpty: true })) },
  album_consent: { trip: req(tripName) },
  roast_screen: {},
  minor_screen: {},
};

const STEPS: Readonly<Record<Step['do'], Shape>> = {
  say: {
    ...BASE,
    from: req(str),
    text: req(str),
    lane: opt(oneOf(['group', 'dm'])),
    replyTo: opt(str),
    displayName: opt(str),
    attachments: opt(
      arrayOf(
        object({
          kind: req(oneOf(['image', 'video', 'file', 'audio'])),
          mimeType: req(str),
          uri: req(str),
          fileName: opt(str),
        }),
        { nonEmpty: true },
      ),
    ),
  },
  react: { ...BASE, from: req(str), target: req(str), reaction: req(str) },
  tap: { ...BASE, from: req(str), target: req(str), actionId: req(str) },
  advance: { ...BASE, minutes: opt(nonNegInt), to: opt(str), drain: opt(bool) },
  drain: { ...BASE },
  intake: {
    ...BASE,
    owner: req(str),
    source: req(
      oneOf([
        'email_receipt',
        'receipt_ocr',
        'provider_listing',
        'host_message',
        'photo_caption',
        'card_descriptor',
      ]),
    ),
    itemId: req(str),
    text: req(str),
    extracted: opt(
      object({ amountMinor: req(int), currency: req(str), merchantDisplay: req(str) }),
    ),
  },
  remember: {
    ...BASE,
    memberId: req(str),
    text: req(str),
    category: req(
      oneOf(['preference', 'dietary', 'budget', 'logistics', 'constraint', 'other']),
    ),
    lane: req(oneOf(['private', 'group'])),
  },
  set_attendance: {
    ...BASE,
    activityId: req(str),
    memberId: req(str),
    status: req(oneOf(['in', 'out', 'maybe'])),
  },
  patch_member: { ...BASE, memberId: req(str), patch: req(record) },
  replay: {
    ...BASE,
    chat: req(tripName),
    fromId: opt(str),
    toId: opt(str),
    ids: opt(arrayOf(str, { nonEmpty: true })),
  },
  injection: { ...BASE, fixture: req(str) },
  probe: { ...BASE, probe: req(oneOf(PROBE_NAMES)), args: opt(record) },
};

export const STEP_KINDS: readonly Step['do'][] = Object.keys(STEPS) as Step['do'][];

function validateStep(raw: unknown, at: string): void {
  record(raw, at);
  const kind = (raw as { do?: unknown }).do;
  if (typeof kind !== 'string' || !(kind in STEPS))
    fail(at, `unknown kind ${describe(kind)} (kinds: ${STEP_KINDS.join(', ')})`);
  const k = kind as Step['do'];
  object(STEPS[k])(raw, at);
  const s = raw as Record<string, unknown>;
  if (k === 'advance' && s['minutes'] === undefined && s['to'] === undefined)
    fail(at, 'advance needs "minutes" or "to"');
  if (k === 'advance' && s['minutes'] !== undefined && s['to'] !== undefined)
    fail(at, 'advance takes "minutes" or "to", not both');
  if (k === 'replay' && s['ids'] !== undefined && (s['fromId'] ?? s['toId']) !== undefined)
    fail(at, 'replay takes "ids" or a "fromId"/"toId" range, not both');
  if (k === 'probe') {
    const probe = s['probe'] as ProbeName;
    object(PROBE_ARGS[probe])(s['args'] ?? {}, `${at}.args`);
  }
}

// ---------- scenarios ----------

const GRADER_IDS: readonly string[] = [
  ...GRADERS.map((g) => g.id),
  'runner',
  'checklist_coverage',
];

const SCENARIO: Shape = {
  id: req(str),
  title: req(str),
  tags: req(arrayOf(oneOf(SCENARIO_TAGS), { nonEmpty: true })),
  checklist: opt(arrayOf(safetyIdCheck)),
  pending: opt(str),
  pendingNote: opt(str),
  setup: opt(object(SETUP)),
  steps: req(arrayOf(record, { nonEmpty: true })),
  weights: opt(
    (v, at) => {
      recordOf(num)(v, at);
      for (const [k, w] of Object.entries(v as Record<string, number>)) {
        if (!GRADER_IDS.includes(k))
          fail(`${at}.${k}`, `unknown grader (graders: ${GRADER_IDS.join(', ')})`);
        if (w < 0) fail(`${at}.${k}`, 'weight must be ≥ 0');
      }
    },
  ),
  expect: opt(object(SCENARIO_EXPECT)),
  rubric: opt(arrayOf(str, { nonEmpty: true })),
};

export function validateScenario(raw: unknown, where: string): Scenario {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(where, 'not an object');
  const s = raw as Record<string, unknown>;
  const id = s['id'];
  if (typeof id !== 'string' || !/^[a-z0-9_.:-]+$/.test(id)) fail(where, `bad id ${String(id)}`);
  const at = `${where}#${id}`;
  object(SCENARIO)(raw, at);
  const tags = s['tags'] as ScenarioTag[];
  if (tags.includes('regression') && tags.includes('heldout')) {
    fail(at, 'a scenario cannot be both regression and heldout');
  }
  const checklist = s['checklist'] as string[] | undefined;
  if (tags.includes('safety') && (checklist === undefined || checklist.length === 0)) {
    fail(at, 'safety scenarios must name their SAFETY §3 checklist ids');
  }
  const pending = s['pending'];
  if (pending !== undefined && (typeof pending !== 'string' || !TASK_ID.test(pending))) {
    fail(at, `pending must be a task id like T-030, got ${String(pending)}`);
  }
  if (s['pendingNote'] !== undefined && pending === undefined) {
    fail(at, 'pendingNote without pending');
  }
  if (pending !== undefined && tags.includes('regression')) {
    fail(
      at,
      'a pending (known-gap) scenario cannot be in the regression suite; drop pending once it passes',
    );
  }
  (s['steps'] as unknown[]).forEach((step, i) => validateStep(step, `${at} step ${String(i)}`));
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
