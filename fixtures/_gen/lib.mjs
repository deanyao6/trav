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

// ---------- splits (independent port of packages/core/src/ledger/splits.ts; README "Rounding") ----------
//
// One remainder rule for every mode: odd minor units go to the LARGEST
// fractional remainder first; ties go to the payer, then to the other
// participants in group member order. For equal splits every fraction ties,
// so the payer gets the first odd cent, the next participant the second, and
// so on. Itemized receipts are rounded once over exact per-member fractions.
// `packages/core/src/ledger/fixtures.test.ts` checks these numbers against core.

const big = (n) => BigInt(n);

function gcdBig(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function rat(num, den) {
  const g = gcdBig(num, den);
  return g > 1n ? { num: num / g, den: den / g } : { num, den };
}

const RAT0 = { num: 0n, den: 1n };
const ratAdd = (a, b) => rat(a.num * b.den + b.num * a.den, a.den * b.den);

function floorDiv(num, den) {
  const q = num / den;
  return num < 0n && q * den !== num ? q - 1n : q;
}

/** Participants in member order, with the payer moved to the front (tie-break priority). */
function priorityOf(participants, payer, memberOrder) {
  const ordered = memberOrder.filter((m) => participants.includes(m));
  assert(ordered.length === participants.length, `unknown participant in ${participants.join(',')}`);
  return ordered.includes(payer) ? [payer, ...ordered.filter((m) => m !== payer)] : ordered;
}

/** Round exact entitlements (summing to `totalMinor`) by largest remainder; ties by `priority` index. */
function roundEntitlements(entitlements, totalMinor, priority) {
  const rows = priority.map((memberId, index) => {
    const e = entitlements.get(memberId) ?? RAT0;
    const floor = floorDiv(e.num, e.den);
    return { memberId, index, floor, frac: e.num - floor * e.den, den: e.den };
  });
  let leftover = big(totalMinor) - rows.reduce((s, r) => s + r.floor, 0n);
  assert(leftover >= 0n && leftover <= big(rows.length), 'entitlements do not sum to the total');
  const byRemainder = [...rows].sort((a, b) => {
    const l = a.frac * b.den;
    const r = b.frac * a.den;
    if (l !== r) return l > r ? -1 : 1;
    return a.index - b.index;
  });
  const out = new Map(rows.map((r) => [r.memberId, Number(r.floor)]));
  for (const r of byRemainder) {
    if (leftover === 0n) break;
    out.set(r.memberId, Number(r.floor) + 1);
    leftover -= 1n;
  }
  return out;
}

function weightedEntitlements(totalMinor, entries) {
  const W = entries.reduce((s, e) => s + big(e.weight), 0n);
  assert(W > 0n, 'weights must sum > 0');
  for (const e of entries) assert(Number.isInteger(e.weight) && e.weight > 0, 'fixture weights are positive integers');
  return new Map(entries.map((e) => [e.memberId, rat(big(totalMinor) * big(e.weight), W)]));
}

const lineValue = (l) => (l.kind === 'discount' ? -Math.abs(l.amount.amountMinor) : l.amount.amountMinor);

function itemizedEntitlements(lineItems, participants) {
  const sub = new Map(participants.map((m) => [m, RAT0]));
  const addEach = (target, owners, amount) => {
    const part = rat(big(amount), big(owners.length));
    for (const m of owners) target.set(m, ratAdd(target.get(m) ?? RAT0, part));
  };
  let itemTotal = 0n;
  const adjustments = [];
  for (const l of lineItems) {
    if (l.kind !== 'item') {
      adjustments.push(l);
      continue;
    }
    itemTotal += big(lineValue(l));
    addEach(sub, l.claimedBy.length ? l.claimedBy : participants, lineValue(l));
  }
  const ent = new Map(sub);
  let unclaimed = 0n;
  for (const l of adjustments) {
    if (l.claimedBy.length) addEach(ent, l.claimedBy, lineValue(l));
    else unclaimed += big(lineValue(l));
  }
  if (unclaimed !== 0n) {
    for (const m of participants) {
      const s = sub.get(m) ?? RAT0;
      const share = itemTotal > 0n ? rat(unclaimed * s.num, s.den * itemTotal) : rat(unclaimed, big(participants.length));
      ent.set(m, ratAdd(ent.get(m) ?? RAT0, share));
    }
  }
  return ent;
}

/**
 * Shares for any core SplitSpec, in group member order (zero shares kept, as core does).
 * `memberOrder` is the group member order; for `exclude` it is also the universe
 * (the fixtures only exclude from activities whose roster is everyone else).
 */
export function computeShares(split, totalMinor, payer, memberOrder) {
  let participants;
  let minor;
  switch (split.method) {
    case 'equal':
    case 'exclude': {
      participants = split.method === 'equal' ? split.participants : memberOrder.filter((m) => !split.excluded.includes(m));
      const pr = priorityOf(participants, payer, memberOrder);
      minor = roundEntitlements(weightedEntitlements(totalMinor, pr.map((memberId) => ({ memberId, weight: 1 }))), totalMinor, pr);
      break;
    }
    case 'weighted': {
      participants = split.weights.map((w) => w.memberId);
      const pr = priorityOf(participants, payer, memberOrder);
      minor = roundEntitlements(weightedEntitlements(totalMinor, split.weights), totalMinor, pr);
      break;
    }
    case 'exact':
      participants = split.amounts.map((a) => a.memberId);
      assert(split.amounts.reduce((s, a) => s + a.amount.amountMinor, 0) === totalMinor, 'exact amounts must sum to the total');
      minor = new Map(split.amounts.map((a) => [a.memberId, a.amount.amountMinor]));
      break;
    case 'itemized': {
      participants = split.participants;
      assert(split.lineItems.reduce((s, l) => s + lineValue(l), 0) === totalMinor, 'line items must sum to the total');
      const pr = priorityOf(participants, payer, memberOrder);
      minor = roundEntitlements(itemizedEntitlements(split.lineItems, participants), totalMinor, pr);
      break;
    }
    default:
      throw new Error(`unknown split ${split.method}`);
  }
  return memberOrder.filter((m) => participants.includes(m)).map((memberId) => ({ memberId, amountMinor: minor.get(memberId) ?? 0 }));
}

// ---------- approval policy (port of packages/core/src/approval/policy.ts `evaluate`) ----------

const MODE_RANK = { none: 0, any_one: 1, each_payer: 2 };

/**
 * Expected PolicyDecision fields for a proposal. `members`: [{ memberId, isMinor, guest?, guardianMemberId? }]
 * in group order; `prefs`: { memberId: perBookingShareCapMinor }; `spentTodayMinor`: Trav-executed
 * bookings in the 24h before the proposal. Quote staleness (D10) and duplicates (D8) are not modelled.
 */
export function evaluatePolicy(p, policy, members, { prefs = {}, spentTodayMinor = 0, spentTripMinor = 0 } = {}) {
  const reasons = [];
  const ruleIds = [];
  let mode = 'none';
  const fire = (id, reason, m = 'none') => {
    reasons.push(reason);
    ruleIds.push(id);
    if (MODE_RANK[m] > MODE_RANK[mode]) mode = m;
  };
  const byId = new Map(members.map((m) => [m.memberId, m]));
  const payerIds = p.payers.map((s) => s.memberId);
  const participantIds = [...new Set([...payerIds, ...p.attendees])];
  const isMinor = (id) => byId.get(id)?.isMinor === true;
  const requester = byId.get(p.requestedBy);
  if (!requester) fire('D1', 'requester_not_member');
  if (requester?.guest) fire('D2', 'requester_is_guest');
  if (payerIds.some((id) => !byId.has(id) || byId.get(id).guest)) fire('D3', 'payer_not_member');
  if (p.payers.length === 0) fire('D4', 'empty_payers');
  if (!(p.totalMinor > 0)) fire('D5', 'negative_or_zero_amount');
  if (p.payers.reduce((s, x) => s + x.shareMinor, 0) !== p.totalMinor) fire('D5', 'shares_do_not_sum');
  if (p.currency !== policy.currency) fire('D6', 'currency_mismatch');
  if (p.totalMinor > policy.hardMaxPerBookingMinor) fire('D7', 'over_hard_max');
  const tags = p.contentTags ?? [];
  const ageRestricted = (p.ageRestriction ?? null) !== null || tags.some((t) => t === '18+' || t === '21+');
  if (ageRestricted && participantIds.some(isMinor)) fire('D9', 'minor_age_restricted');
  const denied = reasons.length > 0;
  if (policy.autoApproveCapMinor <= 0) fire('C1', 'default_confirm', 'any_one');
  else if (p.totalMinor > policy.autoApproveCapMinor) fire('C1', 'over_auto_cap', 'any_one');
  if (policy.alwaysEachPayerKinds.includes(p.kind)) fire('C2', 'kind_requires_each_payer', 'each_payer');
  if (p.payers.some((s) => s.shareMinor > policy.perPersonAutoCapMinor)) fire('C3', 'over_per_person_cap', 'each_payer');
  if (p.payers.some((s) => prefs[s.memberId] != null && s.shareMinor > prefs[s.memberId])) fire('C4', 'over_member_share_cap', 'each_payer');
  if (!p.refundable) fire('C5', 'non_refundable', 'any_one');
  if (spentTodayMinor + p.totalMinor > policy.dailyGroupCapMinor) fire('C6', 'over_daily_cap', 'any_one');
  if (policy.tripGroupCapMinor !== null && spentTripMinor + p.totalMinor > policy.tripGroupCapMinor) fire('C7', 'over_trip_cap', 'any_one');
  if (payerIds.some(isMinor)) fire('C8', 'minor_is_payer', 'any_one');
  if (p.paidBy.kind === 'per_person_cards' && payerIds.some((id) => id !== p.requestedBy)) fire('C9', 'payer_not_requester', 'each_payer');
  const canApprove = (m) => m && !m.guest && !m.isMinor;
  if (denied) return { outcome: 'deny', reasons, ruleIds, approvalMode: 'none', requiredApprovers: [] };
  if (mode === 'none') {
    fire('A1', 'within_all_caps');
    return { outcome: 'auto_approve', reasons, ruleIds, approvalMode: 'none', requiredApprovers: [] };
  }
  let requiredApprovers;
  if (mode === 'any_one') {
    const pool = (policy.approvers === 'any_adult_member' ? members : policy.approvers.map((id) => byId.get(id))).filter(canApprove).map((m) => m.memberId);
    requiredApprovers = [...new Set(canApprove(requester) ? [...pool, requester.memberId] : pool)];
  } else {
    const req = [];
    for (const s of p.payers) {
      const m = byId.get(s.memberId);
      if (canApprove(m)) req.push(m.memberId);
      else if (m?.isMinor) req.push(canApprove(byId.get(m.guardianMemberId)) ? m.guardianMemberId : p.requestedBy);
    }
    requiredApprovers = [...new Set(req)];
  }
  return { outcome: 'needs_confirmation', reasons, ruleIds, approvalMode: mode, requiredApprovers };
}

/** VOICE §3.4 money: symbol first, whole amounts drop cents, thousands comma (mirrors core formatMoney). */
export function fmtMoney(m) {
  const sym = { EUR: '€', USD: '$', GBP: '£' }[m.currency];
  const neg = m.amountMinor < 0;
  const abs = Math.abs(m.amountMinor);
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  const num = frac === '00' ? int : `${int}.${frac}`;
  const body = sym ? `${sym}${num}` : `${m.currency} ${num}`;
  return neg ? `-${body}` : body;
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
