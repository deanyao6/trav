/**
 * Last line of defence for reports: nothing private reaches
 * `evals/reports/` even if a grader's evidence or a transcript line quotes it.
 *
 * Secrets are: each episode's `privateStrings` (the scenario's "never in the
 * group" strings), every QR payload Trav issued, and the private fields of the
 * synthetic card and email fixtures (account masks / last4, account ids,
 * email subjects). DM content is never rendered in the first place (see
 * `reports.ts`); this pass catches anything that slipped through.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './arch/repo.js';
import type { Episode } from './types.js';

export const REDACTED = '[private]';

function jsonFiles(dir: string): unknown[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
      } catch {
        return undefined;
      }
    });
}

let fixtureSecrets: readonly string[] | undefined;

/** Card masks, account ids and email subjects from the synthetic private fixtures. */
export function privateFixtureStrings(root = repoRoot()): readonly string[] {
  if (fixtureSecrets !== undefined && root === repoRoot()) return fixtureSecrets;
  const out = new Set<string>();
  for (const raw of jsonFiles(join(root, 'fixtures', 'transactions'))) {
    const accounts = (raw as { accounts?: unknown } | undefined)?.accounts;
    if (!Array.isArray(accounts)) continue;
    for (const a of accounts as { mask?: unknown; accountId?: unknown }[]) {
      if (typeof a.mask === 'string') out.add(a.mask);
      if (typeof a.accountId === 'string') out.add(a.accountId);
    }
  }
  for (const raw of jsonFiles(join(root, 'fixtures', 'emails'))) {
    const subject = (raw as { email?: { subject?: unknown } } | undefined)?.email?.subject;
    if (typeof subject === 'string') out.add(subject);
  }
  const list = [...out];
  if (root === repoRoot()) fixtureSecrets = list;
  return list;
}

/** QR payloads on ticket cards Trav sent in this episode. */
export function qrPayloads(ep: Episode): string[] {
  const out: string[] = [];
  for (const s of ep.steps) {
    for (const m of s.turn?.outbound ?? []) {
      if (m.card?.type === 'ticket') out.push(m.card.qr.payload);
    }
  }
  return out;
}

export function episodeSecrets(ep: Episode | undefined): string[] {
  if (ep === undefined) return [];
  return [...ep.privateStrings, ...qrPayloads(ep)];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces every secret (case-insensitive) with `[private]`. Numeric
 * secrets (a card's last4, an amount like `9.80`) match only as a whole
 * number, so an order id like `RZ-48213` is not mangled by the last4 `4821`. Secrets shorter than 3
 * characters are ignored (they would erase ordinary text).
 */
export function redact(text: string, secrets: readonly string[]): string {
  const uniq = [...new Set(secrets.map((s) => s.trim()).filter((s) => s.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const s of uniq) {
    const body = escapeRe(s);
    const numeric = /^[0-9][0-9.,]*$/.test(s);
    const re = numeric ? new RegExp(`(?<![0-9])${body}(?![0-9])`, 'gi') : new RegExp(body, 'gi');
    out = out.replace(re, REDACTED);
  }
  return out;
}
