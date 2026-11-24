// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase, isTrue } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { Service } from 'homebridge';
import type { CcuChannel } from '../../types.js';
import { toFiniteNumber } from '../../util/sanitize.js';

const THERMOSTAT_CHANNEL_TYPES = [
  'CLIMATECONTROL_REGULATOR',
  'CLIMATECONTROL_RT_TRANSCEIVER',
  'HEATING_CLIMATECONTROL_TRANSCEIVER',
  'THERMALCONTROL_TRANSMIT',
];

const HEATING_OFF = 0;
const HEATING_HEAT = 1;
const HEATING_AUTO = 3;

/** Set point the CCU treats as "valve closed" on both radio systems. */
const OFF_TEMP = 4.5;
/** Set point used for Heat after Off when no earlier target is known. */
const DEFAULT_HEAT_TEMP = 20;
/** Range of the target temperature without user options or MASTER limits. */
const DEFAULT_MIN_TEMP = OFF_TEMP;
const DEFAULT_MAX_TEMP = 30.5;
/**
 * After Off from Home, a heating group passes on its members' reports one
 * by one for several seconds (20 → 18 → 5 → 18 → 5 in #42). Meanwhile the
 * accessory stays Off whatever arrives.
 */
const OFF_GRACE_MS = 15_000;

/**
 * Set point limits from the MASTER paramset (TEMPERATURE_MINIMUM /
 * TEMPERATURE_MAXIMUM). With MIN_MAX_VALUE_NOT_RELEVANT_FOR_MANU_MODE they
 * do not apply in manual mode, which is what Home always writes.
 */
interface SetPointLimits {
  min: number;
  max: number;
  notInManu: boolean;
}

/** Persisted in accessory.context.thermostat. */
interface ThermostatContext {
  limits?: SetPointLimits;
  /** Off was chosen in Home and not undone since. */
  offRequested?: boolean;
}

/**
 * Off on a device whose minimum set point is above 4.5 °C: the device
 * raises the written 4.5 to its minimum (HmIP-eTRV-B and HmIP-WTH-2 ship
 * with 5.0 °C) and reports that back. Without more, Home would show
 * "Heat 5 °C" right after Off (#42). So the accessory remembers that Off
 * was chosen in Home and keeps showing Off while the device stays in
 * manual mode at or below its minimum. A higher set point or Auto from
 * the CCU ends that, as do Heat, Auto or a temperature from Home.
 *
 * Datapoint names differ between the two radio systems:
 *   HmIP  (HEATING_CLIMATECONTROL_TRANSCEIVER): SET_POINT_TEMPERATURE,
 *         CONTROL_MODE (write: 0 auto, 1 manual), SET_POINT_MODE (read).
 *   BidCos (CLIMATECONTROL_RT_TRANSCEIVER, THERMALCONTROL_TRANSMIT,
 *         CLIMATECONTROL_REGULATOR): SET_TEMPERATURE, AUTO_MODE /
 *         MANU_MODE (actions), CONTROL_MODE (read).
 * In both cases the read-back mode is 0 = auto, 1 = manual, 2 = party,
 * 3 = boost. Humidity (wall thermostats, heating groups with one):
 * HUMIDITY (HmIP), ACTUAL_HUMIDITY (BidCos).
 *
 * Heating groups (VirtualDevices, plan-gruppen 3.6) use the same channel
 * types. HM-CC-VG-1 sends every value as a string (toFiniteNumber takes
 * both). A group may lack SET_POINT_MODE after a CCU restart and never
 * reports LOW_BAT unless a member does.
 */
interface ThermostatDialect {
  setPoint: string;
  modeState: string;
  humidity: string;
  setAuto(): Promise<void>;
  setManual(temp: number): Promise<void>;
}

class ThermostatHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private currentTemp = 20;
  private targetTemp = 20;
  /** Last target above OFF_TEMP, restored when switching Off → Heat. */
  private lastHeatTemp = DEFAULT_HEAT_TEMP;
  /** Mode last chosen in Home; undefined until then. */
  private mode: number | undefined;
  /** Mode reported by the CCU; undefined until the first value arrives. */
  private ccuMode: number | undefined;
  private service: Service | undefined;
  /** Range from the mapping options (minTemp / maxTemp), they win over MASTER. */
  private userMin: number | undefined;
  private userMax: number | undefined;
  /** When Off was chosen in Home (0: not in this run). */
  private offRequestedAt = 0;
  private offGraceTimer: ReturnType<typeof setTimeout> | undefined;
  private offNoticeLogged = false;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const dialect = this.dialectFor(channel.type);
    const service = this.getOrAddService(this.Service.Thermostat, channel.name);

    this.service = service;

    // Target temperature range: the mapping options minTemp / maxTemp
    // win; otherwise the MASTER limits of the device (last known value
    // from the context, refreshed in refresh()); otherwise 4.5..30.5 °C.
    const settings = (this.accessory.context.settings ?? {}) as {
      minTemp?: number;
      maxTemp?: number;
      minStep?: number;
      showHumidity?: unknown;
    };
    this.userMin =
      typeof settings.minTemp === 'number' && Number.isFinite(settings.minTemp)
        ? settings.minTemp
        : undefined;
    this.userMax =
      typeof settings.maxTemp === 'number' && Number.isFinite(settings.maxTemp)
        ? settings.maxTemp
        : undefined;
    const { min: minTemp, max: maxTemp } = this.range();
    const minStep =
      typeof settings.minStep === 'number' &&
      Number.isFinite(settings.minStep) &&
      settings.minStep > 0
        ? settings.minStep
        : 0.5;

    service
      .getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(this.wrapGet<number>(() => this.currentTemp));

    service
      .getCharacteristic(this.Characteristic.TargetTemperature)
      .setProps({ minValue: minTemp, maxValue: maxTemp, minStep })
      .onGet(this.wrapGet<number>(() => this.shownTarget()))
      .onSet(
        this.wrapSet<number>(async (value) => {
          this.clearOff();
          this.applyTarget(value);
          await this.ccu.setValue(this.channelAddress, dialect.setPoint, value);
        }),
      );

    service
      .getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.wrapGet<number>(() => this.deriveCurrentMode()));

    service
      .getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [HEATING_OFF, HEATING_HEAT, HEATING_AUTO] })
      .onGet(this.wrapGet<number>(() => this.deriveTargetMode()))
      .onSet(
        this.wrapSet<number>(async (value) => {
          this.mode = value;
          this.ccuMode = undefined;
          if (value === HEATING_OFF) {
            this.requestOff();
            this.applyTarget(OFF_TEMP);
            await dialect.setManual(OFF_TEMP);
          } else if (value === HEATING_AUTO) {
            this.clearOff();
            await dialect.setAuto();
          } else {
            const wasOff = this.isOff();
            this.clearOff();
            const { min, max } = this.range();
            const restore = wasOff || this.targetTemp <= OFF_TEMP;
            const temp = Math.min(
              max,
              Math.max(min, restore ? this.lastHeatTemp : this.targetTemp),
            );
            this.applyTarget(temp);
            await dialect.setManual(temp);
          }
        }),
      );

    service
      .getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.Characteristic.TemperatureDisplayUnits.CELSIUS);

    this.registerListener(this.channelAddress, 'ACTUAL_TEMPERATURE', (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.currentTemp = v;
        service.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
        service.updateCharacteristic(
          this.Characteristic.CurrentHeatingCoolingState,
          this.deriveCurrentMode(),
        );
      }
    });

    this.need(this.channelAddress, dialect.setPoint, (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.applyTarget(v);
        this.checkOff();
        this.pushState(service);
      }
    });

    this.need(this.channelAddress, dialect.modeState, (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.ccuMode = v;
        this.checkOff();
        this.pushState(service);
      }
    });

    // Set point limits from MASTER: at start, after re-subscribe and
    // after a configuration change in the CCU.
    this.readMasterOnRefresh(this.channelAddress, () => this.readLimits());
    this.onDispose(() => clearTimeout(this.offGraceTimer));

    // Pull initial state so the accessory reflects current values
    // immediately rather than waiting for the next push event.
    this.readOnRefresh(this.channelAddress, 'ACTUAL_TEMPERATURE', (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.currentTemp = v;
        service.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
      }
    });

    this.attachHumidity(service, dialect.humidity, settings.showHumidity === true);

    // Thermostats are battery-powered (HmIP-eTRV-*, HmIP-WTH-*, etc.).
    // Surface LOW_BAT as a HomeKit BatteryService. A heating group has
    // no LOW_BAT value of its own until a member reports one: "normal"
    // instead of "No Response" meanwhile.
    const isGroup = this.ccu.interfaceOf(channel.address) === 'VirtualDevices';
    this.attachBattery(channel.address, { assumeNormal: isGroup });
  }

  /**
   * Option showHumidity (off by default): CurrentRelativeHumidity on the
   * thermostat. Only useful with a sensor (wall thermostat; a heating
   * group with one as member). Empty groups report placeholders.
   *
   * Like the battery level, it needs the datapoint in the channel's
   * paramset description: radiator thermostats have none and would show
   * "No Response" forever. Without a cached description the
   * characteristic appears with the first value (a restored one stays).
   */
  private attachHumidity(service: Service, datapoint: string, show: boolean): void {
    const C = this.Characteristic.CurrentRelativeHumidity;
    const description = this.ccu.describeChannel(this.channelAddress);
    const exists = service.testCharacteristic(C);
    const remove = (): void => {
      if (service.testCharacteristic(C)) {
        service.removeCharacteristic(service.getCharacteristic(C));
      }
    };
    if (!show) {
      remove();
      return;
    }
    if (description && !(datapoint in description)) {
      remove();
      this.log.info(
        '%s: option "Show humidity" ignored, channel %s has no %s',
        this.accessory.displayName,
        this.channelAddress,
        datapoint,
      );
      return;
    }
    let humidity: number | undefined;
    let ready = false;
    const ensure = (): void => {
      if (ready) return;
      ready = true;
      service
        .getCharacteristic(C)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onGet(this.wrapGet<number>(() => humidity ?? this.unknown()));
    };
    if (description || exists) {
      ensure();
    }
    this.need(this.channelAddress, datapoint, (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        humidity = Math.min(100, Math.max(0, Math.round(v)));
        ensure();
        service.updateCharacteristic(C, humidity);
      }
    });
  }

  private dialectFor(channelType: string): ThermostatDialect {
    const address = this.channelAddress;
    if (channelType === 'HEATING_CLIMATECONTROL_TRANSCEIVER') {
      return {
        setPoint: 'SET_POINT_TEMPERATURE',
        modeState: 'SET_POINT_MODE',
        humidity: 'HUMIDITY',
        setAuto: () => this.ccu.setValue(address, 'CONTROL_MODE', 0),
        // Mode and set point in one putParamset, as aiohomematic, RedMatic
        // and matterbridge-homematic do: two setValue calls made a group
        // report the old set point in manual mode first (#42).
        setManual: async (temp) => {
          this.ccu.setValues(
            address,
            [
              ['CONTROL_MODE', 1],
              ['SET_POINT_TEMPERATURE', temp],
            ],
            { together: true },
          );
        },
      };
    }
    return {
      setPoint: 'SET_TEMPERATURE',
      modeState: 'CONTROL_MODE',
      humidity: 'ACTUAL_HUMIDITY',
      setAuto: () => this.ccu.setValue(address, 'AUTO_MODE', true),
      setManual: (temp) => this.ccu.setValue(address, 'MANU_MODE', temp),
    };
  }

  /**
   * TEMPERATURE_MINIMUM / MAXIMUM from MASTER: HmIP keeps them on the
   * thermostat channel, BidCos and HM-CC-VG-1 on the device. Unknown
   * (no answer, no such parameters): the last known limits stay.
   */
  private async readLimits(): Promise<void> {
    const device = this.channelAddress.split(':')[0]!;
    let limits: SetPointLimits | undefined;
    for (const address of [this.channelAddress, device]) {
      const values = await this.ccu.readMaster(address);
      const min = toFiniteNumber(values?.TEMPERATURE_MINIMUM);
      const max = toFiniteNumber(values?.TEMPERATURE_MAXIMUM);
      if (min !== undefined && max !== undefined && min < max) {
        limits = { min, max, notInManu: isTrue(values?.MIN_MAX_VALUE_NOT_RELEVANT_FOR_MANU_MODE) };
        break;
      }
    }
    if (!limits) {
      return;
    }
    const store = this.store();
    const old = store.limits;
    if (
      old &&
      old.min === limits.min &&
      old.max === limits.max &&
      old.notInManu === limits.notInManu
    ) {
      return;
    }
    store.limits = limits;
    this.persist();
    this.log.debug(
      '%s: set point limits %s..%s °C%s',
      this.accessory.displayName,
      limits.min,
      limits.max,
      limits.notInManu ? ' (not in manual mode)' : '',
    );
    if (this.service) {
      const { min, max } = this.range();
      // A new range bumps the bridge's configuration number; Home reloads it.
      this.service
        .getCharacteristic(this.Characteristic.TargetTemperature)
        .setProps({ minValue: min, maxValue: max });
      this.checkOff();
      this.pushState(this.service);
    }
  }

  /** Target temperature range shown in Home (see attach). */
  private range(): { min: number; max: number } {
    const limits = this.activeLimits();
    const min = this.userMin ?? limits?.min ?? DEFAULT_MIN_TEMP;
    let max = this.userMax ?? limits?.max ?? DEFAULT_MAX_TEMP;
    if (max <= min) {
      max = Math.max(min + 0.5, DEFAULT_MAX_TEMP);
    }
    return { min, max };
  }

  /** MASTER limits that apply to what Home writes (manual mode). */
  private activeLimits(): SetPointLimits | undefined {
    const limits = this.store().limits;
    return limits && !limits.notInManu ? limits : undefined;
  }

  /**
   * Highest set point the device may report for Off: 4.5 °C, or its
   * minimum if that is higher and also applies in manual mode.
   */
  private offLimit(): number {
    return Math.max(OFF_TEMP, this.activeLimits()?.min ?? OFF_TEMP);
  }

  private store(): ThermostatContext {
    const ctx = this.accessory.context as unknown as { thermostat?: ThermostatContext };
    ctx.thermostat ??= {};
    return ctx.thermostat;
  }

  private inOffGrace(): boolean {
    return this.offRequestedAt > 0 && Date.now() - this.offRequestedAt < OFF_GRACE_MS;
  }

  private requestOff(): void {
    this.store().offRequested = true;
    this.persist();
    this.offRequestedAt = Date.now();
    clearTimeout(this.offGraceTimer);
    // When the grace ends, settle on what the device reports by then.
    this.offGraceTimer = setTimeout(() => {
      this.offRequestedAt = 0;
      this.checkOff();
      if (this.service) this.pushState(this.service);
    }, OFF_GRACE_MS);
  }

  private clearOff(): void {
    clearTimeout(this.offGraceTimer);
    this.offRequestedAt = 0;
    if (this.store().offRequested) {
      this.store().offRequested = false;
      this.persist();
    }
  }

  /**
   * Outside the grace time: Off chosen in Home ends when the CCU reports
   * Auto or a set point above the off limit (changed on the device or in
   * the CCU).
   */
  private checkOff(): void {
    if (!this.store().offRequested || this.inOffGrace()) {
      return;
    }
    if (this.ccuMode === 0 || this.targetTemp > this.offLimit()) {
      this.clearOff();
      return;
    }
    if (this.targetTemp > OFF_TEMP && !this.offNoticeLogged) {
      this.offNoticeLogged = true;
      this.log.info(
        '%s: Off is reported as %s °C, the minimum set point configured in the CCU',
        this.accessory.displayName,
        this.targetTemp,
      );
    }
  }

  /** Off at the off set point, or Off chosen in Home (see the class comment). */
  private isOff(): boolean {
    if (this.targetTemp <= OFF_TEMP) {
      return true;
    }
    if (!this.store().offRequested) {
      return false;
    }
    return this.inOffGrace() || (this.ccuMode !== 0 && this.targetTemp <= this.offLimit());
  }

  /** The target temperature within the range shown in Home. */
  private shownTarget(): number {
    const { min, max } = this.range();
    return Math.min(max, Math.max(min, this.targetTemp));
  }

  /**
   * A set point above 4.5 °C is the temperature Heat restores after Off,
   * also the device minimum chosen in Home. Not while Off chosen in Home
   * is pending: then the device reports its minimum (or a group its
   * members one by one), which is no heating temperature.
   */
  private applyTarget(temp: number): void {
    this.targetTemp = temp;
    if (temp > OFF_TEMP && !this.store().offRequested && !this.inOffGrace()) {
      this.lastHeatTemp = temp;
    }
  }

  private pushState(service: Service): void {
    service.updateCharacteristic(this.Characteristic.TargetTemperature, this.shownTarget());
    service.updateCharacteristic(
      this.Characteristic.TargetHeatingCoolingState,
      this.deriveTargetMode(),
    );
    service.updateCharacteristic(
      this.Characteristic.CurrentHeatingCoolingState,
      this.deriveCurrentMode(),
    );
  }

  /**
   * Off (see isOff) in every mode, also Auto with a 4.5 °C slot in the
   * week program; otherwise Auto from the CCU mode, else Heat. Without a
   * CCU mode (groups after a CCU restart): the mode chosen in Home.
   */
  private deriveTargetMode(): number {
    if (this.ccuMode === undefined && this.mode !== undefined) {
      return this.mode;
    }
    if (this.isOff()) {
      return HEATING_OFF;
    }
    return this.ccuMode === 0 ? HEATING_AUTO : HEATING_HEAT;
  }

  private deriveCurrentMode(): number {
    if (this.isOff()) {
      return HEATING_OFF;
    }
    return this.targetTemp > this.currentTemp ? HEATING_HEAT : HEATING_OFF;
  }
}

export const thermostatService: ServiceDefinition = {
  key: 'ThermostatAccessory',
  description: 'Heating thermostat',
  channelTypes: THERMOSTAT_CHANNEL_TYPES,
  priority: 10,
  options: [
    {
      key: 'showHumidity',
      label: 'Show humidity',
      type: 'boolean',
      default: false,
      datapoints: ['HUMIDITY', 'ACTUAL_HUMIDITY'],
      hint:
        'Humidity on the thermostat in Home. Only for devices with a humidity sensor (wall thermostats) ' +
        'or heating groups with one as member; an empty group reports placeholder values. ' +
        'Ignored for channels without a humidity datapoint (radiator thermostats).',
    },
  ],
  build: (ctx: ServiceContext) => new ThermostatHandler(ctx),
};
