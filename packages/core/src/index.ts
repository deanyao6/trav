/**
 * @trav/core: domain types and pure functions. Imports nothing internal
 * (no other @trav package). See docs/ARCHITECTURE.md.
 */
export const PACKAGE_NAME = '@trav/core';

export * from './primitives.js';
export * from './errors.js';
export * from './money.js';
export * from './fx.js';
export * from './ids.js';
export * from './clock.js';
export * from './domain/index.js';
export * from './privacy.js';
export * from './cards.js';
export * from './repositories.js';

export * as ledger from './ledger/index.js';
export * as approval from './approval/index.js';
export * as audit from './audit/index.js';
export * as flights from './flights/index.js';
export * as safety from './safety/index.js';
export * as recaps from './recaps/index.js';
export * as wrapped from './wrapped/index.js';
export * as payments from './payments/index.js';
export * as tiers from './tiers/index.js';
export type { SpendingTier, TierSignal, TierInference, TierBlend } from './tiers/index.js';
