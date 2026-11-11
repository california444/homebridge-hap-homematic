import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CcuClient, toTyped } from '../../src/ccu/CcuClient.js';
import { RpcClient } from '../../src/ccu/RpcClient.js';
import { pairChannel } from '../../src/ccu/pairing.js';
import { AccessoryBase, maintenanceAddress } from '../../src/services/AccessoryBase.js';
import type { ServiceDefinition } from '../../src/services/types.js';
import { clampToProps } from '../../src/util/sanitize.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';
import { build, makeSvcEnv, NO_RESPONSE } from '../helpers/svcEnv.js';
import type { CcuChannel, CcuDevice } from '../../src/types.js';

beforeEach(() => vi.restoreAllMocks());

const ch = (address: string, type: string): CcuChannel => ({
  address, type, index: Number(address.split(':')[1]), name: address,
});

describe('pairChannel (plan 8.4)', () => {
  const ps: CcuDevice = {
    address: 'PS', type: 'HMIP-PS', name: 'n', interface: 'HmIP-RF',
    channels: [ch('PS:0', 'MAINTENANCE'), ch('PS:1', 'KEY_TRANSCEIVER'), ch('PS:2', 'SWITCH_TRANSMITTER'),
      ch('PS:3', 'SWITCH_VIRTUAL_RECEIVER'), ch('PS:4', 'SWITCH_VIRTUAL_RECEIVER'), ch('PS:5', 'SWITCH_VIRTUAL_RECEIVER')],
  };
  const drsi4: CcuDevice = {
    address: 'DR', type: 'HmIP-DRSI4', name: 'n', interface: 'HmIP-RF',
    channels: [
      ch('DR:0', 'MAINTENANCE'),
      ...[1, 2, 3, 4].map((i) => ch(`DR:${i}`, 'MULTI_MODE_INPUT_TRANSMITTER')),
      ...[5, 9, 13, 17].flatMap((t) => [ch(`DR:${t}`, 'SWITCH_TRANSMITTER'),
        ch(`DR:${t + 1}`, 'SWITCH_VIRTUAL_RECEIVER'), ch(`DR:${t + 2}`, 'SWITCH_VIRTUAL_RECEIVER'),
        ch(`DR:${t + 3}`, 'SWITCH_VIRTUAL_RECEIVER')]),
    ].reverse(), // order in the list must not matter, the index does
  };

  it('HmIP-PS: mapped receiver or transmitter → state ch 2, command ch 3', () => {
    for (const a of ['PS:2', 'PS:3', 'PS:4', 'PS:5']) {
      const c = ps.channels.find((x) => x.address === a)!;
      expect(pairChannel(ps, c)).toMatchObject({ address: 'PS:3', stateAddress: 'PS:2', type: c.type });
    }
  });

  it('HmIP-DRSI4: lamp n → state 1+4n, command 2+4n', () => {
    for (const n of [1, 2, 3, 4]) {
      const c = drsi4.channels.find((x) => x.address === `DR:${2 + 4 * n}`)!;
      expect(pairChannel(drsi4, c)).toMatchObject({ address: `DR:${2 + 4 * n}`, stateAddress: `DR:${1 + 4 * n}` });
    }
  });

  it('leaves everything else unchanged', () => {
    const input = drsi4.channels.find((x) => x.address === 'DR:1')!; // MULTI_MODE_INPUT_TRANSMITTER
    expect(pairChannel(drsi4, input)).toBe(input);
    const bidcos = ch('B:1', 'SWITCH');
    expect(pairChannel(undefined, bidcos)).toBe(bidcos);
    const stray = ch('PS:9', 'SWITCH_VIRTUAL_RECEIVER');
    expect(pairChannel(ps, stray)).toBe(stray); // not on the device
    const orphan: CcuDevice = { ...ps, channels: [ch('X:1', 'SWITCH_VIRTUAL_RECEIVER')] };
    expect(pairChannel(orphan, orphan.channels[0]!)).toBe(orphan.channels[0]); // no transmitter
    const lonely: CcuDevice = { ...ps, channels: [ch('Y:1', 'SWITCH_TRANSMITTER'), ch('Y:2', 'KEY_TRANSCEIVER')] };
    expect(pairChannel(lonely, lonely.channels[0]!)).toBe(lonely.channels[0]); // no receiver
  });
});

describe('CcuClient values and typing', () => {
  function ccu() {
    const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1', eventServer: { callbackHost: '127.0.0.1' } });
    return new CcuClient({ config, log: new PrefixedLogger(makeLog(), 't') });
  }

  it('toTyped shapes values by paramset TYPE (plan 4.3)', () => {
    expect(toTyped('FLOAT', 1)).toEqual({ explicitDouble: 1 });
    expect(toTyped('FLOAT', 'x')).toEqual({ explicitDouble: 0 });
    expect(toTyped('INTEGER', 2.6)).toBe(3);
    expect(toTyped('ENUM', true)).toBe(1);
    expect(toTyped('ENUM', 'x')).toBe(0);
    expect(toTyped('BOOL', 1)).toBe(true);
    expect(toTyped('BOOL', 'false')).toBe(false);
    expect(toTyped('ACTION', true)).toBe(true);
    expect(toTyped(undefined, 0.5)).toBe(0.5);
  });

  it('setValue uses the describer', async () => {
    const c = ccu();
    c.setDescriber((a) => (a === 'A:1' ? { LEVEL: { TYPE: 'FLOAT' }, STATE: { TYPE: 'BOOL' } } : undefined));
    const set = vi.spyOn(RpcClient.prototype, 'setValue').mockResolvedValue(undefined);
    await c.setValue('A:1', 'LEVEL', 1);
    await c.setValue('A:1', 'STATE', 0);
    await c.setValue('B:1', 'LEVEL', 1);
    expect(set.mock.calls.map((x) => x[2])).toEqual([{ explicitDouble: 1 }, false, 1]);
    expect(c.describe('A:1', 'LEVEL')?.TYPE).toBe('FLOAT');
    expect(c.interfaceOf('00000000000A01:1')).toBe('HmIP-RF');
  });

  it('readValues: one request per channel at a time, ACTION filtered, errors → undefined', async () => {
    const c = ccu();
    c.setDescriber(() => ({ PRESS_LONG: { TYPE: 'ACTION' }, PRESS_SHORT: { TYPE: 'ACTION' }, STATE: { TYPE: 'BOOL' } }));
    const get = vi.spyOn(RpcClient.prototype, 'getParamset')
      .mockResolvedValue({ STATE: true, PRESS_SHORT: false, PRESS_LONG: false });
    const [a, b] = await Promise.all([c.readValues('A:1'), c.readValues('A:1')]);
    expect(a).toEqual({ STATE: true });
    expect(b).toBe(a);
    expect(get).toHaveBeenCalledTimes(1);
    await c.readValues('A:1'); // settled → asks again
    expect(get).toHaveBeenCalledTimes(2);
    get.mockRejectedValueOnce(new Error('Failure'));
    expect(await c.readValues('A:1')).toBeUndefined();
  });

  it('isAction falls back to the PRESS_ prefix without a description', () => {
    const c = ccu();
    expect(c.isAction('A:1', 'PRESS_SHORT')).toBe(true);
    expect(c.isAction('A:1', 'STATE')).toBe(false);
    c.setDescriber(() => ({ PRESS_SHORT: { TYPE: 'BOOL' } }));
    expect(c.isAction('A:1', 'PRESS_SHORT')).toBe(false);
  });

  it('RpcClient.getParamset asks for VALUES and returns {} for non-objects', async () => {
    const call = vi.fn().mockResolvedValueOnce({ STATE: 1 }).mockResolvedValueOnce('x');
    const r = new RpcClient({ interfaceId: 'BidCos-RF', host: 'h', callbackUrl: 'u', callbackId: 'i',
      log: new PrefixedLogger(makeLog(), 'r'), transport: { call, close: async () => undefined } });
    expect(await r.getParamset('A:1')).toEqual({ STATE: 1 });
    expect(await r.getParamset('A:1')).toEqual({});
    expect(call).toHaveBeenCalledWith('getParamset', ['A:1', 'VALUES']);
  });
});

describe('clampToProps (plan 8.5)', () => {
  it('clamps numbers, enforces validValues, passes non-numbers', () => {
    expect(clampToProps(120, { minValue: 0, maxValue: 100 })).toBe(100);
    expect(clampToProps(-3, { minValue: 0 })).toBe(0);
    expect(clampToProps(5, undefined)).toBe(5);
    expect(clampToProps(NaN, {})).toBeUndefined();
    expect(clampToProps(2, { validValues: [0, 1] })).toBeUndefined();
    expect(clampToProps(1, { validValues: [0, 1] })).toBe(1);
    expect(clampToProps(7, { validValues: [] })).toBe(7);
    expect(clampToProps(true, { maxValue: 0 })).toBe(true);
  });
});

/** A small handler that exercises the base-class helpers. */
class Probe extends AccessoryBase {
  value: unknown;
  evaluate?: () => void;
  extra = false;
  attach(channel: CcuChannel): void {
    const s = this.getOrAddService(this.Service.SmokeSensor, 'probe');
    const sw = this.getOrAddService(this.Service.Switch, 'sw');
    s.getCharacteristic(this.Characteristic.SmokeDetected).setProps({ minValue: 0, maxValue: 1 });
    this.need(channel.address, 'STATE', (v) => {
      this.value = v;
      if (v === 'boom') throw new Error('bad');
    });
    this.evaluate = this.watchFault(s, channel.address, () => this.extra);
    this.watchFault(sw, channel.address); // Switch has no StatusFault: no-op
    s.getCharacteristic(this.Characteristic.SmokeDetected).onGet(this.wrapGet(() => this.unknown()));
    sw.getCharacteristic(this.Characteristic.On).onSet(this.wrapSet(async () => {
      throw new Error('ccu down');
    }));
    this.attachBattery(channel.address);
  }
  push(v: number): void {
    this.update(this.accessory.services[0] as never, this.Characteristic.SmokeDetected, v);
  }
  save(): void {
    this.persist();
  }
}
const probeDef: ServiceDefinition = {
  key: 'Probe', description: '', channelTypes: ['X'], priority: 1,
  build: (ctx) => new Probe(ctx),
};

describe('AccessoryBase helpers', () => {
  it('need() + refresh(): start values from getParamset, events after; missing values stay unknown', async () => {
    const env = makeSvcEnv();
    const { handler } = build(env, probeDef, ch('ABC0000001:1', 'X'));
    const p = handler as unknown as Probe;
    await handler.refresh(); // no values at all (undefined)
    expect(p.value).toBeUndefined();
    env.values['ABC0000001:1'] = { STATE: 'boom' }; // a throwing applier is contained
    await handler.refresh();
    env.values['ABC0000001:1'] = { STATE: true };
    await handler.refresh();
    expect(p.value).toBe(true);
    env.fire('ABC0000001:1', 'STATE', false);
    expect(p.value).toBe(false);
    expect(maintenanceAddress('ABC0000001')).toBe('ABC0000001:0');
  });

  it('unknown() → HapStatusError(SERVICE_COMMUNICATION_FAILURE), plain Error without hap', async () => {
    const env = makeSvcEnv();
    const a = build(env, probeDef, ch('ABC0000001:1', 'X'));
    await expect(a.char(a.svc('SmokeSensor'), 'SmokeDetected').onGetHandler!()).rejects.toMatchObject(NO_RESPONSE);
    const b = build(env, probeDef, ch('ABC0000001:1', 'X'), {}, undefined, { withHap: false });
    await expect(b.char(b.svc('SmokeSensor'), 'SmokeDetected').onGetHandler!()).rejects.toThrow('value unknown');
  });

  it('wrapSet maps CCU errors to "No Response"', async () => {
    const env = makeSvcEnv();
    const a = build(env, probeDef, ch('ABC0000001:1', 'X'));
    await expect(a.char(a.svc('Switch'), 'On').onSetHandler!(true)).rejects.toMatchObject(NO_RESPONSE);
    const b = build(env, probeDef, ch('ABC0000001:1', 'X'), {}, undefined, { withHap: false });
    await expect(b.char(b.svc('Switch'), 'On').onSetHandler!(true)).rejects.toThrow('ccu down');
  });

  it('update() clamps to props and drops invalid values; persist() calls the platform', () => {
    const env = makeSvcEnv();
    const a = build(env, probeDef, ch('ABC0000001:1', 'X'));
    const p = a.handler as unknown as Probe;
    const c = a.char(a.svc('SmokeSensor'), 'SmokeDetected');
    p.push(5);
    expect(c.value).toBe(1);
    p.push(NaN);
    expect(c.value).toBe(1);
    p.save();
    expect(a.persist).toHaveBeenCalled();
  });

  it('watchFault: UNREACH, interface state and extra() drive StatusFault', async () => {
    const env = makeSvcEnv();
    const state = vi.spyOn(env.ccu, 'getInterfaceState').mockReturnValue('CONNECTED');
    const a = build(env, probeDef, ch('ABC0000001:1', 'X'));
    const p = a.handler as unknown as Probe;
    const fault = a.char(a.svc('SmokeSensor'), 'StatusFault');
    expect(fault.value).toBe(0);
    env.values['ABC0000001:0'] = { UNREACH: true };
    await a.handler.refresh();
    expect(fault.value).toBe(1);
    env.fire('ABC0000001:0', 'UNREACH', false);
    expect(fault.value).toBe(0);
    state.mockReturnValue('DISCONNECTED');
    env.ccu.emit('interfaceState', 'HmIP-RF', 'DISCONNECTED', 'CONNECTED'); // other interface
    expect(fault.value).toBe(0);
    env.ccu.emit('interfaceState', 'BidCos-RF', 'DISCONNECTED', 'CONNECTED');
    expect(fault.value).toBe(1);
    state.mockReturnValue('CONNECTED');
    p.extra = true;
    p.evaluate!();
    expect(fault.value).toBe(1);
    a.handler.dispose();
    expect(env.ccu.listenerCount('interfaceState')).toBe(0);
    expect(a.char(a.svc('Switch'), 'On').value).toBeUndefined(); // no StatusFault on Switch
    expect(a.svc('Switch').characteristics.has('char:StatusFault')).toBe(false);
  });

  it('battery: unknown until read, LOW_BAT / LOWBAT, voltage → level', async () => {
    const env = makeSvcEnv();
    const a = build(env, probeDef, ch('ABC0000001:1', 'X'));
    const bat = a.svc('battery');
    const low = a.char(bat, 'StatusLowBattery');
    const level = a.char(bat, 'BatteryLevel');
    await expect(low.onGetHandler!()).rejects.toMatchObject(NO_RESPONSE);
    await expect(level.onGetHandler!()).rejects.toMatchObject(NO_RESPONSE);
    env.values['ABC0000001:0'] = { LOWBAT: false };
    await a.handler.refresh();
    expect(await low.onGetHandler!()).toBe(0);
    expect(await level.onGetHandler!()).toBe(100);
    env.fire('ABC0000001:0', 'LOW_BAT', true);
    expect(await low.onGetHandler!()).toBe(1);
    expect(await level.onGetHandler!()).toBe(10);
    env.fire('ABC0000001:0', 'OPERATING_VOLTAGE', 2.8);
    expect(await level.onGetHandler!()).toBe(50);
    env.fire('ABC0000001:0', 'OPERATING_VOLTAGE', 'x');
    expect(await level.onGetHandler!()).toBe(50);
    expect(a.char(bat, 'ChargingState').onGetHandler!()).toBe(2);
  });
});
