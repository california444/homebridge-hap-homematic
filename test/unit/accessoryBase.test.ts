// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { describe, it, expect, vi } from 'vitest';
import { AccessoryBase } from '../../src/services/AccessoryBase.js';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import {
  asPlatformAccessory,
  makeAccessory,
  makeHapStub,
  makeLog,
  makeServiceStub,
} from '../helpers/hapStub.js';
import type { AccessoryContext } from '../../src/types.js';
import type { ServiceContext } from '../../src/services/types.js';

class TestService extends AccessoryBase {
  exposeListenerHelpers() {
    return {
      register: this.registerListener.bind(this),
      get: this.getOrAddService.bind(this),
      wrapGet: this.wrapGet.bind(this),
      wrapSet: this.wrapSet.bind(this),
    };
  }
}

function build() {
  const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1', eventServer: { callbackHost: '127.0.0.1' } });
  const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'a') });
  const hap = makeHapStub();
  const accessory = makeAccessory<AccessoryContext>('uuid', 'X', { kind: 'channel', id: 'X', service: 'k' });
  const ctx: ServiceContext = {
    accessory: asPlatformAccessory(accessory),
    ccu,
    log: new PrefixedLogger(makeLog(), 'svc'),
    Service: hap.Service,
    Characteristic: hap.Characteristic,
  };
  const svc = new TestService(ctx);
  return { svc, helpers: svc.exposeListenerHelpers(), ccu, accessory, hap };
}

describe('AccessoryBase', () => {
  it('getOrAddService reuses existing service', () => {
    const { helpers, hap, accessory } = build();
    const existing = makeServiceStub('srv:Switch', 'X');
    accessory.services.push(existing);
    const out = helpers.get(hap.Service.Switch as unknown as Parameters<typeof helpers.get>[0]);
    expect(out).toBe(existing);
  });

  it('getOrAddService updates Name when reused', () => {
    const { helpers, hap, accessory } = build();
    const existing = makeServiceStub('srv:Switch', 'X');
    accessory.services.push(existing);
    helpers.get(hap.Service.Switch as unknown as Parameters<typeof helpers.get>[0], 'NewName');
    expect(existing.setCharacteristic).toHaveBeenCalled();
  });

  it('getOrAddService creates with subtype', () => {
    const { helpers, hap, accessory } = build();
    helpers.get(hap.Service.Switch as unknown as Parameters<typeof helpers.get>[0], 'X', 'sub');
    expect(accessory.services).toHaveLength(1);
    expect((accessory.services[0] as unknown as { subtype: string }).subtype).toBe('sub');
  });

  it('registerListener tracks disposers', () => {
    const { helpers, ccu } = build();
    const off = helpers.register('A.0:1', 'STATE', () => undefined);
    expect(typeof off).toBe('function');
    // The CcuClient should have it
    expect((ccu as unknown as { datapointListeners: Map<string, Set<unknown>> }).datapointListeners.has('A.0:1.STATE')).toBe(true);
  });

  it('dispose cleans up registered listeners', () => {
    const { svc, helpers, ccu } = build();
    helpers.register('A.0:1', 'STATE', () => undefined);
    svc.dispose();
    expect((ccu as unknown as { datapointListeners: Map<string, Set<unknown>> }).datapointListeners.size).toBe(0);
  });

  it('wrapSet rethrows after logging', async () => {
    const { helpers } = build();
    const wrapped = helpers.wrapSet(async () => { throw new Error('fail'); });
    await expect(wrapped(true as unknown as never)).rejects.toThrow(/fail/);
  });

  it('wrapGet rethrows after logging cache miss', async () => {
    const { helpers } = build();
    const wrapped = helpers.wrapGet(() => { throw new Error('miss'); });
    await expect(wrapped()).rejects.toThrow(/miss/);
  });

  it('wrapSet succeeds for normal handlers', async () => {
    const { helpers } = build();
    let captured: unknown;
    const wrapped = helpers.wrapSet(async (v) => { captured = v; });
    await wrapped(true as unknown as never);
    expect(captured).toBe(true);
  });

  it('wrapGet returns the handler value', async () => {
    const { helpers } = build();
    const wrapped = helpers.wrapGet(() => 42 as unknown as never);
    expect(await wrapped()).toBe(42);
  });

  it('dispose tolerates listener that throws on cleanup', () => {
    const { svc, ccu } = build();
    // Inject a disposer that throws
    (svc as unknown as { disposers: Array<() => void> }).disposers.push(() => { throw new Error('x'); });
    expect(() => svc.dispose()).not.toThrow();
    expect((ccu as unknown as { datapointListeners: Map<string, Set<unknown>> }).datapointListeners.size).toBe(0);
  });
});
