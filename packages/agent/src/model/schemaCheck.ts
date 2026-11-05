/**
 * T-214: every JSON schema the agent sends to the API is closed.
 *
 * The API's structured outputs (`output_config.format: json_schema`) reject
 * an object schema without `additionalProperties: false` with a 400, at every
 * level (T-184 live run: the rubric grader, then expense-text extraction and
 * receipt photo reads). Tool input schemas are held to the same rule so a
 * call has one shape and a key the model invents is never silently accepted.
 *
 * `openObjectPaths` lists every object level that is not closed;
 * `unsupportedOutputKeywords` lists keywords structured outputs do not take
 * (numeric and string bounds, array bounds beyond `minItems` 0/1), which the
 * parsers enforce instead. The live client refuses to send a schema with
 * either, before any spend (`assertSendableSchema`).
 */
import { TravError } from '@trav/core';
import type { JsonSchema } from './client.js';

type Node = Readonly<Record<string, unknown>>;

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

function isObjectSchema(s: Node): boolean {
  const t = s['type'];
  return (
    t === 'object' ||
    (Array.isArray(t) && t.includes('object')) ||
    isNode(s['properties']) ||
    'additionalProperties' in s
  );
}

/** Child schemas of `s`, with their path segment. */
function children(s: Node): [string, Node][] {
  const out: [string, Node][] = [];
  const props = s['properties'];
  if (isNode(props)) {
    for (const [k, v] of Object.entries(props)) if (isNode(v)) out.push([`properties.${k}`, v]);
  }
  const items = s['items'];
  if (isNode(items)) out.push(['items', items]);
  else if (Array.isArray(items)) {
    items.forEach((v: unknown, i) => {
      if (isNode(v)) out.push([`items.${String(i)}`, v]);
    });
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const) {
    const list = s[key];
    if (Array.isArray(list)) {
      list.forEach((v: unknown, i) => {
        if (isNode(v)) out.push([`${key}.${String(i)}`, v]);
      });
    }
  }
  for (const key of ['$defs', 'definitions'] as const) {
    const defs = s[key];
    if (isNode(defs)) {
      for (const [k, v] of Object.entries(defs)) if (isNode(v)) out.push([`${key}.${k}`, v]);
    }
  }
  const ap = s['additionalProperties'];
  if (isNode(ap)) out.push(['additionalProperties', ap]);
  return out;
}

function walk(s: Node, path: string, visit: (s: Node, path: string) => void, depth = 0): void {
  if (depth > 32) return;
  visit(s, path);
  for (const [seg, c] of children(s))
    walk(c, path === '' ? seg : `${path}.${seg}`, visit, depth + 1);
}

/** Paths (`''` = the root) of object schemas without `additionalProperties: false`. */
export function openObjectPaths(schema: JsonSchema): string[] {
  const out: string[] = [];
  walk(schema, '', (s, path) => {
    if (isObjectSchema(s) && s['additionalProperties'] !== false)
      out.push(path === '' ? '(root)' : path);
  });
  return out;
}

const UNSUPPORTED_OUTPUT_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
] as const;

/** `path: keyword` for every keyword structured outputs do not accept. */
export function unsupportedOutputKeywords(schema: JsonSchema): string[] {
  const out: string[] = [];
  walk(schema, '', (s, path) => {
    const at = path === '' ? '(root)' : path;
    for (const k of UNSUPPORTED_OUTPUT_KEYWORDS) if (k in s) out.push(`${at}: ${k}`);
    const min = s['minItems'];
    if (typeof min === 'number' && min > 1) out.push(`${at}: minItems ${String(min)}`);
  });
  return out;
}

/**
 * Throws `invariant_violation` (before any network call or spend) when a
 * schema would be rejected: an open object anywhere, and for an output format
 * an unsupported keyword.
 */
export function assertSendableSchema(
  schema: JsonSchema,
  where: string,
  kind: 'output' | 'tool',
): void {
  const open = openObjectPaths(schema);
  const bad = kind === 'output' ? unsupportedOutputKeywords(schema) : [];
  if (open.length === 0 && bad.length === 0) return;
  throw new TravError(
    'invariant_violation',
    `${where}: schema not sendable (${[
      ...open.map((p) => `${p}: additionalProperties must be false`),
      ...bad,
    ].join('; ')})`,
  );
}
