import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { sendsKeyPresses } from '../inputMode.js';

const PROGRAMMABLE_SWITCH_CHANNEL_TYPES = [
  'KEY',
  'KEY_TRANSCEIVER',
  'PUSH_BUTTON',
  'BLIND_BUTTON',
  // Multi-channel input modules: HmIP-FCI6, HMIPW-DRI32. Each input
  // channel exposes itself as MULTI_MODE_INPUT_TRANSMITTER and emits
  // PRESS_SHORT / PRESS_LONG just like a remote, but only in key mode
  // (CHANNEL_OPERATION_MODE, see inputMode.ts).
  'MULTI_MODE_INPUT_TRANSMITTER',
];

const SINGLE_PRESS = 0;
const DOUBLE_PRESS = 1;
const LONG_PRESS = 2;

class ProgrammableSwitchHandler extends AccessoryBase implements ChannelService {
  private lastShortAt = 0;

  attach(channel: CcuChannel): void {
    const service = this.getOrAddService(this.Service.StatelessProgrammableSwitch, channel.name);

    const eventChar = service.getCharacteristic(this.Characteristic.ProgrammableSwitchEvent);

    this.registerListener(channel.address, 'PRESS_SHORT', (raw) => {
      if (!raw) {
        return;
      }
      const now = Date.now();
      if (now - this.lastShortAt < 400) {
        eventChar.updateValue(DOUBLE_PRESS);
        this.lastShortAt = 0;
        return;
      }
      this.lastShortAt = now;
      eventChar.updateValue(SINGLE_PRESS);
    });

    this.registerListener(channel.address, 'PRESS_LONG', (raw) => {
      if (raw) {
        eventChar.updateValue(LONG_PRESS);
      }
    });

    // Remotes and wall buttons run on batteries; button inputs of
    // flush-mount actuators do not (no LOW_BAT on channel 0). Until the
    // first value: "battery normal" instead of "No Response" — a remote
    // may not send anything for a long time after a CCU restart.
    this.attachBatteryIfPresent(channel.address, { assumeNormal: true });

    this.watchInputMode(channel, (mode) =>
      mode === 'INACTIVE'
        ? 'it sends nothing; change its operating mode in the CCU'
        : sendsKeyPresses(mode)
          ? undefined
          : 'it sends STATE, no key presses; set it to key in the CCU, or map it as doorbell with trigger STATE',
    );
  }
}

export const programmableSwitchService: ServiceDefinition = {
  key: 'ProgrammableSwitchAccessory',
  description: 'Push button / remote (HomeKit Stateless Programmable Switch)',
  channelTypes: PROGRAMMABLE_SWITCH_CHANNEL_TYPES,
  inputModes: ['KEY_BEHAVIOR'],
  priority: 10,
  build: (ctx: ServiceContext) => new ProgrammableSwitchHandler(ctx),
};
