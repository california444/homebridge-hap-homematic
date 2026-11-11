// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Imports a hap-homematic configuration into our config schema.
 *
 * Two entry points:
 *   - importBackupTarball(buffer)  — stream a .tar.gz from the UI
 *   - importConfigJson(rawConfig)  — for users who only have config.json
 *
 * The mapping logic is the only place where we name-translate from the
 * old plugin's service classes to ours. New name aliases go in
 * `SERVICE_ALIASES`. Anything we can't map produces a warning in the
 * `ImportReport` rather than failing the whole import.
 *
 * For users who configured one HAP bridge per hap-homematic *instance*
 * (typically one bridge per room), `splitReportIntoBridges` converts the
 * flat report into one Homebridge platform-config block per instance,
 * each with a deterministic `_bridge: { username, port }` so child-bridge
 * identity is stable across re-runs of the import.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { list as tarList } from 'tar';
import type {
  ChannelMapping,
  ProgramMapping,
  ResolvedConfig,
  VariableMapping,
} from '../types.js';

const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_CONFIG_JSON_BYTES = 16 * 1024 * 1024;

/** hap-homematic service class -> our service key. */
const SERVICE_ALIASES: Record<string, string> = {
  HomeMaticSwitchAccessory: 'SwitchAccessory',
  HomeMaticDimmerAccessory: 'DimmerAccessory',
  HomeMaticBlindAccessory: 'BlindAccessory',
  HomeMaticBlindIPAccessory: 'BlindAccessory',
  HomeMaticContactSensorAccessory: 'ContactAccessory',
  HomeMaticWindowAccessory: 'ContactAccessory',
  HomeMaticDoorAccessory: 'ContactAccessory',
  HomeMaticMotionAccessory: 'MotionAccessory',
  HomeMaticIPMotionAccessory: 'MotionAccessory',
  HomeMaticPresenceAccessory: 'MotionAccessory',
  HomeMaticThermostatAccessory: 'ThermostatAccessory',
  HomeMaticRadiatorThermostatAccessory: 'ThermostatAccessory',
  HomeMaticThermometerAccessory: 'TemperatureAccessory',
  HomeMaticHumidityAccessory: 'HumidityAccessory',
  HomeMaticSmokeDetectorAccessory: 'SmokeAccessory',
  HomeMaticLeakSensorAccessory: 'LeakAccessory',
  HomeMaticVariableAccessory: 'VariableSwitchAccessory',
  HomeMaticVariableNumberSensorAccessory: 'VariableNumericSensorAccessory',
  HomeMaticVarBasedThermometerAccessory: 'VariableNumericSensorAccessory',
  HomeMaticPushTheButtonAccessory: 'ProgrammableSwitchAccessory',
  HomeMaticDoorOpenerAccessory: 'DoorOpenerAccessory',
  HomeMaticProgramAccessory: 'ProgramAccessory',
};

/** Default subtype for service classes that have meaningful sub-variants. */
const SERVICE_DEFAULT_SUBTYPE: Record<string, string> = {
  HomeMaticWindowAccessory: 'window',
  HomeMaticDoorAccessory: 'door',
  HomeMaticContactSensorAccessory: 'contact',
  HomeMaticVarBasedThermometerAccessory: 'temperature',
};

/** hap-homematic Type setting -> our subtype. */
const SUBTYPE_ALIASES: Record<string, string> = {
  Switch: 'switch',
  Outlet: 'outlet',
  Lightbulb: 'lightbulb',
  Door: 'door',
  Window: 'window',
};

export interface ImportReport {
  channels: ChannelMapping[];
  variables: VariableMapping[];
  programs: ProgramMapping[];
  warnings: string[];
  meta: {
    instanceCount: number;
    sourceVersion?: string;
    ccuIp?: string;
    instances: Record<string, { name?: string }>;
  };
}

/** A single Homebridge platform-config block emitted by multi-bridge import. */
export interface BridgeImportBlock {
  /** Source instance UUID, kept for traceability. */
  instanceUuid: string;
  /** Display name shown in the Home app. */
  name: string;
  /** `_bridge` identity for the child-bridge feature. */
  bridge: { username: string; port: number };
  channels: ChannelMapping[];
  variables: VariableMapping[];
  programs: ProgramMapping[];
}

export interface HapHomematicConfigShape {
  ccuIP?: string;
  channels?: string[];
  variables?: string[];
  programs?: string[];
  mappings?: Record<string, {
    Service?: string;
    Type?: string;
    instance?: string;
    [k: string]: unknown;
  }>;
  instances?: Record<string, { name?: string; user?: string; pin?: string; setupID?: string }>;
  version?: string;
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export async function importBackupTarball(tarball: Buffer): Promise<ImportReport> {
  if (!Buffer.isBuffer(tarball) || tarball.length === 0) {
    throw new ImportError('Empty or invalid tarball');
  }
  if (tarball.length > MAX_TARBALL_BYTES) {
    throw new ImportError(`Tarball larger than ${MAX_TARBALL_BYTES / (1024 * 1024)} MiB`);
  }
  const configJson = await extractConfigJson(tarball);
  return importConfigJson(configJson);
}

export function importConfigJson(raw: HapHomematicConfigShape | string): ImportReport {
  const config: HapHomematicConfigShape = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!config || typeof config !== 'object') {
    throw new ImportError('Invalid config payload');
  }

  const warnings: string[] = [];
  const channels: ChannelMapping[] = [];
  const variables: VariableMapping[] = [];
  const programs: ProgramMapping[] = [];

  for (const address of config.channels ?? []) {
    if (typeof address !== 'string' || address.length === 0) {
      continue;
    }
    const mapping = config.mappings?.[address] ?? {};
    const sourceService = mapping.Service ?? '';
    const service = SERVICE_ALIASES[sourceService];
    if (!service) {
      warnings.push(`Could not map service "${sourceService || '?'}" for channel ${address} — skipped`);
      continue;
    }
    const subtype = mapping.Type
      ? SUBTYPE_ALIASES[mapping.Type] ?? SERVICE_DEFAULT_SUBTYPE[sourceService]
      : SERVICE_DEFAULT_SUBTYPE[sourceService];
    // hap-homematic stores the user-customised HomeKit display name under
    // `name`. Lift it to the top-level mapping field so the platform can
    // use it as the accessory display name (otherwise we'd inherit the
    // raw HomeMatic name from the CCU).
    const customName = typeof mapping.name === 'string' && mapping.name.length > 0
      ? mapping.name : undefined;
    channels.push({
      address,
      name: customName,
      service,
      subtype,
      instance: typeof mapping.instance === 'string' ? mapping.instance : undefined,
      settings: dropKnownKeys(mapping, ['Service', 'Type', 'instance', 'name']),
    });
  }

  for (const name of config.variables ?? []) {
    if (typeof name !== 'string' || name.length === 0) {
      continue;
    }
    const mapping = config.mappings?.[name] ?? {};
    const sourceService = mapping.Service ?? '';
    const service = SERVICE_ALIASES[sourceService];
    if (sourceService && !service) {
      warnings.push(`Could not map variable service "${sourceService}" for "${name}" — kept with default mapping`);
    }
    const customName = typeof mapping.name === 'string' && mapping.name.length > 0
      ? mapping.name : undefined;
    variables.push({
      name,
      displayName: customName,
      service,
      subtype: SERVICE_DEFAULT_SUBTYPE[sourceService],
      instance: typeof mapping.instance === 'string' ? mapping.instance : undefined,
      settings: dropKnownKeys(mapping, ['Service', 'Type', 'instance', 'name']),
    });
  }

  for (const name of config.programs ?? []) {
    if (typeof name !== 'string' || name.length === 0) {
      continue;
    }
    const mapping = config.mappings?.[name] ?? {};
    const customName = typeof mapping.name === 'string' && mapping.name.length > 0
      ? mapping.name : undefined;
    programs.push({
      name,
      displayName: customName,
      instance: typeof mapping.instance === 'string' ? mapping.instance : undefined,
    });
  }

  return {
    channels,
    variables,
    programs,
    warnings,
    meta: {
      instanceCount: Object.keys(config.instances ?? {}).length,
      sourceVersion: config.version,
      ccuIp: config.ccuIP,
      instances: config.instances ?? {},
    },
  };
}

/** Merge an ImportReport into an existing ResolvedConfig (channels, variables, programs). */
export function mergeIntoConfig(target: Partial<ResolvedConfig>, report: ImportReport): Partial<ResolvedConfig> {
  const existingChannels = new Map((target.channels ?? []).map((m) => [m.address, m]));
  for (const m of report.channels) {
    existingChannels.set(m.address, m);
  }
  const existingVars = new Map((target.variables ?? []).map((m) => [m.name, m]));
  for (const m of report.variables) {
    existingVars.set(m.name, m);
  }
  const existingProgs = new Map((target.programs ?? []).map((m) => [m.name, m]));
  for (const m of report.programs) {
    existingProgs.set(m.name, m);
  }
  return {
    ...target,
    ccuIp: target.ccuIp ?? report.meta.ccuIp,
    channels: Array.from(existingChannels.values()),
    variables: Array.from(existingVars.values()),
    programs: Array.from(existingProgs.values()),
  };
}

/**
 * Split a flat ImportReport into one Homebridge platform block per
 * hap-homematic instance. Items whose `instance` field is missing or
 * unknown are folded into the first block (so nothing is silently
 * dropped). Each block gets a deterministic `_bridge.username` and
 * `_bridge.port` derived from the instance UUID — re-imports produce
 * the same identities, which preserves Homebridge child-bridge pairing
 * across runs.
 */
export function splitReportIntoBridges(report: ImportReport): BridgeImportBlock[] {
  const instances = report.meta.instances ?? {};
  const uuids = Object.keys(instances);

  if (uuids.length === 0) {
    return [{
      instanceUuid: 'default',
      name: 'HapHomematic',
      bridge: bridgeIdentityFor('default'),
      channels: [...report.channels],
      variables: [...report.variables],
      programs: [...report.programs],
    }];
  }

  const blocks = new Map<string, BridgeImportBlock>();
  for (const uuid of uuids) {
    blocks.set(uuid, {
      instanceUuid: uuid,
      name: instances[uuid]?.name ?? `HapHomematic-${uuid.slice(0, 8)}`,
      bridge: bridgeIdentityFor(uuid),
      channels: [],
      variables: [],
      programs: [],
    });
  }

  // Anything we can't trace back to an instance lands in the first block.
  const fallbackUuid = uuids[0]!;
  const targetFor = (instance?: string): BridgeImportBlock => {
    const direct = instance ? blocks.get(instance) : undefined;
    return direct ?? blocks.get(fallbackUuid)!;
  };
  const placeChannel = (m: ChannelMapping): void => { targetFor(m.instance).channels.push(m); };
  const placeVariable = (m: VariableMapping): void => { targetFor(m.instance).variables.push(m); };
  const placeProgram = (m: ProgramMapping): void => { targetFor(m.instance).programs.push(m); };
  report.channels.forEach(placeChannel);
  report.variables.forEach(placeVariable);
  report.programs.forEach(placeProgram);

  return Array.from(blocks.values());
}

/**
 * Deterministic, locally-administered MAC + port pair from an instance
 * identifier. The MAC sets the locally-administered + unicast bits so
 * it never collides with real OUI-assigned NICs. The port is in
 * 9000..14999 — well clear of the default Homebridge range and unlikely
 * to clash with common services.
 */
export function bridgeIdentityFor(seed: string): { username: string; port: number } {
  const hash = createHash('sha256').update(seed).digest();
  const bytes: string[] = [];
  for (let i = 0; i < 6; i++) {
    let b = hash[i]!;
    if (i === 0) {
      // Force locally-administered (bit 1 set) and unicast (bit 0 cleared).
      b = (b & 0xfe) | 0x02;
    }
    bytes.push(b.toString(16).toUpperCase().padStart(2, '0'));
  }
  const port = 9000 + (hash.readUInt16BE(6) % 6000);
  return { username: bytes.join(':'), port };
}

// --- internals -------------------------------------------------------

async function extractConfigJson(tarball: Buffer): Promise<HapHomematicConfigShape> {
  return new Promise<HapHomematicConfigShape>((resolve, reject) => {
    let resolved = false;
    const stream = Readable.from(tarball);
    // `tar.list` is parse-only — unlike `tar.extract` it never writes
    // files to disk, which matters because we run inside a long-lived
    // Homebridge process whose cwd we should never modify.
    const parser = tarList({
      filter: (path) => path.endsWith('config.json'),
      onReadEntry: (entry) => {
        if (resolved) {
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        entry.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_CONFIG_JSON_BYTES) {
            entry.destroy(new ImportError('config.json too large'));
            return;
          }
          chunks.push(chunk);
        });
        entry.on('end', () => {
          if (resolved) {
            return;
          }
          resolved = true;
          try {
            const parsed = safeParse(Buffer.concat(chunks).toString('utf8'));
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
        entry.on('error', (err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
      },
    });
    parser.on('end', () => {
      if (!resolved) {
        reject(new ImportError('No config.json found in backup'));
      }
    });
    parser.on('error', (err: Error) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    stream.pipe(parser as unknown as NodeJS.WritableStream);
  });
}

function safeParse(text: string): HapHomematicConfigShape {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ImportError('Backup config.json is not a JSON object');
    }
    return parsed as HapHomematicConfigShape;
  } catch (err) {
    if (err instanceof ImportError) {
      throw err;
    }
    throw new ImportError(`Invalid JSON: ${(err as Error).message}`);
  }
}

function dropKnownKeys<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k)) {
      out[k] = v;
    }
  }
  return out;
}
