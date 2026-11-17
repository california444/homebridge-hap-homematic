/**
 * Send queue for setValue (plan-sendequeue.md): only one setValue at a
 * time goes to the CCU, across BidCos-RF and HmIP-RF. Both interfaces
 * share one radio module; parallel commands lost their confirmations
 * although the CCU carried them out.
 *
 * - `enqueue()` returns at once; one worker runs one job at a time.
 * - Success: wait `gapMs`, then the next job. Failure or timeout: report
 *   it and go on at once (after a timeout the CCU may still send).
 * - A new job with the key of a waiting job replaces that job in place
 *   (dragging a blind slider sends only the last LEVEL).
 */

import type { PrefixedLogger } from '../util/logger.js';

export interface SendQueueOptions {
  log: PrefixedLogger;
  /** Upper bound for one job, ms. */
  timeoutMs: number;
  /** Pause after a successful job, ms; 0 = none. */
  gapMs: number;
}

export interface SendJob {
  /** Coalescing key, e.g. `HmIP-RF:ABC0000001:4:LEVEL`. */
  key: string;
  /** For the debug log, e.g. `ABC0000001:4 LEVEL=0.5`. */
  label: string;
  run: () => Promise<void>;
  /** Called with the error (or a SendTimeoutError) and the elapsed time. */
  onError: (err: unknown, durationMs: number) => void;
}

/** The CCU did not answer a job within `timeoutMs`. */
export class SendTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no answer within ${formatSeconds(timeoutMs)}`);
    this.name = 'SendTimeoutError';
  }
}

/** `1234` → `1.2 s`. */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export class SendQueue {
  private readonly waiting: SendJob[] = [];
  private running = false;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly opts: SendQueueOptions) {}

  /** Jobs not yet started. */
  get size(): number {
    return this.waiting.length;
  }

  enqueue(job: SendJob): void {
    if (this.stopped) {
      this.opts.log.debug('send queue stopped, dropping %s', job.label);
      return;
    }
    const i = this.waiting.findIndex((j) => j.key === job.key);
    if (i !== -1) {
      this.waiting[i] = job;
      this.opts.log.debug('queued %s (replaces waiting command)', job.label);
    } else {
      this.waiting.push(job);
      this.opts.log.debug('queued %s (%d waiting)', job.label, this.waiting.length);
    }
    if (!this.running) {
      void this.drain();
    }
  }

  /** Resolves once no job is waiting or running (tests, shutdown). */
  idle(): Promise<void> {
    if (!this.running && this.waiting.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Accept jobs again after stop(). */
  start(): void {
    this.stopped = false;
  }

  /** Drop waiting jobs and refuse new ones; the running one finishes. */
  stop(): void {
    this.stopped = true;
    if (this.waiting.length > 0) {
      this.opts.log.debug('send queue stopped, dropping %d waiting command(s)', this.waiting.length);
    }
    this.waiting.length = 0;
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      let job: SendJob | undefined;
      while ((job = this.waiting.shift()) !== undefined) {
        const ok = await this.runOne(job);
        if (ok && this.opts.gapMs > 0 && this.waiting.length > 0) {
          await delay(this.opts.gapMs);
        }
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  private async runOne(job: SendJob): Promise<boolean> {
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SendTimeoutError(this.opts.timeoutMs)), this.opts.timeoutMs);
    });
    try {
      await Promise.race([job.run(), timeout]);
      this.opts.log.debug('%s answered after %s', job.label, formatSeconds(Date.now() - started));
      return true;
    } catch (err) {
      const ms = Date.now() - started;
      this.opts.log.debug('%s failed after %s: %s', job.label, formatSeconds(ms), (err as Error).message);
      try {
        job.onError(err, ms);
      } catch {
        // reporting must never stop the queue
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
