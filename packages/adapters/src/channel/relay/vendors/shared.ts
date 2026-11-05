/**
 * Small helpers the vendor modules share: constant-time comparisons, HMAC,
 * and defensive readers for untrusted webhook JSON.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { RelayPayloadError } from '../types.js';

/** `127.0.0.1`, `localhost` or `[::1]` (a URL's `hostname`). */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

/** An `http:` origin on loopback (a self-hosted server on the same Mac). */
export function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && isLoopbackHostname(u.hostname);
  } catch {
    return false;
  }
}

/** Constant-time string equality (false on any length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

export function hmacSha256Hex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

export type Json = Readonly<Record<string, unknown>>;

export function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function obj(v: unknown, what: string): Json {
  if (!isObject(v)) throw new RelayPayloadError(`${what} is not an object`);
  return v;
}

export function str(o: Json, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new RelayPayloadError(`${what}.${key} is missing`);
  }
  return v;
}

export function optStr(o: Json, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function optBool(o: Json, key: string): boolean | undefined {
  const v = o[key];
  return typeof v === 'boolean' ? v : undefined;
}

export function strArray(o: Json, key: string): readonly string[] | undefined {
  const v = o[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** `Retry-After` in seconds (integer form only), if present. */
export function retryAfterOf(
  headers: Readonly<Record<string, string>> | undefined,
): number | undefined {
  const raw = headers?.['retry-after'];
  if (raw === undefined || !/^\d{1,5}$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/** A vendor-supplied status or error code, kept only if it is a short plain token (it ends up in logs). */
export function safeLabel(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Za-z0-9_.-]{1,40}$/.test(value) ? value : undefined;
}

/** 408, 425, 429 and 5xx are worth retrying; other 4xx are not. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
