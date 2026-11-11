// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { normalizeLevelToPercent, percentToLevelFraction } from '../../util/sanitize.js';

const DIMMER_CHANNEL_TYPES = [
  'DIMMER',
  'DIMMER_VIRTUAL_RECEIVER',
];

class DimmerHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private cachedLevel = 0;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.Lightbulb, channel.name);

    service.getCharacteristic(this.Characteristic.On)
      .onGet(this.wrapGet<boolean>(() => this.cachedLevel > 0))
      .onSet(this.wrapSet<boolean>(async (value) => {
        const pct = value ? Math.max(this.cachedLevel, 1) : 0;
        await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(pct));
      }));

    service.getCharacteristic(this.Characteristic.Brightness)
      .onGet(this.wrapGet<number>(() => this.cachedLevel))
      .onSet(this.wrapSet<number>(async (value) => {
        const pct = normalizeLevelToPercent(value) ?? 0;
        this.cachedLevel = pct;
        await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(pct));
      }));

    const stateAddress = channel.stateAddress ?? channel.address; // HmIP: DIMMER_TRANSMITTER
    this.registerListener(stateAddress, 'LEVEL', (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === undefined) {
        return;
      }
      this.cachedLevel = pct;
      service.updateCharacteristic(this.Characteristic.On, pct > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, pct);
    });

    this.readOnRefresh(stateAddress, 'LEVEL', (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === undefined) {
        return;
      }
      this.cachedLevel = pct;
      service.updateCharacteristic(this.Characteristic.On, pct > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, pct);
    });
  }
}

export const dimmerService: ServiceDefinition = {
  key: 'DimmerAccessory',
  description: 'Dimmable light',
  channelTypes: DIMMER_CHANNEL_TYPES,
  priority: 10,
  build: (ctx: ServiceContext) => new DimmerHandler(ctx),
};
