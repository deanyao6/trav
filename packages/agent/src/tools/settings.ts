/**
 * `get_settings` and `request_settings_change` (SAFETY §2.6 group settings,
 * §2.8 roast gate, VOICE §7.2 wording). Leads change caps and turn roast mode
 * on; anyone can turn it off; every change is audited.
 */
import type { Group, GroupSpendingPolicy } from '@trav/core';
import { formatMoney, money, safety, TravError } from '@trav/core';
import {
  ROAST_AGE_QUESTION_TEXT,
  ROAST_LEAD_ONLY_TEXT,
  ROAST_MINOR_TEXT,
  ROAST_OFF_TEXT,
  ROAST_ON_TEXT,
} from '../settings/text.js';
import type { ToolDefinition } from './registry.js';
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
const CAP_SETTINGS = [
  'autoApproveCapMinor',
  'perPersonAutoCapMinor',
  'dailyGroupCapMinor',
  'tripGroupCapMinor',
  'hardMaxPerBookingMinor',
  'approvalTtlSeconds',
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

function isBooleanChange(input: SettingsChangeInput): input is BooleanChange {
  return (BOOLEAN_SETTINGS as readonly string[]).includes(input.setting);
}

function isSelfChange(input: SettingsChangeInput): input is SelfChange {
  return (SELF_SETTINGS as readonly string[]).includes(input.setting);
}

export interface SettingsChangeResult {
  readonly kind: 'changed' | 'refused' | 'unchanged';
  readonly setting: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly text: string;
}

export const requestSettingsChangeTool: ToolDefinition<SettingsChangeInput, SettingsChangeResult> =
  {
    name: 'request_settings_change',
    description:
      'Change a group setting on a member\'s request. roastMode on, allAdultsConfirmed and every cap need a lead; roastMode off and quietMode can come from any member. awardsOptOut applies to the requester only ("no awards for me" = true). Roast mode is refused while anyone in the group is under 18 or of unconfirmed age. Returns the line to say.',
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
      const members = ctx.stores.group.members.listByGroup(ctx.groupId);
      const lead = me.role === 'lead' || me.role === 'guardian';
      const refuse = (before: unknown, text: string): SettingsChangeResult => ({
        kind: 'refused',
        setting: input.setting,
        before,
        after: before,
        text,
      });

      if (isSelfChange(input)) {
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
        const after = input.value
          ? [...list, me.memberId]
          : list.filter((id) => id !== me.memberId);
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

      if (isBooleanChange(input)) {
        const before = group.settings[input.setting];
        if (input.setting === 'roastMode' && input.value) {
          if (
            safety.groupHasMinor(members, ctx.now) ||
            safety.isFamilyMode(group, members, ctx.now)
          ) {
            return refuse(before, ROAST_MINOR_TEXT);
          }
          if (!lead) return refuse(before, ROAST_LEAD_ONLY_TEXT);
          if (safety.groupAgeUnconfirmed(group, members)) {
            return refuse(before, ROAST_AGE_QUESTION_TEXT);
          }
        }
        if (input.setting === 'allAdultsConfirmed' && !lead) {
          return refuse(before, "that's a lead call. ask one of them");
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
            : input.setting === 'quietMode'
              ? input.value
                ? "quiet mode on. i'll only speak when @'d or when money needs a decision"
                : 'quiet mode off'
              : 'noted, everyone here is 18+';
        return { kind: 'changed', setting: input.setting, before, after: input.value, text };
      }

      const policy: GroupSpendingPolicy = group.spendingPolicy;
      const capSetting: CapSetting = input.setting;
      const capValue: number | null = input.value;
      const before = policy[capSetting];
      if (!lead) return refuse(before, 'spending caps are a lead call. ask one of them');
      if (before === capValue) {
        return {
          kind: 'unchanged',
          setting: capSetting,
          before,
          after: before,
          text: 'already set that way',
        };
      }
      const after: GroupSpendingPolicy = { ...policy, [capSetting]: capValue };
      ctx.stores.group.groups.update({ ...group, spendingPolicy: after });
      ctx.stores.group.audit.append({
        groupId: ctx.groupId,
        tripId: ctx.tripId,
        type: 'policy.changed',
        actor: { kind: 'member', id: me.memberId },
        visibility: 'group',
        payload: { memberId: me.memberId, setting: input.setting, before: policy, after },
      });
      const label: Record<CapSetting, string> = {
        autoApproveCapMinor: 'auto-approve cap',
        perPersonAutoCapMinor: 'per-person cap',
        dailyGroupCapMinor: 'daily cap',
        tripGroupCapMinor: 'trip cap',
        hardMaxPerBookingMinor: 'per-booking limit',
        approvalTtlSeconds: 'approval window',
      };
      const shown =
        capValue === null
          ? 'off'
          : capSetting === 'approvalTtlSeconds'
            ? `${Math.round(capValue / 60)} min`
            : formatMoney(money(capValue, policy.currency));
      return {
        kind: 'changed',
        setting: capSetting,
        before,
        after: capValue,
        text: `${label[capSetting]} is now ${shown}`,
      };
    },
  };
