/**
 * Doorbell (plan 8.2): HomeKit Doorbell service fed by a bell-signal
 * input such as the HmIP-DSD-PCB (channel 1, MULTI_MODE_INPUT_TRANSMITTER).
 * Replaces the chain DSD-PCB → CCU program → virtual key.
 *
 * Trigger (option `trigger`, default PRESS_SHORT, plan 3.1 finding 7):
 *   PRESS_SHORT / PRESS_LONG — fire on the event itself, whatever its value
 *                              (the CCU may send `false` for a press)
 *   STATE                    — fire when STATE turns true
 * Option `debounceSeconds` (default 2) swallows repeats. No start value:
 * a press is an ACTION, reading it at start would ring the bell.
 */

import { AccessoryBase, isTrue } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';

const TRIGGERS = ['PRESS_SHORT', 'PRESS_LONG', 'STATE'] as const;
type Trigger = (typeof TRIGGERS)[number];

class DoorbellHandler extends AccessoryBase implements ChannelService {
  private lastRingAt = 0;

  attach(channel: CcuChannel): void {
    const settings = this.accessory.context.settings ?? {};
    const trigger: Trigger = (TRIGGERS as readonly string[]).includes(String(settings.trigger))
      ? settings.trigger as Trigger
      : 'PRESS_SHORT';
    const debounce = Number(settings.debounceSeconds ?? 2);
    const debounceMs = Number.isFinite(debounce) && debounce >= 0 ? debounce * 1000 : 2000;

    const service = this.getOrAddService(this.Service.Doorbell, channel.name);
    const event = service.getCharacteristic(this.Characteristic.ProgrammableSwitchEvent);
    // Stateless: reading the event must return null.
    event.onGet(() => null as unknown as number);

    const ring = (): void => {
      const now = Date.now();
      if (now - this.lastRingAt < debounceMs) {
        this.log.debug('doorbell: repeat within %d ms ignored', debounceMs);
        return;
      }
      this.lastRingAt = now;
      this.log.info('%s: ring', this.accessory.displayName);
      event.updateValue(this.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    };

    if (trigger === 'STATE') {
      let last: boolean | undefined;
      this.registerListener(channel.address, 'STATE', (raw) => {
        const on = isTrue(raw);
        if (on && last !== true) {
          ring();
        }
        last = on;
      });
    } else {
      this.registerListener(channel.address, trigger, () => ring());
    }

    this.attachBattery(channel.address);
  }
}

export const doorbellService: ServiceDefinition = {
  key: 'DoorbellAccessory',
  description: 'Doorbell (bell-signal input, e.g. HmIP-DSD-PCB)',
  channelTypes: ['MULTI_MODE_INPUT_TRANSMITTER'],
  priority: 20,
  build: (ctx: ServiceContext) => new DoorbellHandler(ctx),
};
