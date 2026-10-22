/**
 * Offline scripts (D-006, ARCHITECTURE §4). A request is reduced to a
 * deterministic key; `fixtures/scripts/*.json` map keys to responses.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TravError } from '@trav/core';
import type {
  ClassifyRequest,
  CompletionRequest,
  ContentBlock,
  ModelRole,
  ScriptStore,
  ScriptedResponse,
  ToolCall,
} from '../client.js';

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function isClassifyRequest(
  req: CompletionRequest | ClassifyRequest<string>,
): req is ClassifyRequest<string> {
  return 'classifierId' in req;
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return `[image sha256:${sha256Hex(Buffer.from(block.dataBase64, 'base64'))}]`;
    case 'tool_result':
      return `[tool_result] ${block.content}`;
    case 'tool_use':
      return '';
  }
}

/** Raw (un-normalized) text of the last `user` message; images become `[image sha256:<hex>]`. */
export function lastUserText(req: CompletionRequest | ClassifyRequest<string>): string {
  if (isClassifyRequest(req)) return req.input;
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const msg = req.messages[i];
    if (msg?.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    return msg.content
      .map(blockText)
      .filter((t) => t.length > 0)
      .join('\n');
  }
  return '';
}

/** lowercase, trim, collapse whitespace, strip `<untrusted ... id="...">` ids. */
export function normalizeScriptText(text: string): string {
  return text
    .replace(/(<untrusted\b[^>]*?\sid=)"[^"]*"/gi, '$1""')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ScriptKeyParts {
  readonly model: ModelRole;
  readonly systemPromptId: string;
  readonly normalizedText: string;
  readonly toolNames: readonly string[];
}

export function scriptKeyParts(req: CompletionRequest | ClassifyRequest<string>): ScriptKeyParts {
  if (isClassifyRequest(req)) {
    return {
      model: 'fast',
      systemPromptId: req.classifierId,
      normalizedText: normalizeScriptText(req.input),
      toolNames: [],
    };
  }
  return {
    model: req.model,
    systemPromptId: req.systemPromptId,
    normalizedText: normalizeScriptText(lastUserText(req)),
    toolNames: req.tools.map((t) => t.name).sort(),
  };
}

/**
 * sha256 of `model \n systemPromptId \n normalize(lastUserText) \n sortedToolNames.join(',')`.
 * Classify requests use `classifierId` as the systemPromptId, `input` as the
 * text, the `fast` model and no tools.
 */
export function deriveScriptKey(req: CompletionRequest | ClassifyRequest<string>): string {
  const p = scriptKeyParts(req);
  return sha256Hex(
    `${p.model}\n${p.systemPromptId}\n${p.normalizedText}\n${p.toolNames.join(',')}`,
  );
}

/** Authoring helper: builds a script entry for `req` (tests, `TRAV_RECORD`, fixture generators). */
export function scriptFor(
  req: CompletionRequest | ClassifyRequest<string>,
  response: ScriptedResponse['response'],
  note?: string,
): ScriptedResponse {
  const p = scriptKeyParts(req);
  return {
    key: deriveScriptKey(req),
    model: p.model,
    systemPromptId: p.systemPromptId,
    lastUserText: lastUserText(req),
    toolNames: p.toolNames,
    response,
    ...(note === undefined ? {} : { note }),
  };
}

// ---------- validation and loading ----------

function fail(where: string, why: string): never {
  throw new TravError('invalid_argument', `bad offline script ${where}: ${why}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const ROLES: readonly ModelRole[] = ['main', 'fast', 'grader'];

function validateToolCalls(v: unknown, where: string): readonly ToolCall[] {
  if (!Array.isArray(v)) fail(where, 'toolCalls must be an array');
  return v.map((c, i) => {
    if (!isRecord(c) || typeof c['id'] !== 'string' || typeof c['name'] !== 'string') {
      fail(`${where}.toolCalls[${i}]`, 'needs string id and name');
    }
    return { id: c['id'], name: c['name'], input: c['input'] ?? {} };
  });
}

export function validateScriptEntry(v: unknown, where: string): ScriptedResponse {
  if (!isRecord(v)) fail(where, 'not an object');
  const key = v['key'];
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) fail(where, 'key must be sha256 hex');
  const model = v['model'];
  if (typeof model !== 'string' || !ROLES.includes(model as ModelRole)) {
    fail(where, 'model must be main|fast|grader');
  }
  const systemPromptId = v['systemPromptId'];
  if (typeof systemPromptId !== 'string') fail(where, 'systemPromptId must be a string');
  const toolNames = v['toolNames'] ?? [];
  if (!Array.isArray(toolNames) || !toolNames.every((t) => typeof t === 'string')) {
    fail(where, 'toolNames must be strings');
  }
  const r = v['response'];
  if (!isRecord(r)) fail(where, 'response missing');
  let response: ScriptedResponse['response'];
  if (r['kind'] === 'completion') {
    if (typeof r['text'] !== 'string') fail(where, 'completion.text must be a string');
    response = {
      kind: 'completion',
      text: r['text'],
      ...(r['toolCalls'] === undefined
        ? {}
        : { toolCalls: validateToolCalls(r['toolCalls'], where) }),
      ...('json' in r ? { json: r['json'] } : {}),
    };
  } else if (r['kind'] === 'classify') {
    const score = r['score'];
    if (typeof r['label'] !== 'string') fail(where, 'classify.label must be a string');
    if (typeof score !== 'number' || !(score >= 0 && score <= 1)) {
      fail(where, 'classify.score must be in [0,1]');
    }
    response = {
      kind: 'classify',
      label: r['label'],
      score,
      ...(typeof r['reason'] === 'string' ? { reason: r['reason'] } : {}),
    };
  } else {
    fail(where, 'response.kind must be completion|classify');
  }
  return {
    key,
    model: model as ModelRole,
    systemPromptId,
    lastUserText: typeof v['lastUserText'] === 'string' ? v['lastUserText'] : '',
    toolNames: toolNames as string[],
    response,
    ...(typeof v['note'] === 'string' ? { note: v['note'] } : {}),
  };
}

/** In-memory store. Two entries with the same key must have identical responses. */
export function createScriptStore(entries: readonly ScriptedResponse[]): ScriptStore {
  const byKey = new Map<string, ScriptedResponse>();
  for (const e of entries) {
    const prev = byKey.get(e.key);
    if (prev && JSON.stringify(prev.response) !== JSON.stringify(e.response)) {
      throw new TravError(
        'invalid_argument',
        `conflicting offline scripts for key ${e.key.slice(0, 12)} (${e.systemPromptId})`,
      );
    }
    byKey.set(e.key, e);
  }
  return {
    lookup: (key) => byKey.get(key),
    size: () => byKey.size,
  };
}

/**
 * Loads every `*.json` under `dir` (each an array of ScriptedResponse, or an
 * object with a `scripts` array), in file-name order. A missing directory is
 * an empty store; a malformed file throws (scripts are reviewed like code).
 */
export function loadScriptStore(dir: string): ScriptStore {
  if (!existsSync(dir)) return createScriptStore([]);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const entries: ScriptedResponse[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      fail(file, 'not valid JSON');
    }
    const list = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed['scripts'])
        ? (parsed['scripts'] as unknown[])
        : fail(file, 'expected an array of scripts');
    list.forEach((entry, i) => entries.push(validateScriptEntry(entry, `${file}[${i}]`)));
  }
  return createScriptStore(entries);
}
