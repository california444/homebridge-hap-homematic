// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { describe, it, expect } from 'vitest';
import { ConfigError, isValidHost, resolveConfig } from '../../src/util/config.js';

describe('isValidHost', () => {
  it('accepts hostnames, IPv4, IPv6', () => {
    expect(isValidHost('ccu.local')).toBe(true);
    expect(isValidHost('192.168.1.10')).toBe(true);
    expect(isValidHost('fe80::1')).toBe(true);
  });

  it('rejects empty, whitespace, too long, junk', () => {
    expect(isValidHost('')).toBe(false);
    expect(isValidHost(' ')).toBe(false);
    expect(isValidHost('a'.repeat(254))).toBe(false);
    expect(isValidHost(null)).toBe(false);
    expect(isValidHost(123)).toBe(false);
  });
});

describe('resolveConfig', () => {
  const base = { platform: 'HapHomematic', ccuIp: '192.168.1.10' };

  it('fills defaults for everything else', () => {
    const c = resolveConfig(base);
    expect(c.ccuIp).toBe('192.168.1.10');
    expect(c.interfaces).toMatchObject({ bidcosRf: true, hmIpRf: true });
    expect(c.eventServer.port).toBe(9875);
    expect(c.eventServer.watchdogSeconds).toBe(300);
    expect(c.useTls).toBe(false);
    expect(c.ccuAuth.enabled).toBe(false);
  });

  it('rejects empty config', () => {
    expect(() => resolveConfig(null as never)).toThrow(ConfigError);
  });

  it('rejects bad ccuIp', () => {
    expect(() => resolveConfig({ ...base, ccuIp: '' })).toThrow(/ccuIp/);
    expect(() => resolveConfig({ ...base, ccuIp: 'has spaces' })).toThrow(/ccuIp/);
  });

  it('requires username/password when ccuAuth.enabled', () => {
    expect(() => resolveConfig({ ...base, ccuAuth: { enabled: true } })).toThrow(/username/);
    expect(() => resolveConfig({ ...base, ccuAuth: { enabled: true, username: 'u', password: 'p' } })).not.toThrow();
  });

  it('rejects out-of-range event-server port', () => {
    expect(() => resolveConfig({ ...base, eventServer: { port: 80 } })).toThrow(/port/);
    expect(() => resolveConfig({ ...base, eventServer: { port: 70000 } })).toThrow(/port/);
  });

  it('rejects out-of-range watchdog', () => {
    expect(() => resolveConfig({ ...base, eventServer: { watchdogSeconds: 0 } })).toThrow(/watchdog/i);
    expect(() => resolveConfig({ ...base, eventServer: { watchdogSeconds: 999999 } })).toThrow(/watchdog/i);
  });

  it('rejects empty event-server host', () => {
    expect(() => resolveConfig({ ...base, eventServer: { host: '' } })).toThrow(/host/);
  });

  it('coerces non-array channels/variables/programs to []', () => {
    const c = resolveConfig({ ...base, channels: 'not an array' as unknown as never[] });
    expect(c.channels).toEqual([]);
  });

  it('preserves valid arrays', () => {
    const c = resolveConfig({
      ...base,
      channels: [{ address: 'HmIP.0:1', service: 'SwitchAccessory' }],
      variables: [{ name: 'V1' }],
      programs: [{ name: 'P1' }],
    });
    expect(c.channels).toHaveLength(1);
    expect(c.variables).toHaveLength(1);
    expect(c.programs).toHaveLength(1);
  });

  it('uses provided platform name', () => {
    const c = resolveConfig({ ...base, name: 'Custom' });
    expect(c.name).toBe('Custom');
  });

  describe('interfacePorts', () => {
    it('defaults to empty object', () => {
      const c = resolveConfig(base);
      expect(c.interfacePorts).toEqual({});
    });

    it('passes through valid per-interface overrides', () => {
      const c = resolveConfig({
        ...base,
        interfacePorts: { 'BidCos-RF': 2001, 'HmIP-RF': 2010 },
      });
      expect(c.interfacePorts['BidCos-RF']).toBe(2001);
      expect(c.interfacePorts['HmIP-RF']).toBe(2010);
    });

    it('rejects unknown interface names', () => {
      expect(() => resolveConfig({
        ...base,
        interfacePorts: { 'Bogus': 1234 } as never,
      })).toThrow(/unknown interface/);
    });

    it('rejects out-of-range port values', () => {
      expect(() => resolveConfig({
        ...base,
        interfacePorts: { 'BidCos-RF': 0 },
      })).toThrow(/BidCos-RF/);
      expect(() => resolveConfig({
        ...base,
        interfacePorts: { 'BidCos-RF': 70000 },
      })).toThrow(/BidCos-RF/);
    });

    it('rejects non-integer port values', () => {
      expect(() => resolveConfig({
        ...base,
        interfacePorts: { 'BidCos-RF': 'nope' as unknown as number },
      })).toThrow(/BidCos-RF/);
    });

    it('ignores non-object interfacePorts gracefully', () => {
      const c = resolveConfig({ ...base, interfacePorts: null as never });
      expect(c.interfacePorts).toEqual({});
    });
  });
});
