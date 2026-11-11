// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { describe, it, expect, vi } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import {
  asPlatformAccessory,
  makeAccessory,
  makeHapStub,
  makeLog,
} from '../helpers/hapStub.js';
import type { AccessoryContext, CcuChannel } from '../../src/types.js';
import type { ServiceContext } from '../../src/services/types.js';

import { lockService } from '../../src/services/impl/LockAccessory.js';
import { colorTempDimmerService, _testing as colorTempTesting } from '../../src/services/impl/ColorTempDimmerAccessory.js';
import { rgbLightService, _testing as rgbTesting } from '../../src/services/impl/RgbLightAccessory.js';
import { powerMeterService } from '../../src/services/impl/PowerMeterAccessory.js';
import { slatBlindService } from '../../src/services/impl/SlatBlindAccessory.js';

interface TestEnv {
  ccu: CcuClient;
  setValueMock: ReturnType<typeof vi.spyOn>;
  getValueMock: ReturnType<typeof vi.spyOn>;
  fireEvent(address: string, datapoint: string, value: unknown): void;
}

function makeEnv(): TestEnv {
  const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1' });
  const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'sv') });
  return {
    ccu,
    setValueMock: vi.spyOn(ccu, 'setValue').mockResolvedValue(undefined),
    getValueMock: vi.spyOn(ccu, 'getValue').mockResolvedValue(undefined),
    fireEvent(address, datapoint, value) {
      (ccu as unknown as {
        handleEvent(ev: { callbackId: string; channelAddress: string; datapoint: string; value: unknown; receivedAt: number }): void;
      }).handleEvent({
        callbackId: 'c', channelAddress: address, datapoint, value, receivedAt: 0,
      });
    },
  };
}

function buildCtx(env: TestEnv, context: AccessoryContext) {
  const hap = makeHapStub();
  const charClass = (name: string, extra: Record<string, unknown> = {}) => {
    class C { static UUID = `char:${name}`; UUID = `char:${name}`; }
    Object.assign(C, extra);
    Object.defineProperty(C, 'name', { value: name });
    return C;
  };
  // Custom service classes intentionally omit `characteristics` so the
  // makeAccessory wrapper substitutes a proper ServiceStub (Map-based
  // characteristics, getCharacteristic, etc.).
  const svcClass = (name: string) => {
    class S {
      static UUID = `srv:${name}`;
      UUID = `srv:${name}`;
      displayName = '';
      subtype: string | undefined;
      constructor(displayName?: string, subtype?: string) {
        this.displayName = displayName ?? '';
        this.subtype = subtype;
      }
    }
    Object.defineProperty(S, 'name', { value: name });
    return S;
  };
  Object.assign(hap.Service as unknown as Record<string, unknown>, {
    LockMechanism: svcClass('LockMechanism'),
  });

  // Replace hap.Characteristic with a callable class that preserves the
  // existing static slots. Production hap-nodejs's Characteristic is a
  // class — services like PowerMeter create custom Eve characteristics
  // via `new this.Characteristic(displayName, uuid, props)`. The default
  // makeHapStub() exposes Characteristic only as a namespace object, so
  // we need to upgrade it for tests that exercise that path.
  class CharRoot {
    UUID = '';
    displayName = '';
    props: Record<string, unknown> = {};
    value: unknown = undefined;
    constructor(displayName?: string, uuid?: string, props?: Record<string, unknown>) {
      this.displayName = displayName ?? '';
      this.UUID = uuid ?? '';
      this.props = props ?? {};
    }
    onGet() { return this; }
    onSet() { return this; }
    setProps(p: Record<string, unknown>) { Object.assign(this.props, p); return this; }
    updateValue(v: unknown) { this.value = v; return this; }
  }
  // Copy existing slots from hap.Characteristic onto CharRoot.
  Object.assign(CharRoot, hap.Characteristic);
  // Add the new characteristic classes we need.
  Object.assign(CharRoot as unknown as Record<string, unknown>, {
    LockCurrentState: charClass('LockCurrentState', {
      UNSECURED: 0, SECURED: 1, JAMMED: 2, UNKNOWN: 3,
    }),
    LockTargetState: charClass('LockTargetState', { UNSECURED: 0, SECURED: 1 }),
    Hue: charClass('Hue'),
    Saturation: charClass('Saturation'),
    ColorTemperature: charClass('ColorTemperature'),
    OutletInUse: charClass('OutletInUse'),
    CurrentHorizontalTiltAngle: charClass('CurrentHorizontalTiltAngle'),
    TargetHorizontalTiltAngle: charClass('TargetHorizontalTiltAngle'),
  });

  const accessory = makeAccessory<AccessoryContext>('uuid', context.id, context);
  const ctx: ServiceContext = {
    accessory: asPlatformAccessory(accessory),
    ccu: env.ccu,
    log: new PrefixedLogger(makeLog(), 'sv'),
    Service: hap.Service,
    Characteristic: CharRoot as unknown as typeof hap.Characteristic,
  };
  return { ctx, accessory };
}

describe('LockAccessory', () => {
  const channel: CcuChannel = { address: 'HmIP.L:1', name: 'Front Door', index: 1, type: 'KEYMATIC' };

  it('writes inverted STATE on lock command', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'LockAccessory' });
    lockService.build(ctx).attach(channel);
    const target = accessory.services[0]!.characteristics.get('char:LockTargetState')!;
    await target.onSetHandler!(1); // SECURED
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.L:1', 'STATE', false);
  });

  it('writes inverted STATE on unlock command', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'LockAccessory' });
    lockService.build(ctx).attach(channel);
    const target = accessory.services[0]!.characteristics.get('char:LockTargetState')!;
    await target.onSetHandler!(0); // UNSECURED
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.L:1', 'STATE', true);
  });

  it('reflects STATE=true (unlocked) push event as UNSECURED', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'LockAccessory' });
    lockService.build(ctx).attach(channel);
    env.fireEvent('HmIP.L:1', 'STATE', true);
    const current = accessory.services[0]!.characteristics.get('char:LockCurrentState')!;
    expect(current.value).toBe(0); // UNSECURED
  });

  it('reflects STATE=false (locked) push event as SECURED', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'LockAccessory' });
    lockService.build(ctx).attach(channel);
    env.fireEvent('HmIP.L:1', 'STATE', false);
    const current = accessory.services[0]!.characteristics.get('char:LockCurrentState')!;
    const target = accessory.services[0]!.characteristics.get('char:LockTargetState')!;
    expect(current.value).toBe(1); // SECURED
    expect(target.value).toBe(1);
  });

  it('initial pull seeds SECURED / UNSECURED based on STATE', async () => {
    const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
    const env = makeEnv();
    env.getValueMock.mockImplementation(async (_a, dp) => dp === 'STATE' ? false : undefined);
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'LockAccessory' });
    lockService.build(ctx).attach(channel);
    await flush();
    const current = accessory.services[0]!.characteristics.get('char:LockCurrentState')!;
    expect(current.value).toBe(1); // SECURED
  });

  it('reflects ERROR>0 as JAMMED', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'LockAccessory' });
    lockService.build(ctx).attach(channel);
    env.fireEvent('HmIP.L:1', 'ERROR', 1);
    const current = accessory.services[0]!.characteristics.get('char:LockCurrentState')!;
    expect(current.value).toBe(2); // JAMMED
  });
});

describe('ColorTempDimmerAccessory.deriveColortempAddress', () => {
  it('computes the next channel index', () => {
    expect(colorTempTesting.deriveColortempAddress('HmIP.000ABC:1')).toBe('HmIP.000ABC:2');
    expect(colorTempTesting.deriveColortempAddress('HmIP.000ABC:5')).toBe('HmIP.000ABC:6');
  });

  it('returns undefined for addresses without a colon suffix', () => {
    expect(colorTempTesting.deriveColortempAddress('HmIP.000ABC')).toBeUndefined();
  });
});

describe('ColorTempDimmerAccessory', () => {
  const channel: CcuChannel = {
    address: 'HmIP.D:1', name: 'Dim', index: 1, type: 'DIMMER_VIRTUAL_RECEIVER',
  };

  it('writes brightness LEVEL to the bound channel', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ColorTempDimmerAccessory' });
    colorTempDimmerService.build(ctx).attach(channel);
    const brightness = accessory.services[0]!.characteristics.get('char:Brightness')!;
    await brightness.onSetHandler!(60);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.D:1', 'LEVEL', 0.6);
  });

  it('writes color temperature LEVEL to the sibling channel (auto-derived)', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ColorTempDimmerAccessory' });
    colorTempDimmerService.build(ctx).attach(channel);
    const ct = accessory.services[0]!.characteristics.get('char:ColorTemperature')!;
    // mired = 320 => fraction = (320-140)/360 ≈ 0.5
    await ct.onSetHandler!(320);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.D:2', 'LEVEL', expect.closeTo(0.5, 2));
  });

  it('respects an explicit coltempAddress in settings', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, {
      kind: 'channel', id: channel.address, service: 'ColorTempDimmerAccessory',
      settings: { coltempAddress: 'HmIP.D:7' },
    });
    colorTempDimmerService.build(ctx).attach(channel);
    const ct = accessory.services[0]!.characteristics.get('char:ColorTemperature')!;
    await ct.onSetHandler!(140); // coolest
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.D:7', 'LEVEL', 0);
  });

  it('reflects sibling LEVEL events as a mired value', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ColorTempDimmerAccessory' });
    colorTempDimmerService.build(ctx).attach(channel);
    env.fireEvent('HmIP.D:2', 'LEVEL', 1);
    const ct = accessory.services[0]!.characteristics.get('char:ColorTemperature')!;
    expect(ct.value).toBe(500);
  });
});

describe('RgbLightAccessory', () => {
  const channel: CcuChannel = {
    address: 'HmIP.B:8', name: 'BSL', index: 8, type: 'DIMMER_VIRTUAL_RECEIVER',
  };

  it('snapHueToBslIndex picks the closest discrete colour', () => {
    expect(rgbTesting.snapHueToBslIndex(0, 100)).toBe(4);     // red
    expect(rgbTesting.snapHueToBslIndex(120, 100)).toBe(2);   // green
    expect(rgbTesting.snapHueToBslIndex(240, 100)).toBe(1);   // blue
    expect(rgbTesting.snapHueToBslIndex(0, 0)).toBe(7);       // saturation 0 => white
  });

  it('discrete subtype writes COLOR as integer enum 0..7', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'RgbLightAccessory', subtype: 'discrete' });
    rgbLightService.build(ctx).attach(channel);
    const sat = accessory.services[0]!.characteristics.get('char:Saturation')!;
    const hue = accessory.services[0]!.characteristics.get('char:Hue')!;
    await sat.onSetHandler!(100);
    await hue.onSetHandler!(120);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.B:8', 'COLOR', 2); // green
  });

  it('continuous subtype writes COLOR as 0..199 hue ring', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'RgbLightAccessory', subtype: 'continuous' });
    rgbLightService.build(ctx).attach(channel);
    const sat = accessory.services[0]!.characteristics.get('char:Saturation')!;
    const hue = accessory.services[0]!.characteristics.get('char:Hue')!;
    await sat.onSetHandler!(100);
    await hue.onSetHandler!(180); // half ring → round((180/360)*199) = 100
    const lastCall = env.setValueMock.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe('COLOR');
    expect(lastCall?.[2] as number).toBeGreaterThanOrEqual(99);
    expect(lastCall?.[2] as number).toBeLessThanOrEqual(100);
  });

  it('continuous subtype writes 200 (white) for saturation 0', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'RgbLightAccessory', subtype: 'continuous' });
    rgbLightService.build(ctx).attach(channel);
    const sat = accessory.services[0]!.characteristics.get('char:Saturation')!;
    await sat.onSetHandler!(0);
    expect(env.setValueMock).toHaveBeenLastCalledWith('HmIP.B:8', 'COLOR', 200);
  });

  it('initial pull: COLOR getValue applies discrete index back to Hue/Sat', async () => {
    const env = makeEnv();
    env.getValueMock.mockImplementation(async (_a, dp) => dp === 'COLOR' ? 4 : undefined);
    const channel: CcuChannel = { address: 'HmIP.B:8', name: 'BSL', index: 8, type: 'RGBW' };
    const { ctx, accessory } = buildCtx(env, {
      kind: 'channel', id: channel.address, service: 'RgbLightAccessory', subtype: 'discrete',
    });
    rgbLightService.build(ctx).attach(channel);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const hue = accessory.services[0]!.characteristics.get('char:Hue')!;
    expect(hue.value).toBeDefined();
  });

  it('initial pull: continuous COLOR=200 maps to white (sat=0)', async () => {
    const env = makeEnv();
    env.getValueMock.mockImplementation(async (_a, dp) => dp === 'COLOR' ? 200 : undefined);
    const channel: CcuChannel = { address: 'HmIP.B:8', name: 'RGBW', index: 8, type: 'RGBW' };
    const { ctx, accessory } = buildCtx(env, {
      kind: 'channel', id: channel.address, service: 'RgbLightAccessory', subtype: 'continuous',
    });
    rgbLightService.build(ctx).attach(channel);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const sat = accessory.services[0]!.characteristics.get('char:Saturation')!;
    expect(sat.value).toBe(0);
  });

  it('initial pull: continuous COLOR=99 maps to mid-spectrum hue', async () => {
    const env = makeEnv();
    env.getValueMock.mockImplementation(async (_a, dp) => dp === 'COLOR' ? 99 : undefined);
    const channel: CcuChannel = { address: 'HmIP.B:8', name: 'RGBW', index: 8, type: 'RGBW' };
    const { ctx, accessory } = buildCtx(env, {
      kind: 'channel', id: channel.address, service: 'RgbLightAccessory', subtype: 'continuous',
    });
    rgbLightService.build(ctx).attach(channel);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const hue = accessory.services[0]!.characteristics.get('char:Hue')!;
    expect(hue.value).toBeCloseTo((99 / 199) * 360, 1);
  });
});

describe('SlatBlindAccessory', () => {
  const channel: CcuChannel = {
    address: 'HmIP.S:4', name: 'Slats', index: 4, type: 'BLIND_VIRTUAL_RECEIVER',
  };

  it('writes LEVEL_2 for tilt angle, mapped from -90..90 to 0..1', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'SlatBlindAccessory' });
    slatBlindService.build(ctx).attach(channel);
    const target = accessory.services[0]!.characteristics.get('char:TargetHorizontalTiltAngle')!;
    await target.onSetHandler!(0);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.S:4', 'LEVEL_2', 0.5);
    await target.onSetHandler!(-90);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.S:4', 'LEVEL_2', 0);
  });

  it('reflects LEVEL_2 events as a tilt angle', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'SlatBlindAccessory' });
    slatBlindService.build(ctx).attach(channel);
    env.fireEvent('HmIP.S:4', 'LEVEL_2', 1);
    const current = accessory.services[0]!.characteristics.get('char:CurrentHorizontalTiltAngle')!;
    expect(current.value).toBe(90);
  });

  it('seeds LEVEL_2 from getValue at attach (initial pull)', async () => {
    const env = makeEnv();
    env.getValueMock.mockImplementation(async (_a, dp) => dp === 'LEVEL_2' ? 0 : undefined);
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'SlatBlindAccessory' });
    slatBlindService.build(ctx).attach(channel);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const current = accessory.services[0]!.characteristics.get('char:CurrentHorizontalTiltAngle')!;
    expect(current.value).toBe(-90); // -90 + 0*180 = -90
  });

  it('PositionState reflects target>current (increasing) and target<current (decreasing)', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'SlatBlindAccessory' });
    slatBlindService.build(ctx).attach(channel);
    const positionState = accessory.services[0]!.characteristics.get('char:PositionState')!;
    const target = accessory.services[0]!.characteristics.get('char:TargetPosition')!;

    // Increasing: current=20, set target=80 (no LEVEL pushed in between),
    // then WORKING=true fires derivePositionState → STATE_INCREASING (1).
    env.fireEvent('HmIP.S:4', 'LEVEL', 0.2);
    await target.onSetHandler!(80);
    env.fireEvent('HmIP.S:4', 'WORKING', true);
    expect(positionState.value).toBe(1);

    // Decreasing: current=80, target=20.
    env.fireEvent('HmIP.S:4', 'LEVEL', 0.8);
    await target.onSetHandler!(20);
    env.fireEvent('HmIP.S:4', 'WORKING', true);
    expect(positionState.value).toBe(0);

    // WORKING=false → STATE_STOPPED (2).
    env.fireEvent('HmIP.S:4', 'WORKING', false);
    expect(positionState.value).toBe(2);
  });
});

describe('PowerMeterAccessory', () => {
  const channel: CcuChannel = {
    address: 'HmIP.P:6', name: 'PSM Meter', index: 6, type: 'ENERGIE_METER_TRANSMITTER',
  };

  it('subscribes and exposes Eve custom characteristics on the Outlet service', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'PowerMeterAccessory' });
    powerMeterService.build(ctx).attach(channel);
    expect(accessory.services[0]!.UUID).toBe('srv:Outlet');
    // Push a POWER event and verify the OutletInUse characteristic flips on.
    env.fireEvent('HmIP.P:6', 'POWER', 12.5);
    const outletInUse = accessory.services[0]!.characteristics.get('char:OutletInUse')!;
    expect(outletInUse.value).toBe(true);
  });
});
