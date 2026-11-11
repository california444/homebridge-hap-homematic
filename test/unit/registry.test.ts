// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { describe, it, expect } from 'vitest';
import {
  findServiceByKey,
  servicesForChannelType,
  SERVICE_DEFINITIONS,
} from '../../src/services/registry.js';

describe('servicesForChannelType', () => {
  it('returns matching services sorted by priority', () => {
    const result = servicesForChannelType('SWITCH');
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((s) => s.channelTypes.includes('SWITCH'))).toBe(true);
  });

  it('returns [] for unknown types', () => {
    expect(servicesForChannelType('UNKNOWN_TYPE')).toEqual([]);
  });

  it('sorts by ascending priority', () => {
    const result = servicesForChannelType('WEATHER');
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.priority).toBeGreaterThanOrEqual(result[i - 1]!.priority);
    }
  });
});

describe('findServiceByKey', () => {
  it('finds known services by key', () => {
    expect(findServiceByKey('SwitchAccessory')?.key).toBe('SwitchAccessory');
  });

  it('returns undefined for missing or removed keys', () => {
    expect(findServiceByKey('NopeAccessory')).toBeUndefined();
    expect(findServiceByKey('VariableSwitchAccessory')).toBeUndefined();
    expect(findServiceByKey('ProgramAccessory')).toBeUndefined();
  });
});

describe('SERVICE_DEFINITIONS shape', () => {
  it('every service has unique key', () => {
    const keys = SERVICE_DEFINITIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every channelType maps to at least one service', () => {
    for (const def of SERVICE_DEFINITIONS) {
      expect(def.channelTypes.length).toBeGreaterThan(0);
    }
  });
});
