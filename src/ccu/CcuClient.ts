// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Facade over the CCU adapters. Owns the lifecycle (connect / disconnect /
 * reconnect), exposes high-level operations to the platform and services,
 * and dispatches inbound events to registered listeners.
 *
 * XML-RPC only: one RpcClient per enabled interface (BidCos-RF → rfd,
 * HmIP-RF → HMIPServer) for discovery (`listDevices`), reads and writes,
 * plus the local EventServer for the CCU's push events. No JSON-RPC,
 * no ReGa, no CCU login.
 *
 * Each interface has an InterfaceSupervisor (ping/PONG, re-subscribe
 * after a CCU restart, backoff). The CcuClient feeds it every inbound
 * callback and re-emits its events:
 *   'interfaceState' (id, state, previous)
 *   'subscribed'     (id, reason)   — after every successful init
 *
 * Exactly one CcuClient lives per HomematicPlatform instance.
 */

import { networkInterfaces } from 'node:os';
import { EventEmitter } from 'node:events';
import { EventServer, type CallbackActivity, type ChannelEvent } from './EventServer.js';
import {
  InterfaceSupervisor,
  type InterfaceState,
  type SupervisorTimings,
} from './InterfaceSupervisor.js';
import {
  RpcClient,
  INTERFACE_PORTS,
  INTERFACE_TLS_PORTS,
  type ParameterDescription,
  type RpcDeviceDescription,
} from './RpcClient.js';
import { SendQueue, SendTimeoutError, formatSeconds } from './SendQueue.js';
import type { CcuChannel, CcuDevice, CcuInterfaceId, ResolvedConfig } from '../types.js';
import type { PrefixedLogger } from '../util/logger.js';
import { PLUGIN_NAME } from '../settings.js';

export interface CcuClientOptions {
  config: ResolvedConfig;
  log: PrefixedLogger;
  /** Override supervisor timings (tests). */
  timings?: Partial<SupervisorTimings>;
}

type DatapointListener = (value: unknown) => void;

/** Paramset description lookup (Discovery's cache), see setDescriber(). */
export type Describer = (address: string) => Record<string, ParameterDescription> | undefined;

/**
 * A setValue the CCU did not carry out. `reason` is the CCU's answer
 * without the "setValue failed:" prefix, e.g. "Generic error (UNREACH) (-1)",
 * or "no answer within 5.0 s" when the send queue's timeout hit.
 * `durationMs`: time from sending until the answer (or the timeout).
 */
export class SetValueError extends Error {
  constructor(
    readonly address: string,
    readonly datapoint: string,
    readonly value: unknown,
    readonly reason: string,
    override readonly cause?: unknown,
    readonly durationMs?: number,
  ) {
    super(`${address} ${datapoint}=${String(value)} not delivered: ${reason}`);
    this.name = 'SetValueError';
  }

  /** True when the CCU did not answer within the send queue's timeout. */
  get timedOut(): boolean {
    return this.cause instanceof SendTimeoutError;
  }
}

/** Receives the failed commands to the addresses it owns, see setOwner(). */
export type SetFailureReporter = (err: SetValueError) => void;

/** sendQueue defaults (plan-sendequeue.md). */
export const SEND_QUEUE_DEFAULTS = { timeoutMs: 5000, gapMs: 100 } as const;

/** Last known signal strength of a device in dBm, both directions. */
export interface SignalInfo {
  /** How well the CCU received the device (RSSI_DEVICE). */
  device?: number;
  /** How well the device received the CCU (RSSI_PEER). */
  peer?: number;
}

/** Plausible RSSI in dBm; the CCU uses e.g. -65535 or 0 for "unknown". */
export function validRssi(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(n) && n < 0 && n > -128 ? n : undefined;
}

/** `ABC:14` → `ABC:0`, the device's maintenance channel. */
function channel0(address: string): string {
  const colon = address.lastIndexOf(':');
  return `${colon === -1 ? address : address.slice(0, colon)}:0`;
}

/** The CCU's answer without the (sometimes doubled) "setValue failed:" prefix. */
function describeFailure(message: string): string {
  return message.replace(/^(?:setValue failed:\s*)+/, '');
}

const ENABLED_INTERFACES: ReadonlyArray<{
  id: CcuInterfaceId;
  flag: keyof ResolvedConfig['interfaces'];
}> = [
  { id: 'BidCos-RF', flag: 'bidcosRf' },
  { id: 'HmIP-RF', flag: 'hmIpRf' },
];

export interface InterfaceProbe {
  interfaceId: CcuInterfaceId;
  port: number;
  ok: boolean;
  /** Number of methods reported by `system.listMethods` (when ok). */
  methods?: number;
  error?: string;
}

export class CcuClient extends EventEmitter {
  readonly eventServer: EventServer;
  private readonly rpcClients: Map<CcuInterfaceId, RpcClient> = new Map();
  private readonly datapointListeners: Map<string, Set<DatapointListener>> = new Map();
  private readonly config: ResolvedConfig;
  private readonly log: PrefixedLogger;
  private readonly supervisors: Map<CcuInterfaceId, InterfaceSupervisor> = new Map();
  /** callback id (`homebridge-hap-homematic:<interface>`) → supervisor */
  private readonly byCallbackId: Map<string, InterfaceSupervisor> = new Map();
  private started = false;
  private describer: Describer = () => undefined;
  /** In-flight getParamset per channel, so handlers sharing a channel ask once. */
  private readonly inflight = new Map<string, Promise<Record<string, unknown> | undefined>>();
  /** Last RSSI_DEVICE / RSSI_PEER events per maintenance channel (`ABC:0`). */
  private readonly lastSignal = new Map<string, SignalInfo>();
  /** address → interface map, filled by listDevices(). */
  private readonly addressInterface: Map<string, CcuInterfaceId> = new Map();
  /** channel address → reporter of the accessory that uses it, see setOwner(). */
  private readonly owners = new Map<string, SetFailureReporter>();
  /** One setValue at a time, across all interfaces. */
  readonly sendQueue: SendQueue;

  constructor(opts: CcuClientOptions) {
    super();
    // Every accessory with a fault indicator listens to 'interfaceState'
    // (removed again on dispose), so more than 10 listeners are normal.
    this.setMaxListeners(0);
    this.config = opts.config;
    this.log = opts.log;
    this.sendQueue = new SendQueue({
      log: this.log.child('send'),
      timeoutMs: this.config.sendQueue?.timeoutMs ?? SEND_QUEUE_DEFAULTS.timeoutMs,
      gapMs: this.config.sendQueue?.gapMs ?? SEND_QUEUE_DEFAULTS.gapMs,
    });

    this.eventServer = new EventServer({
      host: this.config.eventServer.host,
      port: this.config.eventServer.port,
      log: this.log.child('events'),
      allowedSenders: [this.config.ccuIp],
    });

    this.eventServer.on('event', (ev) => this.handleEvent(ev));
    this.eventServer.on('activity', (a) => this.handleActivity(a));
    this.eventServer.on('error', (err) => {
      this.log.error('Event server error: %s', err.message);
    });

    const callbackHost = this.config.eventServer.callbackHost || this.resolveCallbackHost();
    const callbackUrl = `http://${callbackHost}:${this.config.eventServer.port}`;
    const { rpcAuth } = this.config;
    const auth =
      rpcAuth.enabled && rpcAuth.username && rpcAuth.password
        ? { username: rpcAuth.username, password: rpcAuth.password }
        : undefined;
    for (const { id, flag } of ENABLED_INTERFACES) {
      if (!this.config.interfaces[flag]) {
        continue;
      }
      const callbackId = `${PLUGIN_NAME}:${id}`;
      const client = new RpcClient({
        interfaceId: id,
        host: this.config.ccuIp,
        port: this.portFor(id),
        callbackUrl,
        callbackId,
        log: this.log.child(`rpc:${id}`),
        tls: this.config.useTls,
        ...(auth ? { auth } : {}),
      });
      this.rpcClients.set(id, client);
      const sup = new InterfaceSupervisor({
        client,
        log: this.log.child(`link:${id}`),
        pingId: callbackId,
        callbackUrl,
        ...(opts.timings ? { timings: opts.timings } : {}),
      });
      sup.on('state', (state, prev) => this.emit('interfaceState', id, state, prev));
      sup.on('subscribed', (reason) => this.emit('subscribed', id, reason));
      this.supervisors.set(id, sup);
      this.byCallbackId.set(callbackId, sup);
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.eventServer.start();
    this.started = true;
    this.sendQueue.start();
    for (const id of this.supervisors.keys()) {
      this.log.info(
        'Using XML-RPC port %d for %s%s',
        this.portFor(id),
        id,
        this.config.useTls ? ' (TLS)' : '',
      );
    }
    // First attempt on every interface in parallel; failures retry in the
    // background (backoff), so start() never throws because of the CCU.
    await Promise.all([...this.supervisors.values()].map((s) => s.start()));
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.sendQueue.stop();
    for (const sup of this.supervisors.values()) {
      await sup.stop();
    }
    await this.eventServer.stop();
  }

  /** Interfaces enabled in the config, in a fixed order. */
  enabledInterfaces(): CcuInterfaceId[] {
    return [...this.rpcClients.keys()];
  }

  /**
   * Raw XML-RPC `listDevices` per enabled interface. Failures are
   * reported per interface instead of thrown, so callers can fall back
   * to a cache for just that interface.
   */
  async listRawDevices(): Promise<{
    results: Map<CcuInterfaceId, RpcDeviceDescription[]>;
    errors: Map<CcuInterfaceId, Error>;
  }> {
    const results = new Map<CcuInterfaceId, RpcDeviceDescription[]>();
    const errors = new Map<CcuInterfaceId, Error>();
    for (const client of this.rpcClients.values()) {
      try {
        results.set(client.interfaceId, await client.listDevices());
      } catch (err) {
        errors.set(client.interfaceId, err as Error);
      }
    }
    return { results, errors };
  }

  /**
   * All devices and their channels, via XML-RPC `listDevices` on every
   * enabled interface (no cache; see Discovery for that). XML-RPC
   * carries no names, so `name` is a placeholder of type and address.
   * Interfaces that fail are logged and skipped; the call rejects only
   * if every interface failed.
   */
  async listDevices(): Promise<CcuDevice[]> {
    const { results, errors } = await this.listRawDevices();
    for (const [id, err] of errors) {
      this.log.warn('listDevices on %s failed: %s', id, err.message);
    }
    if (results.size === 0 && errors.size > 0) {
      throw [...errors.values()][0]!;
    }
    const out: CcuDevice[] = [];
    for (const [id, raw] of results) {
      out.push(...toDevices(raw, id));
    }
    this.indexDevices(out);
    return out;
  }

  /** Remember which interface each device / channel address belongs to. */
  indexDevices(devices: CcuDevice[]): void {
    for (const d of devices) {
      this.addressInterface.set(d.address, d.interface);
      for (const c of d.channels) {
        this.addressInterface.set(c.address, d.interface);
      }
    }
    this.log.debug('Indexed %d addresses across interfaces', this.addressInterface.size);
  }

  /** Pin an address (device serial) to an interface, e.g. from devices.json. */
  setInterfaceFor(address: string, intf: CcuInterfaceId): void {
    this.addressInterface.set(address, intf);
  }

  /** `getParamsetDescription(address, 'VALUES')` on the channel's interface. */
  async getParamsetDescription(address: string): Promise<Record<string, ParameterDescription>> {
    return this.clientFor(address).getParamsetDescription(address);
  }

  /** `system.listMethods` on every enabled interface (UI "Test connection"). */
  async probeInterfaces(): Promise<InterfaceProbe[]> {
    const results: InterfaceProbe[] = [];
    for (const client of this.rpcClients.values()) {
      const port = this.portFor(client.interfaceId);
      try {
        const methods = await client.listMethods();
        results.push({ interfaceId: client.interfaceId, port, ok: true, methods: methods.length });
      } catch (err) {
        results.push({
          interfaceId: client.interfaceId,
          port,
          ok: false,
          error: (err as Error).message,
        });
      }
    }
    return results;
  }

  /** Subscribe a callback to a `<serial>:<chan>.<datapoint>` address. */
  registerListener(address: string, listener: DatapointListener): () => void {
    let set = this.datapointListeners.get(address);
    if (!set) {
      set = new Set();
      this.datapointListeners.set(address, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.datapointListeners.delete(address);
      }
    };
  }

  /** True if any interface is currently CONNECTED. */
  isLive(): boolean {
    return [...this.supervisors.values()].some((s) => s.state === 'CONNECTED');
  }

  /** Supervisor state of one interface (undefined if not enabled). */
  getInterfaceState(id: CcuInterfaceId): InterfaceState | undefined {
    return this.supervisors.get(id)?.state;
  }

  /** Paramset descriptions for typing (setValue) and the ACTION filter. */
  setDescriber(fn: Describer): void {
    this.describer = fn;
  }

  /** Description of one datapoint, if the paramset cache has it. */
  describe(address: string, datapoint: string): ParameterDescription | undefined {
    return this.describer(address)?.[datapoint];
  }

  /**
   * `reporter` logs failed commands to `address` (AccessoryBase: one line
   * with the accessory's name). The first owner of an address keeps it;
   * the returned function releases it again.
   */
  setOwner(address: string, reporter: SetFailureReporter): () => void {
    if (!this.owners.has(address)) {
      this.owners.set(address, reporter);
    }
    return () => {
      if (this.owners.get(address) === reporter) {
        this.owners.delete(address);
      }
    };
  }

  /**
   * Queue a CCU datapoint write (plan-sendequeue.md) and return at once.
   * The send queue sends one setValue at a time across all interfaces; a
   * newer write to the same datapoint replaces a waiting one. A failure
   * goes to the address's owner (setOwner), else to the log.
   */
  async setValue(address: string, datapoint: string, value: unknown): Promise<void> {
    this.setValues(address, [[datapoint, value]]);
  }

  /**
   * Queue writes that belong together as one job, sent in order without
   * other commands in between (irrigation: ON_TIME, then STATE). The
   * first failure ends the job. Throws at once for an address on a
   * disabled interface.
   */
  setValues(
    address: string,
    writes: ReadonlyArray<readonly [datapoint: string, value: unknown]>,
  ): void {
    if (writes.length === 0) {
      return;
    }
    let current = 0;
    const label = `${address} ${writes.map(([dp, v]) => `${dp}=${String(v)}`).join(', ')}`;
    this.clientFor(address); // a disabled interface fails at once, not in the queue
    const intf = this.interfaceForAddress(address);
    this.sendQueue.enqueue({
      key: `${intf}:${address}:${writes.map(([dp]) => dp).join('+')}`,
      label,
      run: async () => {
        for (current = 0; current < writes.length; current++) {
          const [dp, v] = writes[current]!;
          await this.sendValue(address, dp, v);
        }
      },
      onError: (err, ms) => {
        const [dp, v] = writes[Math.min(current, writes.length - 1)]!;
        const failure = new SetValueError(
          address,
          dp,
          v,
          err instanceof SetValueError ? err.reason : describeFailure((err as Error).message),
          err instanceof SetValueError ? err.cause : err,
          ms,
        );
        const reporter = this.owners.get(address);
        if (reporter) {
          reporter(failure);
        } else {
          this.log.warn(
            '%s=%s on %s not delivered after %s, (%s)',
            dp,
            String(v),
            address,
            formatSeconds(ms),
            failure.reason,
          );
        }
      },
    });
  }

  /**
   * One setValue via XML-RPC on the channel's interface, typed by the
   * paramset description (plan 4.3): FLOAT as explicit double (the CCU
   * rejects `1` as int for a FLOAT), INTEGER/ENUM rounded, BOOL and
   * ACTION as boolean. Without a description the value is sent as is.
   */
  private async sendValue(address: string, datapoint: string, value: unknown): Promise<void> {
    const typed = toTyped(this.describe(address, datapoint)?.TYPE, value);
    try {
      await this.clientFor(address).setValue(address, datapoint, typed);
    } catch (err) {
      throw new SetValueError(
        address,
        datapoint,
        value,
        describeFailure((err as Error).message),
        err,
      );
    }
  }

  /**
   * Signal strength of the device behind `address`: the CCU's current
   * values of channel 0 (no radio traffic), else the last RSSI events.
   * Empty when neither is known (unreachable HmIP devices report none).
   */
  async signalInfo(address: string): Promise<SignalInfo> {
    const ch0 = channel0(address);
    const values = await this.readValues(ch0);
    const last = this.lastSignal.get(ch0) ?? {};
    const device = validRssi(values?.['RSSI_DEVICE']) ?? last.device;
    const peer = validRssi(values?.['RSSI_PEER']) ?? last.peer;
    return { ...(device !== undefined ? { device } : {}), ...(peer !== undefined ? { peer } : {}) };
  }

  /** Read a CCU datapoint via XML-RPC on the channel's interface. */
  async getValue(address: string, datapoint: string): Promise<unknown> {
    return this.clientFor(address).getValue(address, datapoint);
  }

  /**
   * Current values of a channel via `getParamset(VALUES)` (no radio
   * traffic). Concurrent calls for the same channel share one request.
   * `undefined` when the CCU answered with an error (e.g. BidCos device
   * without power, plan 3.1 finding 1); `{}` for unreachable HmIP devices.
   * ACTION datapoints (PRESS_*) are never returned (plan 4.2).
   */
  readValues(address: string): Promise<Record<string, unknown> | undefined> {
    const running = this.inflight.get(address);
    if (running) {
      return running;
    }
    const p = (async () => {
      try {
        const raw = await this.clientFor(address).getParamset(address);
        const out: Record<string, unknown> = {};
        for (const [dp, v] of Object.entries(raw)) {
          if (!this.isAction(address, dp)) {
            out[dp] = v;
          }
        }
        return out;
      } catch (err) {
        this.log.debug('getParamset(%s) failed: %s', address, (err as Error).message);
        return undefined;
      } finally {
        this.inflight.delete(address);
      }
    })();
    this.inflight.set(address, p);
    return p;
  }

  /** ACTION datapoints must never be applied as start values. */
  isAction(address: string, datapoint: string): boolean {
    const type = this.describe(address, datapoint)?.TYPE;
    return type === 'ACTION' || (type === undefined && datapoint.startsWith('PRESS_'));
  }

  /** Interface a channel / device address is routed to. */
  interfaceOf(address: string): CcuInterfaceId {
    return this.interfaceForAddress(address);
  }

  // --- internals -----------------------------------------------------

  private clientFor(address: string): RpcClient {
    const intf = this.interfaceForAddress(address);
    const client = this.rpcClients.get(intf);
    if (!client) {
      throw new Error(`Interface ${intf} is not enabled (address ${address})`);
    }
    return client;
  }

  private portFor(id: CcuInterfaceId): number {
    return (
      this.config.interfacePorts[id] ??
      (this.config.useTls ? INTERFACE_TLS_PORTS : INTERFACE_PORTS)[id]
    );
  }

  /** Every inbound callback is a sign of life for its interface. */
  private handleActivity(a: CallbackActivity): void {
    const sup = this.byCallbackId.get(a.callbackId);
    if (!sup || a.method === 'event') {
      return; // events are handled (and classified) in handleEvent
    }
    sup.noteActivity(a.method === 'listDevices' ? 'listDevices' : 'other');
  }

  private handleEvent(ev: ChannelEvent): void {
    const sup = this.byCallbackId.get(ev.callbackId);
    if (!sup) {
      // Not one of our subscriptions: ignore it instead of dispatching.
      this.log.debug(
        'Ignored event for unknown callback id %s: %s.%s',
        ev.callbackId,
        ev.channelAddress,
        ev.datapoint,
      );
      return;
    }
    if (
      ev.datapoint === 'PONG' &&
      (ev.channelAddress === 'CENTRAL' || ev.channelAddress === 'CENTRAL:0')
    ) {
      // Own PONG (value = our caller id) or a foreign client's; both prove
      // that our subscription on this interface is alive.
      sup.noteActivity(ev.value === ev.callbackId ? 'pong' : 'event');
      return;
    }
    sup.noteActivity('event');
    if (ev.datapoint === 'RSSI_DEVICE' || ev.datapoint === 'RSSI_PEER') {
      const rssi = validRssi(ev.value);
      if (rssi !== undefined) {
        const entry = this.lastSignal.get(ev.channelAddress) ?? {};
        entry[ev.datapoint === 'RSSI_DEVICE' ? 'device' : 'peer'] = rssi;
        this.lastSignal.set(ev.channelAddress, entry);
      }
    }
    const fullAddress = `${ev.channelAddress}.${ev.datapoint}`;
    const set = this.datapointListeners.get(fullAddress);
    if (!set) {
      this.log.debug('Unrouted event %s = %s', fullAddress, String(ev.value));
      return;
    }
    for (const listener of set) {
      try {
        listener(ev.value);
      } catch (err) {
        this.log.error('Listener for %s threw: %s', fullAddress, (err as Error).message);
      }
    }
  }

  private interfaceForAddress(address: string): CcuInterfaceId {
    // The discovery map (built from listDevices) is authoritative.
    const direct = this.addressInterface.get(address);
    if (direct) {
      return direct;
    }
    const colon = address.indexOf(':');
    if (colon !== -1) {
      const deviceOnly = this.addressInterface.get(address.slice(0, colon));
      if (deviceOnly) return deviceOnly;
    }
    // Before discovery: HmIP serials are 14 hex digits, BidCos serials
    // are 10 characters (3 letters + 7 digits).
    const serial = colon === -1 ? address : address.slice(0, colon);
    return /^[0-9A-F]{14}$/i.test(serial) ? 'HmIP-RF' : 'BidCos-RF';
  }

  private resolveCallbackHost(): string {
    if (this.config.eventServer.host !== '0.0.0.0' && this.config.eventServer.host !== '::') {
      return this.config.eventServer.host;
    }
    const ifs = networkInterfaces();
    for (const list of Object.values(ifs)) {
      for (const i of list ?? []) {
        if (i.family === 'IPv4' && !i.internal) {
          return i.address;
        }
      }
    }
    return '127.0.0.1';
  }
}

/**
 * Turn the flat `listDevices` answer (devices and channels mixed) into
 * devices with their channels. Channel 0 (MAINTENANCE) is kept.
 */
export function toDevices(raw: RpcDeviceDescription[], intf: CcuInterfaceId): CcuDevice[] {
  const devices = new Map<string, CcuDevice>();
  const channels: RpcDeviceDescription[] = [];
  for (const e of raw) {
    if (!e || typeof e.ADDRESS !== 'string' || e.ADDRESS.length === 0) {
      continue;
    }
    if (e.PARENT) {
      channels.push(e);
      continue;
    }
    devices.set(e.ADDRESS, {
      address: e.ADDRESS,
      type: e.TYPE ?? '',
      name: `${e.TYPE ?? 'Device'} ${e.ADDRESS}`,
      interface: intf,
      ...(e.FIRMWARE ? { firmware: e.FIRMWARE } : {}),
      channels: [],
    });
  }
  for (const c of channels) {
    const device = devices.get(c.PARENT!);
    if (!device) {
      continue;
    }
    const colon = c.ADDRESS.lastIndexOf(':');
    const index = typeof c.INDEX === 'number' ? c.INDEX : Number(c.ADDRESS.slice(colon + 1));
    const channel: CcuChannel = {
      address: c.ADDRESS,
      index: Number.isFinite(index) ? index : 0,
      type: c.TYPE ?? '',
      name: `${device.type} ${c.ADDRESS}`,
    };
    device.channels.push(channel);
  }
  for (const d of devices.values()) {
    d.channels.sort((a, b) => a.index - b.index);
  }
  return [...devices.values()];
}

/** Shape a value for setValue by the datapoint's paramset TYPE. */
export function toTyped(type: string | undefined, value: unknown): unknown {
  switch (type) {
    case 'FLOAT': {
      const n = typeof value === 'number' ? value : Number(value);
      return { explicitDouble: Number.isFinite(n) ? n : 0 };
    }
    case 'INTEGER':
    case 'ENUM': {
      const n = typeof value === 'boolean' ? Number(value) : Math.round(Number(value));
      return Number.isFinite(n) ? n : 0;
    }
    case 'BOOL':
    case 'ACTION':
      return value === 'false' ? false : Boolean(value);
    default:
      return value;
  }
}
