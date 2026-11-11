import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  emptyDevicesFile,
  loadDevicesFile,
  mappingUuidSeed,
  parseDeviceKey,
  saveDevicesFile,
  toMappings,
  validateDevicesFile,
} from '../../src/util/devices.js';
import { PluginStorage } from '../../src/util/storage.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';
import type { DevicesFile } from '../../src/types.js';

const KNOWN = new Set(['SwitchAccessory', 'BlindAccessory', 'IrrigationAccessory']);

/** The example from plan section 5.2 (with made-up serials). */
const EXAMPLE = {
  version: 1,
  devices: {
    'BidCos-RF:ABC0000002': {
      enabled: true, service: 'IrrigationAccessory',
      channels: {
        '1': { name: 'Rasen vorne', valveType: 'Irrigation' },
        '2': { name: 'Rasen hinten' }, '3': { name: 'Hochbeet' }, '4': { name: 'Tropfschlauch' },
      },
    },
    'HmIP-RF:00000000000A01': {
      enabled: true, mode: 'perChannel',
      channels: { '6': { service: 'SwitchAccessory', variant: 'Lightbulb', name: 'WZ1' } },
    },
    'HmIP-RF:00000000000A02': {
      enabled: true, service: 'BlindAccessory', options: { invert: true },
    },
  },
};

const errorsOf = (raw: unknown, known: ReadonlySet<string> | undefined = KNOWN): string[] => {
  const r = validateDevicesFile(raw, known);
  return r.ok ? [] : r.errors;
};

describe('validateDevicesFile', () => {
  it('accepts the plan 5.2 example', () => {
    expect(validateDevicesFile(EXAMPLE, KNOWN)).toEqual({ ok: true, file: EXAMPLE });
    expect(validateDevicesFile(emptyDevicesFile()).ok).toBe(true);
  });

  it('checks the root', () => {
    expect(errorsOf(null)).toEqual(['(root): must be an object']);
    expect(errorsOf([])).toEqual(['(root): must be an object']);
    expect(errorsOf({ version: 2, devices: {}, extra: 1 })).toEqual(['extra: unknown key', 'version: must be 1']);
    expect(errorsOf({ version: 1, devices: [] })).toEqual(['devices: must be an object']);
  });

  it('caps the number of devices', () => {
    const devices: Record<string, unknown> = {};
    for (let i = 0; i < 501; i++) devices[`BidCos-RF:ABC${String(i).padStart(7, '0')}`] = { service: 'SwitchAccessory' };
    expect(errorsOf({ version: 1, devices })).toContain('devices: at most 500 entries');
  });

  it('checks device keys and entries', () => {
    expect(errorsOf({ version: 1, devices: {
      'ABC0000002': {},
      'CUxD:ABC0000002': {},
      'BidCos-RF:ABC 2': {},
      'BidCos-RF:ABC0000002': 'x',
    } })).toEqual([
      'devices["ABC0000002"]: key must be "<BidCos-RF|HmIP-RF>:<serial>"',
      'devices["CUxD:ABC0000002"]: key must be "<BidCos-RF|HmIP-RF>:<serial>"',
      'devices["BidCos-RF:ABC 2"]: key must be "<BidCos-RF|HmIP-RF>:<serial>"',
      'devices["BidCos-RF:ABC0000002"]: must be an object',
    ]);
  });

  it('checks device fields', () => {
    const errs = errorsOf({ version: 1, devices: { 'BidCos-RF:ABC0000002': {
      service: 'SwitchAccessory', enabled: 'yes', mode: 'other', variant: '', name: ' ', options: [], bridge: 1,
    } } });
    const p = 'devices["BidCos-RF:ABC0000002"]';
    expect(errs).toEqual([
      `${p}.bridge: unknown key`,
      `${p}.enabled: must be true or false`,
      `${p}.variant: must be a non-empty string`,
      `${p}.name: must be a non-empty string of at most 64 characters`,
      `${p}.options: must be an object`,
      `${p}.mode: must be "device" or "perChannel"`,
    ]);
  });

  it('checks services: format, registry, mode rules', () => {
    const p = (k: string) => `devices["${k}"]`;
    expect(errorsOf({ version: 1, devices: {
      'BidCos-RF:A1': { mode: 'device' },
      'BidCos-RF:A2': { service: 'no-such' },
      'BidCos-RF:A3': { service: 'NopeAccessory' },
      'BidCos-RF:A4': { mode: 'perChannel', service: 'SwitchAccessory', channels: { '1': { service: 'SwitchAccessory' } } },
      'BidCos-RF:A5': { mode: 'perChannel' },
      'BidCos-RF:A6': { channels: { '1': {} } },
      'BidCos-RF:A7': { service: 'SwitchAccessory', channels: { '1': { service: 'SwitchAccessory' } } },
    } })).toEqual([
      `${p('BidCos-RF:A1')}.service: must be a service key such as "SwitchAccessory"`,
      `${p('BidCos-RF:A2')}.service: must be a service key such as "SwitchAccessory"`,
      `${p('BidCos-RF:A3')}.service: unknown service "NopeAccessory"`,
      `${p('BidCos-RF:A4')}.service: not allowed with mode "perChannel" (set it per channel)`,
      `${p('BidCos-RF:A5')}.channels: perChannel mapping without channels`,
      `${p('BidCos-RF:A6')}.channels["1"].service: must be a service key such as "SwitchAccessory"`,
      `${p('BidCos-RF:A7')}.channels["1"].service: not allowed in a device mapping`,
    ]);
    // without a registry, any well-formed key passes
    expect(validateDevicesFile({ version: 1, devices: { 'BidCos-RF:A3': { service: 'NopeAccessory' } } }).ok).toBe(true);
  });

  it('whole-device services must not be mapped per channel', () => {
    const dev = new Set(['IrrigationAccessory']);
    const r = validateDevicesFile({ version: 1, devices: {
      'BidCos-RF:A1': { channels: { '1': { service: 'IrrigationAccessory' } } },
      'BidCos-RF:A2': { service: 'IrrigationAccessory' },
    } }, KNOWN, dev);
    expect(r).toEqual({ ok: false, errors: [
      'devices["BidCos-RF:A1"].channels["1"].service: "IrrigationAccessory" maps a whole device; use "service" on the device entry',
    ] });
  });

  it('allows disabled perChannel devices without channels and disabled channels without service', () => {
    expect(errorsOf({ version: 1, devices: {
      'BidCos-RF:A1': { mode: 'perChannel', enabled: false },
      'BidCos-RF:A2': { channels: { '1': { enabled: false }, '2': { service: 'SwitchAccessory' } } },
    } })).toEqual([]);
  });

  it('checks channels and extra settings', () => {
    const p = 'devices["BidCos-RF:A1"]';
    // (JS orders integer-like keys first, so compare sorted)
    expect(errorsOf({ version: 1, devices: {
      'BidCos-RF:A1': { service: 'IrrigationAccessory', channels: {
        'x': {}, '01': {}, '1000': {}, '1': 'y',
        '2': { name: 'ok', valveType: 'Irrigation', durationDefault: 600, on: true },
        '3': { 'bad-key': 1 },
        '4': { nested: { a: 1 } },
        '5': { name: 'x'.repeat(65) },
      } },
      'BidCos-RF:A2': { service: 'IrrigationAccessory', channels: [] },
    } }).sort()).toEqual([
      `${p}.channels["1"]: must be an object`,
      `${p}.channels["x"]: key must be a channel number`,
      `${p}.channels["01"]: key must be a channel number`,
      `${p}.channels["1000"]: key must be a channel number`,
      `${p}.channels["3"].bad-key: invalid key`,
      `${p}.channels["4"].nested: extra settings must be a string, number or boolean`,
      `${p}.channels["5"].name: must be a non-empty string of at most 64 characters`,
      'devices["BidCos-RF:A2"].channels: must be an object',
    ].sort());
  });
});

describe('toMappings', () => {
  it('flattens device and per-channel mappings', () => {
    const file: DevicesFile = {
      version: 1,
      devices: {
        ...EXAMPLE.devices,
        'HmIP-RF:00000000000A03': {
          options: { debounce: 2 },
          channels: {
            '1': { service: 'SwitchAccessory', valveType: 'x', options: { debounce: 5 } },
            '2': { service: 'SwitchAccessory', enabled: false },
          },
        },
        'HmIP-RF:00000000000A04': { enabled: false, service: 'SwitchAccessory' },
        'bogus': { service: 'SwitchAccessory' },
      },
    } as DevicesFile;
    const m = toMappings(file);
    expect(m).toEqual([
      {
        interface: 'BidCos-RF', device: 'ABC0000002', service: 'IrrigationAccessory', options: {},
        channels: EXAMPLE.devices['BidCos-RF:ABC0000002'].channels,
      },
      {
        interface: 'HmIP-RF', device: '00000000000A01', channel: 6, service: 'SwitchAccessory',
        variant: 'Lightbulb', name: 'WZ1', options: {}, channels: {},
      },
      {
        interface: 'HmIP-RF', device: '00000000000A02', service: 'BlindAccessory', options: { invert: true }, channels: {},
      },
      {
        interface: 'HmIP-RF', device: '00000000000A03', channel: 1, service: 'SwitchAccessory',
        options: { debounce: 5, valveType: 'x' }, channels: {},
      },
    ]);
  });

  it('keeps device-level variant and name', () => {
    const [m] = toMappings({ version: 1, devices: { 'BidCos-RF:A1': { service: 'SwitchAccessory', variant: 'outlet', name: 'N' } } });
    expect(m).toMatchObject({ variant: 'outlet', name: 'N' });
  });
});

describe('keys and UUID seed (D6)', () => {
  it('parses device keys', () => {
    expect(parseDeviceKey('HmIP-RF:00000000000A01')).toEqual({ interface: 'HmIP-RF', device: '00000000000A01' });
    expect(parseDeviceKey('HmIP-RF:')).toBeUndefined();
  });

  it('builds <Interface>:<Serial>:<Channel>:<Service>', () => {
    expect(mappingUuidSeed({ interface: 'HmIP-RF', device: 'X1', channel: 6, service: 'SwitchAccessory' }))
      .toBe('HmIP-RF:X1:6:SwitchAccessory');
    expect(mappingUuidSeed({ interface: 'BidCos-RF', device: 'X2', service: 'IrrigationAccessory' }))
      .toBe('BidCos-RF:X2:device:IrrigationAccessory');
  });
});

describe('loadDevicesFile / saveDevicesFile', () => {
  let tmp = '';
  let storage: PluginStorage;
  const log = () => new PrefixedLogger(makeLog(), 't');
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-devices-'));
    storage = new PluginStorage({ user: { storagePath: () => tmp } });
  });
  const file = () => path.join(tmp, 'homebridge-hap-homematic', 'devices.json');

  it('treats a missing file as "no mappings"', async () => {
    const l = log();
    const info = vi.spyOn(l, 'info');
    expect(await loadDevicesFile(storage, l, KNOWN)).toEqual({ file: undefined, mappings: [], errors: [] });
    expect(info).toHaveBeenCalled();
  });

  it('saves atomically with mode 0600 and loads it back', async () => {
    expect((await saveDevicesFile(storage, EXAMPLE, KNOWN)).ok).toBe(true);
    const st = await fs.stat(file());
    expect(st.mode & 0o777).toBe(0o600);
    await expect(fs.stat(`${file()}.tmp`)).rejects.toThrow();
    const loaded = await loadDevicesFile(storage, log(), KNOWN);
    expect(loaded.file).toEqual(EXAMPLE);
    expect(loaded.mappings).toHaveLength(3);
  });

  it('refuses to save an invalid file and keeps the old one', async () => {
    await saveDevicesFile(storage, EXAMPLE, KNOWN);
    const r = await saveDevicesFile(storage, { version: 1, devices: { x: {} } }, KNOWN);
    expect(r.ok).toBe(false);
    expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toEqual(EXAMPLE);
  });

  it('reports invalid and unreadable files without touching them', async () => {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), JSON.stringify({ version: 3, devices: {} }));
    const l = log();
    const error = vi.spyOn(l, 'error');
    const r = await loadDevicesFile(storage, l, KNOWN);
    expect(r).toEqual({ file: undefined, mappings: [], errors: ['version: must be 1'] });
    expect(error).toHaveBeenCalled();

    await fs.writeFile(file(), '{ not json');
    const r2 = await loadDevicesFile(storage, l, KNOWN);
    expect(r2.errors[0]).toMatch(/cannot read devices\.json/);
    expect(await fs.readFile(file(), 'utf8')).toBe('{ not json');
  });
});
