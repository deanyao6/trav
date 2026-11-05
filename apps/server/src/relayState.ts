/**
 * What the relay channel keeps in memory that a long-running server must not
 * lose on a restart (T-188, D-056). Stored in `GroupStore.runtime` (the T-185
 * tables), runtime-wide (`groupId: null`), ids and addresses only, no text:
 *
 * - `relay_vendor_id`: vendor message id → the Trav message id it carried.
 *   The core maps a 👍 on a vendor id back to Trav's card only for sends of
 *   its own life; after a restart the server does it from here, so a tapback
 *   on a card posted before the restart still approves that card.
 * - `relay_roster`: each group chat's participant addresses, so the channel
 *   knows the chat after a restart (a Morning After to a chat nobody has
 *   written in since the restart would otherwise be refused as unknown).
 *
 * Plus the DM directory (`resolveContact`): a handle is a member's
 * `senderId`, and a DM goes only to an address that is that member's
 * `senderId` in the stores.
 */
import type { InboundEvent, RelayChatSeed, RelayContact } from '@trav/adapters';
import type { Stores } from '@trav/core';

export const VENDOR_ID_NAMESPACE = 'relay_vendor_id';
export const ROSTER_NAMESPACE = 'relay_roster';
/** Vendor ids remembered (the core's own in-memory cap). */
export const VENDOR_ID_CAP = 10_000;

const ADDRESS = /^\+[1-9]\d{6,14}$|^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function looksLikeAddress(handle: string): boolean {
  return ADDRESS.test(handle);
}

export interface RelayState {
  /** After a send went out: remember which vendor ids carried `travId`. */
  rememberSend(travId: string, vendorIds: readonly string[]): void;
  travIdOf(vendorId: string): string | undefined;
  /** Rewrites a reaction target / quote-reply from a vendor id of an earlier life to the Trav id. */
  remap(event: InboundEvent): InboundEvent;
  /** Every chat the server knows: stored rosters, plus provisioned groups' member addresses. */
  chats(): RelayChatSeed[];
  /** Stores a chat's roster if it changed. */
  saveRoster(chatId: string, addresses: readonly string[]): void;
  /** For `createRelayChannel({ resolveContact })`. */
  resolveContact(handle: string, memberId: string): RelayContact | undefined;
}

export function createRelayState(stores: Stores, cap = VENDOR_ID_CAP): RelayState {
  const runtime = stores.group.runtime;
  // Oldest first, so the map stays bounded across restarts too.
  const order: string[] = runtime.list(VENDOR_ID_NAMESPACE, { groupId: null }).map((e) => e.key);
  const known = new Set(order);

  const rosterOf = (chatId: string): string[] | undefined => {
    const v = runtime.get(ROSTER_NAMESPACE, null, chatId)?.value as
      { readonly participants?: unknown } | undefined;
    const list = v?.participants;
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : undefined;
  };

  const travIdOf = (vendorId: string): string | undefined => {
    const v = runtime.get(VENDOR_ID_NAMESPACE, null, vendorId)?.value as
      { readonly travId?: unknown } | undefined;
    return typeof v?.travId === 'string' ? v.travId : undefined;
  };

  return {
    rememberSend(travId, vendorIds) {
      for (const vendorId of vendorIds) {
        // The latest send wins: a vendor id reused (a fake relay restarted
        // with the process) must never point a 👍 at an older card.
        runtime.put({
          namespace: VENDOR_ID_NAMESPACE,
          groupId: null,
          key: vendorId,
          value: { travId },
        });
        if (known.has(vendorId)) continue;
        known.add(vendorId);
        order.push(vendorId);
      }
      while (order.length > cap) {
        const oldest = order.shift()!;
        known.delete(oldest);
        runtime.delete(VENDOR_ID_NAMESPACE, null, oldest);
      }
    },
    travIdOf,
    remap(event) {
      if (event.type === 'reaction') {
        const travId = travIdOf(event.targetMessageId);
        return travId === undefined ? event : { ...event, targetMessageId: travId };
      }
      if (event.type === 'message' && event.replyToMessageId !== undefined) {
        const travId = travIdOf(event.replyToMessageId);
        return travId === undefined ? event : { ...event, replyToMessageId: travId };
      }
      return event;
    },
    chats() {
      const out = new Map<string, Set<string>>();
      for (const e of runtime.list(ROSTER_NAMESPACE, { groupId: null })) {
        out.set(e.key, new Set(rosterOf(e.key) ?? []));
      }
      // A provisioned group nobody has written in yet: its members' addresses.
      for (const g of stores.group.groups.list()) {
        if (g.channelKind !== 'imessage_relay') continue;
        const set = out.get(g.conversationId) ?? new Set<string>();
        for (const m of stores.group.members.listByGroup(g.groupId, { activeOnly: true })) {
          if (looksLikeAddress(m.senderId)) set.add(m.senderId);
        }
        out.set(g.conversationId, set);
      }
      return [...out].map(([chatId, set]) => ({ chatId, participants: [...set] }));
    },
    saveRoster(chatId, addresses) {
      const next = [...new Set(addresses)].sort();
      const prev = rosterOf(chatId);
      if (prev !== undefined && JSON.stringify([...prev].sort()) === JSON.stringify(next)) return;
      runtime.put({
        namespace: ROSTER_NAMESPACE,
        groupId: null,
        key: chatId,
        value: { participants: next },
      });
    },
    resolveContact(handle, memberId) {
      if (!looksLikeAddress(handle)) return undefined;
      const member = stores.group.members.get(memberId);
      if (member === undefined || member.senderId !== handle) return undefined;
      if (!member.active || member.leftAt !== undefined) return undefined;
      return { handle, address: handle, memberId, displayName: member.displayName };
    },
  };
}
