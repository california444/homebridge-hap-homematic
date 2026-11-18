import { describe, it, expect } from 'vitest';
import { buildAddress, deviceAddress, parseAddress } from '../../src/util/address.js';

describe('parseAddress', () => {
  it('parses full datapoint address', () => {
    const p = parseAddress('HmIP.000123ABCDEF:1.STATE');
    expect(p).toEqual({
      interface: 'HmIP',
      serial: '000123ABCDEF',
      channel: 1,
      datapoint: 'STATE',
    });
  });

  it('parses channel-only address', () => {
    const p = parseAddress('HmIP.000123:5');
    expect(p.datapoint).toBeUndefined();
    expect(p.channel).toBe(5);
  });

  it('parses device-only address', () => {
    const p = parseAddress('HmIP.000123');
    expect(p.channel).toBeUndefined();
  });

  it('rejects empty / oversized', () => {
    expect(() => parseAddress('')).toThrow();
    expect(() => parseAddress('a'.repeat(300))).toThrow();
  });

  it('rejects bad interface, serial, datapoint', () => {
    expect(() => parseAddress('Bad!.000123:1.STATE')).toThrow();
    expect(() => parseAddress('HmIP.bad!serial:1.STATE')).toThrow();
    expect(() => parseAddress('HmIP.000123:1.bad-name')).toThrow();
    expect(() => parseAddress('HmIP.000123:bad')).toThrow();
  });
});

describe('buildAddress', () => {
  it('builds address from parts', () => {
    expect(
      buildAddress({ interface: 'HmIP', serial: '000123', channel: 1, datapoint: 'STATE' }),
    ).toBe('HmIP.000123:1.STATE');
    expect(buildAddress({ interface: 'HmIP', serial: '000123' })).toBe('HmIP.000123');
  });

  it('rejects datapoint without channel', () => {
    expect(() =>
      buildAddress({ interface: 'HmIP', serial: '000123', datapoint: 'STATE' }),
    ).toThrow();
  });

  it('rejects missing interface or serial', () => {
    expect(() => buildAddress({ interface: 'HmIP' } as never)).toThrow();
  });
});

describe('deviceAddress', () => {
  it('returns device part of channel address', () => {
    expect(deviceAddress('HmIP.000123:1')).toBe('HmIP.000123');
    expect(deviceAddress('BidCos-RF.OEQ001:2.STATE')).toBe('BidCos-RF.OEQ001');
  });
});
