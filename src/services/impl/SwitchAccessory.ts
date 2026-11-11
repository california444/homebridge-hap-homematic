// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase, isTrue } from '../AccessoryBase.js';
import type {
  ChannelService,
  ServiceContext,
  ServiceDefinition,
} from '../types.js';
import type { CcuChannel } from '../../types.js';

const SWITCH_CHANNEL_TYPES = [
  'SWITCH',
  'SWITCH_VIRTUAL_RECEIVER',
  'SWITCH_TRANSMITTER',
  'VIRTUAL_DEVICES_SWITCH',
];

/**
 * Binary actuator as Switch / Outlet / Lightbulb. HmIP: the state comes
 * from the SWITCH_TRANSMITTER (`stateAddress`), commands go to the first
 * SWITCH_VIRTUAL_RECEIVER (`address`), see ccu/pairing.ts. Unknown state
 * (device unreachable at start) → "No Response" until an event arrives.
 */
class SwitchHandler extends AccessoryBase implements ChannelService {
  private on: boolean | undefined;

  attach(channel: CcuChannel): void {
    const subtype = (this.accessory.context.subtype ?? 'switch').toLowerCase();
    const svcType = subtype === 'outlet'
      ? this.Service.Outlet
      : subtype === 'lightbulb'
        ? this.Service.Lightbulb
        : this.Service.Switch;
    const service = this.getOrAddService(svcType, channel.name);

    service.getCharacteristic(this.Characteristic.On)
      .onGet(this.wrapGet<boolean>(() => this.on ?? this.unknown()))
      .onSet(this.wrapSet<boolean>(async (value) => {
        await this.ccu.setValue(channel.address, 'STATE', Boolean(value));
        if (!channel.stateAddress) {
          this.on = Boolean(value); // BidCos: the event confirms it
        }
      }));

    this.need(channel.stateAddress ?? channel.address, 'STATE', (raw) => {
      this.on = isTrue(raw);
      this.update(service, this.Characteristic.On, this.on);
    });
  }
}

export const switchService: ServiceDefinition = {
  key: 'SwitchAccessory',
  description: 'Binary switch (Switch / Outlet / Lightbulb)',
  channelTypes: SWITCH_CHANNEL_TYPES,
  priority: 10,
  variants: [
    { id: 'switch', label: 'Switch', hapServices: ['Switch'] },
    { id: 'outlet', label: 'Outlet', hapServices: ['Outlet'] },
    { id: 'lightbulb', label: 'Lightbulb', hapServices: ['Lightbulb'] },
  ],
  build: (ctx: ServiceContext) => new SwitchHandler(ctx),
};
