// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * One test file covering each ChannelService implementation. Each test
 * builds the service with the hap stub, attaches a synthetic channel,
 * and exercises the get/set handlers and inbound CCU event listener.
 */

import { describe, it, expect, vi } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { resolveConfig } from '../../src/util/config.js';
import { asPlatformAccessory, makeAccessory, makeHapStub, makeLog, type CharacteristicStub, type ServiceStub } from '../helpers/hapStub.js';
import type { AccessoryContext, CcuChannel, CcuVariable } from '../../src/types.js';
import type { ServiceContext } from '../../src/services/types.js';

import { switchService } from '../../src/services/impl/SwitchAccessory.js';
import { dimmerService } from '../../src/services/impl/DimmerAccessory.js';
import { blindService } from '../../src/services/impl/BlindAccessory.js';
import { thermostatService } from '../../src/services/impl/ThermostatAccessory.js';
import { contactService } from '../../src/services/impl/ContactAccessory.js';
import { motionService } from '../../src/services/impl/MotionAccessory.js';
import { smokeService } from '../../src/services/impl/SmokeAccessory.js';
import { temperatureService } from '../../src/services/impl/TemperatureAccessory.js';
import { humidityService } from '../../src/services/impl/HumidityAccessory.js';
import { leakService } from '../../src/services/impl/LeakAccessory.js';
import { variableSwitchService, variableLightService } from '../../src/services/impl/VariableAccessory.js';
import { programService } from '../../src/services/impl/ProgramAccessory.js';
import { weatherStationService } from '../../src/services/impl/WeatherStationAccessory.js';
import { garageDoorService } from '../../src/services/impl/GarageDoorAccessory.js';

const channel: CcuChannel = { address: 'HmIP.000123:1', name: 'Test', index: 1, type: 'SWITCH' };

interface TestEnv {
  ccu: CcuClient;
  setValueMock: ReturnType<typeof vi.spyOn>;
  getValueMock: ReturnType<typeof vi.spyOn>;
  fireEvent(address: string, datapoint: string, value: unknown): void;
}

function makeEnv(): TestEnv {
  const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1' });
  const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'svc-test') });
  const setValueMock = vi.spyOn(ccu, 'setValue').mockResolvedValue(undefined);
  const getValueMock = vi.spyOn(ccu, 'getValue').mockResolvedValue(undefined);
  return {
    ccu,
    setValueMock,
    getValueMock,
    fireEvent(address, datapoint, value) {
      (ccu as unknown as { handleEvent(ev: { callbackId: string; channelAddress: string; datapoint: string; value: unknown; receivedAt: number }): void }).handleEvent({
        callbackId: 'c', channelAddress: address, datapoint, value, receivedAt: 0,
      });
    },
  };
}

function buildCtx(env: TestEnv, context: AccessoryContext): { ctx: ServiceContext; accessory: ReturnType<typeof makeAccessory<AccessoryContext>> } {
  const hap = makeHapStub();
  const accessory = makeAccessory<AccessoryContext>('uuid', context.name ?? 'Test', context);
  const ctx: ServiceContext = {
    accessory: asPlatformAccessory(accessory),
    ccu: env.ccu,
    log: new PrefixedLogger(makeLog(), 'svc'),
    Service: hap.Service,
    Characteristic: hap.Characteristic,
  };
  return { ctx, accessory };
}

function getChar(service: ServiceStub, name: string): CharacteristicStub {
  const c = service.characteristics.get(`char:${name}`);
  if (!c) {
    throw new Error(`Missing characteristic ${name}`);
  }
  return c;
}

describe('SwitchAccessory', () => {
  it('On characteristic getter / setter / event update for Switch variant', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'SwitchAccessory', subtype: 'switch' });
    const handler = switchService.build(ctx);
    handler.attach(channel);
    const service = accessory.services[0]!;
    expect(service.UUID).toBe('srv:Switch');

    const onChar = getChar(service, 'On');
    expect(await onChar.onGetHandler!()).toBe(false);

    await onChar.onSetHandler!(true);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.000123:1', 'STATE', true);
    expect(await onChar.onGetHandler!()).toBe(true);

    env.fireEvent('HmIP.000123:1', 'STATE', false);
    expect(onChar.value).toBe(false);
  });

  it('Outlet variant uses Outlet service', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'SwitchAccessory', subtype: 'outlet' });
    switchService.build(ctx).attach(channel);
    expect(accessory.services[0]!.UUID).toBe('srv:Outlet');
  });

  it('Lightbulb variant uses Lightbulb service', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'SwitchAccessory', subtype: 'lightbulb' });
    switchService.build(ctx).attach(channel);
    expect(accessory.services[0]!.UUID).toBe('srv:Lightbulb');
  });
});

describe('DimmerAccessory', () => {
  it('reflects LEVEL events to Brightness + On', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'DimmerAccessory' });
    dimmerService.build(ctx).attach(channel);
    const service = accessory.services[0]!;

    env.fireEvent('HmIP.000123:1', 'LEVEL', 0.5);
    expect(getChar(service, 'Brightness').value).toBe(50);
    expect(getChar(service, 'On').value).toBe(true);

    await getChar(service, 'Brightness').onSetHandler!(75);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.000123:1', 'LEVEL', 0.75);

    await getChar(service, 'On').onSetHandler!(false);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.000123:1', 'LEVEL', 0);

    env.fireEvent('HmIP.000123:1', 'LEVEL', 'not-a-number');
    expect(getChar(service, 'Brightness').value).toBe(50); // unchanged
  });

  it('On=true with cachedLevel=0 resolves to LEVEL=0.01', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'DimmerAccessory' });
    dimmerService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    await getChar(service, 'On').onSetHandler!(true);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.000123:1', 'LEVEL', 0.01);
  });
});

describe('BlindAccessory', () => {
  it('LEVEL event updates current/target/positionState', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'BlindAccessory' });
    blindService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    env.fireEvent('HmIP.000123:1', 'LEVEL', 0.4);
    expect(getChar(service, 'CurrentPosition').value).toBe(40);
    expect(getChar(service, 'TargetPosition').value).toBe(40);
    expect(getChar(service, 'PositionState').value).toBe(2);
    env.fireEvent('HmIP.000123:1', 'LEVEL', 'nope'); // ignored
  });

  it('TargetPosition setter calls setValue with /100', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'BlindAccessory' });
    blindService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    await getChar(service, 'TargetPosition').onSetHandler!(80);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.000123:1', 'LEVEL', 0.8);
  });

  it('WORKING event updates PositionState', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'BlindAccessory' });
    blindService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    env.fireEvent('HmIP.000123:1', 'WORKING', false);
    expect(getChar(service, 'PositionState').value).toBe(2);
    env.fireEvent('HmIP.000123:1', 'WORKING', true);
    expect(getChar(service, 'PositionState').value).toBe(2); // current=target=0
  });

  it('PositionState reflects increasing/decreasing target', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'BlindAccessory' });
    blindService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    env.fireEvent('HmIP.000123:1', 'LEVEL', 0.5);
    // Now current=50, set target higher.
    await getChar(service, 'TargetPosition').onSetHandler!(80);
    expect(await getChar(service, 'PositionState').onGetHandler!()).toBe(1);
    // Set target lower than current.
    await getChar(service, 'TargetPosition').onSetHandler!(10);
    expect(await getChar(service, 'PositionState').onGetHandler!()).toBe(0);
  });
});

describe('ThermostatAccessory', () => {
  it('reflects ACTUAL_TEMPERATURE and SET_TEMPERATURE events', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ThermostatAccessory' });
    thermostatService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    env.fireEvent('HmIP.000123:1', 'ACTUAL_TEMPERATURE', 21.5);
    expect(getChar(service, 'CurrentTemperature').value).toBe(21.5);
    env.fireEvent('HmIP.000123:1', 'SET_TEMPERATURE', 22);
    expect(getChar(service, 'TargetTemperature').value).toBe(22);
    await getChar(service, 'TargetTemperature').onSetHandler!(23);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.000123:1', 'SET_TEMPERATURE', 23);
  });

  it('CurrentHeatingCoolingState reflects target vs current temp', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ThermostatAccessory' });
    thermostatService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    // Default: target=20, current=20 → not heating.
    expect(await getChar(service, 'CurrentHeatingCoolingState').onGetHandler!()).toBe(0);
    // Target above current → heating.
    env.fireEvent('HmIP.000123:1', 'SET_TEMPERATURE', 25);
    expect(await getChar(service, 'CurrentHeatingCoolingState').onGetHandler!()).toBe(1);
    // Target ≤ 4.5 → off.
    env.fireEvent('HmIP.000123:1', 'SET_TEMPERATURE', 4.5);
    expect(await getChar(service, 'CurrentHeatingCoolingState').onGetHandler!()).toBe(0);
    // Bad numeric event ignored.
    env.fireEvent('HmIP.000123:1', 'ACTUAL_TEMPERATURE', 'nope');
    env.fireEvent('HmIP.000123:1', 'SET_TEMPERATURE', 'nope');
  });

  it('TargetHeatingCoolingState off / heat / auto each emit the right datapoint', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ThermostatAccessory' });
    thermostatService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    await getChar(service, 'TargetHeatingCoolingState').onSetHandler!(0);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.000123:1', 'SET_TEMPERATURE', 4.5);
    await getChar(service, 'TargetHeatingCoolingState').onSetHandler!(3);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.000123:1', 'AUTO_MODE', true);
    await getChar(service, 'TargetHeatingCoolingState').onSetHandler!(1);
    expect(env.setValueMock).toHaveBeenCalledWith('HmIP.000123:1', 'MANU_MODE', expect.any(Number));
  });

  it('Display units returns CELSIUS', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ThermostatAccessory' });
    thermostatService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    expect(await getChar(service, 'TemperatureDisplayUnits').onGetHandler!()).toBe(0);
  });
});

describe('ContactAccessory', () => {
  it('contact variant uses ContactSensorState', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ContactAccessory', subtype: 'contact' });
    contactService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    env.fireEvent('HmIP.000123:1', 'STATE', true);
    expect(getChar(service, 'ContactSensorState').value).toBe(1); // NOT_DETECTED
    env.fireEvent('HmIP.000123:1', 'STATE', false);
    expect(getChar(service, 'ContactSensorState').value).toBe(0);
  });

  it('door variant uses position characteristics', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ContactAccessory', subtype: 'door' });
    contactService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    expect(service.UUID).toBe('srv:Door');
    env.fireEvent('HmIP.000123:1', 'STATE', true);
    expect(getChar(service, 'CurrentPosition').value).toBe(100);
  });

  it('window variant uses Window service', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'ContactAccessory', subtype: 'window' });
    contactService.build(ctx).attach(channel);
    expect(accessory.services[0]!.UUID).toBe('srv:Window');
  });
});

describe('MotionAccessory', () => {
  it('MOTION events update MotionDetected', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'MotionAccessory' });
    motionService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    env.fireEvent('HmIP.000123:1', 'MOTION', true);
    expect(getChar(service, 'MotionDetected').value).toBe(true);
  });
});

describe('SmokeAccessory', () => {
  it('STATE events map to SmokeDetected', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'SmokeAccessory' });
    smokeService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    env.fireEvent('HmIP.000123:1', 'STATE', true);
    expect(getChar(service, 'SmokeDetected').value).toBe(1);
  });
});

describe('TemperatureAccessory', () => {
  it('updates from TEMPERATURE and ACTUAL_TEMPERATURE', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'TemperatureAccessory' });
    temperatureService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    env.fireEvent('HmIP.000123:1', 'TEMPERATURE', 19.5);
    expect(getChar(service, 'CurrentTemperature').value).toBe(19.5);
    env.fireEvent('HmIP.000123:1', 'ACTUAL_TEMPERATURE', 20.5);
    expect(getChar(service, 'CurrentTemperature').value).toBe(20.5);
  });

  it('ignores non-numeric values', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'TemperatureAccessory' });
    temperatureService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    // No update happened, so internal default of 20 is still returned by onGet.
    env.fireEvent('HmIP.000123:1', 'TEMPERATURE', 'NaN');
    expect(await getChar(service, 'CurrentTemperature').onGetHandler!()).toBe(20);
  });
});

describe('HumidityAccessory', () => {
  it('rounds and clamps humidity values', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'HumidityAccessory' });
    humidityService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    env.fireEvent('HmIP.000123:1', 'HUMIDITY', 55.4);
    expect(getChar(service, 'CurrentRelativeHumidity').value).toBe(55);
    env.fireEvent('HmIP.000123:1', 'HUMIDITY', 105);
    expect(getChar(service, 'CurrentRelativeHumidity').value).toBe(100);
    env.fireEvent('HmIP.000123:1', 'HUMIDITY', 'nan'); // ignored
  });
});

describe('LeakAccessory', () => {
  it('STATE → LeakDetected', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'LeakAccessory' });
    leakService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    env.fireEvent('HmIP.000123:1', 'STATE', true);
    expect(getChar(service, 'LeakDetected').value).toBe(1);
    expect(await getChar(service, 'LeakDetected').onGetHandler!()).toBe(1);
    env.fireEvent('HmIP.000123:1', 'STATE', false);
    expect(getChar(service, 'LeakDetected').value).toBe(0);
  });
});

describe('SmokeAccessory edge', () => {
  it('reset path', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: channel.address, service: 'SmokeAccessory' });
    smokeService.build(ctx).attach(channel);
    const service = accessory.services[0]!;
    env.fireEvent('HmIP.000123:1', 'STATE', true);
    env.fireEvent('HmIP.000123:1', 'STATE', false);
    expect(await getChar(service, 'SmokeDetected').onGetHandler!()).toBe(0);
  });
});

describe('VariableAccessory', () => {
  it('Switch variant: get/set push to CcuJsonRpcClient', async () => {
    const env = makeEnv();
    const setVar = vi.spyOn(env.ccu.api, 'setVariable').mockResolvedValue(undefined);
    const { ctx, accessory } = buildCtx(env, { kind: 'variable', id: 'V1', service: 'VariableSwitchAccessory' });
    const variable: CcuVariable = { id: '1', name: 'V1', valuetype: 2, subtype: 0, value: false };
    const handler = variableSwitchService.build(ctx);
    handler.attach(variable);
    const service = accessory.services[0]!;
    await getChar(service, 'On').onSetHandler!(true);
    expect(setVar).toHaveBeenCalledWith('V1', true);
    handler.dispose?.();
  });

  it('Light variant respects min/max', async () => {
    const env = makeEnv();
    const setVar = vi.spyOn(env.ccu.api, 'setVariable').mockResolvedValue(undefined);
    const { ctx, accessory } = buildCtx(env, { kind: 'variable', id: 'V2', service: 'VariableLightAccessory' });
    const variable: CcuVariable = { id: '2', name: 'V2', valuetype: 4, subtype: 0, minValue: 10, maxValue: 90, value: 30 };
    const handler = variableLightService.build(ctx);
    handler.attach(variable);
    const service = accessory.services[0]!;
    await getChar(service, 'Brightness').onSetHandler!(200);
    expect(setVar).toHaveBeenCalledWith('V2', 90);
    await getChar(service, 'Brightness').onSetHandler!(-50);
    expect(setVar).toHaveBeenCalledWith('V2', 10);
    handler.dispose?.();
  });
});

describe('ProgramAccessory', () => {
  it('On=true triggers runProgram, On=false is a no-op', async () => {
    const env = makeEnv();
    const runProg = vi.spyOn(env.ccu.api, 'runProgram').mockResolvedValue(undefined);
    const { ctx, accessory } = buildCtx(env, { kind: 'program', id: 'P1', service: 'ProgramAccessory' });
    programService.build(ctx).attach('P1');
    const service = accessory.services[0]!;
    await getChar(service, 'On').onSetHandler!(true);
    expect(runProg).toHaveBeenCalledWith('P1');
    runProg.mockClear();
    await getChar(service, 'On').onSetHandler!(false);
    expect(runProg).not.toHaveBeenCalled();
  });
});

describe('WeatherStationAccessory', () => {
  const wchannel: CcuChannel = { address: 'HmIP.000WTH:1', name: 'Garden', index: 1, type: 'WEATHER_TRANSMIT' };

  it('exposes Temperature / Humidity / LightSensor / LeakSensor sub-services', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: wchannel.address, service: 'WeatherStationAccessory' });
    weatherStationService.build(ctx).attach(wchannel);
    const subtypes = accessory.services.map((s) => s.subtype);
    expect(subtypes).toContain('weather-temp');
    expect(subtypes).toContain('weather-hum');
    expect(subtypes).toContain('weather-light');
    expect(subtypes).toContain('weather-rain');
  });

  it('TEMPERATURE / HUMIDITY / ILLUMINATION / RAINING events update the right sub-services', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: wchannel.address, service: 'WeatherStationAccessory' });
    weatherStationService.build(ctx).attach(wchannel);
    const tempSvc  = accessory.services.find((s) => s.subtype === 'weather-temp')!;
    const humSvc   = accessory.services.find((s) => s.subtype === 'weather-hum')!;
    const lightSvc = accessory.services.find((s) => s.subtype === 'weather-light')!;
    const rainSvc  = accessory.services.find((s) => s.subtype === 'weather-rain')!;

    env.fireEvent(wchannel.address, 'TEMPERATURE', 21.5);
    expect(getChar(tempSvc, 'CurrentTemperature').value).toBe(21.5);

    env.fireEvent(wchannel.address, 'HUMIDITY', 64);
    expect(getChar(humSvc, 'CurrentRelativeHumidity').value).toBe(64);

    env.fireEvent(wchannel.address, 'ILLUMINATION', 1234);
    expect(getChar(lightSvc, 'CurrentAmbientLightLevel').value).toBe(1234);

    env.fireEvent(wchannel.address, 'RAINING', true);
    expect(getChar(rainSvc, 'LeakDetected').value).toBe(1);
    env.fireEvent(wchannel.address, 'RAINING', false);
    expect(getChar(rainSvc, 'LeakDetected').value).toBe(0);
  });

  it('clamps illumination to HAP range and ignores junk temperature', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: wchannel.address, service: 'WeatherStationAccessory' });
    weatherStationService.build(ctx).attach(wchannel);
    const lightSvc = accessory.services.find((s) => s.subtype === 'weather-light')!;
    const tempSvc  = accessory.services.find((s) => s.subtype === 'weather-temp')!;

    env.fireEvent(wchannel.address, 'ILLUMINATION', 1_000_000);
    expect(getChar(lightSvc, 'CurrentAmbientLightLevel').value).toBe(100000);

    env.fireEvent(wchannel.address, 'TEMPERATURE', 'NaN');
    // Junk input is rejected, so updateCharacteristic was never called
    // and the stub's `value` stays undefined; the handler still returns
    // the in-memory default via the onGet path.
    expect(getChar(tempSvc, 'CurrentTemperature').value).toBeUndefined();
    expect(await getChar(tempSvc, 'CurrentTemperature').onGetHandler!()).toBe(20);
  });
});

describe('GarageDoorAccessory', () => {
  const gchannel: CcuChannel = { address: 'HmIP.000GRG:1', name: 'Garage', index: 1, type: 'DOOR_OPENER' };

  it('opens via DOOR_COMMAND=1 and dwells in OPENING until DOOR_STATE arrives', async () => {
    vi.useFakeTimers();
    try {
      const env = makeEnv();
      const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: gchannel.address, service: 'GarageDoorAccessory' });
      garageDoorService.build(ctx).attach(gchannel);
      const service = accessory.services[0]!;
      await getChar(service, 'TargetDoorState').onSetHandler!(0); // OPEN
      expect(env.setValueMock).toHaveBeenCalledWith(gchannel.address, 'DOOR_COMMAND', 1);
      expect(getChar(service, 'CurrentDoorState').value).toBe(2); // OPENING

      env.fireEvent(gchannel.address, 'DOOR_STATE', 1); // CCU reports OPEN
      expect(getChar(service, 'CurrentDoorState').value).toBe(0); // HAP OPEN
      expect(getChar(service, 'TargetDoorState').value).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes via DOOR_COMMAND=3 and a stuck door surfaces as STOPPED after travelSeconds', async () => {
    vi.useFakeTimers();
    try {
      const env = makeEnv();
      const { ctx, accessory } = buildCtx(env, {
        kind: 'channel', id: gchannel.address, service: 'GarageDoorAccessory',
        settings: { travelSeconds: 5 },
      });
      garageDoorService.build(ctx).attach(gchannel);
      const service = accessory.services[0]!;
      await getChar(service, 'TargetDoorState').onSetHandler!(1); // CLOSE
      expect(env.setValueMock).toHaveBeenCalledWith(gchannel.address, 'DOOR_COMMAND', 3);
      expect(getChar(service, 'CurrentDoorState').value).toBe(3); // CLOSING

      vi.advanceTimersByTime(5000);
      expect(getChar(service, 'CurrentDoorState').value).toBe(4); // STOPPED
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps CCU DOOR_STATE values: 0=closed, 1=open, 2=ventilation, 3=ignored', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: gchannel.address, service: 'GarageDoorAccessory' });
    garageDoorService.build(ctx).attach(gchannel);
    const service = accessory.services[0]!;

    env.fireEvent(gchannel.address, 'DOOR_STATE', 0);
    expect(getChar(service, 'CurrentDoorState').value).toBe(1); // CLOSED
    env.fireEvent(gchannel.address, 'DOOR_STATE', 2); // ventilation
    expect(getChar(service, 'CurrentDoorState').value).toBe(0); // OPEN

    // Unknown / 3 leaves the previous state.
    env.fireEvent(gchannel.address, 'DOOR_STATE', 3);
    expect(getChar(service, 'CurrentDoorState').value).toBe(0);
  });
});

describe('Battery mixin', () => {
  const bchannel: CcuChannel = { address: 'HmIP.000BAT:2', name: 'Sensor', index: 2, type: 'TEMPERATURE_SENSOR' };

  it('temperature accessory exposes a Battery service driven by LOW_BAT on the device :0 channel', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: bchannel.address, service: 'TemperatureAccessory' });
    temperatureService.build(ctx).attach(bchannel);
    const battery = accessory.services.find((s) => s.subtype === 'battery');
    expect(battery).toBeDefined();
    env.fireEvent('HmIP.000BAT:0', 'LOW_BAT', true);
    expect(getChar(battery!, 'StatusLowBattery').value).toBe(1);
    env.fireEvent('HmIP.000BAT:0', 'LOW_BAT', false);
    expect(getChar(battery!, 'StatusLowBattery').value).toBe(0);
  });

  it('also accepts the legacy LOWBAT spelling', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: bchannel.address, service: 'TemperatureAccessory' });
    temperatureService.build(ctx).attach(bchannel);
    const battery = accessory.services.find((s) => s.subtype === 'battery')!;
    env.fireEvent('HmIP.000BAT:0', 'LOWBAT', true);
    expect(getChar(battery, 'StatusLowBattery').value).toBe(1);
  });

  it('StatusLowBattery onGet returns LOW after a LOW_BAT=true event', async () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: bchannel.address, service: 'TemperatureAccessory' });
    temperatureService.build(ctx).attach(bchannel);
    const battery = accessory.services.find((s) => s.subtype === 'battery')!;
    env.fireEvent('HmIP.000BAT:0', 'LOW_BAT', true);
    expect(await getChar(battery, 'StatusLowBattery').onGetHandler!()).toBe(1);
  });

  it('OPERATING_VOLTAGE maps to a 0..100 % BatteryLevel and ignores junk', () => {
    const env = makeEnv();
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: bchannel.address, service: 'TemperatureAccessory' });
    temperatureService.build(ctx).attach(bchannel);
    const battery = accessory.services.find((s) => s.subtype === 'battery')!;
    env.fireEvent('HmIP.000BAT:0', 'OPERATING_VOLTAGE', 3.2);
    expect(getChar(battery, 'BatteryLevel').value).toBe(100);
    env.fireEvent('HmIP.000BAT:0', 'OPERATING_VOLTAGE', 2.4);
    expect(getChar(battery, 'BatteryLevel').value).toBe(0);
    env.fireEvent('HmIP.000BAT:0', 'OPERATING_VOLTAGE', '2.8');
    expect(getChar(battery, 'BatteryLevel').value).toBe(50);
    env.fireEvent('HmIP.000BAT:0', 'OPERATING_VOLTAGE', 'NaN');
    expect(getChar(battery, 'BatteryLevel').value).toBe(50); // unchanged
  });

  it('addresses without a colon suffix derive :0 from the bare address', () => {
    const env = makeEnv();
    const flat: CcuChannel = { address: 'HmIP.flat', name: 'F', index: 0, type: 'TEMPERATURE_SENSOR' };
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: flat.address, service: 'TemperatureAccessory' });
    temperatureService.build(ctx).attach(flat);
    const battery = accessory.services.find((s) => s.subtype === 'battery')!;
    env.fireEvent('HmIP.flat:0', 'LOW_BAT', true);
    expect(getChar(battery, 'StatusLowBattery').value).toBe(1);
  });
});

describe('WeatherStation initial pull', () => {
  it('seeds temperature / humidity / illumination from getValue at attach time', async () => {
    const env = makeEnv();
    env.getValueMock.mockImplementation(async (_addr, dp) => {
      if (dp === 'TEMPERATURE')  return 18.2;
      if (dp === 'HUMIDITY')     return 71;
      if (dp === 'ILLUMINATION') return 4500;
      if (dp === 'RAINING')      return true;
      return undefined;
    });
    const wchannel: CcuChannel = { address: 'HmIP.000WTH:1', name: 'Garden', index: 1, type: 'WEATHER_TRANSMIT' };
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: wchannel.address, service: 'WeatherStationAccessory' });
    weatherStationService.build(ctx).attach(wchannel);
    // Let the initial-pull promise chain settle.
    await Promise.resolve(); await Promise.resolve();
    const tempSvc  = accessory.services.find((s) => s.subtype === 'weather-temp')!;
    const humSvc   = accessory.services.find((s) => s.subtype === 'weather-hum')!;
    const lightSvc = accessory.services.find((s) => s.subtype === 'weather-light')!;
    const rainSvc  = accessory.services.find((s) => s.subtype === 'weather-rain')!;
    expect(getChar(tempSvc,  'CurrentTemperature').value).toBe(18.2);
    expect(getChar(humSvc,   'CurrentRelativeHumidity').value).toBe(71);
    expect(getChar(lightSvc, 'CurrentAmbientLightLevel').value).toBe(4500);
    expect(getChar(rainSvc,  'LeakDetected').value).toBe(1);
  });
});

/** Drain the microtask queue so initial-pull then-chains resolve. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('GarageDoor initial pull', () => {
  it('seeds CurrentDoorState from DOOR_STATE at attach time (open)', async () => {
    const env = makeEnv();
    env.getValueMock.mockImplementation(async (_addr, dp) => dp === 'DOOR_STATE' ? 1 : undefined);
    const gchannel: CcuChannel = { address: 'HmIP.000GRG:1', name: 'Garage', index: 1, type: 'DOOR_OPENER' };
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: gchannel.address, service: 'GarageDoorAccessory' });
    garageDoorService.build(ctx).attach(gchannel);
    await flush();
    const service = accessory.services[0]!;
    expect(getChar(service, 'CurrentDoorState').value).toBe(0); // OPEN
    expect(getChar(service, 'TargetDoorState').value).toBe(0);
  });

  it('seeds CurrentDoorState from DOOR_STATE at attach time (closed)', async () => {
    const env = makeEnv();
    env.getValueMock.mockImplementation(async (_addr, dp) => dp === 'DOOR_STATE' ? 0 : undefined);
    const gchannel: CcuChannel = { address: 'HmIP.000GRG:1', name: 'Garage', index: 1, type: 'DOOR_OPENER' };
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: gchannel.address, service: 'GarageDoorAccessory' });
    garageDoorService.build(ctx).attach(gchannel);
    await flush();
    const service = accessory.services[0]!;
    expect(getChar(service, 'CurrentDoorState').value).toBe(1); // CLOSED
    expect(getChar(service, 'TargetDoorState').value).toBe(1);
  });

  it('initial pull ignores garbage DOOR_STATE', async () => {
    const env = makeEnv();
    env.getValueMock.mockImplementation(async (_addr, dp) => dp === 'DOOR_STATE' ? 'nope' : undefined);
    const gchannel: CcuChannel = { address: 'HmIP.000GRG:1', name: 'Garage', index: 1, type: 'DOOR_OPENER' };
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: gchannel.address, service: 'GarageDoorAccessory' });
    garageDoorService.build(ctx).attach(gchannel);
    await flush();
    const service = accessory.services[0]!;
    // Stays at the constructor default; updateCharacteristic was never called.
    expect(getChar(service, 'CurrentDoorState').value).toBeUndefined();
  });
});

describe('WeatherStation initial pull (microtask-flushed)', () => {
  it('seeds Temperature / Humidity / Light / Rain', async () => {
    const env = makeEnv();
    env.getValueMock.mockImplementation(async (_addr, dp) => {
      if (dp === 'TEMPERATURE')  return 19.1;
      if (dp === 'HUMIDITY')     return 55;
      if (dp === 'ILLUMINATION') return 800;
      if (dp === 'RAINING')      return false;
      return undefined;
    });
    const wchannel: CcuChannel = { address: 'HmIP.000WTH:1', name: 'Garden', index: 1, type: 'WEATHER_TRANSMIT' };
    const { ctx, accessory } = buildCtx(env, { kind: 'channel', id: wchannel.address, service: 'WeatherStationAccessory' });
    weatherStationService.build(ctx).attach(wchannel);
    await flush();
    const tempSvc  = accessory.services.find((s) => s.subtype === 'weather-temp')!;
    const humSvc   = accessory.services.find((s) => s.subtype === 'weather-hum')!;
    const lightSvc = accessory.services.find((s) => s.subtype === 'weather-light')!;
    expect(getChar(tempSvc,  'CurrentTemperature').value).toBe(19.1);
    expect(getChar(humSvc,   'CurrentRelativeHumidity').value).toBe(55);
    expect(getChar(lightSvc, 'CurrentAmbientLightLevel').value).toBe(800);
  });
});
