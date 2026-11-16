/**
 * Thin Logger wrapper that adds a stable component prefix and gives us a
 * single chokepoint to (a) attach extra fields uniformly and (b) make
 * sure secrets in args are scrubbed before reaching `log.*`.
 *
 * The plugin never logs CCU credentials. `scrubArgs` walks args and
 * replaces any value whose property name matches /password|secret|token/i.
 */

import type { Logging } from 'homebridge';

const SECRET_KEY_RE = /password|secret|token|apikey|api[_-]?key/i;

export function scrubArgs(args: unknown[]): unknown[] {
  return args.map((a) => scrubValue(a));
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return '[redacted: depth]';
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = scrubValue(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export class PrefixedLogger {
  constructor(
    private readonly underlying: Logging,
    public readonly prefix: string,
  ) {}

  child(suffix: string): PrefixedLogger {
    return new PrefixedLogger(this.underlying, `${this.prefix}:${suffix}`);
  }

  info(message: string, ...args: unknown[]): void {
    this.underlying.info(`[${this.prefix}] ${message}`, ...scrubArgs(args));
  }
  success(message: string, ...args: unknown[]): void {
    this.underlying.success(`[${this.prefix}] ${message}`, ...scrubArgs(args));
  }
  warn(message: string, ...args: unknown[]): void {
    this.underlying.warn(`[${this.prefix}] ${message}`, ...scrubArgs(args));
  }
  error(message: string, ...args: unknown[]): void {
    this.underlying.error(`[${this.prefix}] ${message}`, ...scrubArgs(args));
  }
  debug(message: string, ...args: unknown[]): void {
    this.underlying.debug(`[${this.prefix}] ${message}`, ...scrubArgs(args));
  }
}
