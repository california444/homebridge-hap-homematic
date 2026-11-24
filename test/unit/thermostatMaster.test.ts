import { afterEach, describe, expect, it, vi } from 'vitest';
import { build, makeSvcEnv, type SvcEnv } from '../helpers/svcEnv.js';
import { thermostatService } from '../../src/services/impl/ThermostatAccessory.js';
import type { CcuChannel } from '../../src/types.js';

/**
 * Thermostat with MASTER set point limits (TEMPERATURE_MINIMUM /
 * TEMPERATURE_MAXIMUM) and Off on devices whose minimum is above 4.5 °C
 * (#42: a group of HmIP-eTRV-B and HmIP-WTH-2 reports 5 °C after Off).
 */
const hmip: CcuChannel = {
  address: '0001D3C99C3C93:1',
  name: 'eTRV',
  index: 1,
  type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
};
const group: CcuChannel = { ...hmip, address: 'INT0000003:1', name: 'Group' };
const bidcos: CcuChannel = {
  address: 'OEQ0000001:4',
  name: 'RT-DN',
  index: 4,
  type: 'CLIMATECONTROL_RT_TRANSCEIVER',
};

const LIMITS_5_30 = {
  TEMPERATURE_MINIMUM: 5,
  TEMPERATURE_MAXIMUM: 30,
  MIN_MAX_VALUE_NOT_RELEVANT_FOR_MANU_MODE: false,
};

async function setup(
  env: SvcEnv,
  ch: CcuChannel,
  context: Record<string, unknown> = {},
): Promise<ReturnType<typeof build>> {
  const b = build(env, thermostatService, ch, context);
  await b.handler.refresh();
  return b;
}

function chars(b: ReturnType<typeof build>) {
  const s = b.svc('Thermostat');
  return {
    target: b.char(s, 'TargetTemperature'),
    mode: b.char(s, 'TargetHeatingCoolingState'),
    current: b.char(s, 'CurrentHeatingCoolingState'),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Thermostat: MASTER set point limits', () => {
  it('sets the target temperature range from MASTER and keeps it in the context', async () => {
    const env = makeSvcEnv();
    env.master[hmip.address] = LIMITS_5_30;
    const b = await setup(env, hmip);
    const { target } = chars(b);
    expect(target.props).toMatchObject({ minValue: 5, maxValue: 30 });
    expect((b.accessory.context as { thermostat?: unknown }).thermostat).toEqual({
      limits: { min: 5, max: 30, notInManu: false },
    });
    expect(b.persist).toHaveBeenCalled();
  });

  it('uses the last known limits at attach, before MASTER is read', () => {
    const env = makeSvcEnv();
    const b = build(env, thermostatService, hmip, {
      thermostat: { limits: { min: 6, max: 25, notInManu: false } },
    } as never);
    expect(chars(b).target.props).toMatchObject({ minValue: 6, maxValue: 25 });
  });

  it('mapping options minTemp / maxTemp win over MASTER', async () => {
    const env = makeSvcEnv();
    env.master[hmip.address] = LIMITS_5_30;
    const b = await setup(env, hmip, { settings: { minTemp: 10 } });
    expect(chars(b).target.props).toMatchObject({ minValue: 10, maxValue: 30 });
  });

  it('ignores the limits when they do not apply in manual mode', async () => {
    const env = makeSvcEnv();
    env.master[hmip.address] = { ...LIMITS_5_30, MIN_MAX_VALUE_NOT_RELEVANT_FOR_MANU_MODE: true };
    const b = await setup(env, hmip);
    expect(chars(b).target.props).toMatchObject({ minValue: 4.5, maxValue: 30.5 });
  });

  it('BidCos and HM-CC-VG-1: limits on the device, as strings', async () => {
    const env = makeSvcEnv();
    env.master['OEQ0000001'] = { TEMPERATURE_MINIMUM: '6.0', TEMPERATURE_MAXIMUM: '28.0' };
    const b = await setup(env, bidcos);
    expect(env.readMaster).toHaveBeenCalledWith('OEQ0000001:4');
    expect(env.readMaster).toHaveBeenCalledWith('OEQ0000001');
    expect(chars(b).target.props).toMatchObject({ minValue: 6, maxValue: 28 });
  });

  it('without MASTER the range stays 4.5..30.5', async () => {
    const env = makeSvcEnv();
    const b = await setup(env, hmip);
    expect(chars(b).target.props).toMatchObject({ minValue: 4.5, maxValue: 30.5 });
  });

  it('re-reads MASTER when CONFIG_PENDING goes from true to false', async () => {
    const env = makeSvcEnv();
    env.master[hmip.address] = LIMITS_5_30;
    const b = await setup(env, hmip);
    env.readMaster.mockClear();
    env.fire('0001D3C99C3C93:0', 'CONFIG_PENDING', false);
    expect(env.readMaster).not.toHaveBeenCalled();
    env.master[hmip.address] = { ...LIMITS_5_30, TEMPERATURE_MINIMUM: 8 };
    env.fire('0001D3C99C3C93:0', 'CONFIG_PENDING', true);
    env.fire('0001D3C99C3C93:0', 'CONFIG_PENDING', false);
    await vi.waitFor(() => expect(chars(b).target.props).toMatchObject({ minValue: 8 }));
  });

  it('while Off, Home sees the temperature Heat restores, not the off value', async () => {
    const env = makeSvcEnv();
    env.master[hmip.address] = LIMITS_5_30;
    env.values[hmip.address] = { SET_POINT_TEMPERATURE: 4.5, SET_POINT_MODE: 1 };
    const fresh = await setup(env, hmip);
    expect(chars(fresh).target.value).toBe(20); // nothing remembered yet: default
    expect(chars(fresh).mode.value).toBe(0);
    // Remembered across a restart (context).
    const restored = await setup(env, hmip, { thermostat: { lastHeatTemp: 18 } });
    expect(chars(restored).target.value).toBe(18);
    expect(await chars(restored).target.onGetHandler!()).toBe(18);
  });
});

describe('Thermostat: Off on a device with a minimum above 4.5 °C (#42)', () => {
  it('stays Off while the group passes on its members, and after it settles at 5 °C', async () => {
    vi.useFakeTimers();
    const env = makeSvcEnv();
    env.master[group.address] = LIMITS_5_30;
    env.values[group.address] = { SET_POINT_TEMPERATURE: 21, SET_POINT_MODE: 1 };
    const info = vi.spyOn(env.log, 'info');
    const b = await setup(env, group);
    const { mode, current } = chars(b);
    expect(mode.value).toBe(1);

    await mode.onSetHandler!(0);
    expect(env.setValues.mock.calls).toEqual([
      [
        group.address,
        [
          ['CONTROL_MODE', 1],
          ['SET_POINT_TEMPERATURE', 4.5],
        ],
        { together: true },
      ],
    ]);
    // Reports of the members, one after the other (log in #42).
    for (const t of [20, 18, 5, 18, 5]) {
      env.fire(group.address, 'SET_POINT_MODE', 1);
      env.fire(group.address, 'SET_POINT_TEMPERATURE', t);
      expect(mode.value).toBe(0);
      expect(current.value).toBe(0);
      vi.advanceTimersByTime(1000);
    }
    vi.advanceTimersByTime(15_000);
    expect(mode.value).toBe(0);
    expect(info).toHaveBeenCalledWith(
      '%s: Off is reported as %s °C, the minimum set point configured in the CCU',
      'Acc',
      5,
    );

    // Heat restores the target before Off, not the minimum.
    env.setValues.mockClear();
    await mode.onSetHandler!(1);
    expect(env.setValues.mock.calls).toEqual([
      [
        group.address,
        [
          ['CONTROL_MODE', 1],
          ['SET_POINT_TEMPERATURE', 21],
        ],
        { together: true },
      ],
    ]);
  });

  it('a higher set point from the device after the grace time ends Off', async () => {
    vi.useFakeTimers();
    const env = makeSvcEnv();
    env.master[hmip.address] = LIMITS_5_30;
    const b = await setup(env, hmip);
    const { mode } = chars(b);
    await mode.onSetHandler!(0);
    env.fire(hmip.address, 'SET_POINT_MODE', 1);
    env.fire(hmip.address, 'SET_POINT_TEMPERATURE', 5);
    vi.advanceTimersByTime(16_000);
    expect(mode.value).toBe(0);
    env.fire(hmip.address, 'SET_POINT_TEMPERATURE', 19);
    expect(mode.value).toBe(1);
    // Back at 5 °C without Off from Home: a deliberate 5 °C is Heat.
    env.fire(hmip.address, 'SET_POINT_TEMPERATURE', 5);
    expect(mode.value).toBe(1);
  });

  it('Auto from the CCU after the grace time ends Off', async () => {
    vi.useFakeTimers();
    const env = makeSvcEnv();
    env.master[hmip.address] = LIMITS_5_30;
    const b = await setup(env, hmip);
    const { mode } = chars(b);
    await mode.onSetHandler!(0);
    env.fire(hmip.address, 'SET_POINT_MODE', 1);
    env.fire(hmip.address, 'SET_POINT_TEMPERATURE', 5);
    vi.advanceTimersByTime(16_000);
    env.fire(hmip.address, 'SET_POINT_MODE', 0);
    expect(mode.value).toBe(3);
  });

  it('Heat after Off restores the minimum when it was chosen in Home', async () => {
    vi.useFakeTimers();
    const env = makeSvcEnv();
    env.master[hmip.address] = LIMITS_5_30;
    env.values[hmip.address] = { SET_POINT_TEMPERATURE: 13.5, SET_POINT_MODE: 1 };
    const b = await setup(env, hmip);
    const { mode, target } = chars(b);
    await target.onSetHandler!(5);
    env.fire(hmip.address, 'SET_POINT_TEMPERATURE', 5);
    await mode.onSetHandler!(0);
    env.fire(hmip.address, 'SET_POINT_MODE', 1);
    env.fire(hmip.address, 'SET_POINT_TEMPERATURE', 5);
    vi.advanceTimersByTime(16_000);
    expect(mode.value).toBe(0);
    env.setValues.mockClear();
    await mode.onSetHandler!(1);
    expect(env.setValues.mock.calls[0]![1]).toEqual([
      ['CONTROL_MODE', 1],
      ['SET_POINT_TEMPERATURE', 5],
    ]);
  });

  it('Heat without Off keeps a set point at the minimum', async () => {
    const env = makeSvcEnv();
    env.master[hmip.address] = LIMITS_5_30;
    env.values[hmip.address] = { SET_POINT_TEMPERATURE: 5, SET_POINT_MODE: 0 };
    const b = await setup(env, hmip);
    await chars(b).mode.onSetHandler!(1);
    expect(env.setValues.mock.calls[0]![1]).toEqual([
      ['CONTROL_MODE', 1],
      ['SET_POINT_TEMPERATURE', 5],
    ]);
  });

  it('Off keeps the temperature in Home; Heat shows the restored one at once', async () => {
    vi.useFakeTimers();
    const env = makeSvcEnv();
    env.master[group.address] = LIMITS_5_30;
    env.values[group.address] = { SET_POINT_TEMPERATURE: 21, SET_POINT_MODE: 1 };
    const b = await setup(env, group);
    const { mode, target } = chars(b);
    expect(target.value).toBe(21);
    await mode.onSetHandler!(0);
    for (const t of [20, 18, 5, 18, 5]) {
      env.fire(group.address, 'SET_POINT_TEMPERATURE', t);
      expect(target.value).toBe(21);
    }
    vi.advanceTimersByTime(16_000);
    expect(target.value).toBe(21);
    expect(await target.onGetHandler!()).toBe(21);
    // Heat: 21 in Home before the CCU answers (no event fired here).
    target.value = 5;
    await mode.onSetHandler!(1);
    expect(target.value).toBe(21);
  });

  it('Auto after Off shows the remembered temperature until the CCU reports', async () => {
    const env = makeSvcEnv();
    env.master[hmip.address] = LIMITS_5_30;
    env.values[hmip.address] = { SET_POINT_TEMPERATURE: 19, SET_POINT_MODE: 1 };
    const b = await setup(env, hmip);
    const { mode, target } = chars(b);
    await mode.onSetHandler!(0);
    env.fire(hmip.address, 'SET_POINT_TEMPERATURE', 5);
    target.value = 5;
    await mode.onSetHandler!(3);
    expect(target.value).toBe(19);
    env.fire(hmip.address, 'SET_POINT_MODE', 0);
    env.fire(hmip.address, 'SET_POINT_TEMPERATURE', 17);
    expect(target.value).toBe(17);
  });

  it('a temperature from Home ends Off', async () => {
    const env = makeSvcEnv();
    env.master[hmip.address] = LIMITS_5_30;
    const b = await setup(env, hmip);
    const { mode, target } = chars(b);
    await mode.onSetHandler!(0);
    await target.onSetHandler!(5);
    env.fire(hmip.address, 'SET_POINT_MODE', 1);
    env.fire(hmip.address, 'SET_POINT_TEMPERATURE', 5);
    expect(mode.value).toBe(1);
  });

  it('Off chosen in Home survives a restart (context)', async () => {
    const env = makeSvcEnv();
    env.master[hmip.address] = LIMITS_5_30;
    env.values[hmip.address] = { SET_POINT_TEMPERATURE: 5, SET_POINT_MODE: 1 };
    const b = await setup(env, hmip, {
      thermostat: { limits: { min: 5, max: 30, notInManu: false }, offRequested: true },
    });
    expect(chars(b).mode.value).toBe(0);
  });

  it('with limits not applying in manual mode, 5 °C after Off is Heat', async () => {
    vi.useFakeTimers();
    const env = makeSvcEnv();
    env.master[hmip.address] = { ...LIMITS_5_30, MIN_MAX_VALUE_NOT_RELEVANT_FOR_MANU_MODE: true };
    const b = await setup(env, hmip);
    const { mode } = chars(b);
    await mode.onSetHandler!(0);
    env.fire(hmip.address, 'SET_POINT_MODE', 1);
    env.fire(hmip.address, 'SET_POINT_TEMPERATURE', 5);
    vi.advanceTimersByTime(16_000);
    expect(mode.value).toBe(1);
  });

  it('a 4.5 °C slot in Auto shows Off', async () => {
    const env = makeSvcEnv();
    env.values[hmip.address] = { SET_POINT_TEMPERATURE: 4.5, SET_POINT_MODE: 0 };
    const b = await setup(env, hmip);
    expect(chars(b).mode.value).toBe(0);
  });
});
