import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { Discovery, paramsetKey } from '../../src/ccu/Discovery.js';
import type { RpcDeviceDescription } from '../../src/ccu/RpcClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PluginStorage } from '../../src/util/storage.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';
import type { CcuInterfaceId } from '../../src/types.js';

const BID: RpcDeviceDescription[] = [
  { ADDRESS: 'ABC0000002', TYPE: 'HM-LC-Sw4-DR-2', PARENT: '', FIRMWARE: '2.4' },
  { ADDRESS: 'ABC0000002:1', TYPE: 'SWITCH', PARENT: 'ABC0000002', INDEX: 1 },
  { ADDRESS: 'ABC0000002:2', TYPE: 'SWITCH', PARENT: 'ABC0000002', INDEX: 2 },
];
const IP: RpcDeviceDescription[] = [
  { ADDRESS: '000A0000000B02', TYPE: 'HMIP-PS', PARENT: '', FIRMWARE: '2.24.8' },
  { ADDRESS: '000A0000000B02:3', TYPE: 'SWITCH_VIRTUAL_RECEIVER', PARENT: '000A0000000B02', INDEX: 3 },
];

let tmp = '';
let root = '';
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-discovery-'));
  root = path.join(tmp, 'homebridge-hap-homematic');
  vi.restoreAllMocks();
});

function setup(answers: Partial<Record<CcuInterfaceId, RpcDeviceDescription[] | Error>>) {
  const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1', eventServer: { callbackHost: '127.0.0.1' } });
  const log = new PrefixedLogger(makeLog(), 'disc');
  const ccu = new CcuClient({ config, log });
  vi.spyOn(ccu, 'listRawDevices').mockImplementation(async () => {
    const results = new Map<CcuInterfaceId, RpcDeviceDescription[]>();
    const errors = new Map<CcuInterfaceId, Error>();
    for (const id of ccu.enabledInterfaces()) {
      const a = answers[id];
      if (a instanceof Error) errors.set(id, a);
      else if (a) results.set(id, a);
    }
    return { results, errors };
  });
  const storage = new PluginStorage({ user: { storagePath: () => tmp } });
  const warn = vi.spyOn(log, 'warn');
  const discovery = new Discovery({ ccu, storage, log, now: () => new Date('2026-11-11T12:00:00.000Z') });
  return { ccu, discovery, warn, storage };
}

const readJson = async (name: string) => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));

describe('Discovery.run', () => {
  it('uses live answers, writes the cache and indexes addresses', async () => {
    const { ccu, discovery } = setup({ 'BidCos-RF': BID, 'HmIP-RF': IP });
    const index = vi.spyOn(ccu, 'indexDevices');
    const devices = await discovery.run();
    expect(devices.map((d) => d.address)).toEqual(['ABC0000002', '000A0000000B02']);
    expect(discovery.getDevices()).toBe(devices);
    expect(discovery.sourceOf('BidCos-RF')).toBe('live');
    expect(index).toHaveBeenCalledWith(devices);
    expect(await readJson('discovery.json')).toEqual({
      version: 1,
      interfaces: {
        'BidCos-RF': { fetchedAt: '2026-11-11T12:00:00.000Z', devices: BID },
        'HmIP-RF': { fetchedAt: '2026-11-11T12:00:00.000Z', devices: IP },
      },
    });
    expect(discovery.findDevice('HmIP-RF', '000A0000000B02')?.type).toBe('HMIP-PS');
    expect(discovery.findDevice('BidCos-RF', '000A0000000B02')).toBeUndefined();
    expect(discovery.findChannel('ABC0000002:2')?.channel.type).toBe('SWITCH');
    expect(discovery.findChannel('nope:1')).toBeUndefined();
  });

  it('falls back to the cache per interface and keeps the cached entry', async () => {
    await setup({ 'BidCos-RF': BID, 'HmIP-RF': IP }).discovery.run();
    const { discovery, warn } = setup({ 'BidCos-RF': BID, 'HmIP-RF': new Error('ECONNREFUSED') });
    const devices = await discovery.run();
    expect(devices.map((d) => d.interface)).toEqual(['BidCos-RF', 'HmIP-RF']);
    expect(discovery.sourceOf('HmIP-RF')).toBe('cache');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('using the cached device list'))).toBe(true);
    expect((await readJson('discovery.json')).interfaces['HmIP-RF'].devices).toEqual(IP);
  });

  it('warns when neither live nor cached data exist, without writing a cache', async () => {
    const { discovery, warn } = setup({});
    expect(await discovery.run()).toEqual([]);
    expect(discovery.sourceOf('BidCos-RF')).toBeUndefined();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('no cached device list'))).toHaveLength(2);
    await expect(fs.stat(path.join(root, 'discovery.json'))).rejects.toThrow();
  });

  it('rebuilds a broken or unexpected cache file', async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'discovery.json'), '{ broken');
    const a = setup({ 'BidCos-RF': new Error('x'), 'HmIP-RF': IP });
    await a.discovery.run();
    expect(a.warn.mock.calls.some((c) => String(c[0]).includes('Cannot read'))).toBe(true);

    await fs.writeFile(path.join(root, 'discovery.json'), JSON.stringify({ version: 1, interfaces: { 'HmIP-RF': { devices: 'x' } } }));
    const b = setup({ 'BidCos-RF': new Error('x'), 'HmIP-RF': IP });
    await b.discovery.run();
    expect(b.warn.mock.calls.some((c) => String(c[0]).includes('unexpected format'))).toBe(true);
    expect((await readJson('discovery.json')).interfaces['HmIP-RF'].devices).toEqual(IP);
  });

  it('logs but survives a cache write failure', async () => {
    const { discovery, warn, storage } = setup({ 'HmIP-RF': IP });
    vi.spyOn(storage, 'writeJson').mockRejectedValue(new Error('EROFS'));
    await discovery.run();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Cannot write'))).toBe(true);
  });
});

describe('Discovery paramsets', () => {
  it('fetches each type/firmware/channel-type combination once and caches it on disk', async () => {
    const { ccu, discovery } = setup({ 'BidCos-RF': BID, 'HmIP-RF': IP });
    await discovery.run();
    const get = vi.spyOn(ccu, 'getParamsetDescription').mockResolvedValue({ STATE: { TYPE: 'BOOL', OPERATIONS: 7 } });
    await discovery.loadParamsets(['ABC0000002:1', 'ABC0000002:2', 'ABC0000002:1', 'unknown:1']);
    expect(get.mock.calls.map((c) => c[0])).toEqual(['ABC0000002:1']);
    expect(discovery.getParamsetDescription('ABC0000002:2')).toEqual({ STATE: { TYPE: 'BOOL', OPERATIONS: 7 } });
    expect(discovery.getParamsetDescription('000A0000000B02:3')).toBeUndefined();
    expect(discovery.getParamsetDescription('unknown:1')).toBeUndefined();
    expect(Object.keys((await readJson('paramsets.json')).entries)).toEqual(['HM-LC-Sw4-DR-2|2.4|SWITCH']);

    // A new Discovery instance reads the cache instead of asking the CCU.
    const second = setup({ 'BidCos-RF': BID, 'HmIP-RF': IP });
    await second.discovery.run();
    const get2 = vi.spyOn(second.ccu, 'getParamsetDescription').mockResolvedValue({});
    await second.discovery.loadParamsets(['ABC0000002:1']);
    await second.discovery.loadParamsets(['ABC0000002:2']); // cache already loaded
    expect(get2).not.toHaveBeenCalled();
  });

  it('logs and skips failing channels', async () => {
    const { ccu, discovery, warn } = setup({ 'HmIP-RF': IP });
    await discovery.run();
    vi.spyOn(ccu, 'getParamsetDescription').mockRejectedValue(new Error('fault'));
    await discovery.loadParamsets(['000A0000000B02:3']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('getParamsetDescription'))).toBe(true);
    await expect(fs.stat(path.join(root, 'paramsets.json'))).rejects.toThrow();
  });

  it('builds the key without firmware when the device reports none', () => {
    expect(paramsetKey({ address: 'X', type: 'T', name: 'n', interface: 'HmIP-RF', channels: [] },
      { address: 'X:1', index: 1, type: 'C', name: 'n' })).toBe('T||C');
  });
});
