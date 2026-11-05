/**
 * Structured logs (T-188): one JSON object per line on stdout.
 *
 * What a log line may hold is decided here, not by each caller:
 * - only the field names in `LOG_FIELDS` (anything else is dropped and counted);
 * - numbers, booleans, null, and short strings made of id-like characters
 *   (letters, digits, `_ - . : / = , ; ( )` and spaces). A string with anything
 *   else (a phone number's `+`, an email's `@`, an emoji, a quote, a newline)
 *   becomes `"[redacted]"`.
 *
 * So no caller can log a message body, a sender's address, a secret or an
 * env value by accident: there is no field for them and their characters don't
 * survive. Callers log ids, counts, kinds and notes.
 */
import type { Clock } from '@trav/core';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

export const LOG_FIELDS: ReadonlySet<string> = new Set([
  'accepted',
  'count',
  'db',
  'demo',
  'deploy',
  'detail',
  'duplicates',
  'groupId',
  'groups',
  'host',
  'ignored',
  'jobs',
  'kind',
  'lane',
  'live',
  'mode',
  'ms',
  'note',
  'outbound',
  'port',
  'publicHosts',
  'reason',
  'status',
  'tables',
  'tickMs',
  'type',
  'vendor',
]);

export const REDACTED = '[redacted]';
const MAX_STRING = 160;
const SAFE_STRING = /^[A-Za-z0-9_\-.:/=,;() ]*$/;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  readonly clock: Clock;
  /** Default: one line to stdout. */
  readonly write?: (line: string) => void;
}

function safeString(value: string): string {
  const v = value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  return SAFE_STRING.test(v) ? v : REDACTED;
}

/** The record a log line carries (exported for tests). */
export function logRecord(
  ts: string,
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {
    ts,
    level,
    event: safeString(event),
  };
  let dropped = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!LOG_FIELDS.has(key)) {
      dropped += 1;
      continue;
    }
    if (typeof value === 'string') out[key] = safeString(value);
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : null;
    else out[key] = value;
  }
  if (dropped > 0) out['droppedFields'] = dropped;
  return out;
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    write(JSON.stringify(logRecord(options.clock.now(), level, event, fields)));
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

/** An error's class name only (messages can carry payload text). */
export function errorKind(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}
