// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';

const LOCK_CHANNEL_TYPES = [
  'KEYMATIC',
  'LOCK_VIRTUAL_RECEIVER',
];

class LockHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private current: number;
  private target: number;

  constructor(ctx: ServiceContext) {
    super(ctx);
    // HAP: 0=UNSECURED (open), 1=SECURED (locked), 2=JAMMED, 3=UNKNOWN.
    // Default to UNKNOWN until we get a real value.
    this.current = this.Characteristic.LockCurrentState.UNKNOWN;
    this.target = this.Characteristic.LockTargetState.SECURED;
  }

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.LockMechanism, channel.name);

    service.getCharacteristic(this.Characteristic.LockCurrentState)
      .onGet(this.wrapGet<number>(() => this.current));

    service.getCharacteristic(this.Characteristic.LockTargetState)
      .onGet(this.wrapGet<number>(() => this.target))
      .onSet(this.wrapSet<number>(async (value) => {
        // CCU `STATE`: true = unlocked, false = locked. Inverted vs HomeKit.
        this.target = value;
        const stateLocked = value === this.Characteristic.LockTargetState.SECURED;
        await this.ccu.setValue(this.channelAddress, 'STATE', !stateLocked);
      }));

    this.registerListener(this.channelAddress, 'STATE', (raw) => {
      const unlocked = Boolean(raw);
      this.current = unlocked
        ? this.Characteristic.LockCurrentState.UNSECURED
        : this.Characteristic.LockCurrentState.SECURED;
      this.target = unlocked
        ? this.Characteristic.LockTargetState.UNSECURED
        : this.Characteristic.LockTargetState.SECURED;
      service.updateCharacteristic(this.Characteristic.LockCurrentState, this.current);
      service.updateCharacteristic(this.Characteristic.LockTargetState, this.target);
    });

    // Some Keymatic firmwares expose ERROR (0=no error, 1=clutch failure,
    // 2=motor aborted). Surface clutch/motor faults as JAMMED.
    this.registerListener(this.channelAddress, 'ERROR', (raw) => {
      const code = Number(raw);
      if (Number.isFinite(code) && code > 0) {
        this.current = this.Characteristic.LockCurrentState.JAMMED;
        service.updateCharacteristic(this.Characteristic.LockCurrentState, this.current);
      }
    });

    this.readOnRefresh(this.channelAddress, 'STATE', (raw) => {
      const unlocked = Boolean(raw);
      this.current = unlocked
        ? this.Characteristic.LockCurrentState.UNSECURED
        : this.Characteristic.LockCurrentState.SECURED;
      this.target = unlocked
        ? this.Characteristic.LockTargetState.UNSECURED
        : this.Characteristic.LockTargetState.SECURED;
      service.updateCharacteristic(this.Characteristic.LockCurrentState, this.current);
      service.updateCharacteristic(this.Characteristic.LockTargetState, this.target);
    });
  }
}

export const lockService: ServiceDefinition = {
  key: 'LockAccessory',
  description: 'Door lock (Keymatic / electronic lock)',
  channelTypes: LOCK_CHANNEL_TYPES,
  priority: 10,
  build: (ctx: ServiceContext) => new LockHandler(ctx),
};
