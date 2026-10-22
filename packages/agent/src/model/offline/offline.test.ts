import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ClassifyRequest, CompletionRequest } from '../client.js';
import { wrapUntrusted } from '../../untrusted.js';
import {
  bookingIntentResponder,
  createReceiptFixtureResponder,
  createRoastGuardResponder,
  extractBookingIntent,
  looksSharedHeuristicResponder,
  mentionRuleResponder,
  toolResultAckResponder,
} from './fallbacks.js';
import { deriveScriptKey, lastUserText, normalizeScriptText } from './scripts.js';

const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' } });

function req(text: string, tools = ['propose_booking', 'get_roster']): CompletionRequest {
  return {
    model: 'main',
    systemPromptId: 'group_chat_v1',
    system: 's',
    messages: [{ role: 'user', content: text }],
    tools: tools.map(tool),
  };
}

function cls<L extends string>(
  classifierId: string,
  labels: readonly L[],
  input: string,
): ClassifyRequest<L> {
  return { classifierId, labels, systemPromptId: classifierId, system: 's', input };
}

describe('deriveScriptKey', () => {
  it('is sha256 of model, prompt id, normalized last user text and sorted tool names', () => {
    const expected = createHash('sha256')
      .update('main\ngroup_chat_v1\nhello trav\nget_roster,propose_booking')
      .digest('hex');
    expect(deriveScriptKey(req('  Hello\n\tTRAV  '))).toBe(expected);
  });

  it('is stable under tool order, case and whitespace; sensitive to model, prompt id, tools', () => {
    const base = deriveScriptKey(req('hello trav'));
    expect(deriveScriptKey(req('HELLO   trav', ['get_roster', 'propose_booking']))).toBe(base);
    expect(deriveScriptKey({ ...req('hello trav'), model: 'fast' })).not.toBe(base);
    expect(deriveScriptKey({ ...req('hello trav'), systemPromptId: 'other' })).not.toBe(base);
    expect(deriveScriptKey(req('hello trav', ['get_roster']))).not.toBe(base);
  });

  it('keys on the LAST user message only', () => {
    const r: CompletionRequest = {
      ...req('x'),
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    };
    expect(lastUserText(r)).toBe('second');
    expect(deriveScriptKey(r)).toBe(deriveScriptKey(req('second')));
  });

  it('strips untrusted block ids so the same document always hits', () => {
    const a = req(wrapUntrusted('TOTAL 84', 'receipt_ocr', 'priv_aaa'), []);
    const b = req(wrapUntrusted('TOTAL 84', 'receipt_ocr', 'priv_bbb'), []);
    expect(deriveScriptKey(a)).toBe(deriveScriptKey(b));
    expect(normalizeScriptText('<untrusted source="x" id="abc">')).toBe(
      '<untrusted source="x" id="">',
    );
  });

  it('images contribute their sha256', () => {
    const img = (data: string): CompletionRequest => ({
      ...req('x', []),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              mediaType: 'image/png',
              dataBase64: Buffer.from(data).toString('base64'),
            },
            { type: 'text', text: 'extract' },
          ],
        },
      ],
    });
    const hash = createHash('sha256').update('png-bytes-1').digest('hex');
    expect(lastUserText(img('png-bytes-1'))).toBe(`[image sha256:${hash}]\nextract`);
    expect(deriveScriptKey(img('png-bytes-1'))).not.toBe(deriveScriptKey(img('png-bytes-2')));
  });

  it('classify uses fast model, classifierId and input', () => {
    const expected = createHash('sha256').update('fast\nmention_v1\n@trav hi\n').digest('hex');
    expect(deriveScriptKey(cls('mention_v1', ['mention', 'not_mention'], '@Trav  hi'))).toBe(
      expected,
    );
  });
});

describe('fallback responders', () => {
  it('mention_v1: start-of-message address only, biased to silence', () => {
    const labels = ['mention', 'not_mention'] as const;
    const at = (t: string) => mentionRuleResponder.classify?.(cls('mention_v1', labels, t))?.label;
    expect(at('@trav who is in tonight')).toBe('mention');
    expect(at('hey trav, split dinner')).toBe('mention');
    expect(at('trav, book it')).toBe('mention');
    expect(at('trav booked it already')).toBe('not_mention');
    expect(at('lol did trav do that')).toBe('not_mention');
    expect(mentionRuleResponder.classify?.(cls('other_v1', labels, '@trav'))).toBeUndefined();
    expect(mentionRuleResponder.classify?.(cls('mention_v1', ['a', 'b'], '@trav'))).toBeUndefined();
  });

  it('looks_shared_v1: merchant keywords', () => {
    const labels = ['shared', 'personal', 'unsure'] as const;
    const at = (t: string) =>
      looksSharedHeuristicResponder.classify?.(cls('looks_shared_v1', labels, t))?.label;
    expect(at('Rydr ride, uber-style, 23.40 EUR')).toBe('shared');
    expect(at(wrapUntrusted('TAPAS 24 dinner for 6', 'receipt_ocr', 'r'))).toBe('shared');
    expect(at('Farmacia Catalunya 12.00')).toBe('personal');
    expect(at('SQ *XYZ 9.00')).toBe('unsure');
  });

  it('roast_guard_v1: blocks SAFETY §2.8 categories, allows spending', () => {
    const r = createRoastGuardResponder();
    const at = (t: string) =>
      r.classify?.(cls('roast_guard_v1', ['allowed', 'blocked'] as const, t))?.label;
    expect(at("henry's sick so he missed razzmatazz")).toBe('blocked');
    expect(at('maya was so drunk')).toBe('blocked');
    expect(at('leo spent €140 on ubers in one day')).toBe('allowed');
    expect(at('dean was late to the airport again')).toBe('allowed');
  });

  it('booking_intent_v1: extracts quantity, query and exclusions', () => {
    expect(
      extractBookingIntent("@trav get the 5 of us Razzmatazz tickets, Henry's sick"),
    ).toMatchObject({
      kind: 'ticket',
      quantity: 5,
      query: 'razzmatazz',
      excludedNames: ['Henry'],
    });
    expect(extractBookingIntent('@trav book all six of us barça tickets')).toMatchObject({
      quantity: 6,
      query: 'barça',
    });
    expect(
      extractBookingIntent('@trav grab the four of us sagrada familia tickets except Sam'),
    ).toMatchObject({
      quantity: 4,
      excludedNames: ['Sam'],
    });
    expect(extractBookingIntent('we should get tickets at some point')).toBeUndefined();
  });

  it('booking_intent_v1: only when propose_booking is offered, never on a tool-result turn', () => {
    const text = "@trav get the 5 of us Razzmatazz tickets, Henry's sick";
    expect(bookingIntentResponder.complete?.(req(text, ['get_roster']))).toBeUndefined();
    expect(bookingIntentResponder.complete?.(req(text))?.toolCalls[0]?.name).toBe(
      'propose_booking',
    );
    const toolTurn: CompletionRequest = {
      ...req(text),
      messages: [
        { role: 'user', content: text },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'propose_booking', input: {} }],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: text }] },
      ],
    };
    expect(bookingIntentResponder.complete?.(toolTurn)).toBeUndefined();
    expect(toolResultAckResponder.complete?.(toolTurn)).toMatchObject({ text: '', toolCalls: [] });
    expect(toolResultAckResponder.complete?.(req(text))).toBeUndefined();
  });

  it('receipt_extract_v1: answers by image hash only', () => {
    const bytes = Buffer.from('receipt-png');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const r = createReceiptFixtureResponder((h) => (h === hash ? { total: 8400 } : undefined));
    const mk = (data: Buffer): CompletionRequest => ({
      ...req('x', []),
      systemPromptId: 'receipt_extract_v1',
      jsonSchema: { type: 'object' },
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', mediaType: 'image/png', dataBase64: data.toString('base64') }],
        },
      ],
    });
    expect(r.complete?.(mk(bytes))?.json).toEqual({ total: 8400 });
    expect(r.complete?.(mk(Buffer.from('other')))).toBeUndefined();
  });
});
