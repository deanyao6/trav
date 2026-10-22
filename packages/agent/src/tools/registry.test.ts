import type { ToolContext } from './registry.js';
import { TravError } from '@trav/core';
import { describe, expect, it } from 'vitest';
import {
  createToolRegistry,
  FORBIDDEN_TOOL_NAME_PATTERN,
  isForbiddenToolName,
  V0_TOOL_NAMES,
} from './registry.js';
import type { ToolDefinition } from './registry.js';

function tool(
  name: string,
  extra: Partial<ToolDefinition<{ n: number }, number>> = {},
): ToolDefinition<{ n: number }, number> {
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    parse: (input) => {
      const n = (input as { n?: unknown } | null)?.n;
      if (typeof n !== 'number') throw new TravError('invalid_argument', 'n must be a number');
      return { n };
    },
    handler: (input) => Promise.resolve(input.n * 2),
    ...extra,
  };
}

const ctx = (lane: 'group' | 'dm'): ToolContext => ({ lane }) as unknown as ToolContext;

describe('tool registry (SAFETY §2.1 A2)', () => {
  it('V0_TOOL_NAMES is exactly the v0 tool set', () => {
    expect([...V0_TOOL_NAMES]).toEqual([
      'propose_booking',
      'get_pending_proposals',
      'cancel_proposal',
      'search_events',
      'search_flights',
      'search_lodging',
      'get_roster',
      'set_attendance',
      'log_expense',
      'get_balances',
      'get_group_memory',
      'remember',
      'get_settings',
      'request_settings_change',
      'get_my_pending_items',
    ]);
  });

  it('no v0 tool name matches the forbidden pattern, and all of them register', () => {
    const r = createToolRegistry();
    for (const name of V0_TOOL_NAMES) {
      expect(isForbiddenToolName(name)).toBe(false);
      r.register(tool(name));
    }
    expect(r.names()).toEqual([...V0_TOOL_NAMES]);
  });

  it.each([
    'purchase',
    'purchase_tickets',
    'buy_tickets',
    'charge',
    'charge_card',
    'pay',
    'pay_host',
    'refund',
    'refund_booking',
    'execute_booking',
    'delete_ledger_entry',
    'transfer_funds',
    'send_money',
    'Purchase',
    'approve_proposal',
    'grant_approval',
    'confirm_booking',
    'delete_expense',
    'remove_member',
    'undo_expense',
    'checkout',
    'place_order',
  ])('refuses to register "%s"', (name) => {
    const r = createToolRegistry({ allowedNames: [...V0_TOOL_NAMES] });
    expect(() => r.register(tool(name))).toThrow(TravError);
    try {
      r.register(tool(name));
    } catch (e) {
      expect((e as TravError).code).toBe('invalid_argument');
    }
    expect(r.names()).toEqual([]);
  });

  it('the pattern spares "payer" names (get_payers is not a payment)', () => {
    expect(FORBIDDEN_TOOL_NAME_PATTERN.test('get_payers')).toBe(false);
  });

  it('a forbidden name cannot be smuggled in through allowedNames', () => {
    expect(() => createToolRegistry({ allowedNames: ['purchase_tickets'] })).toThrow(/forbidden/);
  });

  it('rejects names outside the allowed list, bad shapes, duplicates, empty descriptions, non-object schemas', () => {
    const r = createToolRegistry();
    expect(() => r.register(tool('web_browse'))).toThrow(/allowed tool list/);
    expect(() => r.register(tool('Get-Roster'))).toThrow(/snake_case/);
    r.register(tool('get_roster'));
    expect(() => r.register(tool('get_roster'))).toThrow(
      expect.objectContaining({ code: 'duplicate' }) as Error,
    );
    expect(() => r.register(tool('get_balances', { description: '  ' }))).toThrow(/description/);
    expect(() => r.register(tool('get_settings', { inputSchema: { type: 'string' } }))).toThrow(
      /object schema/,
    );
  });

  it('keeps dmOnly tools off the group lane (list, specs and run)', async () => {
    const r = createToolRegistry();
    r.register(tool('get_roster'));
    r.register(tool('get_my_pending_items', { dmOnly: true }));
    expect(r.list('group').map((t) => t.name)).toEqual(['get_roster']);
    expect(r.specs('group').map((t) => t.name)).toEqual(['get_roster']);
    expect(r.specs('dm').map((t) => t.name)).toEqual(['get_roster', 'get_my_pending_items']);
    expect(r.specs('dm')[0]).toEqual({
      name: 'get_roster',
      description: 'the get_roster tool',
      inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    });
    await expect(r.run('get_my_pending_items', { n: 1 }, ctx('group'))).rejects.toMatchObject({
      code: 'not_authorized',
    });
    await expect(r.run('get_my_pending_items', { n: 1 }, ctx('dm'))).resolves.toBe(2);
  });

  it('run validates input via parse and rejects unknown tools', async () => {
    const r = createToolRegistry();
    r.register(tool('get_roster'));
    await expect(r.run('get_roster', { n: 21 }, ctx('group'))).resolves.toBe(42);
    await expect(r.run('get_roster', { n: 'x' }, ctx('group'))).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    await expect(r.run('purchase', {}, ctx('group'))).rejects.toMatchObject({ code: 'not_found' });
    expect(r.get('purchase')).toBeUndefined();
  });
});
