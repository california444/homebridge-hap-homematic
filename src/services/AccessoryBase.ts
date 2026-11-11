// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Base class shared by per-accessory handlers. Provides:
 *   - access to platform-level objects (Service / Characteristic / api / ccu)
 *   - getOrAdd helpers for HAP services
 *   - registerListener() that auto-cleans on dispose()
 *   - need() / readOnRefresh(): start values via getParamset (plan 4.2)
 *   - unknown(): "No Response" instead of a made-up default
 *   - update(): push values clamped to the characteristic's props (8.5)
 *   - watchFault(): StatusFault from UNREACH and the interface state (7.7, 8.5)
 *   - safe wrappers for onGet / onSet that route errors to log + HAP fault
 *
 * Services subclass this and implement attach().
 */

import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { CcuClient } from '../ccu/CcuClient.js';
import type { PrefixedLogger } from '../util/logger.js';
import type { AccessoryContext, CcuInterfaceId } from '../types.js';
import type { HapStatus, ServiceContext } from './types.js';
import { clampToProps, type ValueProps } from '../util/sanitize.js';

export type DatapointListener = (value: unknown) => void;

/** HAP services that have an optional StatusFault characteristic. */
const FAULT_CAPABLE = [
  'SmokeSensor', 'ContactSensor', 'LeakSensor', 'MotionSensor', 'TemperatureSensor',
  'HumiditySensor', 'LightSensor', 'IrrigationSystem', 'Valve', 'CarbonMonoxideSensor',
  'CarbonDioxideSensor', 'AirQualitySensor', 'OccupancySensor',
] as const;

/** Device-level channel 0 of any channel address. */
export function maintenanceAddress(channelAddress: string): string {
  const colon = channelAddress.lastIndexOf(':');
  return colon === -1 ? `${channelAddress}:0` : `${channelAddress.slice(0, colon)}:0`;
}

export function isTrue(raw: unknown): boolean {
  return raw === true || raw === 1 || raw === '1' || raw === 'true';
}

export abstract class AccessoryBase {
  protected readonly accessory: PlatformAccessory<AccessoryContext>;
  protected readonly ccu: CcuClient;
  protected readonly log: PrefixedLogger;
  protected readonly Service: typeof Service;
  protected readonly Characteristic: typeof Characteristic;
  private readonly hap: HapStatus | undefined;
  private readonly persistFn: (() => void) | undefined;

  private readonly disposers: Array<() => void> = [];
  /** channel address → datapoint → appliers, read on refresh(). */
  private readonly reads = new Map<string, Map<string, DatapointListener[]>>();

  constructor(ctx: ServiceContext) {
    this.accessory = ctx.accessory;
    this.ccu = ctx.ccu;
    this.log = ctx.log;
    this.Service = ctx.Service;
    this.Characteristic = ctx.Characteristic;
    this.hap = ctx.hap;
    this.persistFn = ctx.persist;
  }

  protected getOrAddService<T extends WithUUID<typeof Service>>(svc: T, name?: string, subtype?: string): Service {
    const existing = subtype === undefined
      ? this.accessory.getService(svc)
      : this.accessory.getServiceById(svc, subtype);
    if (existing) {
      if (name !== undefined) {
        existing.setCharacteristic(this.Characteristic.Name, name);
      }
      return existing;
    }
    // hap-nodejs Service constructors take (displayName, subtype). The
    // overloaded addService(svc) signature cannot express that mix, so
    // we instantiate ourselves when we need a non-default name/subtype.
    const instance = subtype === undefined
      ? new (svc as unknown as new (displayName: string) => Service)(name ?? this.accessory.displayName)
      : new (svc as unknown as new (displayName: string, subtype: string) => Service)(
        name ?? this.accessory.displayName,
        subtype,
      );
    return this.accessory.addService(instance);
  }

  /**
   * Attach a listener for a CCU datapoint on this accessory. Returns a
   * disposer that is also tracked for automatic cleanup in dispose().
   */
  protected registerListener(address: string, datapoint: string, listener: DatapointListener): () => void {
    const key = `${address}.${datapoint}`;
    const off = this.ccu.registerListener(key, listener);
    this.disposers.push(off);
    return off;
  }

  /**
   * Datapoint this accessory depends on: `apply` runs for every event and
   * with the start value from getParamset on refresh() (at start and
   * after every re-subscribe). Never use it for ACTION datapoints
   * (PRESS_*); those are filtered out of start values anyway.
   */
  protected need(address: string, datapoint: string, apply: DatapointListener): void {
    this.registerListener(address, datapoint, apply);
    this.readOnRefresh(address, datapoint, apply);
  }

  /** Start value only (the event listener is registered elsewhere). */
  protected readOnRefresh(address: string, datapoint: string, apply: DatapointListener): void {
    let dps = this.reads.get(address);
    if (!dps) {
      dps = new Map();
      this.reads.set(address, dps);
    }
    const list = dps.get(datapoint) ?? [];
    list.push(apply);
    dps.set(datapoint, list);
  }

  /**
   * Read every needed channel with one getParamset each and apply the
   * values that are present. Missing values (unreachable device, `{}`,
   * Failure) stay unknown until an event arrives.
   */
  async refresh(): Promise<void> {
    for (const [address, dps] of this.reads) {
      const values = await this.ccu.readValues(address);
      if (!values) {
        continue;
      }
      for (const [dp, appliers] of dps) {
        if (!(dp in values) || this.ccu.isAction(address, dp)) {
          continue;
        }
        for (const apply of appliers) {
          try {
            apply(values[dp]);
          } catch (err) {
            this.log.debug('start value %s.%s rejected: %s', address, dp, (err as Error).message);
          }
        }
      }
    }
  }

  /** Throw "No Response" for a value the CCU has not told us yet (4.2). */
  protected unknown(): never {
    if (this.hap) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    throw new Error('value unknown');
  }

  /**
   * updateCharacteristic with the value clamped to the characteristic's
   * minValue / maxValue / validValues; invalid values are dropped.
   */
  protected update(service: Service, char: WithUUID<new () => Characteristic>, value: CharacteristicValue): void {
    const c = service.getCharacteristic(char) as unknown as { props?: ValueProps };
    const v = clampToProps(value, c.props);
    if (v === undefined) {
      this.log.debug('dropping invalid value %s for %s', String(value), (char as unknown as { name?: string }).name ?? '?');
      return;
    }
    service.updateCharacteristic(char, v as CharacteristicValue);
  }

  /** Save `accessory.context` to Homebridge's accessory cache. */
  protected persist(): void {
    this.persistFn?.();
  }

  /**
   * StatusFault (where the HAP service supports it) while the device is
   * UNREACH (channel 0), the channel's interface is not connected, or
   * `extra()` reports a fault (e.g. ERROR_DEGRADED_CHAMBER).
   * Returns a function to re-evaluate after `extra` changed.
   */
  protected watchFault(service: Service, channelAddress: string, extra: () => boolean = () => false): () => void {
    const supported = FAULT_CAPABLE.some((n) => {
      const ctor = (this.Service as unknown as Record<string, { UUID: string } | undefined>)[n];
      return ctor !== undefined && ctor.UUID === service.UUID;
    });
    let unreach = false;
    const intf: CcuInterfaceId = this.ccu.interfaceOf(channelAddress);
    const evaluate = (): void => {
      if (!supported) {
        return;
      }
      const state = this.ccu.getInterfaceState(intf);
      const linkDown = state !== undefined && state !== 'CONNECTED' && state !== 'CONNECTING';
      const fault = unreach || linkDown || extra();
      service.updateCharacteristic(
        this.Characteristic.StatusFault,
        fault ? this.Characteristic.StatusFault.GENERAL_FAULT : this.Characteristic.StatusFault.NO_FAULT,
      );
    };
    this.need(maintenanceAddress(channelAddress), 'UNREACH', (raw) => {
      unreach = isTrue(raw);
      evaluate();
    });
    const onState = (id: CcuInterfaceId): void => {
      if (id === intf) {
        evaluate();
      }
    };
    this.ccu.on('interfaceState', onState);
    this.disposers.push(() => this.ccu.off('interfaceState', onState));
    evaluate();
    return evaluate;
  }

  /** Tracked async setter that maps thrown errors to a HAP-friendly fault. */
  protected wrapSet<T extends CharacteristicValue>(handler: (v: T) => Promise<void> | void) {
    return async (value: CharacteristicValue) => {
      try {
        await handler(value as T);
      } catch (err) {
        this.log.warn('setValue failed: %s', (err as Error).message);
        if (this.hap && !(err instanceof this.hap.HapStatusError)) {
          throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        throw err;
      }
    };
  }

  protected wrapGet<T extends CharacteristicValue>(handler: () => Promise<T> | T) {
    return async (): Promise<CharacteristicValue> => {
      try {
        const v = await handler();
        return v as CharacteristicValue;
      } catch (err) {
        this.log.debug('get: %s', (err as Error).message);
        throw err;
      }
    };
  }

  /**
   * Attach a HAP BatteryService that mirrors the device-level LOW_BAT
   * (HmIP) / LOWBAT (BidCos) datapoint and OPERATING_VOLTAGE into
   * HomeKit's StatusLowBattery + BatteryLevel characteristics. Battery
   * datapoints live on the device channel (`:0`).
   *
   * Mains-powered devices simply shouldn't call this.
   * `assumeNormal`: report "battery normal" instead of "No Response"
   * while no value is known (smoke detectors, see SmokeAccessory).
   */
  protected attachBattery(featureChannelAddress: string, opts: { assumeNormal?: boolean } = {}): void {
    const deviceAddress = maintenanceAddress(featureChannelAddress);
    const service = this.getOrAddService(this.Service.Battery, undefined, 'battery');
    let lowBat: boolean | undefined;
    let level: number | undefined;

    service.getCharacteristic(this.Characteristic.StatusLowBattery)
      .onGet(this.wrapGet<number>(() => {
        if (lowBat === undefined && !opts.assumeNormal) {
          return this.unknown();
        }
        return lowBat
          ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      }));
    service.getCharacteristic(this.Characteristic.BatteryLevel)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      // Without a voltage reading only LOW_BAT is known: report 100 / 10 %.
      .onGet(this.wrapGet<number>(() => level
        ?? (lowBat === undefined ? (opts.assumeNormal ? 100 : this.unknown()) : lowBat ? 10 : 100)));
    service.getCharacteristic(this.Characteristic.ChargingState)
      .onGet(() => this.Characteristic.ChargingState.NOT_CHARGEABLE);

    const applyLow = (raw: unknown): void => {
      lowBat = isTrue(raw);
      service.updateCharacteristic(
        this.Characteristic.StatusLowBattery,
        lowBat
          ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
    };
    const applyVoltage = (raw: unknown): void => {
      // HmIP devices nominally report 0..4 V; map 2.4..3.2 → 0..100 %.
      // Anything outside that range gets clamped. This is a heuristic;
      // CCU does not surface a real % anywhere.
      const v = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
      if (!Number.isFinite(v)) return;
      const pct = Math.min(100, Math.max(0, Math.round(((v - 2.4) / (3.2 - 2.4)) * 100)));
      level = pct;
      service.updateCharacteristic(this.Characteristic.BatteryLevel, pct);
    };

    this.need(deviceAddress, 'LOW_BAT', applyLow);
    this.need(deviceAddress, 'LOWBAT', applyLow); // BidCos spelling
    this.need(deviceAddress, 'OPERATING_VOLTAGE', applyVoltage);
  }

  dispose(): void {
    while (this.disposers.length > 0) {
      const fn = this.disposers.pop();
      try {
        fn?.();
      } catch (err) {
        this.log.debug('dispose listener error: %s', (err as Error).message);
      }
    }
  }
}
