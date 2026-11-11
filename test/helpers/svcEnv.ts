/**
 * Test environment for service handlers: a CcuClient with stubbed
 * setValue / readValues, event injection, and a ServiceContext with the
 * HAP stub, HapStatusError and a persist spy.
 */

import { vi, type Mock } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import type { AccessoryContext, CcuChannel, CcuDevice } from '../../src/types.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../../src/services/types.js';
import { asPlatformAccessory, makeAccessory, makeHapStub, makeLog, type CharacteristicStub, type ServiceStub } from './hapStub.js';

export interface SvcEnv {
  ccu: CcuClient;
  setValue: Mock;
  readValues: Mock;
  log: PrefixedLogger;
  hap: ReturnType<typeof makeHapStub>;
  /** Start values by channel address. */
  values: Record<string, Record<string, unknown>>;
  fire(address: string, datapoint: string, value: unknown, callbackId?: string): void;
}

export function makeSvcEnv(): SvcEnv {
  const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1', eventServer: { callbackHost: '127.0.0.1' } });
  const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'env') });
  const env = {
    ccu,
    values: {} as Record<string, Record<string, unknown>>,
    hap: makeHapStub(),
    log: new PrefixedLogger(makeLog(), 'svc'),
  } as SvcEnv;
  env.setValue = vi.spyOn(ccu, 'setValue').mockResolvedValue(undefined) as unknown as Mock;
  env.readValues = vi.spyOn(ccu, 'readValues').mockImplementation(async (a: string) => env.values[a]) as unknown as Mock;
  env.fire = (address, datapoint, value, callbackId = 'c') => {
    (ccu as unknown as { handleEvent(ev: object): void }).handleEvent({
      callbackId, channelAddress: address, datapoint, value, receivedAt: Date.now(),
    });
  };
  return env;
}

export function build(
  env: SvcEnv,
  def: ServiceDefinition,
  channel: CcuChannel,
  context: Partial<AccessoryContext> = {},
  device?: CcuDevice,
  opts: { withHap?: boolean } = {},
) {
  const accessory = makeAccessory<AccessoryContext>('uuid', context.name ?? 'Acc', {
    kind: 'channel', id: channel.address, service: def.key, ...context,
  } as AccessoryContext);
  const persist = vi.fn();
  const ctx: ServiceContext = {
    accessory: asPlatformAccessory(accessory),
    ccu: env.ccu,
    log: env.log,
    Service: env.hap.Service,
    Characteristic: env.hap.Characteristic,
    ...(opts.withHap === false ? {} : { hap: { HapStatusError: env.hap.HapStatusError, HAPStatus: env.hap.HAPStatus } }),
    persist,
  };
  const handler = def.build(ctx) as ChannelService & { refresh(): Promise<void>; dispose(): void };
  handler.attach(channel, device);
  const svc = (uuidOrSubtype: string): ServiceStub => {
    const s = accessory.services.find((x) => x.UUID === `srv:${uuidOrSubtype}` || x.subtype === uuidOrSubtype);
    if (!s) throw new Error(`no service ${uuidOrSubtype}`);
    return s;
  };
  const char = (s: ServiceStub, name: string): CharacteristicStub => {
    const c = s.characteristics.get(`char:${name}`);
    if (!c) throw new Error(`no characteristic ${name}`);
    return c;
  };
  return { accessory, handler, persist, svc, char };
}

/** HapStatusError thrown by unknown() in the stub. */
export const NO_RESPONSE = { hapStatus: -70402 };
