// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import {
  asPlatformAccessory,
  makeAccessory,
  makeHapStub,
  makeLog,
} from '../helpers/hapStub.js';
import type { AccessoryContext, CcuChannel, CcuVariable } from '../../src/types.js';
import type { ServiceContext } from '../../src/services/types.js';

import { programmableSwitchService } from '../../src/services/impl/ProgrammableSwitchAccessory.js';
import { doorOpenerService } from '../../src/services/impl/DoorOpenerAccessory.js';
import { variableNumericSensorService } from '../../src/services/impl/VariableNumericSensorAccessory.js';

interface TestEnv {
  ccu: CcuClient;
  setValueMock: ReturnType<typeof vi.spyOn>;
  fireEvent(address: string, datapoint: string, value: unknown): void;
}

function makeEnv(): TestEnv {
  const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1' });
  const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'sv') });
  return {
    ccu,
    setValueMock: vi.spyOn(ccu, 'setValue').mockResolvedValue(undefined),
    fireEvent(address, datapoint, value) {
      (ccu as unknown as { handleEvent(ev: { callbackId: string; channelAddress: string; datapoint: string; value: unknown; receivedAt: number }): void }).handleEvent({
        callbackId: 'c', channelAddress: address, datapoint, value, receivedAt: 0,
      });
    },
  };
}

function buildCtx(env: TestEnv, context: AccessoryContext) {
  const hap = makeHapStub();
  // Augment hap stub with characteristics needed by the new services.
  const charClass = (name: string, extra: Record<string, unknown> = {}) => {
    class C { static UUID = `char:${name}`; UUID = `char:${name}`; }
    Object.assign(C, extra);
    Object.defineProperty(C, 'name', { value: name });
    return C;
  };
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
  const augmented: Record<string, unknown> = {
    StatelessProgrammableSwitch: svcClass('StatelessProgrammableSwitch'),
    LockMechanism: svcClass('LockMechanism'),
    LightSensor: svcClass('LightSensor'),
  };
  Object.assign(hap.Service as unknown as Record<string, unknown>, augmented);
  const augmentedChars: Record<string, unknown> = {
    ProgrammableSwitchEvent: charClass('ProgrammableSwitchEvent'),
    LockCurrentState: charClass('LockCurrentState'),
    LockTargetState: charClass('LockTargetState'),
    CurrentAmbientLightLevel: charClass('CurrentAmbientLightLevel'),
  };
  Object.assign(hap.Characteristic as unknown as Record<string, unknown>, augmentedChars);

  const accessory = makeAccessory<AccessoryContext>('uuid', context.id, context);
  const ctx: ServiceContext = {
    accessory: asPlatformAccessory(accessory),
    ccu: env.ccu,
    log: new PrefixedLogger(makeLog(), 'sv'),
    Service: hap.Service,
    Characteristic: hap.Characteristic,
  };
  return { ctx, accessory };
}

describe('ProgrammableSwitchAccessory', () => {
  const channel: CcuChannel = { address: 'HmIP.K:1', name: 'Kitchen Button', index: 1, type: 'KEY' };

  it('emits SINGLE_PRESS on a single short press', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ProgrammableSwitchAccessory' });
    programmableSwitchService.build(ctx).attach(channel);
    const eventChar = accessory.services[0]!.characteristics.get('char:ProgrammableSwitchEvent')!;
    env.fireEvent('HmIP.K:1', 'PRESS_SHORT', true);
    expect(eventChar.value).toBe(0);
  });

  it('emits DOUBLE_PRESS for two quick short presses', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ProgrammableSwitchAccessory' });
    programmableSwitchService.build(ctx).attach(channel);
    const eventChar = accessory.services[0]!.characteristics.get('char:ProgrammableSwitchEvent')!;
    env.fireEvent('HmIP.K:1', 'PRESS_SHORT', true);
    env.fireEvent('HmIP.K:1', 'PRESS_SHORT', true);
    expect(eventChar.value).toBe(1);
  });

  it('emits LONG_PRESS on PRESS_LONG=true', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ProgrammableSwitchAccessory' });
    programmableSwitchService.build(ctx).attach(channel);
    const eventChar = accessory.services[0]!.characteristics.get('char:ProgrammableSwitchEvent')!;
    env.fireEvent('HmIP.K:1', 'PRESS_LONG', true);
    expect(eventChar.value).toBe(2);
  });

  it('ignores PRESS_SHORT=false / PRESS_LONG=false (release events)', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ProgrammableSwitchAccessory' });
    programmableSwitchService.build(ctx).attach(channel);
    const eventChar = accessory.services[0]!.characteristics.get('char:ProgrammableSwitchEvent')!;
    env.fireEvent('HmIP.K:1', 'PRESS_SHORT', false);
    env.fireEvent('HmIP.K:1', 'PRESS_LONG', false);
    expect(eventChar.value).toBeUndefined();
  });
});

describe('DoorOpenerAccessory', () => {
  const channel: CcuChannel = { address: 'HmIP.D:1', name: 'Front Door', index: 1, type: 'SWITCH' };

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('pulses STATE=true on Unsecured then auto-resets to Secured', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'DoorOpenerAccessory' });
    doorOpenerService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    const target = service.characteristics.get('char:LockTargetState')!;
    const current = service.characteristics.get('char:LockCurrentState')!;
    await target.onSetHandler!(0); // UNSECURED
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.D:1', 'STATE', true);
    expect(current.value).toBe(0);
    await vi.advanceTimersByTimeAsync(1600);
    expect(target.value).toBe(1); // SECURED
    expect(current.value).toBe(1);
  });

  it('ignores Secured target writes', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'DoorOpenerAccessory' });
    doorOpenerService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    const target = service.characteristics.get('char:LockTargetState')!;
    await target.onSetHandler!(1); // SECURED
    expect(env.setValueMock).not.toHaveBeenCalled();
  });

  it('handles setValue errors gracefully', async () => {
    const env = makeEnv();
    env.setValueMock.mockRejectedValueOnce(new Error('rpc-fail'));
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'DoorOpenerAccessory' });
    const handler = doorOpenerService.build(ctx);
    handler.attach(channel);
    const target = accessory.services[0]!.characteristics.get('char:LockTargetState')!;
    await expect(target.onSetHandler!(0)).resolves.toBeUndefined();
    handler.dispose?.();
  });
});

describe('VariableNumericSensorAccessory', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders a temperature variable as TemperatureSensor', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'variable', id: 'Outdoor', service: 'VariableNumericSensorAccessory', subtype: 'temperature' });
    const variable: CcuVariable = { id: '1', name: 'Outdoor', valuetype: 4, subtype: 0, unit: '°C', value: 18.5 };
    variableNumericSensorService.build(ctx).attach(variable);
    expect(accessory.services[0]!.UUID).toBe('srv:TemperatureSensor');
  });

  it('infers humidity from unit', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'variable', id: 'Hum', service: 'VariableNumericSensorAccessory' });
    const variable: CcuVariable = { id: '2', name: 'Hum', valuetype: 4, subtype: 0, unit: '%', value: 50 };
    variableNumericSensorService.build(ctx).attach(variable);
    expect(accessory.services[0]!.UUID).toBe('srv:HumiditySensor');
  });

  it('infers light from unit', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'variable', id: 'Lux', service: 'VariableNumericSensorAccessory' });
    const variable: CcuVariable = { id: '3', name: 'Lux', valuetype: 4, subtype: 0, unit: 'lx', value: 200 };
    variableNumericSensorService.build(ctx).attach(variable);
    expect(accessory.services[0]!.UUID).toBe('srv:LightSensor');
  });

  it('polls the CCU and pushes new values', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'variable', id: 'Outdoor', service: 'VariableNumericSensorAccessory', subtype: 'temperature' });
    const handler = variableNumericSensorService.build(ctx);
    handler.attach({ id: '1', name: 'Outdoor', valuetype: 4, subtype: 0, unit: '°C', value: 18 });
    vi.spyOn(env.ccu.api, 'getVariable').mockResolvedValue('22.5');
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();
    handler.dispose?.();
  });

  it('swallows poll errors', async () => {
    const env = makeEnv();
    const { ctx } = buildCtx(env, { kind: 'variable', id: 'Outdoor', service: 'VariableNumericSensorAccessory' });
    const handler = variableNumericSensorService.build(ctx);
    handler.attach({ id: '1', name: 'Outdoor', valuetype: 4, subtype: 0, unit: '°C', value: 18 });
    vi.spyOn(env.ccu.api, 'getVariable').mockRejectedValue(new Error('boom'));
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();
    handler.dispose?.();
  });

  it('falls back to temperature for unknown units', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'variable', id: 'X', service: 'VariableNumericSensorAccessory' });
    variableNumericSensorService.build(ctx).attach({ id: '1', name: 'X', valuetype: 4, subtype: 0, value: 1 });
    expect(accessory.services[0]!.UUID).toBe('srv:TemperatureSensor');
  });
});
