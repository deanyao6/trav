// Shared helpers for the fixture generator. Pure Node built-ins only.
// Everything here is deterministic: no wall clock, no Math.random.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const written = [];

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

export function writeJson(rel, data) {
  const path = join(FIXTURES_DIR, rel);
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  written.push(rel);
}

export function writeJsonl(rel, rows) {
  const path = join(FIXTURES_DIR, rel);
  ensureDir(path);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  written.push(rel);
}

export function writeBinary(rel, buf) {
  const path = join(FIXTURES_DIR, rel);
  ensureDir(path);
  writeFileSync(path, buf);
  written.push(rel);
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`fixture invariant failed: ${msg}`);
}

// ---------- seeded randomness ----------

export function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    chance(p) {
      return next() < p;
    },
  };
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// ---------- money ----------

export const money = (amountMinor, currency) => ({ amountMinor, currency });
export const eur = (amountMinor) => money(amountMinor, 'EUR');
export const usd = (amountMinor) => money(amountMinor, 'USD');

// ---------- time (explicit offsets; instants never depend on the host zone) ----------

const OFFSET_RE = /([+-])(\d{2}):(\d{2})$/;

export function offsetMinutes(offset) {
  if (offset === 'Z') return 0;
  const m = OFFSET_RE.exec(offset);
  assert(m, `bad offset ${offset}`);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

export function offsetOf(iso) {
  const m = OFFSET_RE.exec(iso);
  return m ? m[0] : 'Z';
}

/** Format an instant (epoch ms) as `YYYY-MM-DDTHH:MM:SS±hh:mm` in the given offset. */
export function isoAt(ms, offset) {
  const local = new Date(ms + offsetMinutes(offset) * 60_000).toISOString().slice(0, 19);
  return `${local}${offset}`;
}

/** Local wall-clock `YYYY-MM-DDTHH:MM` plus offset → ISO with seconds. */
export function local(wall, offset) {
  const withSec = wall.length === 16 ? `${wall}:00` : wall;
  return `${withSec}${offset}`;
}

export function addMinutes(iso, minutes, offset = offsetOf(iso)) {
  return isoAt(Date.parse(iso) + minutes * 60_000, offset);
}

export function minutesBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60_000);
}

export function isoDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0 && m === 0) return 'PT0M';
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}`;
}

// ---------- splits (reference implementation; see README "Rounding") ----------

/**
 * Split `total` by integer/rational weights. Floor each share, then:
 * if the payer is a participant the payer absorbs the whole remainder
 * (VOICE §4.4); otherwise one minor unit at a time to the largest
 * fractional remainder, ties to the lowest index (money.allocate order).
 */
export function allocateWeighted(total, entries, payer) {
  const W = entries.reduce((s, e) => s + e.weight, 0);
  assert(W > 0, 'weights must sum > 0');
  const raw = entries.map((e) => (total * e.weight) / W);
  const floors = raw.map((r) => (total >= 0 ? Math.floor(r) : Math.ceil(r)));
  let rem = total - floors.reduce((s, f) => s + f, 0);
  const shares = entries.map((e, i) => ({ memberId: e.memberId, amountMinor: floors[i] }));
  const payerIdx = entries.findIndex((e) => e.memberId === payer);
  if (rem !== 0 && payerIdx >= 0) {
    shares[payerIdx].amountMinor += rem;
    rem = 0;
  }
  const order = raw
    .map((r, i) => ({ i, frac: Math.abs(r - floors[i]) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  let k = 0;
  while (rem !== 0) {
    const step = rem > 0 ? 1 : -1;
    shares[order[k % order.length].i].amountMinor += step;
    rem -= step;
    k += 1;
  }
  return shares;
}

export function splitEqual(total, participants, payer) {
  return allocateWeighted(
    total,
    participants.map((memberId) => ({ memberId, weight: 1 })),
    payer,
  );
}

/**
 * Itemized: each `item` line splits equally among `claimedBy` (empty ⇒ all
 * participants); tax/tip/service/fee/discount lines are allocated pro-rata to
 * each member's item subtotal.
 */
export function splitItemized(lineItems, participants, payer) {
  const sub = new Map(participants.map((m) => [m, 0]));
  for (const li of lineItems.filter((l) => l.kind === 'item')) {
    const who = li.claimedBy.length ? li.claimedBy : participants;
    for (const s of splitEqual(li.amount.amountMinor, who, payer)) {
      sub.set(s.memberId, (sub.get(s.memberId) ?? 0) + s.amountMinor);
    }
  }
  const out = new Map(sub);
  const weighted = [...sub.entries()]
    .filter(([, v]) => v > 0)
    .map(([memberId, weight]) => ({ memberId, weight }));
  for (const li of lineItems.filter((l) => l.kind !== 'item')) {
    for (const s of allocateWeighted(li.amount.amountMinor, weighted, payer)) {
      out.set(s.memberId, out.get(s.memberId) + s.amountMinor);
    }
  }
  return participants
    .filter((m) => out.get(m) !== 0)
    .map((memberId) => ({ memberId, amountMinor: out.get(memberId) }));
}

/** Shares for any core SplitSpec. `allMembers` is the active member list (for `exclude`). */
export function computeShares(split, totalMinor, payer, allMembers) {
  switch (split.method) {
    case 'equal':
      return splitEqual(totalMinor, split.participants, payer);
    case 'exclude':
      return splitEqual(
        totalMinor,
        allMembers.filter((m) => !split.excluded.includes(m)),
        payer,
      );
    case 'weighted':
      return allocateWeighted(totalMinor, split.weights, payer);
    case 'exact':
      return split.amounts.map((a) => ({ memberId: a.memberId, amountMinor: a.amount.amountMinor }));
    case 'itemized':
      return splitItemized(split.lineItems, split.participants, payer);
    default:
      throw new Error(`unknown split ${split.method}`);
  }
}

export function sumShares(shares) {
  return shares.reduce((s, x) => s + x.amountMinor, 0);
}

// ---------- offline script keys (mirrors packages/agent/src/model/offline/scripts.ts) ----------

export function normalizeScriptText(text) {
  return text
    .replace(/(<untrusted\b[^>]*?\sid=)"[^"]*"/gi, '$1""')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function scriptKey(model, systemPromptId, text, toolNames) {
  const tools = [...toolNames].sort().join(',');
  return sha256(`${model}\n${systemPromptId}\n${normalizeScriptText(text)}\n${tools}`);
}

// ---------- injection patterns (mirror of packages/agent/src/untrusted.ts, SAFETY §2.4) ----------

export const INJECTION_PATTERNS = [
  ['ignore_instructions', /ignore (?:all |any |the )?(?:previous|prior|above|earlier|all|your)? ?(?:instructions|rules|prompts?)/i],
  ['system_prompt', /system prompt/i],
  ['you_are_now', /you are now/i],
  ['as_an_ai', /as an ai/i],
  ['disregard', /disregard/i],
  ['approve_all', /approve all/i],
  ['send_money', /send (?:money|payment|funds)/i],
  ['transfer_to', /transfer .{0,80}? to/i],
  ['api_key', /api[_ -]?key/i],
  ['password', /password/i],
  ['at_trav', /@trav/i],
  ['trav_command', /trav,? (?:book|buy|pay|approve|split|add)/i],
  ['markup_tag', /<\s*\/?\s*(?:system|untrusted|tool)/i],
  ['url', /https?:\/\//i],
];

// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

export function detectInjection(text) {
  const norm = text.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ');
  return INJECTION_PATTERNS.filter(([, re]) => re.test(norm)).map(([name]) => name);
}

// ---------- tools ----------

export const V0_TOOL_NAMES = [
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
];
/** Group lane = every tool except the dmOnly one (registry.specs('group')). */
export const GROUP_LANE_TOOLS = V0_TOOL_NAMES.filter((t) => t !== 'get_my_pending_items');
export const DM_LANE_TOOLS = V0_TOOL_NAMES;

/** Prompt ids used by scripts. See README "Offline scripts". */
export const PROMPT_IDS = {
  chat: 'group_chat_v1',
  dm: 'dm_chat_v1',
  mention: 'mention_v1',
  looksShared: 'looks_shared_v1',
  expenseParse: 'expense_parse_v1',
  receipt: 'receipt_extract_v1',
  email: 'email_extract_v1',
  roastGuard: 'roast_guard_v1',
};
