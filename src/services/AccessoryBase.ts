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

import type {
  Characteristic,
  CharacteristicValue,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';
import { SetValueError, type CcuClient, type SignalInfo } from '../ccu/CcuClient.js';
import { formatSeconds } from '../ccu/SendQueue.js';
import type { PrefixedLogger } from '../util/logger.js';
import type { AccessoryContext, CcuChannel, CcuInterfaceId } from '../types.js';
import { INPUT_CHANNEL_TYPE, INPUT_MODE_LABELS, toInputMode, type InputMode } from './inputMode.js';
import type { HapStatus, ServiceContext } from './types.js';
import { clampToProps, toFiniteNumber, type ValueProps } from '../util/sanitize.js';

/**
 * Battery percentage without LOW_BAT_LIMIT: 2.4 V = 0 %, 3.2 V = 100 %
 * (two cells). With LOW_BAT_LIMIT from MASTER: 0 % at the limit, 100 %
 * at limit / 0.75. That ratio fits the limits in the device data (1.1 V
 * one cell, 2.2 / 2.4 V two cells, 3.3 V three, 4.4 V four) against
 * fresh cells; a heuristic, the CCU reports no percentage.
 */
const BATTERY_DEFAULT_RANGE: [number, number] = [2.4, 3.2];
const BATTERY_FULL_RATIO = 0.75;

export function batteryPercent(volts: number, lowBatLimit?: number): number {
  const [empty, full] =
    lowBatLimit !== undefined && lowBatLimit > 0
      ? [lowBatLimit, lowBatLimit / BATTERY_FULL_RATIO]
      : BATTERY_DEFAULT_RANGE;
  return Math.min(100, Math.max(0, Math.round(((volts - empty) / (full - empty)) * 100)));
}

export type DatapointListener = (value: unknown) => void;

/** HAP services that have an optional StatusFault characteristic. */
const FAULT_CAPABLE = [
  'SmokeSensor',
  'ContactSensor',
  'LeakSensor',
  'MotionSensor',
  'TemperatureSensor',
  'HumiditySensor',
  'LightSensor',
  'IrrigationSystem',
  'Valve',
  'CarbonMonoxideSensor',
  'CarbonDioxideSensor',
  'AirQualitySensor',
  'OccupancySensor',
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
  /** MASTER reads, run after the start values on refresh(). */
  private readonly masterReads: Array<() => Promise<void>> = [];

  constructor(ctx: ServiceContext) {
    this.accessory = ctx.accessory;
    this.ccu = ctx.ccu;
    this.log = ctx.log;
    this.Service = ctx.Service;
    this.Characteristic = ctx.Characteristic;
    this.hap = ctx.hap;
    this.persistFn = ctx.persist;
    // The command channel: for paired HmIP channels the receiver (e.g. :3),
    // which the accessory does not listen on (state comes from :2).
    const { kind, id } = this.accessory.context;
    if (kind === 'channel' && id) {
      this.disposers.push(this.ccu.setOwner(id, this.reportSetFailure));
    }
  }

  protected getOrAddService<T extends WithUUID<typeof Service>>(
    svc: T,
    name?: string,
    subtype?: string,
  ): Service {
    const existing =
      subtype === undefined
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
    const instance =
      subtype === undefined
        ? new (svc as unknown as new (displayName: string) => Service)(
            name ?? this.accessory.displayName,
          )
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
  protected registerListener(
    address: string,
    datapoint: string,
    listener: DatapointListener,
  ): () => void {
    const key = `${address}.${datapoint}`;
    const off = this.ccu.registerListener(key, listener);
    this.disposers.push(off);
    // Failed commands to this address are logged with this accessory's name.
    this.disposers.push(this.ccu.setOwner(address, this.reportSetFailure));
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
    for (const read of this.masterReads) {
      try {
        await read();
      } catch (err) {
        this.log.debug('MASTER read failed: %s', (err as Error).message);
      }
    }
  }

  /**
   * Run `read` on every refresh(), after the start values, and when the
   * device reports CONFIG_PENDING going back to false (a configuration
   * change in the CCU; MASTER values send no events).
   */
  protected readMasterOnRefresh(channelAddress: string, read: () => Promise<void>): void {
    this.masterReads.push(read);
    let pending = false;
    this.registerListener(maintenanceAddress(channelAddress), 'CONFIG_PENDING', (raw) => {
      const now = isTrue(raw);
      if (pending && !now) {
        void read().catch((err: Error) => this.log.debug('MASTER read failed: %s', err.message));
      }
      pending = now;
    });
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
  protected update(
    service: Service,
    char: WithUUID<new () => Characteristic>,
    value: CharacteristicValue,
  ): void {
    const c = service.getCharacteristic(char) as unknown as { props?: ValueProps };
    const v = clampToProps(value, c.props);
    if (v === undefined) {
      this.log.debug(
        'dropping invalid value %s for %s',
        String(value),
        (char as unknown as { name?: string }).name ?? '?',
      );
      return;
    }
    service.updateCharacteristic(char, v as CharacteristicValue);
  }

  /**
   * Input channels (MULTI_MODE_INPUT_TRANSMITTER): read the operating mode
   * (CHANNEL_OPERATION_MODE, MASTER) on refresh and after a configuration
   * change, and warn once per mode when `check` names a problem, e.g. a
   * button mapping on an input that sends STATE only. Other channel
   * types: nothing.
   */
  protected watchInputMode(
    channel: CcuChannel,
    check: (mode: InputMode) => string | undefined,
  ): void {
    if (channel.type !== INPUT_CHANNEL_TYPE) {
      return;
    }
    let last: InputMode | undefined;
    this.readMasterOnRefresh(channel.address, async () => {
      const master = await this.ccu.readMaster(channel.address);
      const mode = toInputMode(master?.CHANNEL_OPERATION_MODE);
      if (!mode || mode === last) {
        return;
      }
      last = mode;
      const problem = check(mode);
      if (problem) {
        this.log.warn(
          '%s: input %s is set to "%s" in the CCU: %s',
          this.accessory.displayName,
          channel.address,
          INPUT_MODE_LABELS[mode],
          problem,
        );
      }
    });
  }

  /** Run `fn` on dispose() (timers and the like). */
  protected onDispose(fn: () => void): void {
    this.disposers.push(fn);
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
  protected watchFault(
    service: Service,
    channelAddress: string,
    extra: () => boolean = () => false,
  ): () => void {
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
        fault
          ? this.Characteristic.StatusFault.GENERAL_FAULT
          : this.Characteristic.StatusFault.NO_FAULT,
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

  /**
   * Tracked async setter that maps thrown errors to a HAP-friendly fault.
   * setValue only queues the command (plan-sendequeue.md), so HomeKit gets
   * its answer at once; a command the CCU did not deliver is logged later
   * via reportSetFailure.
   */
  protected wrapSet<T extends CharacteristicValue>(handler: (v: T) => Promise<void> | void) {
    return async (value: CharacteristicValue) => {
      try {
        await handler(value as T);
      } catch (err) {
        if (err instanceof SetValueError) {
          void this.logSetFailure(err);
        } else {
          this.log.warn('setValue failed: %s', (err as Error).message);
        }
        if (this.hap && !(err instanceof this.hap.HapStatusError)) {
          throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        throw err;
      }
    };
  }

  /** Owner callback for the CCU client's send queue (see registerListener). */
  private readonly reportSetFailure = (err: SetValueError): void => {
    void this.logSetFailure(err);
  };

  /**
   * One line per failed command: Homebridge name, datapoint and value,
   * time until the answer, the CCU's answer and the last known signal
   * strength, e.g. `Garten Licht: STATE=true not delivered after 1.2 s,
   * (Generic error (UNREACH) (-1)) last known signal:-72 dBm(CCU)/-67 dBm(device)`.
   */
  private async logSetFailure(err: SetValueError): Promise<void> {
    let signal: SignalInfo = {};
    try {
      signal = await this.ccu.signalInfo(err.address);
    } catch {
      // signal is optional
    }
    const parts: string[] = [];
    if (signal.device !== undefined) {
      parts.push(`${signal.device} dBm(CCU)`);
    }
    if (signal.peer !== undefined) {
      parts.push(`${signal.peer} dBm(device)`);
    }
    // The log prefix names the accessory's channel; name others (Sw4 valves).
    const where = this.log.prefix.endsWith(err.address) ? '' : ` on ${err.address}`;
    const signalText = parts.length > 0 ? ` last known signal:${parts.join('/')}` : '';
    if (err.timedOut) {
      this.log.warn(
        '%s: %s=%s%s no answer from the CCU within %s (it may still be sent)%s',
        this.accessory.displayName,
        err.datapoint,
        String(err.value),
        where,
        formatSeconds(err.durationMs ?? 0),
        signalText,
      );
      return;
    }
    const after = err.durationMs !== undefined ? ` after ${formatSeconds(err.durationMs)}` : '';
    this.log.warn(
      '%s: %s=%s%s not delivered%s, (%s)%s',
      this.accessory.displayName,
      err.datapoint,
      String(err.value),
      where,
      after,
      err.reason,
      signalText,
    );
  }

  protected wrapGet<T extends CharacteristicValue>(handler: () => Promise<T> | T) {
    const log = this.log;
    // A plain function, not an arrow: hap-nodejs calls the handler as a
    // method of the Characteristic, so `this.displayName` names the value
    // that is missing ("get CurrentRelativeHumidity: …").
    return async function (this: { displayName?: string } | void): Promise<CharacteristicValue> {
      try {
        const v = await handler();
        return v as CharacteristicValue;
      } catch (err) {
        const name = (this as { displayName?: string } | undefined)?.displayName;
        log.debug('get %s: %s', name ?? '?', (err as Error).message);
        throw err;
      }
    };
  }

  /**
   * attachBattery() only if channel 0 has LOW_BAT / LOWBAT in its paramset
   * description. For channel types found on battery and mains-powered
   * devices alike (push buttons on remotes vs. flush-mount actuators):
   * a mains device would otherwise report "unknown" forever. Without a
   * cached description, a battery service restored from the cache is
   * kept; a description without LOW_BAT removes it.
   */
  protected attachBatteryIfPresent(
    featureChannelAddress: string,
    opts: { assumeNormal?: boolean } = {},
  ): void {
    const description = this.ccu.describeChannel(maintenanceAddress(featureChannelAddress));
    const existing = this.accessory.getServiceById(this.Service.Battery, 'battery');
    const hasBattery = description
      ? 'LOW_BAT' in description || 'LOWBAT' in description
      : existing !== undefined;
    if (hasBattery) {
      this.attachBattery(featureChannelAddress, opts);
    } else if (existing) {
      this.accessory.removeService(existing);
    }
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
  protected attachBattery(
    featureChannelAddress: string,
    opts: { assumeNormal?: boolean } = {},
  ): void {
    const deviceAddress = maintenanceAddress(featureChannelAddress);
    const service = this.getOrAddService(this.Service.Battery, undefined, 'battery');
    let lowBat: boolean | undefined;
    let level: number | undefined;

    service.getCharacteristic(this.Characteristic.StatusLowBattery).onGet(
      this.wrapGet<number>(() => {
        if (lowBat === undefined && !opts.assumeNormal) {
          return this.unknown();
        }
        return lowBat
          ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      }),
    );
    // BatteryLevel (optional in HAP) only for devices that report
    // OPERATING_VOLTAGE. Devices with LOW_BAT / LOWBAT alone show just
    // "battery low" in Home, no made-up percentage. The paramset cache
    // of channel 0 decides; without it the level appears with the first
    // voltage value.
    const description = this.ccu.describeChannel(deviceAddress);
    let levelReady = false;
    const ensureLevel = (): void => {
      if (levelReady) return;
      levelReady = true;
      service
        .getCharacteristic(this.Characteristic.BatteryLevel)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        // Until the first voltage value only LOW_BAT is known: 100 / 10 %.
        .onGet(
          this.wrapGet<number>(
            () =>
              level ??
              (lowBat === undefined
                ? opts.assumeNormal
                  ? 100
                  : this.unknown()
                : lowBat
                  ? 10
                  : 100),
          ),
        );
    };
    const hasLevel = service.testCharacteristic(this.Characteristic.BatteryLevel);
    if (description ? 'OPERATING_VOLTAGE' in description : hasLevel) {
      ensureLevel();
    } else if (description && hasLevel) {
      // Cached accessory from a version that showed 100 / 10 %.
      service.removeCharacteristic(service.getCharacteristic(this.Characteristic.BatteryLevel));
    }
    service
      .getCharacteristic(this.Characteristic.ChargingState)
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
    // Scale from LOW_BAT_LIMIT (MASTER of channel 0, on the device for
    // BidCos); the last known limit is kept in the context.
    const store = this.accessory.context as unknown as { battery?: { lowBatLimit?: number } };
    let voltage: number | undefined;
    const applyVoltage = (raw: unknown): void => {
      const v = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
      if (!Number.isFinite(v)) return;
      voltage = v;
      const pct = batteryPercent(v, store.battery?.lowBatLimit);
      level = pct;
      ensureLevel();
      service.updateCharacteristic(this.Characteristic.BatteryLevel, pct);
    };

    this.need(deviceAddress, 'LOW_BAT', applyLow);
    this.need(deviceAddress, 'LOWBAT', applyLow); // BidCos spelling
    this.need(deviceAddress, 'OPERATING_VOLTAGE', applyVoltage);

    if (description && !('OPERATING_VOLTAGE' in description)) {
      return; // no percentage, no limit needed
    }
    const serial = deviceAddress.split(':')[0]!;
    this.readMasterOnRefresh(featureChannelAddress, async () => {
      let limit: number | undefined;
      for (const address of [deviceAddress, serial]) {
        const v = toFiniteNumber((await this.ccu.readMaster(address))?.LOW_BAT_LIMIT);
        if (v !== undefined && v > 0) {
          limit = v;
          break;
        }
      }
      if (limit === undefined || store.battery?.lowBatLimit === limit) {
        return;
      }
      store.battery = { ...store.battery, lowBatLimit: limit };
      this.persist();
      this.log.debug('%s: battery low at %s V', this.accessory.displayName, limit);
      if (voltage !== undefined) {
        applyVoltage(voltage);
      }
    });
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
