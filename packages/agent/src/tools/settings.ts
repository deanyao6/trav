/**
 * `get_settings` and `request_settings_change` (SAFETY §2.6 group settings,
 * §2.8 roast gate, VOICE §7.2 wording). Leads change caps and turn roast mode
 * on; anyone can turn it off; every change is audited.
 *
 * In a chat turn the change goes through the settings flow (T-017,
 * `settings/flow.ts`, via `TurnToolContext.settings`), so a change the model
 * inferred gets exactly what a typed command gets: the same gates, the
 * requester's "yes to confirm?" before a cap or the reply mode moves, and the
 * same audit. Outside a chat turn (no flow to ask through) only the changes
 * that need no confirmation apply: roast mode off (the kill switch), roast
 * mode on behind the same gates, the ages flag, and the requester's own
 * awards opt-out. Caps and reply mode then change nothing.
 */
import type { Group, Member } from '@trav/core';
import { currencyExponent, formatMoney, money, safety, TravError } from '@trav/core';
import type { SettingsCommand } from '../settings/parse.js';
import {
  ADULTS_CONFIRM_TYPED_TEXT,
  ROAST_AGE_QUESTION_TEXT,
  ROAST_LEAD_ONLY_TEXT,
  ROAST_MINOR_TEXT,
  ROAST_OFF_TEXT,
  ROAST_ON_TEXT,
} from '../settings/text.js';
import type { ToolContext, ToolDefinition } from './registry.js';
import type { TurnToolContext } from './shared.js';
import { asRecord, bad, optEnum, requireMember } from './shared.js';

export interface SettingsView {
  readonly roastMode: boolean;
  readonly familyMode: boolean;
  readonly quietMode: boolean;
  readonly allAdultsConfirmed: boolean;
  readonly retentionDays: number;
  readonly policy: {
    readonly currency: string;
    readonly autoApproveCapMinor: number;
    readonly perPersonAutoCapMinor: number;
    readonly dailyGroupCapMinor: number;
    readonly tripGroupCapMinor: number | null;
    readonly hardMaxPerBookingMinor: number;
    readonly approvalTtlSeconds: number;
    readonly perPersonCap: string;
  };
}

export function settingsView(group: Group, familyMode: boolean): SettingsView {
  const p = group.spendingPolicy;
  return {
    roastMode: group.settings.roastMode,
    familyMode,
    quietMode: group.settings.quietMode,
    allAdultsConfirmed: group.settings.allAdultsConfirmed,
    retentionDays: group.settings.retentionDays,
    policy: {
      currency: p.currency,
      autoApproveCapMinor: p.autoApproveCapMinor,
      perPersonAutoCapMinor: p.perPersonAutoCapMinor,
      dailyGroupCapMinor: p.dailyGroupCapMinor,
      tripGroupCapMinor: p.tripGroupCapMinor,
      hardMaxPerBookingMinor: p.hardMaxPerBookingMinor,
      approvalTtlSeconds: p.approvalTtlSeconds,
      perPersonCap: formatMoney(money(p.perPersonAutoCapMinor, p.currency)),
    },
  };
}

export const getSettingsTool: ToolDefinition<Record<string, never>, SettingsView> = {
  name: 'get_settings',
  description:
    'Group settings: roast mode, family mode, quiet mode, and the spending policy (per-person cap, daily cap, hard max, approval window). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  parse: (raw) => {
    asRecord(raw);
    return {};
  },
  async handler(_input, ctx) {
    const group = ctx.stores.group.groups.get(ctx.groupId);
    if (group === undefined) throw new TravError('not_found', `group ${ctx.groupId} not found`);
    const members = ctx.stores.group.members.listByGroup(ctx.groupId);
    return settingsView(group, safety.isFamilyMode(group, members, ctx.now));
  },
};

const BOOLEAN_SETTINGS = ['roastMode', 'quietMode', 'allAdultsConfirmed'] as const;
/** The approval window is fixed in v0 (VOICE §6.4: 15 minutes), so it is not here. */
const CAP_SETTINGS = [
  'autoApproveCapMinor',
  'perPersonAutoCapMinor',
  'dailyGroupCapMinor',
  'tripGroupCapMinor',
  'hardMaxPerBookingMinor',
] as const;
type BooleanSetting = (typeof BOOLEAN_SETTINGS)[number];
type CapSetting = (typeof CAP_SETTINGS)[number];

/** Per-member, for the requester only: "@trav no awards for me" (T-016). */
const SELF_SETTINGS = ['awardsOptOut'] as const;
type SelfSetting = (typeof SELF_SETTINGS)[number];

export type SettingsChangeInput =
  | { readonly setting: SelfSetting; readonly value: boolean }
  | { readonly setting: BooleanSetting; readonly value: boolean }
  | { readonly setting: CapSetting; readonly value: number | null };

type BooleanChange = Extract<SettingsChangeInput, { readonly setting: BooleanSetting }>;
type SelfChange = Extract<SettingsChangeInput, { readonly setting: SelfSetting }>;
type CapChange = Extract<SettingsChangeInput, { readonly setting: CapSetting }>;

function isBooleanChange(input: SettingsChangeInput): input is BooleanChange {
  return (BOOLEAN_SETTINGS as readonly string[]).includes(input.setting);
}

function isSelfChange(input: SettingsChangeInput): input is SelfChange {
  return (SELF_SETTINGS as readonly string[]).includes(input.setting);
}

export interface SettingsChangeResult {
  /**
   * `settings_turn`: the settings flow answered (a change, a refusal, or its
   * "yes to confirm?" question) and the loop sends the flow's own messages.
   * `needs_confirmation`: there was no flow to ask through, so nothing changed.
   */
  readonly kind: 'changed' | 'refused' | 'unchanged' | 'settings_turn' | 'needs_confirmation';
  readonly setting: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly text: string;
  /** The flow's turn note (`settings_turn` only). */
  readonly note?: string;
}

/** Integer minor units → the decimal string the settings parser produces (8000 EUR → "80.00"). */
export function minorToDecimal(amountMinor: number, currency: string): string {
  const exp = currencyExponent(currency);
  if (exp === 0) return String(amountMinor);
  const unit = 10 ** exp;
  const whole = Math.trunc(amountMinor / unit);
  const frac = String(amountMinor % unit).padStart(exp, '0');
  return `${String(whole)}.${frac}`;
}

/** The typed command a tool input stands for; undefined when none fits (un-confirming ages). */
function asCommand(input: BooleanChange | CapChange, group: Group): SettingsCommand | undefined {
  if (isBooleanChange(input)) {
    switch (input.setting) {
      case 'roastMode':
        return { kind: 'roast_mode', on: input.value };
      case 'quietMode':
        return { kind: 'set', change: { setting: 'replyMode', quiet: input.value } };
      case 'allAdultsConfirmed':
        return input.value ? { kind: 'adults_confirmed' } : undefined;
    }
  }
  const cap = input as CapChange;
  return {
    kind: 'set',
    change: {
      setting: cap.setting,
      amount: cap.value === null ? null : minorToDecimal(cap.value, group.spendingPolicy.currency),
    },
  };
}

function currentValue(group: Group, setting: BooleanSetting | CapSetting): unknown {
  return (BOOLEAN_SETTINGS as readonly string[]).includes(setting)
    ? group.settings[setting as BooleanSetting]
    : group.spendingPolicy[setting as CapSetting];
}

const CAP_NAME: Readonly<Record<CapSetting, string>> = {
  autoApproveCapMinor: 'auto-approve cap',
  perPersonAutoCapMinor: 'per-person cap',
  dailyGroupCapMinor: 'daily cap',
  tripGroupCapMinor: 'trip cap',
  hardMaxPerBookingMinor: 'per-booking max',
};

export const requestSettingsChangeTool: ToolDefinition<SettingsChangeInput, SettingsChangeResult> =
  {
    name: 'request_settings_change',
    description:
      'Ask to change a group setting on a member\'s request. roastMode on and every cap need a lead. allAdultsConfirmed true is never set here: a lead has to type "@trav everyone\'s 18+" themselves, and this returns the line pointing them to it. roastMode off and quietMode can come from any member. Caps and quietMode never change straight away: trav asks the requester to confirm first. awardsOptOut applies to the requester only ("no awards for me" = true). Roast mode is refused while anyone in the group is under 18 or of unconfirmed age. Returns the line to say.',
    inputSchema: {
      type: 'object',
      properties: {
        setting: {
          type: 'string',
          enum: [...BOOLEAN_SETTINGS, ...SELF_SETTINGS, ...CAP_SETTINGS],
        },
        value: { description: 'boolean for mode settings; integer minor units (or null) for caps' },
      },
      required: ['setting', 'value'],
      additionalProperties: false,
    },
    parse(raw) {
      const r = asRecord(raw);
      const setting = optEnum(r, 'setting', [
        ...BOOLEAN_SETTINGS,
        ...SELF_SETTINGS,
        ...CAP_SETTINGS,
      ]);
      if (setting === undefined) bad('setting is required');
      const value = r['value'];
      if ((SELF_SETTINGS as readonly string[]).includes(setting)) {
        if (typeof value !== 'boolean') bad(`${setting} takes true or false`);
        return { setting: setting as SelfSetting, value };
      }
      if ((BOOLEAN_SETTINGS as readonly string[]).includes(setting)) {
        if (typeof value !== 'boolean') bad(`${setting} takes true or false`);
        return { setting: setting as BooleanSetting, value };
      }
      if (value === null) {
        if (setting !== 'tripGroupCapMinor') bad(`${setting} cannot be null`);
        return { setting, value: null };
      }
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        bad(`${setting} takes a non-negative integer`);
      }
      return { setting: setting as CapSetting, value };
    },
    async handler(input, ctx) {
      const me = requireMember(ctx);
      const group = ctx.stores.group.groups.get(ctx.groupId);
      if (group === undefined) throw new TravError('not_found', `group ${ctx.groupId} not found`);
      if (isSelfChange(input)) return awardsOptOut(input, ctx, group, me);

      const before = currentValue(group, input.setting);
      // SAFETY SC-13 (F7): "everyone here is 18+" unlocks roast mode, so it is
      // never set by a model tool call, lead or not, through either path below.
      // Only a lead typing it (`settings/parse.ts` `adults_confirmed`, or their
      // "yes" to the age question) sets it. Un-confirming stays open.
      if (input.setting === 'allAdultsConfirmed' && input.value) {
        return {
          kind: 'needs_confirmation',
          setting: input.setting,
          before,
          after: before,
          text: ADULTS_CONFIRM_TYPED_TEXT,
        };
      }
      const gateway = (ctx as Partial<TurnToolContext>).settings;
      const cmd = asCommand(input, group);
      if (gateway !== undefined && cmd !== undefined) {
        const out = gateway.run(cmd);
        const now = ctx.stores.group.groups.get(ctx.groupId) ?? group;
        return {
          kind: 'settings_turn',
          setting: input.setting,
          before,
          after: currentValue(now, input.setting),
          text: out.text,
          note: out.note,
        };
      }
      if (
        isBooleanChange(input) &&
        (input.setting === 'roastMode' || input.setting === 'allAdultsConfirmed')
      ) {
        return directBoolean(input, ctx, group, me);
      }
      return {
        kind: 'needs_confirmation',
        setting: input.setting,
        before,
        after: before,
        text: isBooleanChange(input)
          ? "say '@trav set reply mode to quiet' or 'normal' and i'll check it with you first"
          : `say '@trav set the ${CAP_NAME[input.setting]} to' and the amount, and i'll check it with you first`,
      };
    },
  };

function awardsOptOut(
  input: SelfChange,
  ctx: ToolContext,
  group: Group,
  me: Member,
): SettingsChangeResult {
  const list = group.settings.awardsOptOut ?? [];
  const before = list.includes(me.memberId);
  if (before === input.value) {
    return {
      kind: 'unchanged',
      setting: input.setting,
      before,
      after: before,
      text: input.value ? "you're already out of the awards" : "you're already in the awards",
    };
  }
  const after = input.value ? [...list, me.memberId] : list.filter((id) => id !== me.memberId);
  ctx.stores.group.groups.update({
    ...group,
    settings: { ...group.settings, awardsOptOut: after },
  });
  ctx.stores.group.audit.append({
    groupId: ctx.groupId,
    tripId: ctx.tripId,
    type: 'settings.changed',
    actor: { kind: 'member', id: me.memberId },
    visibility: 'group',
    payload: { memberId: me.memberId, setting: input.setting, before, after: input.value },
  });
  return {
    kind: 'changed',
    setting: input.setting,
    before,
    after: input.value,
    text: input.value ? "you're out of the awards" : "you're back in the awards",
  };
}

/** Roast mode and the ages flag with no flow to ask through: the same gates, applied at once. */
function directBoolean(
  input: BooleanChange,
  ctx: ToolContext,
  group: Group,
  me: Member,
): SettingsChangeResult {
  const members = ctx.stores.group.members.listByGroup(ctx.groupId);
  const lead = me.role === 'lead' || me.role === 'guardian';
  const before = group.settings[input.setting];
  const refuse = (text: string): SettingsChangeResult => ({
    kind: 'refused',
    setting: input.setting,
    before,
    after: before,
    text,
  });
  if (input.setting === 'roastMode' && input.value) {
    if (safety.groupHasMinor(members, ctx.now) || safety.isFamilyMode(group, members, ctx.now)) {
      return refuse(ROAST_MINOR_TEXT);
    }
    if (!lead) return refuse(ROAST_LEAD_ONLY_TEXT);
    if (safety.groupAgeUnconfirmed(group, members)) return refuse(ROAST_AGE_QUESTION_TEXT);
  }
  if (input.setting === 'allAdultsConfirmed') {
    if (!lead) return refuse("that's a lead call. ask one of them");
    if (input.value && safety.groupHasMinor(members, ctx.now)) {
      return refuse("can't mark that, someone here is under 18");
    }
  }
  if (before === input.value) {
    return {
      kind: 'unchanged',
      setting: input.setting,
      before,
      after: before,
      text: 'already set that way',
    };
  }
  ctx.stores.group.groups.update({
    ...group,
    settings: { ...group.settings, [input.setting]: input.value },
  });
  ctx.stores.group.audit.append({
    groupId: ctx.groupId,
    tripId: ctx.tripId,
    type: 'settings.changed',
    actor: { kind: 'member', id: me.memberId },
    visibility: 'group',
    payload: { memberId: me.memberId, setting: input.setting, before, after: input.value },
  });
  const text =
    input.setting === 'roastMode'
      ? input.value
        ? ROAST_ON_TEXT
        : ROAST_OFF_TEXT
      : input.value
        ? 'noted, everyone here is 18+'
        : "noted. i'll ask again before anything that needs everyone to be 18+";
  return { kind: 'changed', setting: input.setting, before, after: input.value, text };
}
