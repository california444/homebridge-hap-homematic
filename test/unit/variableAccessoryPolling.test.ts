// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { resolveConfig } from '../../src/util/config.js';
import {
  asPlatformAccessory,
  makeAccessory,
  makeHapStub,
  makeLog,
} from '../helpers/hapStub.js';
import { variableLightService, variableSwitchService } from '../../src/services/impl/VariableAccessory.js';
import type { AccessoryContext, CcuVariable } from '../../src/types.js';
import type { ServiceContext } from '../../src/services/types.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function build(context: AccessoryContext) {
  const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1' });
  const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'v') });
  const hap = makeHapStub();
  const accessory = makeAccessory<AccessoryContext>('uuid', context.id, context);
  const ctx: ServiceContext = {
    accessory: asPlatformAccessory(accessory),
    ccu,
    log: new PrefixedLogger(makeLog(), 'svc'),
    Service: hap.Service,
    Characteristic: hap.Characteristic,
  };
  return { ccu, ctx, accessory };
}

describe('VariableSwitch poll', () => {
  it('updates the characteristic when CCU value changes', async () => {
    const { ccu, ctx, accessory } = build({ kind: 'variable', id: 'V1', service: 'VariableSwitchAccessory' });
    const variable: CcuVariable = { id: '1', name: 'V1', valuetype: 2, subtype: 0, value: false };
    const handler = variableSwitchService.build(ctx);
    handler.attach(variable);

    const getVar = vi.spyOn(ccu.api, 'getVariable').mockResolvedValue('true');
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(getVar).toHaveBeenCalled();
    handler.dispose?.();
  });

  it('swallows poll errors silently', async () => {
    const { ccu, ctx } = build({ kind: 'variable', id: 'V1', service: 'VariableSwitchAccessory' });
    const handler = variableSwitchService.build(ctx);
    handler.attach({ id: '1', name: 'V1', valuetype: 2, subtype: 0, value: false });
    vi.spyOn(ccu.api, 'getVariable').mockRejectedValue(new Error('boom'));
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();
    handler.dispose?.();
  });
});

describe('VariableLight poll', () => {
  it('updates Brightness when CCU value changes', async () => {
    const { ccu, ctx } = build({ kind: 'variable', id: 'V2', service: 'VariableLightAccessory' });
    const handler = variableLightService.build(ctx);
    handler.attach({ id: '2', name: 'V2', valuetype: 4, subtype: 0, minValue: 0, maxValue: 100, value: 30 });
    const getVar = vi.spyOn(ccu.api, 'getVariable').mockResolvedValue('55');
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(getVar).toHaveBeenCalled();
    handler.dispose?.();
  });

  it('handles non-numeric poll responses', async () => {
    const { ccu, ctx } = build({ kind: 'variable', id: 'V2', service: 'VariableLightAccessory' });
    const handler = variableLightService.build(ctx);
    handler.attach({ id: '2', name: 'V2', valuetype: 4, subtype: 0, value: 30 });
    vi.spyOn(ccu.api, 'getVariable').mockResolvedValue('NaN');
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();
    handler.dispose?.();
  });

  it('swallows poll errors silently', async () => {
    const { ccu, ctx } = build({ kind: 'variable', id: 'V2', service: 'VariableLightAccessory' });
    const handler = variableLightService.build(ctx);
    handler.attach({ id: '2', name: 'V2', valuetype: 4, subtype: 0, value: 30 });
    vi.spyOn(ccu.api, 'getVariable').mockRejectedValue(new Error('nope'));
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();
    handler.dispose?.();
  });
});

describe('Program timer auto-flips off', () => {
  it('updates On to false after 1s', async () => {
    const { ccu, ctx, accessory } = build({ kind: 'program', id: 'P', service: 'ProgramAccessory' });
    vi.spyOn(ccu.api, 'runProgram').mockResolvedValue(undefined);
    const { programService } = await import('../../src/services/impl/ProgramAccessory.js');
    const handler = programService.build(ctx);
    handler.attach('P');
    const service = accessory.services[0]!;
    const onChar = service.characteristics.get('char:On')!;
    await onChar.onSetHandler!(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(onChar.value).toBe(false);
  });
});
