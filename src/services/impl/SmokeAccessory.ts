// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { AccessoryBase, isTrue } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';

const SMOKE_CHANNEL_TYPES = [
  'SMOKE_DETECTOR',
  'SMOKE_DETECTOR_COMMUNICATION',
];

/** HmIP-SWSD SMOKE_DETECTOR_ALARM_STATUS (plan 3.1 / 8.3). */
export const ALARM_STATUS = ['IDLE_OFF', 'PRIMARY_ALARM', 'INTRUSION_ALARM', 'SECONDARY_ALARM'] as const;

/** HmIP-SWSD SMOKE_DETECTOR_TEST_RESULT (VALUE_LIST from the CCU). */
export const TEST_RESULT = [
  'NONE', 'SMOKE_TEST_OK', 'SMOKE_TEST_FAILED', 'COMMUNICATION_TEST_SENT', 'COMMUNICATION_TEST_OK',
] as const;

/** ENUM index or name → name; undefined for anything else. */
function enumName<T extends string>(list: readonly T[], raw: unknown): T | undefined {
  if (typeof raw === 'string' && (list as readonly string[]).includes(raw)) {
    return raw as T;
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) ? list[n] : undefined;
}

const alarmName = (raw: unknown) => enumName(ALARM_STATUS, raw);

/**
 * Smoke detector.
 *
 * HmIP-SWSD has no STATE; it reports SMOKE_DETECTOR_ALARM_STATUS:
 *   PRIMARY_ALARM   → smoke detected (this detector)
 *   SECONDARY_ALARM → smoke detected (another detector of the group);
 *                     option `secondaryAlarm: false` keeps it off, so
 *                     Home only shows the detector that saw smoke
 *   INTRUSION_ALARM → no smoke (detector used as siren), logged
 *   IDLE_OFF        → no smoke
 * ERROR_DEGRADED_CHAMBER → StatusFault; SMOKE_DETECTOR_TEST_RESULT → log.
 * BidCos detectors keep the STATE path.
 *
 * No value yet (decided 11.11.2026): after a CCU restart HMIPServer has no
 * values for a detector until it sends again — possibly hours. Instead of
 * "No Response" the detector then reports "no smoke" plus StatusFault; an
 * alarm arrives as an event anyway. The battery shows "normal" meanwhile.
 */
class SmokeHandler extends AccessoryBase implements ChannelService {
  private detected: boolean | undefined;
  private degraded = false;

  attach(channel: CcuChannel): void {
    const service = this.getOrAddService(this.Service.SmokeSensor, channel.name);
    const secondary = this.accessory.context.settings?.secondaryAlarm !== false;

    service.getCharacteristic(this.Characteristic.SmokeDetected)
      .onGet(this.wrapGet<number>(() => this.toHap()));

    // Fault while the chamber is degraded or no value is known yet.
    const reevaluate = this.watchFault(service, channel.address, () => this.degraded || this.detected === undefined);

    const set = (detected: boolean): void => {
      const changed = this.detected !== detected;
      const first = this.detected === undefined;
      this.detected = detected;
      if (changed && detected) {
        this.log.warn('%s: SMOKE detected', this.accessory.displayName);
      }
      this.update(service, this.Characteristic.SmokeDetected, this.toHap());
      if (first) {
        reevaluate();
      }
    };

    // HmIP-SWSD
    this.need(channel.address, 'SMOKE_DETECTOR_ALARM_STATUS', (raw) => {
      const status = alarmName(raw);
      switch (status) {
        case 'PRIMARY_ALARM':
          set(true);
          break;
        case 'SECONDARY_ALARM':
          this.log.info('%s: alarm of another detector in the group', this.accessory.displayName);
          set(secondary);
          break;
        case 'INTRUSION_ALARM':
          this.log.info('%s: intrusion alarm (siren), not smoke', this.accessory.displayName);
          set(false);
          break;
        case 'IDLE_OFF':
          set(false);
          break;
        default:
          this.log.debug('unknown SMOKE_DETECTOR_ALARM_STATUS %s', String(raw));
      }
    });
    // NONE is the idle / reset value (also reported at start): debug only.
    this.registerListener(channel.address, 'SMOKE_DETECTOR_TEST_RESULT', (raw) => {
      const name = this.accessory.displayName;
      const result = enumName(TEST_RESULT, raw);
      switch (result) {
        case 'NONE':
          this.log.debug('%s: test result NONE', name);
          break;
        case 'SMOKE_TEST_FAILED':
          this.log.warn('%s: smoke test FAILED', name);
          break;
        case undefined:
          this.log.debug('%s: unknown SMOKE_DETECTOR_TEST_RESULT %s', name, String(raw));
          break;
        default:
          this.log.info('%s: test result %s', name, result);
      }
    });
    this.need(channel.address, 'ERROR_DEGRADED_CHAMBER', (raw) => {
      this.degraded = isTrue(raw);
      if (this.degraded) {
        this.log.warn('%s: smoke chamber degraded — replace the detector', this.accessory.displayName);
      }
      reevaluate();
    });

    // BidCos (HM-Sec-SD …)
    this.need(channel.address, 'STATE', (raw) => set(isTrue(raw)));

    this.attachBattery(channel.address, { assumeNormal: true });
  }

  private toHap(): number {
    return this.detected
      ? this.Characteristic.SmokeDetected.SMOKE_DETECTED
      : this.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
  }
}

export const smokeService: ServiceDefinition = {
  key: 'SmokeAccessory',
  description: 'Smoke detector',
  channelTypes: SMOKE_CHANNEL_TYPES,
  priority: 10,
  options: [
    { key: 'secondaryAlarm', label: 'Show group alarms', type: 'boolean', default: true,
      hint: 'Off: an alarm of another detector of the group does not show smoke on this one.' },
  ],
  build: (ctx: ServiceContext) => new SmokeHandler(ctx),
};
