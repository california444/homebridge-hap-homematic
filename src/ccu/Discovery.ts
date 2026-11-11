/**
 * Device discovery over XML-RPC with on-disk caches (plan sections 4.1, 6).
 *
 *   discovery.json  raw `listDevices` answer per interface. Used when an
 *                   interface is unreachable at start, so accessories still
 *                   get their channel types.
 *   paramsets.json  `getParamsetDescription(…, 'VALUES')` per combination
 *                   of device type, firmware and channel type. Fetched once
 *                   per new combination; the call causes no radio traffic.
 *
 * Both files are caches: a broken or outdated file is replaced, never
 * trusted over a live answer.
 */

import { toDevices, type CcuClient } from './CcuClient.js';
import type { ParameterDescription, RpcDeviceDescription } from './RpcClient.js';
import type { CcuChannel, CcuDevice, CcuInterfaceId } from '../types.js';
import type { PluginStorage } from '../util/storage.js';
import type { PrefixedLogger } from '../util/logger.js';

export const DISCOVERY_CACHE_FILE = 'discovery.json';
export const PARAMSET_CACHE_FILE = 'paramsets.json';

export interface DiscoveryCache {
  version: 1;
  interfaces: Partial<Record<CcuInterfaceId, { fetchedAt: string; devices: RpcDeviceDescription[] }>>;
}

export interface ParamsetCache {
  version: 1;
  /** key: `<device type>|<firmware>|<channel type>` */
  entries: Record<string, Record<string, ParameterDescription>>;
}

export interface DiscoveryOptions {
  ccu: CcuClient;
  storage: PluginStorage;
  log: PrefixedLogger;
  now?: () => Date;
}

type Source = 'live' | 'cache';

export class Discovery {
  private readonly ccu: CcuClient;
  private readonly storage: PluginStorage;
  private readonly log: PrefixedLogger;
  private readonly now: () => Date;
  private devices: CcuDevice[] = [];
  private readonly sources = new Map<CcuInterfaceId, Source>();
  private paramsets: ParamsetCache = { version: 1, entries: {} };
  private paramsetsLoaded = false;

  constructor(opts: DiscoveryOptions) {
    this.ccu = opts.ccu;
    this.storage = opts.storage;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * `listDevices` on every enabled interface; per interface fall back to
   * the cache if the call fails. Updates the cache with live answers and
   * the CcuClient's address → interface map.
   */
  async run(): Promise<CcuDevice[]> {
    const cache = await this.readCache<DiscoveryCache>(DISCOVERY_CACHE_FILE, isDiscoveryCache)
      ?? { version: 1, interfaces: {} };
    const { results, errors } = await this.ccu.listRawDevices();
    let dirty = false;
    const devices: CcuDevice[] = [];
    this.sources.clear();

    for (const id of this.ccu.enabledInterfaces()) {
      const live = results.get(id);
      if (live) {
        cache.interfaces[id] = { fetchedAt: this.now().toISOString(), devices: live };
        dirty = true;
        this.sources.set(id, 'live');
        devices.push(...toDevices(live, id));
        continue;
      }
      const msg = errors.get(id)?.message ?? 'no answer';
      const cached = cache.interfaces[id];
      if (cached) {
        this.log.warn('listDevices on %s failed (%s); using the cached device list from %s', id, msg, cached.fetchedAt);
        this.sources.set(id, 'cache');
        devices.push(...toDevices(cached.devices, id));
      } else {
        this.log.warn('listDevices on %s failed (%s) and no cached device list exists', id, msg);
      }
    }

    if (dirty) {
      await this.writeCache(DISCOVERY_CACHE_FILE, cache);
    }
    this.devices = devices;
    this.ccu.indexDevices(devices);
    this.log.info('Discovered %d devices (%s)', devices.length,
      [...this.sources].map(([id, src]) => `${id}: ${src}`).join(', ') || 'none');
    return devices;
  }

  /** Result of the last run(). */
  getDevices(): CcuDevice[] {
    return this.devices;
  }

  /** Where the device list of an interface came from in the last run(). */
  sourceOf(id: CcuInterfaceId): Source | undefined {
    return this.sources.get(id);
  }

  findDevice(intf: CcuInterfaceId, serial: string): CcuDevice | undefined {
    return this.devices.find((d) => d.interface === intf && d.address === serial);
  }

  findChannel(address: string): { device: CcuDevice; channel: CcuChannel } | undefined {
    for (const device of this.devices) {
      const channel = device.channels.find((c) => c.address === address);
      if (channel) {
        return { device, channel };
      }
    }
    return undefined;
  }

  /**
   * Make sure the paramset description of each channel is cached. Only
   * combinations not yet in paramsets.json are fetched. Failures are
   * logged and skipped.
   */
  async loadParamsets(channelAddresses: Iterable<string>): Promise<void> {
    await this.ensureParamsetCache();
    let dirty = false;
    for (const address of new Set(channelAddresses)) {
      const hit = this.findChannel(address);
      if (!hit) {
        continue;
      }
      const key = paramsetKey(hit.device, hit.channel);
      if (this.paramsets.entries[key]) {
        continue;
      }
      try {
        this.paramsets.entries[key] = await this.ccu.getParamsetDescription(address);
        dirty = true;
      } catch (err) {
        this.log.warn('getParamsetDescription(%s) failed: %s', address, (err as Error).message);
      }
    }
    if (dirty) {
      await this.writeCache(PARAMSET_CACHE_FILE, this.paramsets);
    }
  }

  /** Cached VALUES description of a channel, if loaded. */
  getParamsetDescription(address: string): Record<string, ParameterDescription> | undefined {
    const hit = this.findChannel(address);
    return hit ? this.paramsets.entries[paramsetKey(hit.device, hit.channel)] : undefined;
  }

  // --- internals -----------------------------------------------------

  private async ensureParamsetCache(): Promise<void> {
    if (this.paramsetsLoaded) {
      return;
    }
    this.paramsets = await this.readCache<ParamsetCache>(PARAMSET_CACHE_FILE, isParamsetCache)
      ?? { version: 1, entries: {} };
    this.paramsetsLoaded = true;
  }

  private async readCache<T>(name: string, guard: (v: unknown) => v is T): Promise<T | undefined> {
    try {
      const raw = await this.storage.readJson<unknown>(name);
      if (raw === undefined) {
        return undefined;
      }
      if (guard(raw)) {
        return raw;
      }
      this.log.warn('%s has an unexpected format; it will be rebuilt', name);
    } catch (err) {
      this.log.warn('Cannot read %s (%s); it will be rebuilt', name, (err as Error).message);
    }
    return undefined;
  }

  private async writeCache(name: string, value: unknown): Promise<void> {
    try {
      await this.storage.writeJson(name, value);
    } catch (err) {
      this.log.warn('Cannot write %s: %s', name, (err as Error).message);
    }
  }
}

export function paramsetKey(device: CcuDevice, channel: CcuChannel): string {
  return `${device.type}|${device.firmware ?? ''}|${channel.type}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isDiscoveryCache(v: unknown): v is DiscoveryCache {
  return isObject(v) && v.version === 1 && isObject(v.interfaces)
    && Object.values(v.interfaces).every((e) => isObject(e) && Array.isArray(e.devices));
}

function isParamsetCache(v: unknown): v is ParamsetCache {
  return isObject(v) && v.version === 1 && isObject(v.entries);
}
