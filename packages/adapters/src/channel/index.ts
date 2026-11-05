/**
 * Channel implementations (T-006): the in-memory simulator channel, the
 * keyword fallback for button-less channels, the message-budget decorator and
 * the VOICE §9.4 transcript printer.
 */
export * from './types.js';
export * from './simulator/index.js';
export * from './keywords.js';
export * from './budget.js';
export * from './transcript.js';
// T-069: channel profiles and the capability text fallback.
export * from './profiles.js';
export * from './fallbackText.js';
// T-071: relay-line pacing (outbound) and burst debounce (inbound).
export * from './timers.js';
export * from './pacing.js';
export * from './debounce.js';
// T-169: iMessage relay channel (core, vendors, webhook receiver, env guard).
export * from './relay/index.js';
