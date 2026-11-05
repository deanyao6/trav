/**
 * T-214: every JSON schema the agent sends is closed (`additionalProperties:
 * false` at every object level). The T-184 live run got a 400 on
 * `EXPENSE_TEXT_SCHEMA` and `RECEIPT_SCHEMA`, which broke the expense-text
 * fallback and receipt photo reads live. This walks every schema the agent
 * has (static list) and every schema a live session actually put on the wire
 * (recording transport), and checks the parsers still refuse unknown keys.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages';
import { createSimulatedClock } from '@trav/core';
import { BARCELONA_NOW } from '../compose.js';
import { INTERPRET_TOOLS } from '../interpret/schemas.js';
import { EXPENSE_TEXT_SCHEMA } from '../prompts/expenseText.js';
import { RECEIPT_SCHEMA } from '../prompts/receipt.js';
import { draftsFromModelJson } from '../ingest/expenseText.js';
import { parseReceiptJson } from '../ingest/receiptLines.js';
import { parseLogExpenseInput } from '../tools/ledger.js';
import { harness } from '../runtime.testkit.js';
import type { JsonSchema } from './client.js';
import { createModelClient, readModelEnv } from './client.js';
import { classifySchema, type LiveTransport } from './live.js';
import { assertSendableSchema, openObjectPaths, unsupportedOutputKeywords } from './schemaCheck.js';

describe('the schema walker', () => {
  it('finds every open object level: root, nested, array items, anyOf, $defs, additionalProperties schemas', () => {
    const s: JsonSchema = {
      type: 'object',
      properties: {
        a: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false },
        b: { type: 'array', items: { type: 'object', properties: {} } },
        c: { anyOf: [{ type: 'null' }, { type: 'object', properties: {} }] },
        d: { type: ['object', 'null'], properties: {} },
        e: { type: 'object', additionalProperties: { type: 'object', properties: {} } },
      },
      $defs: { f: { type: 'object' } },
    };
    expect(openObjectPaths(s).sort()).toEqual(
      [
        '(root)',
        'properties.b.items',
        'properties.c.anyOf.1',
        'properties.d',
        'properties.e',
        'properties.e.additionalProperties',
        '$defs.f',
      ].sort(),
    );
    expect(
      openObjectPaths({ type: 'object', properties: {}, additionalProperties: false }),
    ).toEqual([]);
  });

  it('lists keywords structured outputs do not take', () => {
    expect(
      unsupportedOutputKeywords({
        type: 'object',
        properties: {
          a: { type: 'array', maxItems: 4, minItems: 2, items: { type: 'string', maxLength: 3 } },
          b: { type: 'integer', minimum: 1 },
          c: { type: 'array', minItems: 1, items: { type: 'string', enum: ['x'] } },
        },
        additionalProperties: false,
      }).sort(),
    ).toEqual(
      [
        'properties.a: maxItems',
        'properties.a: minItems 2',
        'properties.a.items: maxLength',
        'properties.b: minimum',
      ].sort(),
    );
  });

  it('assertSendableSchema names what is wrong', () => {
    expect(() => assertSendableSchema({ type: 'object', properties: {} }, 'x_v1', 'tool')).toThrow(
      /x_v1: schema not sendable \(\(root\): additionalProperties must be false\)/,
    );
    expect(() =>
      assertSendableSchema(
        {
          type: 'object',
          properties: { n: { type: 'integer', minimum: 1 } },
          additionalProperties: false,
        },
        'x_v1',
        'output',
      ),
    ).toThrow(/properties\.n: minimum/);
    // Tools may keep bounds (they are not structured outputs); only closure is required.
    expect(() =>
      assertSendableSchema(
        {
          type: 'object',
          properties: { n: { type: 'integer', minimum: 1 } },
          additionalProperties: false,
        },
        'x_v1',
        'tool',
      ),
    ).not.toThrow();
  });
});

describe('every agent schema is closed (static)', () => {
  const h = harness();
  const outputs: [string, JsonSchema][] = [
    ['EXPENSE_TEXT_SCHEMA', EXPENSE_TEXT_SCHEMA],
    ['RECEIPT_SCHEMA', RECEIPT_SCHEMA],
    ['classifySchema', classifySchema(['yes', 'no'])],
  ];
  const tools: [string, JsonSchema][] = [
    ...(['group', 'dm'] as const).flatMap((lane) =>
      h.runtime.tools
        .specs(lane)
        .map((t): [string, JsonSchema] => [`${lane} tool ${t.name}`, t.inputSchema]),
    ),
    ...INTERPRET_TOOLS.map((t): [string, JsonSchema] => [
      `interpret tool ${t.name}`,
      t.inputSchema,
    ]),
  ];

  it('covers the v0 tools and the interpret tools', () => {
    // 14 on the group lane (get_my_pending_items is DM-only), 15 in a DM, the interpret tools.
    expect(tools.length).toBe(14 + 15 + INTERPRET_TOOLS.length);
  });

  for (const [name, schema] of outputs) {
    it(`${name}: closed at every level, no unsupported output keywords`, () => {
      expect(openObjectPaths(schema)).toEqual([]);
      expect(unsupportedOutputKeywords(schema)).toEqual([]);
    });
  }
  for (const [name, schema] of tools) {
    it(`${name}: closed at every level`, () => {
      expect(openObjectPaths(schema)).toEqual([]);
    });
  }
});

/** A live client on a recording transport: no socket, canned replies. */
function recordingClient(reply: (p: MessageCreateParamsNonStreaming) => string) {
  const sent: MessageCreateParamsNonStreaming[] = [];
  const transport: LiveTransport = {
    async createMessage(params) {
      sent.push(params);
      return {
        id: `msg_${String(sent.length)}`,
        type: 'message',
        role: 'assistant',
        model: params.model,
        content: [{ type: 'text', text: reply(params), citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as Message;
    },
  };
  const client = createModelClient({
    env: readModelEnv({
      TRAV_ANTHROPIC_API_KEY: 'sk-test-TRAV-ONLY-0000',
      TRAV_STATE_DIR: mkdtempSync(join(tmpdir(), 'trav-schema-')),
    }),
    clock: createSimulatedClock(BARCELONA_NOW),
    transport,
  });
  return { client, sent };
}

/** OCR gets a receipt's text; structured outputs get JSON matching their schema; the rest 'ok'. */
function cannedReply(p: MessageCreateParamsNonStreaming): string {
  const system = typeof p.system === 'string' ? p.system : JSON.stringify(p.system ?? '');
  if (system.includes('you transcribe photos of receipts'))
    return 'GAT BLAU\n2 x tapas 15,00\nTOTAL 15,00 EUR\n14/03/2026 21:30';
  const schema = (
    p as {
      output_config?: {
        format?: { schema?: { properties?: Record<string, { enum?: string[] }> } };
      };
    }
  ).output_config?.format?.schema;
  const props = schema?.properties ?? {};
  if ('merchantName' in props)
    return JSON.stringify({
      source: 'restaurant',
      merchantName: 'Gat Blau',
      total: { amountMinor: 1500, currency: 'EUR' },
      occurredAt: '',
      lineItems: [
        { description: 'tapas', quantity: 2, amount: { amountMinor: 1500, currency: 'EUR' } },
      ],
      confidence: 0.9,
      warnings: [],
    });
  if ('isExpense' in props) return JSON.stringify({ isExpense: false, expenses: [] });
  if ('label' in props)
    return JSON.stringify({ label: props['label']?.enum?.[0] ?? 'x', score: 0.1 });
  return 'ok';
}

function wireSchemas(p: MessageCreateParamsNonStreaming): [string, JsonSchema][] {
  const out: [string, JsonSchema][] = [];
  const fmt = (p as { output_config?: { format?: { schema?: JsonSchema } } }).output_config?.format;
  if (fmt?.schema !== undefined) out.push(['output', fmt.schema]);
  for (const t of p.tools ?? []) {
    if ('input_schema' in t) out.push([`tool ${t.name}`, t.input_schema as JsonSchema]);
  }
  return out;
}

describe('every schema a live session sends is closed (on the wire)', () => {
  it('a DM, a group ask, an expense the parser cannot settle, and a receipt photo', async () => {
    const { client, sent } = recordingClient(cannedReply);
    const h = harness({ model: client, runtime: { voice: 'log' } });
    await h.dm('h_henry', 'what should i pack for tonight');
    await h.say('h_dean', '@trav anything fun near the beach this afternoon');
    await h.say('h_chase', '@trav the thing earlier came to like 30ish, put it on the tab for us');
    await h.say('h_piotr', '@trav split this', {
      attachments: [
        { kind: 'image', mimeType: 'image/png', uri: 'fixtures/receipts/rcpt_bcn_gatblau.png' },
      ],
    });

    expect(sent.length).toBeGreaterThan(0);
    const schemas = sent.flatMap(wireSchemas);
    expect(schemas.some(([k]) => k.startsWith('tool '))).toBe(true);
    for (const [where, schema] of schemas) {
      expect(openObjectPaths(schema), where).toEqual([]);
      if (where === 'output') expect(unsupportedOutputKeywords(schema), where).toEqual([]);
    }
    // The receipt read put RECEIPT_SCHEMA on the wire (the T-184 400).
    expect(
      schemas.some(([k, sc]) => k === 'output' && 'merchantName' in (sc['properties'] as object)),
    ).toBe(true);
  });

  it('refuses to send an open schema, before the transport or the spend guard', async () => {
    const { client, sent } = recordingClient(() => '{}');
    await expect(
      client.complete({
        model: 'main',
        systemPromptId: 'test_open_v1',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        jsonSchema: { type: 'object', properties: { a: { type: 'object', properties: {} } } },
      }),
    ).rejects.toMatchObject({ code: 'invariant_violation' });
    await expect(
      client.complete({
        model: 'main',
        systemPromptId: 'test_open_v1',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'x', description: 'x', inputSchema: { type: 'object', properties: {} } }],
      }),
    ).rejects.toMatchObject({ code: 'invariant_violation' });
    expect(sent).toEqual([]);
  });
});

describe('the parsers still reject unknown keys', () => {
  const ctx = {
    senderMemberId: 'mem_dean',
    members: [
      { memberId: 'mem_dean', displayName: 'Dean' },
      { memberId: 'mem_henry', displayName: 'Henry' },
    ],
    tripCurrency: 'EUR',
  } as unknown as Parameters<typeof draftsFromModelJson>[1];
  const expense = {
    description: 'dinner',
    category: 'food',
    amount: '84',
    currency: 'EUR',
    paidBy: 'me',
    split: { kind: 'everyone', members: [] },
    shares: [],
    weights: [],
  };

  it('expense text JSON: an extra key at any level rejects the read', () => {
    expect(draftsFromModelJson({ isExpense: true, expenses: [expense] }, ctx)).toHaveLength(1);
    for (const bad of [
      { isExpense: true, expenses: [expense], approved: true },
      { isExpense: true, expenses: [{ ...expense, approve: true }] },
      { isExpense: true, expenses: [{ ...expense, split: { kind: 'everyone', payNow: true } }] },
      {
        isExpense: true,
        expenses: [{ ...expense, shares: [{ member: 'Henry', amount: '4', x: 1 }] }],
      },
      {
        isExpense: true,
        expenses: [{ ...expense, weights: [{ member: 'Henry', weight: 2, x: 1 }] }],
      },
    ]) {
      expect(draftsFromModelJson(bad, ctx), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('receipt JSON: an extra key at any level rejects the read', () => {
    const ok = {
      source: 'restaurant',
      merchantName: 'Bar',
      total: { amountMinor: 1500, currency: 'EUR' },
      occurredAt: '',
      lineItems: [
        { description: 'tapas', quantity: 1, amount: { amountMinor: 1500, currency: 'EUR' } },
      ],
      confidence: 0.9,
      warnings: [],
    };
    expect(parseReceiptJson(ok)).not.toBeNull();
    for (const bad of [
      { ...ok, tipToAdd: 500 },
      { ...ok, total: { amountMinor: 1500, currency: 'EUR', note: 'x' } },
      { ...ok, tip: { amountMinor: 100, currency: 'EUR', extra: true } },
      { ...ok, lineItems: [{ ...ok.lineItems[0], payer: 'me' }] },
      {
        ...ok,
        lineItems: [
          {
            description: 'tapas',
            quantity: 1,
            amount: { amountMinor: 1500, currency: 'EUR', x: 1 },
          },
        ],
      },
    ]) {
      expect(parseReceiptJson(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('log_expense input: an extra key at any level is invalid_argument', () => {
    const base = {
      description: 'dinner',
      amountMinor: 8400,
      currency: 'EUR',
      split: { method: 'exclude', excluded: [] },
    };
    expect(parseLogExpenseInput(base)).toMatchObject({ amountMinor: 8400 });
    for (const bad of [
      { ...base, approve: true },
      { ...base, split: { method: 'exclude', excluded: [], payNow: true } },
      { ...base, split: { method: 'weighted', weights: [{ member: 'Dean', weight: 2, x: 1 }] } },
      { ...base, split: { method: 'exact', amounts: [{ member: 'Dean', amountMinor: 1, x: 1 }] } },
      {
        ...base,
        split: {
          method: 'itemized',
          participants: ['Dean'],
          lineItems: [{ label: 'x', amountMinor: 1, claimedBy: [], extra: 1 }],
        },
      },
    ]) {
      expect(() => parseLogExpenseInput(bad), JSON.stringify(bad)).toThrow(/unexpected field/);
    }
  });
});
