/**
 * @trav/adapters: channel and provider interfaces plus their mock
 * implementations. Imports @trav/core only.
 */
export const PACKAGE_NAME = '@trav/adapters';

export type * from './interfaces/index.js';
export * from './channel/index.js';
export * from './mock/tickets/index.js';
export * from './mock/payments/index.js';
export * from './mock/flights/index.js';
export * from './mock/fx/index.js';
