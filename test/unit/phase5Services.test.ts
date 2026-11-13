import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { smokeService } from '../../src/services/impl/SmokeAccessory.js';
import { contactService } from '../../src/services/impl/ContactAccessory.js';
import { switchService } from '../../src/services/impl/SwitchAccessory.js';
import { irrigationService } from '../../src/services/impl/IrrigationAccessory.js';
import { doorbellService } from '../../src/services/impl/DoorbellAccessory.js';
import { build, makeSvcEnv, NO_RESPONSE } from '../helpers/svcEnv.js';
import type { CcuChannel, CcuDevice } from '../../src/types.js';

const SMOKE: CcuChannel = { address: '000A0000000B02:1', index: 1, type: 'SMOKE_DETECTOR', name: 'RM1' };

describe('SmokeAccessory (plan 8.3)', () => {
  const setup = (settings?: Record<string, unknown>) => {
    const env = makeSvcEnv();
    vi.spyOn(env.ccu, 'getInterfaceState').mockReturnValue('CONNECTED');
    const a = build(env, smokeService, SMOKE, settings ? { settings } : {});
    const s = a.svc('SmokeSensor');
    return { env, a, smoke: a.char(s, 'SmokeDetected'), fault: a.char(s, 'StatusFault') };
  };

  it('maps all four SMOKE_DETECTOR_ALARM_STATUS values (index or name)', async () => {
    const { env, smoke } = setup();
    const cases: Array<[unknown, number]> = [
      [0, 0], [1, 1], [0, 0], [3, 1], [2, 0], ['PRIMARY_ALARM', 1], ['IDLE_OFF', 0], ['SECONDARY_ALARM', 1], ['INTRUSION_ALARM', 0],
    ];
    for (const [raw, hap] of cases) {
      env.fire(SMOKE.address, 'SMOKE_DETECTOR_ALARM_STATUS', raw);
      expect(smoke.value).toBe(hap);
      expect(await smoke.onGetHandler!()).toBe(hap);
    }
    env.fire(SMOKE.address, 'SMOKE_DETECTOR_ALARM_STATUS', 9); // unknown: ignored
    expect(smoke.value).toBe(0);
  });

  it('secondaryAlarm: false keeps a group alarm off', () => {
    const { env, smoke } = setup({ secondaryAlarm: false });
    env.fire(SMOKE.address, 'SMOKE_DETECTOR_ALARM_STATUS', 3);
    expect(smoke.value).toBe(0);
    env.fire(SMOKE.address, 'SMOKE_DETECTOR_ALARM_STATUS', 1);
    expect(smoke.value).toBe(1);
  });

  it('start value from getParamset; HmIP has no STATE (finding P0.2)', async () => {
    const { env, a, smoke } = setup();
    env.values[SMOKE.address] = { SMOKE_DETECTOR_ALARM_STATUS: 0, ERROR_DEGRADED_CHAMBER: false };
    await a.handler.refresh();
    expect(await smoke.onGetHandler!()).toBe(0);
  });

  it('no value yet (CCU restart, finding 16): "no smoke" + StatusFault, battery normal, until the first value', async () => {
    const { env, a, smoke, fault } = setup();
    env.values[SMOKE.address] = {};
    await a.handler.refresh();
    expect(await smoke.onGetHandler!()).toBe(0);
    expect(fault.value).toBe(1);
    const bat = a.svc('battery');
    expect(await a.char(bat, 'StatusLowBattery').onGetHandler!()).toBe(0);
    expect(await a.char(bat, 'BatteryLevel').onGetHandler!()).toBe(100);
    env.fire(SMOKE.address, 'SMOKE_DETECTOR_ALARM_STATUS', 0);
    expect(fault.value).toBe(0);
    env.fire(SMOKE.address, 'SMOKE_DETECTOR_ALARM_STATUS', 1); // later changes: no re-evaluation needed
    expect(smoke.value).toBe(1);
    expect(fault.value).toBe(0);
  });

  it('ERROR_DEGRADED_CHAMBER → StatusFault; test result only logged', () => {
    const { env, fault } = setup();
    const info = vi.spyOn(env.log, 'info');
    env.fire(SMOKE.address, 'SMOKE_DETECTOR_ALARM_STATUS', 0);
    env.fire(SMOKE.address, 'ERROR_DEGRADED_CHAMBER', true);
    expect(fault.value).toBe(1);
    env.fire(SMOKE.address, 'ERROR_DEGRADED_CHAMBER', false);
    expect(fault.value).toBe(0);
    env.fire(SMOKE.address, 'SMOKE_DETECTOR_TEST_RESULT', 1);
    expect(info).toHaveBeenCalledWith('%s: test result %s', 'Acc', 'SMOKE_TEST_OK');
  });

  it('test result: NONE and unknown values only at debug level, FAILED as a warning', () => {
    const { env } = setup();
    const info = vi.spyOn(env.log, 'info');
    const warn = vi.spyOn(env.log, 'warn');
    const debug = vi.spyOn(env.log, 'debug');
    env.fire(SMOKE.address, 'SMOKE_DETECTOR_TEST_RESULT', 0);
    env.fire(SMOKE.address, 'SMOKE_DETECTOR_TEST_RESULT', 'NONE');
    env.fire(SMOKE.address, 'SMOKE_DETECTOR_TEST_RESULT', 9);
    expect(info.mock.calls.some((c) => String(c[0]).includes('test result'))).toBe(false);
    expect(debug).toHaveBeenCalledWith('%s: test result NONE', 'Acc');
    env.fire(SMOKE.address, 'SMOKE_DETECTOR_TEST_RESULT', 2);
    expect(warn).toHaveBeenCalledWith('%s: smoke test FAILED', 'Acc');
    env.fire(SMOKE.address, 'SMOKE_DETECTOR_TEST_RESULT', 'COMMUNICATION_TEST_OK');
    expect(info).toHaveBeenCalledWith('%s: test result %s', 'Acc', 'COMMUNICATION_TEST_OK');
  });

  it('BidCos detectors keep the STATE path', () => {
    const { env, smoke } = setup();
    env.fire(SMOKE.address, 'STATE', true);
    expect(smoke.value).toBe(1);
    env.fire(SMOKE.address, 'STATE', false);
    expect(smoke.value).toBe(0);
  });
});

describe('ContactAccessory', () => {
  const C: CcuChannel = { address: 'ABC0000004:1', index: 1, type: 'SHUTTER_CONTACT', name: 'Tür' };

  it('unknown → No Response; STATE true = open; ERROR 7 = tampered', async () => {
    const env = makeSvcEnv();
    const a = build(env, contactService, C);
    const s = a.svc('ContactSensor');
    const st = a.char(s, 'ContactSensorState');
    await expect(st.onGetHandler!()).rejects.toMatchObject(NO_RESPONSE);
    env.fire(C.address, 'STATE', true);
    expect(st.value).toBe(1); // CONTACT_NOT_DETECTED = open
    env.fire(C.address, 'STATE', false);
    expect(await st.onGetHandler!()).toBe(0);
    env.fire(C.address, 'ERROR', 7);
    expect(a.char(s, 'StatusTampered').value).toBe(1);
    env.fire(C.address, 'ERROR', 0);
    expect(a.char(s, 'StatusTampered').value).toBe(0);
  });

  it('invert swaps open/closed', async () => {
    const env = makeSvcEnv();
    const a = build(env, contactService, C, { settings: { invert: true } });
    await expect(a.char(a.svc('ContactSensor'), 'ContactSensorState').onGetHandler!()).rejects.toMatchObject(NO_RESPONSE);
    env.fire(C.address, 'STATE', true);
    expect(a.char(a.svc('ContactSensor'), 'ContactSensorState').value).toBe(0);
  });
});

describe('SwitchAccessory with HmIP pairing (plan 8.4)', () => {
  it('reads STATE from the transmitter, writes to the receiver, ignores receiver STATE', async () => {
    const env = makeSvcEnv();
    const ch: CcuChannel = { address: 'PS:3', stateAddress: 'PS:2', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'K' };
    const a = build(env, switchService, ch, { subtype: 'Outlet' });
    const on = a.char(a.svc('Outlet'), 'On');
    env.values['PS:2'] = { STATE: true };
    await a.handler.refresh();
    expect(await on.onGetHandler!()).toBe(true);
    env.fire('PS:3', 'STATE', false); // virtual receiver: not the output
    expect(await on.onGetHandler!()).toBe(true);
    await on.onSetHandler!(false);
    expect(env.setValue).toHaveBeenCalledWith('PS:3', 'STATE', false);
    expect(await on.onGetHandler!()).toBe(true); // waits for the transmitter event
    env.fire('PS:2', 'STATE', false);
    expect(on.value).toBe(false);
  });
});

describe('IrrigationAccessory (plan 8.1)', () => {
  const SERIAL = 'ABC0000002';
  const dev: CcuDevice = {
    address: SERIAL, type: 'HM-LC-Sw4-DR-2', name: 'n', interface: 'BidCos-RF',
    channels: [0, 1, 2, 3, 4].map((i) => ({ address: `${SERIAL}:${i}`, index: i, type: i ? 'SWITCH' : 'MAINTENANCE', name: 'x' })),
  };
  const first: CcuChannel = dev.channels[1]!;
  const settings = {
    channels: { '1': { name: 'Rasen vorne', valveType: 'Irrigation' }, '2': { name: 'Rasen hinten', valveType: 'Water Faucet' } },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  /** device: null = not discovered (an explicit undefined would pick the default). */
  const setup = (context: Record<string, unknown> = { settings }, device: CcuDevice | null = dev) => {
    const env = makeSvcEnv();
    vi.spyOn(env.ccu, 'getInterfaceState').mockReturnValue('CONNECTED');
    const a = build(env, irrigationService, first, context, device ?? undefined);
    const valve = (n: number) => a.svc(`valve-${n}`);
    return { env, a, valve, sys: a.svc('IrrigationSystem') };
  };

  it('one IrrigationSystem with 4 linked valves, names, index, valve type', () => {
    const { a, valve } = setup();
    expect(a.accessory.services.filter((s) => s.UUID === 'srv:Valve')).toHaveLength(4);
    expect(valve(1).displayName).toBe('Rasen vorne');
    expect(valve(3).displayName).toBe('Valve 3');
    expect(a.char(valve(2), 'ServiceLabelIndex').value).toBe(2);
    expect(a.char(valve(1), 'ValveType').value).toBe(1);
    expect(a.char(valve(2), 'ValveType').value).toBe(3);
    expect(a.char(valve(4), 'ValveType').value).toBe(1);
    expect(a.char(valve(1), 'IsConfigured').value).toBe(1);
  });

  it('valves from devices.json channels or 1–4 when the device is not discovered', () => {
    const viaMapping = setup({ settings: { channels: { '2': {}, '5': {} } } }, null);
    expect(viaMapping.a.accessory.services.filter((s) => s.UUID === 'srv:Valve').map((s) => s.subtype))
      .toEqual(['valve-2', 'valve-5']);
    const fallback = setup({}, null);
    expect(fallback.a.accessory.services.filter((s) => s.UUID === 'srv:Valve')).toHaveLength(4);
  });

  it('on: ON_TIME first, then STATE; the actuator switches off itself (D3)', async () => {
    const { env, a, valve } = setup();
    const dur = a.char(valve(1), 'SetDuration');
    expect(dur.onGetHandler!()).toBe(600);
    dur.onSetHandler!(900);
    expect(a.persist).toHaveBeenCalled();
    await a.char(valve(1), 'Active').onSetHandler!(1);
    expect(env.setValue.mock.calls).toEqual([
      [`${SERIAL}:1`, 'ON_TIME', 900],
      [`${SERIAL}:1`, 'STATE', true],
    ]);
    env.fire(`${SERIAL}:1`, 'STATE', true);
    expect(a.char(valve(1), 'InUse').value).toBe(1);
    expect(a.char(valve(1), 'RemainingDuration').value).toBe(900);
    vi.advanceTimersByTime(300_000);
    expect(a.char(valve(1), 'RemainingDuration').onGetHandler!()).toBe(600);
    // No timed STATE=false from the plugin:
    vi.advanceTimersByTime(700_000);
    expect(env.setValue).toHaveBeenCalledTimes(2);
    expect(a.char(valve(1), 'RemainingDuration').onGetHandler!()).toBe(0);
    env.fire(`${SERIAL}:1`, 'STATE', false); // actuator timed out
    expect(a.char(valve(1), 'Active').value).toBe(0);
    expect((a.accessory.context as unknown as { irrigation: { ends: object } }).irrigation.ends).toEqual({});
  });

  it('fixed run time per valve (channel option duration) wins over Home and the default', async () => {
    const { env, a, valve } = setup({
      settings: { defaultDuration: 300, channels: { '1': { name: 'Rasen', duration: 90 }, '2': { duration: 'x' }, '3': { duration: 9999 } } },
    });
    const dur = a.char(valve(1), 'SetDuration');
    expect(dur.value).toBe(90);
    expect(dur.onGetHandler!()).toBe(90);
    dur.onSetHandler!(600); // Home tries 10 min
    await vi.advanceTimersByTimeAsync(1);
    expect(dur.value).toBe(90);
    expect(dur.onGetHandler!()).toBe(90);
    await a.char(valve(1), 'Active').onSetHandler!(1);
    expect(env.setValue.mock.calls[0]).toEqual([`${SERIAL}:1`, 'ON_TIME', 90]);
    // invalid → not fixed: Home / default apply
    expect(a.char(valve(2), 'SetDuration').onGetHandler!()).toBe(300);
    a.char(valve(2), 'SetDuration').onSetHandler!(120);
    expect(a.char(valve(2), 'SetDuration').onGetHandler!()).toBe(120);
    // clamped to the HAP maximum
    expect(a.char(valve(3), 'SetDuration').onGetHandler!()).toBe(3600);
  });

  it('SetDuration 0: no ON_TIME, stays on until switched off', async () => {
    const { env, a, valve } = setup();
    a.char(valve(2), 'SetDuration').onSetHandler!(0);
    await a.char(valve(2), 'Active').onSetHandler!(1);
    expect(env.setValue.mock.calls).toEqual([[`${SERIAL}:2`, 'STATE', true]]);
    expect(a.char(valve(2), 'RemainingDuration').onGetHandler!()).toBe(0);
    await a.char(valve(2), 'Active').onSetHandler!(0);
    expect(env.setValue).toHaveBeenLastCalledWith(`${SERIAL}:2`, 'STATE', false);
  });

  it('end time survives a restart (accessory.context)', async () => {
    const first1 = setup();
    first1.a.char(first1.valve(1), 'SetDuration').onSetHandler!(1200);
    await first1.a.char(first1.valve(1), 'Active').onSetHandler!(1);
    const context = first1.a.accessory.context as unknown as Record<string, unknown>;
    vi.advanceTimersByTime(200_000);
    const again = setup({ ...context });
    again.env.values[`${SERIAL}:1`] = { STATE: true, WORKING: false };
    await again.a.handler.refresh();
    expect(again.a.char(again.valve(1), 'RemainingDuration').onGetHandler!()).toBe(1000);
    expect(again.a.char(again.valve(1), 'SetDuration').onGetHandler!()).toBe(1200);
  });

  it('system Active / InUse = OR of the valves; unknown until a value; off switches all off', async () => {
    const { env, a, sys } = setup();
    const act = a.char(sys, 'Active');
    await expect(act.onGetHandler!()).rejects.toMatchObject(NO_RESPONSE);
    await expect(a.char(a.svc('valve-1'), 'Active').onGetHandler!()).rejects.toMatchObject(NO_RESPONSE);
    env.values[`${SERIAL}:1`] = { STATE: false };
    env.values[`${SERIAL}:3`] = { STATE: true };
    await a.handler.refresh();
    expect(await act.onGetHandler!()).toBe(1);
    expect(await a.char(sys, 'InUse').onGetHandler!()).toBe(1);
    expect(a.char(sys, 'ProgramMode').onGetHandler!()).toBe(0);
    await act.onSetHandler!(1); // no-op
    expect(env.setValue).not.toHaveBeenCalled();
    await act.onSetHandler!(0);
    expect(env.setValue.mock.calls).toEqual([[`${SERIAL}:3`, 'STATE', false]]);
    env.fire(`${SERIAL}:3`, 'STATE', false);
    expect(act.value).toBe(0);
  });

  it('defaultDuration option and clamping', async () => {
    const { env, a, valve } = setup({ settings: { defaultDuration: 99999 } });
    expect(a.char(valve(1), 'SetDuration').onGetHandler!()).toBe(3600);
    a.char(valve(1), 'SetDuration').onSetHandler!('x');
    expect(a.char(valve(1), 'SetDuration').onGetHandler!()).toBe(600);
    await a.char(valve(4), 'Active').onSetHandler!(1);
    expect(env.setValue.mock.calls[0]).toEqual([`${SERIAL}:4`, 'ON_TIME', 3600]);
  });
});

describe('DoorbellAccessory (plan 8.2)', () => {
  const D: CcuChannel = { address: '0026E0000000C1:1', index: 1, type: 'MULTI_MODE_INPUT_TRANSMITTER', name: 'Klingel' };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('rings on PRESS_SHORT whatever the value (finding 7), debounced 2 s, onGet null', async () => {
    const env = makeSvcEnv();
    const a = build(env, doorbellService, D);
    const ev = a.char(a.svc('Doorbell'), 'ProgrammableSwitchEvent');
    expect(ev.onGetHandler!()).toBeNull();
    env.fire(D.address, 'PRESS_SHORT', false);
    expect(ev.updateValue).toHaveBeenCalledTimes(1);
    expect(ev.updateValue).toHaveBeenCalledWith(0);
    vi.advanceTimersByTime(1000);
    env.fire(D.address, 'PRESS_SHORT', true);
    expect(ev.updateValue).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1500);
    env.fire(D.address, 'PRESS_SHORT', true);
    expect(ev.updateValue).toHaveBeenCalledTimes(2);
    env.fire(D.address, 'STATE', true); // not the trigger
    vi.advanceTimersByTime(5000);
    env.fire(D.address, 'STATE', true);
    expect(ev.updateValue).toHaveBeenCalledTimes(2);
  });

  it('never rings from start values (ACTION, plan 4.2)', async () => {
    const env = makeSvcEnv();
    const a = build(env, doorbellService, D);
    env.values[D.address] = { PRESS_SHORT: true, STATE: true };
    await a.handler.refresh();
    expect(a.char(a.svc('Doorbell'), 'ProgrammableSwitchEvent').updateValue).not.toHaveBeenCalled();
  });

  it('trigger STATE fires on the rising edge; PRESS_LONG and debounce options', () => {
    const env = makeSvcEnv();
    const a = build(env, doorbellService, D, { settings: { trigger: 'STATE', debounceSeconds: 0 } });
    const ev = a.char(a.svc('Doorbell'), 'ProgrammableSwitchEvent');
    env.fire(D.address, 'STATE', true);
    env.fire(D.address, 'STATE', true);
    env.fire(D.address, 'STATE', false);
    env.fire(D.address, 'STATE', true);
    env.fire(D.address, 'PRESS_SHORT', true);
    expect(ev.updateValue).toHaveBeenCalledTimes(2);

    const b = build(env, doorbellService, D, { settings: { trigger: 'PRESS_LONG', debounceSeconds: 'x' } });
    const ev2 = b.char(b.svc('Doorbell'), 'ProgrammableSwitchEvent');
    env.fire(D.address, 'PRESS_SHORT', true);
    env.fire(D.address, 'PRESS_LONG', true);
    expect(ev2.updateValue).toHaveBeenCalledTimes(1);

    const c = build(env, doorbellService, D, { settings: { trigger: 'nonsense' } });
    env.fire(D.address, 'PRESS_SHORT', true);
    vi.advanceTimersByTime(3000);
    expect(c.char(c.svc('Doorbell'), 'ProgrammableSwitchEvent').updateValue).toHaveBeenCalledTimes(1);
  });
});
