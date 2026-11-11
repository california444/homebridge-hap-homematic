/**
 * devices.json: the device → HomeKit mappings, kept outside config.json
 * under `<storagePath>/homebridge-hap-homematic/devices.json`.
 *
 * Written by the custom-UI server (atomic, mode 0600, via PluginStorage),
 * read by the platform at start. The file is validated on every load and
 * save; an invalid file is reported and never overwritten silently.
 * Format: see docs/DEVICES.md.
 */

import type {
  AccessoryMapping,
  CcuInterfaceId,
  DevicesFile,
  DevicesFileChannel,
} from '../types.js';
import type { PluginStorage } from './storage.js';
import type { PrefixedLogger } from './logger.js';

export const DEVICES_FILE = 'devices.json';

const DEVICE_KEY_RE = /^(BidCos-RF|HmIP-RF):([A-Za-z0-9]{1,32})$/;
const CHANNEL_KEY_RE = /^(0|[1-9][0-9]{0,2})$/;
const SERVICE_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const EXTRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const MAX_NAME = 64;
const MAX_DEVICES = 500;

const DEVICE_KEYS = new Set(['enabled', 'mode', 'service', 'variant', 'name', 'options', 'channels']);
const CHANNEL_KEYS = new Set(['enabled', 'service', 'variant', 'name', 'options']);

export type ValidationResult =
  | { ok: true; file: DevicesFile }
  | { ok: false; errors: string[] };

export function emptyDevicesFile(): DevicesFile {
  return { version: 1, devices: {} };
}

/** `<Interface>:<Serial>` → parts, or undefined if the key is malformed. */
export function parseDeviceKey(key: string): { interface: CcuInterfaceId; device: string } | undefined {
  const m = DEVICE_KEY_RE.exec(key);
  return m ? { interface: m[1] as CcuInterfaceId, device: m[2]! } : undefined;
}

/**
 * UUID seed per decision D6: `<Interface>:<Serial>:<Channel>:<Service>`.
 * Device mappings use `device` in place of the channel number. Changing
 * the service therefore creates a new HomeKit accessory.
 */
export function mappingUuidSeed(m: Pick<AccessoryMapping, 'interface' | 'device' | 'channel' | 'service'>): string {
  return `${m.interface}:${m.device}:${m.channel ?? 'device'}:${m.service}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Structural validation. `knownServices` (registry keys) is optional so
 * the validator stays independent of the service registry;
 * `deviceServices` (keys with scope "device") checks the mode.
 */
export function validateDevicesFile(
  raw: unknown,
  knownServices?: ReadonlySet<string>,
  deviceServices?: ReadonlySet<string>,
): ValidationResult {
  const errors: string[] = [];
  const err = (path: string, msg: string): void => {
    errors.push(`${path}: ${msg}`);
  };

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['(root): must be an object'] };
  }
  for (const k of Object.keys(raw)) {
    if (k !== 'version' && k !== 'devices') {
      err(k, 'unknown key');
    }
  }
  if (raw.version !== 1) {
    err('version', 'must be 1');
  }
  if (!isPlainObject(raw.devices)) {
    err('devices', 'must be an object');
    return { ok: false, errors };
  }
  const entries = Object.entries(raw.devices);
  if (entries.length > MAX_DEVICES) {
    err('devices', `at most ${MAX_DEVICES} entries`);
  }

  const checkName = (path: string, v: unknown): void => {
    if (v !== undefined && (typeof v !== 'string' || v.trim().length === 0 || v.length > MAX_NAME)) {
      err(path, `must be a non-empty string of at most ${MAX_NAME} characters`);
    }
  };
  const checkService = (path: string, v: unknown): void => {
    if (typeof v !== 'string' || !SERVICE_RE.test(v)) {
      err(path, 'must be a service key such as "SwitchAccessory"');
    } else if (knownServices && !knownServices.has(v)) {
      err(path, `unknown service "${v}"`);
    }
  };
  const checkCommon = (path: string, e: Record<string, unknown>): void => {
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') {
      err(`${path}.enabled`, 'must be true or false');
    }
    if (e.variant !== undefined && (typeof e.variant !== 'string' || e.variant.length === 0 || e.variant.length > MAX_NAME)) {
      err(`${path}.variant`, 'must be a non-empty string');
    }
    checkName(`${path}.name`, e.name);
    if (e.options !== undefined && !isPlainObject(e.options)) {
      err(`${path}.options`, 'must be an object');
    }
  };

  for (const [key, dev] of entries) {
    const path = `devices["${key}"]`;
    if (!parseDeviceKey(key)) {
      err(path, 'key must be "<BidCos-RF|HmIP-RF>:<serial>"');
      continue;
    }
    if (!isPlainObject(dev)) {
      err(path, 'must be an object');
      continue;
    }
    for (const k of Object.keys(dev)) {
      if (!DEVICE_KEYS.has(k)) {
        err(`${path}.${k}`, 'unknown key');
      }
    }
    checkCommon(path, dev);
    if (dev.mode !== undefined && dev.mode !== 'device' && dev.mode !== 'perChannel') {
      err(`${path}.mode`, 'must be "device" or "perChannel"');
    }
    // An invalid mode is already reported; fall back to the derived one.
    const mode = dev.mode === 'device' || dev.mode === 'perChannel'
      ? dev.mode
      : (dev.service !== undefined ? 'device' : 'perChannel');
    if (mode === 'device') {
      checkService(`${path}.service`, dev.service);
    } else if (dev.service !== undefined) {
      err(`${path}.service`, 'not allowed with mode "perChannel" (set it per channel)');
    }
    if (dev.channels !== undefined && !isPlainObject(dev.channels)) {
      err(`${path}.channels`, 'must be an object');
      continue;
    }
    const channels = Object.entries((dev.channels ?? {}) as Record<string, unknown>);
    if (mode === 'perChannel' && channels.length === 0 && dev.enabled !== false) {
      err(`${path}.channels`, 'perChannel mapping without channels');
    }
    for (const [idx, ch] of channels) {
      const cpath = `${path}.channels["${idx}"]`;
      if (!CHANNEL_KEY_RE.test(idx)) {
        err(cpath, 'key must be a channel number');
        continue;
      }
      if (!isPlainObject(ch)) {
        err(cpath, 'must be an object');
        continue;
      }
      checkCommon(cpath, ch);
      for (const [k, v] of Object.entries(ch)) {
        if (CHANNEL_KEYS.has(k)) {
          continue;
        }
        if (!EXTRA_KEY_RE.test(k)) {
          err(`${cpath}.${k}`, 'invalid key');
        } else if (!['string', 'number', 'boolean'].includes(typeof v)) {
          err(`${cpath}.${k}`, 'extra settings must be a string, number or boolean');
        }
      }
      if (mode === 'perChannel' && ch.enabled !== false) {
        checkService(`${cpath}.service`, ch.service);
        if (deviceServices && typeof ch.service === 'string' && deviceServices.has(ch.service)) {
          err(`${cpath}.service`, `"${ch.service}" maps a whole device; use "service" on the device entry`);
        }
      } else if (mode === 'device' && ch.service !== undefined) {
        err(`${cpath}.service`, 'not allowed in a device mapping');
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, file: raw as unknown as DevicesFile };
}

function channelExtras(ch: DevicesFileChannel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ch)) {
    if (!CHANNEL_KEYS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

/** Flatten a valid file into one entry per accessory (disabled ones skipped). */
export function toMappings(file: DevicesFile): AccessoryMapping[] {
  const out: AccessoryMapping[] = [];
  for (const [key, dev] of Object.entries(file.devices)) {
    const parsed = parseDeviceKey(key);
    if (!parsed || dev.enabled === false) {
      continue;
    }
    const mode = dev.mode ?? (dev.service !== undefined ? 'device' : 'perChannel');
    const channels = dev.channels ?? {};
    if (mode === 'device') {
      out.push({
        ...parsed,
        service: dev.service!,
        ...(dev.variant ? { variant: dev.variant } : {}),
        ...(dev.name ? { name: dev.name } : {}),
        options: { ...(dev.options ?? {}) },
        channels,
      });
      continue;
    }
    for (const [idx, ch] of Object.entries(channels)) {
      if (ch.enabled === false) {
        continue;
      }
      out.push({
        ...parsed,
        channel: Number(idx),
        service: ch.service!,
        ...(ch.variant ? { variant: ch.variant } : {}),
        ...(ch.name ? { name: ch.name } : {}),
        options: { ...(dev.options ?? {}), ...channelExtras(ch), ...(ch.options ?? {}) },
        channels: {},
      });
    }
  }
  return out;
}

export interface LoadedDevices {
  /** The file as read; undefined if missing or invalid. */
  file: DevicesFile | undefined;
  mappings: AccessoryMapping[];
  errors: string[];
}

/** Read and validate devices.json. A missing file means "no mappings". */
export async function loadDevicesFile(
  storage: PluginStorage,
  log: PrefixedLogger,
  knownServices?: ReadonlySet<string>,
  deviceServices?: ReadonlySet<string>,
): Promise<LoadedDevices> {
  let raw: unknown;
  try {
    raw = await storage.readJson<unknown>(DEVICES_FILE);
  } catch (e) {
    const msg = `cannot read ${DEVICES_FILE}: ${(e as Error).message}`;
    log.error('%s — no accessories will be created; the file is left as it is', msg);
    return { file: undefined, mappings: [], errors: [msg] };
  }
  if (raw === undefined) {
    log.info('%s not found in %s — no devices mapped yet', DEVICES_FILE, storage.rootPath());
    return { file: undefined, mappings: [], errors: [] };
  }
  const result = validateDevicesFile(raw, knownServices, deviceServices);
  if (!result.ok) {
    log.error('%s is invalid (%d problems) — no accessories will be created; the file is left as it is:\n  %s',
      DEVICES_FILE, result.errors.length, result.errors.join('\n  '));
    return { file: undefined, mappings: [], errors: result.errors };
  }
  return { file: result.file, mappings: toMappings(result.file), errors: [] };
}

/** Validate, then write atomically (temp file + rename, mode 0600). */
export async function saveDevicesFile(
  storage: PluginStorage,
  file: unknown,
  knownServices?: ReadonlySet<string>,
  deviceServices?: ReadonlySet<string>,
): Promise<ValidationResult> {
  const result = validateDevicesFile(file, knownServices, deviceServices);
  if (result.ok) {
    await storage.writeJson(DEVICES_FILE, result.file);
  }
  return result;
}
