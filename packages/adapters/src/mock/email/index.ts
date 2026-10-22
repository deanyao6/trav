export { createMockEmailReceiptSource } from './source.js';
export type { InboundDelivery, MockEmailReceiptSource, MockEmailSourceOptions } from './source.js';
export {
  EMAIL_WARNINGS,
  createOfflineReceiptEmailParser,
  scanEmailForInjection,
} from './parser.js';
export { loadEmailFixtures, parseEmailFixture } from './fixture.js';
export type { EmailFixture } from './fixture.js';
