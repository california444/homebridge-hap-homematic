// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Wraps homematic-xmlrpc into a Promise-based, per-interface client. We
 * keep one RpcClient per CCU interface (BidCos-RF, HmIP-RF, …) — each one
 * connects to a different CCU port and registers a callback URL so the
 * EventServer receives push events.
 */

import { createConnection } from 'node:net';
import type { PrefixedLogger } from '../util/logger.js';
import type { CcuInterfaceId } from '../types.js';

/** Default timeout for the pre-init TCP reachability probe. */
const PROBE_TIMEOUT_MS = 5_000;

export const INTERFACE_PORTS: Record<CcuInterfaceId, number> = {
  'BidCos-RF': 2001,
  'HmIP-RF': 2010,
};

/** CCU defaults for XML-RPC over TLS. */
export const INTERFACE_TLS_PORTS: Record<CcuInterfaceId, number> = {
  'BidCos-RF': 42001,
  'HmIP-RF': 42010,
};

/** One entry of a `getParamsetDescription(…, 'VALUES')` answer. */
export interface ParameterDescription {
  TYPE: string;           // BOOL, INTEGER, FLOAT, ENUM, ACTION, STRING
  OPERATIONS?: number;    // bit mask: 1 read, 2 write, 4 event
  FLAGS?: number;
  MIN?: unknown;
  MAX?: unknown;
  DEFAULT?: unknown;
  UNIT?: string;
  VALUE_LIST?: string[];
  [key: string]: unknown;
}

/** One entry of the XML-RPC `listDevices` answer (device or channel). */
export interface RpcDeviceDescription {
  ADDRESS: string;
  TYPE: string;
  PARENT?: string;
  PARENT_TYPE?: string;
  CHILDREN?: string[];
  FIRMWARE?: string;
  INDEX?: number;
  VERSION?: number;
}

export interface RpcClientOptions {
  interfaceId: CcuInterfaceId;
  host: string;
  port?: number;
  /** URL the CCU should call back. e.g. xmlrpc://192.168.1.20:9875 */
  callbackUrl: string;
  /** Identifier the CCU will tag callbacks with. */
  callbackId: string;
  log: PrefixedLogger;
  /** HTTPS instead of HTTP; the CCU's self-signed certificate is accepted. */
  tls?: boolean;
  /** HTTP Basic auth on the XML-RPC port. */
  auth?: { username: string; password: string };
  /**
   * Inject the underlying transport for tests. The default uses
   * homematic-xmlrpc to dial the CCU port.
   */
  transport?: RpcTransport;
  /**
   * Skip the pre-init TCP reachability probe. Tests that mock
   * `homematic-xmlrpc` via `vi.mock` rely on the module's mocked
   * createClient and never actually open a socket; the probe would
   * still try to connect to the configured port and fail.
   */
  skipProbe?: boolean;
}

export interface RpcTransport {
  call(method: string, params: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

export class RpcError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

export class RpcClient {
  readonly interfaceId: CcuInterfaceId;
  private readonly host: string;
  private readonly port: number;
  private readonly callbackUrl: string;
  private readonly callbackId: string;
  private readonly log: PrefixedLogger;
  private transport: RpcTransport | undefined;
  private readonly transportFactory?: RpcTransport;
  private readonly skipProbe: boolean;
  private readonly tls: boolean;
  private readonly auth: { username: string; password: string } | undefined;
  private subscribed = false;

  constructor(opts: RpcClientOptions) {
    this.interfaceId = opts.interfaceId;
    this.host = opts.host;
    this.tls = opts.tls ?? false;
    this.auth = opts.auth;
    this.port = opts.port ?? (this.tls ? INTERFACE_TLS_PORTS : INTERFACE_PORTS)[opts.interfaceId];
    this.callbackUrl = opts.callbackUrl;
    this.callbackId = opts.callbackId;
    this.log = opts.log;
    this.transportFactory = opts.transport;
    this.skipProbe = opts.skipProbe ?? false;
  }

  async ensureTransport(): Promise<RpcTransport> {
    if (this.transport) {
      return this.transport;
    }
    if (this.transportFactory) {
      this.transport = this.transportFactory;
      return this.transport;
    }
    // Late-load the runtime dep so unit tests can inject a transport
    // without resolving the homematic-xmlrpc native module path.
    //
    // homematic-xmlrpc is published as CommonJS; under ESM dynamic import
    // its real `createClient` shows up on `.default`, not directly on the
    // module namespace.
    type ClientOptions = {
      host: string;
      port: number;
      rejectUnauthorized?: boolean;
      basic_auth?: { user: string; pass: string };
    };
    type CreateClientFn = (opts: ClientOptions) => {
      methodCall(method: string, params: unknown[],
        cb: (err: Error | null, value: unknown) => void): void;
    };
    type XmlRpcModule = { createClient?: CreateClientFn; createSecureClient?: CreateClientFn };
    const mod = (await import('homematic-xmlrpc')) as XmlRpcModule & { default?: XmlRpcModule };
    const factory = this.tls
      ? mod.createSecureClient ?? mod.default?.createSecureClient
      : mod.createClient ?? mod.default?.createClient;
    if (typeof factory !== 'function') {
      throw new RpcError('homematic-xmlrpc module did not expose createClient/createSecureClient');
    }
    const client = factory({
      host: this.host,
      port: this.port,
      // CCUs use self-signed certificates; the connection only ever goes
      // to the configured ccuIp.
      ...(this.tls ? { rejectUnauthorized: false } : {}),
      ...(this.auth ? { basic_auth: { user: this.auth.username, pass: this.auth.password } } : {}),
    });
    this.transport = {
      call: (method, params) =>
        new Promise((resolve, reject) => {
          client.methodCall(method, params, (err, value) => {
            if (err) {
              const e = err as { message?: string; faultString?: string; faultCode?: number };
              const detail = e.faultString
                ? `${e.faultString}${e.faultCode !== undefined ? ` (${e.faultCode})` : ''}`
                : e.message ?? 'unknown error';
              reject(new RpcError(`${method} failed: ${detail}`, err));
            } else {
              resolve(value);
            }
          });
        }),
      close: async () => undefined,
    };
    return this.transport;
  }

  /** Subscribe to events. Idempotent. */
  async subscribe(): Promise<void> {
    // Probe TCP reachability with a short timeout BEFORE the XML-RPC init,
    // because the homematic-xmlrpc client uses the kernel default connect
    // timeout (~2 min on Linux). A locked-down CCU firewall would otherwise
    // hang the platform start for two minutes per interface.
    // The probe is skipped when a transport was injected for tests, or
    // when the caller explicitly opted out (skipProbe=true) — used by
    // unit tests that mock homematic-xmlrpc via vi.mock.
    await this.probeOnce();
    const t = await this.ensureTransport();
    await t.call('init', [this.callbackUrl, this.callbackId]);
    this.subscribed = true;
    this.log.info('Subscribed (%s -> %s)', this.callbackId, this.callbackUrl);
  }

  /** TCP probe unless a transport was injected or the caller opted out. */
  private async probeOnce(): Promise<void> {
    if (!this.transportFactory && !this.skipProbe) {
      await this.probeReachable();
    }
  }

  private async probeReachable(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err); else resolve();
      };
      socket.setTimeout(PROBE_TIMEOUT_MS, () => {
        finish(new RpcError(`init failed: connect ETIMEDOUT ${this.host}:${this.port}`));
      });
      socket.once('connect', () => finish());
      socket.once('error', (err: NodeJS.ErrnoException) => {
        const code = err.code ?? 'unknown';
        finish(new RpcError(`init failed: connect ${code} ${this.host}:${this.port}`, err));
      });
    });
  }

  /** Unsubscribe — best-effort, swallows errors. */
  async unsubscribe(): Promise<void> {
    if (!this.subscribed) {
      return;
    }
    try {
      const t = await this.ensureTransport();
      // CCU convention: empty interfaceId removes the subscription.
      await t.call('init', [this.callbackUrl, '']);
    } catch (err) {
      this.log.debug('unsubscribe error (ignored): %s', (err as Error).message);
    } finally {
      this.subscribed = false;
    }
  }

  /** XML-RPC `listDevices`: all devices and channels of this interface. */
  async listDevices(): Promise<RpcDeviceDescription[]> {
    await this.probeOnce();
    const t = await this.ensureTransport();
    const result = await t.call('listDevices', []);
    return Array.isArray(result) ? (result as RpcDeviceDescription[]) : [];
  }

  /** XML-RPC `system.listMethods`; throws if the interface is unreachable. */
  async listMethods(): Promise<string[]> {
    await this.probeOnce();
    const t = await this.ensureTransport();
    const result = await t.call('system.listMethods', []);
    return Array.isArray(result) ? (result as string[]) : [];
  }

  /** XML-RPC `getParamsetDescription(address, 'VALUES')` (no radio traffic). */
  async getParamsetDescription(address: string): Promise<Record<string, ParameterDescription>> {
    const t = await this.ensureTransport();
    const result = await t.call('getParamsetDescription', [address, 'VALUES']);
    return result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, ParameterDescription>)
      : {};
  }

  async getValue(channel: string, datapoint: string): Promise<unknown> {
    const t = await this.ensureTransport();
    return t.call('getValue', [channel, datapoint]);
  }

  async setValue(channel: string, datapoint: string, value: unknown): Promise<void> {
    const t = await this.ensureTransport();
    await t.call('setValue', [channel, datapoint, value]);
  }

  async ping(): Promise<boolean> {
    try {
      const t = await this.ensureTransport();
      // listMethods is a cheap no-op for liveness probing.
      await t.call('system.listMethods', []);
      return true;
    } catch (err) {
      this.log.debug('ping failed: %s', (err as Error).message);
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = undefined;
    }
  }

  isSubscribed(): boolean {
    return this.subscribed;
  }
}
