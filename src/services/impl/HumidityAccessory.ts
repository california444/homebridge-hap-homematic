// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { toRanged } from '../../util/sanitize.js';

const HUMIDITY_CHANNEL_TYPES = [
  'WEATHER',
  'WEATHER_TRANSMIT',
  'CLIMATE_TRANSCEIVER',
  'HUMIDITY_SENSOR',
];

class HumidityHandler extends AccessoryBase implements ChannelService {
  private value = 50;

  attach(channel: CcuChannel): void {
    const service = this.getOrAddService(this.Service.HumiditySensor, channel.name);

    service.getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .onGet(this.wrapGet<number>(() => this.value));

    const apply = (raw: unknown): void => {
      const before = this.value;
      const v = toRanged(raw, 0, 100, before);
      if (v === before && raw !== before) {
        // Input was unusable; toRanged returned the fallback. Skip the
        // characteristic update so HomeKit isn't told the same value
        // again on every spurious event.
        return;
      }
      this.value = Math.round(v);
      service.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, this.value);
    };

    this.registerListener(channel.address, 'HUMIDITY', apply);

    this.readOnRefresh(channel.address, 'HUMIDITY', apply);

    this.attachBattery(channel.address);
  }
}

export const humidityService: ServiceDefinition = {
  key: 'HumidityAccessory',
  description: 'Humidity sensor',
  channelTypes: HUMIDITY_CHANNEL_TYPES,
  priority: 30,
  build: (ctx: ServiceContext) => new HumidityHandler(ctx),
};
