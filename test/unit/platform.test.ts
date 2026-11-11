// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { HomematicPlatform } from '../../src/platform.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { makeHapStub, makeLog } from '../helpers/hapStub.js';
import type { CcuInterfaceId } from '../../src/types.js';
import type { RpcDeviceDescription } from '../../src/ccu/RpcClient.js';
import { switchService } from '../../src/services/impl/SwitchAccessory.js';
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
  vi.restoreAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-platform-'));
});

/** Let the async launch chain (real fs I/O in tmpDir) settle. */
async function flushAsync(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeApi(): FakeApi {
  const api = new FakeApi();
  api.user.storagePath = () => tmpDir;
  return api;
}

const CFG = { platform: 'HapHomematic', ccuIp: '127.0.0.1', eventServer: { callbackHost: '127.0.0.1' } };
const PS = '000A0000000B02';
const PS_LIST: RpcDeviceDescription[] = [
  { ADDRESS: PS, TYPE: 'HMIP-PS', PARENT: '', FIRMWARE: '2.24.8' },
  { ADDRESS: `${PS}:0`, TYPE: 'MAINTENANCE', PARENT: PS, INDEX: 0 },
  { ADDRESS: `${PS}:1`, TYPE: 'SWITCH', PARENT: PS, INDEX: 1 },
  { ADDRESS: `${PS}:2`, TYPE: 'SWITCH', PARENT: PS, INDEX: 2 },
];

async function writeDevices(file: unknown): Promise<void> {
  const dir = path.join(tmpDir, 'homebridge-hap-homematic');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'devices.json'), JSON.stringify(file));
}

/** Stub the CCU side: listDevices answer (or error), no sockets. */
function stubCcu(platform: HomematicPlatform, raw: Partial<Record<CcuInterfaceId, RpcDeviceDescription[]>> | Error) {
  const ccu = platform.getCcu()!;
  vi.spyOn(ccu, 'start').mockResolvedValue(undefined);
  vi.spyOn(ccu, 'stop').mockResolvedValue(undefined);
  const list = vi.spyOn(ccu, 'listRawDevices').mockImplementation(async () => {
    const results = new Map<CcuInterfaceId, RpcDeviceDescription[]>();
    const errors = new Map<CcuInterfaceId, Error>();
    for (const id of ccu.enabledInterfaces()) {
      if (raw instanceof Error) errors.set(id, raw);
      else if (raw[id]) results.set(id, raw[id]!);
      else errors.set(id, new Error('no answer'));
    }
    return { results, errors };
  });
  const paramsets = vi.spyOn(ccu, 'getParamsetDescription').mockResolvedValue({ STATE: { TYPE: 'BOOL' } });
  return { ccu, list, paramsets };
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
    const platform = new HomematicPlatform(log, { platform: 'HapHomematic', ccuIp: '127.0.0.1', eventServer: { callbackHost: '127.0.0.1' } }, api as unknown as API);
    const acc = { UUID: 'uuid:test', displayName: 'X', context: {} } as unknown as PlatformAccessory;
    platform.configureAccessory(acc);
    expect(platform.getCcu()).toBeDefined();
  });

  it('shutdown stops the CCU client', async () => {
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, CFG, api as unknown as API);
    const ccu = platform.getCcu()!;
    const stopSpy = vi.spyOn(ccu, 'stop').mockResolvedValue(undefined);
    api.emit(APIEvent.SHUTDOWN);
    await flushAsync();
    expect(stopSpy).toHaveBeenCalled();
  });

  it('wires per-channel mappings from devices.json with D6 UUIDs, one listDevices and cached paramsets', async () => {
    await writeDevices({ version: 1, devices: {
      [`HmIP-RF:${PS}`]: { channels: {
        '1': { service: 'SwitchAccessory', variant: 'outlet', name: 'Kaffee' },
        '2': { service: 'SwitchAccessory' },
      } },
    } });
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, { ...CFG, channels: [{ address: 'x', service: 'y' }] }, api as unknown as API);
    const { ccu, list, paramsets } = stubCcu(platform, { 'HmIP-RF': PS_LIST });
    const pin = vi.spyOn(ccu, 'setInterfaceFor');
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();

    expect(list).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledWith(PS, 'HmIP-RF');
    expect(api.registered.map((a) => a.UUID)).toEqual([
      `uuid:HmIP-RF:${PS}:1:SwitchAccessory`,
      `uuid:HmIP-RF:${PS}:2:SwitchAccessory`,
    ]);
    const [a1, a2] = api.registered as unknown as Array<{ displayName: string; context: Record<string, unknown> }>;
    expect(a1!.displayName).toBe('Kaffee');
    expect(a1!.context).toMatchObject({ kind: 'channel', id: `${PS}:1`, service: 'SwitchAccessory', subtype: 'outlet' });
    expect(a2!.displayName).toBe(`HMIP-PS ${PS}:2`); // placeholder from discovery
    // paramsets per type/firmware/channel type: :1 and :2 share one entry
    expect(paramsets.mock.calls.map((c) => c[0]).sort()).toEqual([`${PS}:0`, `${PS}:1`]);
    const root = path.join(tmpDir, 'homebridge-hap-homematic');
    expect(JSON.parse(await fs.readFile(path.join(root, 'discovery.json'), 'utf8')).interfaces['HmIP-RF'].devices).toHaveLength(4);
    expect(Object.keys(JSON.parse(await fs.readFile(path.join(root, 'paramsets.json'), 'utf8')).entries)).toEqual([
      'HMIP-PS|2.24.8|MAINTENANCE', 'HMIP-PS|2.24.8|SWITCH',
    ]);
    expect(vi.mocked(log.warn).mock.calls.some((c) => String(c[0]).includes('"channels" is no longer used'))).toBe(true);
  });

  it('uses the cached device list when the CCU is unreachable', async () => {
    await writeDevices({ version: 1, devices: { [`HmIP-RF:${PS}`]: { channels: { '1': { service: 'SwitchAccessory' } } } } });
    await fs.writeFile(path.join(tmpDir, 'homebridge-hap-homematic', 'discovery.json'), JSON.stringify({
      version: 1, interfaces: { 'HmIP-RF': { fetchedAt: '2026-11-01T00:00:00.000Z', devices: PS_LIST } },
    }));
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, CFG, api as unknown as API);
    stubCcu(platform, new Error('ECONNREFUSED'));
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    const acc = api.registered[0] as unknown as { displayName: string } | undefined;
    expect(acc?.displayName).toBe(`HMIP-PS ${PS}:1`);
    expect(vi.mocked(log.warn).mock.calls.some((c) => String(c[0]).includes('using the cached device list'))).toBe(true);
  });

  it('registers a stub channel when neither CCU nor cache know the device', async () => {
    await writeDevices({ version: 1, devices: { 'BidCos-RF:ABC0000002': { channels: { '3': { service: 'SwitchAccessory', name: 'Stubby' } } } } });
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, CFG, api as unknown as API);
    stubCcu(platform, new Error('down'));
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    const acc = api.registered[0] as unknown as { displayName: string; UUID: string } | undefined;
    expect(acc?.UUID).toBe('uuid:BidCos-RF:ABC0000002:3:SwitchAccessory');
    expect(acc?.displayName).toBe('Stubby');
  });

  it('maps a whole device to one accessory on its first matching channel', async () => {
    await writeDevices({ version: 1, devices: {
      [`HmIP-RF:${PS}`]: { service: 'SwitchAccessory', name: 'Device', options: { invert: true },
        channels: { '1': { name: 'eins' } } },
      'BidCos-RF:ABC0000003': { service: 'ContactAccessory' }, // not discovered → stub :1
    } });
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, CFG, api as unknown as API);
    const { paramsets } = stubCcu(platform, { 'HmIP-RF': PS_LIST, 'BidCos-RF': [] });
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    const accs = api.registered as unknown as Array<{ UUID: string; displayName: string; context: Record<string, unknown> }>;
    expect(accs.map((a) => a.UUID)).toEqual([
      `uuid:HmIP-RF:${PS}:device:SwitchAccessory`,
      'uuid:BidCos-RF:ABC0000003:device:ContactAccessory',
    ]);
    expect(accs[0]!.context).toMatchObject({
      kind: 'device', id: PS, settings: { invert: true, channels: { '1': { name: 'eins' } } },
    });
    expect(accs[1]!.displayName).toBe('ABC0000003:1');
    // whole device → every channel considered; :1 and :2 share type and firmware → fetched once
    expect(paramsets.mock.calls.map((c) => c[0])).toEqual([`${PS}:0`, `${PS}:1`]);
  });

  it('falls back to the first non-maintenance channel when no channel type matches', async () => {
    await writeDevices({ version: 1, devices: { [`HmIP-RF:${PS}`]: { service: 'ThermostatAccessory' } } });
    const api = makeApi();
    const platform = new HomematicPlatform(makeLog(), CFG, api as unknown as API);
    stubCcu(platform, { 'HmIP-RF': PS_LIST });
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    const acc = api.registered[0] as unknown as { displayName: string };
    expect(acc.displayName).toBe(`HMIP-PS ${PS}:1`);
  });

  it('skips disabled devices and channels', async () => {
    await writeDevices({ version: 1, devices: {
      [`HmIP-RF:${PS}`]: { channels: { '1': { service: 'SwitchAccessory', enabled: false }, '2': { service: 'SwitchAccessory' } } },
      'BidCos-RF:ABC0000002': { enabled: false, service: 'SwitchAccessory' },
    } });
    const api = makeApi();
    const platform = new HomematicPlatform(makeLog(), CFG, api as unknown as API);
    stubCcu(platform, { 'HmIP-RF': PS_LIST });
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    expect(api.registered.map((a) => a.UUID)).toEqual([`uuid:HmIP-RF:${PS}:2:SwitchAccessory`]);
  });

  it('refuses an invalid devices.json, creates nothing and leaves the file untouched', async () => {
    const bad = { version: 1, devices: { [`HmIP-RF:${PS}`]: { channels: { '1': { service: 'NopeAccessory' } } } } };
    await writeDevices(bad);
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, CFG, api as unknown as API);
    const stale = { UUID: 'uuid:old', displayName: 'old', context: {} } as unknown as PlatformAccessory;
    platform.configureAccessory(stale);
    stubCcu(platform, { 'HmIP-RF': PS_LIST });
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    expect(api.registered).toHaveLength(0);
    expect(vi.mocked(log.error).mock.calls.some((c) => String(c[0]).includes('is invalid'))).toBe(true);
    const file = path.join(tmpDir, 'homebridge-hap-homematic', 'devices.json');
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(bad);
  });

  it('without devices.json: no accessories, stale ones removed', async () => {
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, CFG, api as unknown as API);
    const stale = { UUID: 'uuid:channel:OLD:1', displayName: 'old', context: {} } as unknown as PlatformAccessory;
    platform.configureAccessory(stale);
    stubCcu(platform, { 'HmIP-RF': [], 'BidCos-RF': [] });
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync(60);
    expect(api.unregistered).toEqual([stale]);
    expect(vi.mocked(log.info).mock.calls.some((c) => String(c[0]).includes('not found'))).toBe(true);
  });

  it('logs a startup failure instead of crashing', async () => {
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, CFG, api as unknown as API);
    const { ccu } = stubCcu(platform, {});
    vi.spyOn(ccu, 'start').mockRejectedValue(new Error('EADDRINUSE'));
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    expect(vi.mocked(log.error).mock.calls.some((c) => String(c[1]).includes('EADDRINUSE'))).toBe(true);
  });

  it('updates an existing cached accessory instead of re-registering', async () => {
    await writeDevices({ version: 1, devices: { [`HmIP-RF:${PS}`]: { channels: { '1': { service: 'SwitchAccessory' } } } } });
    const api = makeApi();
    const platform = new HomematicPlatform(makeLog(), CFG, api as unknown as API);
    const uuid = `uuid:HmIP-RF:${PS}:1:SwitchAccessory`;
    const cached = new (api.platformAccessory as new (n: string, u: string) => PlatformAccessory)(`HMIP-PS ${PS}:1`, uuid);
    platform.configureAccessory(cached);
    stubCcu(platform, { 'HmIP-RF': PS_LIST });
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    expect(api.updated).toContain(cached);
    expect(api.registered).toHaveLength(0);
  });

  it('renames a cached accessory and disposes handlers on shutdown', async () => {
    await writeDevices({ version: 1, devices: { [`HmIP-RF:${PS}`]: { channels: { '1': { service: 'SwitchAccessory', name: 'New Name' } } } } });
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, CFG, api as unknown as API);
    const cached = new (api.platformAccessory as new (n: string, u: string) => PlatformAccessory)(
      'Old Name', `uuid:HmIP-RF:${PS}:1:SwitchAccessory`);
    const setCharacteristic = vi.fn();
    const info = api.hap.Service.AccessoryInformation;
    (cached as unknown as { getService: unknown }).getService = vi.fn((svc: unknown) =>
      (svc === info ? { setCharacteristic } : undefined));
    platform.configureAccessory(cached);
    stubCcu(platform, { 'HmIP-RF': PS_LIST });
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

  it('after a re-subscribe: compares listDevices, warns about vanished mapped devices, refreshes that interface', async () => {
    await writeDevices({ version: 1, devices: { [`HmIP-RF:${PS}`]: { channels: { '1': { service: 'SwitchAccessory' } } } } });
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, CFG, api as unknown as API);
    const { ccu, list } = stubCcu(platform, { 'HmIP-RF': PS_LIST, 'BidCos-RF': [] });
    vi.spyOn(ccu, 'isLive').mockReturnValue(true);
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    expect(vi.mocked(log.success)).toHaveBeenCalled();

    const managed = (platform as unknown as { managed: Map<string, { handler: Record<string, unknown>; interface?: string }> }).managed;
    const refreshIp = vi.fn();
    const refreshBid = vi.fn();
    managed.set('ip', { handler: { refresh: refreshIp }, interface: 'HmIP-RF' });
    managed.set('ip2', { handler: { refresh: () => { throw new Error('refresh boom'); } }, interface: 'HmIP-RF' });
    managed.set('ip3', { handler: {}, interface: 'HmIP-RF' });
    managed.set('bid', { handler: { refresh: refreshBid }, interface: 'BidCos-RF' });

    ccu.emit('subscribed', 'HmIP-RF', 'initial'); // ignored
    await flushAsync(5);
    expect(list).toHaveBeenCalledTimes(1);

    // The device vanished and a new one appeared on HmIP-RF.
    list.mockResolvedValueOnce({
      results: new Map([['HmIP-RF', [{ ADDRESS: 'NEW0000001', TYPE: 'X', PARENT: '' }]], ['BidCos-RF', []]]),
      errors: new Map(),
    } as never);
    ccu.emit('subscribed', 'HmIP-RF', 'reconnect');
    await flushAsync();
    expect(list).toHaveBeenCalledTimes(2);
    expect(refreshIp).toHaveBeenCalledTimes(1);
    expect(refreshBid).not.toHaveBeenCalled();
    const infos = vi.mocked(log.info).mock.calls.map((c) => c.map(String).join(' '));
    expect(infos.some((t) => t.includes('after re-subscribe') && t.includes('HmIP-RF 1 1'))).toBe(true);
    const warns = vi.mocked(log.warn).mock.calls.map((c) => c.map(String).join(' '));
    expect(warns.some((t) => t.includes('no longer on the CCU') && t.includes(PS))).toBe(true);
    expect(warns.some((t) => t.includes('refresh boom'))).toBe(true);

    // A failing follow-up is logged and does not block the next one.
    list.mockRejectedValueOnce(new Error('disc boom'));
    ccu.emit('subscribed', 'HmIP-RF', 'stale');
    await flushAsync();
    expect(vi.mocked(log.warn).mock.calls.some((c) => String(c[1]).includes('disc boom'))).toBe(true);
    ccu.emit('subscribed', 'BidCos-RF', 'stale'); // no changes → no info line
    await flushAsync();
    expect(refreshBid).toHaveBeenCalledTimes(1);
  });

  it('warns when no interface is reachable at start', async () => {
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, CFG, api as unknown as API);
    stubCcu(platform, {});
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    expect(vi.mocked(log.warn).mock.calls.some((c) => String(c[0]).includes('not reachable yet'))).toBe(true);
  });

  it('phase 5 wiring: HmIP pairing, device to attach, start values via refresh, persist, describer', async () => {
    await writeDevices({ version: 1, devices: { [`HmIP-RF:${PS}`]: { channels: { '4': { service: 'SwitchAccessory' } } } } });
    const api = makeApi();
    const platform = new HomematicPlatform(makeLog(), CFG, api as unknown as API);
    const list: RpcDeviceDescription[] = [
      { ADDRESS: PS, TYPE: 'HMIP-PS', PARENT: '', FIRMWARE: '2.24.8' },
      { ADDRESS: `${PS}:2`, TYPE: 'SWITCH_TRANSMITTER', PARENT: PS, INDEX: 2 },
      { ADDRESS: `${PS}:3`, TYPE: 'SWITCH_VIRTUAL_RECEIVER', PARENT: PS, INDEX: 3 },
      { ADDRESS: `${PS}:4`, TYPE: 'SWITCH_VIRTUAL_RECEIVER', PARENT: PS, INDEX: 4 },
    ];
    const { ccu, paramsets } = stubCcu(platform, { 'HmIP-RF': list });
    paramsets.mockResolvedValue({ STATE: { TYPE: 'BOOL' } });
    const attach = vi.fn();
    const refresh = vi.fn(async () => undefined);
    let ctxSeen: { persist?: () => void; hap?: unknown } = {};
    vi.spyOn(switchService, 'build').mockImplementation((ctx) => {
      ctxSeen = ctx;
      return { attach, refresh };
    });
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    const [channel, device] = attach.mock.calls[0]!;
    expect(channel).toMatchObject({ address: `${PS}:3`, stateAddress: `${PS}:2`, type: 'SWITCH_VIRTUAL_RECEIVER' });
    expect(device.address).toBe(PS);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(ctxSeen.hap).toBeDefined();
    ctxSeen.persist!();
    expect(api.updated.length).toBeGreaterThan(0);
    expect(ccu.describe(`${PS}:3`, 'STATE')).toEqual({ TYPE: 'BOOL' });
  });

  it('a failing refresh is logged and does not stop the start', async () => {
    await writeDevices({ version: 1, devices: { [`HmIP-RF:${PS}`]: { channels: { '1': { service: 'SwitchAccessory' } } } } });
    const log = makeLog();
    const api = makeApi();
    const platform = new HomematicPlatform(log, CFG, api as unknown as API);
    stubCcu(platform, { 'HmIP-RF': PS_LIST });
    vi.spyOn(switchService, 'build').mockImplementation(() => ({
      attach: vi.fn(), refresh: async () => { throw new Error('refresh boom'); },
    }));
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await flushAsync();
    expect(vi.mocked(log.warn).mock.calls.some((c) => String(c[1]).includes('refresh boom'))).toBe(true);
  });
});
