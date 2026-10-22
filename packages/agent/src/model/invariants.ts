/**
 * SAFETY §2.4, enforced in front of BOTH the live and the offline client so a
 * test of either path proves it:
 * - D2: no single model call both reads an `<untrusted>` block and has tools.
 * - Step 4: any call carrying an `<untrusted>` block has
 *   `UNTRUSTED_SYSTEM_SENTENCE` in its system prompt.
 *
 * Detection runs on NFKC-normalized text with invisible characters stripped,
 * so zero-width-space-split and fullwidth-bracket variants of the tag are caught too.
 */
import { TravError } from '@trav/core';
import { stripInvisible, UNTRUSTED_SYSTEM_SENTENCE } from '../untrusted.js';
import type { ClassifyRequest, CompletionRequest, ContentBlock } from './client.js';

/** `<untrusted`, tolerant of case and whitespace after `<`. */
const UNTRUSTED_OPEN = /<\s*untrusted/i;

/** True if `text` contains an `<untrusted` opener after normalization. */
export function containsUntrustedTag(text: string): boolean {
  return UNTRUSTED_OPEN.test(stripInvisible(text.normalize('NFKC')));
}

function blockHasUntrusted(block: ContentBlock): boolean {
  switch (block.type) {
    case 'text':
      return containsUntrustedTag(block.text);
    case 'tool_result':
      return containsUntrustedTag(block.content);
    case 'tool_use':
      return containsUntrustedTag(JSON.stringify(block.input ?? null));
    case 'image':
      return false;
  }
}

/** True if any message (the documents, not the system prompt) contains `<untrusted`. */
export function messagesHaveUntrusted(req: CompletionRequest): boolean {
  return req.messages.some((m) =>
    typeof m.content === 'string'
      ? containsUntrustedTag(m.content)
      : m.content.some(blockHasUntrusted),
  );
}

/** True if the system prompt or any message text contains `<untrusted`. */
export function hasUntrustedBlock(req: CompletionRequest): boolean {
  return containsUntrustedTag(req.system) || messagesHaveUntrusted(req);
}

/** Throws `untrusted_with_tools` when the D2 invariant would be violated. */
export function assertNoUntrustedWithTools(req: CompletionRequest): void {
  if (req.tools.length > 0 && hasUntrustedBlock(req)) {
    throw new TravError(
      'untrusted_with_tools',
      `request ${req.systemPromptId} contains an <untrusted> block and ${req.tools.length} tool(s); document text may only go to zero-tool extraction calls`,
      { systemPromptId: req.systemPromptId, toolCount: req.tools.length },
    );
  }
}

function missingSentence(id: string): TravError {
  return new TravError(
    'invalid_argument',
    `request ${id} carries an <untrusted> block but its system prompt lacks UNTRUSTED_SYSTEM_SENTENCE`,
    { systemPromptId: id },
  );
}

/** All untrusted-content rules for a completion: D2 first, then the step-4 sentence. */
export function assertUntrustedRules(req: CompletionRequest): void {
  assertNoUntrustedWithTools(req);
  if (messagesHaveUntrusted(req) && !req.system.includes(UNTRUSTED_SYSTEM_SENTENCE)) {
    throw missingSentence(req.systemPromptId);
  }
}

/** Classify calls never have tools; they still need the sentence when the input is a document. */
export function assertClassifyUntrustedRules(req: ClassifyRequest<string>): void {
  if (containsUntrustedTag(req.input) && !req.system.includes(UNTRUSTED_SYSTEM_SENTENCE)) {
    throw missingSentence(req.systemPromptId);
  }
}
