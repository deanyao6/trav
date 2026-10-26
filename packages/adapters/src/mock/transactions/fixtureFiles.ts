/**
 * Fixture *validators* shared by the private-data mocks (transactions, email,
 * album). Reading the files is `../fixtures.ts` (`loadFixture`), the package's
 * one fixture loader (T-059); this module only checks parsed JSON.
 */
import { TravError } from '@trav/core';

// ---------- tiny validators shared by the three mocks (fixture errors are programmer errors) ----------

export type Obj = Record<string, unknown>;

export function fixtureFail(where: string, msg: string): never {
  throw new TravError('invalid_argument', `fixture ${where}: ${msg}`);
}

export function asObj(v: unknown, where: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    fixtureFail(where, 'expected an object');
  return v as Obj;
}

export function asArr(v: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(v)) fixtureFail(where, 'expected an array');
  return v;
}

export function str(o: Obj, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '')
    fixtureFail(`${where}.${key}`, 'expected a non-empty string');
  return v;
}

export function optStr(o: Obj, key: string, where: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fixtureFail(`${where}.${key}`, 'expected a string');
  return v;
}

export function optNum(o: Obj, key: string, where: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v))
    fixtureFail(`${where}.${key}`, 'expected a number');
  return v;
}

export function bool(o: Obj, key: string, where: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') fixtureFail(`${where}.${key}`, 'expected a boolean');
  return v;
}

/** Recursively freezes a plain JSON-like value and returns it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}
