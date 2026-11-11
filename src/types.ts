// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Plugin-wide type declarations for the validated runtime config and
 * the persisted homebridge accessory context. These are the only shapes
 * that cross the boundary between the platform, CCU client, services,
 * and the custom-UI server, so they live in one place.
 */

import type { PlatformConfig } from 'homebridge';

/** The two radio interfaces this plugin talks to (XML-RPC only). */
export type CcuInterfaceId = 'BidCos-RF' | 'HmIP-RF';

export interface InterfaceToggles {
  bidcosRf: boolean;
  hmIpRf: boolean;
}

export interface EventServerConfig {
  /** Local bind address of the event server (default 0.0.0.0). */
  host: string;
  /** Address the CCU calls back (`http://<callbackHost>:<port>`). Required. */
  callbackHost: string;
  port: number;
  watchdogSeconds: number;
}

/** HTTP Basic auth on the XML-RPC ports (CCU setting "Authentifizierung"). */
export interface RpcAuthConfig {
  enabled: boolean;
  username?: string;
  password?: string;
}

/** Concrete, validated config used by everything below the platform. */
export interface ResolvedConfig {
  name: string;
  ccuIp: string;
  interfaces: InterfaceToggles;
  /** XML-RPC port overrides; defaults 2001 / 2010, with TLS 42001 / 42010. */
  interfacePorts: Partial<Record<CcuInterfaceId, number>>;
  useTls: boolean;
  rpcAuth: RpcAuthConfig;
  eventServer: EventServerConfig;
}

/**
 * One accessory to build, resolved from devices.json. `channel` is the
 * channel index for per-channel mappings and `undefined` for a mapping
 * of the whole device (e.g. IrrigationAccessory).
 */
export interface AccessoryMapping {
  interface: CcuInterfaceId;
  /** Device serial, e.g. `ABC0000002`. */
  device: string;
  channel?: number;
  /** Class name in the service registry, e.g. `SwitchAccessory`. */
  service: string;
  /** Variant within a service, e.g. `Outlet` vs `Switch` for SwitchAccessory. */
  variant?: string;
  name?: string;
  /** Service options (device and channel level merged, channel wins). */
  options: Record<string, unknown>;
  /** Per-channel entries of a device mapping (names, valve types …). */
  channels: Record<string, DevicesFileChannel>;
}

/** `<storagePath>/homebridge-hap-homematic/devices.json`, see docs/DEVICES.md. */
export interface DevicesFile {
  version: 1;
  devices: Record<string, DevicesFileDevice>;
}

export interface DevicesFileDevice {
  enabled?: boolean;
  /** `device` (one accessory, needs `service`) or `perChannel`. */
  mode?: 'device' | 'perChannel';
  service?: string;
  variant?: string;
  name?: string;
  options?: Record<string, unknown>;
  channels?: Record<string, DevicesFileChannel>;
}

export interface DevicesFileChannel {
  enabled?: boolean;
  service?: string;
  variant?: string;
  name?: string;
  options?: Record<string, unknown>;
  /** Service-specific scalar extras such as `valveType`. */
  [extra: string]: unknown;
}

/** Shape persisted on `accessory.context`, restored on Homebridge restart. */
export interface AccessoryContext {
  kind: 'channel' | 'device';
  /** Stable identifier: channel address, or device serial for `device`. */
  id: string;
  /** Service registry key chosen for this accessory. */
  service: string;
  /** Optional user-chosen variant within the service. */
  subtype?: string;
  /** Service-specific persisted settings (mapping options). */
  settings?: Record<string, unknown>;
  /** Last-known display name (used to detect renames). */
  name?: string;
}

/** What the platform expects in `homebridge.config.json` for this plugin. */
export interface RawConfig extends PlatformConfig {
  ccuIp?: string;
  interfaces?: Partial<InterfaceToggles>;
  interfacePorts?: Partial<Record<CcuInterfaceId, number>>;
  useTls?: boolean;
  rpcAuth?: Partial<RpcAuthConfig>;
  eventServer?: Partial<EventServerConfig>;
}

/** Discovery result from the CCU (XML-RPC `listDevices`). */
export interface CcuDevice {
  address: string;     // e.g. 000123 (no interface prefix)
  type: string;        // e.g. HmIP-PSM
  /** Placeholder name (`TYPE ADDRESS`); XML-RPC carries no names. */
  name: string;
  interface: CcuInterfaceId;
  firmware?: string;
  channels: CcuChannel[];
}

export interface CcuChannel {
  address: string;     // e.g. 000123:1
  index: number;
  type: string;        // e.g. SWITCH_VIRTUAL_RECEIVER
  name: string;
}
