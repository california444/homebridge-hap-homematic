// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Covers start/stop/list-* and watchdog branches of CcuClient by stubbing
 * the JSON-RPC client and the event server so we never open sockets.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function makeCcu(): CcuClient {
  const config = resolveConfig({
    platform: 'HapHomematic',
    ccuIp: '127.0.0.1',
    eventServer: { host: '127.0.0.1', port: 9876, watchdogSeconds: 60 },
    interfaces: { bidcosRf: false, hmIpRf: false, bidcosWired: false, virtualDevices: false, cuxd: false },
  });
  return new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc') });
}

describe('CcuClient list*()', () => {
  it('listDevices delegates to the JSON-RPC client', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([
      { address: 'HmIP.000123', name: 'X', type: 'T', interface: 'HmIP-RF', channels: [] },
    ]);
    const devices = await ccu.listDevices();
    expect(devices).toHaveLength(1);
  });

  it('listVariables delegates to the JSON-RPC client', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listVariables').mockResolvedValue([
      { id: '1', name: 'V', valuetype: 2, subtype: 0, value: true },
    ]);
    expect((await ccu.listVariables())).toHaveLength(1);
  });

  it('listPrograms delegates to the JSON-RPC client', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listPrograms').mockResolvedValue([{ id: '1', name: 'P' }]);
    expect((await ccu.listPrograms())).toHaveLength(1);
  });

  it('listRooms delegates to the JSON-RPC client', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listRooms').mockResolvedValue([
      { id: '1', name: 'Living', channelIds: ['10', '11'] },
    ]);
    const rooms = await ccu.listRooms();
    expect(rooms[0]?.name).toBe('Living');
    expect(rooms[0]?.channelIds).toEqual(['10', '11']);
  });
});

describe('CcuClient start/stop with no enabled interfaces', () => {
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
});

describe('CcuClient resolveCallbackHost', () => {
  it('returns explicit host when not 0.0.0.0', () => {
    const ccu = makeCcu();
    const host = (ccu as unknown as { resolveCallbackHost(): string }).resolveCallbackHost();
    expect(host).toBe('127.0.0.1');
  });

  it('falls back when host is 0.0.0.0', () => {
    const config = resolveConfig({
      platform: 'HapHomematic',
      ccuIp: '127.0.0.1',
      eventServer: { host: '0.0.0.0', port: 9876 },
    });
    const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc') });
    const host = (ccu as unknown as { resolveCallbackHost(): string }).resolveCallbackHost();
    expect(typeof host).toBe('string');
    expect(host.length).toBeGreaterThan(0);
  });
});

describe('CcuClient setValue/getValue fallback to JSON-RPC', () => {
  it('falls back to api.setInterfaceValue when no XML-RPC client is subscribed', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('HmIP-RF.000123:1', 'STATE', true);
    expect(spy).toHaveBeenCalledWith('HmIP-RF', '000123:1', 'STATE', 'boolean', true);
  });

  it('falls back to api.getInterfaceValue when no XML-RPC client is subscribed', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'getInterfaceValue').mockResolvedValue('22.4');
    const v = await ccu.getValue('HmIP-RF.000123:1', 'ACTUAL_TEMPERATURE');
    expect(v).toBe('22.4');
    expect(spy).toHaveBeenCalledWith('HmIP-RF', '000123:1', 'ACTUAL_TEMPERATURE');
  });

  it('routes integer values through JSON-RPC with type=integer', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('HmIP-RF.000:1', 'KEY', 42);
    expect(spy).toHaveBeenCalledWith('HmIP-RF', '000:1', 'KEY', 'integer', 42);
  });

  it('routes float values through JSON-RPC with type=double', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('HmIP-RF.000:1', 'LEVEL', 0.75);
    expect(spy).toHaveBeenCalledWith('HmIP-RF', '000:1', 'LEVEL', 'double', 0.75);
  });

  it('routes string values through JSON-RPC with type=string', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('HmIP-RF.000:1', 'TEXT', 'hello');
    expect(spy).toHaveBeenCalledWith('HmIP-RF', '000:1', 'TEXT', 'string', 'hello');
  });

  it('strips interface prefix correctly when address has no dot', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('BARE', 'STATE', true);
    expect(spy).toHaveBeenCalled();
  });
});

describe('CcuClient runtime interface discovery', () => {
  it('queries listInterfaces during start() and remembers ports', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([
      { name: 'BidCos-RF', port: 32001 },
      { name: 'HmIP-RF', port: 32010 },
      { name: 'VirtualDevices', port: 39292 },
    ]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    await ccu.start();
    expect(spy).toHaveBeenCalled();
    // discoveredPorts is private — verify via Map size on the instance
    const m = (ccu as unknown as { discoveredPorts: Map<string, number> }).discoveredPorts;
    expect(m.get('BidCos-RF')).toBe(32001);
    expect(m.get('HmIP-RF')).toBe(32010);
    expect(m.get('VirtualDevices')).toBe(39292);
    await ccu.stop();
  });

  it('start() does not crash when listInterfaces throws', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listInterfaces').mockRejectedValue(new Error('ccu-down'));
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    await expect(ccu.start()).resolves.toBeUndefined();
    await ccu.stop();
  });

  it('tolerates lower-case / aliased interface names from the CCU', async () => {
    // Regression: v0.1.5 referenced `mapInterfaceName` without defining it,
    // so any non-empty listInterfaces response triggered a ReferenceError
    // that was swallowed by the try/catch and discarded all discovered
    // ports. Verify the mapping accepts the canonical and aliased forms.
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([
      { name: 'BIDCOS-RF', port: 32001 },
      { name: 'hmip-rf', port: 32010 },
      { name: 'CCU-Jack', port: 12345 }, // unknown — should be skipped, not crash
    ]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    await ccu.start();
    const m = (ccu as unknown as { discoveredPorts: Map<string, number> }).discoveredPorts;
    expect(m.get('BidCos-RF')).toBe(32001);
    expect(m.get('HmIP-RF')).toBe(32010);
    expect(m.size).toBe(2); // CCU-Jack rejected
    await ccu.stop();
  });
});

describe('CcuClient interfacePorts override', () => {
  it('uses the user-supplied port even when listInterfaces returns a different one', async () => {
    // RaspberryMatic firewall regression: listInterfaces returns +30000
    // ports but the CCU firewall blocks them; user pins legacy 2001 in
    // config. The override must beat the discovered value.
    const config = resolveConfig({
      platform: 'HapHomematic',
      ccuIp: '127.0.0.1',
      eventServer: { host: '127.0.0.1', port: 9876 },
      interfaces: { bidcosRf: true, hmIpRf: false, bidcosWired: false, virtualDevices: false, cuxd: false },
      interfacePorts: { 'BidCos-RF': 2001 },
    });
    const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc-override') });
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([{ name: 'BidCos-RF', port: 32001 }]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);

    // Spy on RpcClient ctor by monkey-patching the rpcClients map after start.
    // We can't easily intercept the ctor, so instead we'll observe via the
    // probe failure: subscribe() will fail (no listener on either port), but
    // we can pull the port from the warn log.
    const warns: string[] = [];
    vi.spyOn(ccu['log'] as unknown as { warn: (...args: unknown[]) => void }, 'warn')
      .mockImplementation((fmt: string, ...args: unknown[]) => {
        warns.push([fmt, ...args].map(String).join(' '));
      });
    const infos: string[] = [];
    vi.spyOn(ccu['log'] as unknown as { info: (...args: unknown[]) => void }, 'info')
      .mockImplementation((fmt: string, ...args: unknown[]) => {
        infos.push([fmt, ...args].map(String).join(' '));
      });

    await ccu.start();
    // The startup log should announce port 2001 (override), not 32001 (discovery).
    // PrefixedLogger emits printf-style fmt + args separately; the test
    // captures them as `'fmt arg1 arg2 …'`, so the regex matches that
    // joined form rather than a substituted message.
    expect(infos.join('\n')).toMatch(/Using XML-RPC port .* for .* \(.*\) 2001 BidCos-RF config override/);
    await ccu.stop();
  });
});

describe('CcuClient address → interface lookup', () => {
  it('routes addresses based on the discovered device tree, not the address prefix', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([
      {
        address: '0008DBE9971A0F',
        name: 'Blind 1',
        type: 'HmIP-FROLL',
        interface: 'HmIP-RF',
        channels: [
          { address: '0008DBE9971A0F:1', index: 1, type: 'BLIND_VIRTUAL_RECEIVER', name: 'ch1' },
          { address: '0008DBE9971A0F:4', index: 4, type: 'BLIND_VIRTUAL_RECEIVER', name: 'ch4' },
        ],
      },
    ]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    await ccu.start();

    const set = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    // Even though the address has no `HmIP-RF.` prefix, the lookup map
    // (built from listDevices) sends it to HmIP-RF, not to BidCos-RF.
    await ccu.setValue('0008DBE9971A0F:4', 'LEVEL', 0.5);
    expect(set).toHaveBeenCalledWith('HmIP-RF', '0008DBE9971A0F:4', 'LEVEL', 'double', 0.5);

    await ccu.stop();
  });

  it('falls back to prefix heuristic for addresses missing from the device tree', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    await ccu.start();

    const set = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('HmIP-RF.000:1', 'STATE', true);
    expect(set).toHaveBeenCalledWith('HmIP-RF', '000:1', 'STATE', 'boolean', true);
    await ccu.stop();
  });
});
