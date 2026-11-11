/**
 * Irrigation (plan 8.1, decision D3): one HomeKit IrrigationSystem with a
 * linked Valve per switch channel of a multi-channel actuator such as the
 * HM-LC-Sw4-DR-2. Mapped as a whole device in devices.json:
 *
 *   "BidCos-RF:<serial>": { "service": "IrrigationAccessory",
 *     "channels": { "1": { "name": "Rasen vorne", "valveType": "Irrigation" }, … } }
 *
 * Switching on: first ON_TIME (seconds, from the valve's SetDuration), then
 * STATE=true. The actuator switches itself off — the plugin never sends a
 * timed STATE=false. RemainingDuration is display only; the end time is
 * kept in accessory.context so it survives a Homebridge restart.
 * SetDuration = 0: no ON_TIME, the valve stays on until switched off.
 */

import type { Service } from 'homebridge';
import { AccessoryBase, isTrue } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel, CcuDevice } from '../../types.js';

const DEFAULT_DURATION_S = 600;
const MAX_DURATION_S = 3600; // HAP SetDuration maximum

/** devices.json `valveType` → HAP ValveType. */
const VALVE_TYPES: Record<string, number> = {
  genericvalve: 0, generic: 0,
  irrigation: 1,
  showerhead: 2, shower: 2,
  waterfaucet: 3, faucet: 3,
};

interface IrrigationContext {
  /** SetDuration per channel number, seconds. */
  durations?: Record<string, number>;
  /** Expected end per channel number, epoch ms (display only). */
  ends?: Record<string, number>;
}

interface Valve {
  index: number;
  address: string;
  service: Service;
  on: boolean | undefined;
}

class IrrigationHandler extends AccessoryBase implements ChannelService {
  private readonly valves: Valve[] = [];
  private system?: Service;

  attach(channel: CcuChannel, device?: CcuDevice): void {
    const serial = channel.address.split(':')[0]!;
    const settings = (this.accessory.context.settings ?? {}) as {
      channels?: Record<string, { name?: string; valveType?: unknown }>;
      defaultDuration?: unknown;
    };
    const perChannel = settings.channels ?? {};
    const store = this.store();
    const defaultDuration = clampDuration(Number(settings.defaultDuration ?? DEFAULT_DURATION_S));

    const system = this.getOrAddService(this.Service.IrrigationSystem, this.accessory.displayName);
    this.system = system;
    system.getCharacteristic(this.Characteristic.Active)
      .onGet(this.wrapGet<number>(() => this.systemActive()))
      .onSet(this.wrapSet<number>(async (v) => {
        if (Number(v) === 0) {
          for (const valve of this.valves.filter((x) => x.on)) {
            await this.ccu.setValue(valve.address, 'STATE', false);
          }
        }
      }));
    system.getCharacteristic(this.Characteristic.ProgramMode)
      .onGet(() => this.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
    system.getCharacteristic(this.Characteristic.InUse)
      .onGet(this.wrapGet<number>(() => this.systemActive()));
    this.watchFault(system, `${serial}:1`);

    for (const index of valveChannels(device, perChannel)) {
      const key = String(index);
      const address = `${serial}:${index}`;
      const cfg = perChannel[key] ?? {};
      const name = typeof cfg.name === 'string' && cfg.name ? cfg.name : `Valve ${index}`;
      const service = this.getOrAddService(this.Service.Valve, name, `valve-${index}`);
      const valve: Valve = { index, address, service, on: undefined };
      this.valves.push(valve);
      (system as unknown as { addLinkedService?: (s: Service) => void }).addLinkedService?.(service);

      service.setCharacteristic(this.Characteristic.ServiceLabelIndex, index);
      service.setCharacteristic(this.Characteristic.IsConfigured, this.Characteristic.IsConfigured.CONFIGURED);
      service.setCharacteristic(this.Characteristic.ValveType, valveType(cfg.valveType));

      service.getCharacteristic(this.Characteristic.Active)
        .onGet(this.wrapGet<number>(() => (valve.on === undefined ? this.unknown() : valve.on ? 1 : 0)))
        .onSet(this.wrapSet<number>(async (v) => this.switchValve(valve, Number(v) === 1)));
      service.getCharacteristic(this.Characteristic.InUse)
        .onGet(this.wrapGet<number>(() => (valve.on === undefined ? this.unknown() : valve.on ? 1 : 0)));
      service.getCharacteristic(this.Characteristic.SetDuration)
        .setProps({ minValue: 0, maxValue: MAX_DURATION_S })
        .onGet(() => store.durations![key] ?? defaultDuration)
        .onSet((v) => {
          store.durations![key] = clampDuration(Number(v));
          this.persist();
        });
      service.getCharacteristic(this.Characteristic.RemainingDuration)
        .setProps({ minValue: 0, maxValue: MAX_DURATION_S })
        .onGet(() => this.remaining(key));

      this.need(address, 'STATE', (raw) => {
        valve.on = isTrue(raw);
        if (!valve.on && store.ends![key] !== undefined) {
          delete store.ends![key];
          this.persist();
        }
        const n = valve.on ? 1 : 0;
        service.updateCharacteristic(this.Characteristic.Active, n);
        service.updateCharacteristic(this.Characteristic.InUse, n);
        this.update(service, this.Characteristic.RemainingDuration, this.remaining(key));
        this.updateSystem();
      });
      this.watchFault(service, address);
    }
  }

  private async switchValve(valve: Valve, on: boolean): Promise<void> {
    const key = String(valve.index);
    const store = this.store();
    if (!on) {
      await this.ccu.setValue(valve.address, 'STATE', false);
      delete store.ends![key];
      this.persist();
      return;
    }
    const settings = (this.accessory.context.settings ?? {}) as { defaultDuration?: unknown };
    const duration = store.durations![key] ?? clampDuration(Number(settings.defaultDuration ?? DEFAULT_DURATION_S));
    if (duration > 0) {
      // The actuator switches off by itself after ON_TIME (D3).
      await this.ccu.setValue(valve.address, 'ON_TIME', duration);
      store.ends![key] = Date.now() + duration * 1000;
    } else {
      delete store.ends![key];
    }
    await this.ccu.setValue(valve.address, 'STATE', true);
    this.persist();
    this.update(valve.service, this.Characteristic.RemainingDuration, this.remaining(key));
  }

  /** Seconds left from the stored end time; 0 if unknown or over. */
  private remaining(key: string): number {
    const end = this.store().ends![key];
    if (end === undefined) {
      return 0;
    }
    return Math.max(0, Math.min(MAX_DURATION_S, Math.round((end - Date.now()) / 1000)));
  }

  private systemActive(): number {
    if (this.valves.length > 0 && this.valves.every((v) => v.on === undefined)) {
      return this.unknown();
    }
    return this.valves.some((v) => v.on) ? 1 : 0;
  }

  private updateSystem(): void {
    if (!this.system || this.valves.every((v) => v.on === undefined)) {
      return;
    }
    const n = this.valves.some((v) => v.on) ? 1 : 0;
    this.system.updateCharacteristic(this.Characteristic.Active, n);
    this.system.updateCharacteristic(this.Characteristic.InUse, n);
  }

  /** accessory.context.irrigation, created on first use. */
  private store(): Required<IrrigationContext> {
    const ctx = this.accessory.context as unknown as { irrigation?: IrrigationContext };
    ctx.irrigation ??= {};
    ctx.irrigation.durations ??= {};
    ctx.irrigation.ends ??= {};
    return ctx.irrigation as Required<IrrigationContext>;
  }
}

function clampDuration(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_DURATION_S, Math.max(0, Math.round(n))) : DEFAULT_DURATION_S;
}

function valveType(raw: unknown): number {
  return VALVE_TYPES[String(raw ?? 'irrigation').toLowerCase().replace(/[^a-z]/g, '')] ?? 1;
}

/**
 * Valve channels: the device's SWITCH channels if discovered, else the
 * channels named in devices.json, else 1–4.
 */
function valveChannels(device: CcuDevice | undefined, perChannel: Record<string, unknown>): number[] {
  const fromDevice = (device?.channels ?? [])
    .filter((c) => c.index > 0 && c.type === 'SWITCH')
    .map((c) => c.index);
  if (fromDevice.length > 0) {
    return fromDevice.sort((a, b) => a - b);
  }
  const fromMapping = Object.keys(perChannel).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return fromMapping.length > 0 ? fromMapping.sort((a, b) => a - b) : [1, 2, 3, 4];
}

export const irrigationService: ServiceDefinition = {
  key: 'IrrigationAccessory',
  description: 'Irrigation system: one valve per switch channel (map the whole device)',
  channelTypes: ['SWITCH'],
  // Below SwitchAccessory: only chosen explicitly, as a device mapping.
  priority: 50,
  build: (ctx: ServiceContext) => new IrrigationHandler(ctx),
};
