// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
// Taken from upstream commit 2011787 (2026-11-11); see NOTICE.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { asPlatformAccessory, makeAccessory, makeHapStub, makeLog } from '../helpers/hapStub.js';
import type { CcuChannel } from '../../src/types.js';
import type { ServiceContext } from '../../src/services/types.js';
import { blindService } from '../../src/services/impl/BlindAccessory.js';

const INC = 1;
const DEC = 0;
const STOP = 2;

function setup(type: string, address: string) {
  const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1' });
  const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'blind') });
  const setValue = vi.spyOn(ccu, 'setValue').mockResolvedValue(undefined);
  vi.spyOn(ccu, 'getValue').mockResolvedValue(undefined);
  const fire = (datapoint: string, value: unknown) => {
    (ccu as unknown as { handleEvent(ev: object): void }).handleEvent({
      callbackId: 'c', channelAddress: address, datapoint, value, receivedAt: 0,
    });
  };
  const hap = makeHapStub();
  const mk = (name: string) => {
    class C { static UUID = `char:${name}`; UUID = `char:${name}`; }
    Object.defineProperty(C, 'name', { value: name });
    return C;
  };
  const S = class { static UUID = 'srv:WindowCovering'; UUID = 'srv:WindowCovering'; displayName = ''; subtype: string | undefined; };
  const Characteristic = { ...hap.Characteristic } as Record<string, unknown>;
  for (const n of ['CurrentPosition', 'TargetPosition', 'PositionState', 'Name']) {
    Characteristic[n] = mk(n);
  }
  const accessory = makeAccessory({ kind: 'channel', id: address, service: 'BlindAccessory' });
  const ctx = {
    accessory: asPlatformAccessory(accessory),
    ccu,
    log: new PrefixedLogger(makeLog(), 'blind'),
    Service: { ...hap.Service, WindowCovering: S },
    Characteristic,
  } as unknown as ServiceContext;
  const channel: CcuChannel = { address, name: 'Blind', index: 1, type };
  const handler = blindService.build(ctx);
  handler.attach(channel);
  const svc = accessory.services[0]!;
  const get = (n: string) => svc.characteristics.get(`char:${n}`)!;
  return {
    fire, setValue, handler, get,
    pos: () => get('CurrentPosition').value,
    tgt: () => get('TargetPosition').onGetHandler!() as Promise<unknown>,
    state: () => get('PositionState').value,
    command: (v: number) => get('TargetPosition').onSetHandler!(v),
  };
}

describe('BlindAccessory movement', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('classic BLIND up with WORKING: target stays, every LEVEL is pushed, stops on WORKING=false', async () => {
    const t = setup('BLIND', 'NEQ1:1');
    t.fire('LEVEL', 0);
    await t.command(100);
    expect(t.setValue).toHaveBeenCalledWith('NEQ1:1', 'LEVEL', 1);
    expect(await t.tgt()).toBe(100);
    expect(t.state()).toBe(INC);
    t.fire('WORKING', true);
    for (const l of [0.2, 0.5, 0.8]) {
      t.fire('LEVEL', l);
      expect(t.pos()).toBe(Math.round(l * 100));
      expect(await t.tgt()).toBe(100);
      expect(t.state()).toBe(INC);
    }
    t.fire('LEVEL', 1);
    expect(t.pos()).toBe(100);
    expect(t.state()).toBe(STOP);
    t.fire('WORKING', false);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(100);
  });

  it('classic BLIND down from a wall button: WORKING + DIRECTION, target follows current', async () => {
    const t = setup('BLIND', 'NEQ1:1');
    t.fire('LEVEL', 1);
    t.fire('WORKING', true);
    t.fire('DIRECTION', 2);
    expect(t.state()).toBe(DEC);
    t.fire('LEVEL', 0.6);
    expect(t.state()).toBe(DEC);
    expect(await t.tgt()).toBe(60);
    t.fire('DIRECTION', 0); // ignored
    t.fire('WORKING', false);
    expect(t.state()).toBe(STOP);
    expect(t.pos()).toBe(60);
  });

  it('HmIP ACTIVITY_STATE drives the state and 3 = stable ends it, late LEVEL does not re-arm moving', () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', 'HmIP.A:4');
    t.fire('LEVEL', 0.8);
    t.fire('ACTIVITY_STATE', 2);
    expect(t.state()).toBe(DEC);
    t.fire('LEVEL', 0.5);
    expect(t.state()).toBe(DEC);
    t.fire('ACTIVITY_STATE', 3);
    expect(t.state()).toBe(STOP);
    t.fire('LEVEL', 0.3); // final value arriving after "stable"
    expect(t.pos()).toBe(30);
    expect(t.state()).toBe(STOP);
    t.fire('ACTIVITY_STATE', 1);
    expect(t.state()).toBe(INC);
    t.fire('ACTIVITY_STATE', 0); // unknown ignored
    expect(t.state()).toBe(INC);
    t.fire('ACTIVITY_STATE', 3);
    expect(t.state()).toBe(STOP);
  });

  it('HmIP stop midway after a HomeKit command: target settles on the stop position', async () => {
    const t = setup('SHUTTER_VIRTUAL_RECEIVER', 'HmIP.A:5');
    t.fire('LEVEL', 0);
    await t.command(100);
    t.fire('ACTIVITY_STATE', 1);
    t.fire('LEVEL', 0.4);
    expect(await t.tgt()).toBe(100);
    expect(t.state()).toBe(INC);
    t.fire('ACTIVITY_STATE', 3);
    expect(t.state()).toBe(STOP);
    expect(t.pos()).toBe(40);
    expect(await t.tgt()).toBe(40);
  });

  it('stops after the level stops changing (no explicit stop signal)', async () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', 'HmIP.A:4');
    t.fire('LEVEL', 0.9);
    await t.command(10);
    expect(t.state()).toBe(DEC);
    t.fire('LEVEL', 0.7);
    vi.advanceTimersByTime(4000);
    expect(t.state()).toBe(DEC);
    t.fire('LEVEL', 0.6); // re-arms
    vi.advanceTimersByTime(4000);
    expect(t.state()).toBe(DEC);
    vi.advanceTimersByTime(1500);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(60);
  });

  it('a command to the current position is a no-op move; a command with no CCU response times out', async () => {
    const t = setup('BLIND', 'NEQ1:1');
    t.fire('LEVEL', 0.5);
    await t.command(50);
    expect(t.state()).toBe(STOP);
    await t.command(80);
    expect(t.state()).toBe(INC);
    vi.advanceTimersByTime(5001);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(50);
  });

  it('WORKING=true after a command keeps the commanded direction; failsafe ends a lost stop', async () => {
    const t = setup('BLIND', 'NEQ1:1');
    t.fire('LEVEL', 1);
    await t.command(0);
    t.fire('WORKING', true);
    expect(t.state()).toBe(DEC);
    vi.advanceTimersByTime(60000);
    expect(t.state()).toBe(DEC);
    vi.advanceTimersByTime(61000);
    expect(t.state()).toBe(STOP);
  });

  it('WORKING=true with unknown direction stays STOPPED until a LEVEL shows it; dispose clears the timer', () => {
    const t = setup('BLIND', 'NEQ1:1');
    t.fire('WORKING', true);
    expect(t.state()).toBe(STOP);
    t.fire('LEVEL', 0.3);
    expect(t.state()).toBe(INC);
    t.handler.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
