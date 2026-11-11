// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * The DynamicPlatformPlugin entry point. Wires CCU client + service
 * registry + Homebridge accessory cache together. Lifecycle:
 *
 *   constructor()        — validate config, build CCU client
 *   configureAccessory() — restore one accessory from disk cache
 *   didFinishLaunching   — read devices.json, discover devices (with
 *                          cache), start CCU client, then materialize
 *                          one accessory per mapping
 *   shutdown             — stop CCU client (event server + RPC subs)
 */

import {
  APIEvent,
  type API,
  type Characteristic,
  type DynamicPlatformPlugin,
  type Logging,
  type PlatformAccessory,
  type PlatformConfig,
  type Service,
} from 'homebridge';
import { CcuClient } from './ccu/CcuClient.js';
import { Discovery } from './ccu/Discovery.js';
import { findServiceByKey, SERVICE_DEFINITIONS } from './services/registry.js';
import type { ChannelService, ServiceContext } from './services/types.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type {
  AccessoryContext,
  AccessoryMapping,
  CcuChannel,
  RawConfig,
  ResolvedConfig,
} from './types.js';
import { ConfigError, resolveConfig } from './util/config.js';
import { loadDevicesFile, mappingUuidSeed } from './util/devices.js';
import { PrefixedLogger } from './util/logger.js';
import { PluginStorage } from './util/storage.js';

interface ManagedAccessory {
  accessory: PlatformAccessory<AccessoryContext>;
  handler: ChannelService;
}

export class HomematicPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly api: API;

  private readonly log: PrefixedLogger;
  private readonly storage: PluginStorage;
  private readonly resolved: ResolvedConfig | undefined;
  private readonly ccu: CcuClient | undefined;
  private readonly discovery: Discovery | undefined;
  private readonly cachedAccessories = new Map<string, PlatformAccessory<AccessoryContext>>();
  private readonly managed = new Map<string, ManagedAccessory>();

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.log = new PrefixedLogger(log, PLATFORM_NAME);
    this.storage = new PluginStorage(api);

    try {
      this.resolved = resolveConfig(config as RawConfig);
      if (Array.isArray((config as { channels?: unknown }).channels)) {
        this.log.warn('config.json "channels" is no longer used; mappings live in %s/devices.json',
          this.storage.rootPath());
      }
    } catch (err) {
      if (err instanceof ConfigError) {
        // Per the verified-plugin rule: log and stay idle, do not crash.
        this.log.error('Plugin not configured: %s', err.message);
        return;
      }
      throw err;
    }

    this.ccu = new CcuClient({ config: this.resolved, log: this.log.child('ccu') });
    this.discovery = new Discovery({ ccu: this.ccu, storage: this.storage, log: this.log.child('discovery') });

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.didFinishLaunching().catch((err) => {
        this.log.error('Startup failed: %s', (err as Error).message);
      });
    });
    this.api.on(APIEvent.SHUTDOWN, () => {
      this.shutdown().catch((err) => {
        this.log.warn('Shutdown error: %s', (err as Error).message);
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory as PlatformAccessory<AccessoryContext>);
    this.log.debug('Restored accessory %s', accessory.displayName);
  }

  /** Public for the homebridge-ui server to query CCU on demand. */
  getCcu(): CcuClient | undefined {
    return this.ccu;
  }

  // --- private -------------------------------------------------------

  private async didFinishLaunching(): Promise<void> {
    if (!this.resolved || !this.ccu || !this.discovery) {
      return;
    }
    await this.storage.ensureRoot();

    const known = new Set(SERVICE_DEFINITIONS.map((d) => d.key));
    const { mappings } = await loadDevicesFile(this.storage, this.log, known);
    // devices.json names the interface of every mapped device.
    for (const m of mappings) {
      this.ccu.setInterfaceFor(m.device, m.interface);
    }

    // One listDevices per interface and start, with cache fallback.
    await this.discovery.run();
    await this.discovery.loadParamsets(this.paramsetAddresses(mappings));

    await this.ccu.start();
    this.log.success('Connected to CCU at %s', this.resolved.ccuIp);

    const seen = new Set<string>();
    for (const mapping of mappings) {
      const seed = mappingUuidSeed(mapping);
      try {
        const uuid = this.api.hap.uuid.generate(seed);
        seen.add(uuid);
        this.attachMapping(uuid, mapping);
      } catch (err) {
        this.log.warn('Skipping %s: %s', seed, (err as Error).message);
      }
    }

    // Drop cached accessories that are no longer mapped.
    const toRemove: PlatformAccessory[] = [];
    for (const [uuid, acc] of this.cachedAccessories) {
      if (!seen.has(uuid)) {
        toRemove.push(acc);
        this.cachedAccessories.delete(uuid);
      }
    }
    if (toRemove.length > 0) {
      this.log.info('Removing %d stale accessories', toRemove.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRemove);
    }
  }

  private async shutdown(): Promise<void> {
    for (const m of this.managed.values()) {
      try {
        m.handler.dispose?.();
      } catch (err) {
        this.log.debug('dispose error: %s', (err as Error).message);
      }
    }
    this.managed.clear();
    /* c8 ignore next 3 */
    if (this.ccu) {
      await this.ccu.stop();
    }
  }

  /** Mapped channels plus channel 0 (MAINTENANCE) of each mapped device. */
  private paramsetAddresses(mappings: AccessoryMapping[]): string[] {
    const out: string[] = [];
    for (const m of mappings) {
      out.push(`${m.device}:0`);
      if (m.channel !== undefined) {
        out.push(`${m.device}:${m.channel}`);
      } else {
        const device = this.discovery?.findDevice(m.interface, m.device);
        out.push(...(device?.channels ?? []).map((c) => c.address));
      }
    }
    return out;
  }

  private attachMapping(uuid: string, mapping: AccessoryMapping): void {
    /* c8 ignore start — unreachable: didFinishLaunching gates on ccu */
    if (!this.ccu || !this.discovery) {
      return;
    }
    /* c8 ignore stop */
    const def = findServiceByKey(mapping.service);
    if (!def) {
      throw new Error(`Unknown service: ${mapping.service}`);
    }

    const channel = this.resolveChannel(mapping, def.channelTypes);
    // mapping.name is the user-chosen HomeKit display name. Falls back to
    // the placeholder name from discovery (type + address).
    const displayName = mapping.name || channel.name;
    const isDevice = mapping.channel === undefined;
    const settings: Record<string, unknown> = isDevice
      ? { ...mapping.options, channels: mapping.channels }
      : { ...mapping.options };
    const accessory = this.getOrCreateAccessory<AccessoryContext>(uuid, displayName, {
      kind: isDevice ? 'device' : 'channel',
      id: isDevice ? mapping.device : channel.address,
      service: def.key,
      subtype: mapping.variant,
      settings,
      name: displayName,
    });
    const ctx: ServiceContext = {
      accessory,
      ccu: this.ccu,
      log: this.log.child(`svc:${def.key}:${channel.address}`),
      Service: this.Service,
      Characteristic: this.Characteristic,
    };
    const handler = def.build(ctx);
    handler.attach(channel);
    this.managed.set(uuid, { accessory, handler });
  }

  /**
   * The channel a handler attaches to. Per-channel mappings name it; for
   * device mappings it is the first channel whose type the service
   * supports (refined per service in Phase 5).
   */
  private resolveChannel(mapping: AccessoryMapping, channelTypes: string[]): CcuChannel {
    const device = this.discovery?.findDevice(mapping.interface, mapping.device);
    if (mapping.channel !== undefined) {
      const address = `${mapping.device}:${mapping.channel}`;
      return device?.channels.find((c) => c.address === address)
        ?? stubChannel(address, mapping.channel, mapping.name);
    }
    const channels = device?.channels ?? [];
    const match = channels.find((c) => channelTypes.includes(c.type)) ?? channels.find((c) => c.index > 0);
    return match ?? stubChannel(`${mapping.device}:1`, 1, mapping.name);
  }

  private getOrCreateAccessory<T extends AccessoryContext>(
    uuid: string,
    displayName: string,
    context: T,
  ): PlatformAccessory<T> {
    const existing = this.cachedAccessories.get(uuid) as PlatformAccessory<T> | undefined;
    if (existing) {
      Object.assign(existing.context, context);
      // If the user renamed the accessory, update the cached accessory's
      // display name + AccessoryInformation Name characteristic so
      // HomeKit shows the new name. Note: HomeKit caches the room/name
      // pairing on the device side too, so this only takes effect for
      // *newly-paired* HomeKit hubs — already-paired accessories keep
      // the user's manual rename in the Home app.
      if (existing.displayName !== displayName) {
        existing.displayName = displayName;
        const infoSvc = existing.getService(this.Service.AccessoryInformation);
        if (infoSvc) {
          infoSvc.setCharacteristic(this.Characteristic.Name, displayName);
        }
      }
      this.api.updatePlatformAccessories([existing]);
      return existing;
    }
    const accessory = new this.api.platformAccessory<T>(displayName, uuid);
    accessory.context = context;
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.cachedAccessories.set(uuid, accessory as unknown as PlatformAccessory<AccessoryContext>);
    return accessory;
  }
}

/**
 * Channel not currently visible (CCU unreachable, no cache) — a stub lets
 * the accessory register; events still flow once the CCU sees it.
 */
function stubChannel(address: string, index: number, name: string | undefined): CcuChannel {
  return { address, index, name: name ?? address, type: 'UNKNOWN' };
}
