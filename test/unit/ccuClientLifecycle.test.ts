// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Covers start/stop, XML-RPC discovery, routing and port selection of
 * CcuClient by stubbing RpcClient and the event server so we never open
 * sockets.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CcuClient, toDevices } from '../../src/ccu/CcuClient.js';
import { RpcClient, type RpcDeviceDescription } from '../../src/ccu/RpcClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';
import type { RawConfig } from '../../src/types.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeCcu(overrides: Partial<RawConfig> = {}): CcuClient {
  const config = resolveConfig({
    platform: 'HapHomematic',
    ccuIp: '127.0.0.1',
    eventServer: { host: '127.0.0.1', callbackHost: '127.0.0.1', port: 9876, watchdogSeconds: 60 },
    interfaces: { bidcosRf: false, hmIpRf: false },
    ...overrides,
  });
  return new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc') });
}

const BIDCOS_LIST: RpcDeviceDescription[] = [
  { ADDRESS: 'OEQ0000001', TYPE: 'HM-LC-Sw4-DR-2', PARENT: '', FIRMWARE: '2.4', CHILDREN: ['OEQ0000001:0', 'OEQ0000001:1'] },
  { ADDRESS: 'OEQ0000001:1', TYPE: 'SWITCH', PARENT: 'OEQ0000001', PARENT_TYPE: 'HM-LC-Sw4-DR-2', INDEX: 1 },
  { ADDRESS: 'OEQ0000001:0', TYPE: 'MAINTENANCE', PARENT: 'OEQ0000001', PARENT_TYPE: 'HM-LC-Sw4-DR-2', INDEX: 0 },
];
const HMIP_LIST: RpcDeviceDescription[] = [
  { ADDRESS: '0008DBE9971A0F', TYPE: 'HmIP-FROLL', PARENT: '' },
  { ADDRESS: '0008DBE9971A0F:4', TYPE: 'SHUTTER_VIRTUAL_RECEIVER', PARENT: '0008DBE9971A0F' },
];

describe('toDevices', () => {
  it('groups channels under their device, sorted by index, with placeholder names', () => {
    const [d] = toDevices(BIDCOS_LIST, 'BidCos-RF');
    expect(d).toMatchObject({
      address: 'OEQ0000001', type: 'HM-LC-Sw4-DR-2', name: 'HM-LC-Sw4-DR-2 OEQ0000001',
      interface: 'BidCos-RF', firmware: '2.4',
    });
    expect(d!.channels.map((c) => c.index)).toEqual([0, 1]);
    expect(d!.channels[1]).toEqual({
      address: 'OEQ0000001:1', index: 1, type: 'SWITCH', name: 'HM-LC-Sw4-DR-2 OEQ0000001:1',
    });
  });

  it('derives the index from the address when INDEX is missing', () => {
    const [d] = toDevices(HMIP_LIST, 'HmIP-RF');
    expect(d!.channels[0]!.index).toBe(4);
    expect(d).not.toHaveProperty('firmware');
  });

  it('skips junk entries and orphan channels', () => {
    const out = toDevices([
      null as unknown as RpcDeviceDescription,
      { ADDRESS: '', TYPE: 'X' },
      { ADDRESS: 'ORPHAN:1', TYPE: 'SWITCH', PARENT: 'ORPHAN' },
      { ADDRESS: 'NOTYPE' } as RpcDeviceDescription,
      { ADDRESS: 'NOTYPE:x', PARENT: 'NOTYPE' } as RpcDeviceDescription,
    ], 'BidCos-RF');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ address: 'NOTYPE', type: '', name: 'Device NOTYPE' });
    expect(out[0]!.channels[0]).toMatchObject({ index: 0, type: '', name: ' NOTYPE:x' });
  });
});

describe('CcuClient.listDevices (XML-RPC)', () => {
  it('queries every enabled interface and merges the result', async () => {
    const ccu = makeCcu({ interfaces: { bidcosRf: true, hmIpRf: true } });
    vi.spyOn(RpcClient.prototype, 'listDevices').mockImplementation(function (this: RpcClient) {
      return Promise.resolve(this.interfaceId === 'BidCos-RF' ? BIDCOS_LIST : HMIP_LIST);
    });
    const devices = await ccu.listDevices();
    expect(devices.map((d) => `${d.interface}:${d.address}`)).toEqual([
      'BidCos-RF:OEQ0000001', 'HmIP-RF:0008DBE9971A0F',
    ]);
  });

  it('skips a failing interface but rejects when all fail', async () => {
    const ccu = makeCcu({ interfaces: { bidcosRf: true, hmIpRf: true } });
    const spy = vi.spyOn(RpcClient.prototype, 'listDevices').mockImplementation(function (this: RpcClient) {
      return this.interfaceId === 'HmIP-RF' ? Promise.reject(new Error('down')) : Promise.resolve(BIDCOS_LIST);
    });
    expect(await ccu.listDevices()).toHaveLength(1);
    spy.mockRejectedValue(new Error('down'));
    await expect(ccu.listDevices()).rejects.toThrow('down');
  });

  it('returns [] when no interface is enabled', async () => {
    expect(await makeCcu().listDevices()).toEqual([]);
  });
});

describe('CcuClient.probeInterfaces', () => {
  it('reports system.listMethods per interface', async () => {
    const ccu = makeCcu({ interfaces: { bidcosRf: true, hmIpRf: true }, interfacePorts: { 'HmIP-RF': 42010 } });
    vi.spyOn(RpcClient.prototype, 'listMethods').mockImplementation(function (this: RpcClient) {
      return this.interfaceId === 'BidCos-RF' ? Promise.resolve(['a', 'b']) : Promise.reject(new Error('ECONNREFUSED'));
    });
    expect(await ccu.probeInterfaces()).toEqual([
      { interfaceId: 'BidCos-RF', port: 2001, ok: true, methods: 2 },
      { interfaceId: 'HmIP-RF', port: 42010, ok: false, error: 'ECONNREFUSED' },
    ]);
  });
});

describe('CcuClient start/stop', () => {
  it('start() succeeds without RPC subscriptions and stop() cleans up', async () => {
    const ccu = makeCcu();
    const start = vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    const stop = vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    await ccu.start();
    await ccu.start(); // idempotent
    expect(start).toHaveBeenCalledTimes(1);
    await ccu.stop();
    expect(stop).toHaveBeenCalled();
    await ccu.stop(); // idempotent
  });

  it('subscribes every enabled interface, with port overrides, and unsubscribes on stop', async () => {
    const ccu = makeCcu({ interfaces: { bidcosRf: true, hmIpRf: true }, interfacePorts: { 'BidCos-RF': 42001 } });
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    vi.spyOn(RpcClient.prototype, 'listDevices').mockResolvedValue([]);
    const sub = vi.spyOn(RpcClient.prototype, 'subscribe').mockResolvedValue(undefined);
    const unsub = vi.spyOn(RpcClient.prototype, 'unsubscribe').mockResolvedValue(undefined);
    const infos: string[] = [];
    vi.spyOn(ccu['log'] as unknown as { info: (...args: unknown[]) => void }, 'info')
      .mockImplementation((fmt: string, ...args: unknown[]) => {
        infos.push([fmt, ...args].map(String).join(' '));
      });
    await ccu.start();
    expect(sub).toHaveBeenCalledTimes(2);
    expect(infos.join('\n')).toMatch(/Using XML-RPC port %d for %s%s 42001 BidCos-RF $/m);
    expect(infos.join('\n')).toMatch(/Using XML-RPC port %d for %s%s 2010 HmIP-RF $/m);
    await ccu.stop();
    expect(unsub).toHaveBeenCalledTimes(2);
  });

  it('start() resolves when subscribe fails; the interface is DISCONNECTED and retried later; TLS uses 42001', async () => {
    const ccu = makeCcu({ interfaces: { bidcosRf: true, hmIpRf: false }, useTls: true });
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    vi.spyOn(RpcClient.prototype, 'subscribe').mockRejectedValue(new Error('init failed: connect ECONNREFUSED'));
    const infos: string[] = [];
    vi.spyOn(ccu['log'] as unknown as { info: (...args: unknown[]) => void }, 'info')
      .mockImplementation((...args: unknown[]) => { infos.push(args.map(String).join(' ')); });
    const states: string[] = [];
    ccu.on('interfaceState', (id: string, state: string) => states.push(`${id}:${state}`));
    await expect(ccu.start()).resolves.toBeUndefined();
    expect(infos.join('\n')).toMatch(/42001 BidCos-RF +\(TLS\)/);
    expect(ccu.getInterfaceState('BidCos-RF')).toBe('DISCONNECTED');
    expect(ccu.getInterfaceState('HmIP-RF')).toBeUndefined();
    expect(ccu.isLive()).toBe(false);
    expect(states).toEqual(['BidCos-RF:CONNECTING', 'BidCos-RF:DISCONNECTED']);
    await ccu.stop();
    expect(ccu.getInterfaceState('BidCos-RF')).toBe('STOPPED');
  });
});

describe('CcuClient resolveCallbackHost', () => {
  it('returns explicit host when not 0.0.0.0', () => {
    const ccu = makeCcu();
    const host = (ccu as unknown as { resolveCallbackHost(): string }).resolveCallbackHost();
    expect(host).toBe('127.0.0.1');
  });

  it('falls back when host is 0.0.0.0', () => {
    const ccu = makeCcu({ eventServer: { host: '0.0.0.0', callbackHost: '127.0.0.1', port: 9876 } });
    const host = (ccu as unknown as { resolveCallbackHost(): string }).resolveCallbackHost();
    expect(typeof host).toBe('string');
    expect(host.length).toBeGreaterThan(0);
  });
});

describe('CcuClient address → interface routing', () => {
  it('routes by the discovered device tree', async () => {
    const ccu = makeCcu({ interfaces: { bidcosRf: true, hmIpRf: true } });
    vi.spyOn(RpcClient.prototype, 'listDevices').mockImplementation(function (this: RpcClient) {
      // Deliberately swapped: the map, not the address shape, decides.
      return Promise.resolve(this.interfaceId === 'BidCos-RF'
        ? [{ ADDRESS: '0008DBE9971A0F', TYPE: 'X', PARENT: '' }, { ADDRESS: '0008DBE9971A0F:4', TYPE: 'Y', PARENT: '0008DBE9971A0F' }]
        : []);
    });
    await ccu.listDevices();
    const calls: string[] = [];
    vi.spyOn(RpcClient.prototype, 'setValue').mockImplementation(function (this: RpcClient) {
      calls.push(this.interfaceId);
      return Promise.resolve();
    });
    await ccu.setValue('0008DBE9971A0F:4', 'LEVEL', 0.5);
    await ccu.setValue('0008DBE9971A0F:9', 'LEVEL', 0.5); // device-level fallback
    expect(calls).toEqual(['BidCos-RF', 'BidCos-RF']);
  });

  it('falls back to the serial shape before discovery', async () => {
    const ccu = makeCcu({ interfaces: { bidcosRf: true, hmIpRf: true } });
    const calls: string[] = [];
    vi.spyOn(RpcClient.prototype, 'getValue').mockImplementation(function (this: RpcClient) {
      calls.push(this.interfaceId);
      return Promise.resolve(1);
    });
    await ccu.getValue('000A0000000B02:1', 'STATE');
    await ccu.getValue('OEQ0000001:1', 'STATE');
    await ccu.getValue('OEQ0000001', 'STATE');
    expect(calls).toEqual(['HmIP-RF', 'BidCos-RF', 'BidCos-RF']);
  });

  it('rejects addresses on a disabled interface', async () => {
    const ccu = makeCcu({ interfaces: { bidcosRf: true, hmIpRf: false } });
    await expect(ccu.setValue('000A0000000B02:1', 'STATE', true)).rejects.toThrow(/HmIP-RF is not enabled/);
  });
});

describe('CcuClient supervision wiring', () => {
  const fire = (ccu: CcuClient, ev: Record<string, unknown>) =>
    (ccu as unknown as { handleEvent(e: object): void }).handleEvent({ receivedAt: 0, ...ev });
  const activity = (ccu: CcuClient, method: string, callbackId: string) =>
    (ccu as unknown as { handleActivity(a: object): void }).handleActivity({ method, callbackId });

  it('re-subscribes a stale interface; own PONGs, foreign PONGs and callbacks keep it alive', async () => {
    const ccu = makeCcu({ interfaces: { bidcosRf: true, hmIpRf: true } });
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    vi.spyOn(RpcClient.prototype, 'unsubscribe').mockResolvedValue(undefined);
    vi.spyOn(RpcClient.prototype, 'ping').mockResolvedValue(undefined);
    const sub = vi.spyOn(RpcClient.prototype, 'subscribe').mockResolvedValue(undefined);
    const subscribed: string[] = [];
    ccu.on('subscribed', (id: string, reason: string) => subscribed.push(`${id}:${reason}`));
    await ccu.start();
    expect(ccu.isLive()).toBe(true);
    expect(subscribed).toEqual(['BidCos-RF:initial', 'HmIP-RF:initial']);

    const listener = vi.fn();
    ccu.registerListener('ABC0000002:1.STATE', listener);
    // Keep both alive for 3 minutes: BidCos by own PONG + CCU callbacks,
    // HmIP by a foreign client's PONG and a regular event.
    for (let t = 0; t < 180; t += 30) {
      fire(ccu, { callbackId: 'homebridge-hap-homematic:BidCos-RF', channelAddress: 'CENTRAL', datapoint: 'PONG',
        value: 'homebridge-hap-homematic:BidCos-RF' });
      activity(ccu, 'newDevices', 'homebridge-hap-homematic:BidCos-RF');
      fire(ccu, { callbackId: 'homebridge-hap-homematic:HmIP-RF', channelAddress: 'CENTRAL:0', datapoint: 'PONG', value: 'mb' });
      fire(ccu, { callbackId: 'homebridge-hap-homematic:HmIP-RF', channelAddress: 'ABC0000002:1', datapoint: 'STATE', value: true });
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(listener).toHaveBeenCalledTimes(6);
    expect(sub).toHaveBeenCalledTimes(2);

    // Unknown callback ids and event activity are ignored by the activity hook.
    activity(ccu, 'event', 'homebridge-hap-homematic:HmIP-RF');
    activity(ccu, 'listDevices', 'someone-else');
    fire(ccu, { callbackId: 'someone-else', channelAddress: 'CENTRAL', datapoint: 'PONG', value: 'x' });

    // Silence → both STALE → init again.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(subscribed).toEqual(['BidCos-RF:initial', 'HmIP-RF:initial', 'BidCos-RF:stale', 'HmIP-RF:stale']);
    await ccu.stop();
  });
});

describe('CcuClient Phase 3 additions', () => {
  type Inner = { callbackUrl: string; port: number; tls: boolean; auth?: unknown };
  const inner = (ccu: CcuClient, id: string) =>
    (ccu as unknown as { rpcClients: Map<string, Inner> }).rpcClients.get(id)!;

  it('builds the callback URL from eventServer.callbackHost and passes TLS / auth / ports', () => {
    const ccu = makeCcu({
      interfaces: { bidcosRf: true, hmIpRf: true },
      useTls: true,
      rpcAuth: { enabled: true, username: 'u', password: 'p' },
      interfacePorts: { 'HmIP-RF': 43010 },
      eventServer: { host: '0.0.0.0', callbackHost: '192.168.0.13', port: 9875 },
    });
    expect(ccu.enabledInterfaces()).toEqual(['BidCos-RF', 'HmIP-RF']);
    const bid = inner(ccu, 'BidCos-RF');
    expect(bid).toMatchObject({ callbackUrl: 'http://192.168.0.13:9875', port: 42001, tls: true, auth: { username: 'u', password: 'p' } });
    expect(inner(ccu, 'HmIP-RF').port).toBe(43010);
  });

  it('sends no auth while rpcAuth is disabled', () => {
    const ccu = makeCcu({ interfaces: { bidcosRf: true, hmIpRf: false }, rpcAuth: { enabled: false, username: 'u', password: 'p' } });
    expect(inner(ccu, 'BidCos-RF').auth).toBeUndefined();
  });

  it('listRawDevices reports results and errors per interface', async () => {
    const ccu = makeCcu({ interfaces: { bidcosRf: true, hmIpRf: true } });
    vi.spyOn(RpcClient.prototype, 'listDevices').mockImplementation(function (this: RpcClient) {
      return this.interfaceId === 'BidCos-RF' ? Promise.resolve(BIDCOS_LIST) : Promise.reject(new Error('down'));
    });
    const { results, errors } = await ccu.listRawDevices();
    expect([...results.keys()]).toEqual(['BidCos-RF']);
    expect(errors.get('HmIP-RF')?.message).toBe('down');
  });

  it('setInterfaceFor pins a serial; getParamsetDescription is routed', async () => {
    const ccu = makeCcu({ interfaces: { bidcosRf: true, hmIpRf: true } });
    ccu.setInterfaceFor('ABC0000009', 'HmIP-RF'); // BidCos-shaped serial pinned to HmIP
    const seen: string[] = [];
    vi.spyOn(RpcClient.prototype, 'getParamsetDescription').mockImplementation(function (this: RpcClient) {
      seen.push(this.interfaceId);
      return Promise.resolve({});
    });
    await ccu.getParamsetDescription('ABC0000009:1');
    await ccu.getParamsetDescription('ABC0000010:1');
    expect(seen).toEqual(['HmIP-RF', 'BidCos-RF']);
  });
});
