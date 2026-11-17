import { describe, it, expect, vi } from 'vitest';
import type { Logging } from 'homebridge';
import { CcuClient, SetValueError, validRssi } from '../../src/ccu/CcuClient.js';
import { switchService } from '../../src/services/impl/SwitchAccessory.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import type { CcuChannel } from '../../src/types.js';
import { makeLog } from '../helpers/hapStub.js';
import { build, makeSvcEnv, NO_RESPONSE } from '../helpers/svcEnv.js';

const ID = 'homebridge-hap-homematic:HmIP-RF';

function makeCcu(): CcuClient {
  const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1', eventServer: { callbackHost: '127.0.0.1' } });
  return new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'ccu-test') });
}

const fire = (ccu: CcuClient, channelAddress: string, datapoint: string, value: unknown) =>
  (ccu as unknown as { handleEvent(ev: object): void }).handleEvent({
    callbackId: ID, channelAddress, datapoint, value, receivedAt: 0,
  });

describe('CcuClient.setValue errors', () => {
  const failing = (ccu: CcuClient, message: string) =>
    vi.spyOn(ccu as unknown as { clientFor(a: string): unknown }, 'clientFor').mockReturnValue({
      setValue: async () => { throw new Error(message); },
    });

  it('reports a SetValueError with the CCU answer as reason and the duration', async () => {
    const ccu = makeCcu();
    failing(ccu, 'setValue failed: setValue failed: Generic error (UNREACH) (-1)');
    const reported: SetValueError[] = [];
    ccu.setOwner('ABC0000001:14', (e) => reported.push(e));
    await ccu.setValue('ABC0000001:14', 'STATE', true);
    await ccu.sendQueue.idle();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(SetValueError);
    expect(reported[0]).toMatchObject({
      address: 'ABC0000001:14', datapoint: 'STATE', value: true,
      reason: 'Generic error (UNREACH) (-1)', timedOut: false,
    });
    expect(typeof reported[0]!.durationMs).toBe('number');
  });

  it('logs the failure itself when no accessory owns the address', async () => {
    const raw = makeLog();
    const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1', eventServer: { callbackHost: '127.0.0.1' } });
    const ccu = new CcuClient({ config, log: new PrefixedLogger(raw, 'ccu') });
    failing(ccu, 'setValue failed: Failure (-1)');
    await ccu.setValue('PEQ0000001:1', 'LEVEL', 0.5);
    await ccu.sendQueue.idle();
    expect(String((raw.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0])).toContain('not delivered');
    expect((raw.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toContain('Failure (-1)');
  });

  it('names the failing write of a job and skips the rest', async () => {
    const ccu = makeCcu();
    const sent: string[] = [];
    vi.spyOn(ccu as unknown as { clientFor(a: string): unknown }, 'clientFor').mockReturnValue({
      setValue: async (_a: string, dp: string) => {
        sent.push(dp);
        if (dp === 'ON_TIME') throw new Error('setValue failed: Failure (-1)');
      },
    });
    const reported: SetValueError[] = [];
    ccu.setOwner('PEQ0000001:1', (e) => reported.push(e));
    ccu.setValues('PEQ0000001:1', [['ON_TIME', 60], ['STATE', true]]);
    await ccu.sendQueue.idle();
    expect(sent).toEqual(['ON_TIME']);
    expect(reported[0]).toMatchObject({ datapoint: 'ON_TIME', value: 60, reason: 'Failure (-1)' });
  });
});

describe('CcuClient.signalInfo', () => {
  it('reads RSSI from channel 0 and drops placeholder values', async () => {
    const ccu = makeCcu();
    const read = vi.spyOn(ccu, 'readValues').mockResolvedValue({ RSSI_DEVICE: -72, RSSI_PEER: -65535 });
    expect(await ccu.signalInfo('ABC0000001:14')).toEqual({ device: -72 });
    expect(read).toHaveBeenCalledWith('ABC0000001:0');
  });

  it('falls back to the last RSSI events (unreachable HmIP devices report none)', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu, 'readValues').mockResolvedValue({});
    fire(ccu, 'ABC0000001:0', 'RSSI_DEVICE', -80);
    fire(ccu, 'ABC0000001:0', 'RSSI_PEER', -77);
    fire(ccu, 'ABC0000001:0', 'RSSI_PEER', 128);
    expect(await ccu.signalInfo('ABC0000001:3')).toEqual({ device: -80, peer: -77 });
    expect(await ccu.signalInfo('OTHER0000001:3')).toEqual({});
  });

  it('validRssi accepts -127..-1 dBm only', () => {
    expect(validRssi(-72)).toBe(-72);
    for (const v of [0, 1, 128, -128, -183, -65535, '−70', undefined, Number.NaN]) {
      expect(validRssi(v)).toBeUndefined();
    }
  });
});

describe('failed commands in the log', () => {
  const ch: CcuChannel = { address: 'ABC0000001:14', index: 14, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'K' };
  const warnings = (log: Logging): string[] =>
    (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => {
      const [fmt, ...args] = c as [string, ...unknown[]];
      let i = 0;
      return fmt.replace(/%s/g, () => String(args[i++]));
    });

  it('names the accessory, datapoint, value, reason and signal; HomeKit gets "No Response"', async () => {
    const env = makeSvcEnv();
    const raw = makeLog();
    env.log = new PrefixedLogger(raw, 'svc:SwitchAccessory:ABC0000001:14');
    env.setValue.mockRejectedValue(
      new SetValueError('ABC0000001:14', 'STATE', true, 'Generic error (UNREACH) (-1)'));
    env.values['ABC0000001:0'] = { RSSI_DEVICE: -72, RSSI_PEER: -67 };
    const a = build(env, switchService, ch, { name: 'Garten Licht' });
    await expect(a.char(a.svc('Switch'), 'On').onSetHandler!(true)).rejects.toMatchObject(NO_RESPONSE);
    await vi.waitFor(() => expect(raw.warn).toHaveBeenCalled());
    expect(warnings(raw)).toEqual([
      '[svc:SwitchAccessory:ABC0000001:14] Garten Licht: STATE=true not delivered, '
      + '(Generic error (UNREACH) (-1)) last known signal:-72 dBm(CCU)/-67 dBm(device)',
    ]);
  });

  it('names the address when it is not the accessory channel, and omits an unknown signal', async () => {
    const env = makeSvcEnv();
    const raw = makeLog();
    env.log = new PrefixedLogger(raw, 'svc:SwitchAccessory:ABC0000001:13');
    env.setValue.mockRejectedValue(new SetValueError('ABC0000001:14', 'STATE', false, 'Failure (-1)'));
    const a = build(env, switchService, ch, { name: 'Ventil' });
    await expect(a.char(a.svc('Switch'), 'On').onSetHandler!(false)).rejects.toMatchObject(NO_RESPONSE);
    await vi.waitFor(() => expect(raw.warn).toHaveBeenCalled());
    expect(warnings(raw)).toEqual([
      '[svc:SwitchAccessory:ABC0000001:13] Ventil: STATE=false on ABC0000001:14 not delivered, (Failure (-1))',
    ]);
  });

  it('shows a one-sided signal', async () => {
    const env = makeSvcEnv();
    const raw = makeLog();
    env.log = new PrefixedLogger(raw, 'svc:SwitchAccessory:ABC0000001:14');
    env.setValue.mockRejectedValue(new SetValueError('ABC0000001:14', 'STATE', true, 'Failure (-1)'));
    env.values['ABC0000001:0'] = { RSSI_DEVICE: -88, RSSI_PEER: -65535 };
    const a = build(env, switchService, ch, { name: 'Licht' });
    await expect(a.char(a.svc('Switch'), 'On').onSetHandler!(true)).rejects.toMatchObject(NO_RESPONSE);
    await vi.waitFor(() => expect(raw.warn).toHaveBeenCalled());
    expect(warnings(raw)).toEqual([
      '[svc:SwitchAccessory:ABC0000001:14] Licht: STATE=true not delivered, (Failure (-1)) last known signal:-88 dBm(CCU)',
    ]);
  });
});
