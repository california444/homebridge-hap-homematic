// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { describe, it, expect } from 'vitest';
import { ConfigError, isValidHost, resolveConfig } from '../../src/util/config.js';
import type { RawConfig } from '../../src/types.js';

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
  const base: RawConfig = { platform: 'HapHomematic', ccuIp: '192.168.1.10', eventServer: { callbackHost: '192.168.1.20' } };
  const ev = (e: Record<string, unknown>): RawConfig => ({ ...base, eventServer: { callbackHost: '192.168.1.20', ...e } });

  it('fills defaults for everything else', () => {
    const c = resolveConfig(base);
    expect(c.ccuIp).toBe('192.168.1.10');
    expect(c.interfaces).toEqual({ bidcosRf: true, hmIpRf: true });
    expect(c.eventServer).toEqual({ host: '0.0.0.0', callbackHost: '192.168.1.20', port: 9875 });
    expect(c.useTls).toBe(false);
    expect(c.rpcAuth).toEqual({ enabled: false });
    expect(c).not.toHaveProperty('ccuAuth');
    expect(c).not.toHaveProperty('channels');
  });

  it('rejects empty config', () => {
    expect(() => resolveConfig(null as never)).toThrow(ConfigError);
  });

  it('rejects bad ccuIp', () => {
    expect(() => resolveConfig({ ...base, ccuIp: '' })).toThrow(/ccuIp/);
    expect(() => resolveConfig({ ...base, ccuIp: 'has spaces' })).toThrow(/ccuIp/);
  });

  describe('eventServer.callbackHost', () => {
    it('is required by default', () => {
      expect(() => resolveConfig({ platform: 'HapHomematic', ccuIp: '192.168.1.10' })).toThrow(/callbackHost is required/);
      expect(() => resolveConfig(ev({ callbackHost: '' }))).toThrow(/callbackHost is required/);
    });

    it('may be omitted for the UI (probe / discover only)', () => {
      const c = resolveConfig({ platform: 'HapHomematic', ccuIp: '192.168.1.10' }, { requireCallbackHost: false });
      expect(c.eventServer.callbackHost).toBe('');
    });

    it('must be a valid host', () => {
      expect(() => resolveConfig(ev({ callbackHost: 'not valid' }))).toThrow(/callbackHost must be/);
      expect(() => resolveConfig(ev({ callbackHost: 'not valid' }), { requireCallbackHost: false })).toThrow(/callbackHost must be/);
    });
  });

  describe('rpcAuth', () => {
    it('requires username and password when enabled', () => {
      expect(() => resolveConfig({ ...base, rpcAuth: { enabled: true } })).toThrow(/rpcAuth/);
      expect(() => resolveConfig({ ...base, rpcAuth: { enabled: true, username: 'u' } })).toThrow(/rpcAuth/);
    });

    it('passes credentials through', () => {
      const c = resolveConfig({ ...base, rpcAuth: { enabled: true, username: 'u', password: 'p' } });
      expect(c.rpcAuth).toEqual({ enabled: true, username: 'u', password: 'p' });
    });

    it('keeps stored credentials while disabled and ignores non-strings', () => {
      expect(resolveConfig({ ...base, rpcAuth: { username: 'u', password: 'p' } }).rpcAuth)
        .toEqual({ enabled: false, username: 'u', password: 'p' });
      expect(resolveConfig({ ...base, rpcAuth: { username: 1 as never } }).rpcAuth).toEqual({ enabled: false });
    });
  });

  it('keeps only BidCos-RF / HmIP-RF interface toggles', () => {
    const c = resolveConfig({ ...base, interfaces: { hmIpRf: false, cuxd: true } as never });
    expect(c.interfaces).toEqual({ bidcosRf: true, hmIpRf: false });
  });

  it('rejects out-of-range event-server port', () => {
    expect(() => resolveConfig(ev({ port: 80 }))).toThrow(/port/);
    expect(() => resolveConfig(ev({ port: 70000 }))).toThrow(/port/);
  });

  it('ignores the upstream watchdogSeconds (replaced by ping/PONG per interface)', () => {
    const c = resolveConfig(ev({ watchdogSeconds: 0 }));
    expect(c.eventServer).not.toHaveProperty('watchdogSeconds');
  });

  it('rejects empty event-server host', () => {
    expect(() => resolveConfig(ev({ host: '' }))).toThrow(/host/);
  });

  it('ignores old "channels" (mappings live in devices.json)', () => {
    const c = resolveConfig({ ...base, channels: [{ address: '0:1', service: 'SwitchAccessory' }] } as RawConfig);
    expect(c).not.toHaveProperty('channels');
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

    it('treats cleared UI fields (null / "") as "use the default"', () => {
      const c = resolveConfig({ ...base, interfacePorts: { 'BidCos-RF': null, 'HmIP-RF': '' } as never });
      expect(c.interfacePorts).toEqual({});
    });

    it('rejects unknown interface names', () => {
      expect(() => resolveConfig({
        ...base,
        interfacePorts: { 'Bogus': 1234 } as never,
      })).toThrow(/unknown interface/);
      expect(() => resolveConfig({
        ...base,
        interfacePorts: { 'CUxD': 8701 } as never,
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
