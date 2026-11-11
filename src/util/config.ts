// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Resolves and validates the raw plugin config from Homebridge into the
 * strongly-typed ResolvedConfig the rest of the code depends on. Bad
 * input produces a thrown ConfigError with a human-readable explanation;
 * the platform turns that into a single user-visible log line and
 * refuses to start (per the verified-plugin rule "must not start unless
 * configured").
 */

import type {
  CcuInterfaceId,
  EventServerConfig,
  InterfaceToggles,
  RawConfig,
  ResolvedConfig,
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
  bidcosWired: false,
  virtualDevices: true,
  cuxd: false,
};

const DEFAULT_EVENT_SERVER: EventServerConfig = {
  host: '0.0.0.0',
  port: 9875,
  watchdogSeconds: 300,
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

export function resolveConfig(raw: RawConfig): ResolvedConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('Plugin config is empty or invalid');
  }

  const ccuIp = raw.ccuIp;
  if (!isValidHost(ccuIp)) {
    throw new ConfigError('ccuIp is required and must be a valid hostname or IP address');
  }

  const interfaces: InterfaceToggles = {
    ...DEFAULT_INTERFACES,
    ...(raw.interfaces ?? {}),
  };

  const useTls = Boolean(raw.useTls ?? false);

  const ccuAuth = {
    enabled: Boolean(raw.ccuAuth?.enabled ?? false),
    username: typeof raw.ccuAuth?.username === 'string' ? raw.ccuAuth.username : undefined,
    password: typeof raw.ccuAuth?.password === 'string' ? raw.ccuAuth.password : undefined,
  };
  if (ccuAuth.enabled && (!ccuAuth.username || !ccuAuth.password)) {
    throw new ConfigError('ccuAuth.enabled is true but username/password are missing');
  }

  const evHost = raw.eventServer?.host ?? DEFAULT_EVENT_SERVER.host;
  if (typeof evHost !== 'string' || evHost.length === 0) {
    throw new ConfigError('eventServer.host must be a non-empty string');
  }
  const evPort = Number(raw.eventServer?.port ?? DEFAULT_EVENT_SERVER.port);
  if (!Number.isInteger(evPort) || evPort < 1024 || evPort > 65535) {
    throw new ConfigError('eventServer.port must be an integer in [1024, 65535]');
  }
  const evWatchdog = Number(raw.eventServer?.watchdogSeconds ?? DEFAULT_EVENT_SERVER.watchdogSeconds);
  if (!Number.isInteger(evWatchdog) || evWatchdog < 30 || evWatchdog > 3600) {
    throw new ConfigError('eventServer.watchdogSeconds must be an integer in [30, 3600]');
  }

  const channels = Array.isArray(raw.channels) ? raw.channels.filter(Boolean) : [];
  const variables = Array.isArray(raw.variables) ? raw.variables.filter(Boolean) : [];
  const programs = Array.isArray(raw.programs) ? raw.programs.filter(Boolean) : [];

  const validInterfaceIds: ReadonlySet<CcuInterfaceId> = new Set([
    'BidCos-RF', 'HmIP-RF', 'BidCos-Wired', 'VirtualDevices', 'CUxD',
  ]);
  const interfacePorts: Partial<Record<CcuInterfaceId, number>> = {};
  if (raw.interfacePorts && typeof raw.interfacePorts === 'object') {
    for (const [k, v] of Object.entries(raw.interfacePorts)) {
      if (!validInterfaceIds.has(k as CcuInterfaceId)) {
        throw new ConfigError(`interfacePorts: unknown interface "${k}"`);
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
    ccuAuth,
    eventServer: { host: evHost, port: evPort, watchdogSeconds: evWatchdog },
    channels,
    variables,
    programs,
  };
}
