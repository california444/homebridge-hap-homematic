// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { describe, it, expect, vi } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';
import { resolveConfig } from '../../src/util/config.js';
import type { ChannelEvent } from '../../src/ccu/EventServer.js';

function makeCcu(): CcuClient {
  const config = resolveConfig({ platform: 'HapHomematic', ccuIp: '127.0.0.1', eventServer: { callbackHost: '127.0.0.1' } });
  return new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'ccu-test') });
}

describe('CcuClient registerListener / event dispatch', () => {
  it('allows many interfaceState listeners without a MaxListeners warning', () => {
    const ccu = makeCcu();
    const warn = vi.fn();
    process.on('warning', warn);
    try {
      for (let i = 0; i < 50; i++) ccu.on('interfaceState', () => undefined);
      expect(ccu.getMaxListeners()).toBe(0);
      expect(ccu.listenerCount('interfaceState')).toBe(50);
    } finally {
      process.off('warning', warn);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('routes events to all matching listeners', () => {
    const ccu = makeCcu();
    const a = vi.fn();
    const b = vi.fn();
    ccu.registerListener('HmIP.0:1.STATE', a);
    ccu.registerListener('HmIP.0:1.STATE', b);
    const ev: ChannelEvent = {
      callbackId: 'cb',
      channelAddress: 'HmIP.0:1',
      datapoint: 'STATE',
      value: true,
      receivedAt: Date.now(),
    };
    (ccu as unknown as { handleEvent(ev: ChannelEvent): void }).handleEvent(ev);
    expect(a).toHaveBeenCalledWith(true);
    expect(b).toHaveBeenCalledWith(true);
  });

  it('off() removes the listener', () => {
    const ccu = makeCcu();
    const a = vi.fn();
    const off = ccu.registerListener('HmIP.0:1.STATE', a);
    off();
    (ccu as unknown as { handleEvent(ev: ChannelEvent): void }).handleEvent({
      callbackId: 'c', channelAddress: 'HmIP.0:1', datapoint: 'STATE', value: 1, receivedAt: 0,
    });
    expect(a).not.toHaveBeenCalled();
  });

  it('catches listener exceptions without breaking', () => {
    const ccu = makeCcu();
    const a = vi.fn(() => { throw new Error('nope'); });
    const b = vi.fn();
    ccu.registerListener('HmIP.0:1.STATE', a);
    ccu.registerListener('HmIP.0:1.STATE', b);
    expect(() => (ccu as unknown as { handleEvent(ev: ChannelEvent): void }).handleEvent({
      callbackId: 'c', channelAddress: 'HmIP.0:1', datapoint: 'STATE', value: 1, receivedAt: 0,
    })).not.toThrow();
    expect(b).toHaveBeenCalled();
  });

  it('drops unrouted events silently', () => {
    const ccu = makeCcu();
    expect(() => (ccu as unknown as { handleEvent(ev: ChannelEvent): void }).handleEvent({
      callbackId: 'c', channelAddress: 'HmIP.X:9', datapoint: 'STATE', value: 1, receivedAt: 0,
    })).not.toThrow();
  });

  it('guesses the interface from the serial shape before discovery', () => {
    const ccu = makeCcu();
    const intfFor = (ccu as unknown as { interfaceForAddress(a: string): string }).interfaceForAddress.bind(ccu);
    expect(intfFor('00000000000A01:6')).toBe('HmIP-RF');
    expect(intfFor('ABC0000002:1')).toBe('BidCos-RF');
    expect(intfFor('weird')).toBe('BidCos-RF');
  });

  it('isLive returns false with no subscribed clients', () => {
    const ccu = makeCcu();
    expect(ccu.isLive()).toBe(false);
  });
});
