// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { normalizeLevelToPercent, percentToLevelFraction, toFiniteNumber } from '../../util/sanitize.js';

/**
 * Window covering with adjustable slat angle (venetian blind / HmIP-BBL).
 * Adds CurrentHorizontalTiltAngle / TargetHorizontalTiltAngle to the
 * standard WindowCovering service. Slat angle lives in the CCU `LEVEL_2`
 * datapoint (0..1 fraction; 0 = horizontal/open, 1 = fully tilted shut).
 */
const SLAT_BLIND_CHANNEL_TYPES = [
  'BLIND_VIRTUAL_RECEIVER',
  'BLIND_TRANSMITTER',
];

const STATE_STOPPED = 2;
const STATE_INCREASING = 1;
const STATE_DECREASING = 0;

const HK_TILT_MIN = -90;
const HK_TILT_MAX = 90;
const HK_TILT_RANGE = HK_TILT_MAX - HK_TILT_MIN;

class SlatBlindHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private current = 0;
  private target = 0;
  private currentTilt = 0;
  private targetTilt = 0;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.WindowCovering, channel.name);

    service.getCharacteristic(this.Characteristic.CurrentPosition)
      .onGet(this.wrapGet<number>(() => this.current));

    service.getCharacteristic(this.Characteristic.TargetPosition)
      .onGet(this.wrapGet<number>(() => this.target))
      .onSet(this.wrapSet<number>(async (value) => {
        const pct = normalizeLevelToPercent(value) ?? 0;
        this.target = pct;
        await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(pct));
      }));

    service.getCharacteristic(this.Characteristic.PositionState)
      .onGet(this.wrapGet<number>(() => this.derivePositionState()));

    service.getCharacteristic(this.Characteristic.CurrentHorizontalTiltAngle)
      .setProps({ minValue: HK_TILT_MIN, maxValue: HK_TILT_MAX, minStep: 1 })
      .onGet(this.wrapGet<number>(() => this.currentTilt));

    service.getCharacteristic(this.Characteristic.TargetHorizontalTiltAngle)
      .setProps({ minValue: HK_TILT_MIN, maxValue: HK_TILT_MAX, minStep: 1 })
      .onGet(this.wrapGet<number>(() => this.targetTilt))
      .onSet(this.wrapSet<number>(async (value) => {
        this.targetTilt = value;
        const fraction = (value - HK_TILT_MIN) / HK_TILT_RANGE;
        await this.ccu.setValue(this.channelAddress, 'LEVEL_2', fraction);
      }));

    this.registerListener(this.channelAddress, 'LEVEL', (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === undefined) return;
      this.current = pct;
      this.target = pct;
      service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
      service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
      service.updateCharacteristic(this.Characteristic.PositionState, this.derivePositionState());
    });

    this.registerListener(this.channelAddress, 'LEVEL_2', (raw) => {
      const f = toFiniteNumber(raw);
      if (f === undefined) return;
      const angle = HK_TILT_MIN + Math.max(0, Math.min(1, f)) * HK_TILT_RANGE;
      this.currentTilt = Math.round(angle);
      this.targetTilt = this.currentTilt;
      service.updateCharacteristic(this.Characteristic.CurrentHorizontalTiltAngle, this.currentTilt);
      service.updateCharacteristic(this.Characteristic.TargetHorizontalTiltAngle, this.targetTilt);
    });

    this.registerListener(this.channelAddress, 'WORKING', (raw) => {
      const moving = Boolean(raw);
      service.updateCharacteristic(
        this.Characteristic.PositionState,
        moving ? this.derivePositionState() : STATE_STOPPED,
      );
    });

    // Best-effort initial pulls — same apply paths as the LEVEL /
    // LEVEL_2 listeners above; tested via fireEvent there.
    /* v8 ignore start */
    this.readOnRefresh(this.channelAddress, 'LEVEL', (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === undefined) return;
      this.current = pct;
      this.target = pct;
      service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
      service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
      service.updateCharacteristic(this.Characteristic.PositionState, STATE_STOPPED);
    });

    this.readOnRefresh(this.channelAddress, 'LEVEL_2', (raw) => {
      const f = toFiniteNumber(raw);
      if (f === undefined) return;
      const angle = HK_TILT_MIN + Math.max(0, Math.min(1, f)) * HK_TILT_RANGE;
      this.currentTilt = Math.round(angle);
      this.targetTilt = this.currentTilt;
      service.updateCharacteristic(this.Characteristic.CurrentHorizontalTiltAngle, this.currentTilt);
      service.updateCharacteristic(this.Characteristic.TargetHorizontalTiltAngle, this.targetTilt);
    });
    /* v8 ignore stop */
  }

  private derivePositionState(): number {
    if (this.target > this.current) {
      return STATE_INCREASING;
    }
    if (this.target < this.current) {
      return STATE_DECREASING;
    }
    return STATE_STOPPED;
  }
}

export const slatBlindService: ServiceDefinition = {
  key: 'SlatBlindAccessory',
  description: 'Window covering with slat angle (HmIP-BBL)',
  channelTypes: SLAT_BLIND_CHANNEL_TYPES,
  // Lower priority than plain BlindAccessory — opt-in.
  priority: 50,
  build: (ctx: ServiceContext) => new SlatBlindHandler(ctx),
};
