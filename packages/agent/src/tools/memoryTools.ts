/**
 * `get_group_memory` and `remember`. Group facts live in the GroupStore and
 * may be said in the group; "remember for me" facts go to the sender's
 * PrivateStore with the lane they were said in (SAFETY §2.3 "Memory").
 */
import type { MemoryCategory } from '@trav/core';
import { safety, TravError } from '@trav/core';
import type { GroupMemory, MemberMemory } from '../memory/index.js';
import { MEMORY_CATEGORIES } from '../memory/index.js';
import { sanitizeInline } from '../context/groupContext.js';
import { detectInjection } from '../untrusted.js';
import type { ToolDefinition } from './registry.js';
import {
  activeMembers,
  asRecord,
  currentTrip,
  messageIdOf,
  nameOf,
  optEnum,
  optInt,
  optStringArray,
  reqString,
  requireMember,
  resolveMemberRef,
} from './shared.js';

/**
 * Money-trouble reasons (SAFETY roast blocklist "financial hardship"). A bare
 * "tight" only counts on a budget fact ("tight connection" is logistics).
 */
const HARDSHIP_RE =
  /\b(?:money'?s? (?:is |are )?tight|tight (?:on|with|for) (?:money|cash|funds)|(?:cash|funds|money|things|finances)(?: is| are|'s|s)? (?:really |pretty |very |so )?tight|broke|skint|strapped|struggling|can'?t afford|cannot afford|couldn'?t afford|in debt|debts?|student loans?|loans?|paycheck|payday|unemployed|laid off|lost (?:my|his|her|their) job|between jobs|financial (?:aid|troubles?|hardship|stress|problems?|issues?)|hardship|money (?:troubles?|problems?|issues?|stress)|tuition)\b/;

/** Exported for tests. */
export function isHardship(text: string, category: MemoryCategory): boolean {
  const t = text.normalize('NFKC').replace(/[‘’]/g, "'").toLowerCase();
  return HARDSHIP_RE.test(t) || (category === 'budget' && /\btight\b/.test(t));
}

/** "keep my share under €80 a day" ⇒ "keep your share under €80 a day" (said back to its owner). */
function toSecondPerson(text: string): string {
  return text
    .replace(/\bi am\b|\bi'm\b/giu, "you're")
    .replace(/\bi was\b/giu, 'you were')
    .replace(/\bmyself\b/giu, 'yourself')
    .replace(/\bmine\b/giu, 'yours')
    .replace(/\bmy\b/giu, 'your')
    .replace(/\b(?:i|me)\b/giu, 'you');
}

/**
 * The private "noted" (VOICE §3.7 DM): what was kept, and that the group
 * won't see it. A budget is a note for planning, not an enforced cap.
 */
export function privateNotedText(text: string, category: MemoryCategory): string {
  const fact = toSecondPerson(sanitizeInline(text, 140)).replace(/[\s.!]+$/u, '');
  return category === 'budget'
    ? `noted: ${fact}. it's a note for planning, not a hard cap, and the group won't see it`
    : `noted: ${fact}. just between us, the group won't see it`;
}

export function createGetGroupMemoryTool(groupMemory: GroupMemory): ToolDefinition<
  { readonly limit?: number },
  {
    readonly facts: readonly {
      readonly text: string;
      readonly category: string;
      readonly about: readonly string[];
    }[];
  }
> {
  return {
    name: 'get_group_memory',
    description:
      "What the group has said before (tastes, budgets, inside jokes, logistics) that may be repeated in the group. Members' private notes are not here.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
    parse(raw) {
      const limit = optInt(asRecord(raw), 'limit');
      return limit === undefined ? {} : { limit: Math.min(100, Math.max(1, limit)) };
    },
    async handler(input, ctx) {
      const members = activeMembers(ctx);
      const facts = groupMemory.recall(ctx.groupId, { limit: input.limit ?? 30 });
      return {
        facts: facts.map((f) => ({
          text: sanitizeInline(f.text, 200),
          category: f.category,
          about: f.aboutMemberIds.map((id) => nameOf(members, id)),
        })),
      };
    },
  };
}

export interface RememberInputRaw {
  readonly text: string;
  readonly category?: MemoryCategory;
  readonly about?: readonly string[];
  readonly scope?: 'group' | 'me';
}

export function createRememberTool(
  groupMemory: GroupMemory,
  memberMemory: MemberMemory,
): ToolDefinition<
  RememberInputRaw,
  { readonly kind: 'remembered' | 'refused'; readonly scope: 'group' | 'me'; readonly text: string }
> {
  return {
    name: 'remember',
    description:
      "Remember a fact. scope 'group' (default in the group thread): something said in the group, repeatable there. scope 'me' (default in a private thread): a fact about the sender only, kept private to them. A personal budget is scope 'me', category 'budget', the figure only (e.g. 'keep my share under €80 a day'), never why. Never store health details, money troubles, or reasons someone skipped something.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'one lowercase sentence' },
        category: { type: 'string', enum: [...MEMORY_CATEGORIES] },
        about: {
          type: 'array',
          items: { type: 'string' },
          description: 'member ids or names the fact is about',
        },
        scope: { type: 'string', enum: ['group', 'me'] },
      },
      required: ['text'],
      additionalProperties: false,
    },
    parse(raw) {
      const r = asRecord(raw);
      const out: { -readonly [K in keyof RememberInputRaw]: RememberInputRaw[K] } = {
        text: reqString(r, 'text', 240),
      };
      const category = optEnum(r, 'category', MEMORY_CATEGORIES);
      if (category !== undefined) out.category = category;
      const about = optStringArray(r, 'about');
      if (about !== undefined) out.about = about;
      const scope = optEnum(r, 'scope', ['group', 'me'] as const);
      if (scope !== undefined) out.scope = scope;
      return out;
    },
    async handler(input, ctx) {
      const me = requireMember(ctx);
      const members = activeMembers(ctx);
      const scope = input.scope ?? (ctx.lane === 'dm' ? 'me' : 'group');
      const category = input.category ?? 'other';
      const tripId = currentTrip(ctx)?.tripId ?? null;
      const messageId = messageIdOf(ctx);
      // A memory line is rendered into every later prompt, so an instruction
      // smuggled in as a "fact" would persist (SAFETY §2.4). Screen and refuse.
      const injected = detectInjection(input.text);
      if (injected.length > 0) {
        ctx.stores.group.audit.append({
          groupId: ctx.groupId,
          tripId,
          type: 'injection.detected',
          actor: { kind: 'system', id: 'trav' },
          ...(scope === 'group'
            ? { visibility: 'group' }
            : { visibility: 'owner', ownerId: me.memberId }),
          payload: {
            source: 'memory_text',
            itemId: messageId,
            matchedPattern: injected[0]!.pattern,
            patterns: injected.map((m) => m.pattern),
            excerpt: injected[0]!.excerpt,
            scope,
          },
        });
        return {
          kind: 'refused',
          scope,
          text: "that reads like an instruction, not something to remember, so i'm leaving it out",
        };
      }
      // Why someone is on a budget is theirs alone, even in their own notes
      // (T-134, SAFETY §2.3 fail closed). An error, not a refusal, so a live
      // model can retry with the figure only.
      if (isHardship(input.text, category)) {
        throw new TravError(
          'invalid_argument',
          'leave out why: store only the figure or preference the member stated, never money troubles or other personal reasons',
        );
      }
      if (scope === 'group') {
        if (ctx.lane !== 'group') {
          // Group memory holds only what was said in the group thread (SAFETY §2.3).
          return {
            kind: 'refused',
            scope,
            text: "that was said here, not in the group, so i'll keep it to you. say it in the chat if you want everyone to know",
          };
        }
        const about = (input.about ?? []).map((ref) => {
          const id = resolveMemberRef(members, ref);
          if (id === undefined) throw new TravError('not_found', `no member "${ref}" on this trip`);
          return id;
        });
        groupMemory.remember(ctx.groupId, {
          category,
          text: input.text,
          aboutMemberIds: about,
          sourceMessageId: messageId,
          sourceTripId: tripId,
          now: ctx.now,
        });
        return { kind: 'remembered', scope, text: 'noted' };
      }
      // SAFETY §2.7 rule 5: for a minor, only preferences stated in the group thread.
      if (safety.isMinor(me, ctx.now)) {
        const allowed =
          ctx.lane === 'group' &&
          (category === 'preference' || category === 'dietary' || category === 'taste');
        if (!allowed)
          return { kind: 'refused', scope, text: "i don't keep private notes for anyone under 18" };
      }
      memberMemory.remember(me.memberId, ctx.groupId, {
        category,
        text: input.text,
        aboutMemberIds: [me.memberId],
        sourceMessageId: messageId,
        sourceTripId: tripId,
        now: ctx.now,
        sourceLane: ctx.lane === 'dm' ? 'private' : 'group',
      });
      // In the group thread the reply is a group message: no echo, and no
      // "the group won't see it" (they just did).
      return {
        kind: 'remembered',
        scope,
        text: ctx.lane === 'dm' ? privateNotedText(input.text, category) : 'noted, just between us',
      };
    },
  };
}
