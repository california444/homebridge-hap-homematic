// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Shared types for service classes. A service is a small adapter that
 * binds one CCU channel to one or more HAP services.
 *
 * Services are registered in `registry.ts` and selected by:
 *   1. The user's `subtype` in config.channels[i].subtype, if any.
 *   2. Otherwise the highest-priority service whose `channelTypes`
 *      includes the device's channel type.
 */

import type { Characteristic, PlatformAccessory, Service } from 'homebridge';
import type { CcuClient } from '../ccu/CcuClient.js';
import type { PrefixedLogger } from '../util/logger.js';
import type { AccessoryContext, CcuChannel, CcuDevice } from '../types.js';

/** The parts of `api.hap` the handlers need for HAP status errors. */
export interface HapStatus {
  HapStatusError: new (status: number) => Error;
  /** SERVICE_COMMUNICATION_FAILURE = -70402 */
  HAPStatus: { SERVICE_COMMUNICATION_FAILURE: number };
}

export interface ServiceContext {
  accessory: PlatformAccessory<AccessoryContext>;
  ccu: CcuClient;
  log: PrefixedLogger;
  Service: typeof Service;
  Characteristic: typeof Characteristic;
  /** For "No Response" on unknown values; tests may omit it. */
  hap?: HapStatus;
  /** Persist `accessory.context` (Homebridge accessory cache). */
  persist?: () => void;
}

export interface ServiceVariant {
  /** Display name shown in the UI. */
  label: string;
  /** Stable subtype identifier saved in config / accessory.context. */
  id: string;
  /** Optional list of HAP service categories produced (informational only). */
  hapServices?: string[];
}

/**
 * A user-settable option, rendered by the custom UI and stored in
 * devices.json (`options` of the mapping, or per channel for
 * `channelOptions`).
 */
export interface OptionSpec {
  key: string;
  label: string;
  type: 'boolean' | 'number' | 'enum' | 'text';
  default?: boolean | number | string;
  /** enum: allowed values (stored as given). */
  values?: string[];
  min?: number;
  max?: number;
  hint?: string;
}

export interface ServiceDefinition {
  /** Stable key used in config / accessory.context. */
  key: string;
  /** Human-readable description. */
  description: string;
  /** Channel-type strings this service can handle, e.g. `SWITCH_VIRTUAL_RECEIVER`. */
  channelTypes: string[];
  /** Lower number wins when multiple services claim the same channelType. */
  priority: number;
  /** Sub-variants the user can pick (optional). */
  variants?: ServiceVariant[];
  /** `device`: one accessory for the whole device (devices.json mode "device"). */
  scope?: 'channel' | 'device';
  /** Options of the mapping. */
  options?: OptionSpec[];
  /** Device scope: options per channel (e.g. valve name and type). */
  channelOptions?: OptionSpec[];
  /** Constructor for the per-accessory handler. */
  build(ctx: ServiceContext): ChannelService;
}

/** Implemented by per-accessory channel handlers. */
export interface ChannelService {
  /**
   * Wire HAP services + characteristics. Called once after construction.
   * `device` is the discovered device (all channels), if known; whole-
   * device services such as irrigation use it.
   */
  attach(channel: CcuChannel, device?: CcuDevice): void;
  /** Disconnect listeners; called when the accessory is removed. */
  dispose?(): void;
  /**
   * Re-read current values from the CCU. Called after every re-subscribe
   * of the channel's interface (CCU restart, stale subscription), because
   * events during the outage are lost (plan 7.3, 4.2).
   */
  refresh?(): void | Promise<void>;
}
