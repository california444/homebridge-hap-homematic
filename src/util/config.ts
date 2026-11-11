// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Resolves and validates the raw plugin config from Homebridge into the
 * strongly-typed ResolvedConfig the rest of the code depends on. Bad
 * input produces a thrown ConfigError with a human-readable explanation;
 * the platform turns that into a single user-visible log line and
 * refuses to start (per the verified-plugin rule "must not start unless
 * configured").
 *
 * Only the connection lives in config.json; device mappings live in
 * devices.json (see util/devices.ts).
 */

import type {
  CcuInterfaceId,
  InterfaceToggles,
  RawConfig,
  ResolvedConfig,
  RpcAuthConfig,
} from '../types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_INTERFACES: InterfaceToggles = {
  bidcosRf: true,
  hmIpRf: true,
};

const VALID_INTERFACE_IDS: ReadonlySet<CcuInterfaceId> = new Set(['BidCos-RF', 'HmIP-RF']);

const DEFAULT_EVENT_SERVER = {
  host: '0.0.0.0',
  port: 9875,
  watchdogSeconds: 600,
};

const HOSTNAME_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

export function isValidHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    return false;
  }
  return HOSTNAME_RE.test(value) || IPV4_RE.test(value) || IPV6_RE.test(value);
}

export interface ResolveOptions {
  /**
   * The custom-UI server probes and discovers before the user has picked
   * a callback host; it never subscribes, so it may skip the check.
   */
  requireCallbackHost?: boolean;
}

export function resolveConfig(raw: RawConfig, opts: ResolveOptions = {}): ResolvedConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('Plugin config is empty or invalid');
  }

  const ccuIp = raw.ccuIp;
  if (!isValidHost(ccuIp)) {
    throw new ConfigError('ccuIp is required and must be a valid hostname or IP address');
  }

  const interfaces: InterfaceToggles = {
    bidcosRf: Boolean(raw.interfaces?.bidcosRf ?? DEFAULT_INTERFACES.bidcosRf),
    hmIpRf: Boolean(raw.interfaces?.hmIpRf ?? DEFAULT_INTERFACES.hmIpRf),
  };

  const useTls = Boolean(raw.useTls ?? false);

  const rpcAuth: RpcAuthConfig = {
    enabled: Boolean(raw.rpcAuth?.enabled ?? false),
    ...(typeof raw.rpcAuth?.username === 'string' ? { username: raw.rpcAuth.username } : {}),
    ...(typeof raw.rpcAuth?.password === 'string' ? { password: raw.rpcAuth.password } : {}),
  };
  if (rpcAuth.enabled && (!rpcAuth.username || !rpcAuth.password)) {
    throw new ConfigError('rpcAuth.enabled is true but username/password are missing');
  }

  const evHost = raw.eventServer?.host ?? DEFAULT_EVENT_SERVER.host;
  if (typeof evHost !== 'string' || evHost.length === 0) {
    throw new ConfigError('eventServer.host must be a non-empty string');
  }
  const callbackHost = raw.eventServer?.callbackHost;
  if (callbackHost !== undefined && callbackHost !== '' && !isValidHost(callbackHost)) {
    throw new ConfigError('eventServer.callbackHost must be a valid hostname or IP address');
  }
  if ((opts.requireCallbackHost ?? true) && !callbackHost) {
    throw new ConfigError(
      'eventServer.callbackHost is required: the address under which the CCU reaches this host (e.g. 192.168.0.13)');
  }
  const evPort = Number(raw.eventServer?.port ?? DEFAULT_EVENT_SERVER.port);
  if (!Number.isInteger(evPort) || evPort < 1024 || evPort > 65535) {
    throw new ConfigError('eventServer.port must be an integer in [1024, 65535]');
  }
  const evWatchdog = Number(raw.eventServer?.watchdogSeconds ?? DEFAULT_EVENT_SERVER.watchdogSeconds);
  if (!Number.isInteger(evWatchdog) || evWatchdog < 30 || evWatchdog > 3600) {
    throw new ConfigError('eventServer.watchdogSeconds must be an integer in [30, 3600]');
  }

  const interfacePorts: Partial<Record<CcuInterfaceId, number>> = {};
  if (raw.interfacePorts && typeof raw.interfacePorts === 'object') {
    for (const [k, v] of Object.entries(raw.interfacePorts)) {
      if (!VALID_INTERFACE_IDS.has(k as CcuInterfaceId)) {
        throw new ConfigError(`interfacePorts: unknown interface "${k}"`);
      }
      // The UI stores a cleared port field as null / ''.
      if (v === undefined || v === null || (v as unknown) === '') {
        continue;
      }
      const port = Number(v);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigError(`interfacePorts.${k} must be an integer in [1, 65535]`);
      }
      interfacePorts[k as CcuInterfaceId] = port;
    }
  }

  return {
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : 'HapHomematic',
    ccuIp,
    interfaces,
    interfacePorts,
    useTls,
    rpcAuth,
    eventServer: {
      host: evHost,
      callbackHost: callbackHost ?? '',
      port: evPort,
      watchdogSeconds: evWatchdog,
    },
  };
}
