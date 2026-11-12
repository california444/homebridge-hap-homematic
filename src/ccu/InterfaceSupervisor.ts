/**
 * Keeps one CCU interface (rfd or HMIPServer) subscribed (plan section 7).
 *
 *   CONNECTING ──init OK──► CONNECTED ──ping call fails──► DISCONNECTED
 *        │                     │                               │
 *        └─init fails─► DISCONNECTED ◄───────init fails────────┤
 *                              │                               │
 *                              └──ping call OK → init at once──┘
 *   CONNECTED ──no own PONG and no other callback for 90 s──► STALE ──init──► CONNECTED
 *
 * Why: after a CCU restart the CCU answers `ping` again but has forgotten
 * every subscription and never re-registers on its own (3.1, finding 14).
 * Only the PONG event proves the subscription is alive; any other callback
 * for this interface (events, foreign PONGs, listDevices, newDevices) counts
 * as well. A failing `ping` call means "unreachable"; the first successful
 * call afterwards is the restart signal.
 *
 * Retry pacing while DISCONNECTED: exponential backoff 5 s … 5 min until the
 * interface has been connected once (HMIPServer starts later than rfd), then
 * every 15 s. State changes are logged; retries only at debug level.
 */

import { EventEmitter } from 'node:events';
import type { RpcClient } from './RpcClient.js';
import type { CcuInterfaceId } from '../types.js';
import type { PrefixedLogger } from '../util/logger.js';

export type InterfaceState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'STALE' | 'DISCONNECTED' | 'STOPPED';
export type SubscribeReason = 'initial' | 'reconnect' | 'stale';

export interface SupervisorTimings {
  /** Check interval of the internal tick. */
  tickMs: number;
  /** Ping while CONNECTED. */
  pingIntervalMs: number;
  /** No own PONG and no other callback for this long → STALE. */
  staleAfterMs: number;
  /** Retry interval while DISCONNECTED after the first successful connect. */
  reconnectIntervalMs: number;
  /** Backoff before the first successful connect. */
  initialBackoffMs: number;
  maxBackoffMs: number;
  /** The CCU must call listDevices within this time after init. */
  handshakeTimeoutMs: number;
}

export const DEFAULT_TIMINGS: SupervisorTimings = {
  tickMs: 5_000,
  pingIntervalMs: 60_000,
  staleAfterMs: 90_000,
  reconnectIntervalMs: 15_000,
  initialBackoffMs: 5_000,
  maxBackoffMs: 300_000,
  handshakeTimeoutMs: 15_000,
};

export interface SupervisorOptions {
  client: RpcClient;
  log: PrefixedLogger;
  /** Caller id for `ping`; the PONG event carries it back. */
  pingId: string;
  /** Shown in the handshake error. */
  callbackUrl: string;
  timings?: Partial<SupervisorTimings>;
  now?: () => number;
}

export interface SupervisorEvents {
  state: (state: InterfaceState, previous: InterfaceState) => void;
  subscribed: (reason: SubscribeReason) => void;
}

export class InterfaceSupervisor extends EventEmitter {
  readonly interfaceId: CcuInterfaceId;
  private readonly client: RpcClient;
  private readonly log: PrefixedLogger;
  private readonly pingId: string;
  private readonly callbackUrl: string;
  private readonly t: SupervisorTimings;
  private readonly now: () => number;

  private current: InterfaceState = 'IDLE';
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private everConnected = false;
  private backoffMs: number;
  private nextRetryAt = 0;
  private lastPingAt = 0;
  private lastActivityAt = 0;
  private lastPongAt = 0;
  private subscribedAt = 0;
  private handshakeSeen = true;
  private lastError = '';

  constructor(opts: SupervisorOptions) {
    super();
    this.client = opts.client;
    this.interfaceId = opts.client.interfaceId;
    this.log = opts.log;
    this.pingId = opts.pingId;
    this.callbackUrl = opts.callbackUrl;
    this.t = { ...DEFAULT_TIMINGS, ...(opts.timings ?? {}) };
    this.now = opts.now ?? Date.now;
    this.backoffMs = this.t.initialBackoffMs;
  }

  override on<K extends keyof SupervisorEvents>(event: K, listener: SupervisorEvents[K]): this {
    return super.on(event, listener);
  }

  get state(): InterfaceState {
    return this.current;
  }

  /** First subscribe attempt; resolves when it has succeeded or failed. */
  async start(): Promise<void> {
    if (this.current !== 'IDLE' && this.current !== 'STOPPED') {
      return;
    }
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.debug('supervisor tick failed: %s', (err as Error).message));
    }, this.t.tickMs);
    this.timer.unref?.();
    this.setState('CONNECTING');
    await this.run(() => this.subscribe('initial'));
  }

  /** Stop timers and unsubscribe (same URL, empty id). */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const wasLive = this.current === 'CONNECTED' || this.current === 'STALE';
    this.setState('STOPPED');
    if (wasLive) {
      await this.client.unsubscribe();
    }
    await this.client.close();
  }

  /**
   * Any inbound callback for this interface. `pong` marks our own PONG,
   * `listDevices` completes the init handshake.
   */
  noteActivity(kind: 'event' | 'pong' | 'listDevices' | 'other'): void {
    const now = this.now();
    this.lastActivityAt = now;
    if (kind === 'listDevices') {
      this.handshakeSeen = true;
      this.log.debug('%s: handshake (listDevices) %d ms after init', this.interfaceId, now - this.subscribedAt);
    } else if (kind === 'pong') {
      this.lastPongAt = now;
      this.log.debug('%s: PONG %d ms after ping', this.interfaceId, now - this.lastPingAt);
    }
  }

  /** "12 s ago" / "never" for the stale warning. */
  private ago(at: number, now: number): string {
    return at > 0 ? `${Math.round((now - at) / 1000)} s ago` : 'never';
  }

  // --- internals -----------------------------------------------------

  /** Serialize operations; a tick that finds us busy just skips. */
  private async run(op: () => Promise<void>): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      await op();
    } finally {
      this.busy = false;
    }
  }

  private async tick(): Promise<void> {
    const now = this.now();
    switch (this.current) {
      case 'DISCONNECTED':
        if (now >= this.nextRetryAt) {
          await this.run(() => this.retry());
        }
        return;
      case 'CONNECTED':
        this.checkHandshake(now);
        if (now - this.lastActivityAt >= this.t.staleAfterMs) {
          await this.run(async () => {
            this.setState('STALE');
            this.log.warn('%s: no PONG and no events for %d s (last PONG %s, subscribed %s); subscribing again',
              this.interfaceId, Math.round((now - this.lastActivityAt) / 1000),
              this.ago(this.lastPongAt, now), this.ago(this.subscribedAt, now));
            await this.subscribe('stale');
          });
          return;
        }
        if (now - this.lastPingAt >= this.t.pingIntervalMs) {
          await this.run(() => this.ping());
        }
        return;
      default:
        return;
    }
  }

  private async ping(): Promise<void> {
    this.lastPingAt = this.now();
    try {
      await this.client.ping(this.pingId);
      this.log.debug('%s: ping call returned (last callback %s)', this.interfaceId, this.ago(this.lastActivityAt, this.now()));
    } catch (err) {
      this.disconnected(err as Error);
    }
  }

  /** DISCONNECTED: is the port back? Then subscribe at once. */
  private async retry(): Promise<void> {
    try {
      await this.client.ping(this.pingId);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.debug('%s still unreachable: %s', this.interfaceId, this.lastError);
      this.scheduleRetry();
      return;
    }
    await this.subscribe(this.everConnected ? 'reconnect' : 'initial');
  }

  private async subscribe(reason: SubscribeReason): Promise<void> {
    this.handshakeSeen = false;
    try {
      await this.client.subscribe();
    } catch (err) {
      this.disconnected(err as Error);
      return;
    }
    const now = this.now();
    this.subscribedAt = now;
    this.lastActivityAt = now;
    this.lastPingAt = now;
    this.everConnected = true;
    this.backoffMs = this.t.initialBackoffMs;
    this.setState('CONNECTED');
    this.emit('subscribed', reason);
  }

  private disconnected(err: Error): void {
    this.lastError = err.message;
    const first = this.current !== 'DISCONNECTED';
    this.setState('DISCONNECTED', err.message);
    if (first && /ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/.test(err.message) && !this.everConnected) {
      this.log.warn('Hint: check the CCU firewall (Settings → Control Panel → Security → Firewall: '
        + '"XML-RPC API") or set interfacePorts.%s', this.interfaceId);
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.everConnected) {
      this.nextRetryAt = this.now() + this.t.reconnectIntervalMs;
      return;
    }
    this.nextRetryAt = this.now() + this.backoffMs;
    this.backoffMs = Math.min(this.t.maxBackoffMs, this.backoffMs * 2);
  }

  private checkHandshake(now: number): void {
    if (this.handshakeSeen || now - this.subscribedAt < this.t.handshakeTimeoutMs) {
      return;
    }
    this.handshakeSeen = true; // report once per subscribe
    this.log.error(
      '%s: init succeeded, but the CCU did not call back within %d s. The CCU cannot reach %s — '
        + 'check eventServer.callbackHost / port, firewall and Docker port mapping.',
      this.interfaceId, Math.round(this.t.handshakeTimeoutMs / 1000), this.callbackUrl);
  }

  private setState(next: InterfaceState, detail?: string): void {
    const prev = this.current;
    if (prev === next) {
      return;
    }
    this.current = next;
    if (next === 'CONNECTED') {
      this.log.info('%s connected%s', this.interfaceId, prev === 'CONNECTING' ? '' : ` (was ${prev})`);
    } else if (next === 'DISCONNECTED') {
      this.log.warn('%s unreachable: %s', this.interfaceId, detail ?? this.lastError);
    } else {
      this.log.debug('%s: %s → %s', this.interfaceId, prev, next);
    }
    this.emit('state', next, prev);
  }
}
