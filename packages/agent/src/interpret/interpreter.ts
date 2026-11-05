/**
 * The model-first read of a member's message (T-183, D-047).
 *
 * One `interpret_v1` completion through the one spend-guarded model client
 * (`model/client.ts`; `TRAV_MODEL`), offering only the strict tools in
 * `schemas.ts`. The tool call goes through `validate.ts`; what comes out is
 * the flows' own input types, so the expense flow and the roster write path
 * apply every money and roster rule exactly as they do to a parsed message.
 *
 * Nothing this returns can approve or buy: approval stays the D-042
 * whitelist on the raw text and auto-buy stays `autoBuyVerdict` (code), and
 * a booking ask is `chat`, so the chat loop's `propose_booking` makes a
 * proposal that goes through `ApprovalPolicy` and the audit log.
 *
 * A fallback response (offline, no script) is `chat`: offline, the loop
 * runs the parsers (the scripted model) instead and never calls this.
 */
import type { Member } from '@trav/core';
import { sanitizeInline } from '../context/groupContext.js';
import type { ModelClient, ResponseSource } from '../model/client.js';
import { interpretSystemPrompt } from '../prompts/interpret.js';
import { INTERPRET_PROMPT_ID, INTERPRET_TOOLS } from './schemas.js';
import { interpretToolCalls, type Interpretation, type InterpretContext } from './validate.js';

export interface InterpretInput {
  readonly me: Member;
  /** Every member of the group (guests and leavers are rejected by the validator). */
  readonly members: readonly Member[];
  readonly ctx: InterpretContext;
  /** The sender's own words: quoted and forwarded lines already removed (SAFETY §2.4). */
  readonly text: string;
  readonly plans: readonly string[];
  readonly openCard: boolean;
}

export interface InterpretResult {
  readonly interpretation: Interpretation;
  readonly source: ResponseSource;
}

export interface Interpreter {
  interpret(input: InterpretInput): Promise<InterpretResult>;
}

export function createInterpreter(deps: { readonly model: ModelClient }): Interpreter {
  return {
    async interpret(input) {
      const memberNames = input.ctx.members.map((m) => sanitizeInline(m.displayName, 40));
      const res = await deps.model.complete({
        model: 'main',
        systemPromptId: INTERPRET_PROMPT_ID,
        system: interpretSystemPrompt({
          memberNames,
          senderName: sanitizeInline(input.me.displayName, 40),
          tripCurrency: input.ctx.tripCurrency,
          plans: input.plans.slice(0, 6).map((p) => sanitizeInline(p, 40)),
          openCard: input.openCard,
        }),
        messages: [
          {
            role: 'user',
            content: `${sanitizeInline(input.me.displayName, 40)}: ${sanitizeInline(input.text, 600)}`,
          },
        ],
        tools: INTERPRET_TOOLS,
        maxTokens: 800,
      });
      if (res.source === 'fallback') {
        return { interpretation: { kind: 'chat', reason: 'no_read' }, source: res.source };
      }
      return {
        interpretation: interpretToolCalls(res.toolCalls, {
          ctx: input.ctx,
          members: input.members,
        }),
        source: res.source,
      };
    },
  };
}
