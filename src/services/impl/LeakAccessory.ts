// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';

const LEAK_CHANNEL_TYPES = [
  'WATERDETECTIONSENSOR',
  'TILT_SENSOR',
];

class LeakHandler extends AccessoryBase implements ChannelService {
  private detected = false;

  attach(channel: CcuChannel): void {
    const service = this.getOrAddService(this.Service.LeakSensor, channel.name);

    service.getCharacteristic(this.Characteristic.LeakDetected)
      .onGet(this.wrapGet<number>(() => this.toHapValue()));

    this.registerListener(channel.address, 'STATE', (raw) => {
      this.detected = Boolean(raw);
      service.updateCharacteristic(this.Characteristic.LeakDetected, this.toHapValue());
    });

    this.readOnRefresh(channel.address, 'STATE', (raw) => {
      this.detected = Boolean(raw);
      service.updateCharacteristic(this.Characteristic.LeakDetected, this.toHapValue());
    });

    this.attachBattery(channel.address);
  }

  private toHapValue(): number {
    return this.detected
      ? this.Characteristic.LeakDetected.LEAK_DETECTED
      : this.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
  }
}

export const leakService: ServiceDefinition = {
  key: 'LeakAccessory',
  description: 'Water / leak sensor',
  channelTypes: LEAK_CHANNEL_TYPES,
  priority: 15,
  build: (ctx: ServiceContext) => new LeakHandler(ctx),
};
