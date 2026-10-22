/**
 * Browser stand-in for `node:crypto` (aliased in vite.config.ts). `@trav/core`'s
 * root entry includes the id generator and the audit hash chain, which the UI
 * never calls. If anything in the browser ever does, fail loudly instead of
 * producing a fake hash or id.
 */
function unavailable(name: string): never {
  throw new Error(`node:crypto ${name} is not available in the simulator UI`);
}

export function randomBytes(): never {
  return unavailable('randomBytes');
}

export function createHash(): never {
  return unavailable('createHash');
}

export default { randomBytes, createHash };
