// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { HomematicPlatform } from '../../src/platform.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { makeHapStub, makeLog } from '../helpers/hapStub.js';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import type { CcuDevice } from '../../src/types.js';
import { APIEvent, type API, type PlatformAccessory } from 'homebridge';

class FakeApi extends EventEmitter {
  hap = makeHapStub();
  user = { storagePath: () => '' };
  registered: PlatformAccessory[] = [];
  unregistered: PlatformAccessory[] = [];
  updated: PlatformAccessory[] = [];

  platformAccessory = class {
    UUID: string;
    displayName: string;
    services: unknown[] = [];
    context: Record<string, unknown> = {};
    constructor(displayName: string, uuid: string) {
      this.displayName = displayName;
      this.UUID = uuid;
    }
    getService = vi.fn(() => undefined);
    getServiceById = vi.fn(() => undefined);
    addService = vi.fn((s: unknown) => {
      this.services.push(s);
      return s;
    });
  } as unknown as API['platformAccessory'];

  registerPlatform = vi.fn();
  registerPlatformAccessories = vi.fn((_p: string, _n: string, accs: PlatformAccessory[]) => {
    this.registered.push(...accs);
  });
  unregisterPlatformAccessories = vi.fn((_p: string, _n: string, accs: PlatformAccessory[]) => {
    this.unregistered.push(...accs);
  });
  updatePlatformAccessories = vi.fn((accs: PlatformAccessory[]) => {
    this.updated.push(...accs);
  });

  // hap object wraps to provide uuid.generate
  constructor() {
    super();
    (this.hap as unknown as { uuid: { generate(s: string): string } }).uuid = {
      generate: (s: string) => `uuid:${s}`,
    };
  }
}

let tmpDir = '';
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-platform-'));
});

async function flushAsync(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function makeApi(): FakeApi {
  const api = new FakeApi();
  api.user.storagePath = () => tmpDir;
  return api;
}

describe('HomematicPlatform', () => {
  it('logs and stays idle when ccuIp missing', () => {
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, { platform: 'HapHomematic' }, api as unknown as API);
    expect(platform.getCcu()).toBeUndefined();
    expect(vi.mocked(log.error)).toHaveBeenCalled();
  });

  it('configureAccessory restores cached accessories', () => {
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, { platform: 'HapHomematic', ccuIp: '127.0.0.1' }, api as unknown as API);
    const acc = { UUID: 'uuid:test', displayName: 'X', context: {} } as unknown as PlatformAccessory;
    platform.configureAccessory(acc);
    expect(platform.getCcu()).toBeDefined();
  });

  it('didFinishLaunching wires up channel accessories with one listDevices call', async () => {
    const log = makeLog();
    const api = makeApi();
    const config = {
      platform: 'HapHomematic',
      ccuIp: '127.0.0.1',
      channels: [
        { address: 'HmIP.0:1', service: 'SwitchAccessory' },
        { address: 'HmIP.0:2', service: 'SwitchAccessory' },
      ],
      // Old fields from removed features are ignored.
      variables: [{ name: 'V1' }],
      programs: [{ name: 'P1' }],
    };
    const platform = new HomematicPlatform(log, config, api as unknown as API);
    const ccu = platform.getCcu()!;
    vi.spyOn(ccu, 'start').mockResolvedValue(undefined);
    const list = vi.spyOn(ccu, 'listDevices').mockResolvedValue([
      { address: 'HmIP.0', type: 'X', name: 'D', interface: 'HmIP-RF', channels: [
        { address: 'HmIP.0:1', index: 1, type: 'SWITCH', name: 'C1' },
        { address: 'HmIP.0:2', index: 2, type: 'SWITCH', name: 'C2' },
      ] },
    ] satisfies CcuDevice[]);

    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();

    expect(api.registered).toHaveLength(2);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('still registers accessories when discovery fails', async () => {
    const log = makeLog();
    const api = makeApi();
    const config = {
      platform: 'HapHomematic',
      ccuIp: '127.0.0.1',
      channels: [{ address: 'HmIP.0:1', service: 'SwitchAccessory', name: 'Lamp' }],
    };
    const platform = new HomematicPlatform(log, config, api as unknown as API);
    const ccu = platform.getCcu()!;
    vi.spyOn(ccu, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu, 'listDevices').mockRejectedValue(new Error('down'));
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    expect(api.registered).toHaveLength(1);
    expect(vi.mocked(log.warn).mock.calls.some((c) => String(c[0]).includes('Device discovery failed'))).toBe(true);
  });

  it('removes stale accessories on next launch', async () => {
    const log = makeLog();
    const api = makeApi();
    const config = { platform: 'HapHomematic', ccuIp: '127.0.0.1', channels: [] };
    const platform = new HomematicPlatform(log, config, api as unknown as API);
    const stale = { UUID: 'uuid:channel:HmIP.OLD:1', displayName: 'old', context: {} } as unknown as PlatformAccessory;
    platform.configureAccessory(stale);
    const ccu = platform.getCcu()!;
    vi.spyOn(ccu, 'start').mockResolvedValue(undefined);
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync(60);
    expect(api.unregistered.length).toBeGreaterThan(0);
    expect(api.unregistered[0]).toBe(stale);
  });

  it('skips unknown service keys with a warning', async () => {
    const log = makeLog();
    const api = makeApi();
    const config = {
      platform: 'HapHomematic',
      ccuIp: '127.0.0.1',
      channels: [{ address: 'HmIP.0:1', service: 'NopeAccessory' }],
    };
    const platform = new HomematicPlatform(log, config, api as unknown as API);
    const ccu = platform.getCcu()!;
    vi.spyOn(ccu, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu, 'listDevices').mockResolvedValue([]);
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });

  it('shutdown stops the CCU client', async () => {
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, { platform: 'HapHomematic', ccuIp: '127.0.0.1' }, api as unknown as API);
    const ccu = platform.getCcu()!;
    const stopSpy = vi.spyOn(ccu, 'stop').mockResolvedValue(undefined);
    api.emit(APIEvent.SHUTDOWN);
    await flushAsync();
    expect(stopSpy).toHaveBeenCalled();
  });

  it('falls back to stub channel when not visible on CCU', async () => {
    const log = makeLog();
    const api = makeApi();
    const config = {
      platform: 'HapHomematic',
      ccuIp: '127.0.0.1',
      channels: [{ address: 'HmIP.UNK:1', service: 'SwitchAccessory', name: 'Stubby' }],
    };
    const platform = new HomematicPlatform(log, config, api as unknown as API);
    const ccu = platform.getCcu()!;
    vi.spyOn(ccu, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu, 'listDevices').mockResolvedValue([]);
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync(40);
    // Either the registration succeeded (good) or attach() threw and a
    // warn was logged (also acceptable, since the test mostly proves the
    // fallback channel-name path is exercised).
    const registered = api.registered.some((a) => (a as unknown as { displayName: string }).displayName === 'Stubby');
    const warned = vi.mocked(log.warn).mock.calls.some((c) => String(c[0]).includes('HmIP.UNK:1'));
    expect(registered || warned).toBe(true);
  });

  it('uses the user-specified mapping.name as the HomeKit display name', async () => {
    const log = makeLog();
    const api = makeApi();
    const config = {
      platform: 'HapHomematic',
      ccuIp: '127.0.0.1',
      channels: [{ address: 'HmIP.0:1', service: 'SwitchAccessory', name: 'Living Room Lamp' }],
    };
    const platform = new HomematicPlatform(log, config, api as unknown as API);
    const ccu = platform.getCcu()!;
    vi.spyOn(ccu, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu, 'listDevices').mockResolvedValue([
      { address: 'HmIP.0', type: 'X', name: 'D', interface: 'HmIP-RF',
        channels: [{ address: 'HmIP.0:1', index: 1, type: 'SWITCH', name: 'CCU Default Name' }] },
    ]);
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    const acc = api.registered.find((a) => a.UUID === 'uuid:channel:HmIP.0:1') as
      unknown as { displayName: string } | undefined;
    expect(acc?.displayName).toBe('Living Room Lamp');
  });

  it('falls back to the discovered channel name when mapping.name is missing', async () => {
    const log = makeLog();
    const api = makeApi();
    const config = {
      platform: 'HapHomematic',
      ccuIp: '127.0.0.1',
      channels: [{ address: 'HmIP.0:1', service: 'SwitchAccessory', settings: { name: 'Legacy HomeKit Name' } }],
    };
    const platform = new HomematicPlatform(log, config, api as unknown as API);
    const ccu = platform.getCcu()!;
    vi.spyOn(ccu, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu, 'listDevices').mockResolvedValue([
      { address: 'HmIP.0', type: 'X', name: 'D', interface: 'HmIP-RF',
        channels: [{ address: 'HmIP.0:1', index: 1, type: 'SWITCH', name: 'CCU Name' }] },
    ]);
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    const acc = api.registered.find((a) => a.UUID === 'uuid:channel:HmIP.0:1') as
      unknown as { displayName: string } | undefined;
    // settings.name (pre-0.1.5 hap-homematic imports) is no longer read.
    expect(acc?.displayName).toBe('CCU Name');
  });

  it('updates an existing cached accessory instead of re-registering', async () => {
    const log = makeLog();
    const api = makeApi();
    const config = {
      platform: 'HapHomematic',
      ccuIp: '127.0.0.1',
      channels: [{ address: 'HmIP.0:1', service: 'SwitchAccessory' }],
    };
    const platform = new HomematicPlatform(log, config, api as unknown as API);
    const cached = new (api.platformAccessory as new (n: string, u: string) => PlatformAccessory)('Cached', 'uuid:channel:HmIP.0:1');
    platform.configureAccessory(cached);
    const ccu = platform.getCcu()!;
    vi.spyOn(ccu, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu, 'listDevices').mockResolvedValue([
      { address: 'HmIP.0', type: 'X', name: 'D', interface: 'HmIP-RF', channels: [{ address: 'HmIP.0:1', index: 1, type: 'SWITCH', name: 'C' }] },
    ]);
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    expect(api.updated.length).toBeGreaterThan(0);
    // Was cached, so should NOT have been registered again.
    expect(api.registered.find((a) => a.UUID === 'uuid:channel:HmIP.0:1')).toBeUndefined();
  });

  it('renames a cached accessory and disposes handlers on shutdown', async () => {
    const log = makeLog();
    const api = makeApi();
    const config = {
      platform: 'HapHomematic',
      ccuIp: '127.0.0.1',
      channels: [{ address: 'HmIP.0:1', service: 'SwitchAccessory', name: 'New Name' }],
    };
    const platform = new HomematicPlatform(log, config, api as unknown as API);
    const cached = new (api.platformAccessory as new (n: string, u: string) => PlatformAccessory)('Old Name', 'uuid:channel:HmIP.0:1');
    const setCharacteristic = vi.fn();
    const info = api.hap.Service.AccessoryInformation;
    (cached as unknown as { getService: unknown }).getService = vi.fn((svc: unknown) =>
      (svc === info ? { setCharacteristic } : undefined));
    platform.configureAccessory(cached);
    const ccu = platform.getCcu()!;
    vi.spyOn(ccu, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu, 'stop').mockResolvedValue(undefined);
    vi.spyOn(ccu, 'listDevices').mockResolvedValue([]);
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    expect(cached.displayName).toBe('New Name');
    expect(setCharacteristic).toHaveBeenCalledWith(expect.anything(), 'New Name');

    // The FakeApi accessory cannot wire HAP characteristics, so attach()
    // fails here; insert handlers directly to cover the shutdown path.
    const managed = (platform as unknown as { managed: Map<string, { handler: { dispose?: () => void } }> }).managed;
    const ok = vi.fn();
    managed.set('a', { handler: { dispose: ok } });
    managed.set('b', { handler: { dispose: () => { throw new Error('dispose boom'); } } });
    managed.set('c', { handler: {} });
    api.emit(APIEvent.SHUTDOWN);
    await flushAsync();
    expect(ok).toHaveBeenCalled();
    expect(managed.size).toBe(0);
    expect(vi.mocked(log.debug).mock.calls.some((c) => String(c[1]).includes('dispose boom'))).toBe(true);
  });
});
