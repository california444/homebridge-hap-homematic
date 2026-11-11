// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
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

class ThermostatHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private currentTemp = 20;
  private targetTemp = 20;
  private mode = HEATING_OFF;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.Thermostat, channel.name);

    // Read user-pinned target-temperature range; default to the CCU
    // typical 4.5..30.5 °C, which is what RaspberryMatic exposes.
    const settings = (this.accessory.context.settings ?? {}) as {
      minTemp?: number; maxTemp?: number; minStep?: number;
    };
    const minTemp = typeof settings.minTemp === 'number' && Number.isFinite(settings.minTemp)
      ? settings.minTemp : 4.5;
    const maxTemp = typeof settings.maxTemp === 'number' && Number.isFinite(settings.maxTemp) && settings.maxTemp > minTemp
      ? settings.maxTemp : 30.5;
    const minStep = typeof settings.minStep === 'number' && Number.isFinite(settings.minStep) && settings.minStep > 0
      ? settings.minStep : 0.5;

    service.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(this.wrapGet<number>(() => this.currentTemp));

    service.getCharacteristic(this.Characteristic.TargetTemperature)
      .setProps({ minValue: minTemp, maxValue: maxTemp, minStep })
      .onGet(this.wrapGet<number>(() => this.targetTemp))
      .onSet(this.wrapSet<number>(async (value) => {
        this.targetTemp = value;
        await this.ccu.setValue(this.channelAddress, 'SET_TEMPERATURE', value);
      }));

    service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.wrapGet<number>(() => this.deriveCurrentMode()));

    service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [HEATING_OFF, HEATING_HEAT, HEATING_AUTO] })
      .onGet(this.wrapGet<number>(() => this.mode))
      .onSet(this.wrapSet<number>(async (value) => {
        this.mode = value;
        // Auto: set CONTROL_MODE=0; Manual heat: CONTROL_MODE=1; Off: SET_TEMPERATURE=4.5
        if (value === HEATING_OFF) {
          await this.ccu.setValue(this.channelAddress, 'SET_TEMPERATURE', 4.5);
        } else if (value === HEATING_AUTO) {
          await this.ccu.setValue(this.channelAddress, 'AUTO_MODE', true);
        } else {
          await this.ccu.setValue(this.channelAddress, 'MANU_MODE', this.targetTemp);
        }
      }));

    service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.Characteristic.TemperatureDisplayUnits.CELSIUS);

    this.registerListener(this.channelAddress, 'ACTUAL_TEMPERATURE', (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.currentTemp = v;
        service.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
        service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.deriveCurrentMode());
      }
    });

    this.registerListener(this.channelAddress, 'SET_TEMPERATURE', (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.targetTemp = v;
        service.updateCharacteristic(this.Characteristic.TargetTemperature, v);
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
    this.readOnRefresh(this.channelAddress, 'SET_TEMPERATURE', (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.targetTemp = v;
        service.updateCharacteristic(this.Characteristic.TargetTemperature, v);
        service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.deriveCurrentMode());
      }
    });

    // Thermostats are battery-powered (HmIP-eTRV-*, HmIP-WTH-*, etc.).
    // Surface LOW_BAT as a HomeKit BatteryService.
    this.attachBattery(channel.address);
  }

  private deriveCurrentMode(): number {
    if (this.targetTemp <= 4.5) {
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
  build: (ctx: ServiceContext) => new ThermostatHandler(ctx),
};
