/**
 * @trav/agent: Trav's loop, prompts, model client, tools, memory, approvals
 * and the single BookingExecutor. Imports @trav/core and @trav/adapters.
 */
export const PACKAGE_NAME = '@trav/agent';

export * from './model/client.js';
export * from './tools/registry.js';
export * from './memory/index.js';
export * from './booking/executor.js';
export * from './context/groupContext.js';
export * from './approval/events.js';
export * from './untrusted.js';
export * from './mention.js';
export * from './outbound/send.js';
export * from './loop.js';
