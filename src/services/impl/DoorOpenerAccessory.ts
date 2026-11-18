import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';

/**
 * A momentary relay used as a door buzzer / electric strike. In HomeKit
 * the natural service is LockMechanism: the user "unlocks", we pulse
 * STATE=true on the CCU, and after a short delay flip the lock back to
 * Secured so the Home app doesn't show a dangling "Unlocked" state.
 */

const DOOR_OPENER_CHANNEL_TYPES = ['SWITCH', 'SWITCH_VIRTUAL_RECEIVER'];

const SECURED = 1;
const UNSECURED = 0;
const PULSE_MS = 1500;

class DoorOpenerHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private resetTimer: NodeJS.Timeout | undefined;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.LockMechanism, channel.name);

    service
      .getCharacteristic(this.Characteristic.LockCurrentState)
      .onGet(this.wrapGet<number>(() => SECURED));

    service
      .getCharacteristic(this.Characteristic.LockTargetState)
      .onGet(this.wrapGet<number>(() => SECURED))
      .onSet(
        this.wrapSet<number>(async (value) => {
          if (value !== UNSECURED) {
            return;
          }
          try {
            await this.ccu.setValue(this.channelAddress, 'STATE', true);
          } catch (err) {
            this.log.warn('door-opener pulse failed: %s', (err as Error).message);
          }
          service.updateCharacteristic(this.Characteristic.LockCurrentState, UNSECURED);
          if (this.resetTimer) {
            clearTimeout(this.resetTimer);
          }
          this.resetTimer = setTimeout(() => {
            service.updateCharacteristic(this.Characteristic.LockTargetState, SECURED);
            service.updateCharacteristic(this.Characteristic.LockCurrentState, SECURED);
            this.resetTimer = undefined;
          }, PULSE_MS);
          if (this.resetTimer.unref) {
            this.resetTimer.unref();
          }
        }),
      );
  }

  override dispose(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }
    super.dispose();
  }
}

export const doorOpenerService: ServiceDefinition = {
  key: 'DoorOpenerAccessory',
  description: 'Door opener / electric strike (HomeKit LockMechanism, momentary)',
  channelTypes: DOOR_OPENER_CHANNEL_TYPES,
  priority: 50,
  build: (ctx: ServiceContext) => new DoorOpenerHandler(ctx),
};
