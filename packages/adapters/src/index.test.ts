import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@trav/adapters', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@trav/adapters');
  });
});
