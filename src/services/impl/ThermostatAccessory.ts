// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase } from '../AccessoryBase.js';
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

/**
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

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const dialect = this.dialectFor(channel.type);
    const service = this.getOrAddService(this.Service.Thermostat, channel.name);

    // Read user-pinned target-temperature range; default to the CCU
    // typical 4.5..30.5 °C, which is what RaspberryMatic exposes.
    const settings = (this.accessory.context.settings ?? {}) as {
      minTemp?: number;
      maxTemp?: number;
      minStep?: number;
      showHumidity?: unknown;
    };
    const minTemp =
      typeof settings.minTemp === 'number' && Number.isFinite(settings.minTemp)
        ? settings.minTemp
        : 4.5;
    const maxTemp =
      typeof settings.maxTemp === 'number' &&
      Number.isFinite(settings.maxTemp) &&
      settings.maxTemp > minTemp
        ? settings.maxTemp
        : 30.5;
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
      .onGet(this.wrapGet<number>(() => this.targetTemp))
      .onSet(
        this.wrapSet<number>(async (value) => {
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
            this.applyTarget(OFF_TEMP);
            await dialect.setManual(OFF_TEMP);
          } else if (value === HEATING_AUTO) {
            await dialect.setAuto();
          } else {
            const temp = this.targetTemp > OFF_TEMP ? this.targetTemp : this.lastHeatTemp;
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
        this.pushState(service);
      }
    });

    this.need(this.channelAddress, dialect.modeState, (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.ccuMode = v;
        this.pushState(service);
      }
    });

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
   */
  private attachHumidity(service: Service, datapoint: string, show: boolean): void {
    const C = this.Characteristic.CurrentRelativeHumidity;
    if (!show) {
      if (service.testCharacteristic(C)) {
        service.removeCharacteristic(service.getCharacteristic(C));
      }
      return;
    }
    let humidity: number | undefined;
    service
      .getCharacteristic(C)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.wrapGet<number>(() => humidity ?? this.unknown()));
    this.need(this.channelAddress, datapoint, (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        humidity = Math.min(100, Math.max(0, Math.round(v)));
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
        setManual: async (temp) => {
          await this.ccu.setValue(address, 'CONTROL_MODE', 1);
          await this.ccu.setValue(address, 'SET_POINT_TEMPERATURE', temp);
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

  private applyTarget(temp: number): void {
    this.targetTemp = temp;
    if (temp > OFF_TEMP) {
      this.lastHeatTemp = temp;
    }
  }

  private pushState(service: Service): void {
    service.updateCharacteristic(this.Characteristic.TargetTemperature, this.targetTemp);
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
   * Auto from the CCU mode; otherwise Off at the off set point, else Heat.
   * Without a CCU mode (groups after a CCU restart): the mode chosen in
   * Home, else the set point decides.
   */
  private deriveTargetMode(): number {
    if (this.ccuMode === undefined && this.mode !== undefined) {
      return this.mode;
    }
    if (this.ccuMode === 0) {
      return HEATING_AUTO;
    }
    return this.targetTemp <= OFF_TEMP ? HEATING_OFF : HEATING_HEAT;
  }

  private deriveCurrentMode(): number {
    if (this.targetTemp <= OFF_TEMP) {
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
      hint:
        'Humidity on the thermostat in Home. Only for devices with a humidity sensor (wall thermostats) ' +
        'or heating groups with one as member; an empty group reports placeholder values.',
    },
  ],
  build: (ctx: ServiceContext) => new ThermostatHandler(ctx),
};
