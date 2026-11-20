/**
 * Beta-only diagnostics for heating groups (plan-gruppen 3.9). To be
 * removed once the measurements from real installations are in.
 *
 * Open questions it answers from a user's log (`grep group-diag`):
 *   1. Does a group with members confirm a written value by an event,
 *      and how fast? Is the value in getParamset a few seconds later?
 *   2. Does getValue work on groups (aiohomematic says it does not)?
 *   3. How long does VirtualDevices take to answer `init`?
 *   4. Does a group report real humidity or a placeholder?
 *
 * Only addresses of heating groups (`INT` + 7 digits), at info level so
 * no debug mode is needed. Times are ms relative to the setValue, since
 * Homebridge timestamps only show seconds.
 */

import type { PrefixedLogger } from '../util/logger.js';

export const GROUP_DIAG_PREFIX = '[group-diag]';
/** Delay of the getParamset check after a setValue. */
export const CHECK_DELAY_MS = 3_000;
/** Events up to this long after a setValue are attributed to it. */
export const ATTRIBUTE_WINDOW_MS = 10_000;

const GROUP_RE = /^INT\d{7}(?::\d+)?$/;

export function isGroupAddress(address: string): boolean {
  return GROUP_RE.test(address);
}

interface SentWrite {
  n: number;
  address: string;
  datapoint: string;
  value: unknown;
  at: number;
  events: number;
}

export interface GroupDiagnosticsOptions {
  log: PrefixedLogger;
  readValues(address: string): Promise<Record<string, unknown> | undefined>;
  getValue(address: string, datapoint: string): Promise<unknown>;
  now?: () => number;
  checkDelayMs?: number;
}

export class GroupDiagnostics {
  private readonly log: PrefixedLogger;
  private readonly opts: GroupDiagnosticsOptions;
  private readonly now: () => number;
  private readonly checkDelayMs: number;
  private seq = 0;
  private readonly recent: SentWrite[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly probed = new Set<string>();

  constructor(opts: GroupDiagnosticsOptions) {
    this.opts = opts;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.checkDelayMs = opts.checkDelayMs ?? CHECK_DELAY_MS;
  }

  /**
   * A setValue to a group is about to go out. Returns its number for
   * onSendResult(), or undefined for other addresses.
   */
  onSend(address: string, datapoint: string, value: unknown): number | undefined {
    if (!isGroupAddress(address)) return undefined;
    const write: SentWrite = {
      n: ++this.seq,
      address,
      datapoint,
      value,
      at: this.now(),
      events: 0,
    };
    this.recent.push(write);
    this.prune();
    this.info('#%d setValue %s %s=%s', write.n, address, datapoint, fmt(value));
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.check(write);
    }, this.checkDelayMs);
    timer.unref?.();
    this.timers.add(timer);
    return write.n;
  }

  /** Answer of the CCU to setValue #n (ok or the error). */
  onSendResult(n: number | undefined, err?: Error): void {
    if (n === undefined) return;
    const write = this.recent.find((w) => w.n === n);
    const ms = write ? this.now() - write.at : 0;
    if (err) {
      this.info('#%d setValue failed after %d ms: %s', n, ms, err.message);
    } else {
      this.info('#%d setValue OK after %d ms', n, ms);
    }
  }

  /** Any event for a group address (PONG excluded by the caller). */
  onEvent(address: string, datapoint: string, value: unknown): void {
    if (!isGroupAddress(address)) return;
    this.prune();
    const now = this.now();
    let write: SentWrite | undefined;
    for (let i = this.recent.length - 1; i >= 0; i--) {
      if (this.recent[i]!.address === address) {
        write = this.recent[i];
        break;
      }
    }
    if (write) {
      if (write.datapoint === datapoint) write.events++;
      this.info(
        'event %s %s=%s +%dms after #%d',
        address,
        datapoint,
        fmt(value),
        now - write.at,
        write.n,
      );
    } else {
      this.info('event %s %s=%s', address, datapoint, fmt(value));
    }
  }

  /** VirtualDevices answered `init` after `ms`. */
  onInit(reason: string, ms: number | undefined): void {
    this.info('VirtualDevices init (%s) answered after %s ms', reason, ms ?? '?');
  }

  /**
   * Once per group channel after the start: getValue on the set point
   * next to getParamset, plus mode and humidity start values.
   */
  async probe(channelAddresses: Iterable<string>): Promise<void> {
    for (const address of channelAddresses) {
      if (!isGroupAddress(address) || this.probed.has(address)) continue;
      this.probed.add(address);
      try {
        const values = await this.opts.readValues(address);
        if (!values) {
          this.info('start %s getParamset failed', address);
          continue;
        }
        const hmip = 'SET_POINT_TEMPERATURE' in values || 'SET_POINT_MODE' in values;
        const sp = hmip ? 'SET_POINT_TEMPERATURE' : 'SET_TEMPERATURE';
        const mode = hmip ? 'SET_POINT_MODE' : 'CONTROL_MODE';
        const hum = hmip ? 'HUMIDITY' : 'ACTUAL_HUMIDITY';
        let got: string;
        try {
          got = `ok ${fmt(await this.opts.getValue(address, sp))}`;
        } catch (err) {
          got = `failed (${(err as Error).message})`;
        }
        this.info(
          'start %s %s getParamset=%s getValue %s; %s=%s; %s=%s',
          address,
          sp,
          fmt(values[sp]),
          got,
          mode,
          fmt(values[mode]),
          hum,
          fmt(values[hum]),
        );
      } catch (err) {
        this.info('start %s probe failed: %s', address, (err as Error).message);
      }
    }
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private async check(write: SentWrite): Promise<void> {
    const values = await this.opts.readValues(write.address);
    const read = values ? fmt(values[write.datapoint]) : 'getParamset failed';
    this.info(
      '#%d check after %d ms: getParamset %s=%s (written %s, events %d)',
      write.n,
      this.checkDelayMs,
      write.datapoint,
      read,
      fmt(write.value),
      write.events,
    );
  }

  private prune(): void {
    const cutoff = this.now() - ATTRIBUTE_WINDOW_MS;
    while (this.recent.length > 0 && this.recent[0]!.at < cutoff) this.recent.shift();
  }

  private info(format: string, ...args: unknown[]): void {
    this.log.info(`${GROUP_DIAG_PREFIX} ${format}`, ...args);
  }
}

function fmt(v: unknown): string {
  if (v === undefined) return '(missing)';
  return typeof v === 'string' ? `"${v}"` : String(v);
}
