// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Weather station accessory: combines TemperatureSensor +
 * HumiditySensor + LightSensor + LeakSensor (rain) on a single
 * HomeKit accessory. Targets HmIP-SWO-PR (Pro), HmIP-SWO-PL+ and
 * HmIP-SWO-B which all expose a WEATHER_TRANSMIT channel with a
 * superset of the relevant datapoints. Each sub-service updates only
 * if the corresponding datapoint is actually pushed by the device,
 * so the simpler PL/B variants don't show stale "0 lux" or "no rain"
 * readings — they get the default and stay there until an event
 * arrives.
 *
 * Maps to upstream issues #519, #548, #565, #653 in thkl/hap-homematic.
 */

import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { toFiniteNumber, toRanged } from '../../util/sanitize.js';

const WEATHER_CHANNEL_TYPES = [
  'WEATHER_TRANSMIT',
  // Some firmwares put a separate "WEATHER" channel in addition to
  // the transmit channel — we accept both so the auto-pick lands on
  // the right one regardless.
  'WEATHER',
];

class WeatherStationHandler extends AccessoryBase implements ChannelService {
  private temp = 20;
  private humidity = 50;
  private lux = 1;
  private raining = false;

  attach(channel: CcuChannel): void {
    const baseName = channel.name || this.accessory.displayName;
    const tempSvc  = this.getOrAddService(this.Service.TemperatureSensor, `${baseName} Temperature`, 'weather-temp');
    const humSvc   = this.getOrAddService(this.Service.HumiditySensor,    `${baseName} Humidity`,    'weather-hum');
    const lightSvc = this.getOrAddService(this.Service.LightSensor,       `${baseName} Light`,       'weather-light');
    const rainSvc  = this.getOrAddService(this.Service.LeakSensor,        `${baseName} Rain`,        'weather-rain');

    tempSvc.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(this.wrapGet<number>(() => this.temp));

    humSvc.getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .onGet(this.wrapGet<number>(() => this.humidity));

    lightSvc.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
      .setProps({ minValue: 0.0001, maxValue: 100000, minStep: 0.0001 })
      .onGet(this.wrapGet<number>(() => this.lux));

    rainSvc.getCharacteristic(this.Characteristic.LeakDetected)
      .onGet(this.wrapGet<number>(() => this.raining
        ? this.Characteristic.LeakDetected.LEAK_DETECTED
        : this.Characteristic.LeakDetected.LEAK_NOT_DETECTED));

    // --- live updates ---------------------------------------------

    const applyTemp = (raw: unknown): void => {
      const v = toFiniteNumber(raw);
      if (v === undefined) return;
      this.temp = v;
      tempSvc.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
    };
    const applyHum = (raw: unknown): void => {
      const before = this.humidity;
      const v = toRanged(raw, 0, 100, before);
      if (v === before && raw !== before) return;
      this.humidity = Math.round(v);
      humSvc.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, this.humidity);
    };
    const applyLux = (raw: unknown): void => {
      const v = toFiniteNumber(raw);
      if (v === undefined) return;
      // ILLUMINATION on HmIP-SWO is reported in lux directly; clamp to
      // HAP's accepted range so very low/high readings don't trip the
      // "0 minStep" assertion.
      this.lux = Math.max(0.0001, Math.min(100000, v));
      lightSvc.updateCharacteristic(this.Characteristic.CurrentAmbientLightLevel, this.lux);
    };
    const applyRain = (raw: unknown): void => {
      const v = raw === true || raw === 1 || raw === '1' || raw === 'true';
      this.raining = v;
      rainSvc.updateCharacteristic(this.Characteristic.LeakDetected, v
        ? this.Characteristic.LeakDetected.LEAK_DETECTED
        : this.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
    };

    this.registerListener(channel.address, 'TEMPERATURE',  applyTemp);
    this.registerListener(channel.address, 'ACTUAL_TEMPERATURE', applyTemp);
    this.registerListener(channel.address, 'HUMIDITY',     applyHum);
    this.registerListener(channel.address, 'ILLUMINATION', applyLux);
    this.registerListener(channel.address, 'BRIGHTNESS',   applyLux);
    this.registerListener(channel.address, 'RAINING',      applyRain);

    // Best-effort initial pulls so HomeKit reflects current state
    // immediately rather than waiting for the next CCU push. Same
    // apply* functions as above — tested via fireEvent.
    /* v8 ignore start */
    this.readOnRefresh(channel.address, 'TEMPERATURE', applyTemp);
    this.readOnRefresh(channel.address, 'HUMIDITY', applyHum);
    this.readOnRefresh(channel.address, 'ILLUMINATION', applyLux);
    this.readOnRefresh(channel.address, 'RAINING', applyRain);
    /* v8 ignore stop */

    this.attachBattery(channel.address);
  }
}

export const weatherStationService: ServiceDefinition = {
  key: 'WeatherStationAccessory',
  description: 'Weather station (temperature + humidity + light + rain)',
  channelTypes: WEATHER_CHANNEL_TYPES,
  // Lower priority than TemperatureAccessory (20) so weather stations
  // get this richer mapping by default. Plain temperature sensors that
  // share the WEATHER channel type can still opt back to the simpler
  // TemperatureAccessory via the service dropdown in the UI.
  priority: 5,
  build: (ctx: ServiceContext) => new WeatherStationHandler(ctx),
};
