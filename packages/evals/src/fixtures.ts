/**
 * Fixture loading for the eval harness (ARCHITECTURE §8: one helper per
 * package, resolved from the repo root, never from `process.cwd()`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './arch/repo.js';

/** Absolute path of `fixtures/<rel>`. */
export function fixturePath(rel: string): string {
  return join(repoRoot(), 'fixtures', rel);
}

/** Parsed JSON at `fixtures/<rel>` (e.g. `groups/barcelona.json`). */
export function loadFixture<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(fixturePath(rel), 'utf8')) as T;
}

/** One object per non-empty line of `fixtures/<rel>` (e.g. `chats/barcelona.jsonl`). */
export function loadJsonl<T = unknown>(rel: string): T[] {
  return readFileSync(fixturePath(rel), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

/** `*.json` file names (without extension) in `fixtures/<dir>`, sorted. */
export function listFixtures(dir: string): string[] {
  return readdirSync(fixturePath(dir))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** The three reference trips (fixtures/README.md). */
export type TripName = 'barcelona' | 'lisbon' | 'turks-and-caicos';
export const TRIP_NAMES: readonly TripName[] = ['barcelona', 'lisbon', 'turks-and-caicos'];

/** Chat line as in `fixtures/chats/<trip>.jsonl` (fixtures/README.md "chat lines"). */
export interface ChatLine {
  readonly id: string;
  readonly ts: string;
  readonly kind: 'message' | 'reaction' | 'button_tap' | 'member_joined' | 'clock' | 'system';
  readonly lane: 'group' | 'direct';
  readonly senderId: string | null;
  readonly displayName?: string;
  readonly text?: string;
  readonly attachments?: readonly {
    readonly kind: 'image' | 'video' | 'file' | 'audio';
    readonly mimeType: string;
    readonly uri: string;
    readonly fileName?: string;
  }[];
  readonly reaction?: string;
  readonly target?: { readonly cardRef?: string };
  readonly actionId?: string;
  readonly value?: string;
  readonly ref?: string;
  readonly advanceTo?: string;
  /** `system` lines: what arrived, for whom, and the fixture to ingest. */
  readonly event?: string;
  readonly memberId?: string;
  readonly email?: string;
  readonly transactions?: string;
  readonly expect?: ChatLineExpect;
}

export interface ChatLineExpect {
  readonly addressed?: boolean | 'either';
  readonly action?: string | readonly string[];
  readonly cardRef?: string;
  readonly mustContain?: readonly string[];
  readonly mustNotContain?: readonly string[];
  readonly [key: string]: unknown;
}

/** Injection / adversarial fixture (`fixtures/injection/<id>.json`). */
export interface InjectionFixture {
  readonly id: string;
  readonly category: 'injection' | 'adversarial';
  readonly injected: boolean;
  readonly title: string;
  readonly vector: string;
  readonly groupId: string;
  readonly text?: string;
  readonly message?: {
    readonly senderId: string;
    readonly displayName?: string;
    readonly lane: 'group' | 'direct';
    readonly ts?: string;
    readonly text?: string;
    readonly reaction?: string;
  };
  readonly source?: {
    readonly owner?: string;
    readonly postedBy?: string;
    readonly fixture?: string;
  };
  readonly pendingProposals?: readonly string[];
  readonly expect: {
    readonly toolCalls?: number;
    readonly proposals?: number;
    readonly audit?: readonly string[];
    readonly invalidAttemptCause?: string;
    readonly action?: string | readonly string[];
    readonly expectedText?: string;
    readonly mustNotContain?: readonly string[];
    readonly extraction?: { readonly totalMinor?: number };
    readonly lowConfidenceCard?: boolean;
    readonly matchedPatterns: readonly string[];
    readonly checklist?: readonly string[];
  };
}

export function loadInjection(id: string): InjectionFixture {
  return loadFixture<InjectionFixture>(`injection/${id}.json`);
}
