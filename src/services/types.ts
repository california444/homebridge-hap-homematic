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
import type { AccessoryContext, CcuChannel } from '../types.js';

export interface ServiceContext {
  accessory: PlatformAccessory<AccessoryContext>;
  ccu: CcuClient;
  log: PrefixedLogger;
  Service: typeof Service;
  Characteristic: typeof Characteristic;
}

export interface ServiceVariant {
  /** Display name shown in the UI. */
  label: string;
  /** Stable subtype identifier saved in config / accessory.context. */
  id: string;
  /** Optional list of HAP service categories produced (informational only). */
  hapServices?: string[];
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
  /** Constructor for the per-accessory handler. */
  build(ctx: ServiceContext): ChannelService;
}

/** Implemented by per-accessory channel handlers. */
export interface ChannelService {
  /** Wire HAP services + characteristics. Called once after construction. */
  attach(channel: CcuChannel): void;
  /** Disconnect listeners; called when the accessory is removed. */
  dispose?(): void;
}
